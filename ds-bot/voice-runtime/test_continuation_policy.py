import unittest

from continuation_policy import ContinuationDisposition, ContinuationPolicy


class ContinuationPolicyTests(unittest.TestCase):
    def test_high_score_accepts_and_low_score_rejects(self):
        policy = ContinuationPolicy(reject_threshold=0.25, accept_threshold=0.8)

        self.assertIs(policy.classify(0.8), ContinuationDisposition.ACCEPT)
        self.assertIs(policy.classify(0.25), ContinuationDisposition.REJECT)

    def test_middle_score_enters_clarification(self):
        policy = ContinuationPolicy(reject_threshold=0.25, accept_threshold=0.8)

        self.assertIs(policy.classify(0.5), ContinuationDisposition.UNCERTAIN)

    def test_invalid_thresholds_and_scores_fail_closed(self):
        with self.assertRaises(ValueError):
            ContinuationPolicy(reject_threshold=0.8, accept_threshold=0.25)
        with self.assertRaises(ValueError):
            ContinuationPolicy(reject_threshold=-0.1, accept_threshold=0.8)
        policy = ContinuationPolicy(reject_threshold=0.25, accept_threshold=0.8)
        with self.assertRaises(ValueError):
            policy.classify(float("nan"))


if __name__ == "__main__":
    unittest.main()


