"""V13 configuration-matching contract for Laya voice addressing.

The runtime compares one complete role configuration with one complete ASR
transcript.  Offline groups can contain several candidates, but each model call
still receives exactly one candidate snapshot so answer labels and sibling
configurations cannot leak into the model input.
"""
from __future__ import annotations

import inspect
import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from voice_addressing import ContextSnapshot, LayaDecision


_NEGATIVE_KINDS = frozenset({
    "wrong_configuration",
    "mention_only",
    "media_quote",
    "negative_address",
})
_CANDIDATE_KINDS = _NEGATIVE_KINDS | {"correct_configuration"}
_SNAPSHOT_FIELDS = frozenset({
    "bot_id",
    "user_id",
    "profile_version",
    "agent_names",
    "explicit_wake_required",
    "negative_addressing_examples",
    "rules",
    "dialogue_active",
    "recent_reply",
    "wake_names",
})


def _nonempty_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


def _strict_snapshot(value: object) -> ContextSnapshot:
    if not isinstance(value, Mapping):
        raise ValueError("snapshot must be a mapping")
    if not _SNAPSHOT_FIELDS.issuperset(value.keys()):
        raise ValueError("snapshot contains unknown fields")

    def required(name: str) -> str:
        raw = value.get(name)
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"snapshot {name} must be a non-empty string")
        return raw.strip()

    def optional_text(name: str, default: str = "") -> str:
        raw = value.get(name, default)
        if not isinstance(raw, str):
            raise ValueError(f"snapshot {name} must be a string")
        if len(raw) > ContextSnapshot.MAX_TEXT:
            raise ValueError(f"snapshot {name} exceeds the text limit")
        return raw

    def items(name: str) -> tuple[str, ...]:
        raw = value.get(name, ())
        if not isinstance(raw, (list, tuple)):
            raise ValueError(f"snapshot {name} must be a sequence")
        if len(raw) > ContextSnapshot.MAX_ITEMS:
            raise ValueError(f"snapshot {name} exceeds the item limit")
        result = []
        for item in raw:
            if not isinstance(item, str) or not item.strip():
                raise ValueError(
                    f"snapshot {name} entries must be non-empty strings"
                )
            normalized = item.strip()
            if len(normalized) > ContextSnapshot.MAX_TEXT:
                raise ValueError(f"snapshot {name} entry exceeds the text limit")
            result.append(normalized)
        return tuple(result)

    def flag(name: str, default: bool) -> bool:
        raw = value.get(name, default)
        if type(raw) is not bool:
            raise ValueError(f"snapshot {name} must be a boolean")
        return raw

    profile_version = value.get("profile_version")
    if (
        not isinstance(profile_version, (str, int))
        or isinstance(profile_version, bool)
        or (isinstance(profile_version, str) and not profile_version.strip())
    ):
        raise ValueError("snapshot profile_version is invalid")

    return ContextSnapshot(
        bot_id=required("bot_id"),
        user_id=required("user_id"),
        profile_version=(
            profile_version.strip()
            if isinstance(profile_version, str)
            else profile_version
        ),
        agent_names=items("agent_names"),
        explicit_wake_required=flag("explicit_wake_required", True),
        negative_addressing_examples=items("negative_addressing_examples"),
        rules=items("rules"),
        dialogue_active=flag("dialogue_active", False),
        recent_reply=optional_text("recent_reply"),
        wake_names=items("wake_names"),
    )


