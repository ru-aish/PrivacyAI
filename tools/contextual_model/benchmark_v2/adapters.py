"""Strict local predictor adapters for contextual benchmark evaluation."""
from __future__ import annotations

import json
import subprocess
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from .core import Prediction, estimate_tokens, prediction_from_mapping


class CallableAdapter:
    def __init__(self, predictor: Callable[[str], Prediction | Mapping[str, Any]]):
        self._predictor = predictor

    def predict(self, text: str) -> Prediction:
        value = self._predictor(text)
        if isinstance(value, Prediction):
            value.validate(text)
            return value
        return prediction_from_mapping(value, text)


class CommandJsonAdapter:
    """Invoke a local JSON predictor with source text only on stdin."""

    def __init__(self, command: Sequence[str], *, timeout_s: float = 30.0):
        if not command:
            raise ValueError("command is required")
        self.command = tuple(command)
        self.timeout_s = timeout_s

    def predict(self, text: str) -> Prediction:
        request = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
        try:
            completed = subprocess.run(
                self.command,
                input=request,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=self.timeout_s,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("local prediction command failed") from error
        if completed.returncode != 0:
            raise RuntimeError(f"local prediction command exited {completed.returncode}")
        try:
            value = json.loads(completed.stdout.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError("local prediction command returned invalid JSON") from error
        if not isinstance(value, Mapping):
            raise RuntimeError("local prediction command must return one JSON object")
        return prediction_from_mapping(value, text)


class OllamaMinistral3BAdapter:
    """Opt-in adapter for the existing local `ministral-3:3b` verifier."""

    def __init__(
        self,
        *,
        enabled: bool = False,
        endpoint: str = "http://127.0.0.1:11434/api/generate",
        model: str = "ministral-3:3b",
        timeout_s: float = 45.0,
        num_ctx: int = 4096,
    ):
        if not enabled:
            raise RuntimeError("3B execution is disabled; pass enabled=True deliberately")
        self.endpoint = endpoint
        self.model = model
        self.timeout_s = timeout_s
        self.num_ctx = num_ctx
        self.calls = 0
        self.three_b_calls = 0
        self.three_b_tokens = 0

    def predict(self, text: str) -> Prediction:
        instruction = (
            "Return one JSON object with spans, route, and confidence. Each span has start, end, "
            "entity_type, and action. Actions are MASK, KEEP, or REVIEW. Routes are PASS, REDACT, "
            "or ESCALATE. Offsets are zero-based Python Unicode code-point indices. Use the whole "
            "context to distinguish private identifiers from public examples.\n\nTEXT:\n"
        )
        body = json.dumps({
            "model": self.model,
            "prompt": instruction + text,
            "stream": False,
            "format": "json",
            "keep_alive": "10m",
            "options": {"temperature": 0, "num_ctx": self.num_ctx},
        }).encode("utf-8")
        request = urllib.request.Request(self.endpoint, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                envelope = json.loads(response.read().decode("utf-8"))
            value = json.loads(envelope["response"])
        except Exception as error:
            raise RuntimeError("local 3B verifier request failed") from error
        self.calls += 1
        self.three_b_calls += 1
        self.three_b_tokens += estimate_tokens(text)
        return prediction_from_mapping(value, text)


class CascadeAdapter:
    """Use a compact model first and call 3B only on abstention or low confidence."""

    def __init__(self, local, verifier, *, minimum_confidence: float = 0.80):
        if not 0 <= minimum_confidence <= 1:
            raise ValueError("minimum_confidence must be in [0,1]")
        self.local = local
        self.verifier = verifier
        self.minimum_confidence = minimum_confidence
        self.three_b_calls = 0
        self.three_b_tokens = 0

    def predict(self, text: str) -> Prediction:
        local = self.local.predict(text)
        if local.route != "ESCALATE" and local.confidence >= self.minimum_confidence:
            return local
        before_calls = int(getattr(self.verifier, "three_b_calls", getattr(self.verifier, "calls", 0)))
        before_tokens = int(getattr(self.verifier, "three_b_tokens", 0))
        verified = self.verifier.predict(text)
        after_calls = int(getattr(self.verifier, "three_b_calls", getattr(self.verifier, "calls", before_calls + 1)))
        after_tokens = int(getattr(self.verifier, "three_b_tokens", before_tokens + estimate_tokens(text)))
        self.three_b_calls += max(1, after_calls - before_calls)
        self.three_b_tokens += max(estimate_tokens(text), after_tokens - before_tokens)
        return verified
