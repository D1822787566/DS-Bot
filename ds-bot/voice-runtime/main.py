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
    if not str(result.get("windowsWakeModelDir", "")).strip():
        candidates = [
            values.get("DS_BOT_WAKE_MODEL_DIR", ""),
            r"D:\phone_agent_runtime\rebuild\sherpa-kws\sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01",
        ]
        result["windowsWakeModelDir"] = next(
            (candidate for candidate in candidates
             if candidate and Path(candidate, "tokens.txt").is_file()), "")
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


def choose_input_device(devices, hostapis, configured_name: str = "", default_index=None):
    """Choose one Windows microphone endpoint, preferring WASAPI."""
    if not isinstance(devices, (list, tuple)):
        return default_index
    candidates = [item for item in devices if isinstance(item, dict)
                  and item.get("max_input_channels", 0) > 0]
    wanted = str(configured_name or "").strip().casefold()
    if wanted:
        exact = [item for item in candidates if str(item.get("name", "")).strip().casefold() == wanted]
        candidates = exact or [item for item in candidates if wanted in str(item.get("name", "")).casefold()]
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


class WindowsPcmCapture:
    """Capture mono microphone PCM from the selected Windows endpoint."""

    def __init__(self, device_name: str = "", *, sample_rate: int = 16000):
        self.device_name = device_name
        self.sample_rate = sample_rate
        self._stream = None
        self._loop = None
        self._chunks = None
        self.dropped_chunks = 0

    async def start(self):
        if os.name != "nt":
            raise RuntimeError("Windows microphone capture is only available on Windows")
        try:
            import sounddevice as sd
            self._loop = asyncio.get_running_loop()
            self._chunks = asyncio.Queue(maxsize=32)
            default_index = None
            try:
                default_index = sd.default.device[0]
            except (AttributeError, IndexError, TypeError):
                pass
            devices = sd.query_devices()
            index = choose_input_device(devices, sd.query_hostapis(), self.device_name, default_index)
            if index is None:
                raise RuntimeError("Windows microphone was not found")
            selected = next((item for item in devices if item.get("index") == index), None)
            if selected is None and isinstance(index, int) and 0 <= index < len(devices):
                selected = devices[index]
            self.sample_rate = max(1, round(float((selected or {}).get("default_samplerate", self.sample_rate))))

            def callback(indata, frames, time_info, status):
                del frames, time_info
                if status:
                    print(json.dumps({"type": "windows.audio.input_status", "status": str(status)}, ensure_ascii=False), flush=True)
                chunk = bytes(indata)
                try:
                    self._loop.call_soon_threadsafe(self._put_chunk, chunk)
                except RuntimeError:
                    return

            self._stream = sd.RawInputStream(samplerate=self.sample_rate, channels=1,
                                             dtype="int16", device=index,
                                             blocksize=max(160, self.sample_rate // 10),
                                             callback=callback)
            self._stream.start()
            print(json.dumps({"type": "windows.audio.input_ready", "device_index": index,
                              "sample_rate": self.sample_rate}, ensure_ascii=False), flush=True)
        except RuntimeError:
            raise
        except Exception as error:
            self._stream = None
            self._chunks = None
            raise RuntimeError("Windows microphone could not be opened") from error

    def _put_chunk(self, chunk):
        if self._chunks is None:
            return
        try:
            self._chunks.put_nowait(chunk)
        except asyncio.QueueFull:
            self.dropped_chunks += 1

    async def next_chunk(self):
        return await self._chunks.get()

    async def close(self):
        if self._stream is not None:
            await asyncio.to_thread(self._stream.stop)
            await asyncio.to_thread(self._stream.close)
            self._stream = None
        self._chunks = None


class WindowsWakeRuntime:
    def __init__(self, config, mapping, on_wake):
        from windows_wake import WindowsWakeDetector
        self.config = config
        self.mapping = mapping
        self.on_wake = on_wake
        self.capture = WindowsPcmCapture(str(config.get("inputDeviceName", "")))
        detector_config = {
            "windows_wake_model_dir": config.get("windowsWakeModelDir", ""),
            "windows_wake_keywords_score": config.get("windowsWakeKeywordsScore", 1.5),
            "windows_wake_keywords_threshold": config.get("windowsWakeKeywordsThreshold", .35),
            "windows_wake_cooldown_seconds": config.get("windowsWakeCooldownSeconds", 1.),
        }
        self.detector = WindowsWakeDetector(detector_config, mapping)
        self._closed = False

    async def start(self):
        """Open the microphone before the host reports the runtime as ready."""
        await self.capture.start()
        unsupported = self.detector.diagnostics_snapshot().get("unsupported_wake_names", [])
        if unsupported:
            print(json.dumps({"type": "windows.wake.unsupported_names",
                              "names": unsupported}, ensure_ascii=False), flush=True)

    async def run(self):
        try:
            while not self._closed:
                chunk = await self.capture.next_chunk()
                pcm = resample_pcm16(chunk, self.capture.sample_rate, 16000)
                hits = self.detector.process_pcm16(pcm)
                for hit in hits:
                    payload = self.detector.event_for_hit(hit)
                    if payload is not None:
                        print(json.dumps({"type": "windows.wake.published", **payload}, ensure_ascii=False), flush=True)
                        result = self.on_wake(payload)
                        if hasattr(result, "__await__"):
                            await result
        finally:
            await self.close()

    async def close(self):
        self._closed = True
        await self.capture.close()
        self.detector.close()


class VoiceRuntime:
    def __init__(self, bridge, tts, playback, *, device=None, config=None):
        self.bridge = bridge
        self.tts = tts
        self.playback = playback
        self.device = device
        self.config = dict(config or {})
        self.roles = None
        self.mapping = None
        self.responses: dict[str, dict] = {}
        self.state = "stopped"
        self.active_bot_id = None
        self.wake_runtime = None
        self.wake_task = None

    async def start(self):
        if self.device is not None:
            self.device.connect()
        await self.bridge.connect()
        roles_event = await self.bridge.subscribe_roles()
        self.roles = roles_event.payload if isinstance(roles_event, BridgeEvent) else roles_event
        self.mapping = WakeMapping.from_roster(self.roles)
        await self.playback.start()
        if self.config.get("windowsWakeEnabled", self.config.get("wakeEnabled", False)):
            self.wake_runtime = WindowsWakeRuntime(self.config, self.mapping, self._on_wake)
            await self.wake_runtime.start()
            self.wake_task = asyncio.create_task(self.wake_runtime.run())
        self.state = "listening"
        print(json.dumps({"type": "runtime.ready", "state": self.state,
                          "roles": list(self.mapping.roles)}, ensure_ascii=False), flush=True)
        return self.roles

    async def stop(self):
        self.state = "stopped"
        if self.wake_runtime is not None:
            await self.wake_runtime.close()
        if self.wake_task is not None:
            self.wake_task.cancel()
            await asyncio.gather(self.wake_task, return_exceptions=True)
            self.wake_task = None
            self.wake_runtime = None
        await self.playback.stop()
        await self.playback.close() if hasattr(self.playback, "close") else asyncio.sleep(0)
        await self.bridge.close()
        if self.device is not None:
            self.device.disconnect()

    async def _on_wake(self, payload):
        self.active_bot_id = payload.get("bot_id")
        print(json.dumps({"type": "runtime.wake", "bot_id": self.active_bot_id,
                          "wake_session_id": payload.get("wake_session_id")}, ensure_ascii=False), flush=True)

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
            if self.wake_runtime is not None:
                await self.wake_runtime.close()
                if self.wake_task is not None:
                    self.wake_task.cancel()
                    await asyncio.gather(self.wake_task, return_exceptions=True)
                self.wake_runtime = WindowsWakeRuntime(self.config, self.mapping, self._on_wake)
                await self.wake_runtime.start()
                self.wake_task = asyncio.create_task(self.wake_runtime.run())
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
        bridge_task = None
        try:
            while True:
                bridge_task = asyncio.create_task(self.bridge.next_event())
                waiters = {bridge_task}
                wake_task = self.wake_task
                if wake_task is not None:
                    waiters.add(wake_task)
                done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
                if wake_task is not None and wake_task in done:
                    if not wake_task.cancelled():
                        error = wake_task.exception()
                        if error is not None:
                            raise error
                    if self.state != "stopped":
                        raise RuntimeError("Windows wake runtime stopped unexpectedly")
                    return
                try:
                    event = bridge_task.result()
                except asyncio.TimeoutError:
                    # An idle voice session is healthy. Keep the Bridge connection
                    # alive until it reports a real protocol or transport error.
                    continue
                await self.handle_event(event)
        finally:
            if bridge_task is not None and not bridge_task.done():
                bridge_task.cancel()
                await asyncio.gather(bridge_task, return_exceptions=True)


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
    runtime = VoiceRuntime(bridge, make_tts(config), playback, device=device, config=config)
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
