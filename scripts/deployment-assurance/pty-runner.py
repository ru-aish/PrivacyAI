#!/usr/bin/env python3
"""Run one command behind a pseudo-terminal with bounded scripted input."""

from __future__ import annotations

import argparse
import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("a command is required after --")
    return args


def main() -> int:
    args = parse_args()
    master, slave = pty.openpty()
    child = subprocess.Popen(
        args.command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=os.environ.copy(),
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)
    if args.input:
        os.write(master, args.input.encode("utf-8"))

    deadline = time.monotonic() + args.timeout
    try:
        while True:
            if time.monotonic() >= deadline:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                print("deployment assurance PTY command timed out", file=sys.stderr)
                return 124

            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                if chunk:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                elif child.poll() is not None:
                    break
            elif child.poll() is not None:
                while True:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
                break
        return child.wait()
    finally:
        os.close(master)
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
