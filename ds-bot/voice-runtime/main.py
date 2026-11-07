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

import numpy as np

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


def choose_output_device(devices, hostapis, configured_name: str = "", default_index=None):
    """Return a stable PortAudio device index for a Windows output endpoint.

    Windows exposes the same endpoint through MME, DirectSound, WDM-KS and
    WASAPI. Passing the friendly name directly to sounddevice is ambiguous, so
    prefer the exact name on WASAPI, then WDM-KS, then DirectSound.
    """
    if not isinstance(devices, (list, tuple)):
        return default_index
    candidates = [item for item in devices if isinstance(item, dict)
                  and item.get("max_output_channels", 0) > 0]
    wanted = str(configured_name or "").strip().casefold()
    if wanted:
        exact = [item for item in candidates if str(item.get("name", "")).strip().casefold() == wanted]
        candidates = exact or [item for item in candidates
                               if wanted in str(item.get("name", "")).casefold()]
    if not candidates:
        return default_index
    priorities = ("windows wasapi", "windows wdm-ks", "windows directsound", "windows mme")
    def rank(item):
        hostapi = item.get("hostapi")
        name = str(hostapis[hostapi].get("name", "")).casefold() if isinstance(hostapi, int) and 0 <= hostapi < len(hostapis) and isinstance(hostapis[hostapi], dict) else ""
        try:
            return priorities.index(name)
        except ValueError:
            return len(priorities)
    selected = min(candidates, key=lambda item: (rank(item), int(item.get("index", 1 << 30))))
    return selected.get("index", default_index)


def resample_pcm16(chunk: bytes, source_rate: int, target_rate: int) -> bytes:
    if not isinstance(chunk, bytes) or len(chunk) % 2:
        raise ValueError("PCM16 chunk must contain complete samples")
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("audio sample rates must be positive")
    if source_rate == target_rate or not chunk:
        return chunk
    source = np.frombuffer(chunk, dtype="<i2").astype(np.float32)
    target_length = max(1, round(len(source) * target_rate / source_rate))
    target = np.interp(
        np.linspace(0, len(source) - 1, target_length),
        np.arange(len(source)), source,
    )
    return np.rint(np.clip(target, -32768, 32767)).astype("<i2").tobytes()


class WindowsPcmPlayback:
    """Small playback boundary. The real output stream is opened lazily."""

    def __init__(self, device_name: str = ""):
        self.device_name = device_name
        self._stream = None
        self.sample_rate = 16000

    async def start(self):
        if os.name != "nt":
            return
        try:
            import sounddevice as sd

            default_index = None
            try:
                default_index = sd.default.device[1]
            except (AttributeError, IndexError, TypeError):
                pass
            devices = sd.query_devices()
            index = choose_output_device(devices, sd.query_hostapis(), self.device_name, default_index)
            selected = next((item for item in devices if item.get("index") == index), None)
            if selected is None and isinstance(index, int) and 0 <= index < len(devices):
                selected = devices[index]
            self.sample_rate = max(1, round(float((selected or {}).get("default_samplerate", 16000))))
            kwargs = {"samplerate": self.sample_rate, "channels": 1, "dtype": "int16", "device": index}
            self._stream = sd.RawOutputStream(**kwargs)
            self._stream.start()
        except Exception as error:
            raise RuntimeError("Windows audio output could not be opened") from error

    async def play(self, chunk: bytes):
        if self._stream is not None:
            await asyncio.to_thread(self._stream.write, resample_pcm16(chunk, 16000, self.sample_rate))

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
