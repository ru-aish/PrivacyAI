"""Converter for the MIT-licensed Text Anonymization Benchmark (TAB)."""
from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from .common import LabelSpan, PublicSample, PublicSourceError, iter_safe_zip_json, stable_id
from .registry import require_permitted

_ACTIONS = {"DIRECT": "MASK", "QUASI": "MASK", "NO_MASK": "KEEP"}


def _rows(value: Any) -> Iterator[Mapping[str, Any]]:
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, Mapping):
                raise PublicSourceError("TAB JSON list contains a non-object row")
            yield item
        return
    if isinstance(value, Mapping):
        # Some releases wrap the examples, while others store one document per
        # JSON file. Support both without guessing arbitrary nested structures.
        for key in ("documents", "examples", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                yield from _rows(nested)
                return
        if "text" in value and "entity_mentions" in value:
            yield value
            return
    raise PublicSourceError("unsupported TAB JSON structure")


def _related(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return tuple(value)
    raise PublicSourceError("TAB related_mentions must be null, string, or list[str]")


def convert_row(row: Mapping[str, Any], *, split_hint: str, revision: str | None = None) -> PublicSample:
    require_permitted("tab")
    text = row.get("text")
    document_id = row.get("doc_id")
    annotator_id = row.get("annotator_id")
    if not isinstance(text, str) or not text:
        raise PublicSourceError("TAB row is missing text")
    if not isinstance(document_id, str) or not document_id:
        raise PublicSourceError("TAB row is missing doc_id")
    if not isinstance(annotator_id, str) or not annotator_id:
        raise PublicSourceError("TAB row is missing annotator_id")
    split = str(row.get("dataset_type") or split_hint)
    mentions = row.get("entity_mentions")
    if not isinstance(mentions, list):
        raise PublicSourceError("TAB entity_mentions must be a list")

    spans: list[LabelSpan] = []
    for mention in mentions:
        if not isinstance(mention, Mapping):
            raise PublicSourceError("TAB mention must be an object")
        try:
            start = int(mention["start_offset"])
            end = int(mention["end_offset"])
        except (KeyError, TypeError, ValueError) as error:
            raise PublicSourceError("TAB mention has invalid offsets") from error
        identifier_type = str(mention.get("identifier_type") or "")
        try:
            action = _ACTIONS[identifier_type]
        except KeyError as error:
            raise PublicSourceError(f"unsupported TAB identifier_type: {identifier_type}") from error
        span_text = mention.get("span_text")
        if span_text is not None and (not isinstance(span_text, str) or text[start:end] != span_text):
            raise PublicSourceError("TAB span_text does not match code-point offsets")
        span = LabelSpan(
            start=start,
            end=end,
            entity_type=str(mention.get("entity_type") or "UNKNOWN"),
            action=action,
            entity_id=str(mention["entity_id"]) if mention.get("entity_id") is not None else None,
            mention_id=str(mention["entity_mention_id"]) if mention.get("entity_mention_id") is not None else None,
            related_mentions=_related(mention.get("related_mentions")),
            sensitivity_basis=identifier_type,
        )
        span.validate(text)
        spans.append(span)

    # All annotators and target variants for one court document remain in the
    # same group. This prevents near-identical documents and co-reference chains
    # from leaking between train, validation, and holdout.
    sample = PublicSample(
        sample_id=stable_id("tab", document_id, annotator_id, str(row.get("task") or "")),
        group_id=f"tab:{document_id}",
        source="tab",
        source_split=split,
        text=text,
        spans=tuple(sorted(spans, key=lambda item: (item.start, item.end, item.entity_type))),
        metadata={
            "dataset_id": "ildpil/text-anonymization-benchmark",
            "dataset_revision": revision,
            "license": "MIT",
            "attribution": "Text Anonymization Benchmark (TAB), Ildiko Pilan et al.",
            "document_id": document_id,
            "annotator_id": annotator_id,
            "task": row.get("task"),
            "quality_checked": row.get("quality_checked"),
            "source_meta": row.get("meta") if isinstance(row.get("meta"), Mapping) else {},
        },
    )
    sample.validate()
    return sample


def iter_tab_archives(paths: list[Path], *, revision: str | None = None) -> Iterator[PublicSample]:
    require_permitted("tab")
    for path in sorted(paths):
        lower = path.stem.casefold()
        split_hint = "validation" if "dev" in lower else "test" if "test" in lower else "train"
        for _, value in iter_safe_zip_json(path):
            for row in _rows(value):
                yield convert_row(row, split_hint=split_hint, revision=revision)
