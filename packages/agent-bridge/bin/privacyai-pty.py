#!/usr/bin/env python3
"""Transparent Unix PTY bridge used by `privacyai claude|codex`.

The child owns a real pseudo-terminal, so its native TUI, slash commands,
keyboard handling, colors, and permission dialogs remain unchanged. The bridge
only watches output for a PrivacyAI reinjection marker and types the already
sanitized prompt back into the native composer.
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
MAX_SCAN_BYTES = 16384
REINJECT_DELAY_SECONDS = 0.55
SUBMIT_DELAY_SECONDS = 0.12


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--flavor", choices=("claude", "codex"), required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("missing wrapped command")
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

            readable, _, _ = select.select([stdin_fd, master_fd], [], [], timeout)
            if stdin_fd in readable:
                data = os.read(stdin_fd, 65536)
                if data:
                    os.write(master_fd, data)

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

    return exit_code_from_status(child_status or 0)


if __name__ == "__main__":
    raise SystemExit(main())
