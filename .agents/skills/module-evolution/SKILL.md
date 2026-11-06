---
name: module-evolution
description: Preserve Git-tracked module plans, confirmed decisions, unfinished scope, and exact continuation points across Codex sessions and computers. Use when planning, changing, pausing, or resuming application-module work. Do not use for project-wide requirement management or ordinary discussion that changes no module state.
---

# Module Evolution

Maintain durable module memory so a later session can answer: what was planned, what was decided, how much is complete, what was deliberately deferred, and where development should resume.

## Source and loading

Use `docs/module-memory/INDEX.md` plus one Markdown file per module in `docs/module-memory/`.

- At the start of module work, read the index and only the affected module files.
- Never load every module file merely to obtain an overview.
- Keep project-wide product requirements in their existing requirement system; this memory records module-level execution continuity.
- Treat `docs/module-evolution.md` as a legacy pointer, not a second source of truth.

If the directory or target module file is absent, initialize it using the required sections below. Existing partial modules may be reconstructed from the current conversation, code, tests, Git history, and trusted repository documents. Never invent lost plans or rationale.

## Evidence labels

Prefix material claims with exactly one label:

- `[用户确认]` — the user explicitly chose or confirmed it.
- `[代码证据]` — current code, tests, commits, or a trusted repository artifact proves it.
- `[现状重建]` — inferred from the present implementation; historical intent is unknown.
- `[候选建议]` — a proposal that the user has not accepted.
- `[待确认]` — relevant but currently ambiguous.

Only `[用户确认]` or an explicit authoritative repository decision artifact may become a formal decision. Keep AI proposals as candidates. When a decision changes, retain the old entry and mark which newer decision supersedes it.

## Required module record

Keep each active module file concise and include:

1. `模块目标` — intended outcome and completion criteria.
2. `规划基线` — stable plan IDs and status: `未开始`, `进行中`, `完成`, `延期`, or `取消`.
3. `决策记录` — decision ID, date, status/source, decision, reason, impact, and superseding decision when applicable.
4. `开发状态` — completed, in progress, deferred, and verified results.
5. `继续入口` — exact stopping point, next executable action, blockers, and verification command or observable result.

Compute progress from known plan items, such as `5/8 完成；1 进行中；2 延期`. If the original plan is unavailable, write `规划基线：待补录；进度无法计算` rather than estimating a percentage.

## When to write

Update the affected module record when at least one durable state change occurred:

- a plan was accepted or changed;
- scope was added, removed, deferred, or cancelled;
- a plan item started or completed;
- the user explicitly chose to leave part for a later iteration;
- a product or technical decision was confirmed or superseded;
- verification changed what is known;
- work is paused and a future session needs a continuation point.

Do not update it for ordinary answers, unaccepted brainstorming, repeated explanation, transient investigation that changes no conclusion, or failed experiments with no durable consequence.

Before finishing a state-changing development turn:

1. Update only the affected module files and their short index rows.
2. Preserve unrelated entries and historical decisions.
3. If present, run `python .agents/skills/module-evolution/scripts/check_memory.py`.
4. End the user-facing result with either `模块记忆：已更新 — <file and concise changes>` or `模块记忆：无需更新 — <reason>`.

## Context budget

- Keep `INDEX.md` to routing and one-line continuation summaries.
- Keep the active portion of a module record under roughly 3,000–5,000 tokens.
- Keep each decision compact; link to specs, commits, or ADRs instead of copying them.
- Move superseded or completed detail to `docs/module-memory/archive/` when it obstructs resumption.
- Edit changed sections only; do not restate the full record in the final response.
