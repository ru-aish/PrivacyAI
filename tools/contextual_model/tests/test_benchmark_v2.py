from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from tools.contextual_model.benchmark_v2.adapters import CallableAdapter, CascadeAdapter, CommandJsonAdapter
from tools.contextual_model.benchmark_v2.core import (
    BenchmarkError,
    Case,
    Prediction,
    Span,
    generate_cases,
    leakage_check,
    read_owner_fixture,
    score,
    write_owner_fixture,
)


class BenchmarkV2Tests(unittest.TestCase):
    def test_default_generator_is_deterministic_large_and_diverse(self) -> None:
        first = generate_cases(10_000, seed=1729)
        second = generate_cases(10_000, seed=1729)
        self.assertEqual([case.case_id for case in first], [case.case_id for case in second])
        self.assertEqual([case.text for case in first[:20]], [case.text for case in second[:20]])
        self.assertEqual(len(first), 10_000)
        self.assertGreaterEqual(len({case.family for case in first}), 10)
        self.assertTrue(any(case.route == "ESCALATE" for case in first))
        self.assertTrue(any(span.critical for case in first for span in case.spans))
        self.assertTrue(all("example" not in case.text.casefold() or case.safe for case in first if case.family == "secret_regression" and case.route == "PASS"))

    def test_fixture_permissions_and_content_free_manifest(self) -> None:
        cases = generate_cases(30)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "fixture.jsonl"
            manifest = write_owner_fixture(path, cases)
            self.assertEqual(os.stat(path.parent).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(len(read_owner_fixture(path)), 30)
            rendered = json.dumps(manifest)
            self.assertNotIn(cases[0].text, rendered)

    def test_leakage_detects_groups_templates_and_normalized_duplicates(self) -> None:
        one = generate_cases(1)[0]
        distinct_text = "A separate safe fixture that is intentionally assigned to a conflicting partition."
        same_group = Case(
            case_id="same-group", group_id=one.group_id, template_id="different-template",
            family="partition_probe", text=distinct_text, spans=(), route="PASS", safe=True,
        )
        with self.assertRaisesRegex(BenchmarkError, "group leakage"):
            leakage_check([one], [same_group])

        same_template = Case(
            case_id="same-template", group_id="different-group", template_id=one.template_id,
            family="partition_probe", text=distinct_text + " template", spans=(), route="PASS", safe=True,
        )
        with self.assertRaisesRegex(BenchmarkError, "template leakage"):
            leakage_check([one], [same_template])

        duplicate = Case(
            case_id="duplicate", group_id="new-group", template_id="new-template",
            family=one.family, text="  " + one.text.upper() + "  ", spans=(), route="PASS", safe=True,
        )
        with self.assertRaisesRegex(BenchmarkError, "duplicate"):
            leakage_check([one, duplicate])

    def test_oracle_metrics_pass_and_bad_predictor_fails(self) -> None:
        cases = generate_cases(100)
        mapping = {case.text: case for case in cases}
        oracle = CallableAdapter(lambda text: Prediction(mapping[text].spans, mapping[text].route, 1.0))
        perfect = score(cases, oracle)
        self.assertTrue(perfect["release_gate"]["passed"])
        self.assertEqual(perfect["critical_false_negatives"], 0)
        self.assertEqual(perfect["exact_span"]["f1"], 1.0)
        bad = CallableAdapter(lambda text: Prediction((), "PASS", 0.99))
        failed = score(cases, bad)
        self.assertFalse(failed["release_gate"]["passed"])
        self.assertGreater(failed["critical_false_negatives"], 0)
        self.assertNotIn(cases[0].text, json.dumps(failed))

    def test_command_adapter_uses_stdin_and_cascade_counts_3b(self) -> None:
        script = (
            "import json,sys; d=json.load(sys.stdin); "
            "json.dump({'spans':[],'route':'PASS','confidence':0.9},sys.stdout)"
        )
        adapter = CommandJsonAdapter([sys.executable, "-c", script])
        prediction = adapter.predict("private source text")
        self.assertEqual(prediction.route, "PASS")

        class Local:
            def predict(self, text):
                return Prediction((), "ESCALATE", 0.2)

        class Verifier:
            calls = 0
            three_b_calls = 0
            three_b_tokens = 0
            def predict(self, text):
                self.calls += 1
                self.three_b_calls += 1
                self.three_b_tokens += 7
                return Prediction((), "PASS", 0.8)

        cascade = CascadeAdapter(Local(), Verifier())
        self.assertEqual(cascade.predict("text").route, "PASS")
        self.assertEqual(cascade.three_b_calls, 1)
        self.assertGreaterEqual(cascade.three_b_tokens, 1)

    def test_prediction_schema_rejects_raw_text_and_bad_offsets(self) -> None:
        from tools.contextual_model.benchmark_v2.core import prediction_from_mapping
        with self.assertRaises(BenchmarkError):
            prediction_from_mapping({"spans": [], "route": "PASS", "confidence": 1, "text": "leak"}, "abc")
        with self.assertRaises(BenchmarkError):
            prediction_from_mapping({"spans": [{"start": 0, "end": 4, "entity_type": "PERSON", "action": "MASK"}], "route": "REDACT", "confidence": 1}, "abc")


if __name__ == "__main__":
    unittest.main()
