import unittest
import importlib.util
import asyncio

from audio_adapter import AudioSegment, OwnerDecision
from continuation_admission import ContinuationAction, ContinuationAdmission
from continuation_policy import ContinuationPolicy
from voice_addressing import ContextSnapshot
from wake_mapping import WakeMapping
from wake_gated_gateway import WakeGatedAdmission
from wake_session import WakeSessionManager, SessionPhase
import numpy as np


def owner(identifier=1):
    return OwnerDecision('owner', .99, 'verified', identifier, 'cam', 'p1')


def segment(identifier=1, start=100., end=102.):
    return AudioSegment(np.zeros(160, dtype=np.float32), 16000, identifier, end, start)


class WakeBindingTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_binding_distinguishes_missing_name_from_a_mention(self):
        for text, detail in (('请回答我你能听到吗', 'configured_name_missing'),
                             ('我说青禾请回答我', 'name_not_at_start'),
                             ('青禾刚刚说的是不是对的', 'mention_or_combined_addressee')):
            with self.subTest(text=text):
                binding = self.binding()
                gateway = self.gateway(binding)
                self.stage(binding)
                result = await gateway.evaluate(text, owner(), segment(), now=103)
                self.assertFalse(result.admitted)
                self.assertEqual(getattr(binding, 'last_detail', None), detail)

    def binding(self):
        self.assertIsNotNone(importlib.util.find_spec('wake_binding'),
                             'a keyword event alone must not open or switch a role')
        from wake_binding import WakeBindingGate
        mapping = WakeMapping.from_config({'wake_mapping_version': '7',
                                          'bot_wake_names': {'a': ['青禾'], 'b': ['真央']}})
        return WakeBindingGate(mapping, 'device:current', timeout=8.)

    def stage(self, gate, *, role='a', identifier='w', version='7', identity='device:current', now=101):
        return gate.stage({'type': 'device.wake', 'wake_session_id': identifier,
                           'bot_id': role, 'wake_mapping_version': version}, identity, now=now)

    def gateway(self, binding):
        sessions = WakeSessionManager()
        return WakeGatedAdmission(
            sessions, ContinuationAdmission(sessions, ContinuationPolicy(.25, .8)),
            snapshot_provider=lambda role: ContextSnapshot(role, 'owner', 'p1'),
            score_evaluator=lambda *_: .5, clock=lambda: 0, wake_binding=binding)

    async def test_name_only_binds_without_becoming_a_business_question(self):
        binding = self.binding()
        gateway = self.gateway(binding)
        self.assertEqual(self.stage(binding), 'wake_candidate_staged')
        self.assertIsNone(gateway.sessions.current)
        result = await gateway.evaluate('青禾', owner(), segment(), now=103)
        self.assertIs(result.action, ContinuationAction.DROP)
        self.assertEqual(result.reason, 'wake_name_only')
        self.assertEqual(gateway.sessions.current.session_id, 'w')
        self.assertIs(gateway.sessions.current.phase, SessionPhase.FIRST_TURN_PENDING)
        first = await gateway.evaluate('帮我检查这个文件', owner(2), segment(2, 104, 105), now=105)
        self.assertIs(first.action, ContinuationAction.SUBMIT)
        self.assertEqual(first.text, '帮我检查这个文件')

    async def test_name_plus_instruction_is_preserved_and_duplicate_event_is_noop(self):
        binding = self.binding()
        gateway = self.gateway(binding)
        self.stage(binding)
        result = await gateway.evaluate('青禾你能帮我检查这个文件吗', owner(), segment(), now=103)
        self.assertIs(result.action, ContinuationAction.SUBMIT)
        self.assertEqual(result.text, '青禾你能帮我检查这个文件吗')
        expiry = gateway.sessions.current.expires_at
        self.assertEqual(self.stage(binding, now=104), 'wake_duplicate')
        self.assertEqual(gateway.sessions.current.expires_at, expiry)

    async def test_clear_punctuated_vocative_preserves_ordinary_question(self):
        for text in ('青禾，今天天气怎么样？', '青禾，几点了？', '青禾，请评价这段台词。'):
            with self.subTest(text=text):
                binding = self.binding()
                gateway = self.gateway(binding)
                self.stage(binding)
                result = await gateway.evaluate(text, owner(), segment(), now=103)
                self.assertTrue(result.admitted)
                self.assertEqual(result.text, text)

    async def test_mentions_quotes_and_denial_do_not_bind_even_with_keyword_candidate(self):
        for text in ('青禾刚刚说的是不是对的', '我想知道青禾的意见',
                     '节目里说青禾你好', '“青禾，你在吗”是他的原话',
                     '青禾不是在叫你，我在和别人说话', '青禾和真央都来回答'):
            with self.subTest(text=text):
                binding = self.binding()
                gateway = self.gateway(binding)
                self.stage(binding)
                result = await gateway.evaluate(text, owner(), segment(), now=103)
                self.assertIs(result.action, ContinuationAction.DROP)
                self.assertIsNone(gateway.sessions.current)

    async def test_unconfirmed_other_role_candidate_does_not_destroy_clarification(self):
        binding = self.binding()
        gateway = self.gateway(binding)
        gateway.open('old', 'b', now=98)
        gateway.sessions.accept_first_turn('首问', now=99)
        gateway.sessions.begin_clarification('候选原话', now=100)
        self.stage(binding)
        self.assertIs(gateway.sessions.current.phase, SessionPhase.CLARIFICATION_PENDING)
        self.assertEqual(gateway.sessions.current.session_id, 'old')
        # Directly resolve the KWS metadata: a mention cannot replace the role.
        resolution = binding.resolve('青禾刚刚说的是不是对的', segment(), now=103)
        self.assertIsNone(resolution)
        self.assertEqual(gateway.sessions.current.session_id, 'old')

    async def test_explicit_wake_recovers_after_ambiguous_confirmation_closed_session(self):
        binding = self.binding()
        gateway = self.gateway(binding)
        gateway.open('old', 'a', now=100)
        await gateway.evaluate('首问', owner(), segment(), now=102)
        gateway.register_input('i1', '首问', session_id='old', bot_id='a')
        gateway.mark_input_accepted('i1')
        gateway.record_agent_reply('首答', input_id='i1', response_id='r1',
                                   session_id='old', bot_id='a', now=103)
        uncertain = await gateway.evaluate('候选问题', owner(2), segment(2, 104, 105), now=105)
        self.assertIs(uncertain.action, ContinuationAction.CLARIFY)
        ambiguous = await gateway.evaluate('好吧。', owner(3), segment(3, 105, 106), now=106)
        self.assertEqual(ambiguous.reason, 'clarification_ambiguous')
        self.assertIsNone(gateway.sessions.current)

        self.assertEqual(self.stage(binding, identifier='fresh', now=107), 'wake_candidate_staged')
        result = await gateway.evaluate('青禾请回答我', owner(4), segment(4, 106, 109), now=109)

        self.assertIs(result.action, ContinuationAction.SUBMIT)
        self.assertEqual(result.reason, 'first_turn_admitted')
        self.assertEqual(gateway.sessions.current.session_id, 'fresh')
        self.assertIsNone(gateway.pending)

    async def test_stale_connection_version_wrong_segment_and_unverified_speaker_do_not_bind(self):
        binding = self.binding()
        self.assertEqual(self.stage(binding, identity='device:old'), 'wake_connection_mismatch')
        self.assertEqual(self.stage(binding, version='6'), 'invalid_wake_event')
        gateway = self.gateway(binding)
        self.stage(binding)
        invalid = OwnerDecision('unknown', .2, 'unknown', 1, 'cam', 'p1')
        result = await gateway.evaluate('青禾', invalid, segment(), now=103)
        self.assertIs(result.action, ContinuationAction.DROP)
        self.assertIsNone(gateway.sessions.current)
        # A later unrelated segment cannot claim a previous word hit.
        later = await gateway.evaluate('青禾', owner(2), segment(2, 104, 105), now=106)
        self.assertIs(later.action, ContinuationAction.DROP)
        self.assertIsNone(gateway.sessions.current)

    async def test_rename_clears_old_candidate_and_rejects_reused_mapping_version(self):
        binding = self.binding()
        self.stage(binding)
        updated = WakeMapping.from_config({'wake_mapping_version': '8',
                                          'bot_wake_names': {'a': ['临舟']}})
        self.assertTrue(binding.update_mapping(updated))
        self.assertIsNone(binding.resolve('青禾', segment(), now=103))
        self.assertEqual(self.stage(binding, version='7'), 'invalid_wake_event')
        with self.assertRaises(ValueError):
            binding.update_mapping(WakeMapping.from_config({'wake_mapping_version': '7',
                                                           'bot_wake_names': {'a': ['青禾']}}))

    async def test_repeating_same_bot_wake_keeps_the_current_bot_session(self):
        binding = self.binding()
        gateway = self.gateway(binding)
        gateway.open('old', 'a', now=98)
        self.stage(binding, identifier='same-role')
        result = await gateway.evaluate('青禾', owner(), segment(), now=103)
        self.assertEqual(result.reason, 'wake_name_only')
        self.assertEqual(gateway.sessions.current.bot_id, 'a')


if __name__ == '__main__':
    unittest.main()


