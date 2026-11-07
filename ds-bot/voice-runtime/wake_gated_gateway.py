"""Gateway-owned bounded context and fail-closed continuation orchestration."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import inspect
import math
import time
from typing import Awaitable, Callable, Mapping

from audio_adapter import AudioSegment, OwnerDecision
from clarification import parse_confirmation
from continuation_admission import ContinuationAction, ContinuationAdmission
from continuation_input import ContinuationContext
from voice_addressing import ContextSnapshot
from wake_session import SessionPhase, WakeSession, WakeSessionManager
from wake_binding import WakeBindingGate


@dataclass(frozen=True)
class WakeAdmissionResult:
    action: ContinuationAction
    reason: str
    text: str | None = None
    prompt: str | None = None
    bot_id: str | None = None
    snapshot: ContextSnapshot | None = None
    owner: OwnerDecision | None = None
    segment: AudioSegment | None = None
    score: float | None = None
    session_id: str | None = None

    @property
    def admitted(self) -> bool:
        return self.action is ContinuationAction.SUBMIT


@dataclass(frozen=True)
class _PendingCandidate:
    text: str
    owner: OwnerDecision
    segment: AudioSegment
    bot_id: str
    snapshot: ContextSnapshot
    session_id: str
    score: float


SnapshotProvider = Callable[
    [str], ContextSnapshot | Mapping[str, object] | Awaitable[ContextSnapshot | Mapping[str, object]]
]
ScoreEvaluator = Callable[[ContextSnapshot, ContinuationContext, str], float | Awaitable[float]]


class WakeGatedAdmission:
    """One candidate slot covers reply waiting, model waiting and clarification."""

    def __init__(self, sessions: WakeSessionManager, continuation: ContinuationAdmission, *,
                 snapshot_provider: SnapshotProvider, score_evaluator: ScoreEvaluator | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 wake_binding: WakeBindingGate | None = None, diagnostics=None,
                 asr_wake_fallback_enabled: bool = False):
        if not callable(snapshot_provider):
            raise ValueError('snapshot_provider is required')
        self.sessions = sessions
        self.continuation = continuation
        self.snapshot_provider = snapshot_provider
        self.score_evaluator = score_evaluator or self._unavailable_score
        self.clock = clock
        self.wake_binding = wake_binding
        self.asr_wake_fallback_enabled = asr_wake_fallback_enabled
        self.diagnostics = diagnostics
        self._pending: _PendingCandidate | None = None
        self._evaluating: object | None = None
        self._generation = 0
        self._changed = asyncio.Event()
        self._last_segment_id = -1

    @property
    def pending(self) -> _PendingCandidate | None:
        return self._pending

    def open(self, session_id: str, bot_id: str, *, now: float) -> WakeSession:
        self.close()
        return self.sessions.open(session_id, bot_id, now=now)

    def close(self) -> None:
        self._generation += 1
        self._pending = None
        self._evaluating = None
        self._last_segment_id = -1
        self.sessions.close()
        self._changed.set()

    def register_input(self, input_id: str, text: str, *, session_id: str,
                       bot_id: str) -> bool:
        return self.sessions.register_input(input_id, text, session_id=session_id,
                                            bot_id=bot_id)

    def mark_input_accepted(self, input_id: str) -> bool:
        return self.sessions.mark_input_accepted(input_id)

    def discard_input(self, input_id: str) -> None:
        self.sessions.discard_input(input_id)
        self._changed.set()

    def finish_reply_audio(self, input_id: str, *, now: float) -> bool:
        result = self.sessions.finish_reply_audio(input_id, now=now)
        self._changed.set()
        return result

    def clarification_prompt_finished(self, *, now: float) -> bool:
        """Arm the confirmation deadline once prompt audio has been emitted."""
        return self.sessions.finish_clarification_prompt(now=now)

    def input_is_current(self, input_id: str, *, session_id: str,
                         bot_id: str, now: float) -> bool:
        session = self.sessions.current
        return bool(session and session.session_id == session_id
                    and session.bot_id == bot_id and not self.sessions.expire(now=now))

    async def evaluate(self, text: str, owner: OwnerDecision, segment: AudioSegment,
                       *, now: float) -> WakeAdmissionResult:
        if not self._valid_owner(owner, segment):
            return self._drop('owner_not_verified', session=self.sessions.current)
        if not isinstance(text, str) or not text.strip() or len(text) > ContextSnapshot.MAX_TEXT:
            return self._drop('invalid_transcript', session=self.sessions.current)
        if self.wake_binding is not None:
            pending_candidate = self.wake_binding.pending
            binding = self.wake_binding.resolve(text, segment, now=now,
                                                allow_asr=self.asr_wake_fallback_enabled)
            if self.asr_wake_fallback_enabled:
                self._diagnose('wake.asr.comparison', segment=segment,
                               kws_bound=bool(binding and binding.source == 'kws'),
                               asr_explicit=binding is not None,
                               source=binding.source if binding else None,
                               bot_id=binding.bot_id if binding else None,
                               reason=self.wake_binding.last_reason)
                if self.wake_binding.last_reason in (
                        'wake_segment_already_consumed', 'wake_segment_invalid_or_expired'):
                    return self._drop(self.wake_binding.last_reason, session=self.sessions.current)
            if binding is not None:
                self.open(binding.session_id, binding.bot_id, now=now)
                if binding.name_only:
                    self._last_segment_id = segment.segment_id
                    return self._drop('wake_name_only', session=self.sessions.current)
            elif pending_candidate is not None:
                self._diagnose('wake.binding.rejected', session_id=pending_candidate.session_id,
                               bot_id=pending_candidate.bot_id,
                               segment_id=segment.segment_id,
                               reason=self.wake_binding.last_reason,
                               detail=self.wake_binding.last_detail)
        if self._evaluating is not None:
            return self._drop('continuation_candidate_busy', session=self.sessions.current)
        session = self.sessions.current
        if session is None:
            return self._drop('wake_required')
        if segment.segment_id <= self._last_segment_id:
            return self._drop('segment_already_consumed', session=session)
        self._last_segment_id = segment.segment_id
        generation = self._generation
        token = self._evaluating = object()
        started = self.clock()
        current_time = lambda: float(now) + max(0., self.clock() - started)
        try:
            if self.sessions.expire(now=current_time()):
                return self._failure(
                    'clarification_expired' if session.phase is SessionPhase.CLARIFICATION_PENDING
                    else 'session_expired', generation)
            if session.phase is SessionPhase.CLARIFICATION_PENDING:
                return await self._confirm(text, owner, segment, generation, current_time)
            if session.phase is SessionPhase.CONTEXT_GATED:
                while not self.sessions.current.turns:
                    if not self.sessions.awaiting_reply:
                        return self._failure('continuation_context_unavailable', generation)
                    self._changed.clear()
                    remaining = self.sessions.deadline - current_time()
                    if remaining <= 0:
                        return self._failure('session_expired', generation)
                    try:
                        await asyncio.wait_for(self._changed.wait(), remaining)
                    except TimeoutError:
                        return self._failure('session_expired', generation)
                    if not self._same_session(session, generation):
                        return self._drop('session_changed')
                    if self.sessions.expire(now=current_time()):
                        return self._failure('session_expired', generation)
                session = self.sessions.current
            snapshot = await self._snapshot(session.bot_id)
            if not self._same_session(session, generation):
                return self._drop('session_changed')
            if self.sessions.expire(now=current_time()):
                return self._failure('session_expired', generation)
            if snapshot is None:
                return self._failure('snapshot_unavailable', generation)
            if session.phase is SessionPhase.FIRST_TURN_PENDING:
                self.sessions.accept_first_turn(text, now=current_time())
                return WakeAdmissionResult(
                    ContinuationAction.SUBMIT, 'first_turn_admitted', text=text,
                    bot_id=session.bot_id, snapshot=snapshot, owner=owner,
                    segment=segment, session_id=session.session_id)
            if session.phase is not SessionPhase.CONTEXT_GATED:
                return self._failure('invalid_session_phase', generation)
            last = session.turns[-1]
            context = ContinuationContext(
                turn_count=session.turn_count, last_user_text=last.user_text,
                last_agent_reply=last.agent_reply, turns=session.turns,
                seconds_since_last_turn=max(0., current_time() - float(
                    session.last_user_at if session.last_user_at is not None else session.opened_at)))
            model_started = self.clock()
            outcome = 'error'
            self._diagnose('continuation.model.started', session, segment,
                           context_turns=len(context.turns))
            try:
                score = self.score_evaluator(snapshot, context, text)
                if inspect.isawaitable(score):
                    score = await score
                if (isinstance(score, bool) or not isinstance(score, (int, float))
                        or not math.isfinite(score) or not 0 <= score <= 1):
                    raise ValueError('invalid_continuation_score')
                outcome = 'completed'
            except asyncio.CancelledError:
                outcome = 'cancelled'
                raise
            except Exception:
                return self._failure('continuation_evaluator_unavailable', generation)
            finally:
                self._diagnose('continuation.model.ended', session, segment, outcome=outcome,
                               elapsed_ms=round(max(0., self.clock() - model_started) * 1000, 3))
            if not self._same_session(session, generation):
                return self._drop('session_changed')
            fresh = await self._snapshot(session.bot_id)
            if not self._same_session(session, generation):
                return self._drop('session_changed')
            if self.sessions.expire(now=current_time()):
                return self._failure('session_expired', generation)
            if fresh is None:
                return self._failure('snapshot_unavailable', generation)
            if self._snapshot_key(fresh) != self._snapshot_key(snapshot):
                return self._failure('snapshot_changed', generation)
            action = self.continuation.evaluate(text, score=float(score), now=current_time())
            if action.action is ContinuationAction.CLARIFY:
                self._pending = _PendingCandidate(text, owner, segment,
                                                 session.bot_id, snapshot,
                                                 session.session_id, float(score))
            return WakeAdmissionResult(
                action.action, action.reason, text=action.text, prompt=action.prompt,
                bot_id=session.bot_id, snapshot=snapshot, owner=owner,
                segment=segment, score=float(score), session_id=session.session_id)
        except asyncio.CancelledError:
            self._failure('continuation_cancelled', generation)
            raise
        finally:
            if self._evaluating is token:
                self._evaluating = None

    async def confirm(self, text: str, owner: OwnerDecision, segment: AudioSegment,
                      *, now: float) -> WakeAdmissionResult:
        session = self.sessions.current
        if session is None or session.phase is not SessionPhase.CLARIFICATION_PENDING:
            self._pending = None
            return self._drop('clarification_no_clarification', session=session)
        return await self.evaluate(text, owner, segment, now=now)

    async def _confirm(self, text, owner, segment, generation, current_time):
        session, pending = self.sessions.current, self._pending
        if (pending is None or pending.session_id != session.session_id
                or pending.bot_id != session.bot_id
                or not self._valid_owner(pending.owner, pending.segment)):
            return self._failure('clarification_candidate_invalid', generation)
        fresh = await self._snapshot(session.bot_id)
        if not self._same_session(session, generation):
            return self._drop('session_changed')
        if self.sessions.expire(now=current_time()):
            return self._failure('clarification_expired', generation)
        if fresh is None or self._snapshot_key(fresh) != self._snapshot_key(pending.snapshot):
            return self._failure('snapshot_changed', generation)
        confirmed = parse_confirmation(text)
        self._diagnose('continuation.confirmation.parsed', session, segment,
                       result=('affirmative' if confirmed is True else
                               'negative' if confirmed is False else 'ambiguous'))
        action = self.continuation.confirm(confirmed, now=current_time())
        self._pending = None
        if action.action is ContinuationAction.SUBMIT:
            return WakeAdmissionResult(
                action.action, action.reason, text=pending.text,
                bot_id=pending.bot_id, snapshot=pending.snapshot,
                owner=pending.owner, segment=pending.segment, score=pending.score,
                session_id=pending.session_id)
        return self._drop(action.reason, session=self.sessions.current)

    def record_agent_reply(self, text: str, *, now: float, input_id: str | None = None,
                           response_id: str | None = None, session_id: str | None = None,
                           bot_id: str | None = None) -> bool:
        if not all((input_id, response_id, session_id, bot_id)):
            return False
        result = self.sessions.complete_input(input_id, response_id, text, now=now,
                                              session_id=session_id, bot_id=bot_id)
        self._changed.set()
        return result

    def _same_session(self, session: WakeSession, generation: int) -> bool:
        current = self.sessions.current
        return bool(generation == self._generation and current
                    and current.session_id == session.session_id
                    and current.bot_id == session.bot_id)

    def _failure(self, reason: str, generation: int) -> WakeAdmissionResult:
        if generation == self._generation:
            self.close()
        return self._drop(reason)

    def _diagnose(self, kind, session=None, segment=None, **fields):
        if self.diagnostics:
            if session is not None:
                fields.setdefault('session_id', session.session_id)
                fields.setdefault('bot_id', session.bot_id)
            if segment is not None:
                fields.setdefault('segment_id', segment.segment_id)
            self.diagnostics({'type': kind, **fields})

    async def _snapshot(self, bot_id: str) -> ContextSnapshot | None:
        try:
            value = self.snapshot_provider(bot_id)
            if inspect.isawaitable(value):
                value = await value
            if not isinstance(value, ContextSnapshot):
                value = ContextSnapshot.from_mapping(value)
            if value.bot_id != bot_id:
                raise ValueError('snapshot_bot_mismatch')
            return value
        except Exception:
            return None

    @staticmethod
    def _snapshot_key(snapshot):
        return (snapshot.bot_id, snapshot.user_id, snapshot.profile_version,
                snapshot.agent_names, snapshot.wake_names, snapshot.rules,
                snapshot.negative_addressing_examples, snapshot.explicit_wake_required)

    @staticmethod
    async def _unavailable_score(*_args) -> float:
        raise RuntimeError('continuation_evaluator_unavailable')

    @staticmethod
    def _valid_owner(owner: OwnerDecision, segment: AudioSegment) -> bool:
        return (isinstance(owner, OwnerDecision) and owner.identity == 'owner'
                and owner.status == 'verified' and owner.segment_id == segment.segment_id
                and bool(owner.model_id) and bool(owner.profile_version))

    @staticmethod
    def _drop(reason: str, *, session: WakeSession | None = None) -> WakeAdmissionResult:
        return WakeAdmissionResult(ContinuationAction.DROP, reason,
                                   bot_id=session.bot_id if session else None,
                                   session_id=session.session_id if session else None)


