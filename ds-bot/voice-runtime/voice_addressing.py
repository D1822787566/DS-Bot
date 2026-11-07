"""Role selection and fail-closed semantic admission for Voice Addressing V1.

This module deliberately contains no model implementation.  The production Laya
checkpoint is selected only after the re-evaluation work freezes its contract;
the adapter is injected so the gateway can exercise the same binary decision
path in tests and in a configured runtime.
"""
from __future__ import annotations

import inspect
import math
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Mapping, Sequence

from audio_adapter import OwnerDecision


@dataclass(frozen=True)
class RouteDecision:
    bot_id: str | None
    reason: str
    matched_wake_names: tuple[str, ...] = ()


class CharacterRouter:
    """Select one role using the fixed V1 priority order.

    Explicit, unique role names win over the currently active session, followed
    by the user/device default.  A duplicate name is always ambiguous, even if
    one of the candidates happens to be active.
    """

    def __init__(self, wake_names: Mapping[str, Sequence[str]]):
        self._wake_names: dict[str, tuple[str, ...]] = {}
        for bot_id, names in wake_names.items():
            if not isinstance(bot_id, str) or not bot_id.strip():
                raise ValueError("bot_id is required")
            if isinstance(names, str):
                raise ValueError("wake names must be a sequence")
            normalized = tuple(dict.fromkeys(
                name.strip() for name in names
                if isinstance(name, str) and name.strip()))
            self._wake_names[bot_id] = normalized

    @property
    def wake_names(self) -> Mapping[str, tuple[str, ...]]:
        return self._wake_names

    def select(self, text: str, *, active_bot_id: str | None,
               default_bot_id: str | None) -> RouteDecision:
        if not isinstance(text, str) or not text.strip():
            return RouteDecision(None, "empty_text")

        matches: list[tuple[str, str]] = []
        for bot_id, names in self._wake_names.items():
            for name in names:
                if name in text:
                    matches.append((bot_id, name))

        bot_ids = tuple(dict.fromkeys(bot_id for bot_id, _ in matches))
        if len(bot_ids) > 1:
            return RouteDecision(None, "ambiguous_wake_name",
                                 tuple(name for _, name in matches))
        if len(bot_ids) == 1:
            return RouteDecision(bot_ids[0], "explicit_wake_name",
                                 tuple(name for _, name in matches))
        if active_bot_id and active_bot_id in self._wake_names:
            return RouteDecision(active_bot_id, "active_session")
        if default_bot_id and default_bot_id in self._wake_names:
            return RouteDecision(default_bot_id, "default_bot")
        return RouteDecision(None, "no_target")


@dataclass(frozen=True)
class ContextSnapshot:
    """Bounded, read-only projection used by Laya.

    The shape intentionally has no raw audio, credentials, or full memory
    fields.  Callers can construct it from a protocol mapping with
    :meth:`from_mapping`, which ignores unrecognised fields and applies the
    V1 length limits.
    """

    bot_id: str
    user_id: str
    profile_version: str | int
    agent_names: tuple[str, ...] = ()
    explicit_wake_required: bool = True
    negative_addressing_examples: tuple[str, ...] = ()
    rules: tuple[str, ...] = ()
    dialogue_active: bool = False
    recent_reply: str = ""
    wake_names: tuple[str, ...] = ()

    MAX_TEXT = 2000
    MAX_ITEMS = 32

    def __post_init__(self):
        if not self.bot_id.strip() or not self.user_id.strip():
            raise ValueError("snapshot identity is required")
        if len(self.recent_reply) > self.MAX_TEXT:
            raise ValueError("recent_reply exceeds snapshot limit")
        for values in (self.agent_names, self.negative_addressing_examples,
                       self.rules, self.wake_names):
            if len(values) > self.MAX_ITEMS or any(len(item) > self.MAX_TEXT for item in values):
                raise ValueError("snapshot field exceeds limit")

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "ContextSnapshot":
        allowed = {
            "bot_id", "user_id", "profile_version", "agent_names",
            "explicit_wake_required", "negative_addressing_examples", "rules",
            "dialogue_active", "recent_reply", "wake_names",
        }
        if not isinstance(value, Mapping) or not allowed.issuperset(value.keys()):
            raise ValueError("invalid_context_snapshot")

        def items(name: str) -> tuple[str, ...]:
            raw = value.get(name, ())
            if isinstance(raw, str) or raw is None:
                raise ValueError("invalid_context_snapshot")
            return tuple(item.strip() for item in raw
                         if isinstance(item, str) and item.strip())

        recent = value.get("recent_reply", "")
        if not isinstance(recent, str):
            raise ValueError("invalid_context_snapshot")
        profile_version = value.get("profile_version", 0)
        if not isinstance(profile_version, (str, int)) or isinstance(profile_version, bool):
            raise ValueError("invalid_context_snapshot")
        bot_id = value.get("bot_id", "")
        user_id = value.get("user_id", "")
        if not isinstance(bot_id, str) or not isinstance(user_id, str):
            raise ValueError("invalid_context_snapshot")
        return cls(
            bot_id=bot_id,
            user_id=user_id,
            profile_version=profile_version,
            agent_names=items("agent_names"),
            explicit_wake_required=bool(value.get("explicit_wake_required", True)),
            negative_addressing_examples=items("negative_addressing_examples"),
            rules=items("rules"),
            dialogue_active=bool(value.get("dialogue_active", False)),
            recent_reply=recent[: cls.MAX_TEXT],
            wake_names=items("wake_names"),
        )


