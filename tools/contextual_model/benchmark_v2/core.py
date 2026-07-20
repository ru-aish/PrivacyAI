"""Leakage-resistant synthetic benchmark for contextual privacy routing."""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import statistics
import time
import unicodedata
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol

ACTIONS = frozenset({"MASK", "KEEP", "REVIEW"})
ROUTES = frozenset({"PASS", "REDACT", "ESCALATE"})
CONTEXTUAL_TYPES = frozenset({"PERSON", "TEAM", "PROJECT", "CUSTOMER", "INTERNAL_ALIAS"})
CRITICAL_TYPES = frozenset({"SECRET", "PASSWORD", "AUTH_TOKEN", "PRIVATE_KEY", "CREDIT_CARD", "GOVERNMENT_ID"})


class BenchmarkError(ValueError):
    pass


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()


def normalized_hash(value: str) -> str:
    return sha256_text(" ".join(unicodedata.normalize("NFKC", value).casefold().split()))


def estimate_tokens(value: str) -> int:
    return max(1, (len(value.encode("utf-8", errors="surrogatepass")) + 3) // 4)


@dataclass(frozen=True, slots=True)
class Span:
    start: int
    end: int
    entity_type: str
    action: str
    critical: bool = False

    def validate(self, text: str) -> None:
        if not 0 <= self.start < self.end <= len(text):
            raise BenchmarkError("span outside Unicode code-point bounds")
        if not self.entity_type:
            raise BenchmarkError("entity_type is required")
        if self.action not in ACTIONS:
            raise BenchmarkError(f"invalid action: {self.action}")


@dataclass(frozen=True, slots=True)
class Case:
    case_id: str
    group_id: str
    template_id: str
    family: str
    text: str
    spans: tuple[Span, ...]
    route: str
    pair_id: str | None = None
    pair_relation: str | None = None
    safe: bool = False
    metadata: Mapping[str, Any] | None = None

    def validate(self) -> None:
        if not self.case_id or not self.group_id or not self.template_id or not self.family:
            raise BenchmarkError("case identity fields are required")
        if not self.text or "\x00" in self.text:
            raise BenchmarkError("case text must be non-empty Unicode text")
        if self.route not in ROUTES:
            raise BenchmarkError(f"invalid route: {self.route}")
        prior = -1
        for span in sorted(self.spans, key=lambda item: (item.start, item.end)):
            span.validate(self.text)
            if span.start < prior:
                raise BenchmarkError("benchmark spans overlap")
            prior = span.end
        expected = "ESCALATE" if any(span.action == "REVIEW" for span in self.spans) else "REDACT" if any(span.action == "MASK" for span in self.spans) else "PASS"
        if expected != self.route:
            raise BenchmarkError(f"route/action mismatch: expected {expected}, got {self.route}")
        if self.safe and self.route != "PASS":
            raise BenchmarkError("safe cases must PASS")
        if self.pair_relation not in {None, "flip", "same"}:
            raise BenchmarkError("invalid pair relation")

    def private_dict(self) -> dict[str, Any]:
        self.validate()
        return {
            "schema_version": "privacyai-contextual-benchmark-case-v2",
            "case_id": self.case_id,
            "group_id": self.group_id,
            "template_id": self.template_id,
            "family": self.family,
            "text": self.text,
            "text_sha256": sha256_text(self.text),
            "normalized_sha256": normalized_hash(self.text),
            "text_chars": len(self.text),
            "estimated_tokens": estimate_tokens(self.text),
            "spans": [asdict(span) for span in self.spans],
            "route": self.route,
            "pair_id": self.pair_id,
            "pair_relation": self.pair_relation,
            "safe": self.safe,
            "metadata": dict(self.metadata or {}),
        }

    def public_dict(self) -> dict[str, Any]:
        result = self.private_dict()
        result.pop("text")
        return result


@dataclass(frozen=True, slots=True)
class Prediction:
    spans: tuple[Span, ...]
    route: str
    confidence: float

    def validate(self, text: str) -> None:
        if self.route not in ROUTES:
            raise BenchmarkError("prediction has invalid route")
        if not 0.0 <= self.confidence <= 1.0:
            raise BenchmarkError("prediction confidence outside [0,1]")
        prior = -1
        for span in sorted(self.spans, key=lambda item: (item.start, item.end)):
            span.validate(text)
            if span.start < prior:
                raise BenchmarkError("prediction spans overlap")
            prior = span.end


class Predictor(Protocol):
    def predict(self, text: str) -> Prediction: ...


def prediction_from_mapping(value: Mapping[str, Any], text: str) -> Prediction:
    allowed = {"spans", "entities", "route", "confidence"}
    extra = set(value) - allowed
    if extra:
        raise BenchmarkError(f"prediction contains unapproved keys: {sorted(extra)}")
    raw_spans = value.get("spans", value.get("entities", []))
    if not isinstance(raw_spans, list):
        raise BenchmarkError("prediction spans must be a list")
    spans = []
    for item in raw_spans:
        if not isinstance(item, Mapping):
            raise BenchmarkError("prediction span must be an object")
        spans.append(Span(
            start=int(item["start"]),
            end=int(item["end"]),
            entity_type=str(item.get("entity_type") or item.get("label") or "UNKNOWN"),
            action=str(item.get("action") or "MASK"),
            critical=bool(item.get("critical", False)),
        ))
    prediction = Prediction(tuple(spans), str(value.get("route") or "PASS"), float(value.get("confidence", 1.0)))
    prediction.validate(text)
    return prediction


def _one_span(text: str, value: str, entity_type: str, action: str, *, critical: bool = False) -> tuple[Span, ...]:
    start = text.index(value)
    return (Span(start, start + len(value), entity_type, action, critical),)


def _case(index: int, template: str, family: str, text: str, spans: tuple[Span, ...], *, pair_id: str | None = None, pair_relation: str | None = None, safe: bool = False, group: str | None = None, metadata: Mapping[str, Any] | None = None) -> Case:
    route = "ESCALATE" if any(span.action == "REVIEW" for span in spans) else "REDACT" if any(span.action == "MASK" for span in spans) else "PASS"
    case = Case(
        case_id=f"ctx-v2-{index:06d}",
        group_id=group or f"group-{index:06d}",
        template_id=template,
        family=family,
        text=text,
        spans=spans,
        route=route,
        pair_id=pair_id,
        pair_relation=pair_relation,
        safe=safe,
        metadata=metadata,
    )
    case.validate()
    return case


_NAMES = ("Quenby", "Ishan", "Meilin", "Sora", "Anik", "Nоra", "Zuleika", "Tavish")
_TEAMS = ("TULIP-8", "ORBIT-17", "EMBER-4", "KITE-29", "MINT-6")
_PROJECTS = ("VEX-881", "LANTERN-42", "HARBOR-9", "CEDAR-73", "NOVA-116")
_CUSTOMERS = ("Q9M2", "ZK-74", "ACCT-R7P", "CUST-81X", "KAPPA-31")
_PUBLIC = ("Python", "ModernBERT", "PostgreSQL", "Kubernetes", "OpenAPI")


def generate_cases(count: int = 10_000, *, seed: int = 1729) -> list[Case]:
    """Generate invented, deterministic, lexically varied benchmark cases."""
    if count < 1:
        raise ValueError("count must be positive")
    rng = random.Random(seed)
    cases: list[Case] = []
    index = 0
    pair_number = 0
    while len(cases) < count:
        family_index = pair_number % 10
        nonce = hashlib.blake2b(f"{seed}:{pair_number}".encode(), digest_size=4).hexdigest()
        name = _NAMES[pair_number % len(_NAMES)] + nonce[:2]
        team = _TEAMS[pair_number % len(_TEAMS)] + nonce[2:]
        project = _PROJECTS[pair_number % len(_PROJECTS)] + nonce[:2]
        customer = _CUSTOMERS[pair_number % len(_CUSTOMERS)] + nonce[1:3]
        pair_id = f"pair-{pair_number:05d}"
        group_id = f"pair-group-{pair_number:05d}"

        if family_index == 0:
            private = f"Meeting note: {name} is the private attendee; remove the name before sending outside the team."
            public = f"Public conference schedule: {name} is the published speaker name and may remain visible."
            pair = (
                _case(index, "person-context-private", "contextual_person", private, _one_span(private, name, "PERSON", "MASK"), pair_id=pair_id, pair_relation="flip", group=group_id),
                _case(index + 1, "person-context-public", "contextual_person", public, _one_span(public, name, "PERSON", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id),
            )
        elif family_index == 1:
            private = f"Internal roster maps {team} to the incident-response team. Do not expose that code."
            public = f"The public documentation uses {team} as an invented tutorial identifier."
            pair = (
                _case(index, "team-private", "team_project_alias", private, _one_span(private, team, "TEAM", "MASK"), pair_id=pair_id, pair_relation="flip", group=group_id),
                _case(index + 1, "team-public", "team_project_alias", public, _one_span(public, team, "TEAM", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id),
            )
        elif family_index == 2:
            private = f"The customer escalation belongs to account {customer}; share only after replacing the customer code."
            public = f"Example payload: customer_code={customer}. This value is synthetic and approved for docs."
            pair = (
                _case(index, "customer-private", "customer_code", private, _one_span(private, customer, "CUSTOMER", "MASK"), pair_id=pair_id, pair_relation="flip", group=group_id),
                _case(index + 1, "customer-public", "customer_code", public, _one_span(public, customer, "CUSTOMER", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id),
            )
        elif family_index == 3:
            private = f"Project {project} is still under embargo. It appears again below.\nStatus: {project} must be redacted."
            first = private.index(project)
            second = private.index(project, first + 1)
            spans = (Span(first, first + len(project), "PROJECT", "MASK"), Span(second, second + len(project), "PROJECT", "MASK"))
            safe = f"Release notes publicly announce project {project}; both the name and release date are public."
            pair = (
                _case(index, "coreference-private", "coreference", private, spans, pair_id=pair_id, pair_relation="flip", group=group_id),
                _case(index + 1, "coreference-public", "coreference", safe, _one_span(safe, project, "PROJECT", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id),
            )
        elif family_index == 4:
            private = f'{{"tool":"crm_lookup","result":{{"customer":"{customer}","visibility":"internal"}}}}'
            safe = f'{{"tool":"example","arguments":{{"customer":"{customer}","synthetic":true}}}}'
            pair = (
                _case(index, "tool-private", "tool_structured", private, _one_span(private, customer, "CUSTOMER", "MASK"), pair_id=pair_id, pair_relation="flip", group=group_id),
                _case(index + 1, "tool-safe", "tool_structured", safe, _one_span(safe, customer, "CUSTOMER", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id),
            )
        elif family_index == 5:
            secret = f"sk_live_{nonce}A7x9"
            private = f"curl https://service.invalid -H 'Authorization: Bearer {secret}'"
            safe_value = f"sk_test_EXAMPLE_{nonce}"
            safe = f"Documentation placeholder: Authorization: Bearer {safe_value}"
            pair = (
                _case(index, "secret-live", "secret_regression", private, _one_span(private, secret, "AUTH_TOKEN", "MASK", critical=True), pair_id=pair_id, pair_relation="flip", group=group_id),
                _case(index + 1, "secret-placeholder", "secret_regression", safe, _one_span(safe, safe_value, "AUTH_TOKEN", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id),
            )
        elif family_index == 6:
            email = f"user{pair_number}@private.invalid"
            private = f"Contact address {email} belongs to the user and must not leave the support ticket."
            public_value = f"person{pair_number}@example.com"
            safe = f"RFC-style documentation address {public_value} is a safe example."
            pair = (
                _case(index, "email-private", "conventional_pii", private, _one_span(private, email, "EMAIL", "MASK"), pair_id=pair_id, pair_relation="flip", group=group_id),
                _case(index + 1, "email-example", "conventional_pii", safe, _one_span(safe, public_value, "EMAIL", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id),
            )
        elif family_index == 7:
            technology = _PUBLIC[pair_number % len(_PUBLIC)]
            uuid_value = f"123e4567-e89b-12d3-a456-{pair_number:012d}"[-36:]
            safe_a = f"Install {technology} and use UUID {uuid_value} in the public tutorial fixture."
            safe_b = f"const privateKeyName = 'PUBLIC_KEY'; // identifier only, not key material {nonce}"
            pair = (
                _case(index, "technical-safe", "terminal_code_negative", safe_a, _one_span(safe_a, technology, "PUBLIC_TECH", "KEEP"), pair_id=pair_id, pair_relation="same", safe=True, group=group_id),
                _case(index + 1, "identifier-safe", "terminal_code_negative", safe_b, (), pair_id=pair_id, pair_relation="same", safe=True, group=group_id),
            )
        elif family_index == 8:
            filler = "public build output line\n" * (70 + pair_number % 40)
            private = filler + f"At the far end, internal project {project} must be removed."
            safe = filler + f"At the far end, public library {project} is an invented benchmark token."
            pair = (
                _case(index, "long-context-private", "long_context", private, _one_span(private, project, "PROJECT", "MASK"), pair_id=pair_id, pair_relation="flip", group=group_id, metadata={"window_seam": True}),
                _case(index + 1, "long-context-safe", "long_context", safe, _one_span(safe, project, "PROJECT", "KEEP"), pair_id=pair_id, pair_relation="flip", safe=True, group=group_id, metadata={"window_seam": True}),
            )
        else:
            ambiguous = f"The label {project} appears without evidence of whether it is public or internal."
            safe = f"The word client means an HTTP client in this code comment. nonce={nonce}"
            pair = (
                _case(index, "ambiguous-review", "ambiguity_ood", ambiguous, _one_span(ambiguous, project, "INTERNAL_ALIAS", "REVIEW"), pair_id=pair_id, pair_relation="same", group=group_id),
                _case(index + 1, "semantic-hard-negative", "ambiguity_ood", safe, (), pair_id=pair_id, pair_relation="same", safe=True, group=group_id),
            )

        for item in pair:
            if len(cases) < count:
                cases.append(item)
        index += 2
        pair_number += 1

    # Stable shuffle prevents family blocks from hiding ordering/state bugs while
    # preserving deterministic IDs and pair/group metadata.
    rng.shuffle(cases)
    return cases


def write_owner_fixture(path: Path, cases: Iterable[Case]) -> dict[str, Any]:
    rows = list(cases)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        for case in rows:
            handle.write(json.dumps(case.private_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)
    return {
        "schema_version": "privacyai-contextual-benchmark-fixture-v2",
        "cases": len(rows),
        "groups": len({case.group_id for case in rows}),
        "templates": len({case.template_id for case in rows}),
        "families": sorted({case.family for case in rows}),
        "fixture_sha256": sha256_text("\n".join(case.public_dict()["text_sha256"] for case in rows)),
    }


def read_owner_fixture(path: Path) -> list[Case]:
    cases = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
                spans = tuple(Span(**span) for span in value.get("spans", []))
                case = Case(
                    case_id=value["case_id"], group_id=value["group_id"], template_id=value["template_id"],
                    family=value["family"], text=value["text"], spans=spans, route=value["route"],
                    pair_id=value.get("pair_id"), pair_relation=value.get("pair_relation"), safe=bool(value.get("safe")),
                    metadata=value.get("metadata") or {},
                )
                case.validate()
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                raise BenchmarkError(f"{path}:{line_number}: invalid benchmark case") from error
            cases.append(case)
    return cases


def leakage_check(cases: Iterable[Case], references: Iterable[Case] = ()) -> None:
    left, right = list(cases), list(references)
    left_groups = {case.group_id for case in left}
    right_groups = {case.group_id for case in right}
    if left_groups & right_groups:
        raise BenchmarkError("group leakage across benchmark partitions")
    left_templates = {case.template_id for case in left}
    right_templates = {case.template_id for case in right}
    if left_templates & right_templates:
        raise BenchmarkError("template leakage across benchmark partitions")
    exact: set[str] = set()
    normalized: set[str] = set()
    for case in left + right:
        case.validate()
        raw = sha256_text(case.text)
        norm = normalized_hash(case.text)
        if raw in exact or norm in normalized:
            raise BenchmarkError("exact or normalized duplicate benchmark text")
        exact.add(raw)
        normalized.add(norm)


def _overlap(left: Span, right: Span) -> bool:
    if left.entity_type != right.entity_type or left.action != right.action:
        return False
    intersection = max(0, min(left.end, right.end) - max(left.start, right.start))
    union = max(left.end, right.end) - min(left.start, right.start)
    return union > 0 and intersection / union >= 0.5


def _match_counts(gold: tuple[Span, ...], predicted: tuple[Span, ...], *, exact: bool) -> tuple[int, int, int, int]:
    used: set[int] = set()
    tp = 0
    critical_fn = 0
    for target in gold:
        found = None
        for index, candidate in enumerate(predicted):
            if index in used:
                continue
            matched = (
                target.start == candidate.start and target.end == candidate.end and
                target.entity_type == candidate.entity_type and target.action == candidate.action
            ) if exact else _overlap(target, candidate)
            if matched:
                found = index
                break
        if found is None:
            if target.critical or target.entity_type in CRITICAL_TYPES:
                critical_fn += 1
        else:
            used.add(found)
            tp += 1
    return tp, len(predicted) - len(used), len(gold) - tp, critical_fn


def _prf(tp: int, fp: int, fn: int) -> dict[str, float]:
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1}


def _bootstrap(values: list[float], *, rounds: int = 500, seed: int = 1729) -> list[float]:
    if not values:
        return [0.0, 0.0]
    rng = random.Random(seed)
    size = len(values)
    samples = [statistics.fmean(rng.choice(values) for _ in range(size)) for _ in range(rounds)]
    samples.sort()
    return [samples[int(0.025 * (rounds - 1))], samples[int(0.975 * (rounds - 1))]]


def score(
    cases: Iterable[Case],
    predictor: Predictor | Callable[[str], Prediction],
    *,
    timeout_s: float | None = None,
    release_gates: Mapping[str, float] | None = None,
) -> dict[str, Any]:
    rows = []
    exact_totals = [0, 0, 0, 0]
    overlap_totals = [0, 0, 0, 0]
    for case in cases:
        case.validate()
        started = time.perf_counter()
        output = predictor.predict(case.text) if hasattr(predictor, "predict") else predictor(case.text)
        latency = time.perf_counter() - started
        if timeout_s is not None and latency > timeout_s:
            output = Prediction((), "ESCALATE", 0.0)
        output.validate(case.text)
        exact = _match_counts(case.spans, output.spans, exact=True)
        overlap = _match_counts(case.spans, output.spans, exact=False)
        for index, value in enumerate(exact): exact_totals[index] += value
        for index, value in enumerate(overlap): overlap_totals[index] += value
        route_ok = output.route == case.route
        label_ok = exact[1] == 0 and exact[2] == 0
        rows.append({"case": case, "prediction": output, "latency": latency, "route_ok": route_ok, "label_ok": label_ok})

    count = len(rows)
    if not count:
        raise BenchmarkError("cannot score an empty benchmark")
    exact_scores = _prf(*exact_totals[:3])
    overlap_scores = _prf(*overlap_totals[:3])
    safe_rows = [row for row in rows if row["case"].safe]
    contextual_gold = sum(1 for row in rows for span in row["case"].spans if span.entity_type in CONTEXTUAL_TYPES and span.action == "MASK")
    contextual_found = 0
    for row in rows:
        for target in row["case"].spans:
            if target.entity_type not in CONTEXTUAL_TYPES or target.action != "MASK": continue
            if any(_overlap(target, candidate) for candidate in row["prediction"].spans): contextual_found += 1

    pairs: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["case"].pair_id:
            pairs[row["case"].pair_id].append(row)
    complete_pairs = [items for items in pairs.values() if len(items) == 2]
    pair_joint = statistics.fmean(
        float(all(item["route_ok"] and item["label_ok"] for item in items)) for items in complete_pairs
    ) if complete_pairs else 1.0

    outcomes = [float(row["route_ok"] and row["label_ok"]) for row in rows]
    probabilities = [row["prediction"].confidence for row in rows]
    brier = statistics.fmean((probability - outcome) ** 2 for probability, outcome in zip(probabilities, outcomes))
    bins = [[] for _ in range(10)]
    for probability, outcome in zip(probabilities, outcomes):
        bins[min(9, int(probability * 10))].append((probability, outcome))
    ece = sum(
        len(bucket) / count * abs(statistics.fmean(item[0] for item in bucket) - statistics.fmean(item[1] for item in bucket))
        for bucket in bins if bucket
    )

    by_family: dict[str, Any] = {}
    for family in sorted({row["case"].family for row in rows}):
        subset = [row for row in rows if row["case"].family == family]
        by_family[family] = {
            "count": len(subset),
            "route_accuracy": statistics.fmean(float(row["route_ok"]) for row in subset),
            "exact_case_accuracy": statistics.fmean(float(row["route_ok"] and row["label_ok"]) for row in subset),
        }

    latencies = sorted(row["latency"] * 1000 for row in rows)
    actual_3b_calls = int(getattr(predictor, "three_b_calls", getattr(predictor, "calls", 0)))
    actual_3b_tokens = int(getattr(predictor, "three_b_tokens", 0))
    report: dict[str, Any] = {
        "schema_version": "privacyai-contextual-benchmark-report-v2",
        "count": count,
        "exact_span": exact_scores,
        "overlap_span": overlap_scores,
        "critical_false_negatives": exact_totals[3],
        "route_accuracy": statistics.fmean(float(row["route_ok"]) for row in rows),
        "case_accuracy": statistics.fmean(outcomes),
        "safe_false_positive_rate": statistics.fmean(float(not (row["route_ok"] and row["label_ok"])) for row in safe_rows) if safe_rows else 0.0,
        "safe_escalation_rate": statistics.fmean(float(row["prediction"].route == "ESCALATE") for row in safe_rows) if safe_rows else 0.0,
        "contextual_mask_recall": contextual_found / contextual_gold if contextual_gold else 1.0,
        "pair_joint_accuracy": pair_joint,
        "calibration": {"brier": brier, "ece": ece},
        "latency_ms": {
            "mean": statistics.fmean(latencies),
            "p50": latencies[max(0, math.ceil(0.50 * count) - 1)],
            "p95": latencies[max(0, math.ceil(0.95 * count) - 1)],
            "p99": latencies[max(0, math.ceil(0.99 * count) - 1)],
        },
        "three_b": {
            "calls": actual_3b_calls,
            "call_rate": actual_3b_calls / count,
            "tokens": actual_3b_tokens,
            "estimated_tokens_avoided": sum(estimate_tokens(row["case"].text) for row in rows) - actual_3b_tokens,
        },
        "per_family": by_family,
        "worst_family": min(by_family, key=lambda key: by_family[key]["case_accuracy"]),
        "bootstrap_ci95": {
            "route_accuracy": _bootstrap([float(row["route_ok"]) for row in rows]),
            "case_accuracy": _bootstrap(outcomes),
        },
        "cases": [
            {
                "case_id": row["case"].case_id,
                "text_sha256": sha256_text(row["case"].text),
                "text_chars": len(row["case"].text),
                "route_ok": row["route_ok"],
                "label_ok": row["label_ok"],
                "latency_ms": row["latency"] * 1000,
            }
            for row in rows
        ],
    }
    gates = dict(release_gates or {
        "exact_span_f1": 0.90,
        "contextual_mask_recall": 0.97,
        "route_accuracy": 0.97,
        "pair_joint_accuracy": 0.94,
        "safe_false_positive_rate_max": 0.01,
        "critical_false_negatives_max": 0.0,
    })
    actual = {
        "exact_span_f1": report["exact_span"]["f1"],
        "contextual_mask_recall": report["contextual_mask_recall"],
        "route_accuracy": report["route_accuracy"],
        "pair_joint_accuracy": report["pair_joint_accuracy"],
        "safe_false_positive_rate_max": report["safe_false_positive_rate"],
        "critical_false_negatives_max": float(report["critical_false_negatives"]),
    }
    failures = []
    for key, threshold in gates.items():
        value = actual[key]
        if key.endswith("_max"):
            if value > threshold: failures.append(key)
        elif value < threshold:
            failures.append(key)
    report["release_gate"] = {"passed": not failures, "thresholds": gates, "actual": actual, "failures": failures}
    return report
