import unittest

from wake_session import SessionPhase, WakeSessionManager


class WakeSessionManagerTests(unittest.TestCase):
    def test_tool_and_tts_wait_do_not_consume_the_post_reply_window(self):
        manager = WakeSessionManager()
        manager.open('w', 'a', now=100)
        manager.accept_first_turn('查询天气', now=101)
        manager.register_input('i', '查询天气', session_id='w', bot_id='a')
        manager.mark_input_accepted('i')

        self.assertFalse(manager.expire(now=125), 'a live task is distinct from idle continuation')
        self.assertTrue(manager.complete_input('i', 'r', '天气回答',
                        session_id='w', bot_id='a', now=140))
        self.assertFalse(manager.expire(now=160), 'text completion is not audio completion')
        self.assertTrue(manager.finish_reply_audio('i', now=165))
        self.assertEqual(manager.current.expires_at, 177)
        self.assertFalse(manager.finish_reply_audio('i', now=170))
        self.assertEqual(manager.current.expires_at, 177)
        self.assertTrue(manager.expire(now=177))

    def test_waiting_for_a_reply_has_a_finite_deadline(self):
        manager = WakeSessionManager()
        manager.open('w', 'a', now=100)
        manager.accept_first_turn('查询天气', now=101)
        manager.register_input('i', '查询天气', session_id='w', bot_id='a')
        manager.mark_input_accepted('i')

        self.assertFalse(manager.expire(now=220))
        self.assertTrue(manager.expire(now=221))
        self.assertIsNone(manager.current)

    def test_an_older_wait_cannot_shorten_a_newer_completed_audio_window(self):
        manager = WakeSessionManager()
        manager.open('w', 'a', now=100)
        manager.accept_first_turn('旧请求', now=101)
        manager.register_input('old', '旧请求', session_id='w', bot_id='a')
        manager.mark_input_accepted('old')
        manager.accept_continuation('新请求', now=105)
        manager.register_input('new', '新请求', session_id='w', bot_id='a')
        manager.mark_input_accepted('new')
        manager.complete_input('new', 'r', '新回复', session_id='w', bot_id='a', now=217)
        manager.finish_reply_audio('new', now=218)
        self.assertEqual(manager.deadline, 230)

    def test_reply_wait_cannot_extend_clarification_or_a_replacement_role(self):
        manager = WakeSessionManager()
        manager.open('w', 'a', now=100)
        manager.accept_first_turn('查询天气', now=101)
        manager.register_input('i', '查询天气', session_id='w', bot_id='a')
        manager.mark_input_accepted('i')
        manager.begin_clarification('不确定的问题', now=105)
        self.assertTrue(manager.expire(now=110))
        manager.open('new', 'b', now=111)
        finish = getattr(manager, 'finish_reply_audio', None)
        self.assertTrue(callable(finish))
        self.assertFalse(finish('i', now=112))
        self.assertEqual(manager.current.expires_at, 119)

    def test_wake_opens_one_first_turn_without_semantic_gate(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0)

        session = manager.open("wake-1", "qinghe", now=100.0)

        self.assertEqual(session.phase, SessionPhase.FIRST_TURN_PENDING)
        self.assertEqual(session.bot_id, "qinghe")
        self.assertTrue(manager.can_accept_first_turn(now=104.9))
        self.assertFalse(manager.can_accept_first_turn(now=105.0))

    def test_first_turn_enters_context_gate_and_records_short_context(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0)
        manager.open("wake-1", "qinghe", now=100.0)

        session = manager.accept_first_turn("第一条指令", now=102.0)

        self.assertEqual(session.phase, SessionPhase.CONTEXT_GATED)
        self.assertEqual(session.turn_count, 1)
        self.assertEqual(session.last_user_text, "第一条指令")
        self.assertEqual(session.last_user_at, 102.0)
        self.assertEqual(session.expires_at, 112.0)

    def test_rejected_continuation_does_not_refresh_or_record_context(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0)
        manager.open("wake-1", "qinghe", now=100.0)
        manager.accept_first_turn("第一条指令", now=102.0)

        rejected = manager.reject_continuation(now=105.0)

        self.assertEqual(rejected.reason, "semantic_rejected")
        self.assertEqual(manager.current.last_user_text, "第一条指令")
        self.assertEqual(manager.current.expires_at, 112.0)

    def test_admitted_continuation_refreshes_context_window(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0)
        manager.open("wake-1", "qinghe", now=100.0)
        manager.accept_first_turn("第一条指令", now=102.0)

        session = manager.accept_continuation("追问", now=110.0)

        self.assertEqual(session.turn_count, 2)
        self.assertEqual(session.last_user_text, "追问")
        self.assertEqual(session.last_user_at, 110.0)
        self.assertEqual(session.expires_at, 120.0)

    def test_explicit_role_switch_replaces_old_context(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0)
        manager.open("wake-1", "zhenyao", now=100.0)
        manager.accept_first_turn("旧角色问题", now=102.0)
        manager.record_agent_reply("旧角色回复", now=103.0)

        session = manager.open("wake-2", "qinghe", now=104.0)

        self.assertEqual(session.phase, SessionPhase.FIRST_TURN_PENDING)
        self.assertEqual(session.bot_id, "qinghe")
        self.assertEqual(session.last_user_text, "")
        self.assertEqual(session.last_agent_reply, "")
        self.assertEqual(manager.current.session_id, "wake-2")

    def test_expired_session_rejects_later_turn_and_clears(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0)
        manager.open("wake-1", "qinghe", now=100.0)
        manager.accept_first_turn("第一条指令", now=102.0)

        result = manager.try_accept_continuation("超时后的话", now=112.0)

        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "session_expired")
        self.assertIsNone(manager.current)

    def test_uncertain_turn_enters_clarification_without_submission(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0,
                                     clarification_timeout=5.0)
        manager.open("wake-1", "qinghe", now=100.0)
        manager.accept_first_turn("第一条指令", now=102.0)

        session = manager.begin_clarification("不确定的后续话", now=105.0)

        self.assertEqual(session.phase, SessionPhase.CLARIFICATION_PENDING)
        self.assertEqual(session.pending_user_text, "不确定的后续话")
        self.assertEqual(session.last_user_text, "第一条指令")

    def test_confirmation_yes_admits_pending_text_and_refreshes_window(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0,
                                     clarification_timeout=5.0)
        manager.open("wake-1", "qinghe", now=100.0)
        manager.accept_first_turn("第一条指令", now=102.0)
        manager.begin_clarification("暂存问题", now=105.0)

        result = manager.confirm_clarification(True, now=106.0)

        self.assertEqual(result.status, "accepted")
        self.assertEqual(result.text, "暂存问题")
        self.assertEqual(manager.current.phase, SessionPhase.CONTEXT_GATED)
        self.assertEqual(manager.current.last_user_text, "暂存问题")
        self.assertEqual(manager.current.turn_count, 2)
        self.assertEqual(manager.current.expires_at, 116.0)
        self.assertEqual(manager.current.pending_user_text, "")

    def test_confirmation_no_discards_pending_text_without_refreshing(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0,
                                     clarification_timeout=5.0)
        manager.open("wake-1", "qinghe", now=100.0)
        manager.accept_first_turn("第一条指令", now=102.0)
        manager.begin_clarification("暂存问题", now=105.0)

        result = manager.confirm_clarification(False, now=106.0)

        self.assertEqual(result.status, "rejected")
        self.assertIsNone(result.text)
        self.assertEqual(manager.current.phase, SessionPhase.CONTEXT_GATED)
        self.assertEqual(manager.current.last_user_text, "第一条指令")
        self.assertEqual(manager.current.expires_at, 112.0)

    def test_clarification_timeout_discards_session(self):
        manager = WakeSessionManager(first_turn_timeout=5.0, continuation_timeout=10.0,
                                     clarification_timeout=5.0)
        manager.open("wake-1", "qinghe", now=100.0)
        manager.accept_first_turn("第一条指令", now=102.0)
        manager.begin_clarification("暂存问题", now=105.0)

        result = manager.confirm_clarification(True, now=110.0)

        self.assertEqual(result.status, "expired")
        self.assertIsNone(result.text)
        self.assertIsNone(manager.current)


if __name__ == "__main__":
    unittest.main()


