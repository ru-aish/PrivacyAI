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
CHILD_KILL_WAIT_SECONDS = 1.0
DEFAULT_ROWS = 24
DEFAULT_COLUMNS = 80
MAX_TERMINAL_DIMENSION = 65535


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


def positive_terminal_dimension(name: str, fallback: int) -> int:
    try:
        value = int(os.environ.get(name, "") or fallback)
    except (TypeError, ValueError):
        return fallback
    if value <= 0:
        return fallback
    return min(value, MAX_TERMINAL_DIMENSION)


def copy_window_size(source_fd: int, target_fd: int) -> None:
    try:
        size = fcntl.ioctl(source_fd, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(target_fd, termios.TIOCSWINSZ, size)
    except OSError:
        rows = positive_terminal_dimension("LINES", DEFAULT_ROWS)
        cols = positive_terminal_dimension("COLUMNS", DEFAULT_COLUMNS)
        fcntl.ioctl(target_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(descriptor: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        try:
            written = os.write(descriptor, remaining)
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError(errno.EIO, "write returned no progress")
        remaining = remaining[written:]


def is_closed_pty_error(error: OSError) -> bool:
    return error.errno in (errno.EBADF, errno.EIO, errno.EPIPE)


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


def signal_child_group(pid: int, signum: int) -> None:
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass


def wait_child(pid: int, options: int = 0) -> tuple[int, int | None]:
    try:
        waited_pid, status = os.waitpid(pid, options)
    except ChildProcessError:
        return pid, 0
    return waited_pid, status


def process_group_exists(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def reap_child_nonblocking(pid: int, known_status: int | None) -> int | None:
    if known_status is not None:
        return known_status
    waited_pid, status = wait_child(pid, os.WNOHANG)
    return status if waited_pid == pid else None


def terminate_child(
    pid: int,
    initial_signal: int = signal.SIGTERM,
    known_status: int | None = None,
) -> int | None:
    status = reap_child_nonblocking(pid, known_status)
    if not process_group_exists(pid):
        if status is None:
            _, status = wait_child(pid, 0)
        return status

    signal_child_group(pid, initial_signal)
    deadline = time.monotonic() + CHILD_TERMINATION_SECONDS
    while time.monotonic() < deadline:
        status = reap_child_nonblocking(pid, status)
        if not process_group_exists(pid):
            if status is None:
                _, status = wait_child(pid, 0)
            return status
        time.sleep(0.02)

    signal_child_group(pid, signal.SIGKILL)
    deadline = time.monotonic() + CHILD_KILL_WAIT_SECONDS
    while time.monotonic() < deadline:
        status = reap_child_nonblocking(pid, status)
        if not process_group_exists(pid):
            if status is None:
                _, status = wait_child(pid, 0)
            return status
        time.sleep(0.02)

    if status is None:
        _, status = wait_child(pid, 0)
    return status


class SessionActionTracker:
    """Tracks the editable terminal line without changing bytes sent to Codex."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.cursor = 0
        self.disabled = False
        self.escape = bytearray()
        self.bracketed_paste = False

    def feed(self, data: bytes) -> tuple[bytes, dict[str, object] | None]:
        forwarded = bytearray()
        for value in data:
            forwarded.append(value)

            if self.escape:
                self.escape.append(value)
                if self._escape_complete(value):
                    self._apply_escape(bytes(self.escape))
                    self.escape.clear()
                elif len(self.escape) > 64:
                    self._disable_line()
                    self.escape.clear()
                continue

            if value == 27:
                self.escape.append(value)
                continue

            if self.bracketed_paste:
                self._insert_pasted(value)
                continue

            if value in (10, 13):
                action = None if self.disabled else parse_session_action(bytes(self.buffer))
                if action is not None:
                    return bytes(forwarded[:-1]), action
                self._reset_line()
                continue

            if value in (8, 127):
                self._backspace()
                continue
            if value == 1:  # Ctrl-A
                self.cursor = 0
                continue
            if value == 5:  # Ctrl-E
                self.cursor = len(self.buffer)
                continue
            if value == 21:  # Ctrl-U
                del self.buffer[:self.cursor]
                self.cursor = 0
                continue
            if value == 23:  # Ctrl-W
                self._delete_previous_word()
                continue
            if value == 3:  # Ctrl-C
                self._reset_line()
                continue
            if 32 <= value <= 126:
                self._insert(value)
                continue

            self._disable_line()

        return bytes(forwarded), None

    def _escape_complete(self, value: int) -> bool:
        sequence = self.escape
        if len(sequence) == 2 and sequence[1] not in (ord("["), ord("O"), ord("]"), ord("P"), ord("X"), ord("^"), ord("_")):
            return True
        if len(sequence) < 3:
            return False
        if sequence[1] in (ord("["), ord("O")):
            return 0x40 <= value <= 0x7E
        if sequence[1] == ord("]"):
            return value == 7 or sequence.endswith(b"\x1b\\")
        if sequence[1] in (ord("P"), ord("X"), ord("^"), ord("_")):
            return sequence.endswith(b"\x1b\\")
        return True

    def _apply_escape(self, sequence: bytes) -> None:
        if sequence in (b"\x1b[D", b"\x1bOD"):
            self.cursor = max(0, self.cursor - 1)
            return
        if sequence in (b"\x1b[C", b"\x1bOC"):
            self.cursor = min(len(self.buffer), self.cursor + 1)
            return
        if sequence in (b"\x1b[H", b"\x1bOH", b"\x1b[1~", b"\x1b[7~"):
            self.cursor = 0
            return
        if sequence in (b"\x1b[F", b"\x1bOF", b"\x1b[4~", b"\x1b[8~"):
            self.cursor = len(self.buffer)
            return
        if sequence == b"\x1b[3~":
            if not self.disabled and self.cursor < len(self.buffer):
                del self.buffer[self.cursor]
            return
        if sequence == b"\x1b[200~":
            self.bracketed_paste = True
            return
        if sequence == b"\x1b[201~":
            self.bracketed_paste = False
            return
        if len(sequence) == 2 and 32 <= sequence[1] <= 126 and not self.buffer:
            self._insert(sequence[1])
            return
        if not self.buffer and self._is_terminal_query(sequence):
            return
        self._disable_line()

    @staticmethod
    def _is_terminal_query(sequence: bytes) -> bool:
        return (
            sequence.startswith(b"\x1b[?")
            or sequence.startswith(b"\x1b]")
            or sequence.startswith((b"\x1bP", b"\x1bX", b"\x1b^", b"\x1b_"))
        )

    def _insert_pasted(self, value: int) -> None:
        if value in (10, 13) or not (32 <= value <= 126):
            self._disable_line()
            return
        self._insert(value)

    def _insert(self, value: int) -> None:
        if self.disabled:
            return
        if len(self.buffer) >= MAX_SESSION_ACTION_BYTES:
            self._disable_line()
            return
        self.buffer.insert(self.cursor, value)
        self.cursor += 1

    def _backspace(self) -> None:
        if self.disabled or self.cursor == 0:
            return
        self.cursor -= 1
        del self.buffer[self.cursor]

    def _delete_previous_word(self) -> None:
        if self.disabled or self.cursor == 0:
            return
        end = self.cursor
        start = end
        while start > 0 and chr(self.buffer[start - 1]).isspace():
            start -= 1
        while start > 0 and not chr(self.buffer[start - 1]).isspace():
            start -= 1
        del self.buffer[start:end]
        self.cursor = start

    def _disable_line(self) -> None:
        self.disabled = True
        self.buffer.clear()
        self.cursor = 0

    def _reset_line(self) -> None:
        self.buffer.clear()
        self.cursor = 0
        self.disabled = False
        self.escape.clear()
        self.bracketed_paste = False


def exit_code_from_status(status: int | None) -> int:
    if status is None:
        return 1
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
    forwarded_signal: int | None = None
    termination_deadline: float | None = None
    kill_sent = False
    stdout_broken = False

    def resize(_signum=None, _frame=None) -> None:
        try:
            copy_window_size(stdin_fd if stdin_is_tty else stdout_fd, master_fd)
        except OSError as error:
            if error.errno not in (errno.EBADF, errno.ENOTTY, errno.EIO):
                raise

    def forward_signal(signum, _frame) -> None:
        nonlocal forwarded_signal, termination_deadline
        if forwarded_signal is None:
            forwarded_signal = signum
            termination_deadline = time.monotonic() + CHILD_TERMINATION_SECONDS
        signal_child_group(pid, signum)

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
            if termination_deadline is not None and now >= termination_deadline and not kill_sent:
                signal_child_group(pid, signal.SIGKILL)
                kill_sent = True

            due = [item for item in scheduled if item[0] <= now]
            scheduled = [item for item in scheduled if item[0] > now]
            for _, request_id in due:
                prompt = read_pending(runtime_dir, request_id)
                if prompt is not None:
                    try:
                        write_all(master_fd, encode_paste(prompt, args.flavor))
                        time.sleep(SUBMIT_DELAY_SECONDS)
                        write_all(master_fd, b"\r")
                    except OSError as error:
                        if not is_closed_pty_error(error):
                            raise
                        child_status = terminate_child(pid)
                        break

            if child_status is not None:
                break

            timeout = 0.1
            if scheduled:
                timeout = max(0.0, min(timeout, scheduled[0][0] - now))
            if termination_deadline is not None and not kill_sent:
                timeout = max(0.0, min(timeout, termination_deadline - now))

            try:
                readable, _, _ = select.select(inputs, [], [], timeout)
            except InterruptedError:
                readable = []

            if stdin_fd in readable:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    forwarded, action = action_tracker.feed(data) if action_tracker else (data, None)
                    if forwarded:
                        try:
                            write_all(master_fd, forwarded)
                        except OSError as error:
                            if not is_closed_pty_error(error):
                                raise
                            child_status = terminate_child(pid)
                            break
                    if action is not None:
                        try:
                            write_all(stdout_fd, b"\r\n")
                        except OSError as error:
                            if not is_closed_pty_error(error):
                                raise
                            stdout_broken = True
                            child_status = terminate_child(pid, signal.SIGPIPE)
                            break
                        write_session_action(runtime_dir, args.session_action_file, action)
                        child_status = terminate_child(pid)
                        session_action_requested = True
                        break
                elif stdin_fd in inputs:
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
                    try:
                        write_all(stdout_fd, data)
                    except OSError as error:
                        if not is_closed_pty_error(error):
                            raise
                        stdout_broken = True
                        child_status = terminate_child(pid, signal.SIGPIPE)
                        break
                    scan_buffer = (scan_buffer + data)[-MAX_SCAN_BYTES:]
                    for match in MARKER.finditer(scan_buffer):
                        request_id = match.group(1).decode("ascii").lower()
                        if request_id not in handled:
                            handled.add(request_id)
                            scheduled.append((time.monotonic() + REINJECT_DELAY_SECONDS, request_id))
                    scheduled.sort()
                else:
                    _, child_status = wait_child(pid, 0)
                    break

            waited_pid, status = wait_child(pid, os.WNOHANG)
            if waited_pid == pid:
                child_status = status
    finally:
        child_status = terminate_child(
            pid,
            forwarded_signal or signal.SIGTERM,
            child_status,
        )
        if old_terminal is not None:
            try:
                termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_terminal)
            except OSError:
                pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    if session_action_requested:
        return SESSION_ACTION_EXIT_CODE
    if stdout_broken:
        return 128 + signal.SIGPIPE
    if forwarded_signal is not None:
        return 128 + forwarded_signal
    return exit_code_from_status(child_status)


if __name__ == "__main__":
    raise SystemExit(main())
