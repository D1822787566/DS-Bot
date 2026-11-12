import pytest
import numpy as np

from service import MeloTts, SpeechService


class FakeAsr:
    def transcribe(self, audio, sample_rate):
        return f"text-{len(audio)}-{sample_rate}"


class FakeTts:
    def __init__(self):
        self.calls = []

    def synthesize(self, text, voice, sample_rate, request_id="", cancel_check=None):
        self.calls.append((text, voice, sample_rate, request_id))
        yield text.encode("utf-8")
        yield b"\x00\x00"


def test_service_delegates_asr_and_tts_with_bounded_cancellation():
    tts = FakeTts()
    service = SpeechService(asr=FakeAsr(), tts=tts)
    assert service.capabilities() == {"asr": True, "tts": True, "prewarmed": False}
    assert service.transcribe(b"12", 16000) == "text-2-16000"
    assert list(service.synthesize("你好", "ZH", 16000, request_id="r1")) == ["你好".encode("utf-8"), b"\x00\x00"]
    assert tts.calls == [("你好", "ZH", 16000, "r1")]
    service.cancel("r1")
    assert service.cancelled("r1") is True


def test_service_warmup_runs_a_short_local_tts_request():
    tts = FakeTts()
    SpeechService(tts=tts).warmup()
    assert tts.calls == [("嗯", "", 16000, "")]


def test_service_requires_at_least_one_model_for_capability():
    service = SpeechService()
    assert service.capabilities() == {"asr": False, "tts": False, "prewarmed": False}
    with pytest.raises(RuntimeError, match="ASR model is not configured"):
        service.transcribe(b"12", 16000)
    with pytest.raises(RuntimeError, match="TTS model is not configured"):
        list(service.synthesize("你好", "ZH", 16000))


class FakeHParams:
    class Data:
        sampling_rate = 24000
        spk2id = {"ZH": 7}

    data = Data()


class FakeMeloModel:
    hps = FakeHParams()

    def __init__(self):
        self.calls = []

    def tts_to_file(self, text, speaker, output_path=None, speed=1.0, quiet=True):
        assert speaker == 7
        assert output_path is None
        self.calls.append(text)
        return np.linspace(-0.25, 0.25, 240, dtype=np.float32)


def test_melo_tts_returns_mono_pcm16_at_runtime_sample_rate():
    model = FakeMeloModel()
    chunks = list(MeloTts(model).synthesize("你好", "", 16000))
    pcm = b"".join(chunks)
    assert len(pcm) > 0
    assert len(pcm) % 2 == 0
    assert len(pcm) == 320
    assert model.calls == ["你好"]


def test_melo_tts_checks_cancellation_between_sentence_chunks():
    model = FakeMeloModel()
    cancelled = False
    chunks = MeloTts(model).synthesize("你好。再见。", "", 16000, cancel_check=lambda: cancelled)
    first = next(chunks)
    assert first
    cancelled = True
    assert list(chunks) == []
    assert model.calls == ["你好。"]


def test_melo_preserves_speaker_zero_and_filters_above_output_nyquist():
    from types import SimpleNamespace

    class HighFrequencyModel:
        hps = SimpleNamespace(data=SimpleNamespace(sampling_rate=44100, spk2id={"ZH": 3, "custom": 0}))

        def tts_to_file(self, text, speaker, output_path, **kwargs):
            assert speaker == 0
            t = np.arange(44100) / 44100
            return np.sin(2 * np.pi * 12000 * t).astype(np.float32)

    chunks = MeloTts(HighFrequencyModel()).synthesize("你好", "custom", 16000)
    samples = np.frombuffer(b"".join(chunks), dtype="<i2").astype(np.float32) / 32768
    assert len(samples) == 16000
    assert np.sqrt(np.mean(samples[100:-100] ** 2)) < 0.005
