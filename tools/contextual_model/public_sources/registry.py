"""License and access policy for contextual-model public sources.

The registry is deliberately code-reviewed rather than discovered dynamically:
changing a dataset, license, or access state must be an explicit repository
change. Reports generated from this module contain no source text.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Final


@dataclass(frozen=True, slots=True)
class DatasetPolicy:
    key: str
    repository_id: str
    license: str
    access: str
    attribution: str
    permitted: bool
    notes: str

    def public_dict(self) -> dict[str, str | bool]:
        return asdict(self)


POLICIES: Final[dict[str, DatasetPolicy]] = {
    "tab": DatasetPolicy(
        key="tab",
        repository_id="ildpil/text-anonymization-benchmark",
        license="MIT",
        access="public",
        attribution="Text Anonymization Benchmark (TAB), Ildiko Pilan et al.; preserve the MIT license notice.",
        permitted=True,
        notes="Manually annotated ECHR anonymization data. Keep document and annotator variants in one leakage group.",
    ),
    "openpii_1_5m": DatasetPolicy(
        key="openpii_1_5m",
        repository_id="ai4privacy/pii-masking-openpii-1.5m",
        license="CC-BY-4.0",
        access="public",
        attribution="Ai4Privacy / Ai Suisse SA, OpenPII 1.5M (2026), CC-BY-4.0.",
        permitted=True,
        notes="Synthetic multilingual PII. Stream and sample; do not require a full 5+ GB download.",
    ),
    "the_stack_smol": DatasetPolicy(
        key="the_stack_smol",
        repository_id="bigcode/the-stack-smol",
        license="mixed source licenses plus BigCode terms",
        access="gated",
        attribution="Per-example source license and BigCode Terms of Use are required.",
        permitted=False,
        notes="Fail closed until the user separately accepts the current gated terms and provenance obligations.",
    ),
}


class DatasetAccessError(PermissionError):
    """Raised when a source is unknown, gated, or not approved by policy."""


def policy_for(key: str) -> DatasetPolicy:
    try:
        return POLICIES[key]
    except KeyError as error:
        raise DatasetAccessError(f"unknown public dataset key: {key}") from error


def require_permitted(key: str) -> DatasetPolicy:
    policy = policy_for(key)
    if not policy.permitted or policy.access != "public":
        raise DatasetAccessError(
            f"dataset {policy.repository_id} is {policy.access}; automatic access is disabled"
        )
    return policy


def registry_manifest() -> dict[str, object]:
    return {
        "schema_version": "privacyai-public-source-registry-v1",
        "sources": [POLICIES[key].public_dict() for key in sorted(POLICIES)],
    }