def _validate_snapshot(snapshot: ContextSnapshot) -> None:
    if not isinstance(snapshot, ContextSnapshot):
        raise ValueError("snapshot must be a ContextSnapshot")
    if type(snapshot.bot_id) is not str or not snapshot.bot_id.strip():
        raise ValueError("snapshot bot_id is invalid")
    if type(snapshot.user_id) is not str or not snapshot.user_id.strip():
        raise ValueError("snapshot user_id is invalid")
    if (
        not isinstance(snapshot.profile_version, (str, int))
        or isinstance(snapshot.profile_version, bool)
        or (
            isinstance(snapshot.profile_version, str)
            and not snapshot.profile_version.strip()
        )
    ):
        raise ValueError("snapshot profile_version is invalid")
    if type(snapshot.explicit_wake_required) is not bool:
        raise ValueError("snapshot explicit_wake_required is invalid")
    if type(snapshot.dialogue_active) is not bool:
        raise ValueError("snapshot dialogue_active is invalid")
    if type(snapshot.recent_reply) is not str:
        raise ValueError("snapshot recent_reply is invalid")
    if len(snapshot.recent_reply) > ContextSnapshot.MAX_TEXT:
        raise ValueError("snapshot recent_reply exceeds the text limit")
    for name in (
        "agent_names",
        "negative_addressing_examples",
        "rules",
        "wake_names",
    ):
        values = getattr(snapshot, name)
        if not isinstance(values, tuple):
            raise ValueError(f"snapshot {name} must be a tuple")
        if len(values) > ContextSnapshot.MAX_ITEMS:
            raise ValueError(f"snapshot {name} exceeds the item limit")
        for item in values:
            if not isinstance(item, str) or not item.strip():
                raise ValueError(f"snapshot {name} contains an invalid entry")
            if len(item) > ContextSnapshot.MAX_TEXT:
                raise ValueError(f"snapshot {name} entry exceeds the text limit")


@dataclass(frozen=True)
class ConfigurationCandidate:
    candidate_id: str
    snapshot: ContextSnapshot
    expected_match: bool
    candidate_kind: str

    def __post_init__(self):
        if type(self.candidate_id) is not str or not self.candidate_id.strip():
            raise ValueError("candidate_id must be a non-empty string")
        object.__setattr__(self, "candidate_id", self.candidate_id.strip())
        _validate_snapshot(self.snapshot)
        if type(self.expected_match) is not bool:
            raise ValueError("expected_match must be a boolean")
        if type(self.candidate_kind) is not str:
            raise ValueError("candidate_kind must be a string")
        kind = self.candidate_kind.strip()
        if kind not in _CANDIDATE_KINDS:
            raise ValueError("unsupported candidate_kind")
        object.__setattr__(self, "candidate_kind", kind)
        if self.expected_match != (kind == "correct_configuration"):
            raise ValueError(
                "candidate_kind and expected_match must describe the same label"
            )

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "ConfigurationCandidate":
        allowed = {
            "candidate_id",
            "snapshot",
            "expected_match",
            "candidate_kind",
        }
        if not isinstance(value, Mapping) or set(value) != allowed:
            raise ValueError("candidate mapping has invalid fields")
        try:
            snapshot = _strict_snapshot(value["snapshot"])
            return cls(
                candidate_id=value["candidate_id"],
                snapshot=snapshot,
                expected_match=value["expected_match"],
                candidate_kind=value["candidate_kind"],
            )
        except (TypeError, ValueError) as error:
            raise ValueError(f"invalid candidate: {error}") from error


@dataclass(frozen=True)
class ConfigurationMatchingGroup:
    group_id: str
    transcript: str
    candidates: tuple[ConfigurationCandidate, ...]

    def __post_init__(self):
        if type(self.group_id) is not str or not self.group_id.strip():
            raise ValueError("group_id must be a non-empty string")
        object.__setattr__(self, "group_id", self.group_id.strip())
        if type(self.transcript) is not str or not self.transcript.strip():
            raise ValueError("transcript must be a non-empty string")
        transcript = self.transcript.strip()
        if len(transcript) > ContextSnapshot.MAX_TEXT:
            raise ValueError("transcript exceeds the text limit")
        object.__setattr__(self, "transcript", transcript)
        if not isinstance(self.candidates, tuple):
            raise ValueError("candidates must be a tuple")
        if not 3 <= len(self.candidates) <= 5:
            raise ValueError("candidates must contain between 3 and 5 items")
        if any(
            not isinstance(candidate, ConfigurationCandidate)
            for candidate in self.candidates
        ):
            raise ValueError("candidates must be ConfigurationCandidate values")
        identifiers = [candidate.candidate_id for candidate in self.candidates]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("candidate_id must be unique within a group")
        if sum(candidate.expected_match for candidate in self.candidates) != 1:
            raise ValueError("group must contain exactly one correct configuration")
        snapshots = [
            tuple(sorted(_snapshot_signature(candidate.snapshot)))
            for candidate in self.candidates
        ]
        if len(set(snapshots)) != len(snapshots):
            raise ValueError("group contains duplicate configuration snapshots")


