"""G3 audio boundary: one VAD segment feeds ASR and speaker verification.

Model inference is injected so this module tests the wiring and cancellation
semantics without pretending that a model supports frame-level identity events.
"""
from __future__ import annotations

import asyncio
import inspect
from collections import deque
from dataclasses import dataclass
from typing import Callable
from uuid import uuid4

import numpy as np


@dataclass(frozen=True)
class AudioSegment:
    samples: np.ndarray
    sample_rate: int
    segment_id: int
    ended_at: float | None = None
    started_at: float | None = None


@dataclass(frozen=True)
class NormalizedAudio:
    samples: np.ndarray
    sample_rate: int
    channels: int


@dataclass(frozen=True)
class OwnerDecision:
    identity: str
    score: float
    status: str
    segment_id: int | None = None
    model_id: str = ''
    profile_version: str = ''


def normalize_audio(samples: np.ndarray, sample_rate: int, target_rate: int = 16000) -> NormalizedAudio:
    if sample_rate <= 0 or target_rate <= 0:
        raise ValueError('sample rates must be positive')
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim == 2:
        values = values.mean(axis=1)
    if values.ndim != 1 or not values.size or not np.all(np.isfinite(values)):
        raise ValueError('audio must be mono or [frames, channels]')
    values = np.clip(values, -1.0, 1.0)
    if sample_rate != target_rate and values.size:
        target_length = max(1, round(values.size * target_rate / sample_rate))
        values = np.interp(np.linspace(0, values.size - 1, target_length), np.arange(values.size), values).astype(np.float32)
    return NormalizedAudio(values.astype(np.float32, copy=False), target_rate, 1)


async def join_segment(segment, transcribe, verify, *, speaker_timeout=2.0):
    """Run ASR/identity against one finalized VAD segment; late evidence grants nothing."""
    normalized = normalize_audio(segment.samples, segment.sample_rate)
    frozen = AudioSegment(normalized.samples, 16000, segment.segment_id,
                          segment.ended_at, segment.started_at)
    asr = asyncio.create_task(asyncio.to_thread(transcribe, frozen))
    speaker = asyncio.create_task(asyncio.to_thread(verify, frozen))
    def consume(task):
        if not task.cancelled():
            task.exception()
    try:
        owner = await asyncio.wait_for(asyncio.shield(speaker), speaker_timeout)
    except TimeoutError:
        speaker.add_done_callback(consume)
        asr.add_done_callback(consume)
        return None, OwnerDecision('unknown', 0.0, 'timeout', segment_id=segment.segment_id)
    except Exception:
        asr.add_done_callback(consume)
        return None, OwnerDecision('unknown', 0.0, 'unknown', segment_id=segment.segment_id)
    if owner.identity != 'owner' or owner.status != 'verified' or owner.segment_id != segment.segment_id:
        asr.add_done_callback(consume)
        return None, owner
    return await asr, owner


class SpeechAdapter:
    def __init__(self, submit_text: Callable[[str, str], object], *, stop_playback=None, cancel_tts=None, cancel_run=None):
        self.submit_text = submit_text
        self.stop_playback = stop_playback or (lambda response: None)
        self.cancel_tts = cancel_tts or (lambda response: None)
        self.cancel_run = cancel_run or (lambda run: None)
        self._responses: dict[str, tuple[str, bool]] = {}
        self._queues: dict[str, deque] = {}

    async def submit(self, segment: AudioSegment, owner: OwnerDecision, *, text: str) -> bool:
        normalized = normalize_audio(segment.samples, segment.sample_rate)
        if normalized.channels != 1 or normalized.sample_rate != 16000:
            raise ValueError('adapter invariant violated')
        if owner.status != 'verified' or owner.identity != 'owner' or owner.segment_id != segment.segment_id:
            return False
        if not text.strip():
            raise ValueError('final transcript must contain text')
        input_id = uuid4().hex  # DS Bot allocates the run id after acquiring its session binding.
        result = self.submit_text(text, input_id)
        if inspect.isawaitable(result):
            await result
        return True

    def begin_response(self, run_id: str, response_id: str) -> None:
        if response_id in self._responses:
            raise ValueError('response_id cannot be reused')
        self._responses[response_id] = (run_id, False)
        self._queues[response_id] = deque()

    def enqueue_tts(self, response_id: str, pcm16: bytes) -> bool:
        if response_id not in self._responses:
            raise KeyError(response_id)
        if not isinstance(pcm16, bytes):
            raise TypeError('TTS output must be PCM16 bytes')
        if self.response_cancelled(response_id):
            return False
        if len(self._queues[response_id]) >= 32:
            raise BufferError('output_backpressure')
        self._queues[response_id].append(pcm16)
        return True

    async def interrupt(self, run_id: str, response_id: str, owner: OwnerDecision, *, segment_id=None) -> bool:
        current = self._responses.get(response_id)
        if current is None or current[0] != run_id or current[1] or owner.status != 'verified' or owner.identity != 'owner' or segment_id is None or owner.segment_id != segment_id:
            return False
        self._responses[response_id] = (run_id, True)
        self._queues[response_id].clear()
        for callback, identifier in [(self.stop_playback, response_id), (self.cancel_tts, response_id), (self.cancel_run, run_id)]:
            result = callback(identifier)
            if inspect.isawaitable(result):
                await result
        return True

    def response_cancelled(self, response_id: str) -> bool:
        return self._responses.get(response_id, ('', False))[1]


