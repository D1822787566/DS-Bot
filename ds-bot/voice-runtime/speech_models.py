"""The retained Paraformer/CAM++ pair, with bounded inference and no late grants."""
from __future__ import annotations

import asyncio
import contextlib
import io
from pathlib import Path

from retained_models import CAMProfile, ParaformerAdapter, SpeakerProfileAdapter


class SpeechFailure(RuntimeError):
    """A stable diagnostic code; model exceptions/transcripts are not logged."""


class SpeechModels:
    def __init__(self, transcribe, verify, *, asr_timeout=20., speaker_timeout=5., profile=None):
        self.transcribe, self.verify = transcribe, verify
        self.asr_timeout, self.speaker_timeout = asr_timeout, speaker_timeout
        self.profile = profile
        self.pending = set()

    def _finished(self, task):
        self.pending.discard(task)
        if not task.cancelled():
            task.exception()

    def _infer(self, callback, segment):
        task = asyncio.create_task(asyncio.to_thread(callback, segment))
        self.pending.add(task)
        task.add_done_callback(self._finished)
        return task

    def profile_status(self):
        return self.profile.status() if self.profile is not None and hasattr(self.profile, 'status') else {
            'pending_samples': 0, 'approved_samples': 0,
        }

    def label_profile_sample(self, candidate):
        if self.profile is None or not candidate or candidate.get('embedding') is None:
            raise SpeechFailure('voiceprint_candidate_missing')
        return self.profile.add_pending(candidate['embedding'], sample_id=candidate.get('sample_id'),
                                        segment_id=candidate.get('segment_id'), score=candidate.get('score'))

    def apply_profile_samples(self):
        if self.profile is None:
            raise SpeechFailure('voiceprint_profile_unavailable')
        return self.profile.apply_pending()

    def discard_profile_samples(self):
        if self.profile is None:
            raise SpeechFailure('voiceprint_profile_unavailable')
        return self.profile.discard_pending()

    async def recognize(self, segment):
        # Native inference cannot be killed by cancelling the awaiter. Retain
        # the slot until those exact tasks finish, even after a timeout/switch.
        if self.pending:
            raise SpeechFailure('models_busy')
        asr = self._infer(self.transcribe, segment)
        speaker = self._infer(self.verify, segment)
        try:
            owner = await asyncio.wait_for(asyncio.shield(speaker), self.speaker_timeout)
        except TimeoutError:
            raise SpeechFailure('speaker_timeout') from None
        except Exception:
            raise SpeechFailure('speaker_inference_failed') from None
        if owner.identity != 'owner' or owner.status != 'verified' or owner.segment_id != segment.segment_id:
            return None, owner
        if not owner.model_id or not owner.profile_version:
            raise SpeechFailure('speaker_evidence_missing')
        try:
            text = await asyncio.wait_for(asyncio.shield(asr), self.asr_timeout)
        except TimeoutError:
            raise SpeechFailure('asr_timeout') from None
        except Exception:
            raise SpeechFailure('asr_inference_failed') from None
        if not isinstance(text, str) or not text.strip():
            raise SpeechFailure('empty_transcript')
        if len(text) > 2000:
            raise SpeechFailure('transcript_too_long')
        # Keep the ASR transcript as returned after validation. The voice
        # path may use ``strip`` only to decide whether text is empty; it must
        # not remove a Bot name, punctuation, or any other recognized content
        # before submitting the turn.
        return text, owner

    async def drain(self):
        if self.pending:
            await asyncio.gather(*list(self.pending), return_exceptions=True)


def load_speech_models(config, hotwords):
    folders = [Path(str(config.get(key) or '')) for key in
               ('asrModelDir', 'speakerModelDir', 'speakerProfileDir')]
    if any(not str(config.get(key) or '').strip() for key in
           ('asrModelDir', 'speakerModelDir', 'speakerProfileDir')):
        raise SpeechFailure('speech_models_not_configured')
    if not all(path.is_dir() for path in folders):
        raise SpeechFailure('speech_model_directory_missing')
    asr_dir, speaker_dir, profile_dir = folders
    if not all((profile_dir / name).is_file() for name in ('target_profile.json', 'target_profile.npz')):
        raise SpeechFailure('speaker_profile_missing')
    try:
        # Third-party startup output is not a runtime status protocol and can
        # contain arbitrary paths. Only the caller emits allowlisted stages.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            from funasr import AutoModel
            options = {'device': config.get('modelDevice', 'cpu'), 'disable_update': True,
                       'disable_pbar': True, 'disable_log': True}
            asr = ParaformerAdapter(AutoModel(model=str(asr_dir), **options), hotwords=hotwords)
            profile = CAMProfile(profile_dir, AutoModel(model=str(speaker_dir), **options))
    except ImportError:
        raise SpeechFailure('speech_dependencies_missing') from None
    except Exception:
        raise SpeechFailure('speech_models_load_failed') from None
    return SpeechModels(asr.transcribe_segment, SpeakerProfileAdapter(profile).verify_segment, profile=profile)
