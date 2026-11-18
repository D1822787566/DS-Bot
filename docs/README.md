# 项目目录与文档导航

本页说明现有目录的职责和查阅入口。源码目录保持既有分工，模块记忆统一保存，本地诊断材料按用途归档。

## 源码与启动

| 目录或文件 | 职责 | 查阅入口 |
| --- | --- | --- |
| `app/` | Electron 桌面应用：窗口、托盘、Host 启动、数据位置、安装与更新 | [桌面应用说明](../app/README.md) |
| `ds-bot/` | 核心 Bot 插件：聊天、群聊、记忆、工具、插件页及语音接入 | [插件说明](../ds-bot/README.md) |
| `local-voice/` | 独立的本地语音插件，包含 Host 接入和 Python 运行时 | [插件配置](../local-voice/package.json)、[运行时说明](../local-voice/runtime/README.md) |
| `browser-plugins/` | Bot 浏览器的 `refs`、`script`、`task` 三种后端及基准测试 | [浏览器插件说明](../browser-plugins/README.md) |
| `mobile/` | iOS / Android 客户端，通过加密配对连接桌面 Host | [移动端说明](../mobile/README.md) |
| `link/` | 手机与 Host 的加密通信、配对协议及 Relay Server | [通信说明](../link/README.md) |
| `docker/` | Docker 镜像、部署配置与部署测试 | [部署说明](../docker/README.md) |
| `scripts/` | 仓库级工具，目前包含扫描脚本 | [扫描脚本](../scripts/scan.mjs) |
| `start.ps1` | Windows 从当前源码启动正式 Desktop 的统一入口 | [源码启动说明](../app/README.md#run-from-source-windows) |

正式 Desktop 的启动关系：

```text
start.ps1
  → 检查依赖、构建 ds-bot
  → 同步 ds-bot 和 local-voice 到 app/node_modules
  → 启动 app 中的 Electron Desktop
```

`app/node_modules/ds-bot/` 和 `app/node_modules/local-voice/` 是安装副本。修改源码应进入根目录对应的插件目录，再通过正式启动入口同步。启动前检查已有 Desktop，避免重复启动。

核心插件内部按以下目录分工：

- [`ds-bot/src/client/`](../ds-bot/src/client/)：插件界面与交互。
- [`ds-bot/src/host/`](../ds-bot/src/host/)：Bot、群聊、记忆、工具及语音服务接入。
- [`ds-bot/src/shared/`](../ds-bot/src/shared/)：客户端与 Host 共享代码。
- [`ds-bot/src/office/`](../ds-bot/src/office/)：Office 文档处理。
- [`ds-bot/voice-runtime/`](../ds-bot/voice-runtime/)：现有 Phone Agent 的 Python 语音运行时；与独立 Local Voice 插件分别维护。
- [`ds-bot/test/`](../ds-bot/test/)：核心插件测试。
- [`ds-bot/dev/`](../ds-bot/dev/)：测试台架、模拟模型与开发验证工具。

## 文档怎么找

| 目录或文件 | 保存内容 | 使用方式 |
| --- | --- | --- |
| [vision.zh.md](vision.zh.md) / [vision.md](vision.md) | 项目愿景 | 先了解产品方向 |
| [plans/](plans/README.md) | 产品设计与历史设计说明 | 按主题查规则、取舍和限制，并查看具体文档状态 |
| [development/](development/) | 功能开发文档，目前集中在 `cross-module/` | 实现前核对范围、确认状态与验收条件 |
| [module-memory/](module-memory/INDEX.md) | 表情球、插件与预设、Phone Agent、Local Voice、MOSS Live 的模块记录 | 统一查当前进度、已确认决策与继续入口 |
| [prototypes/](prototypes/) | 原型、方向确认材料、界面截图与验证证据 | 结合对应开发文档查看 |
| [design/](design/ui-standard.md) | UI 规范 | 查视觉与交互约束 |
| [dev/](dev/release-checklist.md) | 发布检查清单 | 发布时使用 |
| [images/](images/) | README 等说明文档使用的图片 | 与原型证据分开存放 |
| [change-memory.md](change-memory.md) | 已有语音行为修复及验证记录 | 查历史修复线索 |
| [known-issues.zh.md](known-issues.zh.md) / [known-issues.md](known-issues.md) | 已知问题与恢复步骤 | 排查使用问题 |

协作规则在根目录 [AGENTS.md](../AGENTS.md)，项目技能位于 [`.agents/skills/`](../.agents/skills/)。开发文档技能与模块记忆技能均使用同一模块记忆入口。

开发与贡献方式见 [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)，版本变化见 [CHANGELOG.md](../CHANGELOG.md)。

## 本地数据、依赖与生成文件

| 位置 | 内容与处理边界 |
| --- | --- |
| `.ds-bot-local/data/`、`workspace/`、`shell/` | 正式源码启动使用的持久数据，包括配置、凭据、聊天、Bot 文件及浏览器状态；清理前需要保留与备份 |
| `.ds-bot-local/local-voice-env/`、`local-voice-models/`、`voice-runtime-env/`、`voice-runtime-private/` | 正在使用或仍由代码引用的语音环境、模型和私有配置；保持原路径 |
| `.ds-bot-local/diagnostics/tools/` | 本机诊断脚本及配套音频、JSON 输入与结果；脚本相对路径已随迁移调整，仍仅用于诊断 |
| `.ds-bot-local/diagnostics/logs/` | 历史构建、测试和启动日志 |
| `.ds-bot-local/diagnostics/screenshots/` | 诊断截图与历史 Playwright 截图 |
| `.ds-bot-local/diagnostics/runs/` | 历史隔离测试数据、原型浏览器 profile 和音频诊断材料；历史测试数据保留原内容，重用旧测试目录时按清单恢复原位置 |
| `.ds-bot-local/diagnostics/reference/` | 本机下载的参考 SDK 与语音依赖清单 |
| `.ds-bot-local/diagnostics/retired/` | 隔离保留的失败 Python 环境与旧缓存；尚未永久删除，仍占用磁盘空间 |
| `.dsh-test-*/`、`.playwright-mcp/` | 测试台架或浏览器工具可能再次生成的临时目录；本次已有材料已归档到 `diagnostics/` |
| `.pytest_cache/`、`__pycache__/` | Python 测试缓存与字节码，可重新生成 |
| 各包的 `node_modules/` | 安装依赖或本地插件副本，可通过相应包的安装流程恢复 |
| `app/ui/dist/`、`app/dist-pack/`、`app/dist-next/`、`app/build/runtime/`、`app/build/runtime-cache/` | 已被 Git 忽略的构建、打包或运行时下载产物；`app/build/` 同时含受版本控制的安装资源，不能整体作为缓存删除 |
| `ds-bot/client.js` | 构建生成且受 Git 跟踪的客户端包，由 `ds-bot/scripts/build-client.mjs` 生成；修改界面时应改 `src/client/` |
| [output/imagegen/](../output/imagegen/) | 当前受 Git 跟踪的角色图片及生成提示词，属于交付素材 |

`.git/` 是版本历史，`.github/` 保存 GitHub 工作流与协作模板，`.agents/` 保存项目技能。它们属于项目基础设施。

## 整理记录（2026-11-17）

- 表情球记录并入 `module-memory/`，保留历史决策、规划基线与继续入口；移除旧的重复索引与空目录。
- 修正规则中的技能路径和模块记忆路径。`plans/` 保留产品设计，`development/` 保留开发文档，两类材料通过本页导航查阅。
- 本机诊断材料分类迁入 `diagnostics/`；未使用的失败 Python 环境与旧缓存迁入 `diagnostics/retired/`。永久删除被工具策略拒绝，本次采用可恢复归档，不计为释放磁盘空间。
- 本机迁移清单位于 `.ds-bot-local/diagnostics/cleanup-20261117.json`，记录原路径、目标路径、文件校验值与清理对象；归档目录的内容校验记录位于同目录的 `archive-snapshots-20261117.json`。
- 诊断脚本更新前的原件保存在 `diagnostics/reference/original-tools-20261117/`；如需完整还原原位置及原内容，结合迁移清单使用这些原件。
- 正式数据、模型、有效语音环境和运行中的 Desktop 保持原位置。`.ds-bot-local/` 及测试缓存同时从 Docker 构建上下文排除。
