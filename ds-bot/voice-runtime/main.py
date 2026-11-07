"""DS Bot managed Windows voice runtime.

The process boundary is intentional: this module owns the Windows audio and
speech providers while the DS Bot host owns Bot sessions and model execution.
The only cognition-facing transport is the authenticated local Bridge.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Mapping

from bridge_client import BridgeClient, BridgeEvent
from wake_mapping import WakeMapping
from windows_adapter import WindowsDeviceAdapter


def runtime_config_from_env(values: Mapping[str, str] | None = None) -> dict:
    values = os.environ if values is None else values
    raw = values.get("DS_BOT_VOICE_CONFIG", "{}")
    try:
        config = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid DS_BOT_VOICE_CONFIG") from error
    if not isinstance(config, dict):
        raise ValueError("invalid DS_BOT_VOICE_CONFIG")
    result = {
        "bridge_url": values.get("DS_BOT_BRIDGE_URL", "").strip(),
        "bridge_credential": values.get("DS_BOT_BRIDGE_CREDENTIAL", "").strip(),
        "device_id": values.get("DS_BOT_DEVICE_ID", "windows-dsbot-01").strip(),
        "target_id": values.get("DS_BOT_TARGET_ID", values.get("DS_BOT_DEVICE_ID", "windows-dsbot-01")).strip(),
    }
    if not result["bridge_url"] or not result["bridge_credential"]:
        raise ValueError("DS Bot Bridge credentials are required")
    if not result["device_id"] or not result["target_id"]:
        raise ValueError("DS Bot device identity is required")
    result.update(config)
    return result


class NullTTS:
    """Keep the Bridge usable while the user has not configured a TTS key."""

    async def synthesize_stream(self, _text: str, *, voice: str | None = None):
        if False:
            yield b""


class WindowsPcmPlayback:
    """Small playback boundary. The real output stream is opened lazily."""

    def __init__(self, device_name: str = ""):
        self.device_name = device_name
        self._stream = None

    async def start(self):
        if os.name != "nt":
            return
        try:
            import sounddevice as sd

            kwargs = {"samplerate": 16000, "channels": 1, "dtype": "int16"}
            if self.device_name:
                kwargs["device"] = self.device_name
            self._stream = sd.RawOutputStream(**kwargs)
            self._stream.start()
        except Exception as error:
            raise RuntimeError("Windows audio output could not be opened") from error

    async def play(self, chunk: bytes):
        if self._stream is not None:
            await asyncio.to_thread(self._stream.write, chunk)

    async def stop(self):
        if self._stream is not None:
            await asyncio.to_thread(self._stream.stop)

    async def close(self):
        if self._stream is not None:
            await asyncio.to_thread(self._stream.close)
            self._stream = None


class VoiceRuntime:
    def __init__(self, bridge, tts, playback, *, device=None):
        self.bridge = bridge
        self.tts = tts
        self.playback = playback
        self.device = device
        self.roles = None
        self.mapping = None
        self.responses: dict[str, dict] = {}
        self.state = "stopped"

    async def start(self):
        if self.device is not None:
            self.device.connect()
        await self.bridge.connect()
        roles_event = await self.bridge.subscribe_roles()
        self.roles = roles_event.payload if isinstance(roles_event, BridgeEvent) else roles_event
        self.mapping = WakeMapping.from_roster(self.roles)
        await self.playback.start()
        self.state = "listening"
        print(json.dumps({"type": "runtime.ready", "state": self.state,
                          "roles": list(self.mapping.roles)}, ensure_ascii=False), flush=True)
        return self.roles

    async def stop(self):
        self.state = "stopped"
        await self.playback.stop()
        await self.playback.close() if hasattr(self.playback, "close") else asyncio.sleep(0)
        await self.bridge.close()
        if self.device is not None:
            self.device.disconnect()

    async def submit_transcript(self, text: str, *, bot_id: str, score: float = 1.0):
        return await self.bridge.submit(text, bot_id=bot_id,
                                        speaker={"status": "owner_verified", "score": score})

    async def handle_event(self, event: BridgeEvent | dict):
        value = event.raw if isinstance(event, BridgeEvent) else event
        event_type = value.get("type")
        correlation = value.get("correlation") or {}
        payload = value.get("payload") or {}
        if event_type == "roles.snapshot.result" or event_type == "roles.changed":
            self.roles = payload
            self.mapping = WakeMapping.from_roster(payload)
            return
        if event_type == "output.started":
            response_id = correlation.get("response_id")
            if response_id:
                self.responses[response_id] = {"voice": payload.get("tts_voice")}
            self.state = "speaking"
            return
        if event_type == "output.segment":
            response_id = correlation.get("response_id")
            if not response_id or response_id not in self.responses:
                return
            text = payload.get("speak_text")
            if not isinstance(text, str) or not text.strip():
                return
            voice = payload.get("tts_voice") or self.responses[response_id].get("voice")
            async for chunk in self.tts.synthesize_stream(text, voice=voice):
                await self.playback.play(chunk)
            if isinstance(event, BridgeEvent):
                await self.bridge.progress(event)
            return
        if event_type == "output.ended":
            response_id = correlation.get("response_id")
            if response_id:
                self.responses.pop(response_id, None)
            self.state = "listening"

    def handle_event_sync(self, value: dict):
        asyncio.run(self.handle_event(value))

    async def run(self):
        await self.start()
        while True:
            await self.handle_event(await self.bridge.next_event())


def make_tts(config: Mapping[str, object]):
    config_path = config.get("ttsConfigPath")
    if not isinstance(config_path, str) or not config_path.strip():
        return NullTTS()
    from retained_tts import RetainedTTS

    return RetainedTTS(config_path)


async def run(config: Mapping[str, object]):
    bridge = BridgeClient(config["bridge_url"], config["bridge_credential"],
                          channel="voice", target_id=config["target_id"])
    device = WindowsDeviceAdapter(config["device_id"], target_id=config["target_id"])
    playback = WindowsPcmPlayback(str(config.get("outputDeviceName", "")))
    runtime = VoiceRuntime(bridge, make_tts(config), playback, device=device)
    try:
        await runtime.run()
    finally:
        await runtime.stop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    config = runtime_config_from_env()
    if args.config:
        config.update(json.loads(args.config.read_text(encoding="utf-8")))
    asyncio.run(run(config))


if __name__ == "__main__":
    main()
