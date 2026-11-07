"""Bind device candidates or opt-in ASR vocatives to one owner speech segment.

This is conservative Router logic, not a second semantic classifier. A name
mention without clear vocative syntax cannot replace a role session.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
import re
from uuid import uuid4

from audio_adapter import AudioSegment
from wake_mapping import WakeMapping


@dataclass(frozen=True)
class WakeBinding:
    session_id: str
    bot_id: str
    name_only: bool
    source: str = 'kws'


@dataclass(frozen=True)
class _KeywordCandidate:
    session_id: str
    bot_id: str
    received_at: float
    version: str


class WakeBindingGate:
    def __init__(self, mapping: WakeMapping, connection_identity: str, *, timeout: float = 8.):
        if not connection_identity or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError('invalid_wake_binding_configuration')
        self.mapping = mapping
        self.connection_identity = connection_identity
        self.timeout = timeout
        self.pending: _KeywordCandidate | None = None
        self._seen = deque(maxlen=32)
        self._versions = {mapping.version}
        self.last_reason = 'wake_required'
        self.last_detail = None
        self._last_asr_segment_id = -1

    def update_mapping(self, mapping: WakeMapping) -> bool:
        if mapping == self.mapping:
            return False
        if mapping.version in self._versions:
            self.pending = None
            raise ValueError('wake_mapping_version_reused')
        self.mapping = mapping
        self._versions.add(mapping.version)
        self.pending = None
        self._seen.clear()
        return True

    def stage(self, data: dict, identity: str | None, *, now: float) -> str:
        if identity != self.connection_identity:
            return 'wake_connection_mismatch'
        if (not isinstance(data, dict) or data.get('type') != 'device.wake'
                or data.get('wake_mapping_version') != self.mapping.version
                or data.get('bot_id') not in self.mapping.roles
                or not isinstance(data.get('wake_session_id'), str)
                or not data['wake_session_id'].strip() or len(data['wake_session_id']) > 2000
                or data.get('matched_bot_ids') not in (None, [data['bot_id']])):
            return 'invalid_wake_event'
        identifier = data['wake_session_id'].strip()
        if identifier in self._seen:
            return 'wake_duplicate'
        if self.pending is not None and now < self.pending.received_at + self.timeout:
            return 'wake_candidate_busy'
        self._seen.append(identifier)
        self.pending = _KeywordCandidate(identifier, data['bot_id'], float(now), self.mapping.version)
        return 'wake_candidate_staged'

    def resolve(self, text: str, segment: AudioSegment, *, now: float,
                allow_asr: bool = False) -> WakeBinding | None:
        if allow_asr:
            # This high-water mark survives role closure and mapping changes.
            # A late KWS event or another transcript of the same PCM grants no
            # second wake, even when the preceding session has already closed.
            identifier = segment.segment_id
            if (isinstance(identifier, bool) or not isinstance(identifier, int)
                    or identifier <= self._last_asr_segment_id):
                self.last_reason = 'wake_segment_already_consumed'
                self.last_detail = None
                return None
            self._last_asr_segment_id = identifier
            start, end = segment.started_at, segment.ended_at
            if (start is None or end is None or not all(math.isfinite(t) for t in (start, end, now))
                    or start > end or end > now + .5 or now >= end + self.timeout):
                self.last_reason = 'wake_segment_invalid_or_expired'
                self.last_detail = None
                return None
        binding = self._resolve_keyword(text, segment, now=now)
        if binding is not None or not allow_asr:
            return binding
        matches = [(role, vocative) for role in self.mapping.roles
                   if (vocative := self._vocative(text, role)) is not None]
        if len(matches) != 1:
            self.last_reason = 'wake_not_explicit'
            self.last_detail = 'no_unique_explicit_call'
            return None
        role, name_only = matches[0]
        self.last_reason = 'wake_asr_confirmed'
        self.last_detail = None
        return WakeBinding('asr-' + uuid4().hex, role, name_only, 'asr')

    def _resolve_keyword(self, text: str, segment: AudioSegment, *, now: float) -> WakeBinding | None:
        candidate = self.pending
        if candidate is None:
            self.last_reason = 'wake_required'
            self.last_detail = None
            return None
        self.last_reason = 'wake_not_explicit'
        self.last_detail = None
        if now >= candidate.received_at + self.timeout or candidate.version != self.mapping.version:
            self.pending = None
            self.last_reason = 'wake_candidate_expired'
            return None
        start, end = segment.started_at, segment.ended_at
        # No retained/replayed speech: the event must overlap this finalized
        # segment. Half a second allows media/data-channel scheduling skew.
        if (start is None or end is None or not math.isfinite(start) or not math.isfinite(end)
                or end < start or not start - .5 <= candidate.received_at <= end + .5):
            self.pending = None
            self.last_reason = 'wake_segment_mismatch'
            return None
        self.pending = None
        vocative = self._vocative(text, candidate.bot_id)
        if vocative is None:
            return None
        self.last_reason = 'wake_confirmed'
        return WakeBinding(candidate.session_id, candidate.bot_id, vocative)

    def _vocative(self, text: str, bot_id: str) -> bool | None:
        self.last_detail = None
        if not isinstance(text, str):
            return None
        value = text.strip()
        # A quoted name, a statement about a name, or an explicit denial is
        # insufficient evidence of calling it. No fuzzy aliases are added.
        if any(word in value for word in ('不是叫你', '不是在叫你', '没叫你', '没有叫你',
                                          '在和别人说', '在跟别人说', '是他的原话', '这是原话')):
            self.last_detail = 'denied_or_quoted_call'
            return None
        value = re.sub(r'^(?:喂|嘿|嗨)[，,、\s]*', '', value, count=1)
        matches = [(role, name) for role, names in self.mapping.roles.items() for name in names
                   if value.startswith(name)]
        if {role for role, _ in matches} != {bot_id}:
            self.last_detail = ('candidate_role_mismatch' if matches else
                               'name_not_at_start' if any(name in value for name in self.mapping.all_names())
                               else 'configured_name_missing')
            return None
        name = max((name for _, name in matches), key=len)
        rest = value[len(name):]
        # Reject combined addressees, reporting/possessive text, and arbitrary
        # name prefixes. For unpunctuated ASR require a clear direct request.
        cleaned = rest.lstrip('，,。.!！?？:：、 \t')
        if not cleaned:
            return True
        if cleaned.startswith(('和', '及', '与', '还有', '刚刚', '刚才', '说', '认为', '的', '不是')):
            self.last_detail = 'mention_or_combined_addressee'
            return None
        if any(cleaned.startswith(other_name) for other_role, names in self.mapping.roles.items()
               if other_role != bot_id for other_name in names):
            self.last_detail = 'combined_roles'
            return None
        if rest.lstrip().startswith(('，', ',', '：', ':')):
            return False
        if not cleaned.startswith(('你', '请', '帮我', '能不能', '可以', '在吗', '在不在',
                                   '告诉我', '解释', '查一下', '检查', '打开', '播放', '停止', '你好')):
            self.last_detail = 'request_prefix_not_explicit'
            return None
        return False


