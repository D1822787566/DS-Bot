import asyncio
import json
import threading

import numpy as np
import pytest

from audio_adapter import AudioSegment, OwnerDecision
from speech_models import SpeechModels, SpeechFailure, load_speech_models
from retained_models import CAMProfile


def segment():
    return AudioSegment(np.ones(16000, dtype=np.float32) * .1, 16000, 1, 2., 1.)


def test_missing_profile_fails_before_loading_models(tmp_path):
    config = {key: str(tmp_path) for key in ('asrModelDir', 'speakerModelDir', 'speakerProfileDir')}
    with pytest.raises(SpeechFailure, match='speaker_profile_missing'):
        load_speech_models(config, ())


def test_owner_rejection_never_returns_a_transcript():
    models = SpeechModels(lambda _: 'secret text', lambda s: OwnerDecision('unknown', .1, 'unknown', s.segment_id))
    text, owner = asyncio.run(models.recognize(segment()))
    assert text is None and owner.identity == 'unknown'


def test_owner_verified_recognition_preserves_the_complete_asr_transcript():
    models = SpeechModels(
        lambda _: '  华子，检查项目。  ',
        lambda s: OwnerDecision('owner', .99, 'verified', s.segment_id, 'cam++', 'p'))
    text, owner = asyncio.run(models.recognize(segment()))
    assert text == '  华子，检查项目。  '
    assert owner.status == 'verified'


def test_transcribe_only_does_not_call_owner_verification():
    calls = []
    models = SpeechModels(lambda _: (calls.append('asr') or '完整结果'), lambda _: calls.append('owner'))
    text = asyncio.run(models.transcribe_only(segment()))
    assert text == '完整结果'
    assert calls == ['asr']


def test_native_timeout_cannot_launch_more_parallel_model_work_or_submit_late():
    released = threading.Event()
    calls = []

    def transcribe(item):
        calls.append(item.segment_id)
        released.wait(2.)
        return 'late text'

    async def run():
        models = SpeechModels(transcribe, lambda s: OwnerDecision('owner', .99, 'verified', s.segment_id, 'cam++', 'p'), asr_timeout=.01)
        try:
            with pytest.raises(SpeechFailure, match='asr_timeout'):
                await models.recognize(segment())
            with pytest.raises(SpeechFailure, match='models_busy'):
                await models.recognize(segment())
            assert calls == [1]
        finally:
            released.set()
            await models.drain()

    asyncio.run(run())


def test_user_labeled_voiceprint_samples_wait_for_apply_and_survive_reload(tmp_path):
    profile_dir = tmp_path / 'profile'
    profile_dir.mkdir()
    (profile_dir / 'target_profile.json').write_text(json.dumps({
        'model': 'cam++', 'sample_rate': 16000, 'normalization': 'l2', 'threshold': .5,
    }), encoding='utf-8')
    np.savez(profile_dir / 'target_profile.npz', centroid=np.array([1., 0.]))
    profile = CAMProfile(profile_dir, object())
    assert profile.pending_count == 0
    assert profile.approved_count == 0
    profile.add_pending(np.array([0., 1.]), sample_id='sample-1', segment_id=7, score=.42)
    assert profile.pending_count == 1
    assert profile.approved_count == 0
    profile.apply_pending()
    reloaded = CAMProfile(profile_dir, object())
    assert reloaded.pending_count == 0
    assert reloaded.approved_count == 1


def test_applied_voiceprint_embedding_can_raise_a_matching_score(tmp_path):
    profile_dir = tmp_path / 'profile'
    profile_dir.mkdir()
    (profile_dir / 'target_profile.json').write_text(json.dumps({
        'model': 'cam++', 'sample_rate': 16000, 'normalization': 'l2', 'threshold': .5,
    }), encoding='utf-8')
    np.savez(profile_dir / 'target_profile.npz', centroid=np.array([1., 0.]))

    class Model:
        def generate(self, **_kwargs):
            return [{'spk_embedding': np.array([0., 1.])}]

    profile = CAMProfile(profile_dir, Model())
    audio = np.ones(16000, dtype=np.float32) * .1
    assert profile.score(audio) == 0.
    profile.add_pending(np.array([0., 1.]), sample_id='sample-2', segment_id=8, score=0.)
    profile.apply_pending()
    assert profile.score(audio) == 1.
