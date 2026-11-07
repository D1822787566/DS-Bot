import pytest
import warnings

from wake_mapping import WakeMapping
from windows_wake import build_keyword_table

def test_wake_table_can_keep_supported_bots_when_one_name_is_not_in_model_vocabulary(tmp_path):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from pypinyin import pinyin
        from pypinyin.contrib.tone_convert import to_finals_tone, to_initials
        pieces = []
        for syllable in pinyin("华子"):
            pieces.extend(piece for piece in (
                to_initials(syllable[0], strict=False),
                to_finals_tone(syllable[0], strict=False),
            ) if piece)
    (tmp_path / "tokens.txt").write_text("\n".join(pieces), encoding="utf-8")
    mapping = WakeMapping("v1", {"supported": ("华子",), "unsupported": ("Chief",)})

    table = build_keyword_table(mapping, tmp_path / "tokens.txt", strict=False)

    assert table.bot_by_keyword == {"wake_0": "supported"}
    assert table.unsupported == (("unsupported", "Chief"),)
    with pytest.raises(ValueError, match="unsupported_wake_name"):
        build_keyword_table(mapping, tmp_path / "tokens.txt")
