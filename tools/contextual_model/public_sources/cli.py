"""Metadata-safe command line interface for public contextual-model sources."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from .common import PublicSample, select_complete_groups, write_owner_jsonl
from .openpii import deterministic_quota_sample, stream_huggingface
from .registry import registry_manifest, require_permitted
from .tab import iter_tab_archives


def _quota(value: str) -> dict[str, int]:
    result: dict[str, int] = {}
    if not value:
        return result
    for part in value.split(","):
        key, separator, raw = part.partition("=")
        if not separator or not key.strip():
            raise argparse.ArgumentTypeError("quotas must use key=count pairs")
        try:
            count = int(raw)
        except ValueError as error:
            raise argparse.ArgumentTypeError(f"invalid quota: {part}") from error
        if count < 0:
            raise argparse.ArgumentTypeError("quota counts must be non-negative")
        result[key.strip()] = count
    return result


def _write_manifest(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def _select(samples: list[PublicSample], target_tokens: int | None) -> tuple[list[PublicSample], dict[str, Any]]:
    if target_tokens is None:
        return samples, {
            "schema_version": "privacyai-public-source-selection-v1",
            "target_tokens": None,
            "selected_tokens": sum(row.private_dict()["estimated_tokens"] for row in samples),
            "underfill_tokens": None,
            "input_groups": len({row.group_id for row in samples}),
            "selected_groups": len({row.group_id for row in samples}),
            "selected_samples": len(samples),
        }
    return select_complete_groups(samples, target_tokens)


def _tab(args: argparse.Namespace) -> dict[str, Any]:
    require_permitted("tab")
    samples = list(iter_tab_archives(args.archives, revision=args.revision))
    selected, selection = _select(samples, args.target_tokens)
    count = write_owner_jsonl(args.output, (row.private_dict() for row in selected))
    return {
        "schema_version": "privacyai-public-source-conversion-v1",
        "source": "tab",
        "dataset_revision": args.revision,
        "input_archives": len(args.archives),
        "input_samples": len(samples),
        "written_samples": count,
        "selection": selection,
        "license": "MIT",
        "attribution_required": True,
    }


def _openpii(args: argparse.Namespace) -> dict[str, Any]:
    require_permitted("openpii_1_5m")
    samples, sampling = deterministic_quota_sample(
        stream_huggingface(split=args.split, revision=args.revision),
        max_rows=args.max_rows,
        seed=args.seed,
        language_quotas=args.language_quotas,
        region_quotas=args.region_quotas,
        revision=args.revision,
    )
    selected, selection = _select(samples, args.target_tokens)
    count = write_owner_jsonl(args.output, (row.private_dict() for row in selected))
    return {
        "schema_version": "privacyai-public-source-conversion-v1",
        "source": "openpii_1_5m",
        "dataset_revision": args.revision,
        "source_split": args.split,
        "written_samples": count,
        "sampling": sampling,
        "selection": selection,
        "license": "CC-BY-4.0",
        "attribution_required": True,
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="License-aware public data tools for the PrivacyAI contextual model")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("inventory", help="Print content-free source policy metadata")

    tab = commands.add_parser("tab", help="Convert local TAB ZIP archives")
    tab.add_argument("archives", nargs="+", type=Path)
    tab.add_argument("--revision")
    tab.add_argument("--target-tokens", type=int)
    tab.add_argument("--output", type=Path, required=True)
    tab.add_argument("--manifest", type=Path, required=True)

    pii = commands.add_parser("openpii", help="Stream and sample OpenPII 1.5M")
    pii.add_argument("--split", default="train")
    pii.add_argument("--revision")
    pii.add_argument("--max-rows", type=int, required=True)
    pii.add_argument("--target-tokens", type=int)
    pii.add_argument("--seed", type=int, default=1729)
    pii.add_argument("--language-quotas", type=_quota, default={})
    pii.add_argument("--region-quotas", type=_quota, default={})
    pii.add_argument("--output", type=Path, required=True)
    pii.add_argument("--manifest", type=Path, required=True)

    gated = commands.add_parser("check-access", help="Fail closed for unknown or gated sources")
    gated.add_argument("dataset_key")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "inventory":
        print(json.dumps(registry_manifest(), indent=2, sort_keys=True))
        return 0
    if args.command == "check-access":
        policy = require_permitted(args.dataset_key)
        print(json.dumps(policy.public_dict(), indent=2, sort_keys=True))
        return 0
    report = _tab(args) if args.command == "tab" else _openpii(args)
    _write_manifest(args.manifest, report)
    # Reports contain counts, hashes, licensing, and selection metadata only.
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
