"""Local acoustic candidates; the Bridge alone binds the target role.

The detector is device-agnostic. The managed Windows runtime feeds it PCM from
the selected microphone, while the legacy LiveKit adapter feeds it an audio
track. It never changes microphone publication or playback state.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from threading import Lock
import time
from uuid import uuid4

import numpy as np
from wake_mapping import WakeMapping


SAMPLE_RATE = 16000
_MODEL_FILES = {
    'tokens': 'tokens.txt',
    'encoder': 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'decoder': 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    'joiner': 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
}


@dataclass(frozen=True)
class KeywordTable:
    keywords: str
    bot_by_keyword: dict[str, str]
    unsupported: tuple[tuple[str, str], ...] = ()


def build_keyword_table(mapping, tokens_path, *, strict=True):
    """Encode WenetSpeech partial pinyin without guessed aliases.

    Strict callers reject unsupported names. The runtime may keep supported Bot
    names active while returning unsupported names in the table diagnostics.
    """
    from pypinyin import pinyin
    from pypinyin.contrib.tone_convert import to_finals_tone, to_initials

    if not mapping.roles:
        raise ValueError('empty_wake_mapping')
    vocabulary = {line.split()[0] for line in Path(tokens_path).read_text(encoding='utf-8').splitlines()
                  if line.strip()}
    lines = []
    bots = {}
    pronunciations = {}
    unsupported = []
    for bot_id, names in mapping.roles.items():
        for name in names:
            if re.fullmatch(r'[\u4e00-\u9fff]+', name) is None:
                unsupported.append((bot_id, name))
                continue
            # Match sherpa_onnx.text2token(tokens_type='ppinyin').
            pieces = []
            for syllable in pinyin(name):
                initial = to_initials(syllable[0], strict=False)
                final = to_finals_tone(syllable[0], strict=False)
                pieces.extend(piece for piece in (initial, final) if piece)
            if not pieces or any(piece not in vocabulary for piece in pieces):
                unsupported.append((bot_id, name))
                continue
            pronunciation = tuple(pieces)
            if pronunciation in pronunciations:
                if pronunciations[pronunciation] != bot_id:
                    raise ValueError('ambiguous_wake_names')
                continue
            pronunciations[pronunciation] = bot_id
            keyword = f'wake_{len(lines)}'
            bots[keyword] = bot_id
            lines.append(f'{" ".join(pieces)} @{keyword}')
    if strict and unsupported:
        raise ValueError('unsupported_wake_name')
    if not lines:
        raise ValueError('unsupported_wake_name')
    return KeywordTable('/'.join(lines), bots, tuple(unsupported))


@dataclass(frozen=True)
class WakeHit:
    wake_session_id: str
    bot_id: str
    mapping_version: str
    generation: int
    sequence: int


def _number(config, name, default, *, minimum=0., maximum=None):
    value = config.get(name, default)
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < minimum
            or (maximum is not None and value > maximum)):
        raise ValueError(f'invalid_{name}')
    return float(value)


class SpeechBoundary:
    """Reuse Silero's defaults to retire a completed utterance's KWS state."""

    def __init__(self, *, model=None):
        if model is None:
            try:
                from livekit.plugins.silero import onnx_model
                model = onnx_model.OnnxModel(
                    onnx_session=onnx_model.new_inference_session(force_cpu=True),
                    sample_rate=SAMPLE_RATE)
            except ImportError:
                model = _EnergyBoundaryModel()
        self.model = model
        self.reset()

    def reset(self):
        self._pending = np.empty(0, dtype=np.float32)
        self._speech = self._silence = 0
        self._active = False
        self.model.reset()

    def process(self, samples):
        self._pending = np.concatenate((self._pending, samples))
        window = self.model.window_size_samples
        ended = False
        while len(self._pending) >= window:
            probability = float(self.model(self._pending[:window]))
            self._pending = self._pending[window:]
            if not math.isfinite(probability):
                raise ValueError('invalid_wake_vad_probability')
            if probability >= .5:
                self._speech += window
                self._silence = 0
                self._active = self._active or self._speech >= .05 * SAMPLE_RATE
            elif probability < .35:
                if self._active:
                    self._silence += window
                    if self._silence >= .55 * SAMPLE_RATE:
                        ended = True
                        self._speech = self._silence = 0
                        self._active = False
                        self.model.reset()
                else:
                    self._speech = 0
        return ended


class _EnergyBoundaryModel:
    """Small dependency-free fallback used by the local sounddevice path."""

    window_size_samples = 512

    def reset(self):
        return None

    def __call__(self, samples):
        values = np.asarray(samples, dtype=np.float32)
        return float(np.sqrt(np.mean(values * values))) * 8.0


class WindowsWakeDetector:
    """One serialized Sherpa model with versioned, replaceable keyword streams."""

    def __init__(self, config, mapping, *, spotter=None, clock=time.monotonic):
        directory = config.get('windows_wake_model_dir')
        if not isinstance(directory, str) or not Path(directory).is_absolute():
            raise ValueError('windows_wake_model_dir_required')
        self._paths = {key: Path(directory) / filename for key, filename in _MODEL_FILES.items()}
        if any(not path.is_file() or path.stat().st_size == 0 for path in self._paths.values()):
            raise ValueError('windows_wake_assets_missing')
        score = _number(config, 'windows_wake_keywords_score', 1.5, minimum=0.01)
        threshold = _number(config, 'windows_wake_keywords_threshold', .35, minimum=0.01, maximum=1.)
        self._cooldown = _number(config, 'windows_wake_cooldown_seconds', 1.)
        self._clock = clock
        self._lock = Lock()
        self._mapping = None
        self._used_versions = set()
        self._table = None
        self._stream = None
        self._generation = 0
        self._sequence = 0
        self._last_event_sequence = 0
        self._last_detection = {}
        self._diagnostic_frames = 0
        self._diagnostic_boundaries = 0
        self._diagnostic_keyword_results = 0
        self._diagnostic_valid_hits = 0
        self._diagnostic_cooldown_drops = 0
        self._diagnostic_unknown_keywords = 0
        self._unsupported = ()
        self.closed = False
        self._allow_empty = config.get('active_role_wake_enabled', False) is True
        # Validate before calling the native constructor (some Sherpa invalid
        # configurations terminate the process rather than raising Python errors).
        if mapping.roles or not self._allow_empty:
            build_keyword_table(mapping, self._paths['tokens'], strict=False)
        if spotter is None:
            import sherpa_onnx

            # A real, empty base file is required by Sherpa 1.13.8. Loading the
            # Android keywords.txt would retain its old wake word on every rename.
            with TemporaryDirectory(prefix='windows-wake-') as temp:
                empty = Path(temp) / 'keywords.txt'
                empty.write_text('', encoding='utf-8')
                spotter = sherpa_onnx.KeywordSpotter(
                    **{key: str(path) for key, path in self._paths.items()},
                    keywords_file=str(empty), num_threads=1,
                    sample_rate=SAMPLE_RATE, keywords_score=score,
                    keywords_threshold=threshold, provider='cpu')
        self._spotter = spotter
        self._boundary = SpeechBoundary()
        self.update_mapping(mapping)

    def process_frame(self, frame):
        return self._process_samples(frame.data, frame.sample_rate, frame.num_channels)

    def process_pcm16(self, data, sample_rate=SAMPLE_RATE, num_channels=1):
        """Process a raw PCM16 microphone chunk without a LiveKit dependency."""
        return self._process_samples(data, sample_rate, num_channels)

    def _process_samples(self, data, sample_rate, num_channels):
        with self._lock:
            if self.closed or self._stream is None:
                return ()
            if sample_rate != SAMPLE_RATE or num_channels != 1:
                raise ValueError('wake_audio_format')
            self._diagnostic_frames += 1
            samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.
            self._stream.accept_waveform(SAMPLE_RATE, samples)
            hits = ()
            while self._spotter.is_ready(self._stream):
                self._spotter.decode_stream(self._stream)
                keyword = self._spotter.get_result(self._stream)
                if not keyword:
                    continue
                self._diagnostic_keyword_results += 1
                self._spotter.reset_stream(self._stream)
                bot_id = self._table.bot_by_keyword.get(keyword)
                if bot_id is None:
                    self._diagnostic_unknown_keywords += 1
                    continue
                now = self._clock()
                previous = self._last_detection.get(bot_id)
                if previous is not None and now - previous < self._cooldown:
                    self._diagnostic_cooldown_drops += 1
                    continue
                self._last_detection[bot_id] = now
                self._sequence += 1
                self._diagnostic_valid_hits += 1
                hits = (WakeHit(uuid4().hex, bot_id, self._mapping.version,
                                self._generation, self._sequence),)
                break
            if self._boundary.process(samples):
                self._diagnostic_boundaries += 1
                self._stream = self._spotter.create_stream(self._table.keywords)
            return hits

    def diagnostics_snapshot(self):
        with self._lock:
            return {
                'frames': self._diagnostic_frames,
                'utterance_boundaries': self._diagnostic_boundaries,
                'keyword_results': self._diagnostic_keyword_results,
                'valid_hits': self._diagnostic_valid_hits,
                'cooldown_drops': self._diagnostic_cooldown_drops,
                'unknown_keywords': self._diagnostic_unknown_keywords,
                'generation': self._generation,
                'mapping_version': self._mapping.version if self._mapping else None,
                'bot_ids': list(self._mapping.roles) if self._mapping else [],
                'unsupported_wake_names': [list(item) for item in self._unsupported],
            }

    def event_for_hit(self, hit):
        with self._lock:
            if (self.closed or self._table is None or hit.generation != self._generation
                    or hit.mapping_version != self._mapping.version
                    or hit.sequence <= self._last_event_sequence):
                return None
            self._last_event_sequence = hit.sequence
            return {
                'type': 'device.wake',
                'wake_session_id': hit.wake_session_id,
                'bot_id': hit.bot_id,
                'wake_mapping_version': hit.mapping_version,
            }

    def update_mapping(self, mapping):
        with self._lock:
            if self.closed:
                raise RuntimeError('wake_detector_closed')
            if mapping == self._mapping and (self._stream is not None or
                                             (self._allow_empty and not mapping.roles)):
                return
            # Invalidate even if a replacement is invalid. A failed rename must
            # not continue detecting an old name or publishing an in-flight hit.
            self._generation += 1
            self._stream = None
            self._table = None
            self._unsupported = ()
            self._last_detection.clear()
            if mapping.version in self._used_versions and not self._allow_empty:
                raise ValueError('wake_mapping_version_reused')
            if not mapping.roles and self._allow_empty:
                self._mapping = mapping
                self._used_versions.add(mapping.version)
                self._boundary.reset()
                return
            table = build_keyword_table(mapping, self._paths['tokens'], strict=False)
            stream = self._spotter.create_stream(table.keywords)
            self._mapping = WakeMapping(mapping.version, dict(mapping.roles))
            self._boundary.reset()
            self._used_versions.add(mapping.version)
            self._table = table
            self._unsupported = table.unsupported
            self._stream = stream

    def close(self):
        with self._lock:
            self.closed = True
            self._generation += 1
            self._stream = None
            self._table = None
            self._spotter = None
            self._boundary = None


async def run_windows_wake(track, participant, detector):
    """Read the same post-APM track at model rate, independently of playback."""
    stream = None
    frames = samples = peak = 0
    next_report = 0.
    last_boundary_count = 0
    try:
        from livekit import rtc
        stream = rtc.AudioStream.from_track(track=track, sample_rate=SAMPLE_RATE,
                                           num_channels=1, capacity=50)
        async for event in stream:
            frames += 1
            values = np.frombuffer(event.frame.data, dtype=np.int16)
            samples += len(values)
            peak = max(peak, int(np.max(np.abs(values.astype(np.int32)), initial=0)))
            hits = await asyncio.to_thread(detector.process_frame, event.frame)
            snapshot_reader = getattr(detector, 'diagnostics_snapshot', None)
            diagnostics = (await asyncio.to_thread(snapshot_reader)
                           if callable(snapshot_reader) else {})
            boundary_count = diagnostics.get('utterance_boundaries', 0)
            if boundary_count > last_boundary_count:
                print(json.dumps({
                    'type': 'windows.wake.boundary',
                    'utterance_index': boundary_count,
                    'wake_diagnostics': diagnostics,
                }, ensure_ascii=False), flush=True)
                last_boundary_count = boundary_count
            for hit in hits:
                payload = await asyncio.to_thread(detector.event_for_hit, hit)
                if payload is not None:
                    await participant.publish_data(json.dumps(payload, ensure_ascii=False),
                                                   reliable=True, topic='agent-events.v1')
                    print(json.dumps({**payload, 'type': 'windows.wake.published'},
                                     ensure_ascii=False), flush=True)
            now = time.monotonic()
            if now >= next_report:
                # Local diagnostics only. Never send PCM or additional control
                # events; distinguish a silent/missing feed from a keyword miss.
                print(json.dumps({'type': 'windows.wake.audio', 'frames': frames,
                                  'samples': samples, 'peak': peak,
                                  'wake_diagnostics': diagnostics}), flush=True)
                peak = 0
                next_report = now + 10.
    finally:
        try:
            if stream is not None:
                await stream.aclose()
        finally:
            # Serializes with an uncancelled native decode still running in the
            # worker when the coroutine was cancelled; no late result is emitted.
            await asyncio.to_thread(detector.close)


async def watch_wake_mapping(config_path, detector, *, interval=1.):
    """Re-read only the shared versioned mapping; all other settings need restart."""
    def reload_mapping():
        try:
            config = json.loads(Path(config_path).read_text(encoding='utf-8-sig'))
            detector.update_mapping(WakeMapping.from_config(config))
        except Exception:
            detector.close()
            raise

    while True:
        await asyncio.to_thread(reload_mapping)
        await asyncio.sleep(interval)


