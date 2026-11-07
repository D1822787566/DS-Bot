"""Deterministic data builder for wake-gated continuation experiments."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
from typing import Iterable


_SCENARIOS = (
    ("refer_back", "你刚刚说的日期确定吗？", "小王，你明天几点出发？"),
    ("clarification", "你的意思是先验证再接入吗？", "我得先把文件整理好。"),
    ("direct_followup", "那我们先准备第二个方案。", "视频里说周三会下雨。"),
    ("agreement", "好，那就按你说的继续。", "大家先别说话。"),
    ("explicit_name", "{name}，你能再解释一下吗？", "我不是在问你，我是在问小王。"),
    ("other_role", "{name}，刚才那部分再说一遍。", "{other}，你来看看这个。"),
)

_SPLIT_SPEC = {
    "train": {
        "names": ("澄音", "栖迟", "洛微", "昭宁"),
        "actions": ("整理文件", "准备会议", "检查设备", "规划路线", "核对日期", "分析方案", "安排提醒", "阅读报告"),
    },
    "validation": {
        "names": ("砚歌", "容与"),
        "actions": ("制作清单", "复核合同", "安排出行", "比较选项", "检查预算", "整理笔记", "确认计划", "解释概念"),
    },
    "test": {
        "names": ("初霁", "绛云"),
        "actions": ("准备演示", "核对资料", "规划时间", "检查结果", "整理数据", "评估风险", "安排任务", "回答疑问"),
    },
}

_SPLIT_SPEC_V2 = {
    "train": {
        "names": ("箫然", "霁川", "闻溪", "拓影"),
        "actions": ("准备答辩", "整理照片", "检查网络", "安排采购", "核对账单", "分析日志", "规划训练", "阅读合同"),
    },
    "validation": {
        "names": ("云昭", "疏桐"),
        "actions": ("设计流程", "复查数据", "安排会议", "比较方案", "检查库存", "整理代码", "确认时间", "解释规则"),
    },
    "test": {
        "names": ("砚辞", "沧澜"),
        "actions": ("准备答复", "核对名单", "规划预算", "检查接口", "整理记录", "评估进度", "安排提醒", "回答追问"),
    },
}

_SPLIT_SPEC_V3 = {
    "train": {
        "names": ("澜音", "松岚", "映川", "清砚"),
        "actions": ("准备答辩", "整理照片", "检查网络", "安排采购", "核对账单", "分析日志", "规划训练", "阅读合同"),
    },
    "validation": {
        "names": ("遥岑", "栖月"),
        "actions": ("设计流程", "复查数据", "安排会议", "比较方案", "检查库存", "整理代码", "确认时间", "解释规则"),
    },
    "test": {
        "names": ("沉星", "望川"),
        "actions": ("准备答复", "核对名单", "规划预算", "检查接口", "整理记录", "评估进度", "安排提醒", "回答追问"),
    },
}

_DATASET_SPECS = {"v1": _SPLIT_SPEC, "v2": _SPLIT_SPEC_V2, "v3": _SPLIT_SPEC_V3}


def _json(values: Iterable[str]) -> str:
    return json.dumps(list(values), ensure_ascii=False, separators=(",", ":"))


def _reply(name: str, action: str, scenario: str) -> str:
    replies = {
        "refer_back": f"{action}安排在周三。",
        "clarification": f"先完成{action}，再进行下一步。",
        "direct_followup": f"我建议先把{action}拆成两个小步骤。",
        "agreement": f"关于{action}，可以按这个顺序继续。",
        "explicit_name": f"我刚才解释了{action}的处理顺序。",
        "other_role": f"{action}目前已经有一个初步安排。",
    }
    return replies[scenario]


def _row(*, split: str, index: int, name: str, other: str, action: str,
         category: str, label: str, text: str, pair_id: str, pair_side: str) -> dict[str, str]:
    reply = _reply(name, action, category)
    return {
        "sample_id": f"wake-cont-{split}-{index:05d}",
        "group_id": pair_id,
        "pair_id": pair_id,
        "pair_kind": "post_wake_continuation",
        "pair_side": pair_side,
        "split": split,
        "category": category,
        "scenario": "明确唤醒后第一条指令已完成，判断当前语音是否继续对目标角色说话",
        "rationale": "短时会话上下文和当前转写共同决定后续语义准入",
        "label_source": "wake_gated_synthetic_template_v1",
        "label": label,
        "text": text,
        "name_group": name,
        "action_group": action,
        "bot_id": f"char-{split}-{name}",
        "user_id": "owner",
        "profile_version": "evaluation",
        "agent_names": _json((name,)),
        "wake_names": _json((name,)),
        "negative_addressing_examples": _json(("小王",)),
        "rules": _json(("明确唤醒后可以继续追问。",)),
        "explicit_wake_required": "true",
        "dialogue_active": "true",
        "recent_reply": reply,
        "turn_count": "1",
        "last_user_text": f"请先帮我处理{action}。",
        "last_agent_reply": reply,
        "seconds_since_last_turn": "1.25",
        "name_position": "start" if name in text and text.startswith(name) else "absent",
        "asr_style": "punctuation_free",
    }


def build_dataset(*, variant: str = "v1") -> dict[str, list[dict[str, str]]]:
    """Build balanced, name/action-isolated train/validation/test rows."""
    if variant not in _DATASET_SPECS:
        raise ValueError(f"unknown dataset variant: {variant}")
    dataset: dict[str, list[dict[str, str]]] = {}
    for split, spec in _DATASET_SPECS[variant].items():
        rows: list[dict[str, str]] = []
        index = 0
        names = spec["names"]
        for name_index, name in enumerate(names):
            other = names[(name_index + 1) % len(names)]
            for action in spec["actions"]:
                for category, positive_template, negative_template in _SCENARIOS:
                    pair_id = f"wake-cont-{split}-group-{len(rows) // 2:05d}"
                    positive = positive_template.format(name=name, other=other)
                    negative = negative_template.format(name=name, other=other)
                    rows.append(_row(
                        split=split, index=index, name=name, other=other,
                        action=action, category=category, label="addressed",
                        text=positive, pair_id=pair_id, pair_side="positive"))
                    index += 1
                    rows.append(_row(
                        split=split, index=index, name=name, other=other,
                        action=action, category=category, label="ambient",
                        text=negative, pair_id=pair_id, pair_side="negative"))
                    index += 1
        dataset[split] = rows
    return dataset


def _write_csv(path: Path, rows: list[dict[str, str]]) -> str:
    if not rows:
        raise ValueError("dataset split is empty")
    fieldnames = list(rows[0])
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_dataset(root: str | Path, *, variant: str = "v1") -> dict[str, object]:
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    dataset = build_dataset(variant=variant)
    splits: dict[str, object] = {}
    for split, rows in dataset.items():
        path = root / f"{split}.csv"
        digest = _write_csv(path, rows)
        splits[split] = {
            "path": str(path),
            "sha256": digest,
            "rows": len(rows),
            "groups": len({row["group_id"] for row in rows}),
            "names": sorted({row["name_group"] for row in rows}),
            "actions": sorted({row["action_group"] for row in rows}),
        }
    manifest: dict[str, object] = {
        "dataset_version": f"wake-gated-continuation-{variant}",
        "model_input": "continuation_input.ContinuationContext",
        "final_test_opened": False,
        "splits": splits,
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Build wake-gated continuation data")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--variant", choices=sorted(_DATASET_SPECS), default="v1")
    args = parser.parse_args()
    print(json.dumps(write_dataset(args.output, variant=args.variant), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

