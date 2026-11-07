"""Isolated HTTP adapter for a candidate wake-gated continuation scorer.

The adapter keeps the existing Laya/System-1 envelope and fixed choice names,
but sends the post-wake continuation input.  It is only selected when the
caller explicitly configures a candidate endpoint; no historical checkpoint is
chosen here.
"""
from __future__ import annotations

import math
from typing import Mapping

from continuation_input import ContinuationContext, build_continuation_nli_pair
from continuation_runtime_input import FROZEN_CANDIDATE_ID, build_continuation_runtime_state
from voice_addressing import ContextSnapshot


class ContinuationHttpEvaluator:
    question_id = "configuration_matching"
    positive_choice = "configuration_matches_speech"
    negative_choice = "configuration_does_not_match_speech"
    instructions = "判断当前语音是否仍在继续对已唤醒的目标角色说话，而不是旁人、视频、电视、直播或环境声音。"

    def __init__(self, url: str, *, model: str, timeout: float = 2.0,
                 api_key: str | None = None, mode: str = "legacy_nli"):
        if not isinstance(url, str) or not url.strip():
            raise ValueError("continuation_url is required")
        if not isinstance(model, str) or not model.strip():
            raise ValueError("continuation_model is required")
        if (not isinstance(timeout, (int, float)) or isinstance(timeout, bool)
                or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError("continuation_timeout must be positive")
        if mode not in ("legacy_nli", "frozen_llm"):
            raise ValueError("invalid_continuation_mode")
        if mode == "frozen_llm" and model.strip() != FROZEN_CANDIDATE_ID:
            raise ValueError("invalid_frozen_continuation_model")
        self.url = url.strip()
        self.model = model.strip()
        self.timeout = float(timeout)
        self.api_key = api_key
        self.mode = mode
        self._session = None
        self._closed = False

    def build_payload(self, snapshot: ContextSnapshot, context: ContinuationContext,
                      text: str) -> dict:
        if self.mode == "frozen_llm":
            state = build_continuation_runtime_state(snapshot, context, text)
        else:
            pair = build_continuation_nli_pair(snapshot, context, text)
            state = "\n".join((pair.premise, "", "[当前转写判断]", pair.hypothesis))
        return {
            "model": self.model,
            "state": state,
            "questions": {
                self.question_id: {
                    "type": "choice",
                    "instructions": self.instructions,
                    "criteria": [self.positive_choice, self.negative_choice],
                }
            },
        }

    def parse_response(self, value: Mapping[str, object]) -> float:
        if not isinstance(value, Mapping):
            raise ValueError("invalid_continuation_response")
        if self.mode == "frozen_llm":
            if value.get("model") != self.model:
                raise ValueError("continuation_model_mismatch")
            if "error" in value:
                raise ValueError("invalid_continuation_response")
            usage = value.get("usage", {})
            if not isinstance(usage, Mapping):
                raise ValueError("invalid_continuation_response")
            if (usage.get("truncated") or usage.get("state_tokens_dropped")
                    or usage.get("truncated_questions")):
                raise ValueError("continuation_response_truncated")
        answers = value.get("answers")
        if not isinstance(answers, Mapping):
            raise ValueError("invalid_continuation_response")
        answer = answers.get(self.question_id)
        if not isinstance(answer, Mapping):
            raise ValueError("invalid_continuation_response")
        if self.mode == "frozen_llm" and set(answers) != {self.question_id}:
            raise ValueError("invalid_continuation_response")
        choice = answer.get("choice")
        if choice not in (self.positive_choice, self.negative_choice):
            raise ValueError("invalid_continuation_response")
        raw = answer.get("x_jev_confidence", answer.get("confidence"))
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ValueError("invalid_continuation_response")
        confidence = float(raw)
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("invalid_continuation_response")
        if self.mode == "frozen_llm":
            if any(isinstance(answer[name], bool) or not isinstance(answer[name], (int, float))
                   or answer[name] != confidence
                   for name in ("confidence", "x_jev_confidence") if name in answer):
                raise ValueError("invalid_continuation_response")
            if (choice, confidence) not in ((self.positive_choice, 1),
                                             (self.positive_choice, .5),
                                             (self.negative_choice, 1)):
                raise ValueError("invalid_continuation_compatibility_code")
        return confidence if choice == self.positive_choice else 1.0 - confidence

    async def __call__(self, snapshot: ContextSnapshot,
                       context: ContinuationContext, text: str) -> float:
        import aiohttp

        if self._closed:
            raise RuntimeError("continuation_client_closed")
        payload = self.build_payload(snapshot, context, text)
        headers = {}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        if self._session is None:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout))
        async with self._session.post(self.url, json=payload, headers=headers,
                                      allow_redirects=False) as response:
            if response.status != 200:
                raise RuntimeError(f"continuation_http_{response.status}")
            return self.parse_response(await response.json())

    async def aclose(self) -> None:
        """Release the reusable connection when the owning runtime stops."""
        self._closed = True
        if self._session is not None:
            await self._session.close()