@dataclass(frozen=True)
class LayaDecision:
    admitted: bool
    score: float
    model_id: str
    model_version: str
    reason: str


@dataclass(frozen=True)
class AdmissionResult:
    admitted: bool
    reason: str
    bot_id: str | None = None
    route: RouteDecision | None = None
    snapshot: ContextSnapshot | None = None
    laya: LayaDecision | None = None


SnapshotProvider = Callable[[str], ContextSnapshot | Mapping[str, object] | Awaitable[ContextSnapshot | Mapping[str, object]]]
LayaEvaluator = Callable[[ContextSnapshot, str], LayaDecision | Awaitable[LayaDecision]]


class AdmissionCoordinator:
    """Combine role routing, snapshot lookup, Laya and CAM++ in one gate."""

    def __init__(self, router: CharacterRouter, snapshot_provider: SnapshotProvider,
                 laya_evaluator: LayaEvaluator):
        self.router = router
        self.snapshot_provider = snapshot_provider
        self.laya_evaluator = laya_evaluator

    async def evaluate(self, text: str, owner: OwnerDecision, *, segment_id: int,
                       active_bot_id: str | None,
                       default_bot_id: str | None) -> AdmissionResult:
        if owner.identity != "owner" or owner.status != "verified":
            return AdmissionResult(False, "owner_not_verified")
        if owner.segment_id != segment_id:
            return AdmissionResult(False, "segment_mismatch")

        route = self.router.select(text, active_bot_id=active_bot_id,
                                   default_bot_id=default_bot_id)
        if route.bot_id is None:
            return AdmissionResult(False, route.reason, route=route)

        try:
            snapshot = self.snapshot_provider(route.bot_id)
            if inspect.isawaitable(snapshot):
                snapshot = await snapshot
            if snapshot is None:
                raise ValueError("empty_context_snapshot")
            if not isinstance(snapshot, ContextSnapshot):
                snapshot = ContextSnapshot.from_mapping(snapshot)
            if snapshot.bot_id != route.bot_id:
                raise ValueError("snapshot_bot_mismatch")
        except Exception:
            return AdmissionResult(False, "snapshot_unavailable", route=route,
                                   bot_id=route.bot_id)

        try:
            laya = self.laya_evaluator(snapshot, text)
            if inspect.isawaitable(laya):
                laya = await laya
            if not isinstance(laya, LayaDecision):
                raise ValueError("invalid_laya_result")
        except Exception:
            return AdmissionResult(False, "laya_unavailable", route=route,
                                   bot_id=route.bot_id, snapshot=snapshot)

        if laya.admitted is not True:
            return AdmissionResult(False, "laya_rejected", route=route,
                                   bot_id=route.bot_id, snapshot=snapshot, laya=laya)
        return AdmissionResult(True, "admitted", bot_id=route.bot_id,
                               route=route, snapshot=snapshot, laya=laya)


