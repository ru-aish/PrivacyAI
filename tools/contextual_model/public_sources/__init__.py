"""License-aware public data adapters for PrivacyAI contextual-model training."""

from .common import LabelSpan, PublicSample, PublicSourceError
from .openpii import convert_row as convert_openpii_row
from .registry import DatasetAccessError, DatasetPolicy, policy_for, require_permitted
from .tab import convert_row as convert_tab_row

__all__ = [
    "DatasetAccessError",
    "DatasetPolicy",
    "LabelSpan",
    "PublicSample",
    "PublicSourceError",
    "convert_openpii_row",
    "convert_tab_row",
    "policy_for",
    "require_permitted",
]
