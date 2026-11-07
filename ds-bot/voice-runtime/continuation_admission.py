"""Apply the three-way continuation policy to an ephemeral wake session."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from continuation_policy import ContinuationDisposition, ContinuationPolicy
from wake_session import ClarificationResult, ContinuationResult, WakeSessionManager


class ContinuationAction(str, Enum):
    SUBMIT = "submit"
    DROP = "drop"
    CLARIFY = "clarify"


@dataclass(frozen=True)
class ContinuationActionResult:
    action: ContinuationAction
    reason: str
    text: str | None = None
    prompt: str | None = None


class ContinuationAdmission:
    """Keep policy decisions separate from Core submission."""

    PROMPT = "你是在和我说吗？"

    def __init__(self, sessions: WakeSessionManager, policy: ContinuationPolicy):
        self.sessions = sessions
        self.policy = policy

    def evaluate(self, text: str, *, score: float, now: float) -> ContinuationActionResult:
        disposition = self.policy.classify(score)
        if disposition is ContinuationDisposition.ACCEPT:
            try:
                session = self.sessions.accept_continuation(text, now=now)
            except (ValueError, RuntimeError) as error:
                return ContinuationActionResult(ContinuationAction.DROP, str(error))
            return ContinuationActionResult(
                ContinuationAction.SUBMIT, "semantic_accepted", text=session.last_user_text
            )
        if disposition is ContinuationDisposition.REJECT:
            result = self.sessions.reject_continuation(now=now)
            return ContinuationActionResult(ContinuationAction.DROP, result.reason)
        try:
            self.sessions.begin_clarification(text, now=now)
        except (ValueError, RuntimeError) as error:
            return ContinuationActionResult(ContinuationAction.DROP, str(error))
        return ContinuationActionResult(
            ContinuationAction.CLARIFY, "semantic_uncertain", prompt=self.PROMPT
        )

    def confirm(self, confirmed: bool | None, *, now: float) -> ContinuationActionResult:
        result: ClarificationResult = self.sessions.confirm_clarification(confirmed, now=now)
        if result.status == "accepted":
            return ContinuationActionResult(
                ContinuationAction.SUBMIT, "clarification_confirmed", text=result.text
            )
        return ContinuationActionResult(ContinuationAction.DROP, f"clarification_{result.status}")


