# Contextual privacy benchmark v2

This package builds a deterministic, synthetic-only locked benchmark for deciding
which information should be masked, preserved, or escalated after reading full
agent context. It is intentionally separate from every training source.

## Coverage

The default 10,000-case fixture includes paired and unpaired slices for:

- private versus explicitly public person names;
- team, project, customer, and internal alias codes;
- co-reference and repeated mentions;
- tool-call JSON/YAML-like structures;
- terminal/code hard negatives;
- live-looking credentials versus documented placeholders;
- conventional PII and safe example domains;
- Unicode boundaries;
- long-distance evidence and window seams;
- ambiguous cases that must escalate.

Every counterfactual pair shares a group and pair ID. Template, group, exact-text,
and normalized-text contamination checks must pass before scoring.

## Generate

```bash
umask 077
python -m tools.contextual_model.benchmark_v2.cli generate \
  --count 10000 \
  --seed 1729 \
  --fixture ~/.local/share/privacyai-contextual-model/benchmarks/contextual-v2.jsonl \
  --manifest ~/.local/share/privacyai-contextual-model/manifests/contextual-v2.json
```

The fixture contains invented raw text and is mode `0600` inside a mode `0700`
directory. The manifest contains counts and hashes only.

## Score a future student or existing router

The command adapter sends one `{"text": ...}` object over stdin and expects one
JSON prediction on stdout:

```json
{
  "spans": [
    {"start": 10, "end": 18, "entity_type": "PROJECT", "action": "MASK"}
  ],
  "route": "REDACT",
  "confidence": 0.97
}
```

```bash
python -m tools.contextual_model.benchmark_v2.cli score \
  --fixture ~/.local/share/privacyai-contextual-model/benchmarks/contextual-v2.jsonl \
  --adapter command \
  --command python path/to/predict_json.py \
  --report ~/.local/share/privacyai-contextual-model/benchmarks/student-report.json
```

## Compare the existing 3B verifier

The repository's local baseline is `ministral-3:3b` through Ollama. Its adapter
is disabled unless `--enable-3b` is explicit:

```bash
python -m tools.contextual_model.benchmark_v2.cli score \
  --fixture ~/.local/share/privacyai-contextual-model/benchmarks/contextual-v2.jsonl \
  --adapter ollama-3b \
  --enable-3b \
  --timeout 45 \
  --report ~/.local/share/privacyai-contextual-model/benchmarks/ministral-3b-report.json
```

Keep Ollama `num_ctx` fixed at 4096 while comparing generations to avoid model
reload churn. Run the linear router, ONNX PII gate, contextual student, direct 3B,
and student-to-3B cascade on the identical fixture.

## Metrics and gates

Reports contain no benchmark text. They include:

- exact and overlap span precision/recall/F1;
- critical false negatives;
- contextual MASK recall;
- route and full-case accuracy;
- safe false-positive and escalation rates;
- pair-joint consistency;
- ECE and Brier calibration;
- per-family worst slice;
- bootstrap confidence intervals;
- latency p50/p95/p99;
- 3B calls, call rate, tokens sent, and estimated tokens avoided.

Default release gates are strict and must be tuned only on a separate development
fixture, never on the locked benchmark. A model does not replace the 3B verifier
unless it passes the locked gates and materially reduces verifier calls without
increasing critical false negatives.
