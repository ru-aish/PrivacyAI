"""CLI for generating and scoring the locked synthetic benchmark."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .adapters import CommandJsonAdapter, OllamaMinistral3BAdapter
from .core import Prediction, generate_cases, read_owner_fixture, score, write_owner_fixture


def _write_private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="PrivacyAI contextual benchmark v2")
    commands = root.add_subparsers(dest="command_name", required=True)

    generate = commands.add_parser("generate")
    generate.add_argument("--count", type=int, default=10_000)
    generate.add_argument("--seed", type=int, default=1729)
    generate.add_argument("--fixture", type=Path, required=True)
    generate.add_argument("--manifest", type=Path, required=True)

    run = commands.add_parser("score")
    run.add_argument("--fixture", type=Path, required=True)
    run.add_argument("--report", type=Path, required=True)
    run.add_argument("--adapter", choices=("command", "ollama-3b", "oracle"), required=True)
    run.add_argument("--command", nargs="+")
    run.add_argument("--timeout", type=float, default=45.0)
    run.add_argument("--minimum-confidence", type=float, default=0.80)
    run.add_argument("--enable-3b", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command_name == "generate":
        cases = generate_cases(args.count, seed=args.seed)
        manifest = write_owner_fixture(args.fixture, cases)
        manifest.update({"seed": args.seed, "requested_count": args.count})
        _write_private_json(args.manifest, manifest)
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0

    cases = read_owner_fixture(args.fixture)
    if args.adapter == "command":
        if not args.command:
            raise SystemExit("--command is required for the command adapter")
        predictor = CommandJsonAdapter(args.command, timeout_s=args.timeout)
    elif args.adapter == "ollama-3b":
        predictor = OllamaMinistral3BAdapter(enabled=args.enable_3b, timeout_s=args.timeout)
    else:
        # Oracle exists only to validate benchmark/scoring mechanics. It is not
        # a model result and is identified explicitly in the saved report.
        by_text = {case.text: case for case in cases}

        class Oracle:
            def predict(self, text: str) -> Prediction:
                case = by_text[text]
                return Prediction(case.spans, case.route, 1.0)

        predictor = Oracle()

    report = score(cases, predictor, timeout_s=args.timeout)
    report["adapter"] = args.adapter
    _write_private_json(args.report, report)
    # The report has hashes, offsets, decisions, metrics, and latencies only.
    print(json.dumps({key: value for key, value in report.items() if key != "cases"}, indent=2, sort_keys=True))
    return 0 if report["release_gate"]["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
