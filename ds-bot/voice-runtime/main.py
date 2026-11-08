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
    diagnostic_command = values.get("DS_BOT_VOICE_DIAGNOSTICS_COMMAND", "").strip()
    if diagnostic_command:
        result["diagnosticCommandPath"] = diagnostic_command
    if not str(result.get("windowsWakeModelDir", "")).strip():
        candidates = [
            values.get("DS_BOT_WAKE_MODEL_DIR", ""),
            r"D:\phone_agent_runtime\rebuild\sherpa-kws\sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01",
        ]
        result["windowsWakeModelDir"] = next(
            (candidate for candidate in candidates
             if candidate and Path(candidate, "tokens.txt").is_file()), "")
    return result


DIAGNOSTIC_COMMANDS = {'voiceprint', 'voiceprint_label', 'voiceprint_apply', 'voiceprint_discard', 'asr_test', 'tts_test', 'full_chain_test'}


def read_diagnostic_request(path):
    if not path:
        return None
    path = Path(path)
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
        path.unlink(missing_ok=True)
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or payload.get('mode') not in DIAGNOSTIC_COMMANDS:
        return None
    request = {'mode': payload['mode']}
    if isinstance(payload.get('segment_id'), int) and payload['segment_id'] >= 0:
        request['segment_id'] = payload['segment_id']
    if payload['mode'] == 'tts_test':
        text = payload.get('text')
        if isinstance(text, str) and text.strip():
            request['text'] = text.strip()[:1000]
        voice = payload.get('voice')
        if isinstance(voice, str) and voice.strip():
            request['voice'] = voice.strip()[:120]
    return request


def read_voiceprint_request(path):
    request = read_diagnostic_request(path)
    return request if request and request['mode'].startswith('voiceprint') else None


def read_voiceprint_command(path):
    request = read_voiceprint_request(path)
    return request['mode'] if request and request['mode'] == 'voiceprint' else None


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
    resampler = StreamingPcm16Resampler(source_rate, target_rate)
    return resampler.push(chunk) + resampler.flush()


class StreamingPcm16Resampler:
    """Keep sample phase across microphone chunks during rate conversion."""

    def __init__(self, source_rate: int, target_rate: int):
        if source_rate <= 0 or target_rate <= 0:
            raise ValueError("audio sample rates must be positive")
        self.source_rate = int(source_rate)
        self.target_rate = int(target_rate)
        self._step = self.source_rate / self.target_rate
        self._buffer = np.empty(0, dtype=np.float64)
        self._base_index = 0
        self._input_count = 0
        self._output_count = 0

    def push(self, chunk: bytes) -> bytes:
        if not isinstance(chunk, bytes) or len(chunk) % 2:
            raise ValueError("PCM16 chunk must contain complete samples")
        if not chunk:
            return b''
        if self.source_rate == self.target_rate:
            self._input_count += len(chunk) // 2
            self._output_count = self._input_count
            return chunk
        values = np.frombuffer(chunk, dtype='<i2').astype(np.float64)
        self._buffer = np.concatenate((self._buffer, values))
        self._input_count += len(values)
        result = self._available(final=False)
        self._compact()
        return self._encode(result)

    def flush(self) -> bytes:
        if self.source_rate == self.target_rate or self._input_count == 0:
            return b''
        result = self._available(final=True)
        self._compact()
        return self._encode(result)

    def _available(self, *, final: bool):
        target_count = round(self._input_count * self.target_rate / self.source_rate) if final else None
        values = []
        while target_count is None or self._output_count < target_count:
            position = self._output_count * self._step
            if not final and position + 1 >= self._input_count:
                break
            values.append(self._sample(position))
            self._output_count += 1
        return values

    def _sample(self, position):
        local = max(0., position - self._base_index)
        index = int(local)
        fraction = local - index
        if index >= len(self._buffer) - 1:
            return float(self._buffer[-1])
        return float(self._buffer[index] * (1. - fraction) + self._buffer[index + 1] * fraction)

    def _compact(self):
        if not len(self._buffer):
            return
        keep_from = max(self._base_index,
                        int(self._output_count * self._step) - 1)
        if keep_from <= self._base_index:
            return
        offset = keep_from - self._base_index
        self._buffer = self._buffer[offset:]
        self._base_index = keep_from

    @staticmethod
    def _encode(values):
        if not values:
            return b''
        return np.rint(np.clip(np.asarray(values), -32768, 32767)).astype('<i2').tobytes()


