"""One live device's wake, owner-gated input and semantic continuation path."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import re
import time
from uuid import uuid4

from continuation_admission import ContinuationAction, ContinuationAdmission
from continuation_policy import ContinuationPolicy
from speech_models import SpeechFailure
from wake_gated_gateway import WakeGatedAdmission
from wake_mapping import WakeMapping
from wake_session import SessionPhase, WakeSessionManager


@dataclass
class InputLease:
    bot_id: str
    session_id: str
    wake_session_id: str
    generation: int
    mapping_version: str
    opened_at: float
    names: tuple[str, ...]
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    accepted: bool = False


class VoiceInput:
    def __init__(self, bridge, models, *, config=None, evaluator=None,
                 notify=None, interrupt=None, clarify=None, clock=time.monotonic):
        self.bridge, self.models = bridge, models
        self.config = dict(config or {})
        self.clock = clock
        self.notify = notify or (lambda *_args, **_fields: None)
        self.interrupt, self.clarify = interrupt, clarify
        self.sessions = WakeSessionManager(
            first_turn_timeout=self.config.get('wakeTimeout', 8.),
            continuation_timeout=self.config.get('continuationTimeoutSeconds', 12.),
            clarification_timeout=self.config.get('clarificationTimeoutSeconds', 5.))
        self.gate = WakeGatedAdmission(
            self.sessions,
            ContinuationAdmission(self.sessions, ContinuationPolicy(
                self.config.get('continuationRejectThreshold', .25),
                self.config.get('continuationAcceptThreshold', .8))),
            snapshot_provider=self._snapshot, score_evaluator=evaluator, clock=clock,
            diagnostics=lambda value: self.notify(value['type'], **{k: v for k, v in value.items() if k != 'type'}))
        self.lease = None
        self.generation = 0
        self.task = None
        self.busy = False
        self.inputs = {}
        self._last_segment_id = 0

    def invalidate(self):
        self.generation += 1
        if self.lease:
            self.lease.ready.set()
        self.lease = None
        self.inputs.clear()
        self.gate.close()

    def abort_input(self, correlation, *, reason='output_aborted'):
        input_id = correlation.get('input_id') if isinstance(correlation, dict) else None
        if not input_id:
            return
        self.inputs.pop(input_id, None)
        self.gate.discard_input(input_id)
        self.notify('input.aborted', input_id=input_id, reason=reason)

    def stage_wake(self, payload, roster):
        mapping = WakeMapping.from_roster(roster)
        role = next((item for item in roster['roles'] if item['bot_id'] == payload.get('bot_id')), None)
        if role is None or payload.get('wake_mapping_version') != mapping.version:
            return None
        self.invalidate()
        lease = InputLease(role['bot_id'], role['session_id'], payload['wake_session_id'],
                           self.generation, mapping.version, self.clock(), mapping.roles[role['bot_id']])
        self.lease = lease
        return lease

    async def wake(self, payload, roster):
        lease = self.stage_wake(payload, roster)
        return await self.confirm_wake(lease, payload) if lease else False

    async def confirm_wake(self, lease, payload):
        if self.interrupt:
            await self.interrupt()
        if self.lease is not lease:
            lease.ready.set()
            return False
        self._state('listening', 'wake_confirming', 'wake_pending')
        try:
            result = await self.bridge.publish_wake({**payload, 'generation': lease.generation})
            if self.lease is not lease:
                return False
            if getattr(result, 'type', '') != 'device.wake.accepted':
                raise SpeechFailure('wake_rejected')
            lease.accepted = True
            self.gate.open(lease.wake_session_id, lease.bot_id, now=lease.opened_at)
            self.notify('runtime.wake', bot_id=lease.bot_id, wake_session_id=lease.wake_session_id)
            self._state('listening', 'awaiting_speech', 'wake_accepted')
            return True
        except Exception:
            if self.lease is lease:
                self.invalidate()
                self._state('listening', 'waiting_for_wake', 'wake_rejected')
            return False
        finally:
            lease.ready.set()

    def offer(self, segment):
        lease = self.lease
        if lease is None:
            return
        if self.task is not None and not self.task.done():
            self.notify('audio.segment.dropped', segment_id=segment.segment_id, reason='input_busy')
            return
        self.task = asyncio.create_task(self.process(segment, lease))
        self.task.add_done_callback(self._done)

    def _done(self, task):
        if not task.cancelled() and task.exception() is not None:
            self._state('listening', 'awaiting_speech', 'input_processing_failed')

    async def process(self, segment, lease=None):
        lease = self.lease if lease is None else lease
        if self.busy or lease is None:
            return
        self.busy = True
        try:
            await asyncio.wait_for(lease.ready.wait(), 10.)
            if self.lease is not lease or not lease.accepted or segment.segment_id <= self._last_segment_id:
                return
            self._last_segment_id = segment.segment_id
            if not self.sessions.hold_audio(started_at=segment.started_at, ended_at=segment.ended_at,
                                             now=self.clock(), processing_timeout=25.):
                self._state('listening', 'waiting_for_wake', 'session_expired')
                return
            self.notify('audio.segment.ended', bot_id=lease.bot_id, wake_session_id=lease.wake_session_id,
                        segment_id=segment.segment_id, samples=len(segment.samples))
            self._state('listening', 'transcribing', 'processing')
            try:
                text, owner = await self.models.recognize(segment)
            except SpeechFailure as error:
                self._state('listening', 'awaiting_speech', str(error))
                return
            if self.lease is not lease:
                return
            if owner.identity != 'owner' or owner.status != 'verified':
                self.notify('identity.rejected', segment_id=segment.segment_id, score=owner.score)
                self._state('listening', 'awaiting_speech', 'owner_not_verified')
                return
            self.notify('identity.verified', segment_id=segment.segment_id, score=owner.score)
            if not isinstance(text, str) or not text.strip():
                self._state('listening', 'awaiting_speech', 'empty_transcript')
                return
            phase = self.sessions.current.phase if self.sessions.current else None
            if phase is SessionPhase.FIRST_TURN_PENDING:
                text = self._strip_name(text, lease.names)
                if not text:
                    self._state('listening', 'awaiting_speech', 'wake_name_only')
                    return
            elif self.config.get('continuationEnabled', True) is not True:
                self._state('listening', 'waiting_for_wake', 'wake_required')
                return
            self._state('listening', 'checking_admission', 'processing')
            admission = await self.gate.evaluate(text, owner, segment, now=self.clock())
            if self.lease is not lease:
                return
            if admission.action is ContinuationAction.CLARIFY:
                self._state('listening', 'clarification', admission.reason)
                if self.clarify:
                    await self.clarify(admission.prompt, lease.bot_id)
                    if self.lease is lease:
                        self.gate.clarification_prompt_finished(now=self.clock())
                return
            if not admission.admitted:
                self._state('listening', 'awaiting_speech', admission.reason)
                return
            text, owner, segment = admission.text, admission.owner, admission.segment
            if self.interrupt:
                await self.interrupt()
            if self.lease is not lease:
                return
            input_id = uuid4().hex
            if not self.gate.register_input(input_id, text, session_id=lease.wake_session_id, bot_id=lease.bot_id):
                self._state('listening', 'awaiting_speech', 'input_registration_failed')
                return
            self.inputs[input_id] = lease
            self.notify('input.submit', bot_id=lease.bot_id, input_id=input_id, segment_id=segment.segment_id)
            try:
                result = await self.bridge.submit(
                    text, input_id=input_id, bot_id=lease.bot_id, session_id=lease.session_id,
                    wake_session_id=lease.wake_session_id, generation=lease.generation,
                    segment_id=segment.segment_id, speaker={
                        'status': 'owner_verified', 'score': owner.score,
                        'model_id': owner.model_id, 'profile_version': owner.profile_version,
                        'segment_id': segment.segment_id})
            except Exception:
                self.gate.discard_input(input_id)
                self.inputs.pop(input_id, None)
                if self.lease is lease:
                    self._state('listening', 'awaiting_speech', 'submit_failed')
                return
            if self.lease is not lease:
                return
            if result.type == 'input.accepted':
                self.gate.mark_input_accepted(input_id)
                self.notify('input.accepted', bot_id=lease.bot_id, input_id=input_id)
                self._state('listening', 'waiting_for_reply', 'input_accepted')
            else:
                self.gate.discard_input(input_id)
                self.inputs.pop(input_id, None)
                self._state('listening', 'awaiting_speech', 'input_rejected')
        finally:
            if self.lease is lease:
                self.sessions.release_audio()
            self.busy = False

    @staticmethod
    def _strip_name(text, names):
        value = re.sub(r'^(?:喂|嘿|嗨)[，,、\s]*', '', text.strip(), count=1)
        for name in sorted(names, key=len, reverse=True):
            if value.startswith(name):
                return value[len(name):].lstrip('，,。.!！?？:：、 \t')
        return text.strip()

    async def _snapshot(self, bot_id):
        result = await self.bridge.context_snapshot(bot_id, dialogue_active=self.sessions.awaiting_reply)
        return result.payload.get('snapshot', result.payload)

    def owns_output(self, correlation):
        lease = self.inputs.get(correlation.get('input_id'))
        if lease is None or lease is not self.lease:
            return False
        current = all(correlation.get(name) == getattr(lease, name) for name in
                      ('bot_id', 'session_id', 'wake_session_id', 'generation'))
        if current:
            # A fast authenticated output can be consumed before submit()'s
            # awaiting task resumes from the preceding input.accepted frame.
            self.gate.mark_input_accepted(correlation['input_id'])
        return current

    def reply_finished(self, correlation, text):
        if not self.owns_output(correlation):
            return
        input_id = correlation['input_id']
        self.reply_generated(correlation, text)
        self.inputs.pop(input_id, None)
        if text.strip():
            self.gate.finish_reply_audio(input_id, now=self.clock())
        else:
            self.gate.discard_input(input_id)
        self._state('listening', 'awaiting_speech', 'reply_completed')

    def reply_generated(self, correlation, text):
        if not self.owns_output(correlation):
            return
        input_id = correlation['input_id']
        lease = self.inputs[input_id]
        if text.strip():
            if len(text) > 2000:
                text = '[回复较长，以下为末尾内容]\n' + text[-1900:]
            self.gate.record_agent_reply(text, now=self.clock(), input_id=input_id,
                                        response_id=correlation['response_id'],
                                        session_id=lease.wake_session_id, bot_id=lease.bot_id)

    def _state(self, state, stage, result):
        self.notify('runtime.state', state=state, stage=stage, result=result, error_code='')

    async def close(self):
        self.invalidate()
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
