# 上游 0.3.8 全量迁移

记录状态：源码集成、自动化回归和正式 Desktop 启动核验完成；迁移分支交付
最近更新：2026-11-19

## 模块目标

- [用户确认] 移植上游 DS Bot 0.3.8 的全部更新，DSH 同步到 0.2.2-rc.1；保留当前 MOSS 展示与交互、Local Voice、Phone Agent 和插件预设。
- [用户确认] 移除已经被当前 Bot 详情侧栏和字幕交互替代的旧插件页 MOSS 内容。
- [代码证据] 开发依据：[迁移开发文档](../development/cross-module/upstream-0.3.8-migration-development.md)。上游固定基线为 `Fei2411/DS-Bot@5e9b7da8882da3b68d8a0624342708c2150a9156`，不代表后续上游新提交已同步。

## 规划基线

| ID | 事项 | 状态 | 证据 |
|---|---|---|---|
| UM-01 | DSH 升级及旧 MOSS 入口收敛 | 完成 | [代码证据] DSH 0.2.2-rc.1；旧全页移除，当前侧栏保留 |
| UM-02 | 阅读、批注、动画、通知、模型与桌面体验 | 完成 | [代码证据] 全部上游模块及测试已集成 |
| UM-03 | Secrets、Memory、ledger、并行会话与恢复 | 完成 | [代码证据] 保留本地私聊隔离和预设换段逻辑 |
| UM-04 | 群协作、Local Agent、Computer Use、连接器、IM、手机和部署 | 完成 | [代码证据] 包含上游 link/mobile/Docker/CI/Doctor |
| UM-05 | 完整验证、正式启动、迁移分支交付 | 完成 | [代码证据] 自动化回归、构建及正式 Desktop 路径/数据/安装副本核验通过 |

进度：5/5 完成。外部设备和账号验收保留独立边界。

## 决策记录

- UM-D01 / 2026-11-18 / [用户确认] 用户要求全部移植并保留 MOSS，随后确认 DSH 同步上游，再要求按迁移方案开始处理。影响：迁移覆盖整个固定上游提交，保留本地语音、插件与数据目录，不自动合并本项目 main。
- UM-D02 / 2026-11-18 / [用户确认] 删除旧插件页的 MOSS 内容；当前 Bot 详情侧栏、实时字幕、Profile 与运行时保留。原因：当前展示和交互已经改变。影响：共享开始入口移至实时字幕侧栏，旧字段读取仅用于数据兼容。

## 开发状态

- [代码证据] 在 `codex/upstream-0.3.8-migration` 上三方合并上游，人工处理客户端注册、Host 模块列表、Profile、聊天索引和预设等集成点；保留根 AGENTS.md 和正式 start.ps1 流程。
- [代码证据] 修复切换 Local Agent 时隐藏预设阻塞创建/被错误提交、Android 签名 CRLF、Windows Doctor fixture 及测试环境的 PATH 大小写假设。保留已选预设的模型 Bot、群成员与换段行为。
- [代码证据] 插件全量分两组验证：其余文件 3119 项，3112 通过、7 跳过；gateway 单文件 5/5 通过，合计 3117 通过、7 跳过、0 失败。构建与 lint 通过；lint 保留既有警告。
- [代码证据] app 单元测试 497 通过、6 跳过、0 失败；UI 构建通过，保留体积和 DSH 旧 API 可选导出的构建警告。真实 Electron 生命周期检查退出码 0；检查 fixture 等待真实 ready-to-show，取代固定 1200 ms 延迟。
- [代码证据] mobile 68/68、link 36/36、Local Voice 33/33；mobile/link TypeScript 检查通过。
- [代码证据] Windows Node 24.15.0 在 gateway 文件使用强制退出时触发 libuv 原生退出断言，业务断言全部通过；单独不带强制退出参数运行通过。未跳过 gateway 产品测试，未修改产品网关以绕过 Node 问题。
- [代码证据] 真实外部账号、手机配对、Computer Use 驱动、真人麦克风及原生安装包未由本轮自动化验收。MOSS 空播放标识异常继续由 MOSS 模块跟进。

## 继续入口

- [代码证据] 2026-11-19 已通过正式 `start.ps1` 启动；Electron 来自本仓库，数据目录仍为 `.ds-bot-local/{data,workspace,shell}`，源码与安装副本 client.js 的 SHA256 一致。原有 4 个 Bot 均保留，正式窗口可见聊天历史、MOSS 绑定与上次对话。
- [代码证据] 原生截图 `FrameArrived timed out`、点击 `coordinate input geometry is unavailable`，设置与插件页逐项原生视觉操作未验收；对应代码和自动化回归通过。
- [代码证据] 启动前 Bot state 已备份至本机 `.ds-bot-local/diagnostics/runs/upstream-0.3.8-before-start/state.json`；本地数据与诊断记录不进入 Git。
- [代码证据] 全量 Windows 验证：在 ds-bot 中用 `rg --files test -g '*.test.js'` 枚举，排除 `test/connectors-gateway.test.js`，其余传给 `node --import ./test/harness-resolve.mjs --test --test-concurrency=4 --test-timeout=120000 --test-force-exit`；gateway 用同一 import 单独运行且不加 force-exit。app/mobile/link/Local Voice 分别执行各自 npm test，mobile/link 再执行 npm run typecheck。
- [代码证据] 交付分支为 origin/codex/upstream-0.3.8-migration；本轮不合并 main。后续从该分支和固定上游 SHA 继续，外部设备验收按开发文档逐项进行，MOSS 空播放标识异常继续从 MOSS 记录接续。
