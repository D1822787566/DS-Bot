import json
import asyncio
import sys
from types import SimpleNamespace
import pytest
import numpy as np

import main
from main import choose_input_device, choose_output_device, resample_pcm16, runtime_config_from_env, VoiceRuntime, StreamingPcm16Resampler, read_voiceprint_command
from bridge_client import BridgeEvent


class IdleVad:
    window_size_samples = 160
    def reset(self): pass
    def __call__(self, _samples): return 0.


def test_runtime_reads_only_ds_bot_environment_contract():
    config = runtime_config_from_env({
        "DS_BOT_BRIDGE_URL": "ws://127.0.0.1:4321",
        "DS_BOT_BRIDGE_CREDENTIAL": "secret",
        "DS_BOT_DEVICE_ID": "windows-1",
        "DS_BOT_TARGET_ID": "windows-1",
        "DS_BOT_VOICE_CONFIG": json.dumps({"ttsVoice": "voice-a"}),
    })
    assert config["bridge_url"] == "ws://127.0.0.1:4321"
    assert config["bridge_credential"] == "secret"
    assert config["device_id"] == "windows-1"
    assert config["target_id"] == "windows-1"
    assert config["ttsVoice"] == "voice-a"
    assert set(config) <= {
        "bridge_url", "bridge_credential", "device_id", "target_id",
        "ttsVoice", "windowsWakeModelDir",
    }


def test_runtime_maps_output_segments_to_tts_and_playback():
    class Bridge:
        async def cancel(self, *_):
            return None

    class TTS:
        async def synthesize_stream(self, text, cancellation_token=None, *, voice):
            yield text.encode()

    class Playback:
        def __init__(self):
            self.chunks = []

        async def play(self, chunk):
            self.chunks.append(chunk)

        async def stop(self):
            return None

    playback = Playback()
    runtime = VoiceRuntime(Bridge(), TTS(), playback)
    async def run():
        await runtime.handle_event({
            "type": "output.started",
            "correlation": {"response_id": "response-1"},
            "payload": {"tts_voice": "voice-a"},
        })
        await runtime.handle_event({
            "type": "output.segment",
            "correlation": {"response_id": "response-1"},
            "payload": {"speak_text": "你好", "tts_voice": "voice-a"},
        })
        await runtime.output.drain()
        await runtime.output.close()
    asyncio.run(run())
    assert playback.chunks == ["你好".encode()]


def test_runtime_unwraps_the_roles_snapshot_bridge_event_before_mapping():
    class Bridge:
        async def connect(self):
            return None

        async def subscribe_roles(self):
            raw = {
                "protocol": "agent-events.v1", "event_id": "roles-1",
                "type": "roles.snapshot.result", "binding": {
                    "device_id": "windows-1", "activity_epoch": "epoch", "channel_session_id": "session",
                }, "sequence": 1, "correlation": {"request_id": "request-1"},
                "payload": {"activity_epoch": "epoch", "revision": 1, "roles": [{
                    "bot_id": "b", "session_id": "session-b", "wake_names": ["小贝"], "profile_version": 1,
                }]}, "occurred_at": "2026-11-07T00:00:00Z",
            }
            return BridgeEvent.parse(raw)

        async def close(self):
            return None

    class Playback:
        async def start(self):
            return None

        async def stop(self):
            return None

        async def close(self):
            return None

    runtime = VoiceRuntime(Bridge(), object(), Playback())
    asyncio.run(runtime.start())
    assert runtime.mapping.roles == {"b": ("小贝",)}


def test_output_device_selection_prefers_wasapi_when_windows_names_are_duplicated():
    devices = [
        {"name": "扬声器 (Philips SPA5308P)", "max_output_channels": 2, "hostapi": 0, "index": 5},
        {"name": "扬声器 (Philips SPA5308P)", "max_output_channels": 2, "hostapi": 1, "index": 14},
        {"name": "扬声器 (Philips SPA5308P)", "max_output_channels": 2, "hostapi": 2, "index": 18},
    ]
    hostapis = [{"name": "Windows DirectSound"}, {"name": "Windows WDM-KS"}, {"name": "Windows WASAPI"}]
    assert choose_output_device(devices, hostapis, "扬声器 (Philips SPA5308P)") == 18


