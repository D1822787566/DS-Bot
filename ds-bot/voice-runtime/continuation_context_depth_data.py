"""Offline paired context-depth questions, with no training or runtime changes."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path


_NAMES = ("栖弦", "望舒")
_TOPICS = (
    ("修补帐篷", "外帐接缝", "换用防水胶带"),
    ("整理底片", "拍摄日期", "先按胶卷编号分组"),
    ("制作木勺", "木纹方向", "改用小刀慢慢修整"),
    ("规划骑行路线", "沿途补水点", "改走河岸支线"),
)
_TEMPLATES = (
    ("followup", "你上面说先核对{detail}，能讲讲检查方法吗", "小岚，你上面说先核对{detail}，能讲讲检查方法吗"),
    ("explicit_target", "{name}，要是{detail}有问题，你会让我先{alternative}吗", "{other}，要是{detail}有问题，你会让我先{alternative}吗"),
    ("role_mention", "你来评评{other}对{action}的建议靠谱吗", "小岚，你来评评{name}对{action}的建议靠谱吗"),
    ("other_role", "帮我把{action}的下一步列出来，{name}", "帮我把{action}的下一步列出来，{other}"),
    ("media_quote", "刚才视频里那段{action}的建议，你能替我找出问题吗", "节目里的讲解员说『{name}，把{detail}检查一遍』"),
    ("negation", "先别复述了，我要你解释{detail}的判断依据", "我没在问你，这句话是问旁边小岚的：{detail}怎么检查"),
    ("topic_change", "{action}先放一下，你陪我练习自我介绍吧", "小岚，{action}先放一下，我们聊下晚饭吧"),
    ("history_reference", "照你最早提出的那个办法，下一步怎样落实", "小岚，照你最早提出的那个办法，下一步怎样落实"),
    ("ambiguous_short", "可以，那就照这个继续", "可以，那就照这个继续"),
    ("ambiguous_deictic", "这里具体该怎么弄", "这里具体该怎么弄"),
)


def build_context_depth_dataset():
    """Keep each question fixed while exposing suffixes of one three-turn history."""
    rows = []
    for role_index, name in enumerate(_NAMES):
        other = _NAMES[1 - role_index]
        for topic_index, (action, detail, alternative) in enumerate(_TOPICS):
            for kind in ("informative", "repetitive"):
                if kind == "informative":
                    earlier = [
                        {"user": f"{name}，帮我为{action}做准备。小岚建议{alternative}，我想先听你的方案。",
                         "agent": f"我建议先核对{detail}，再决定是否{alternative}。"},
                        {"user": f"你刚说的{detail}为什么要优先检查？",
                         "agent": f"因为{detail}会影响后续安排。先确认它的情况，条件不足再{alternative}。"},
                    ]
                else:
                    earlier = [
                        {"user": f"{name}，我们聊聊{action}这件事，先不决定做法。",
                         "agent": f"可以，我们就讨论{action}，暂时不确定具体步骤。"},
                        {"user": f"我还在考虑{action}，暂时没想好细节。",
                         "agent": f"好，我们可以慢慢讨论{action}，不用急着决定。"},
                    ]
                latest = {"user": "这个话题我还想听你再说说。",
                          "agent": "好的，你还有哪里想让我说明？"}
                full = earlier + [latest]
                for category, positive, negative in _TEMPLATES:
                    scenario = f"depth-{role_index}-{topic_index}-{kind}-{category}"
                    for label, template in (("addressed", positive), ("ambient", negative)):
                        text = template.format(name=name, other=other, action=action,
                                               detail=detail, alternative=alternative)
                        for depth in range(4):
                            rows.append({
                                "sample_id": f"{scenario}-{label}-d{depth}",
                                "case_id": f"{scenario}-{label}", "group_id": f"{scenario}-d{depth}",
                                "label": label, "category": category, "text": text,
                                "context_depth": str(depth), "history_kind": kind,
                                "history_json": json.dumps(full[-depth:] if depth else [], ensure_ascii=False),
                                "name_group": name, "bot_id": f"depth-role-{role_index}",
                                "user_id": "owner", "profile_version": "offline-depth-diagnostic",
                                "agent_names": json.dumps([name], ensure_ascii=False),
                                "wake_names": json.dumps([name], ensure_ascii=False),
                                "negative_addressing_examples": json.dumps([other, "小岚"], ensure_ascii=False),
                                "rules": json.dumps(["唤醒后的后续语音仍须判断是否对当前角色说话。"], ensure_ascii=False),
                                "explicit_wake_required": "true", "dialogue_active": "true",
                                "recent_reply": latest["agent"], "last_agent_reply": latest["agent"],
                                "last_user_text": latest["user"], "turn_count": "3",
                                "seconds_since_last_turn": "1.25",
                            })
    return rows


def write_context_depth_dataset(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=False)
    rows = build_context_depth_dataset()
    path = root / "diagnostic.csv"
    with path.open("x", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    manifest = {
        "version": "context-depth-diagnostic-v1", "training": False,
        "holdout_opened": False, "production_enabled": False,
        "dataset": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "rows": len(rows), "distinct_questions": len({row["case_id"] for row in rows}),
        "by_depth": dict(Counter(row["context_depth"] for row in rows)),
        "by_category": dict(Counter(row["category"] for row in rows)),
        "by_history_kind": dict(Counter(row["history_kind"] for row in rows)),
        "turn_count": 3, "seconds_since_last_turn": 1.25,
        "diagnostic_policy": {"reject_threshold": 0.1, "accept_threshold": 0.9},
        "threshold": 0.5,
    }
    with (root / "manifest.json").open("x", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(write_context_depth_dataset(args.output), ensure_ascii=False, indent=2))

