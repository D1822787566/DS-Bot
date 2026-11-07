"""Adapters for retained ASR, CAM++ and Qwen TTS assets.

These wrappers intentionally keep model selection and preprocessing explicit;
they do not claim model-level incremental streaming support.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import math
import hashlib
import json
import threading
import re

from audio_adapter import AudioSegment, NormalizedAudio, OwnerDecision, normalize_audio


@dataclass(frozen=True)
class RetainedModelConfig:
    asr_model_dir: str
    speaker_profile_dir: str
    tts_sample_rate: int = 16000


class ParaformerAdapter:
    def __init__(self, model, *, hotwords=()):
        self.model = model
        self.hotwords = tuple(dict.fromkeys(
            name.strip() for name in hotwords if isinstance(name, str) and name.strip()))

    def transcribe_segment(self, segment: AudioSegment) -> str:
        audio = normalize_audio(segment.samples, segment.sample_rate)
        options = {'batch_size_s': 300}
        if self.hotwords:
            options['hotword'] = ' '.join(self.hotwords)
        result = self.model.generate(input=audio.samples, **options)
        if not result:
            return ''
        first = result[0] if isinstance(result, list) else result
        text = str(first.get('text', '') if isinstance(first, dict) else first).strip()
        # Paraformer separates Chinese bots with spaces. Keep role names
        # intact for the shared Router/Laya input while preserving English words.
        return re.sub(r'(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])', '', text)


class SpeakerProfileAdapter:
    def __init__(self, verifier):
        self.verifier = verifier

    def verify_segment(self, segment: AudioSegment) -> OwnerDecision:
        audio = normalize_audio(segment.samples, segment.sample_rate)
        result = self.verifier.score(audio.samples, sample_rate=audio.sample_rate)
        if isinstance(result, (float, int)):
            threshold = getattr(self.verifier, 'threshold', None)
            if threshold is None:
                raise ValueError('profile threshold must be explicit')
            verified = math.isfinite(result) and result >= threshold
            return OwnerDecision('owner' if verified else 'unknown', float(result),
                                 'verified' if verified else 'unknown', segment_id=segment.segment_id,
                                 model_id=getattr(self.verifier, 'model_id', ''),
                                 profile_version=getattr(self.verifier, 'profile_version', ''))
        return OwnerDecision(result.get('identity', 'unknown'), float(result.get('score', 0.0)),
                             result.get('status', 'unknown'), segment_id=segment.segment_id)


class QwenTTSAdapter:
    def __init__(self, synthesize, sample_rate: int = 16000, *, synthesize_stream=None):
        self.synthesize = synthesize
        self.sample_rate = sample_rate
        self.synthesize_stream = synthesize_stream

    async def synthesize_pcm16(self, text: str, cancellation_token=None) -> bytes:
        result = self.synthesize(text, cancellation_token)
        if hasattr(result, '__await__'):
            result = await result
        if not isinstance(result, bytes):
            raise TypeError('Qwen TTS adapter must return PCM16 little-endian bytes')
        return result

    async def synthesize_pcm16_stream(self, text: str, cancellation_token=None):
        if self.synthesize_stream is None:
            pcm = await self.synthesize_pcm16(text, cancellation_token=cancellation_token)
            if pcm:
                yield pcm
            return
        result = self.synthesize_stream(text, cancellation_token)
        if hasattr(result, '__await__') and not hasattr(result, '__aiter__'):
            result = await result
        if hasattr(result, '__aiter__'):
            async for chunk in result:
                if not isinstance(chunk, bytes) or not chunk or len(chunk) % 2:
                    raise TypeError('Qwen TTS adapter must return PCM16 little-endian bytes')
                yield chunk
            return
        if not isinstance(result, bytes):
            raise TypeError('Qwen TTS adapter must return PCM16 little-endian bytes')
        if result:
            yield result


class CAMProfile:
    """Retained CAM++ centroid space, threshold, and silence preprocessing."""
    model_id = 'cam++'

    def __init__(self, profile_dir, model):
        folder = Path(profile_dir)
        metadata_bytes = (folder / 'target_profile.json').read_bytes()
        metadata = json.loads(metadata_bytes)
        if (metadata['model'], metadata['sample_rate'], metadata['normalization']) != ('cam++', 16000, 'l2'):
            raise ValueError('incompatible retained speaker profile')
        embedding_bytes = (folder / 'target_profile.npz').read_bytes()
        self.profile_version = hashlib.sha256(metadata_bytes + embedding_bytes).hexdigest()
        self.centroid = np.asarray(np.load(folder / 'target_profile.npz')['centroid'], dtype=np.float64).reshape(-1)
        self.centroid /= np.linalg.norm(self.centroid)
        self.threshold = float(metadata['threshold'])
        self.model = model
        self._lock = threading.Lock()

    def score(self, samples, sample_rate=16000):
        values = normalize_audio(samples, sample_rate).samples
        # Same 30 ms relative-energy trim and 200 ms padding as the retained verifier.
        frame, pad = 480, 3200
        count = len(values) // frame
        if count >= 2:
            energy = np.sqrt(np.mean(values[:count * frame].reshape(count, frame).astype(np.float64) ** 2, axis=1))
            active = np.flatnonzero(energy >= max(1e-4, float(energy.max()) * .08))
            if len(active):
                values = values[max(0, int(active[0]) * frame - pad):min(len(values), (int(active[-1]) + 1) * frame + pad)]
        values = values[-12 * 16000:]
        if len(values) < 8000:
            raise ValueError('speaker audio too short')
        with self._lock:
            result = self.model.generate(input=values)
        embedding = result[0]['spk_embedding']
        if hasattr(embedding, 'detach'):
            embedding = embedding.detach().cpu().numpy()
        vector = np.asarray(embedding, dtype=np.float64).reshape(-1)
        score = float(np.dot(self.centroid, vector / np.linalg.norm(vector)))
        if not math.isfinite(score):
            raise ValueError('invalid speaker embedding')
        return max(-1., min(1., score))


