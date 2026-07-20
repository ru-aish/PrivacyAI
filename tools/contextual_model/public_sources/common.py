"""Dependency-light contracts shared by public contextual-model sources."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Mapping

_TOKENISH = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[^\w\s]|\s+", re.UNICODE)


class PublicSourceError(ValueError):
    """Invalid source data, offsets, archive layout, or output contract."""


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()


def stable_id(*parts: object) -> str:
    return sha256_text("\x1f".join(str(part) for part in parts))[:32]


def normalized_fingerprint(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return sha256_text(" ".join(normalized.split()))


def estimate_tokens(text: str) -> int:
    """Conservative offline estimate used only for bounded source selection."""
    total = 0.0
    for match in _TOKENISH.finditer(text):
        token = match.group(0)
        if token.isspace():
            total += max(0.15, len(token) / 14.0)
        elif token[0].isalpha() or token[0] == "_":
            boundaries = token.count("_") + sum(
                token[index].isupper() and token[index - 1].islower()
                for index in range(1, len(token))
            )
            total += max(1.0, len(token) / 5.0) + boundaries * 0.45
        elif token[0].isdigit():
            total += max(1.0, len(token) / 3.0)
        else:
            total += 1.0
    return max(1, int(total * 1.08 + 0.999999))


@dataclass(frozen=True, slots=True)
class LabelSpan:
    start: int
    end: int
    entity_type: str
    action: str
    entity_id: str | None = None
    mention_id: str | None = None
    related_mentions: tuple[str, ...] = ()
    sensitivity_basis: str | None = None

    def validate(self, text: str) -> None:
        if not (isinstance(self.start, int) and isinstance(self.end, int)):
            raise PublicSourceError("span offsets must be integers")
        if not 0 <= self.start < self.end <= len(text):
            raise PublicSourceError("span is outside Unicode code-point bounds")
        if not self.entity_type:
            raise PublicSourceError("span entity_type is required")
        if self.action not in {"MASK", "KEEP", "REVIEW"}:
            raise PublicSourceError(f"unsupported action: {self.action}")

    def offset_dict(self) -> dict[str, Any]:
        """Return labels without repeating the raw sensitive substring."""
        return {
            "start": self.start,
            "end": self.end,
            "entity_type": self.entity_type,
            "action": self.action,
            "entity_id": self.entity_id,
            "mention_id": self.mention_id,
            "related_mentions": list(self.related_mentions),
            "sensitivity_basis": self.sensitivity_basis,
        }


@dataclass(frozen=True, slots=True)
class PublicSample:
    sample_id: str
    group_id: str
    source: str
    source_split: str
    text: str
    spans: tuple[LabelSpan, ...]
    metadata: Mapping[str, Any]

    def validate(self) -> None:
        if not self.sample_id or not self.group_id or not self.source or not self.source_split:
            raise PublicSourceError("sample identity fields must be non-empty")
        if not isinstance(self.text, str) or not self.text or "\x00" in self.text:
            raise PublicSourceError("sample text must be non-empty Unicode text")
        prior_end = -1
        for span in sorted(self.spans, key=lambda item: (item.start, item.end)):
            span.validate(self.text)
            if span.start < prior_end:
                raise PublicSourceError("crossing or overlapping source spans are not supported")
            prior_end = span.end

    @property
    def route(self) -> str:
        if any(span.action == "REVIEW" for span in self.spans):
            return "ESCALATE"
        if any(span.action == "MASK" for span in self.spans):
            return "REDACT"
        return "PASS"

    def private_dict(self) -> dict[str, Any]:
        self.validate()
        return {
            "schema_version": "privacyai-public-context-sample-v1",
            "sample_id": self.sample_id,
            "group_id": self.group_id,
            "source": self.source,
            "source_split": self.source_split,
            "text": self.text,
            "text_sha256": sha256_text(self.text),
            "normalized_sha256": normalized_fingerprint(self.text),
            "text_chars": len(self.text),
            "text_bytes": len(self.text.encode("utf-8", errors="surrogatepass")),
            "estimated_tokens": estimate_tokens(self.text),
            "route": self.route,
            "spans": [span.offset_dict() for span in self.spans],
            "metadata": dict(self.metadata),
        }

    def public_dict(self) -> dict[str, Any]:
        private = self.private_dict()
        private.pop("text")
        return private


def iter_safe_zip_json(path: Path) -> Iterator[tuple[str, Any]]:
    """Yield JSON members without extracting archives to the filesystem."""
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as error:
        raise PublicSourceError(f"invalid ZIP archive: {path}") from error
    with archive:
        for member in sorted(archive.infolist(), key=lambda item: item.filename):
            pure = PurePosixPath(member.filename)
            unix_mode = member.external_attr >> 16
            if (
                pure.is_absolute()
                or ".." in pure.parts
                or member.filename.startswith(("/", "\\"))
                or stat.S_ISLNK(unix_mode)
            ):
                raise PublicSourceError(f"unsafe ZIP member: {member.filename}")
            if member.is_dir() or pure.suffix.casefold() != ".json":
                continue
            try:
                with archive.open(member) as handle:
                    value = json.load(handle)
            except (UnicodeError, json.JSONDecodeError, OSError) as error:
                raise PublicSourceError(f"invalid JSON member: {member.filename}") from error
            yield member.filename, value


def write_owner_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    count = 0
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(dict(row), ensure_ascii=False, sort_keys=True, separators=(",", ":")))
            handle.write("\n")
            count += 1
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)
    return count


def select_complete_groups(samples: Iterable[PublicSample], target_tokens: int) -> tuple[list[PublicSample], dict[str, Any]]:
    """Deterministically maximize the reachable sum <= target by complete group."""
    if target_tokens < 1:
        raise ValueError("target_tokens must be positive")
    groups: dict[str, list[PublicSample]] = {}
    for sample in samples:
        sample.validate()
        groups.setdefault(sample.group_id, []).append(sample)
    ordered = []
    for group_id, rows in groups.items():
        tokens = sum(estimate_tokens(row.text) for row in rows)
        ordered.append((hashlib.sha256(group_id.encode()).hexdigest(), group_id, tokens, rows))
    ordered.sort()

    reachable = 1
    mask = (1 << (target_tokens + 1)) - 1
    additions: list[int] = []
    usable: list[tuple[str, str, int, list[PublicSample]]] = []
    for item in ordered:
        tokens = item[2]
        if tokens > target_tokens:
            continue
        shifted = (reachable << tokens) & mask
        additions.append(shifted & ~reachable)
        usable.append(item)
        reachable |= shifted
        if (reachable >> target_tokens) & 1:
            break
    best = reachable.bit_length() - 1
    chosen: list[PublicSample] = []
    selected_groups: list[str] = []
    for item, new in zip(reversed(usable), reversed(additions)):
        tokens = item[2]
        if best >= tokens and ((new >> best) & 1):
            selected_groups.append(item[1])
            chosen.extend(item[3])
            best -= tokens
    chosen.sort(key=lambda row: (row.group_id, row.sample_id))
    selected_tokens = sum(estimate_tokens(row.text) for row in chosen)
    report = {
        "schema_version": "privacyai-public-source-selection-v1",
        "target_tokens": target_tokens,
        "selected_tokens": selected_tokens,
        "underfill_tokens": target_tokens - selected_tokens,
        "input_groups": len(groups),
        "selected_groups": len(selected_groups),
        "selected_samples": len(chosen),
        "selection_sha256": sha256_text("\n".join(sorted(selected_groups))),
    }
    return chosen, report