def test_input_device_selection_prefers_wasapi_when_microphone_names_are_duplicated():
    devices = [
        {"name": "C01", "max_input_channels": 1, "hostapi": 0, "index": 1},
        {"name": "C01", "max_input_channels": 1, "hostapi": 2, "index": 19},
    ]
    hostapis = [{"name": "MME"}, {"name": "Windows DirectSound"}, {"name": "Windows WASAPI"}]
    assert choose_input_device(devices, hostapis, "C01") == 19


def test_microphone_open_failure_is_reported_as_a_runtime_error(monkeypatch):
    class SoundDevice:
        class Default:
            device = (1, 5)

        default = Default()

        @staticmethod
        def query_devices():
            return [{"name": "C01", "max_input_channels": 1,
                     "default_samplerate": 48000, "hostapi": 0, "index": 1}]

        @staticmethod
        def query_hostapis():
            return [{"name": "Windows WASAPI"}]

        class RawInputStream:
            def __init__(self, **_kwargs):
                raise OSError("device is busy")

    monkeypatch.setattr(main.os, "name", "nt")
    monkeypatch.setitem(sys.modules, "sounddevice", SoundDevice)
    capture = main.WindowsPcmCapture("C01")
    with pytest.raises(RuntimeError, match="Windows microphone could not be opened"):
        asyncio.run(capture.start())


def test_pcm_output_is_resampled_to_the_selected_windows_device_rate():
    source = b"\x00\x00\xff\x7f"
    result = resample_pcm16(source, 16000, 48000)
    assert len(result) == 12
    assert result[:2] == b"\x00\x00"
    assert int.from_bytes(result[-2:], "little", signed=True) == 32767


def test_streaming_input_resampler_preserves_chunk_boundaries():
    source = (np.sin(np.linspace(0, 12, 4800)) * 12000).astype('<i2').tobytes()
    expected = resample_pcm16(source, 48000, 16000)
    resampler = StreamingPcm16Resampler(48000, 16000)
    chunks = [source[offset:offset + 960] for offset in range(0, len(source), 960)]
    result = b''.join(resampler.push(chunk) for chunk in chunks) + resampler.flush()
    assert result == expected


def test_voiceprint_command_is_consumed_once(tmp_path):
    path = tmp_path / 'voice-diagnostics-command.json'
    path.write_text('{"mode":"voiceprint"}', encoding='utf-8')
    assert read_voiceprint_command(path) == 'voiceprint'
    assert read_voiceprint_command(path) is None


def test_voiceprint_label_command_is_consumed_and_preserves_segment_id(tmp_path):
    path = tmp_path / 'voice-diagnostics-command.json'
    path.write_text('{"mode":"voiceprint_label","segment_id":7}', encoding='utf-8')
    request = main.read_voiceprint_request(path)
    assert request == {'mode': 'voiceprint_label', 'segment_id': 7}
    assert main.read_voiceprint_request(path) is None


def test_voiceprint_test_runs_owner_verification_without_bridge_submission():
    from audio_adapter import AudioSegment, OwnerDecision
    from speech_models import SpeechModels

    models = SpeechModels(lambda _: '测试语音', lambda item:
                          OwnerDecision('owner', .91, 'verified', item.segment_id, 'cam++', 'profile'))
    runtime = VoiceRuntime(object(), object(), object(), models=models)
    events = []
    runtime.record = lambda kind, **fields: events.append((kind, fields))
    segment = AudioSegment(np.ones(16000, dtype=np.float32) * .1, 16000, 1, 2., 1.)
    asyncio.run(runtime._run_voiceprint_test(segment))
    assert [kind for kind, _ in events] == ['identity.verified', 'asr.completed', 'voice.test.completed']
    assert events[-1][1]['result'] == 'owner_verified'


def test_voiceprint_candidate_requires_explicit_label_before_apply(tmp_path):
    class Models:
        def __init__(self):
            self.labeled = []
            self.applied = 0
            self.discarded = 0

        def profile_status(self):
            return {'pending_samples': len(self.labeled), 'approved_samples': self.applied}

        def label_profile_sample(self, candidate):
            self.labeled.append(candidate)
            return self.profile_status()

        def apply_profile_samples(self):
            self.applied += len(self.labeled)
            self.labeled.clear()
            return self.profile_status()

        def discard_profile_samples(self):
            self.labeled.clear()
            return self.profile_status()

    command = tmp_path / 'voice-command.json'
    models = Models()
    runtime = VoiceRuntime(object(), object(), object(), models=models,
                           config={'diagnosticCommandPath': str(command)})
    events = []
    runtime.record = lambda kind, **fields: events.append((kind, fields))
    runtime._voiceprint_candidate = {
        'sample_id': 'voice-test-7', 'segment_id': 7, 'score': .42,
        'embedding': np.array([1., 0.]),
    }
    command.write_text('{"mode":"voiceprint_label","segment_id":7}', encoding='utf-8')
    runtime._poll_voiceprint_command()
    assert models.labeled and runtime._voiceprint_candidate is None
    assert events[-1][0] == 'voice.sample.labeled'
    command.write_text('{"mode":"voiceprint_apply"}', encoding='utf-8')
    runtime._poll_voiceprint_command()
    assert models.applied == 1
    assert events[-1][0] == 'voice.sample.applied'


