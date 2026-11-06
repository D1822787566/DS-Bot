# Codex project instructions

Spend time on thinking; you do not need to use the commentary channel to report progress to me.

DO NOT send optional commentary

采用方案 1：将稳定的项目级行为约束集中写在本文件中，并由 Codex 在每次任务开始时加载；其中明确禁止可选进度播报，避免长任务被无意义的中断要求打断。

## 开发任务协作规则

涉及新功能、模块改造、架构、UI、交互、状态流转或安全边界时：

1. 开始分析前先读取 `.agent/skills/module-evolution/SKILL.md`，再读取项目实际存在的项目记忆入口（当前为 `docs/project-memory/INDEX.md`）和受影响模块记录；如果目录已迁移为 `docs/module-memory/`，按 module-evolution Skill 的规则处理。
2. 先检查现有文档、源码、测试和配置，再判断是否需要创建或修改文档。
3. 文档保存位置按对应 Skill 管理：开发文档、原型、探索记录和项目规划使用 `collaborative-development-brief` Skill；长期模块记忆使用 `module-evolution` Skill，不在本文件重复维护目录细节。
4. 区分用户已确认的内容、Agent 的候选建议、待用户确认的问题，以及明确不属于本次范围的内容。
5. 用户只要求讨论时，不直接修改代码或把候选方案写成正式决策。
6. 用户要求制作开发文档时，使用项目内的 `collaborative-development-brief` Skill；先共同确认需求、方案、UI/交互和安全边界，再整理文档。
7. 涉及 UI 或交互时，必要时先制作并确认原型、流程图或状态图。
8. 涉及安全时，先确认保护对象、信任边界、允许操作、敏感数据和必要控制；不得因假设风险擅自建立完整权限、审计或密钥体系。
9. 不因未来可能的需求提前增加抽象、权限体系、配置、服务、扩展点或依赖；新增结构必须说明当前必要性。
10. 只有用户确认后的开发文档，才能作为后续开发依据；实现中发现文档未覆盖的范围时，先记录并重新确认。
11. 开发文档完成后，只把具有长期影响且已确认的决策写入 `module-evolution`；临时讨论、未确认建议和单次步骤不写入模块记忆。
