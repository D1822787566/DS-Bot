"""Line protocol for the isolated Local Voice runtime.

The host owns lifecycle and DS Bot routing. This process owns only local speech
models and returns bounded JSON messages on stdout.
"""

from __future__ import annotations

import base64
import binascii
from typing import Any, Iterable

MAX_REQUEST_TEXT = 16_000
MAX_AUDIO_BYTES = 20 * 16000 * 2


def _error(code: str, message: str) -> dict[str, str]:
    return {"type": "error", "code": code, "message": message}


def _required_id(message: dict[str, Any]) -> str:
    value = message.get("request_id")
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise ValueError("request_id is required")
    return value


def _sample_rate(message: dict[str, Any]) -> int:
    value = message.get("sample_rate", 16000)
    if value != 16000:
        raise ValueError("sample_rate must be 16000")
    return value


def _is_cancelled(service: Any, request_id: str) -> bool:
    checker = getattr(service, "cancelled", None)
    if not callable(checker):
        checker = getattr(service, "is_cancelled", None)
    return bool(checker(request_id)) if callable(checker) else False


class RuntimeProtocol:
    def __init__(self, service):
        self.service = service

    def handle(self, message: Any) -> Iterable[dict[str, Any]]:
        request_id = message.get("request_id") if isinstance(message, dict) else None
        request_id = request_id if isinstance(request_id, str) and request_id.strip() else None
        try:
            if not isinstance(message, dict):
                raise ValueError("message must be an object")
            kind = message.get("type")
            if kind == "hello":
                caps = self.service.capabilities()
                yield {
                    "type": "ready",
                    "asr": caps.get("asr") is True,
                    "tts": caps.get("tts") is True,
                    "prewarmed": caps.get("prewarmed") is True,
                }
                return
            if kind == "transcribe":
                request_id = _required_id(message)
                sample_rate = _sample_rate(message)
                encoded = message.get("audio_b64")
                if not isinstance(encoded, str) or not encoded:
                    raise ValueError("audio_b64 is required")
                try:
                    audio = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error):
                    raise ValueError("audio_b64 is invalid") from None
                if not audio or len(audio) > MAX_AUDIO_BYTES or len(audio) % 2:
                    raise ValueError("audio frame is invalid")
                text = self.service.transcribe(audio, sample_rate)
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("empty transcript")
                yield {"type": "transcript", "request_id": request_id, "text": text[:4000]}
                return
            if kind == "synthesize":
                request_id = _required_id(message)
                sample_rate = _sample_rate(message)
                text = message.get("text")
                voice = message.get("voice", "")
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_REQUEST_TEXT:
                    raise ValueError("text is invalid")
                if not isinstance(voice, str) or len(voice) > 128:
                    raise ValueError("voice is invalid")
                for chunk in self.service.synthesize(text.strip(), voice.strip(), sample_rate, request_id=request_id):
                    if _is_cancelled(self.service, request_id):
                        yield {"type": "cancelled", "request_id": request_id}
                        return
                    if not isinstance(chunk, bytes) or not chunk or len(chunk) % 2:
                        raise ValueError("PCM chunk is invalid")
                    yield {"type": "audio", "request_id": request_id, "data": base64.b64encode(chunk).decode("ascii")}
                if _is_cancelled(self.service, request_id):
                    yield {"type": "cancelled", "request_id": request_id}
                    return
                yield {"type": "complete", "request_id": request_id}
                return
            if kind == "cancel":
                request_id = _required_id(message)
                self.service.cancel(request_id)
                yield {"type": "cancelled", "request_id": request_id}
                return
            raise ValueError("unsupported runtime message")
        except Exception as error:
            response = _error("runtime_request_failed" if request_id else "invalid_request", str(error)[:240])
            if request_id:
                response["request_id"] = request_id
            yield response


def parse_line(line: str) -> Any:
    import json

    return json.loads(line)
