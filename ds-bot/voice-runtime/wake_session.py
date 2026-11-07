"""Wake-gated conversation state for post-wake semantic admission.

The first complete owner utterance after an explicit role wake is admitted by
the product rule. Later utterances remain inside the short-lived session but
must be admitted by the semantic evaluator before they are submitted to Core.
This module stores only ephemeral session context; it does not write a
Profile or a conversation history.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
import math

from continuation_input import ContinuationTurn
from voice_addressing import ContextSnapshot


class SessionPhase(str, Enum):
    FIRST_TURN_PENDING = "first_turn_pending"
    CONTEXT_GATED = "context_gated"
    CLARIFICATION_PENDING = "clarification_pending"


@dataclass(frozen=True)
class WakeSession:
    session_id: str
    bot_id: str
    phase: SessionPhase
    opened_at: float
    expires_at: float
    turn_count: int = 0
    last_user_text: str = ""
    last_user_at: float | None = None
    last_agent_reply: str = ""
    pending_user_text: str = ""
    resume_expires_at: float | None = None
    turns: tuple[ContinuationTurn, ...] = ()


@dataclass(frozen=True)
class _InflightInput:
    text: str
    ordinal: int
    deadline: float
    bridge_accepted: bool = False
    completed: bool = False


@dataclass(frozen=True)
class ContinuationResult:
    accepted: bool
    reason: str
    session: WakeSession | None = None


@dataclass(frozen=True)
class ClarificationResult:
    status: str
    text: str | None = None
    session: WakeSession | None = None


class WakeSessionStateError(ValueError):
    """Raised when a caller tries to record a turn in the wrong phase."""


class WakeSessionManager:
    """Manage one device's ephemeral wake-gated conversation session."""

    def __init__(self, *, first_turn_timeout: float = 8.0,
                 continuation_timeout: float = 12.0,
                 clarification_timeout: float = 5.0):
        if first_turn_timeout <= 0 or continuation_timeout <= 0 or clarification_timeout <= 0:
            raise ValueError("wake session timeouts must be positive")
        self.first_turn_timeout = float(first_turn_timeout)
        self.continuation_timeout = float(continuation_timeout)
        self.clarification_timeout = float(clarification_timeout)
        self._current: WakeSession | None = None
        self._inflight: dict[str, _InflightInput] = {}
        self._turn_order: dict[str, int] = {}
        self._audio_deadline = 0.

    @property
    def current(self) -> WakeSession | None:
        return self._current

    def open(self, session_id: str, bot_id: str, *, now: float) -> WakeSession:
        session_id = self._required_text(session_id, "session_id")
        bot_id = self._required_text(bot_id, "bot_id")
        self.close()
        self._current = WakeSession(
            session_id=session_id,
            bot_id=bot_id,
            phase=SessionPhase.FIRST_TURN_PENDING,
            opened_at=float(now),
            expires_at=float(now) + self.first_turn_timeout,
        )
        return self._current

    def can_accept_first_turn(self, *, now: float) -> bool:
        session = self._current
        return bool(
            session
            and session.phase is SessionPhase.FIRST_TURN_PENDING
            and float(now) < session.expires_at
        )

    def accept_first_turn(self, text: str, *, now: float) -> WakeSession:
        self._require_active(SessionPhase.FIRST_TURN_PENDING, now=now)
        text = self._required_text(text, "text")
        self._current = replace(
            self._current,
            phase=SessionPhase.CONTEXT_GATED,
            expires_at=float(now) + self.continuation_timeout,
            turn_count=1,
            last_user_text=text,
            last_user_at=float(now),
        )
        return self._current

    def accept_continuation(self, text: str, *, now: float) -> WakeSession:
        self._require_active(SessionPhase.CONTEXT_GATED, now=now)
        text = self._required_text(text, "text")
        self._current = replace(
            self._current,
            expires_at=float(now) + self.continuation_timeout,
            turn_count=self._current.turn_count + 1,
            last_user_text=text,
            last_user_at=float(now),
        )
        return self._current

    def try_accept_continuation(self, text: str, *, now: float) -> ContinuationResult:
        session = self._current
        if session is None:
            return ContinuationResult(False, "session_inactive")
        if session.phase is not SessionPhase.CONTEXT_GATED:
            return ContinuationResult(False, "first_turn_pending", session)
        if self.expire(now=now):
            return ContinuationResult(False, "session_expired")
        if not isinstance(text, str) or not text.strip():
            return ContinuationResult(False, "empty_text", session)
        return ContinuationResult(True, "accepted", self.accept_continuation(text, now=now))

    def reject_continuation(self, *, now: float) -> ContinuationResult:
        session = self._current
        if session is None:
            return ContinuationResult(False, "session_inactive")
        if self.expire(now=now):
            return ContinuationResult(False, "session_expired")
        return ContinuationResult(False, "semantic_rejected", session)

    def begin_clarification(self, text: str, *, now: float) -> WakeSession:
        session = self._require_active(SessionPhase.CONTEXT_GATED, now=now)
        text = self._required_text(text, "text")
        self._current = replace(
            session,
            phase=SessionPhase.CLARIFICATION_PENDING,
            expires_at=float(now) + self.clarification_timeout,
            pending_user_text=text,
            resume_expires_at=session.expires_at,
        )
        return self._current

    def finish_clarification_prompt(self, *, now: float) -> bool:
        """Start the confirmation window after the clarification audio is emitted."""
        session = self._current
        if session is None or session.phase is not SessionPhase.CLARIFICATION_PENDING:
            return False
        self._current = replace(
            session,
            expires_at=float(now) + self.clarification_timeout,
        )
        return True

    def confirm_clarification(self, confirmed: bool | None, *, now: float) -> ClarificationResult:
        session = self._current
        if session is None:
            return ClarificationResult("session_inactive")
        if session.phase is not SessionPhase.CLARIFICATION_PENDING:
            return ClarificationResult("no_clarification", session=session)
        if float(now) >= session.expires_at:
            self.close()
            return ClarificationResult("expired")
        if confirmed is True:
            text = session.pending_user_text
            self._current = replace(
                session,
                phase=SessionPhase.CONTEXT_GATED,
                expires_at=float(now) + self.continuation_timeout,
                turn_count=session.turn_count + 1,
                last_user_text=text,
                last_user_at=float(now),
                pending_user_text="",
                resume_expires_at=None,
            )
            return ClarificationResult("accepted", text=text, session=self._current)
        if confirmed is False:
            resume_expires_at = session.resume_expires_at or float(now)
            if resume_expires_at <= float(now):
                self.close()
                return ClarificationResult("expired")
            self._current = replace(
                session,
                phase=SessionPhase.CONTEXT_GATED,
                expires_at=resume_expires_at,
                pending_user_text="",
                resume_expires_at=None,
            )
            return ClarificationResult("rejected", session=self._current)
        self.close()
        return ClarificationResult("ambiguous")

    def record_agent_reply(self, text: str, *, now: float) -> WakeSession:
        """Legacy state helper. Runtime history uses complete_input instead."""
        self._require_active(SessionPhase.CONTEXT_GATED, now=now)
        text = self._required_text(text, "text")
        self._current = replace(
            self._current,
            last_agent_reply=text,
            expires_at=float(now) + self.continuation_timeout,
        )
        return self._current

    @property
    def awaiting_reply(self) -> bool:
        return any(not item.completed for item in self._inflight.values())

    @property
    def deadline(self) -> float:
        session = self._current
        if session is None:
            return 0.
        if session.phase is not SessionPhase.CONTEXT_GATED:
            return max(session.expires_at, self._audio_deadline)
        return max(session.expires_at, self._audio_deadline,
                   max((item.deadline for item in self._inflight.values()), default=0.))

    def hold_audio(self, *, started_at: float, ended_at: float, now: float,
                   processing_timeout: float = 25.) -> bool:
        """Finish one bounded utterance that began inside the original window.

        This temporary hold covers VAD/inference latency, not idle listening.
        Releasing a rejected utterance restores the original expiry.
        """
        session = self._current
        if (session is None or not all(math.isfinite(v) for v in
                (started_at, ended_at, now, processing_timeout))
                or processing_timeout <= 0 or started_at > ended_at
                or ended_at < session.opened_at - .5 or ended_at > now + .5
                or ended_at - started_at > 31. or started_at >= self.deadline):
            return False
        self._audio_deadline = now + processing_timeout
        return True

    def release_audio(self) -> None:
        self._audio_deadline = 0.

    def register_input(self, input_id: str, text: str, *, session_id: str,
                       bot_id: str) -> bool:
        """Retain the original admitted text before AgentSession schedules it."""
        session = self._current
        if (session is None or session.session_id != session_id
                or session.bot_id != bot_id
                or session.phase is not SessionPhase.CONTEXT_GATED
                or not isinstance(input_id, str) or not input_id.strip()
                or not isinstance(text, str) or not text.strip()
                or len(text) > ContextSnapshot.MAX_TEXT
                or input_id in self._inflight or input_id in self._turn_order
                or len(self._inflight) >= 4):
            return False
        self._inflight[input_id] = _InflightInput(
            text.strip(), session.turn_count,
            float(session.last_user_at if session.last_user_at is not None else session.opened_at) + 120.)
        return True

    def mark_input_accepted(self, input_id: str) -> bool:
        item = self._inflight.get(input_id)
        if item is None:
            return False
        self._inflight[input_id] = replace(item, bridge_accepted=True)
        return True

    def discard_input(self, input_id: str) -> None:
        self._inflight.pop(input_id, None)

    def complete_input(self, input_id: str, response_id: str, text: str, *,
                       session_id: str, bot_id: str, now: float) -> bool:
        session = self._current
        if (session is None or session.session_id != session_id
                or session.bot_id != bot_id):
            return False
        if self.expire(now=now):
            return False
        item = self._inflight.get(input_id)
        if (item is None or not item.bridge_accepted
                or item.completed
                or not isinstance(response_id, str) or not response_id.strip()
                or not isinstance(text, str) or not text.strip()
                or len(text) > ContextSnapshot.MAX_TEXT
                or any(turn.response_id == response_id for turn in session.turns)):
            return False
        turn = ContinuationTurn(input_id, response_id, item.text, text.strip())
        self._inflight[input_id] = replace(item, completed=True)
        self._turn_order[input_id] = item.ordinal
        turns = tuple(sorted((*session.turns, turn),
                             key=lambda value: self._turn_order[value.input_id]))[-3:]
        self._turn_order = {value.input_id: self._turn_order[value.input_id] for value in turns}
        self._current = replace(
            session, turns=turns, last_agent_reply=turns[-1].agent_reply)
        return True

    def finish_reply_audio(self, input_id: str, *, now: float) -> bool:
        item = self._inflight.get(input_id)
        if item is None or not item.completed:
            return False
        if self.expire(now=now):
            return False
        self._inflight.pop(input_id, None)
        if item.deadline <= float(now) or self._current.phase is not SessionPhase.CONTEXT_GATED:
            return False
        self._current = replace(self._current, expires_at=float(now) + self.continuation_timeout)
        return True

    def expire(self, *, now: float) -> bool:
        if self._current is None:
            return False
        for identifier, item in list(self._inflight.items()):
            if float(now) >= item.deadline:
                self._inflight.pop(identifier, None)
        if float(now) < self.deadline:
            return False
        self.close()
        return True

    def close(self) -> None:
        self._current = None
        self._audio_deadline = 0.
        self._inflight.clear()
        self._turn_order.clear()

    def short_context(self) -> dict[str, object]:
        session = self._current
        if session is None:
            return {}
        return {
            "session_id": session.session_id,
            "target_bot_id": session.bot_id,
            "phase": session.phase.value,
            "turn_count": session.turn_count,
            "last_user_text": session.last_user_text,
            "last_user_at": session.last_user_at,
            "last_agent_reply": session.last_agent_reply,
        }

    def _require_active(self, phase: SessionPhase, *, now: float) -> WakeSession:
        session = self._current
        if session is None:
            raise WakeSessionStateError("session_inactive")
        if self.expire(now=now):
            raise WakeSessionStateError("session_expired")
        if session.phase is not phase:
            raise WakeSessionStateError(f"expected_{phase.value}")
        return session

    @staticmethod
    def _required_text(value: str, name: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} is required")
        return value.strip()


