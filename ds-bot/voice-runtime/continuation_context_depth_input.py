"""Bounded context ablations for offline use only."""
from __future__ import annotations

from dataclasses import replace

from continuation_reranker_input_v3 import RerankerPairV3, build_reranker_pair_v3
from voice_addressing import ContextSnapshot


def build_depth_reranker_pair(snapshot, context, transcript, history):
    """Add earlier turns without changing V3's most recent turn or score cues.

    An empty history hides conversation text but preserves the same known
    session state. This ablation must not be selected by the live Gateway.
    """
    if not isinstance(history, (list, tuple)) or len(history) > 3:
        raise ValueError("history must contain zero to three complete turns")
    for turn in history:
        if not isinstance(turn, (tuple, list)) or len(turn) != 2:
            raise ValueError("each history turn requires user and agent text")
        if any(not isinstance(text, str) or not text.strip()
               or len(text) > ContextSnapshot.MAX_TEXT for text in turn):
            raise ValueError("history text must be nonempty and bounded")
    base = build_reranker_pair_v3(snapshot, context, transcript)
    if not history:
        hidden = replace(context, last_user_text="未提供", last_agent_reply="未提供")
        return build_reranker_pair_v3(snapshot, hidden, transcript)
    if tuple(history[-1]) != (context.last_user_text, context.last_agent_reply):
        raise ValueError("last history turn differs from continuation context")
    if len(history) == 1:
        return base
    earlier = ["[更早的连续对话]"]
    for index, (user, agent) in enumerate(history[:-1], start=1):
        earlier.extend((f"第{index}轮用户：{user}", f"第{index}轮角色回复：{agent}"))
    passage = "\n".join(earlier) + "\n\n" + base.passage
    if len(passage) > 32768:
        raise ValueError("context-depth passage exceeds the bot limit")
    return RerankerPairV3(query=base.query, passage=passage)

