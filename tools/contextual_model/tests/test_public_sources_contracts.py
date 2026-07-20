from __future__ import annotations

import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

from tools.contextual_model.public_sources.common import (
    PublicSourceError,
    iter_safe_zip_json,
    select_complete_groups,
    write_owner_jsonl,
)
from tools.contextual_model.public_sources.openpii import (
    convert_row as convert_openpii_row,
    deterministic_quota_sample,
)
from tools.contextual_model.public_sources.registry import DatasetAccessError, require_permitted
from tools.contextual_model.public_sources.tab import convert_row as convert_tab_row


class PublicSourceTests(unittest.TestCase):
    def test_registry_fails_closed_for_gated_source(self) -> None:
        self.assertEqual(require_permitted("tab").license, "MIT")
        with self.assertRaises(DatasetAccessError):
            require_permitted("the_stack_smol")

    def test_tab_offsets_actions_and_group_isolation(self) -> None:
        row = {
            "text": "Case 123 concerns Nora. Python is public.",
            "doc_id": "doc-7",
            "annotator_id": "ann-1",
            "dataset_type": "train",
            "task": "Protect Nora",
            "entity_mentions": [
                {
                    "start_offset": 5,
                    "end_offset": 8,
                    "span_text": "123",
                    "entity_type": "CODE",
                    "identifier_type": "QUASI",
                    "entity_id": "e1",
                    "entity_mention_id": "m1",
                    "related_mentions": ["m2"],
                },
                {
                    "start_offset": 18,
                    "end_offset": 22,
                    "span_text": "Nora",
                    "entity_type": "PERSON",
                    "identifier_type": "DIRECT",
                    "entity_id": "e2",
                    "entity_mention_id": "m2",
                },
                {
                    "start_offset": 24,
                    "end_offset": 30,
                    "span_text": "Python",
                    "entity_type": "ORG",
                    "identifier_type": "NO_MASK",
                    "entity_id": "e3",
                    "entity_mention_id": "m3",
                },
            ],
        }
        first = convert_tab_row(row, split_hint="train", revision="rev")
        second = convert_tab_row({**row, "annotator_id": "ann-2"}, split_hint="train")
        self.assertEqual(first.group_id, second.group_id)
        self.assertNotEqual(first.sample_id, second.sample_id)
        self.assertEqual([span.action for span in first.spans], ["MASK", "MASK", "KEEP"])
        rendered = first.private_dict()
        self.assertEqual(rendered["route"], "REDACT")
        self.assertNotIn("span_text", json.dumps(rendered["spans"]))

    def test_openpii_validates_codepoint_offsets_and_is_deterministic(self) -> None:
        rows = []
        for index in range(20):
            value = f"Nora{index}"
            text = f"Contact {value} in Delhi."
            rows.append({
                "source_text": text,
                "privacy_mask": [{"label": "GIVENNAME", "start": 8, "end": 8 + len(value), "value": value}],
                "uid": index,
                "split": "train",
                "language": "en" if index % 2 == 0 else "hi",
                "region": "IN",
                "script": "Latn",
            })
        first, report_a = deterministic_quota_sample(rows, max_rows=7, seed=9)
        second, report_b = deterministic_quota_sample(list(rows), max_rows=7, seed=9)
        self.assertEqual([item.sample_id for item in first], [item.sample_id for item in second])
        self.assertEqual(report_a["selection_sha256"], report_b["selection_sha256"])
        self.assertTrue(all(item.route == "REDACT" for item in first))
        bad = dict(rows[0])
        bad["privacy_mask"] = [{"label": "GIVENNAME", "start": 8, "end": 12, "value": "wrong"}]
        with self.assertRaises(PublicSourceError):
            convert_openpii_row(bad)

    def test_zip_traversal_and_symlink_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            traversal = Path(directory) / "bad.zip"
            with zipfile.ZipFile(traversal, "w") as archive:
                archive.writestr("../escape.json", json.dumps([]))
            with self.assertRaises(PublicSourceError):
                list(iter_safe_zip_json(traversal))

            symlink = Path(directory) / "symlink.zip"
            info = zipfile.ZipInfo("linked.json")
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            with zipfile.ZipFile(symlink, "w") as archive:
                archive.writestr(info, "target")
            with self.assertRaises(PublicSourceError):
                list(iter_safe_zip_json(symlink))

    def test_owner_permissions_content_free_labels_and_group_budget(self) -> None:
        rows = []
        for index, name in enumerate(("Nora", "Ishan", "Mei")):
            text = f"Contact {name}."
            rows.append(convert_openpii_row({
                "source_text": text,
                "privacy_mask": [{"label": "GIVENNAME", "start": 8, "end": 8 + len(name), "value": name}],
                "uid": index,
                "split": "train",
                "language": "en",
                "region": "IN",
            }))
        target = sum(row.private_dict()["estimated_tokens"] for row in rows[:2])
        selected, report = select_complete_groups(rows, target)
        self.assertEqual(report["selected_tokens"], target)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "rows.jsonl"
            count = write_owner_jsonl(path, (row.private_dict() for row in selected))
            self.assertEqual(count, len(selected))
            self.assertEqual(os.stat(path.parent).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            # The content-free selection report contains no raw source text.
            rendered = json.dumps(report)
            self.assertNotIn("Nora", rendered)
            self.assertNotIn("Ishan", rendered)


if __name__ == "__main__":
    unittest.main()
