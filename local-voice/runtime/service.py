"""Speech model adapters for the Local Voice runtime.

Imports of FunASR and MeloTTS stay lazy so protocol tests and host startup can
report a precise dependency/model error instead of crashing at module import.
"""

from __future__ import annotations

import os
import math
from pathlib import Path


class SpeechService:
    def __init__(self, *, asr=None, tts=None):
        self.asr = asr
        self.tts = tts
        self._cancelled: set[str] = set()
        self._prewarmed = False

    def capabilities(self):
        return {"asr": self.asr is not None, "tts": self.tts is not None, "prewarmed": self._prewarmed}

    def transcribe(self, audio: bytes, sample_rate: int) -> str:
        if self.asr is None:
            raise RuntimeError("ASR model is not configured")
        if sample_rate != 16000:
            raise ValueError("sample_rate must be 16000")
        return self.asr.transcribe(audio, sample_rate)

    def synthesize(self, text: str, voice: str, sample_rate: int, request_id: str = ""):
        if self.tts is None:
            raise RuntimeError("TTS model is not configured")
        if sample_rate != 16000:
            raise ValueError("sample_rate must be 16000")
        for chunk in self.tts.synthesize(
            text,
            voice,
            sample_rate,
            request_id=request_id,
            cancel_check=lambda: self.cancelled(request_id),
        ):
            if request_id and self.cancelled(request_id):
                return
            yield chunk

    def cancel(self, request_id: str):
        self._cancelled.add(request_id)

    def cancelled(self, request_id: str) -> bool:
        return request_id in self._cancelled

    def warmup(self):
        if self.tts is None:
            return
        for _ in self.tts.synthesize("嗯", "", 16000):
            pass
        self._prewarmed = True


class ParaformerAsr:
    def __init__(self, model):
        self.model = model

    @classmethod
    def from_environment(cls):
        model_dir = os.environ.get("LOCAL_VOICE_ASR_MODEL_DIR", "").strip()
        if not model_dir:
            raise RuntimeError("LOCAL_VOICE_ASR_MODEL_DIR is not configured")
        try:
            from funasr import AutoModel
        except ImportError as error:
            raise RuntimeError("FunASR dependency is missing") from error
        device = os.environ.get("LOCAL_VOICE_ASR_DEVICE", "cpu")
        model = AutoModel(
            model=model_dir,
            device=device,
            disable_update=True,
            disable_pbar=True,
            disable_log=True,
        )
        return cls(model)

    def transcribe(self, audio: bytes, sample_rate: int) -> str:
        import numpy as np

        samples = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
        result = self.model.generate(input=samples, batch_size_s=300)
        if not result:
            return ""
        item = result[0] if isinstance(result, list) else result
        text = item.get("text", "") if isinstance(item, dict) else item
        return str(text).strip()


class MeloTts:
    def __init__(self, model):
        self.model = model
        self.speakers = getattr(getattr(model, "hps", None), "data", None)
        raw_speaker_ids = getattr(self.speakers, "spk2id", {}) or {}
        self.speaker_ids = dict(raw_speaker_ids.items()) if hasattr(raw_speaker_ids, "items") else dict(raw_speaker_ids)

    @classmethod
    def from_environment(cls):
        model_dir = os.environ.get("LOCAL_VOICE_TTS_MODEL_DIR", "").strip()
        if not model_dir:
            raise RuntimeError("LOCAL_VOICE_TTS_MODEL_DIR is not configured")
        model_root = Path(model_dir)
        config_path = model_root / "config.json"
        checkpoint_path = model_root / "checkpoint.pth"
        if not config_path.is_file() or not checkpoint_path.is_file():
            raise RuntimeError("MeloTTS model files are missing")
        # Model serving must be deterministic and must never fetch files from
        # the network. Setup tooling is responsible for populating the caches.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        try:
            # MeloTTS imports Japanese text normalization at module import.
            # The full UniDic download is 500+ MB; the bundled lite dictionary
            # is sufficient for startup and keeps the local Windows MVP small.
            import sys
            import types
            import unidic_lite

            sys.modules.setdefault("unidic", unidic_lite)
            # MeloTTS imports every language cleaner at startup. The English
            # cleaner constructs G2p and requests NLTK cmudict even for a
            # Chinese-only runtime. Keep the MVP dependency-free for English.
            if "g2p_en" not in sys.modules:
                shim = types.ModuleType("g2p_en")
                from importlib.machinery import ModuleSpec

                shim.__spec__ = ModuleSpec("g2p_en", loader=None)
                shim.G2p = type("G2p", (), {"__call__": lambda self, _text: []})
                sys.modules["g2p_en"] = shim
            from melo.api import TTS
        except ImportError as error:
            raise RuntimeError("MeloTTS dependency is missing") from error
        device = os.environ.get("LOCAL_VOICE_TTS_DEVICE", "cpu")
        return cls(TTS(
            language="ZH",
            device=device,
            use_hf=False,
            config_path=str(config_path),
            ckpt_path=str(checkpoint_path),
        ))

    def synthesize(self, text: str, voice: str, sample_rate: int, request_id: str = "", cancel_check=None):
        if sample_rate != 16000:
            raise ValueError("MeloTTS output contract must use 16 kHz")
        speaker = self.speaker_ids.get(voice, self.speaker_ids.get("ZH"))
        if speaker is None and self.speaker_ids:
            speaker = next(iter(self.speaker_ids.values()))
        if speaker is None:
            raise RuntimeError("MeloTTS Chinese speaker is unavailable")
        import re
        import numpy as np
        from scipy.signal import resample_poly
        source_rate = int(getattr(getattr(self.model, "hps", None), "data", None).sampling_rate)
        pieces = [piece for piece in re.split(r"(?<=[。！？!?；;])", text) if piece.strip()] or [text]
        for piece in pieces:
            if callable(cancel_check) and cancel_check():
                return
            audio = self.model.tts_to_file(piece, speaker, None, speed=1.0, quiet=True)
            audio = np.asarray(audio, dtype=np.float32).reshape(-1)
            if audio.size == 0:
                continue
            if source_rate != sample_rate:
                divisor = math.gcd(source_rate, sample_rate)
                audio = resample_poly(audio, sample_rate // divisor, source_rate // divisor)
            pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype("<i2").tobytes()
            for offset in range(0, len(pcm), 1600 * 2):
                if callable(cancel_check) and cancel_check():
                    return
                yield pcm[offset:offset + 1600 * 2]


def load_from_environment() -> SpeechService:
    asr = ParaformerAsr.from_environment()
    tts = MeloTts.from_environment()
    service = SpeechService(asr=asr, tts=tts)
    if os.environ.get("LOCAL_VOICE_TTS_PREWARM", "1").strip().lower() not in {"0", "false", "no"}:
        service.warmup()
    return service
