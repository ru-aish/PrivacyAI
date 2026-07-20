"""Streaming converter for CC-BY-4.0 OpenPII 1.5M."""
from __future__ import annotations

import hashlib
import random
from collections import Counter
from collections.abc import Iterable, Iterator, Mapping
from typing import Any

from .common import LabelSpan, PublicSample, PublicSourceError, stable_id
from .registry import require_permitted

DATASET_ID = "ai4privacy/pii-masking-openpii-1.5m"


def convert_row(row: Mapping[str, Any], *, revision: str | None = None) -> PublicSample:
    require_permitted("openpii_1_5m")
    text = row.get("source_text")
    uid = row.get("uid")
    if not isinstance(text, str) or not text:
        raise PublicSourceError("OpenPII row is missing source_text")
    if uid is None:
        raise PublicSourceError("OpenPII row is missing uid")
    masks = row.get("privacy_mask")
    if not isinstance(masks, list):
        raise PublicSourceError("OpenPII privacy_mask must be a list")

    spans: list[LabelSpan] = []
    for index, item in enumerate(masks):
        if not isinstance(item, Mapping):
            raise PublicSourceError("OpenPII mask must be an object")
        try:
            start = int(item["start"])
            end = int(item["end"])
        except (KeyError, TypeError, ValueError) as error:
            raise PublicSourceError("OpenPII mask has invalid offsets") from error
        label = str(item.get("label") or "")
        value = item.get("value")
        if value is not None and (not isinstance(value, str) or text[start:end] != value):
            raise PublicSourceError("OpenPII value does not match code-point offsets")
        span = LabelSpan(
            start=start,
            end=end,
            entity_type=label,
            action="MASK",
            mention_id=f"mask:{index}",
            sensitivity_basis="synthetic_pii",
        )
        span.validate(text)
        spans.append(span)

    language = str(row.get("language") or "unknown")
    region = str(row.get("region") or "unknown")
    source_split = str(row.get("split") or "train")
    sample = PublicSample(
        sample_id=stable_id("openpii-1.5m", uid),
        group_id=f"openpii:{uid}",
        source="openpii_1_5m",
        source_split=source_split,
        text=text,
        spans=tuple(sorted(spans, key=lambda item: (item.start, item.end, item.entity_type))),
        metadata={
            "dataset_id": DATASET_ID,
            "dataset_revision": revision,
            "license": "CC-BY-4.0",
            "attribution": "Ai4Privacy / Ai Suisse SA, OpenPII 1.5M (2026)",
            "synthetic": True,
            "language": language,
            "region": region,
            "script": row.get("script"),
            "source_dataset": row.get("source_dataset"),
            "uid_hash": hashlib.sha256(str(uid).encode()).hexdigest()[:24],
        },
    )
    sample.validate()
    return sample


def deterministic_quota_sample(
    rows: Iterable[Mapping[str, Any]],
    *,
    max_rows: int,
    seed: int = 1729,
    language_quotas: Mapping[str, int] | None = None,
    region_quotas: Mapping[str, int] | None = None,
    revision: str | None = None,
) -> tuple[list[PublicSample], dict[str, Any]]:
    """Reservoir-sample a stream while enforcing optional language/region caps."""
    if max_rows < 1:
        raise ValueError("max_rows must be positive")
    language_quotas = dict(language_quotas or {})
    region_quotas = dict(region_quotas or {})
    rng = random.Random(seed)
    reservoir: list[PublicSample] = []
    language_counts: Counter[str] = Counter()
    region_counts: Counter[str] = Counter()
    eligible_seen = 0
    rejected_quota = 0

    for row in rows:
        language = str(row.get("language") or "unknown")
        region = str(row.get("region") or "unknown")
        if language in language_quotas and language_counts[language] >= language_quotas[language]:
            rejected_quota += 1
            continue
        if region in region_quotas and region_counts[region] >= region_quotas[region]:
            rejected_quota += 1
            continue
        sample = convert_row(row, revision=revision)
        eligible_seen += 1
        if len(reservoir) < max_rows:
            reservoir.append(sample)
            language_counts[language] += 1
            region_counts[region] += 1
            continue
        replacement = rng.randrange(eligible_seen)
        if replacement >= max_rows:
            continue
        evicted = reservoir[replacement]
        old_language = str(evicted.metadata.get("language") or "unknown")
        old_region = str(evicted.metadata.get("region") or "unknown")
        language_counts[old_language] -= 1
        region_counts[old_region] -= 1
        reservoir[replacement] = sample
        language_counts[language] += 1
        region_counts[region] += 1

    reservoir.sort(key=lambda item: item.sample_id)
    report = {
        "schema_version": "privacyai-openpii-sampling-v1",
        "dataset_id": DATASET_ID,
        "dataset_revision": revision,
        "seed": seed,
        "eligible_seen": eligible_seen,
        "selected_rows": len(reservoir),
        "rejected_quota": rejected_quota,
        "language_counts": dict(sorted(language_counts.items())),
        "region_counts": dict(sorted(region_counts.items())),
        "selection_sha256": hashlib.sha256("\n".join(item.sample_id for item in reservoir).encode()).hexdigest(),
    }
    return reservoir, report


def stream_huggingface(
    *,
    split: str = "train",
    revision: str | None = None,
) -> Iterator[Mapping[str, Any]]:
    """Yield rows lazily; importing datasets is optional until this is called."""
    require_permitted("openpii_1_5m")
    try:
        from datasets import load_dataset
    except ImportError as error:  # pragma: no cover - environment dependent
        raise RuntimeError("install the optional `datasets` package to stream OpenPII") from error
    dataset = load_dataset(DATASET_ID, split=split, streaming=True, revision=revision)
    for row in dataset:
        if not isinstance(row, Mapping):
            raise PublicSourceError("OpenPII stream yielded a non-object row")
        yield row
