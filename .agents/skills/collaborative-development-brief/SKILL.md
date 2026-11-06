---
name: collaborative-development-brief
description: Guide the user and Agent to jointly clarify a development request, confirm technical choices, UI or interaction behavior, security boundaries, and complexity limits, then produce a confirmed development document for implementation. Use when a feature, module change, prototype, interaction flow, or development document needs collaborative definition before coding.
---

# Collaborative Development Brief

## Purpose

Guide a shared discovery and confirmation process. The development document is a record of decisions made by the user and Agent; it is not a place to turn Agent assumptions into requirements.

## Required first reading

Before analysis, read:

1. `AGENTS.md`;
2. `.agent/skills/module-evolution/SKILL.md`;
3. the project's actual memory index (currently `docs/project-memory/INDEX.md`; use `docs/module-memory/INDEX.md` if that structure exists) and only the affected module records;
4. related documents, source, tests, configuration, and scripts.

Use the module-evolution skill's actual source and path rules. Treat confirmed module decisions as constraints, and treat proposals as candidates until the user confirms them.

## Workflow

Track the work through these states:

`DISCOVERY` → `DESIGN` → `PROTOTYPE_REVIEW` (when needed) → `CONFIRMATION` → `DOCUMENT_DRAFT` → `DOCUMENT_CONFIRMED` → `IMPLEMENTATION` → `ACCEPTANCE`

- In `DISCOVERY`, describe current behavior, desired outcome, affected modules, historical constraints, missing information, and risks.
- In `DESIGN`, compare a small number of viable approaches, including impact, cost, complexity, compatibility, and reuse of existing mechanisms.
- Enter `PROTOTYPE_REVIEW` for UI, interaction, visual behavior, or state-flow decisions. Confirm the prototype, flow, and important states before treating them as requirements.
- In `CONFIRMATION`, ask the user to resolve open decisions. Do not silently choose between materially different behaviors.
- In `DOCUMENT_DRAFT`, record confirmed facts, candidate suggestions, unresolved questions, scope, steps, and acceptance criteria separately.
- Enter `DOCUMENT_CONFIRMED` only after the user explicitly accepts the document or its decisions.
- Enter `IMPLEMENTATION` only when the user asks to develop from a confirmed document.
- During implementation, stop and record a scope deviation if a necessary change is outside the document; update the confirmed document before proceeding.
- In `ACCEPTANCE`, verify observable criteria and record actual results.

## UI and interaction gate

When the request affects screens, components, user actions, states, feedback, errors, loading, empty states, responsive behavior, or permissions exposed in UI, tell the user which behaviors are not yet fixed. Propose a low-fidelity prototype, flow, or state diagram when it would prevent ambiguity. Do not freeze unconfirmed UI behavior into the development document.

## Security boundary gate

Identify:

- protected objects and sensitive data;
- trust boundaries and untrusted inputs;
- allowed and forbidden operations;
- existing security mechanisms;
- minimum controls required for this request;
- risks that need discussion but do not yet justify implementation.

Separate mandatory security acceptance criteria from optional hardening. Preserve existing boundaries. Do not introduce a complete RBAC system, policy engine, audit platform, key-management service, encryption scheme, or other security subsystem solely because it might be useful later. Any change that expands permissions, accessible data, resource scope, or trust boundaries requires explicit user confirmation.

## Complexity control

Prefer existing modules, patterns, dependencies, and workflows. Do not add abstractions, configuration, extension points, services, or dependencies for speculative future needs. For each new file, type, interface, setting, or service, state why the current request requires it. Record future possibilities separately from the confirmed scope.

## Document status and evidence

Keep these categories distinct:

- `已确认内容` — user-confirmed requirements or authoritative repository decisions;
- `Agent 建议` — proposals that require confirmation;
- `待确认问题` — unresolved decisions;
- `明确不做` — excluded scope.

Only `DOCUMENT_CONFIRMED` content may guide implementation. A discussion-only request does not authorize code or a confirmed document. A document-only request does not authorize code changes.

## Development document template

Use this structure and adapt it to the task:

```markdown
# <功能或模块名称> 开发文档

## 文档状态
Draft / Confirmed / In Progress / Completed

## 1. 目标与使用场景
## 2. 当前行为
## 3. 期望行为
## 4. 已确认决策
## 5. 待确认问题
## 6. Agent 建议
## 7. UI 与交互依据
## 8. 安全边界
## 9. 功能范围
### 包含
### 不包含
## 10. 技术方案
## 11. 影响范围
## 12. 实施步骤
### 步骤 1
- 修改对象：
- 修改内容：
- 完成条件：
## 13. 验收标准
### 功能验收
### UI 与交互验收
### 安全验收
### 回归验收
### 错误场景验收
## 14. 测试计划
## 15. 风险与回滚方式
## 16. 复杂度控制
## 17. 范围偏差记录
## 18. 关联的 module-evolution 决策
## 19. 变更记录
```

Steps and acceptance criteria must be observable. State inputs, actions, expected outputs or state changes, and the verification method. Avoid vague criteria such as “works normally” or “secure enough”.

## Document placement and module-evolution

Before creating a document, search for an existing document that can be updated. Use this repository layout unless an existing module-specific structure clearly governs the subject:

- `docs/development/<module>/` — formal development documents. Use `<feature>-development.md`; keep a draft at this path with `Draft` status and update it in place after confirmation.
- `docs/prototypes/<module>/` — UI prototypes, interaction flows, state diagrams, and visual confirmation materials.
- `docs/project-memory/` — durable module memory and confirmed long-term decisions.
- `experiments/` — exploratory, comparative, or unconfirmed investigations.
- `planning/` — project-level roadmaps and backlog material.

For a cross-module feature, use `docs/development/cross-module/`. Update the relevant index when that structure requires it. Do not create parallel documents for the same subject. A discussion-only request does not require a formal development document.

After the user confirms the development document, extract only durable, confirmed module decisions into the module-evolution record. Link the development document from the decision record and link the relevant decision back from the development document. Do not put temporary discussion, unconfirmed proposals, one-off implementation steps, or ordinary test output into module memory.

## Completion checks

Before presenting a confirmed document, verify:

- module-evolution and affected module memory were read;
- existing documents were searched;
- confirmed facts, suggestions, unresolved questions, and exclusions are separate;
- UI or interaction decisions have a confirmed basis when applicable;
- security boundaries and minimum controls are explicit;
- complexity limits and non-goals are explicit;
- every implementation step has a completion condition;
- acceptance criteria are observable and testable;
- related module-evolution decisions and document links are recorded;
- the document is placed in the correct existing location.