def _snapshot_signature(snapshot: ContextSnapshot) -> tuple[tuple[str, Any], ...]:
    return tuple(
        (name, getattr(snapshot, name))
        for name in _SNAPSHOT_FIELDS
    )


@dataclass(frozen=True)
class CandidateDecision:
    candidate: ConfigurationCandidate
    decision: LayaDecision

    @property
    def admitted(self) -> bool:
        return self.decision.admitted


@dataclass(frozen=True)
class ConfigurationRanking:
    candidates: tuple[CandidateDecision, ...]
    selected: ConfigurationCandidate | None
    false_match: bool
    correct: bool


def rank_configuration_candidates(
    candidates: Sequence[ConfigurationCandidate],
    decisions: Mapping[str, LayaDecision],
) -> ConfigurationRanking:
    """Select the highest-confidence admitted candidate deterministically."""
    candidates = tuple(candidates)
    if len(candidates) < 2:
        raise ValueError("at least two candidates are required for comparison")
    if any(not isinstance(candidate, ConfigurationCandidate) for candidate in candidates):
        raise ValueError("candidates must be ConfigurationCandidate values")
    identifiers = [candidate.candidate_id for candidate in candidates]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("candidate_id must be unique")
    if not isinstance(decisions, Mapping):
        raise ValueError("decisions must be a mapping")
    if set(decisions) != set(identifiers):
        raise ValueError("decisions must contain exactly one result per candidate")

    resolved = []
    for candidate in candidates:
        value = decisions[candidate.candidate_id]
        if not isinstance(value, LayaDecision):
            raise ValueError("decisions must contain LayaDecision values")
        if (
            not isinstance(value.score, (int, float))
            or isinstance(value.score, bool)
            or not math.isfinite(float(value.score))
        ):
            raise ValueError("candidate decision score must be finite")
        resolved.append(CandidateDecision(candidate, value))

    ordered = tuple(sorted(
        resolved,
        key=lambda item: (
            -float(item.decision.score),
            item.candidate.candidate_id,
        ),
    ))
    admitted = tuple(item for item in ordered if item.decision.admitted)
    selected = admitted[0].candidate if admitted else None
    return ConfigurationRanking(
        candidates=ordered,
        selected=selected,
        false_match=selected is not None and not selected.expected_match,
        correct=selected is not None and selected.expected_match,
    )


async def evaluate_configuration_group(
    group: ConfigurationMatchingGroup,
    evaluator: Callable[
        [ContextSnapshot, str],
        LayaDecision | Awaitable[LayaDecision],
    ],
) -> ConfigurationRanking:
    """Evaluate each candidate separately; never send the whole group."""
    if not isinstance(group, ConfigurationMatchingGroup):
        raise ValueError("group must be a ConfigurationMatchingGroup")
    decisions = {}
    for candidate in group.candidates:
        value = evaluator(candidate.snapshot, group.transcript)
        if inspect.isawaitable(value):
            value = await value
        if not isinstance(value, LayaDecision):
            raise ValueError("configuration evaluator returned an invalid decision")
        decisions[candidate.candidate_id] = value
    return rank_configuration_candidates(group.candidates, decisions)


