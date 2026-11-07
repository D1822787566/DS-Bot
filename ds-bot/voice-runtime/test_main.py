import json

from main import runtime_config_from_env, VoiceRuntime


def test_runtime_reads_only_ds_bot_environment_contract():
    config = runtime_config_from_env({
        "DS_BOT_BRIDGE_URL": "ws://127.0.0.1:4321",
        "DS_BOT_BRIDGE_CREDENTIAL": "secret",
        "DS_BOT_DEVICE_ID": "windows-1",
        "DS_BOT_TARGET_ID": "windows-1",
        "DS_BOT_VOICE_CONFIG": json.dumps({"ttsVoice": "voice-a"}),
    })
    assert config == {
        "bridge_url": "ws://127.0.0.1:4321",
        "bridge_credential": "secret",
        "device_id": "windows-1",
        "target_id": "windows-1",
        "ttsVoice": "voice-a",
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
