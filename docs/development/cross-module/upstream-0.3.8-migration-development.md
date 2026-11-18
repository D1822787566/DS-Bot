# DS Bot 上游 0.3.8 能力迁移与 MOSS 入口收敛

## 文档状态

Confirmed / migration in progress

## 1. 目标与使用场景

把上游 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) `main` 当前的 0.3.8 能力逐项迁移到本项目，同时保留本项目的 MOSS Live、Local Voice、桌面数据目录和启动流程。

用户继续从 Bot 详情侧栏使用 MOSS Live。旧的插件页 MOSS 设置入口不再作为产品入口。

## 2. 当前基线

- `[代码证据]` 上游基线：`5e9b7da8882da3b68d8a0624342708c2150a9156`，版本 0.3.8，DSH 0.2.2-rc.1。
- `[代码证据]` 本项目基线：`1ba59d4d545f7ce2301da462e1c0eef577fd2d27`，版本 0.2.7，DSH 0.2.1-rc.5。
- `[代码证据]` 两者共同祖先为 `71d344bf193f3f18185f25de3d8e5c483046910a`。本项目在共同祖先上增加了 MOSS Live、Local Voice、Phone Agent 和项目治理内容；上游在共同祖先上继续增加了大量产品能力。
- `[用户确认]` 目标是迁移上游能力，同时保留当前 MOSS 内容中仍属于运行时、Profile、会话记忆、实时字幕、Bot 详情侧栏和安全桥接的部分。

## 3. MOSS 入口收敛

### 已确认保留

- `MossLiveDetailsPanel`：Bot 详情侧栏中的绑定、Profile、API Key、音色和拨打入口。
- `MossLiveCaptionPanel`：当前页面的实时字幕、历史、继续练习、重拨、静音和会话控制。
- `moss-live-controller.js`、`moss-live.js`：会话生命周期、媒体、字幕、打断、Profile 记忆和历史恢复。
- `src/host/moss-live.js`、`moss-live-dsbot.js`、MOSS channel actions：Host relay、授权、任务读取/派发和结果回传。
- 相关 Profile 配置迁移、会话记忆和回归测试。

### 已确认移除

- 旧的 DSH Plugins 页面 `MOSS Live` tab 注册。
- `openMossLiveSettings` 及其从插件管理页跳转 MOSS 的入口。
- 旧 `MossLiveSettings` 全页配置界面：Persona、场景、问候、旧 DS Bot 接入卡、旧字幕舞台和旧屏幕共享卡。
- 只服务旧全页界面的测试和 CSS。

### 迁移注意

- `[代码证据]` 旧全页界面目前仍提供“共享屏幕”的开始按钮；当前侧栏只有共享中的“停止共享”按钮。删除旧页面前，已把“共享屏幕”开始按钮移到当前实时字幕侧栏，避免删掉仍在设计文档中的能力。
- `[代码证据]` Host 仍保留旧配置字段的读取和规范化，用于已有 Profile 数据兼容；删除编辑入口不等于立即删除数据迁移和运行时字段。

## 4. 上游迁移范围

### 第一批：低耦合体验能力

- 长回复阅读条：`reading.js`、长消息定位、章节菜单和回归测试。
- 文本 Quote / Annotate：选中文本后的引用与批注动作。
- 全局动画档位：Full / Reduced / Off，并接入本项目现有主题和 MOSS 动效。
- 失败更新恢复、长消息折叠和 settled card 展开。
- 通知、模型列表刷新、批量模型设置和边栏折叠修复。

### 第二批：安全和数据能力

- Secrets 文件可选加密：AES-256-GCM、密码短语、环境变量/文件输入、错误恢复和迁移测试。
- Memory layers、自动整理、撤销和作用域移动。
- 消息 ledger、并行会话和重启后的 group 状态恢复。

### 第三批：协作、连接与移动能力

- Group task board、共享待办、群消息搜索、改动文件审查和验证标记。
- Local Agent ACP / stdio MCP bridge、CLI 发现、登录和图片输入。
- Gateway Remote、手机文件传输、连接器、QQ/WeCom 增强和手机端更新。

## 5. 兼容性边界

- 不直接把上游 `client.js`、`link.js` 或整个 `ds-bot/src/client/index.js` 覆盖到本项目。它们会覆盖 MOSS 和 Local Voice 的入口。
- 不直接升级 DSH 到 0.2.2-rc.1。DSH 升级单独验证，先确认 MOSS、Local Voice、Office 和 Desktop Host 的兼容性。
- 上游功能按源模块、测试和明确集成点迁移；每批完成后重新构建 `client.js` 并运行对应专项和全量测试。
- Secrets 加密属于安全边界变化：实现时保留明文兼容迁移、错误恢复和用户可理解的解锁状态，不自动删除旧密钥。

## 6. 验收标准

- 旧插件页 MOSS tab 不再出现；Bot 详情侧栏和实时字幕入口可用。
- 当前侧栏可以开始和停止屏幕共享，挂断和重拨不会错误恢复旧屏幕轨道。
- 每一批上游能力有对应源代码、测试、构建和 lint 证据。
- MOSS Profile、会话记忆、API Key、Host relay 和 Local Voice 不因迁移回归。
- 正式 Desktop 始终通过 `start.ps1` 启动验收。

## 7. 当前进度

- `[代码证据]` 已创建迁移分支 `codex/upstream-0.3.8-migration`。
- `[代码证据]` 已移除旧 MOSS 插件 tab 注册和跳转 action。
- `[代码证据]` 已把屏幕共享开始按钮补到当前实时字幕侧栏；相关专项测试通过。
- `[待确认]` 上游 DSH 0.2.2-rc.1 升级是否与第一批体验能力一起进行，还是单独建立兼容性批次。

## 8. 继续入口

下一步从第一批开始：先移植 `reading.js` 和 Quote / Annotate 的独立模块，再处理动画档位和更新恢复。每个批次完成后更新本节、模块记忆和验证记录。