class WindowsPcmPlayback:
    """Small playback boundary. The real output stream is opened lazily."""

    def __init__(self, device_name: str = ""):
        self.device_name = device_name
        self._media_devices = None
        self._player = None
        self._source = None
        self._track = None
        self.sample_rate = 16000
        self.processing = None
        self._generation = 0

    async def start(self):
        if os.name != "nt":
            return
        if self._player is not None:
            return
        try:
            import sounddevice as sd
            from livekit import rtc

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
            media_devices = rtc.MediaDevices(
                input_sample_rate=self.sample_rate,
                output_sample_rate=self.sample_rate,
                num_channels=1,
            )
            player = media_devices.open_output(output_device=index)
            source = rtc.AudioSource(16000, 1)
            track = rtc.LocalAudioTrack.create_audio_track("dsbot-tts", source)
            await player.add_track(track)
            await player.start()
            self._media_devices = media_devices
            self._player, self._source, self._track = player, source, track
        except Exception as error:
            raise RuntimeError("Windows audio output could not be opened") from error

    async def play(self, chunk: bytes):
        source, generation = self._source, self._generation
        if source is not None:
            if not isinstance(chunk, bytes) or len(chunk) % 2:
                raise ValueError("PCM16 chunk must contain complete samples")
            from livekit import rtc
            for offset in range(0, len(chunk), 640):
                if self._source is not source or generation != self._generation:
                    return
                part = chunk[offset:offset + 640]
                if not part:
                    continue
                await source.capture_frame(rtc.AudioFrame(
                    data=part, sample_rate=16000, num_channels=1,
                    samples_per_channel=len(part) // 2))

    async def stop(self):
        self._generation += 1
        player, source = self._player, self._source
        self._media_devices = self._player = self._source = self._track = None
        if source is not None:
            await source.aclose()
        if player is not None:
            await player.aclose()

    async def drain(self):
        player, source, generation = self._player, self._source, self._generation
        if player is None or source is None:
            return
        await source.wait_for_playout()
        if self._player is not player or generation != self._generation:
            return
        await self._wait_for_native_buffer(player)
        self._generation += 1
        self._media_devices = self._player = self._source = self._track = None
        await source.aclose()
        await player.aclose()

    async def _wait_for_native_buffer(self, player):
        """Let OutputPlayer's device callback consume its final buffered block."""
        if not hasattr(player, "_buffer"):
            return
        sample_rate = max(1, int(getattr(player, "_sample_rate", self.sample_rate)))
        blocksize = max(1, int(getattr(player, "_blocksize", sample_rate // 10)))
        block_duration = blocksize / sample_rate
        interval = min(.01, max(.002, block_duration / 10))
        deadline = time.monotonic() + max(.5, block_duration * 4)
        empty_for = 0.0
        while time.monotonic() < deadline:
            if len(player._buffer):
                empty_for = 0.0
            else:
                empty_for += interval
                if empty_for >= block_duration:
                    return
            await asyncio.sleep(interval)

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
        self.resampler = None

    async def start(self):
        """Open the microphone before the host reports the runtime as ready."""
        await self.capture.start()
        self.resampler = StreamingPcm16Resampler(self.capture.sample_rate, 16000)
        unsupported = self.detector.diagnostics_snapshot().get("unsupported_wake_names", [])
        if unsupported:
            print(json.dumps({"type": "windows.wake.unsupported_names",
                              "names": unsupported}, ensure_ascii=False), flush=True)

    async def run(self):
        frames = 0
        samples = 0
        peak = 0
        energy = 0.0
        energy_samples = 0
        next_report = 0.0
        last_dropped = 0
        try:
            while not self._closed:
                chunk = await self.capture.next_chunk()
                if (getattr(self, 'resampler', None) is None
                        or self.resampler.source_rate != self.capture.sample_rate):
                    self.resampler = StreamingPcm16Resampler(self.capture.sample_rate, 16000)
                pcm = self.resampler.push(chunk)
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
                normalized = values.astype(np.float64) / 32768.0
                energy += float(np.dot(normalized, normalized))
                energy_samples += len(values)
                hits = self.detector.process_pcm16(pcm)
                for hit in hits:
                    payload = self.detector.event_for_hit(hit)
                    if payload is not None:
                        print(json.dumps({"type": "windows.wake.published", **payload}, ensure_ascii=False), flush=True)
                        result = self.on_wake(payload)
                        if hasattr(result, "__await__"):
                            await result
                # Keep the detector chunk in the bounded command segment. A
                # user can say the wake word and the request in one chunk;
                # the full ASR transcript remains available to the Bot.
                if self.on_pcm is not None:
                    self.on_pcm(pcm)
                now = time.monotonic()
                if now >= next_report:
                    print(json.dumps({"type": "windows.wake.audio", "frames": frames,
                                      "samples": samples, "peak": peak,
                                      "rms": (energy / max(1, energy_samples)) ** .5,
                                      "dropped_chunks": self.capture.dropped_chunks,
                                      "wake_diagnostics": self.detector.diagnostics_snapshot()},
                                     ensure_ascii=False), flush=True)
                    peak = 0
                    energy = 0.0
                    energy_samples = 0
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
        self._voiceprint_mode = False
        self._voiceprint_started_at = 0.0
        self._voiceprint_candidate = None
        self._asr_test_mode = False
        self._asr_test_started_at = 0.0
        self._full_chain_mode = False
        self._full_chain_started_at = 0.0
        self._full_chain_wake = False
        self._full_chain_bot_id = None
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
            if hasattr(self.models, 'profile_status'):
                status = self.models.profile_status()
                self.record('voice.profile.status',
                            pending_samples=status.get('pending_samples', 0),
                            approved_samples=status.get('approved_samples', 0))
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
            self._poll_diagnostic_command()
            for segment in self.segmenter.feed(pcm, now=time.monotonic()):
                if self._asr_test_mode:
                    self._asr_test_mode = False
                    self._spawn(self._run_asr_test(segment))
                elif self._full_chain_mode and self._full_chain_wake:
                    self._full_chain_mode = False
                    self._full_chain_wake = False
                    self._spawn(self._run_full_chain_test(segment))
                elif self._voiceprint_mode:
                    self._voiceprint_mode = False
                    self._spawn(self._run_voiceprint_test(segment))
                elif self.input:
                    self.input.offer(segment)

    def _poll_diagnostic_command(self):
        if self._asr_test_mode and time.monotonic() - self._asr_test_started_at > 20:
            self._asr_test_mode = False
            self.record('asr.test.completed', result='timeout')
        if self._full_chain_mode and time.monotonic() - self._full_chain_started_at > 20:
            self._full_chain_mode = False
            self._full_chain_wake = False
            self.record('full_chain.test.completed', result='timeout')
        if self._voiceprint_mode and time.monotonic() - self._voiceprint_started_at > 20:
            self._voiceprint_mode = False
            self._voiceprint_candidate = None
            self.record('voice.test.completed', result='timeout')
        request = read_diagnostic_request(self.config.get('diagnosticCommandPath', ''))
        if not request:
            return
        mode = request['mode']
        if mode == 'asr_test':
            self._voiceprint_mode = False
            self._full_chain_mode = False
            self._full_chain_wake = False
            self._asr_test_mode = True
            self._asr_test_started_at = time.monotonic()
            self.record('asr.test.ready', result='speak_now')
            return
        if mode == 'tts_test':
            self._spawn(self._run_tts_test(request.get('text') or '这是语音测试。', request.get('voice') or self.config.get('ttsVoice')))
            return
        if mode == 'full_chain_test':
            self._asr_test_mode = False
            self._voiceprint_mode = False
            self._full_chain_mode = True
            self._full_chain_wake = False
            self._full_chain_started_at = time.monotonic()
            self._full_chain_bot_id = None
            self.record('full_chain.test.ready', result='say_wake_word')
            return
        if mode == 'voiceprint':
            self._asr_test_mode = False
            self._full_chain_mode = False
            self._full_chain_wake = False
            self._voiceprint_mode = True
            self._voiceprint_started_at = time.monotonic()
            self._voiceprint_candidate = None
            self.record('voice.test.ready', result='speak_now')
            return
        if mode == 'voiceprint_label':
            candidate = self._voiceprint_candidate
            requested_segment = request.get('segment_id')
            if candidate is None or requested_segment != candidate.get('segment_id'):
                self.record('voice.sample.label_rejected', segment_id=requested_segment,
                            error_code='voiceprint_candidate_missing')
                return
            try:
                status = self.models.label_profile_sample(candidate)
            except (SpeechFailure, ValueError, OSError):
                self.record('voice.sample.label_rejected', segment_id=requested_segment,
                            error_code='voiceprint_sample_save_failed')
                return
            self._voiceprint_candidate = None
            self.record('voice.sample.labeled', segment_id=requested_segment,
                        pending_samples=status.get('pending_samples', 0),
                        approved_samples=status.get('approved_samples', 0))
            return
        if mode == 'voiceprint_apply':
            try:
                status = self.models.apply_profile_samples()
            except (SpeechFailure, ValueError, OSError):
                self.record('voice.sample.apply_rejected', error_code='voiceprint_sample_apply_failed')
                return
            self.record('voice.sample.applied', pending_samples=status.get('pending_samples', 0),
                        approved_samples=status.get('approved_samples', 0))
            return
        if mode == 'voiceprint_discard':
            try:
                status = self.models.discard_profile_samples()
            except (SpeechFailure, ValueError, OSError):
                self.record('voice.sample.discard_rejected', error_code='voiceprint_sample_discard_failed')
                return
            self.record('voice.sample.discarded', pending_samples=status.get('pending_samples', 0),
                        approved_samples=status.get('approved_samples', 0))

    # Kept as a narrow compatibility alias for callers that only know the
    # original voiceprint diagnostic command.
    def _poll_voiceprint_command(self):
        return self._poll_diagnostic_command()

    async def _run_asr_test(self, segment):
        started = time.monotonic()
        self.record('asr.test.started', segment_id=segment.segment_id)
        try:
            text = await self.models.transcribe_only(segment)
        except SpeechFailure as error:
            self.record('asr.test.completed', segment_id=segment.segment_id, result='failed',
                        error_code=str(error), duration_ms=round(max(0., time.monotonic() - started) * 1000, 3))
            return
        self.record('asr.test.completed', segment_id=segment.segment_id, result='completed',
                    transcript=text, characters=len(text),
                    duration_ms=round(max(0., time.monotonic() - started) * 1000, 3))

    async def _run_tts_test(self, text, voice):
        self.record('tts.test.started')
        try:
            await self.output.say(text, voice=voice)
        except Exception:
            self.record('tts.test.completed', result='failed', error_code='tts_playback_failed')
            return
        self.record('tts.test.completed', result='completed')

    async def _run_full_chain_test(self, segment):
        started = time.monotonic()
        self.record('full_chain.test.stage', stage='asr_and_owner')
        try:
            _text, owner = await self.models.recognize(segment)
        except SpeechFailure as error:
            self.record('full_chain.test.completed', result='failed', error_code=str(error),
                        duration_ms=round(max(0., time.monotonic() - started) * 1000, 3))
            return
        if owner.identity != 'owner' or owner.status != 'verified':
            self.record('full_chain.test.completed', result='owner_rejected', score=owner.score,
                        duration_ms=round(max(0., time.monotonic() - started) * 1000, 3))
            return
        self.record('full_chain.test.stage', stage='tts_playback')
        role = next((item for item in (self.roles or {}).get('roles', [])
                     if item.get('bot_id') == self._full_chain_bot_id), {})
        try:
            await self.output.say('语音链路测试完成。', voice=role.get('tts_voice') or self.config.get('ttsVoice'))
        except Exception:
            self.record('full_chain.test.completed', result='failed', error_code='tts_playback_failed')
            return
        self.record('full_chain.test.completed', result='completed', submitted=False,
                    duration_ms=round(max(0., time.monotonic() - started) * 1000, 3))

    async def _run_voiceprint_test(self, segment):
        started = time.monotonic()
        try:
            text, owner = await self.models.recognize(segment)
        except SpeechFailure as error:
            error_code = str(error)
            failure_kind = 'owner.failed' if error_code.startswith('speaker') else 'asr.failed'
            self.record(failure_kind, segment_id=segment.segment_id, error_code=error_code,
                        duration_ms=round(max(0., time.monotonic() - started) * 1000, 3))
            self.record('voice.test.completed', segment_id=segment.segment_id, result='failed')
            return
        verified = owner.identity == 'owner' and owner.status == 'verified'
        event = 'identity.verified' if verified else 'identity.rejected'
        self.record(event, segment_id=segment.segment_id, score=owner.score, status=owner.status)
        embedding = getattr(owner, 'embedding', None)
        samples = np.asarray(segment.samples, dtype=np.float32)
        quality_ok = (samples.ndim == 1 and samples.size >= 8000 and np.all(np.isfinite(samples))
                      and float(np.max(np.abs(samples))) >= .01)
        labelable = (embedding is not None and owner.segment_id == segment.segment_id
                     and bool(owner.model_id) and quality_ok)
        self._voiceprint_candidate = ({
            'sample_id': f'voice-test-{segment.segment_id}', 'segment_id': segment.segment_id,
            'score': owner.score, 'embedding': embedding,
        } if labelable else None)
        if verified and isinstance(text, str) and text.strip():
            self.record('asr.completed', segment_id=segment.segment_id, characters=len(text),
                        duration_ms=round(max(0., time.monotonic() - started) * 1000, 3))
        status = self.models.profile_status() if hasattr(self.models, 'profile_status') else {}
        self.record('voice.test.completed', segment_id=segment.segment_id,
                    result='owner_verified' if verified else 'owner_rejected', labelable=labelable,
                    **{key: status[key] for key in ('pending_samples', 'approved_samples') if key in status})

    async def _on_wake(self, payload):
        if self._full_chain_mode:
            self._full_chain_wake = True
            self._full_chain_bot_id = payload.get('bot_id')
            if self.segmenter:
                self.segmenter.reset()
            self.record('full_chain.test.wake', bot_id=payload.get('bot_id'))
            return
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
