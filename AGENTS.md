# Codex project instructions

Spend time on thinking; you do not need to use the commentary channel to report progress to me.

DO NOT send optional commentary

采用方案 1：将稳定的项目级行为约束集中写在本文件中，并由 Codex 在每次任务开始时加载；其中明确禁止可选进度播报，避免长任务被无意义的中断要求打断。

## 开发任务协作规则

涉及新功能、模块改造、架构、UI、交互、状态流转或安全边界时：

1. 开始分析前先读取 `.agents/skills/module-evolution/SKILL.md`，再读取统一模块记忆入口 `docs/module-memory/INDEX.md` 和受影响模块记录。
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

## DS Bot 正式启动入口

本仓库存在正式启动入口、直接 Electron 入口、诊断脚本和静态原型服务器。后续会话必须区分它们。

### 用户验收和手动启动

唯一正式启动命令是：

```powershell
Set-Location E:\project_space\ds-bot-dfl
.\start.ps1
```

`start.ps1` 会按顺序完成依赖检查、构建 `ds-bot`、同步 `local-voice` 和 `ds-bot` 到 `app/node_modules`，然后通过 `app/package.json` 的 `npm start` 启动正式 Electron Desktop。用户验收、截图、真实 MOSS 测试和任何“启动程序”请求都必须使用这个入口。

启动前先检查是否已经有 DS Bot 进程或 Host 端口。已有正式 Desktop 正在运行时，不要再启动第二个实例；需要加载新代码时，先正常退出旧实例，再使用 `start.ps1` 重启。

### 其他入口的边界

- `app/src/main.mjs` 是 Electron 的应用主文件，不是用户启动命令。只有 `start.ps1` 或 `npm start` 间接调用它。
- `npm --prefix app start` 只适用于已经完成插件构建和同步的临时开发场景，不能代替 `start.ps1` 做用户验收。
- `.ds-bot-local/diagnostics/tools/moss-preview-probe.mjs`、`.ds-bot-local/diagnostics/tools/moss-dsbot-smoke.mjs`、`.ds-bot-local/diagnostics/tools/moss-persistent-ui-launch.mjs` 等是诊断或自动化验证脚本，禁止作为用户验收的启动入口。它们可能使用隔离数据、模拟 MOSS、远程调试端口或未同步的安装副本。诊断材料分类位置见 `docs/README.md`，不要与正式数据混放。
- `http://127.0.0.1:28941/` 是静态视觉原型服务器，不是 DS Bot Desktop。
- `http://127.0.0.1:26814/` 是正式 Desktop 内部 Host 的临时 Web 地址，不能作为独立启动入口，也不能据此再开一个浏览器实例。

### 启动结果核对

启动后应看到 DS Bot Desktop 窗口。需要确认实际运行的代码时，核对以下三项：

1. 进程来自 `E:\project_space\ds-bot-dfl\app\node_modules\electron`；
2. Host 数据目录是本次 `start.ps1` 使用的 `DS_BOT_HOME`、`DS_BOT_WORKSPACE` 和 `DS_BOT_SHELL_DATA`；
3. `app/node_modules/ds-bot/client.js` 已由本次 `start.ps1` 从当前 `ds-bot` 源码构建并同步。

如果启动方式、数据目录或安装副本不明确，应先停止并重新通过 `start.ps1` 启动，不要猜测当前窗口对应哪个副本。
