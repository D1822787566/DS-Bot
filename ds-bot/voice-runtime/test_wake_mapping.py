import unittest

from wake_mapping import WakeMapping


class WakeMappingTests(unittest.TestCase):
    def test_role_names_are_normalized_and_versioned(self):
        mapping = WakeMapping.from_config({
            'wake_mapping_version': 'profile-2',
            'bot_wake_names': {'alice': [' 阿璃 ', '阿璃']},
        })

        self.assertEqual(mapping.version, 'profile-2')
        self.assertEqual(mapping.names_for('alice'), ('阿璃',))

    def test_empty_role_mapping_fails_closed(self):
        with self.assertRaises(ValueError):
            WakeMapping.from_config({'bot_wake_names': {'alice': []}})

    def test_all_names_are_unique_in_role_order_for_asr_hints(self):
        mapping = WakeMapping.from_config({'bot_wake_names': {
            'alice': ['阿璃', '小璃'], 'bob': ['小璃', '阿木'],
        }})

        self.assertEqual(mapping.all_names(), ('阿璃', '小璃', '阿木'))


