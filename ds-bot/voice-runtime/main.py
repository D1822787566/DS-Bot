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
import sys
import time
from pathlib import Path
from typing import Mapping

import numpy as np

from bridge_client import BridgeClient, BridgeEvent
from wake_mapping import WakeMapping
from windows_adapter import WindowsDeviceAdapter
from speech_capture import PcmSegmenter, load_vad
from speech_models import SpeechFailure, load_speech_models
from voice_input import VoiceInput
from voice_output import VoiceOutput


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
        self.processing = None
        self._generation = 0
        self._resampler = None

    async def start(self):
        if os.name != "nt":
            return
        if self._stream is not None:
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
        stream, generation = self._stream, self._generation
        if stream is not None:
            if not isinstance(chunk, bytes) or len(chunk) % 2:
                raise ValueError("PCM16 chunk must contain complete samples")
            if self.sample_rate != 16000 and self._resampler is None:
                from livekit import rtc
                # Keep the filter and fractional sample position across both
                # provider chunks and writes. Restarting interpolation every
                # 100 ms distorts the waveform at each block boundary.
                self._resampler = rtc.AudioResampler(
                    16000, self.sample_rate, quality=rtc.AudioResamplerQuality.HIGH)
            for offset in range(0, len(chunk), 3200):
                if self._stream is not stream or generation != self._generation:
                    return
                part = chunk[offset:offset + 3200]
                if self.processing is not None:
                    self.processing.render(part)
                if self._resampler is not None:
                    part = b''.join(bytes(frame.data) for frame in self._resampler.push(bytearray(part)))
                await self._write(part, stream, generation)

    async def _write(self, pcm, stream, generation):
        block_bytes = max(2, self.sample_rate // 10 * 2)
        for offset in range(0, len(pcm), block_bytes):
            if self._stream is not stream or generation != self._generation:
                return
            await asyncio.to_thread(stream.write, pcm[offset:offset + block_bytes])

    async def stop(self):
        self._generation += 1
        self._resampler = None  # Interrupted audio must never be flushed later.
        stream, self._stream = self._stream, None
        if stream is not None:
            await asyncio.to_thread(stream.abort)
            await asyncio.to_thread(stream.close)

    async def drain(self):
        stream, generation = self._stream, self._generation
        if stream is not None:
            resampler, self._resampler = self._resampler, None
            if resampler is not None:
                tail = b''.join(bytes(frame.data) for frame in resampler.flush())
                await self._write(tail, stream, generation)
            if self._stream is not stream or generation != self._generation:
                return
            try:
                await asyncio.to_thread(stream.stop)
            finally:
                if self._stream is stream:
                    self._stream = None
                await asyncio.to_thread(stream.close)

    async def close(self):
        await self.stop()


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
            "active_role_wake_enabled": True,
            "windows_wake_model_dir": config.get("windowsWakeModelDir", ""),
            "windows_wake_keywords_score": config.get("windowsWakeKeywordsScore", 1.5),
            "windows_wake_keywords_threshold": config.get("windowsWakeKeywordsThreshold", .35),
            "windows_wake_cooldown_seconds": config.get("windowsWakeCooldownSeconds", 1.),
        }
        self.detector = WindowsWakeDetector(detector_config, mapping)
        self._closed = False
        self.on_pcm = self.on_gap = None
        self.processing = None

    async def start(self):
        """Open the microphone before the host reports the runtime as ready."""
        await self.capture.start()
        unsupported = self.detector.diagnostics_snapshot().get("unsupported_wake_names", [])
        if unsupported:
            print(json.dumps({"type": "windows.wake.unsupported_names",
                              "names": unsupported}, ensure_ascii=False), flush=True)

    async def run(self):
        frames = 0
        samples = 0
        peak = 0
        next_report = 0.0
        last_dropped = 0
        try:
            while not self._closed:
                chunk = await self.capture.next_chunk()
                pcm = resample_pcm16(chunk, self.capture.sample_rate, 16000)
                if self.capture.dropped_chunks != last_dropped:
                    last_dropped = self.capture.dropped_chunks
                    if self.on_gap:
                        self.on_gap()
                if self.processing is not None:
                    pcm = self.processing.capture(pcm)
                values = np.frombuffer(pcm, dtype="<i2")
                frames += 1
                samples += len(values)
                peak = max(peak, int(np.max(np.abs(values.astype(np.int32)), initial=0)))
                hits = self.detector.process_pcm16(pcm)
                for hit in hits:
                    payload = self.detector.event_for_hit(hit)
                    if payload is not None:
                        print(json.dumps({"type": "windows.wake.published", **payload}, ensure_ascii=False), flush=True)
                        result = self.on_wake(payload)
                        if hasattr(result, "__await__"):
                            await result
                # Do not feed the wake-word chunk into the command segment.
                # The next microphone chunk begins the post-wake utterance.
                if self.on_pcm is not None and not hits:
                    self.on_pcm(pcm)
                now = time.monotonic()
                if now >= next_report:
                    print(json.dumps({"type": "windows.wake.audio", "frames": frames,
                                      "samples": samples, "peak": peak,
                                      "wake_diagnostics": self.detector.diagnostics_snapshot()},
                                     ensure_ascii=False), flush=True)
                    peak = 0
                    next_report = now + 5.0
        finally:
            await self.close()

    async def close(self):
        self._closed = True
        await self.capture.close()
        self.detector.close()


