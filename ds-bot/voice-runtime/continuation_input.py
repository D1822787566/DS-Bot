"""Bounded input construction for wake-gated continuation admission."""
from __future__ import annotations

from dataclasses import dataclass
import math

from laya_configuration_matching import _validate_snapshot
from voice_addressing import ContextSnapshot


@dataclass(frozen=True)
class ContinuationTurn:
    """One accepted input and its associated complete generated reply."""

    input_id: str
    response_id: str
    user_text: str
    agent_reply: str

    def __post_init__(self) -> None:
        for name in ("input_id", "response_id", "user_text", "agent_reply"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} is required")
            if len(value) > ContextSnapshot.MAX_TEXT:
                raise ValueError(f"{name} exceeds the text limit")


@dataclass(frozen=True)
class ContinuationContext:
    """Ephemeral context for one semantic continuation decision."""

    turn_count: int
    last_user_text: str
    last_agent_reply: str
    seconds_since_last_turn: float
    turns: tuple[ContinuationTurn, ...] = ()

    def __post_init__(self) -> None:
        if type(self.turn_count) is not int or self.turn_count < 1:
            raise ValueError("turn_count must be a positive integer")
        for name, value in (("last_user_text", self.last_user_text),
                            ("last_agent_reply", self.last_agent_reply)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} is required")
            if len(value) > ContextSnapshot.MAX_TEXT:
                raise ValueError(f"{name} exceeds the text limit")
        if (isinstance(self.seconds_since_last_turn, bool)
                or not isinstance(self.seconds_since_last_turn, (int, float))
                or not math.isfinite(float(self.seconds_since_last_turn))
                or self.seconds_since_last_turn < 0):
            raise ValueError("seconds_since_last_turn must be a finite nonnegative number")
        if (not isinstance(self.turns, tuple) or len(self.turns) > 3
                or any(not isinstance(turn, ContinuationTurn) for turn in self.turns)
                or len(self.turns) > self.turn_count):
            raise ValueError("turns must contain at most three associated complete turns")
        if self.turns:
            if (len({turn.input_id for turn in self.turns}) != len(self.turns)
                    or len({turn.response_id for turn in self.turns}) != len(self.turns)):
                raise ValueError("continuation turns require unique associations")
            last = self.turns[-1]
            if (last.user_text, last.agent_reply) != (self.last_user_text, self.last_agent_reply):
                raise ValueError("last complete turn differs from continuation context")


@dataclass(frozen=True)
class ContinuationNliPair:
    premise: str
    hypothesis: str


def build_continuation_nli_pair(
    snapshot: ContextSnapshot,
    context: ContinuationContext,
    transcript: str,
) -> ContinuationNliPair:
    """Build a label-free pair for the post-wake semantic gate.

    Session identifiers, candidate labels, answers and evaluation metadata are
    deliberately absent. The full transcript is preserved and rejected when
    it exceeds the bounded snapshot text limit.
    """
    _validate_snapshot(snapshot)
    if not isinstance(context, ContinuationContext):
        raise ValueError("continuation context is required")
    if not isinstance(transcript, str) or not transcript.strip():
        raise ValueError("transcript is required")
    transcript = transcript.strip()
    if len(transcript) > ContextSnapshot.MAX_TEXT:
        raise ValueError("transcript exceeds the text limit")

    premise = "\n".join((
        "[目标角色配置]",
        f"角色标识：{snapshot.bot_id.strip()}",
        f"当前称呼：{'、'.join(snapshot.agent_names)}",
        f"唤醒词：{'、'.join(snapshot.wake_names)}",
        f"否定称呼：{'、'.join(snapshot.negative_addressing_examples)}",
        f"寻址规则：{'；'.join(snapshot.rules)}",
        "",
        "[短时会话上下文]",
        "已完成第一条指令：是",
        f"已准入回合数：{context.turn_count}",
        f"上一条用户语句：{context.last_user_text.strip()}",
        f"最近角色回复：{context.last_agent_reply.strip()}",
        f"距上一条准入语音秒数：{float(context.seconds_since_last_turn):g}",
        "",
        "[当前判断任务]",
        "判断当前转写是否是在继续对目标角色说话。",
    ))
    if len(premise) > 32768:
        raise ValueError("continuation premise exceeds the bot limit")
    hypothesis = (
        f"当前转写“{transcript}”是在继续对目标角色说话，"
        "并且应当提交给该角色。"
    )
    if len(hypothesis) > 32768:
        raise ValueError("continuation hypothesis exceeds the bot limit")
    return ContinuationNliPair(premise=premise, hypothesis=hypothesis)

