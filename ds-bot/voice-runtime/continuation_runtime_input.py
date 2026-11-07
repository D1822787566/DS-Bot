"""Frozen 053 continuation serialization for associated runtime turns."""
from __future__ import annotations

from continuation_input import ContinuationContext
from continuation_reranker_input_v3 import build_reranker_pair_v3
from voice_addressing import ContextSnapshot


FROZEN_CANDIDATE_ID = "deepseek-flash-continuation-prompt-v2-053"


def build_continuation_runtime_state(
    snapshot: ContextSnapshot,
    context: ContinuationContext,
    transcript: str,
) -> str:
    """Preserve the validated passage/query format without sending internal IDs.

    The historical experiment builders remain unchanged. Runtime callers must
    supply complete, associated turns; a snapshot reply alone is not a turn.
    """
    if not isinstance(context, ContinuationContext) or not context.turns:
        raise ValueError("runtime continuation requires one to three complete turns")
    pair = build_reranker_pair_v3(snapshot, context, transcript)
    passage = pair.passage
    if len(context.turns) > 1:
        earlier = ["[更早的连续对话]"]
        for index, turn in enumerate(context.turns[:-1], start=1):
            earlier.extend((f"第{index}轮用户：{turn.user_text}",
                            f"第{index}轮角色回复：{turn.agent_reply}"))
        passage = "\n".join(earlier) + "\n\n" + passage
    state = passage + "\n\n[待判断的当前转写]\n" + pair.query
    if len(state) > 32768:
        raise ValueError("continuation state exceeds the character limit")
    return state