def test_idle_bridge_timeout_does_not_shutdown_the_runtime():
    class Bridge:
        def __init__(self):
            self.calls = 0

        async def next_event(self):
            self.calls += 1
            if self.calls == 1:
                raise asyncio.TimeoutError
            raise StopAsyncIteration

    runtime = VoiceRuntime(Bridge(), object(), object())
    async def start():
        runtime.state = "listening"
    runtime.start = start
    try:
        asyncio.run(runtime.run())
    except StopAsyncIteration:
        pass
    assert runtime.bridge.calls == 2


def test_runtime_surfaces_microphone_start_failure_before_ready(monkeypatch):
    class Bridge:
        async def connect(self):
            return None

        async def subscribe_roles(self):
            return {
                "activity_epoch": "epoch", "revision": 1,
                "roles": [{"bot_id": "b", "session_id": "session-b",
                           "wake_names": ["小贝"], "profile_version": 1}],
            }

        async def close(self):
            return None

    class Playback:
        async def start(self):
            return None

        async def stop(self):
            return None

        async def close(self):
            return None

    class BrokenWakeRuntime:
        def __init__(self, *_args):
            pass

        async def start(self):
            raise RuntimeError("Windows microphone could not be opened")

    monkeypatch.setattr(main, "WindowsWakeRuntime", BrokenWakeRuntime)
    runtime = VoiceRuntime(Bridge(), object(), Playback(),
                           models=object(), vad=IdleVad(),
                           config={"windowsWakeEnabled": True, "continuationEnabled": False})
    with pytest.raises(RuntimeError, match="microphone"):
        asyncio.run(runtime.start())


def test_runtime_propagates_background_wake_failure(monkeypatch):
    class Bridge:
        async def connect(self):
            return None

        async def subscribe_roles(self):
            return {
                "activity_epoch": "epoch", "revision": 1,
                "roles": [{"bot_id": "b", "session_id": "session-b",
                           "wake_names": ["小贝"], "profile_version": 1}],
            }

        async def next_event(self):
            await asyncio.sleep(10)

        async def close(self):
            return None

    class Playback:
        async def start(self):
            return None

        async def stop(self):
            return None

        async def close(self):
            return None

    class FailedWakeRuntime:
        def __init__(self, *_args):
            pass

        async def start(self):
            return None

        async def run(self):
            raise RuntimeError("wake decoder stopped")

        async def close(self):
            return None

    monkeypatch.setattr(main, "WindowsWakeRuntime", FailedWakeRuntime)
    runtime = VoiceRuntime(Bridge(), object(), Playback(),
                           models=object(), vad=IdleVad(),
                           config={"windowsWakeEnabled": True, "continuationEnabled": False})
    with pytest.raises(RuntimeError, match="wake decoder stopped"):
        asyncio.run(runtime.run())


def test_wake_candidate_is_published_to_the_ds_bot_bridge():
    class Bridge:
        def __init__(self):
            self.payload = None

        async def publish_wake(self, payload):
            self.payload = payload

    bridge = Bridge()
    runtime = VoiceRuntime(bridge, object(), object())
    payload = {
        "type": "device.wake", "wake_session_id": "wake-1", "bot_id": "b",
        "wake_mapping_version": "epoch:1",
    }
    asyncio.run(runtime._on_wake(payload))
    assert bridge.payload == payload
    assert runtime.active_bot_id == "b"


