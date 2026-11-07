"""Three-way score policy for automatic admission and clarification."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math


class ContinuationDisposition(str, Enum):
    ACCEPT = "accept"
    REJECT = "reject"
    UNCERTAIN = "uncertain"


@dataclass(frozen=True)
class ContinuationPolicy:
    reject_threshold: float
    accept_threshold: float

    def __post_init__(self) -> None:
        if not 0 <= self.reject_threshold < self.accept_threshold <= 1:
            raise ValueError("thresholds must satisfy 0 <= reject < accept <= 1")

    def classify(self, score: float) -> ContinuationDisposition:
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            raise ValueError("score must be numeric")
        score = float(score)
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("score must be finite and between zero and one")
        if score >= self.accept_threshold:
            return ContinuationDisposition.ACCEPT
        if score <= self.reject_threshold:
            return ContinuationDisposition.REJECT
        return ContinuationDisposition.UNCERTAIN


