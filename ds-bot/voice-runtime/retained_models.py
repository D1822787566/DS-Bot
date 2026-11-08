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
import time
from uuid import uuid4

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
        embedding = None
        score_with_embedding = getattr(self.verifier, 'score_with_embedding', None)
        if callable(score_with_embedding):
            result, embedding = score_with_embedding(audio.samples, sample_rate=audio.sample_rate)
        else:
            result = self.verifier.score(audio.samples, sample_rate=audio.sample_rate)
        if isinstance(result, (float, int)):
            threshold = getattr(self.verifier, 'threshold', None)
            if threshold is None:
                raise ValueError('profile threshold must be explicit')
            verified = math.isfinite(result) and result >= threshold
            return OwnerDecision('owner' if verified else 'unknown', float(result),
                                 'verified' if verified else 'unknown', segment_id=segment.segment_id,
                                 model_id=getattr(self.verifier, 'model_id', ''),
                                 profile_version=getattr(self.verifier, 'profile_version', ''),
                                 embedding=embedding)
        return OwnerDecision(result.get('identity', 'unknown'), float(result.get('score', 0.0)),
                             result.get('status', 'unknown'), segment_id=segment.segment_id,
                             embedding=embedding)


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
    _SAMPLES_META = 'dsbot_voice_samples.json'
    _SAMPLES_DATA = 'dsbot_voice_samples.npz'
    _MAX_PENDING = 16
    _MAX_APPROVED = 64

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
        self._samples_folder = folder
        self._pending, self._approved, self._sample_metadata = self._load_samples()
        self._refresh_profile_version(metadata_bytes, embedding_bytes)

    @staticmethod
    def _empty_vectors(dimension):
        return np.empty((0, dimension), dtype=np.float64)

    def _load_samples(self):
        dimension = self.centroid.size
        pending = self._empty_vectors(dimension)
        approved = self._empty_vectors(dimension)
        metadata = {'version': 1, 'pending': [], 'approved': []}
        try:
            raw = json.loads((self._samples_folder / self._SAMPLES_META).read_text(encoding='utf-8'))
            if isinstance(raw, dict):
                metadata['pending'] = raw.get('pending') if isinstance(raw.get('pending'), list) else []
                metadata['approved'] = raw.get('approved') if isinstance(raw.get('approved'), list) else []
        except (FileNotFoundError, OSError, ValueError, TypeError):
            pass
        try:
            with np.load(self._samples_folder / self._SAMPLES_DATA) as data:
                for name, target in (('pending', 'pending'), ('approved', 'approved')):
                    values = np.asarray(data[name], dtype=np.float64)
                    if values.ndim == 2 and values.shape[1] == dimension and np.all(np.isfinite(values)):
                        if target == 'pending': pending = values[:self._MAX_PENDING]
                        else: approved = values[:self._MAX_APPROVED]
        except (FileNotFoundError, OSError, ValueError, KeyError):
            pass
        metadata['pending'] = metadata['pending'][:len(pending)]
        metadata['approved'] = metadata['approved'][:len(approved)]
        return pending, approved, metadata

    def _refresh_profile_version(self, metadata_bytes=None, embedding_bytes=None):
        if metadata_bytes is None:
            metadata_bytes = (self._samples_folder / 'target_profile.json').read_bytes()
        if embedding_bytes is None:
            embedding_bytes = (self._samples_folder / 'target_profile.npz').read_bytes()
        adaptive_bytes = b''
        for path in (self._samples_folder / self._SAMPLES_META, self._samples_folder / self._SAMPLES_DATA):
            try:
                adaptive_bytes += path.read_bytes()
            except FileNotFoundError:
                pass
        self.profile_version = hashlib.sha256(metadata_bytes + embedding_bytes + adaptive_bytes).hexdigest()

    @property
    def pending_count(self):
        return len(self._pending)

    @property
    def approved_count(self):
        return len(self._approved)

    def status(self):
        return {'pending_samples': self.pending_count, 'approved_samples': self.approved_count,
                'profile_version': self.profile_version}

    @staticmethod
    def _normalized_vector(values, dimension):
        vector = np.asarray(values, dtype=np.float64).reshape(-1)
        if vector.size != dimension or not np.all(np.isfinite(vector)):
            raise ValueError('invalid speaker embedding')
        norm = np.linalg.norm(vector)
        if not math.isfinite(norm) or norm <= 0:
            raise ValueError('invalid speaker embedding')
        return vector / norm

    def _write_samples(self):
        metadata = {
            'version': 1,
            'pending': self._sample_metadata.get('pending', [])[:len(self._pending)],
            'approved': self._sample_metadata.get('approved', [])[:len(self._approved)],
        }
        meta_path = self._samples_folder / self._SAMPLES_META
        data_path = self._samples_folder / self._SAMPLES_DATA
        stamp = uuid4().hex
        meta_tmp = self._samples_folder / f'.{self._SAMPLES_META}.{stamp}.tmp'
        data_tmp = self._samples_folder / f'.{self._SAMPLES_DATA}.{stamp}.tmp'
        try:
            meta_tmp.write_text(json.dumps(metadata, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            with data_tmp.open('wb') as handle:
                np.savez_compressed(handle, pending=self._pending, approved=self._approved)
            meta_tmp.replace(meta_path)
            data_tmp.replace(data_path)
        finally:
            meta_tmp.unlink(missing_ok=True)
            data_tmp.unlink(missing_ok=True)
        self._sample_metadata = metadata
        self._refresh_profile_version()

    def add_pending(self, embedding, *, sample_id=None, segment_id=None, score=None):
        """Store one explicitly user-labeled embedding without activating it."""
        with self._lock:
            if self.pending_count >= self._MAX_PENDING:
                raise ValueError('voiceprint_pending_limit')
            vector = self._normalized_vector(embedding, self.centroid.size)
            self._pending = np.vstack([self._pending, vector])
            self._sample_metadata.setdefault('pending', []).append({
                'id': str(sample_id or uuid4().hex),
                'segment_id': int(segment_id) if isinstance(segment_id, (int, np.integer)) else None,
                'score': float(score) if isinstance(score, (float, int)) and math.isfinite(score) else None,
                'created_at': int(time.time()),
            })
            self._write_samples()
        return self.status()

    def apply_pending(self):
        """Activate all pending samples while preserving the base centroid."""
        with self._lock:
            if self.pending_count:
                available = self._MAX_APPROVED - self.approved_count
                if available < self.pending_count:
                    raise ValueError('voiceprint_approved_limit')
                self._approved = np.vstack([self._approved, self._pending])
                self._sample_metadata.setdefault('approved', []).extend(self._sample_metadata.get('pending', []))
                self._pending = self._empty_vectors(self.centroid.size)
                self._sample_metadata['pending'] = []
                self._write_samples()
        return self.status()

    def discard_pending(self):
        with self._lock:
            self._pending = self._empty_vectors(self.centroid.size)
            self._sample_metadata['pending'] = []
            self._write_samples()
        return self.status()

    def _prepare(self, samples, sample_rate=16000):
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
        return values

    def embedding(self, samples, sample_rate=16000):
        values = self._prepare(samples, sample_rate)
        with self._lock:
            result = self.model.generate(input=values)
        embedding = result[0]['spk_embedding']
        if hasattr(embedding, 'detach'):
            embedding = embedding.detach().cpu().numpy()
        return self._normalized_vector(embedding, self.centroid.size)

    def score_with_embedding(self, samples, sample_rate=16000):
        vector = self.embedding(samples, sample_rate)
        with self._lock:
            references = np.vstack([self.centroid, self._approved])
        score = float(np.max(references @ vector))
        if not math.isfinite(score):
            raise ValueError('invalid speaker score')
        return max(-1., min(1., score)), vector

    def score(self, samples, sample_rate=16000):
        return self.score_with_embedding(samples, sample_rate)[0]


