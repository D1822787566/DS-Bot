"""Small explicit confirmation parser for the clarification turn."""
from __future__ import annotations

import re
import unicodedata


def parse_confirmation(text: str) -> bool | None:
    """Return True/False only for explicit confirmation; otherwise None."""
    if not isinstance(text, str) or not text.strip():
        return None
    # ASR may terminate an explicit "是的" with sentence punctuation.  Keep
    # question marks: "是的?" does not provide an affirmative confirmation.
    normalized = unicodedata.normalize("NFKC", text).strip().rstrip("。.! \t\r\n")
    negative = ("不是", "不在和你说", "我在和别人说", "我在问别人", "没有")
    if any(phrase in normalized for phrase in negative):
        return False
    positive = ("是的", "我在和你说", "对", "是")
    if normalized in positive:
        return True
    # Paraformer normally omits commas. Require the whole explicit address
    # statement, rather than accepting every sentence starting with "是的".
    if re.fullmatch(r"(?:是的|对)我(?:是)?在(?:和|跟)你说(?:话)?", normalized):
        return True
    if normalized.startswith(("是的，", "是的,", "对，", "对,", "我在和你说")):
        return True
    if normalized.startswith(("嗯，", "嗯,", "嗯。", "嗯。")) and len(normalized) > 1:
        return True
    return None
