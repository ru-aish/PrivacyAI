#!/usr/bin/env python3
"""Focused timeout-cleanup tests for the deployment-assurance PTY runner."""

from __future__ import annotations

import errno
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
RUNNER_PATH = Path(__file__).with_name("pty-runner.py")
SPEC = importlib.util.spec_from_file_location("privacyai_pty_runner", RUNNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load the deployment-assurance PTY runner.")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class PtyRunnerCleanupTests(unittest.TestCase):
    def test_missing_process_group_is_already_clean(self) -> None:
        missing = ProcessLookupError(errno.ESRCH, "fixture process group exited")
        with patch.object(RUNNER.os, "killpg", side_effect=missing):
            RUNNER.kill_process_group(12345)

    def test_unexpected_process_group_error_is_not_masked(self) -> None:
        denied = PermissionError(errno.EPERM, "fixture permission failure")
        with patch.object(RUNNER.os, "killpg", side_effect=denied):
            with self.assertRaises(PermissionError) as raised:
                RUNNER.kill_process_group(12345)
        self.assertEqual(raised.exception.errno, errno.EPERM)

    def test_timeout_cleanup_exits_without_a_traceback(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(RUNNER_PATH),
                "--timeout",
                "0",
                "--",
                sys.executable,
                "-c",
                "pass",
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 124)
        self.assertIn("deployment assurance PTY command timed out", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
