import unittest

from continuation_admission import ContinuationAdmission, ContinuationAction
from continuation_policy import ContinuationPolicy
from wake_session import SessionPhase, WakeSessionManager


class ContinuationAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.sessions = WakeSessionManager(
            first_turn_timeout=5.0, continuation_timeout=10.0,
            clarification_timeout=5.0,
        )
        self.sessions.open("wake-1", "qinghe", now=100.0)
        self.sessions.accept_first_turn("第一条指令", now=102.0)
        self.admission = ContinuationAdmission(
            self.sessions, ContinuationPolicy(reject_threshold=0.25, accept_threshold=0.8)
        )

    def test_high_score_returns_text_to_submit_and_refreshes_session(self):
        result = self.admission.evaluate("继续追问", score=0.9, now=105.0)

        self.assertIs(result.action, ContinuationAction.SUBMIT)
        self.assertEqual(result.text, "继续追问")
        self.assertEqual(self.sessions.current.phase, SessionPhase.CONTEXT_GATED)
        self.assertEqual(self.sessions.current.turn_count, 2)

    def test_low_score_drops_text_without_refreshing_session(self):
        result = self.admission.evaluate("对旁人说", score=0.1, now=105.0)

        self.assertIs(result.action, ContinuationAction.DROP)
        self.assertIsNone(result.text)
        self.assertEqual(self.sessions.current.last_user_text, "第一条指令")
        self.assertEqual(self.sessions.current.expires_at, 112.0)

    def test_middle_score_prompts_and_confirmation_returns_deferred_text(self):
        result = self.admission.evaluate("不确定的话", score=0.5, now=105.0)

        self.assertIs(result.action, ContinuationAction.CLARIFY)
        self.assertEqual(result.prompt, "你是在和我说吗？")
        self.assertIsNone(result.text)

        confirmed = self.admission.confirm(True, now=106.0)

        self.assertIs(confirmed.action, ContinuationAction.SUBMIT)
        self.assertEqual(confirmed.text, "不确定的话")

    def test_confirmation_without_pending_text_does_not_submit(self):
        result = self.admission.confirm(True, now=105.0)

        self.assertIs(result.action, ContinuationAction.DROP)
        self.assertIsNone(result.text)


if __name__ == "__main__":
    unittest.main()


