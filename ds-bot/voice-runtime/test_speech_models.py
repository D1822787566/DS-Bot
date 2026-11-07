import asyncio
import threading

import numpy as np
import pytest

from audio_adapter import AudioSegment, OwnerDecision
from speech_models import SpeechModels, SpeechFailure, load_speech_models


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