class LayaConfigurationEvaluator:
    """Call Laya with the frozen V13 single-configuration choice contract."""

    question_id = "configuration_matching"
    positive_choice = "configuration_matches_speech"
    negative_choice = "configuration_does_not_match_speech"
    # Request-shape guard only. The model's tokenizer budget is separate and is
    # verified from the endpoint usage plus training-time token validation.
    MAX_STATE_CHARS = 32768

    def __init__(
        self,
        url: str,
        *,
        model: str,
        threshold: float,
        api_key: str | None = None,
        timeout: float = 2.0,
    ):
        if not isinstance(url, str) or not url.strip():
            raise ValueError("laya_url is required")
        if not isinstance(model, str) or not model.strip():
            raise ValueError("laya_model is required")
        if (
            not isinstance(threshold, (int, float))
            or isinstance(threshold, bool)
            or not 0 <= threshold <= 1
        ):
            raise ValueError("laya_threshold must be between 0 and 1")
        if (
            not isinstance(timeout, (int, float))
            or isinstance(timeout, bool)
            or timeout <= 0
        ):
            raise ValueError("laya_timeout must be positive")
        self.url = url.strip()
        self.model = model.strip()
        self.threshold = float(threshold)
        self.api_key = api_key
        self.timeout = float(timeout)

    def build_state(self, snapshot: ContextSnapshot, text: str) -> str:
        _validate_snapshot(snapshot)
        if not isinstance(text, str) or not text.strip():
            raise ValueError("transcript is required")
        transcript = text.strip()
        if len(transcript) > ContextSnapshot.MAX_TEXT:
            raise ValueError("transcript exceeds the text limit")

        state = "\n".join((
            "[角色配置]",
            f"Bot 标识：{snapshot.bot_id.strip()}",
            f"当前称呼：{'、'.join(snapshot.agent_names)}",
            f"唤醒词：{'、'.join(snapshot.wake_names)}",
            (
                "否定称呼："
                f"{'、'.join(snapshot.negative_addressing_examples)}"
            ),
            f"寻址规则：{'；'.join(snapshot.rules)}",
            "",
            "[对话上下文]",
            f"是否活跃：{'是' if snapshot.dialogue_active else '否'}",
            f"最近回复：{snapshot.recent_reply}",
            f"明确唤醒要求：{'是' if snapshot.explicit_wake_required else '否'}",
            "",
            "[当前转写]",
            transcript,
        ))
        if len(state) > self.MAX_STATE_CHARS:
            raise ValueError(
                f"state exceeds the {self.MAX_STATE_CHARS} character limit"
            )
        return state

    def build_payload(self, snapshot: ContextSnapshot, text: str) -> dict:
        if not isinstance(snapshot, ContextSnapshot):
            raise ValueError("snapshot must be a ContextSnapshot")
        return {
            "model": self.model,
            "state": self.build_state(snapshot, text),
            "questions": {
                self.question_id: {
                    "type": "choice",
                    "instructions": (
                        "判断当前转写是否匹配给出的角色配置与寻址规则。"
                        "只依据完整配置和转写，不要把提及角色名、媒体引述、"
                        "否定称呼或旁人说话当作匹配。"
                    ),
                    "criteria": [
                        self.positive_choice,
                        self.negative_choice,
                    ],
                },
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
        usage = value.get("usage")
        if usage is not None:
            if not isinstance(usage, Mapping):
                raise ValueError("invalid_laya_response")
            truncated = usage.get("truncated", False)
            dropped = usage.get("state_tokens_dropped", 0)
            truncated_questions = usage.get("truncated_questions", ())
            if (
                type(truncated) is not bool
                or type(dropped) is not int
                or dropped < 0
                or not isinstance(truncated_questions, (list, tuple))
                or any(
                    not isinstance(question, str)
                    for question in truncated_questions
                )
            ):
                raise ValueError("invalid_laya_response")
            if truncated or dropped > 0 or truncated_questions:
                raise ValueError("laya_response_truncated")
        choice = answer.get("choice")
        if choice not in (self.positive_choice, self.negative_choice):
            raise ValueError("invalid_laya_response")
        raw_score = answer.get(
            "x_jev_confidence",
            answer.get("confidence", answer.get("score")),
        )
        if (
            not isinstance(raw_score, (int, float))
            or isinstance(raw_score, bool)
            or not math.isfinite(float(raw_score))
        ):
            raise ValueError("invalid_laya_response")
        score = max(0.0, min(1.0, float(raw_score)))
        model_id = value.get("model", self.model)
        if not isinstance(model_id, str) or not model_id.strip():
            model_id = self.model
        admitted = (
            choice == self.positive_choice
            and score >= self.threshold
        )
        return LayaDecision(
            admitted=admitted,
            score=score,
            model_id=model_id,
            model_version=self.model,
            reason="accepted" if admitted else "rejected",
        )

    async def __call__(
        self,
        snapshot: ContextSnapshot,
        text: str,
    ) -> LayaDecision:
        import aiohttp

        headers = {}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        timeout = aiohttp.ClientTimeout(total=self.timeout)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                self.url,
                json=self.build_payload(snapshot, text),
                headers=headers,
            ) as response:
                if response.status != 200:
                    raise RuntimeError(f"laya_http_{response.status}")
                return self.parse_response(await response.json())