class LayaHttpEvaluator:
    """Call a configured Laya System-1 endpoint with a bounded V1 prompt.

    The endpoint and threshold are always explicit configuration.  This class
    does not select a checkpoint or silently fall back to the historical model;
    the caller must provide the re-evaluated model identifier.
    """

    question_id = "addressing"
    positive_choice = "addressed_to_agent"
    negative_choice = "ambient_speech"

    def __init__(self, url: str, *, model: str, threshold: float,
                 api_key: str | None = None, timeout: float = 2.0):
        if not isinstance(url, str) or not url.strip():
            raise ValueError("laya_url is required")
        if not isinstance(model, str) or not model.strip():
            raise ValueError("laya_model is required")
        if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not 0 <= threshold <= 1:
            raise ValueError("laya_threshold must be between 0 and 1")
        if timeout <= 0:
            raise ValueError("laya_timeout must be positive")
        self.url = url.strip()
        self.model = model.strip()
        self.threshold = float(threshold)
        self.api_key = api_key
        self.timeout = float(timeout)

    def build_payload(self, snapshot: ContextSnapshot, text: str) -> dict:
        if not isinstance(snapshot, ContextSnapshot) or not isinstance(text, str) or not text.strip():
            raise ValueError("snapshot and text are required")
        state = "\n".join((
            f"目标 Bot：{snapshot.bot_id}",
            f"角色唤醒词：{'、'.join(snapshot.wake_names)}",
            f"明确唤醒要求：{'是' if snapshot.explicit_wake_required else '否'}",
            f"是否处于活动对话：{'是' if snapshot.dialogue_active else '否'}",
            f"最近一条角色回复：{snapshot.recent_reply}",
            f"已确认的角色称呼：{'、'.join(snapshot.agent_names)}",
            f"否定称呼：{'、'.join(snapshot.negative_addressing_examples)}",
            f"寻址规则：{'；'.join(snapshot.rules)}",
            f"当前语音转写：{text.strip()}",
        ))
        return {
            "model": self.model,
            "state": state,
            "questions": {
                self.question_id: {
                    "type": "choice",
                    "instructions": "判断当前语音是否是在对目标角色说话，而不是旁人、视频、电视、直播或环境声音。",
                    "criteria": [self.positive_choice, self.negative_choice],
                }
            },
        }

    def parse_response(self, value: Mapping[str, object]) -> LayaDecision:
        if not isinstance(value, Mapping):
            raise ValueError("invalid_laya_response")
        answers = value.get("answers")
        if not isinstance(answers, Mapping):
            raise ValueError("invalid_laya_response")
        answer = answers.get(self.question_id)
        if not isinstance(answer, Mapping):
            raise ValueError("invalid_laya_response")
        choice = answer.get("choice")
        if not isinstance(choice, str) or choice not in (self.positive_choice, self.negative_choice):
            raise ValueError("invalid_laya_response")
        raw_score = answer.get("x_jev_confidence", answer.get("confidence", answer.get("score")))
        if not isinstance(raw_score, (int, float)) or isinstance(raw_score, bool) or not math.isfinite(float(raw_score)):
            raise ValueError("invalid_laya_response")
        score = max(0.0, min(1.0, float(raw_score)))
        model_id = value.get("model", self.model)
        if not isinstance(model_id, str) or not model_id.strip():
            model_id = self.model
        return LayaDecision(
            admitted=choice == self.positive_choice and score >= self.threshold,
            score=score,
            model_id=model_id,
            model_version=self.model,
            reason="accepted" if choice == self.positive_choice and score >= self.threshold else "rejected",
        )

    async def __call__(self, snapshot: ContextSnapshot, text: str) -> LayaDecision:
        import aiohttp

        headers = {}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        timeout = aiohttp.ClientTimeout(total=self.timeout)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(self.url, json=self.build_payload(snapshot, text), headers=headers) as response:
                if response.status != 200:
                    raise RuntimeError(f"laya_http_{response.status}")
                return self.parse_response(await response.json())


class UnavailableLayaEvaluator:
    """Fail-closed placeholder until a re-evaluated Laya model is configured."""

    async def __call__(self, snapshot: ContextSnapshot, text: str) -> LayaDecision:
        return LayaDecision(False, 0.0, "unconfigured", "unconfigured", "laya_unavailable")
