"""Bounded, in-memory Windows PCM segmentation using Phone Agent's Silero VAD."""
from __future__ import annotations

from collections import deque
import math

import numpy as np

from audio_adapter import AudioSegment


def load_vad():
    from livekit.plugins.silero import onnx_model
    return onnx_model.OnnxModel(
        onnx_session=onnx_model.new_inference_session(force_cpu=True), sample_rate=16000)


class PcmSegmenter:
    """Keep pre-roll and one utterance; discard an oversized utterance entirely."""

    def __init__(self, vad, *, min_speech=.06, silence=.55, prefix=.3,
                 max_speech=30., notify=None):
        self.vad = vad
        self.window = int(vad.window_size_samples)
        if self.window <= 0 or not all(math.isfinite(v) and v > 0 for v in (min_speech, silence, prefix, max_speech)):
            raise ValueError('invalid_segment_settings')
        self.minimum = math.ceil(min_speech * 16000 / self.window)
        self.silence_limit = math.ceil(silence * 16000 / self.window)
        self.maximum = math.ceil(max_speech * 16000 / self.window)
        self.prefix = deque(maxlen=math.ceil(prefix * 16000 / self.window))
        self.notify = notify or (lambda *_args, **_kwargs: None)
        self.sequence = 0
        self.reset()

    def reset(self):
        self.pending = np.empty(0, dtype=np.float32)
        self.parts = []
        self.prefix.clear()
        self.active = False
        self.discarding = False
        self.speech = self.silence = 0
        self.position = None
        self.last_chunk_at = None
        self.started_at = None
        self.vad.reset()

    def feed(self, pcm16: bytes, *, now: float):
        if not isinstance(pcm16, bytes) or len(pcm16) % 2 or not math.isfinite(now):
            raise ValueError('invalid_pcm_segment')
        if not pcm16:
            return []
        if self.last_chunk_at is not None and now - self.last_chunk_at > 1.:
            if self.active:
                self.notify('audio.segment.dropped', reason='audio_gap', segment_id=self.sequence)
            self.reset()
        values = np.frombuffer(pcm16, dtype='<i2').astype(np.float32) / 32768.
        if self.position is None:
            self.position = now - len(values) / 16000
        self.last_chunk_at = now
        self.pending = np.concatenate((self.pending, values))
        # Consume all frames, including those after an END in the same chunk.
        completed = []
        offset = 0
        while len(self.pending) - offset >= self.window:
            frame = self.pending[offset:offset + self.window]
            offset += self.window
            self.position += self.window / 16000
            probability = float(self.vad(frame))
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError('invalid_vad_probability')
            result = self._frame(frame, probability)
            if result is not None:
                completed.append(result)
        self.pending = self.pending[offset:].copy()
        return completed

    def _frame(self, frame, probability):
        voiced = probability >= .5
        if not self.active:
            self.prefix.append(frame.copy())
            self.speech = self.speech + 1 if voiced else 0
            if self.speech < self.minimum:
                return None
            self.sequence += 1
            self.active = True
            self.parts = list(self.prefix)
            self.prefix.clear()
            self.started_at = self.position - len(self.parts) * self.window / 16000
            self.notify('audio.segment.started', segment_id=self.sequence, started_at=self.started_at)
            return None
        self.silence = self.silence + 1 if probability < .35 else 0
        if not self.discarding:
            self.parts.append(frame.copy())
            if len(self.parts) > self.maximum:
                self.parts.clear()
                self.discarding = True
                self.notify('audio.segment.dropped', reason='too_long', segment_id=self.sequence)
        if self.silence < self.silence_limit:
            return None
        result = None
        if not self.discarding:
            values = np.concatenate(self.parts)
            values.flags.writeable = False
            result = AudioSegment(values, 16000, self.sequence,
                                  ended_at=self.position, started_at=self.started_at)
        self.parts = []
        self.speech = self.silence = 0
        self.active = self.discarding = False
        self.started_at = None
        return result
