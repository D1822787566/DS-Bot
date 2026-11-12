import base64
import json

from protocol import RuntimeProtocol


class FakeService:
    def __init__(self):
        self.cancelled = []
        self.cancelled_ids = set()

    def capabilities(self):
        return {"asr": True, "tts": True, "prewarmed": True}

    def transcribe(self, audio, sample_rate):
        assert audio == b"\x01\x02"
        assert sample_rate == 16000
        return "你好"

    def synthesize(self, text, voice, sample_rate, request_id=""):
        assert text == "你好"
        assert voice == "ZH"
        assert sample_rate == 16000
        yield b"\x01\x00"
        yield b"\x02\x00"

    def cancel(self, request_id):
        self.cancelled.append(request_id)
        self.cancelled_ids.add(request_id)

    def is_cancelled(self, request_id):
        return request_id in self.cancelled_ids


def collect(protocol, message):
    return list(protocol.handle(message))


def test_ready_and_transcription_messages_are_bounded():
    protocol = RuntimeProtocol(FakeService())
    assert collect(protocol, {"type": "hello"}) == [{"type": "ready", "asr": True, "tts": True, "prewarmed": True}]
    result = collect(protocol, {
        "type": "transcribe",
        "request_id": "r1",
        "sample_rate": 16000,
        "audio_b64": base64.b64encode(b"\x01\x02").decode(),
    })
    assert result == [{"type": "transcript", "request_id": "r1", "text": "你好"}]


def test_synthesis_emits_pcm_chunks_and_complete():
    protocol = RuntimeProtocol(FakeService())
    result = collect(protocol, {"type": "synthesize", "request_id": "r2", "text": "你好", "voice": "ZH", "sample_rate": 16000})
    assert result[0]["type"] == "audio"
    assert result[0]["request_id"] == "r2"
    assert base64.b64decode(result[0]["data"]) == b"\x01\x00"
    assert result[-1] == {"type": "complete", "request_id": "r2"}


def test_cancel_is_forwarded_and_invalid_messages_fail_closed():
    service = FakeService()
    protocol = RuntimeProtocol(service)
    assert collect(protocol, {"type": "cancel", "request_id": "r3"}) == [{"type": "cancelled", "request_id": "r3"}]
    assert service.cancelled == ["r3"]
    error = collect(protocol, {"type": "unsupported"})
    assert error[0]["type"] == "error"
    assert error[0]["code"] == "invalid_request"


def test_cancelled_synthesis_does_not_emit_complete():
    service = FakeService()
    service.cancelled_ids.add("r4")
    protocol = RuntimeProtocol(service)
    result = collect(protocol, {"type": "synthesize", "request_id": "r4", "text": "你好", "voice": "ZH", "sample_rate": 16000})
    assert result[-1] == {"type": "cancelled", "request_id": "r4"}
    assert all(message["type"] != "complete" for message in result)


def test_request_failure_keeps_request_id_for_the_host():
    class BrokenService(FakeService):
        def transcribe(self, audio, sample_rate):
            raise RuntimeError("model failed")

    result = collect(RuntimeProtocol(BrokenService()), {
        "type": "transcribe",
        "request_id": "r5",
        "sample_rate": 16000,
        "audio_b64": base64.b64encode(b"\x01\x02").decode(),
    })
    assert result == [{"type": "error", "code": "runtime_request_failed", "message": "model failed", "request_id": "r5"}]
