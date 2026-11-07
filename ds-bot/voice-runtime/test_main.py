import json
import asyncio
import sys
import pytest

import main
from main import choose_input_device, choose_output_device, resample_pcm16, runtime_config_from_env, VoiceRuntime
from bridge_client import BridgeEvent


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
        async def synthesize_stream(self, text, *, voice):
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
    runtime.handle_event_sync({
        "type": "output.started",
        "correlation": {"response_id": "response-1"},
        "payload": {"tts_voice": "voice-a"},
    })
    runtime.handle_event_sync({
        "type": "output.segment",
        "correlation": {"response_id": "response-1"},
        "payload": {"speak_text": "你好", "tts_voice": "voice-a"},
    })
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
                           config={"windowsWakeEnabled": True})
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
                           config={"windowsWakeEnabled": True})
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