class VoiceRuntime:
    def __init__(self, bridge, tts, playback, *, device=None, config=None,
                 models=None, vad=None, continuation_evaluator=None):
        self.bridge, self.tts, self.playback = bridge, tts, playback
        self.device, self.config = device, dict(config or {})
        self.models, self.vad = models, vad
        self.evaluator = continuation_evaluator
        self.input = self.segmenter = self.processing = None
        self.roles = self.mapping = None
        self.state, self.active_bot_id = "stopped", None
        self.wake_runtime = self.wake_task = None
        self._controls = set()
        self._wake_confirmation = None
        self._closing = False
        self.output = VoiceOutput(
            bridge, tts, playback,
            owns=lambda correlation: self.input.owns_output(correlation) if self.input else True,
            generated=lambda c, text: self.input.reply_generated(c, text) if self.input else None,
            finished=lambda c, text: self.input.reply_finished(c, text) if self.input else None,
            notify=self.record)
        self.output.aborted = lambda c, reason='output_aborted': self.input.abort_input(c, reason=reason) if self.input else None

    def record(self, kind, **fields):
        if kind in ("runtime.state", "runtime.ready") and fields.get("state"):
            self.state = fields["state"]
        if kind == "runtime.wake":
            self.active_bot_id = fields.get("bot_id")
        print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self._controls.add(task)
        def finished(value):
            self._controls.discard(value)
            if not value.cancelled() and value.exception() is not None and not self._closing:
                self.record("runtime.state", state="error", stage="bridge",
                            error_code="voice_control_failed")
        task.add_done_callback(finished)
        return task

    def _roles_changed(self, payload):
        if payload == self.roles:
            return
        self.roles = payload
        self.active_bot_id = None
        if self.input:
            self.input.invalidate()
        if self.segmenter:
            self.segmenter.reset()
        if self._closing:
            return
        self._spawn(self.output.interrupt())
        if payload is None:
            self.mapping = WakeMapping("disconnected", {})
            self.record("runtime.state", state="paused", stage="bridge_reconnecting",
                        error_code="bridge_disconnected")
        else:
            self.mapping = WakeMapping.from_roster(payload)
            source = getattr(getattr(self.models, "transcribe", None), "__self__", None)
            if source is not None and hasattr(source, "hotwords"):
                source.hotwords = self.mapping.all_names()
        detector = getattr(self.wake_runtime, "detector", None)
        if detector is not None:
            try:
                detector.update_mapping(self.mapping)
            except (ValueError, RuntimeError):
                self.record("runtime.state", state="error", stage="wake_mapping",
                            error_code="unsupported_wake_names")

    def _make_evaluator(self):
        if self.evaluator is not None or not self.config.get("continuationEnabled", True):
            return
        if self.config.get("continuationUrl"):
            from continuation_http import ContinuationHttpEvaluator
            self.evaluator = ContinuationHttpEvaluator(
                self.config["continuationUrl"], model=self.config.get("continuationModel", ""),
                mode=self.config.get("continuationMode", "legacy_nli"),
                timeout=self.config.get("continuationTimeout", 2.),
                api_key=os.environ.get("DS_BOT_CONTINUATION_API_KEY"))
        else:
            from continuation_service import ManagedContinuationEvaluator
            path = os.environ.get("DS_BOT_CONTINUATION_CONFIG", "")
            if not path:
                raise SpeechFailure("continuation_not_configured")
            self.evaluator = ManagedContinuationEvaluator(
                path, timeout=self.config.get("continuationTimeout", 2.))

    async def start(self):
        self.state = "starting"
        self.bridge.on_roles_changed = self._roles_changed
        if self.device is not None:
            self.device.connect()
        self.record("runtime.progress", stage="bridge_connecting")
        await self.bridge.connect()
        roles_event = await self.bridge.subscribe_roles()
        self.roles = roles_event.payload if isinstance(roles_event, BridgeEvent) else roles_event
        self.mapping = WakeMapping.from_roster(self.roles)
        if self.config.get("windowsWakeEnabled", self.config.get("wakeEnabled", False)):
            self.record("runtime.progress", stage="models_loading")
            if self.models is None:
                self.models = await asyncio.to_thread(load_speech_models, self.config, self.mapping.all_names())
            self._make_evaluator()
            self.record("runtime.progress", stage="vad_loading")
            if self.vad is None:
                # LiveKit plugin registration must happen on the event-loop thread.
                self.vad = load_vad()
            self.segmenter = PcmSegmenter(self.vad, notify=self._audio_event)
            if isinstance(self.playback, WindowsPcmPlayback):
                from audio_processing import WindowsAudioProcessing
                self.processing = WindowsAudioProcessing()
                self.playback.processing = self.processing
            self.input = VoiceInput(
                self.bridge, self.models, config=self.config, evaluator=self.evaluator,
                notify=self.record, interrupt=self.output.interrupt, clarify=self._clarify)
            self.record("runtime.progress", stage="audio_opening")
            self.wake_runtime = WindowsWakeRuntime(self.config, self.mapping, self._on_wake)
            self.wake_runtime.on_pcm, self.wake_runtime.on_gap = self._on_pcm, self._audio_gap
            self.wake_runtime.processing = self.processing
            await self.wake_runtime.start()
            self.wake_task = asyncio.create_task(self.wake_runtime.run())
        await self.playback.start()
        self.record("runtime.ready", state="listening", stage="listening")
        return self.roles

    def _audio_event(self, kind, **fields):
        if self.input and self.input.lease:
            self.record(kind, **fields)
            if kind == "audio.segment.started":
                self.record("runtime.state", state="listening", stage="capturing",
                            result="processing", error_code="")

    def _audio_gap(self):
        if self.segmenter:
            self.segmenter.reset()
        if self.input:
            self.input.invalidate()
        self._spawn(self.output.interrupt())
        self.record("runtime.state", state="listening", stage="waiting_for_wake",
                    result="audio_gap", error_code="audio_gap")

    def _on_pcm(self, pcm):
        if self.segmenter:
            for segment in self.segmenter.feed(pcm, now=time.monotonic()):
                self.input.offer(segment)

    async def _on_wake(self, payload):
        if self.input is None:
            # Standalone protocol diagnostics never create verified Bot input.
            publisher = getattr(self.bridge, "publish_wake", None)
            if callable(publisher):
                await publisher(payload)
            self.record("runtime.wake", bot_id=payload.get("bot_id"),
                        wake_session_id=payload.get("wake_session_id"))
            return
        if not self.roles:
            return
        if self.segmenter:
            self.segmenter.reset()
        if self.input:
            self.input.invalidate()
        await self.output.interrupt()
        lease = self.input.stage_wake(payload, self.roles)
        if lease:
            if self._wake_confirmation and not self._wake_confirmation.done():
                self._wake_confirmation.cancel()
            self._wake_confirmation = self._spawn(self.input.confirm_wake(lease, payload))

    async def _clarify(self, text, bot_id):
        role = next((item for item in (self.roles or {}).get("roles", []) if item["bot_id"] == bot_id), {})
        await self.output.say(text, voice=role.get("tts_voice") or self.config.get("ttsVoice"))

    async def handle_event(self, event):
        value = event.raw if isinstance(event, BridgeEvent) else event
        if value.get("type") in ("roles.snapshot.result", "roles.changed"):
            self._roles_changed(value.get("payload"))
        elif value.get("type", "").startswith("output."):
            await self.output.handle(event)
        elif value.get("type") == "bridge.error":
            self.record("runtime.state", state="listening", stage="bridge",
                        error_code="bridge_request_rejected")

    async def _reconnect(self):
        self._roles_changed(None)
        await self.output.interrupt()
        while not self._closing:
            if self.wake_task and self.wake_task.done():
                self.wake_task.result()
                raise RuntimeError("Windows wake runtime stopped unexpectedly")
            try:
                await self.bridge.reconnect()
                roles = await self.bridge.subscribe_roles()
                self._roles_changed(roles.payload)
                self.record("runtime.state", state="listening", stage="waiting_for_wake",
                            result="bridge_reconnected", error_code="")
                return
            except (ConnectionError, OSError, TimeoutError):
                await asyncio.sleep(1.)

    async def run(self):
        await self.start()
        bridge_task = None
        try:
            while not self._closing:
                bridge_task = asyncio.create_task(self.bridge.next_event())
                waiters = {bridge_task}
                if self.wake_task:
                    waiters.add(self.wake_task)
                done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
                if self.wake_task in done:
                    self.wake_task.result()
                    if self.state != "stopped":
                        raise RuntimeError("Windows wake runtime stopped unexpectedly")
                    return
                try:
                    event = bridge_task.result()
                except asyncio.TimeoutError:
                    continue
                except ConnectionError:
                    await self._reconnect()
                    continue
                await self.handle_event(event)
        finally:
            if bridge_task is not None and not bridge_task.done():
                bridge_task.cancel()
                await asyncio.gather(bridge_task, return_exceptions=True)

    async def stop(self):
        self._closing = True
        self.state = "stopped"
        if self.input:
            await self.input.close()
        for task in list(self._controls):
            task.cancel()
        await asyncio.gather(*list(self._controls), return_exceptions=True)
        await self.output.close()
        if self.wake_task:
            self.wake_task.cancel()
            await asyncio.gather(self.wake_task, return_exceptions=True)
        if self.wake_runtime:
            await self.wake_runtime.close()
        await self.playback.stop()
        closer = getattr(self.playback, "close", None)
        if closer:
            await closer()
        await self.bridge.close()
        if self.evaluator and hasattr(self.evaluator, "aclose"):
            await self.evaluator.aclose()
        if self.device:
            self.device.disconnect()

def make_tts(config: Mapping[str, object]):
    config_path = config.get("ttsConfigPath")
    if not isinstance(config_path, str) or not config_path.strip():
        raise SpeechFailure('tts_not_configured')
    from retained_tts import RetainedTTS

    try:
        result = RetainedTTS(config_path)
    except (OSError, ValueError):
        raise SpeechFailure('tts_configuration_invalid') from None
    result.voice = str(config.get('ttsVoice') or result.voice)
    result.model = str(config.get('ttsModel') or result.model)
    return result


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
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    config = runtime_config_from_env()
    if args.config:
        config.update(json.loads(args.config.read_text(encoding="utf-8")))
    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        code = str(error) if isinstance(error, SpeechFailure) else 'voice_runtime_failed'
        print(json.dumps({'type': 'runtime.state', 'state': 'error', 'stage': 'startup',
                          'error_code': code}), flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
