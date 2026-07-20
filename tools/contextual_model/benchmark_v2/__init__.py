"""Brutal, leakage-resistant benchmark for the PrivacyAI contextual model."""

from .core import (
    BenchmarkError,
    Case,
    Prediction,
    Span,
    generate_cases,
    leakage_check,
    score,
)

__all__ = [
    "BenchmarkError",
    "Case",
    "Prediction",
    "Span",
    "generate_cases",
    "leakage_check",
    "score",
]
