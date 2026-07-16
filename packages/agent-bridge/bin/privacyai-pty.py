#!/usr/bin/env python3
"""Transparent Unix PTY bridge used by `privacyai claude|codex`.

The child owns a real pseudo-terminal, so its native TUI, slash commands,
keyboard handling, colors, and permission dialogs remain unchanged. The bridge
watches output for PrivacyAI reinjection markers and can restart a protected
Codex TUI when the user enters an exact local /resume or /fork command.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import tty
from pathlib import Path

MARKER = re.compile(rb"\[PRIVACYAI_REINJECT:([0-9a-fA-F-]{36})\]")
SESSION_ACTION = re.compile(
    rb"^\s*/(resume|fork)(?:\s+(--last|--all|[A-Za-z0-9][A-Za-z0-9._:-]{0,255}))?\s*$"
)
MAX_SCAN_BYTES = 16384
MAX_SESSION_ACTION_BYTES = 512
REINJECT_DELAY_SECONDS = 0.55
SUBMIT_DELAY_SECONDS = 0.12
SESSION_ACTION_EXIT_CODE = 86
CHILD_TERMINATION_SECONDS = 2.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--flavor", choices=("claude", "codex"), required=True)
    parser.add_argument("--session-action-file")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("missing wrapped command")
    if args.session_action_file and args.flavor != "codex":
        parser.error("session actions are supported only for Codex")
    return args


def copy_window_size(source_fd: int, target_fd: int) -> None:
    try:
        size = fcntl.ioctl(source_fd, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(target_fd, termios.TIOCSWINSZ, size)
    except OSError:
        rows = int(os.environ.get("LINES", "24") or 24)
        cols = int(os.environ.get("COLUMNS", "80") or 80)
        fcntl.ioctl(target_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_pending(runtime_dir: Path, request_id: str) -> str | None:
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", request_id):
        return None
    path = runtime_dir / "pending" / f"{request_id}.json"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        path.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError):
        return None

    prompt = record.get("sanitizedPrompt")
    if not isinstance(prompt, str):
        return None
    return prompt


def encode_paste(prompt: str, flavor: str) -> bytes:
    payload = prompt.encode("utf-8")
    # Bracketed paste preserves multiline prompts and prevents the child TUI
    # from treating pasted control characters as native shortcuts.
    if flavor in {"claude", "codex"}:
        return b"\x1b[200~" + payload + b"\x1b[201~"
    return payload


def parse_session_action(value: bytes) -> dict[str, object] | None:
    match = SESSION_ACTION.fullmatch(value)
    if not match:
        return None
    selector = match.group(2)
    return {
        "version": 1,
        "action": match.group(1).decode("ascii"),
        "selector": selector.decode("ascii") if selector else None,
    }


def write_session_action(runtime_dir: Path, requested_path: str, action: dict[str, object]) -> None:
    path = Path(requested_path).resolve()
    if path.parent != runtime_dir:
        raise RuntimeError("Codex session action file must remain inside the private runtime directory.")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(action, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def terminate_child(pid: int) -> int:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

    deadline = time.monotonic() + CHILD_TERMINATION_SECONDS
    while time.monotonic() < deadline:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
        if waited_pid == pid:
            return status
        time.sleep(0.02)

    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)
    return status


class SessionActionTracker:
    def __init__(self) -> None:
        self.buffer = bytearray()
        self.disabled = False
        self.line_known_empty = True
        self.escape_state: str | None = None
        self.escape_reset_allowed = False

    def feed(self, data: bytes) -> tuple[bytes, dict[str, object] | None]:
        forwarded = bytearray()
        for value in data:
            forwarded.append(value)

            if self.escape_state is not None:
                if self.escape_state == "start":
                    if value in (ord("["), ord("O")):
                        self.escape_state = "csi"
                        continue
                    if value == ord("]"):
                        self.escape_state = "osc"
                        continue
                    if value in (ord("P"), ord("X"), ord("^"), ord("_")):
                        self.escape_state = "string"
                        continue
                    if 0x30 <= value <= 0x7E:
                        self._finish_escape()
                        continue

                    reset_allowed = self.escape_reset_allowed
                    self._clear_escape()
                    if reset_allowed:
                        self.disabled = False
                    else:
                        continue
                elif self.escape_state == "csi":
                    if 0x40 <= value <= 0x7E:
                        self._finish_escape()
                    continue
                elif self.escape_state == "osc":
                    if value == 7:
                        self._finish_escape()
                    elif value == 27:
                        self.escape_state = "osc_escape"
                    continue
                elif self.escape_state == "string":
                    if value == 27:
                        self.escape_state = "string_escape"
                    continue
                elif self.escape_state in ("osc_escape", "string_escape"):
                    base_state = self.escape_state.removesuffix("_escape")
                    if value == ord("\\"):
                        self._finish_escape()
                    elif value != 27:
                        self.escape_state = base_state
                    continue

            if value in (10, 13):
                action = None if self.disabled else parse_session_action(bytes(self.buffer))
                if action is not None:
                    return bytes(forwarded[:-1]), action
                self._reset_line()
                continue

            if value in (8, 127):
                if not self.disabled and self.buffer:
                    self.buffer.pop()
                    self.line_known_empty = len(self.buffer) == 0
                continue
            if value in (3, 21):
                self._reset_line()
                continue
            if value == 27:
                self.escape_state = "start"
                self.escape_reset_allowed = self.line_known_empty
                self.disabled = True
                self.buffer.clear()
                continue
            if 32 <= value <= 126:
                if self.disabled:
                    self.line_known_empty = False
                    continue
                if len(self.buffer) >= MAX_SESSION_ACTION_BYTES:
                    self.disabled = True
                    self.line_known_empty = False
                    self.buffer.clear()
                else:
                    self.buffer.append(value)
                    self.line_known_empty = False
                continue

            self.disabled = True
            self.buffer.clear()

        return bytes(forwarded), None

    def _finish_escape(self) -> None:
        reset_allowed = self.escape_reset_allowed
        self._clear_escape()
        if reset_allowed:
            self.disabled = False

    def _clear_escape(self) -> None:
        self.escape_state = None
        self.escape_reset_allowed = False

    def _reset_line(self) -> None:
        self.buffer.clear()
        self.disabled = False
        self.line_known_empty = True
        self._clear_escape()


def exit_code_from_status(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def main() -> int:
    args = parse_args()
    runtime_dir = Path(args.runtime_dir).resolve()
    pid, master_fd = pty.fork()

    if pid == 0:
        os.execvpe(args.command[0], args.command, os.environ.copy())

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_is_tty = os.isatty(stdin_fd)
    old_terminal = termios.tcgetattr(stdin_fd) if stdin_is_tty else None
    scan_buffer = b""
    handled: set[str] = set()
    scheduled: list[tuple[float, str]] = []
    child_status: int | None = None
    session_action_requested = False
    action_tracker = SessionActionTracker() if args.session_action_file else None

    def resize(_signum=None, _frame=None) -> None:
        copy_window_size(stdin_fd if stdin_is_tty else stdout_fd, master_fd)

    def forward_signal(signum, _frame) -> None:
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGWINCH, resize)
    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGHUP, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    try:
        resize()
        if stdin_is_tty:
            tty.setraw(stdin_fd)

        inputs = [stdin_fd, master_fd]
        while child_status is None:
            now = time.monotonic()
            due = [item for item in scheduled if item[0] <= now]
            scheduled = [item for item in scheduled if item[0] > now]
            for _, request_id in due:
                prompt = read_pending(runtime_dir, request_id)
                if prompt is not None:
                    os.write(master_fd, encode_paste(prompt, args.flavor))
                    # Claude Code and Codex need a distinct key event after the
                    # bracketed-paste terminator. Sending both in one write can
                    # leave the text in the composer without submitting it.
                    time.sleep(SUBMIT_DELAY_SECONDS)
                    os.write(master_fd, b"\r")

            timeout = 0.1
            if scheduled:
                timeout = max(0.0, min(timeout, scheduled[0][0] - now))

            readable, _, _ = select.select(inputs, [], [], timeout)
            if stdin_fd in readable:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    forwarded, action = action_tracker.feed(data) if action_tracker else (data, None)
                    if forwarded:
                        os.write(master_fd, forwarded)
                    if action is not None:
                        os.write(stdout_fd, b"\r\n")
                        write_session_action(runtime_dir, args.session_action_file, action)
                        child_status = terminate_child(pid)
                        session_action_requested = True
                        break
                else:
                    inputs.remove(stdin_fd)

            if master_fd in readable:
                try:
                    data = os.read(master_fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b""
                    else:
                        raise

                if data:
                    os.write(stdout_fd, data)
                    scan_buffer = (scan_buffer + data)[-MAX_SCAN_BYTES:]
                    for match in MARKER.finditer(scan_buffer):
                        request_id = match.group(1).decode("ascii").lower()
                        if request_id not in handled:
                            handled.add(request_id)
                            scheduled.append((time.monotonic() + REINJECT_DELAY_SECONDS, request_id))
                    scheduled.sort()
                else:
                    _, child_status = os.waitpid(pid, 0)
                    break

            waited_pid, status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                child_status = status
    finally:
        if old_terminal is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_terminal)
        try:
            os.close(master_fd)
        except OSError:
            pass

    if session_action_requested:
        return SESSION_ACTION_EXIT_CODE
    return exit_code_from_status(child_status or 0)


if __name__ == "__main__":
    raise SystemExit(main())