def test_wake_chunk_is_forwarded_to_post_wake_segmenter():
    pcm = b"\x00\x01" * 160
    received, wakes = [], []

    class Capture:
        sample_rate = 16000
        dropped_chunks = 0

        async def next_chunk(self):
            return pcm

        async def close(self):
            return None

    class Detector:
        def process_pcm16(self, value):
            assert value == pcm
            return (object(),)

        def event_for_hit(self, _hit):
            return {'type': 'device.wake', 'bot_id': 'b', 'wake_session_id': 'w',
                    'wake_mapping_version': 'epoch:1'}

        def diagnostics_snapshot(self):
            return {}

        def close(self):
            return None

    async def on_wake(payload):
        wakes.append(payload)
        runtime._closed = True

    runtime = main.WindowsWakeRuntime.__new__(main.WindowsWakeRuntime)
    runtime.capture = Capture()
    runtime.detector = Detector()
    runtime._closed = False
    runtime.processing = None
    runtime.on_pcm = received.append
    runtime.on_gap = None
    runtime.on_wake = on_wake

    asyncio.run(runtime.run())
    assert wakes and received == [pcm]


def test_managed_runtime_connects_pcm_models_bridge_and_target_voice(monkeypatch):
    import numpy as np
    from types import SimpleNamespace
    from audio_adapter import OwnerDecision
    from speech_models import SpeechModels

    class Bridge:
        on_roles_changed = None

        def __init__(self):
            self.sent = []

        async def connect(self): pass

        async def subscribe_roles(self):
            return {'activity_epoch': 'epoch', 'revision': 1, 'roles': [{
                'bot_id': 'b', 'session_id': 'chat-b', 'wake_names': ['华子'], 'profile_version': 1}]}

        async def publish_wake(self, value):
            return SimpleNamespace(type='device.wake.accepted', payload=value)

        async def context_snapshot(self, bot_id, **kwargs):
            return SimpleNamespace(payload={'bot_id': bot_id, 'user_id': 'owner', 'profile_version': 1})

        async def submit(self, text, **kwargs):
            self.sent.append({'text': text, **kwargs})
            return SimpleNamespace(type='input.accepted', payload={'status': 'queued'})

        async def progress(self, *args, **kwargs): pass
        async def close(self): pass

    class Playback:
        def __init__(self): self.chunks = []
        async def start(self): pass
        async def stop(self): pass
        async def close(self): pass
        async def play(self, pcm): self.chunks.append(pcm)

    class TTS:
        def __init__(self): self.voices = []
        async def synthesize_stream(self, text, cancellation_token=None, *, voice):
            self.voices.append(voice)
            yield b'\x00\x00' * 160

    class Vad:
        window_size_samples = 160
        def reset(self): pass
        def __call__(self, samples): return 1. if np.max(np.abs(samples)) > .01 else 0.

    class Wake:
        def __init__(self, *args): pass
        async def start(self): pass
        async def run(self): await asyncio.Event().wait()
        async def close(self): pass

    monkeypatch.setattr(main, 'WindowsWakeRuntime', Wake)

    async def run():
        bridge, tts, playback = Bridge(), TTS(), Playback()
        models = SpeechModels(lambda _: '检查项目', lambda s: OwnerDecision('owner', .99, 'verified', s.segment_id, 'cam++', 'p'))
        runtime = VoiceRuntime(bridge, tts, playback, models=models, vad=Vad(),
                               config={'windowsWakeEnabled': True, 'continuationEnabled': False})
        try:
            await runtime.start()
            await runtime._on_wake({'bot_id': 'b', 'wake_session_id': 'w', 'wake_mapping_version': 'epoch:1'})
            runtime._on_pcm(np.full(16000, 4000, dtype='<i2').tobytes() + b'\x00\x00' * 16000)
            await runtime.input.task
            item = bridge.sent[0]
            correlation = {key: item[key] for key in ('bot_id', 'session_id', 'input_id', 'wake_session_id', 'generation')}
            correlation['response_id'] = 'r'
            await runtime.handle_event({'type': 'output.started', 'correlation': correlation, 'payload': {'tts_voice': 'bot-voice'}})
            await runtime.handle_event({'type': 'output.segment', 'correlation': correlation, 'payload': {'segment_index': 0, 'speak_text': '已检查'}})
            await runtime.handle_event({'type': 'output.ended', 'correlation': correlation, 'payload': {'status': 'completed'}})
            await runtime.output.drain()
            assert item['text'] == '检查项目' and item['session_id'] == 'chat-b'
            assert tts.voices == ['bot-voice'] and len(playback.chunks) == 1
        finally:
            await runtime.stop()
    asyncio.run(run())
