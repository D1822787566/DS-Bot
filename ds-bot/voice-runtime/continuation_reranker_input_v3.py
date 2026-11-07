"""Reranker input with non-decisive conversational cue features."""
from __future__ import annotations

from dataclasses import dataclass
import unicodedata

from continuation_input import ContinuationContext
from laya_configuration_matching import _validate_snapshot
from voice_addressing import ContextSnapshot


def _contains(text: str, values: tuple[str, ...]) -> bool:
    return any(value in text for value in values)


@dataclass(frozen=True)
class ContinuationCues:
    reference: bool
    handoff: bool
    other_or_environment: bool
    negation: bool

    def to_text(self) -> str:
        return "\n".join((
            f"回指线索：{'是' if self.reference else '否'}",
            f"承接线索：{'是' if self.handoff else '否'}",
            f"旁人或环境线索：{'是' if self.other_or_environment else '否'}",
            f"否定线索：{'是' if self.negation else '否'}",
        ))


def extract_continuation_cues(transcript: str) -> ContinuationCues:
    if not isinstance(transcript, str) or not transcript.strip():
        raise ValueError("transcript is required")
    normalized = unicodedata.normalize("NFKC", transcript.strip())
    return ContinuationCues(
        reference=_contains(normalized, ("刚刚", "刚才", "你说", "意思", "上次")),
        handoff=_contains(normalized, ("继续", "接着", "然后", "那就", "再")),
        other_or_environment=_contains(
            normalized, ("小王", "别人", "旁人", "大家", "视频", "电视", "直播", "电影", "新闻")
        ),
        negation=_contains(normalized, ("不是", "不在问", "别", "不要")),
    )


@dataclass(frozen=True)
class RerankerPairV3:
    query: str
    passage: str


def build_reranker_pair_v3(
    snapshot: ContextSnapshot,
    context: ContinuationContext,
    transcript: str,
) -> RerankerPairV3:
    _validate_snapshot(snapshot)
    if not isinstance(context, ContinuationContext):
        raise ValueError("continuation context is required")
    if not isinstance(transcript, str) or not transcript.strip():
        raise ValueError("transcript is required")
    query = transcript.strip()
    if len(query) > ContextSnapshot.MAX_TEXT:
        raise ValueError("transcript exceeds the text limit")
    cues = extract_continuation_cues(query)
    target_name = (snapshot.agent_names or snapshot.wake_names or (snapshot.bot_id,))[0]
    passage = "\n".join((
        "[目标角色与上一轮对话]",
        f"目标角色：{snapshot.bot_id.strip()}",
        f"角色称呼：{target_name}",
        f"唤醒词：{'、'.join(snapshot.wake_names)}",
        f"用户上一句：{context.last_user_text.strip()}",
        f"{target_name}上一句回复：{context.last_agent_reply.strip()}",
        "",
        "[会话状态]",
        "第一条指令已完成：是",
        f"已准入回合数：{context.turn_count}",
        f"距上一条准入语音秒数：{float(context.seconds_since_last_turn):g}",
        "",
        "[当前转写的非决策性线索]",
        cues.to_text(),
        f"寻址规则：{'；'.join(snapshot.rules)}",
    ))
    if len(passage) > 32768:
        raise ValueError("reranker passage exceeds the character limit")
    return RerankerPairV3(query=query, passage=passage)

