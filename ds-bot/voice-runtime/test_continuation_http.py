import pytest

from continuation_http import ContinuationHttpEvaluator
from continuation_input import ContinuationContext, ContinuationTurn
from voice_addressing import ContextSnapshot


def test_frozen_runtime_preserves_associated_turns_and_three_way_scores():
    client = ContinuationHttpEvaluator('http://127.0.0.1:12000/score',
                                     model='deepseek-flash-continuation-prompt-v2-053', mode='frozen_llm')
    turns = (ContinuationTurn('i1', 'r1', '第一问', '第一答'),
             ContinuationTurn('i2', 'r2', '第二问', '第二答'))
    body = client.build_payload(ContextSnapshot('bot-a', 'owner', 'v', agent_names=('华子',)),
                                ContinuationContext(2, '第二问', '第二答', 1., turns), '继续解释')
    assert '第1轮用户：第一问' in body['state']
    assert '第二问' in body['state'] and '第二答' in body['state']
    for choice, confidence, expected in [('configuration_matches_speech', 1, 1),
                                         ('configuration_matches_speech', .5, .5),
                                         ('configuration_does_not_match_speech', 1, 0)]:
        assert client.parse_response({'model': client.model, 'answers': {
            'configuration_matching': {'choice': choice, 'confidence': confidence}}}) == expected
    with pytest.raises(ValueError, match='mismatch'):
        client.parse_response({'model': 'wrong', 'answers': {}})
