from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
MEMORY_DIR = ROOT / "docs" / "module-memory"
INDEX = MEMORY_DIR / "INDEX.md"
REQUIRED_HEADINGS = (
    "## 模块目标",
    "## 规划基线",
    "## 决策记录",
    "## 开发状态",
    "## 继续入口",
)


def main() -> int:
    errors: list[str] = []
    if not INDEX.is_file():
        print(f"missing index: {INDEX}")
        return 1

    index_text = INDEX.read_text(encoding="utf-8")
    linked_files = sorted(set(re.findall(r"\]\(([^/)]+\.md)\)", index_text)))
    if not linked_files:
        errors.append("INDEX.md contains no module links")

    for name in linked_files:
        path = MEMORY_DIR / name
        if not path.is_file():
            errors.append(f"missing module file: {name}")
            continue
        text = path.read_text(encoding="utf-8")
        for heading in REQUIRED_HEADINGS:
            if heading not in text:
                errors.append(f"{name}: missing heading {heading}")
        if "记录状态：" not in text:
            errors.append(f"{name}: missing record status")
        if "最近更新：" not in text:
            errors.append(f"{name}: missing update date")

    if errors:
        print("module memory validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"module memory validation passed: {len(linked_files)} modules")
    return 0


if __name__ == "__main__":
    sys.exit(main())
