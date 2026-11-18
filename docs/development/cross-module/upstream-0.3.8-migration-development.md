# DS Bot 上游 0.3.8 能力迁移与 MOSS 入口收敛

## 文档状态

Confirmed / implementation and local verification complete

## 1. 目标与使用场景

把上游 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) `main` 在下述固定提交中的全部 0.3.8 更新迁移到本项目，同时保留本项目的 MOSS Live、Local Voice、Phone Agent、插件预设、桌面数据目录和启动流程。

用户继续从 Bot 详情侧栏使用 MOSS Live。旧的插件页 MOSS 设置入口不再作为产品入口。

## 2. 当前基线

- `[代码证据]` 上游基线：`5e9b7da8882da3b68d8a0624342708c2150a9156`，版本 0.3.8，DSH 0.2.2-rc.1。
- `[代码证据]` 本项目迁移前基线：`1ba59d4d545f7ce2301da462e1c0eef577fd2d27`，版本 0.2.7，DSH 0.2.1-rc.5；迁移分支已将应用和插件版本推进到 0.3.8，DSH 推进到 0.2.2-rc.1。
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
- 上游 Computer Use、侧栏分组、Bot 斜杠命令、多语言、桌面窗口与更新流程、Doctor、Docker 开发部署、发布与 CI 更新一并纳入。

## 5. 兼容性边界

- 使用共同祖先进行三方合并；人工合并客户端注册、Host 模块列表、Profile、预设和聊天索引等交叉点。MOSS、Local Voice、Phone Agent 独立源码及当前入口保留。生成的 `client.js`、`office.js`、`link.js` 从合并后的源码构建。
- DSH 0.2.2-rc.1 作为第一批兼容性迁移同步升级；保留 MOSS、Local Voice、Office 和 Desktop Host 的入口与数据目录，并在迁移后执行对应回归。
- 三批能力按同一固定上游提交完整集成，保留上游测试并补充本地集成回归；执行构建、专项、全量测试及正式 Desktop 检查。
- Secrets 加密属于安全边界变化：实现时保留明文兼容迁移、错误恢复和用户可理解的解锁状态，不自动删除旧密钥。

## 6. 验收标准

- 旧插件页 MOSS tab 不再出现；旧 `MossLiveSettings` 全页配置、旧 DS Bot 接入 panel、旧场景/动画/屏幕共享 CSS 和对应页面测试已删除；Bot 详情侧栏和实时字幕入口可用。
- 当前侧栏可以开始和停止屏幕共享，挂断和重拨不会错误恢复旧屏幕轨道。
- 每一批上游能力有对应源代码、测试、构建和 lint 证据。
- MOSS Profile、会话记忆、API Key、Host relay 和 Local Voice 不因迁移回归。
- 正式 Desktop 始终通过 `start.ps1` 启动验收。

## 7. 当前进度

- `[代码证据]` 已创建迁移分支 `codex/upstream-0.3.8-migration`。
- `[代码证据]` 已移除旧 MOSS 插件 tab 注册和跳转 action。
- `[代码证据]` 已删除旧 `MossLiveSettings` 全页配置、旧 DS Bot 接入 panel、旧场景/动画/屏幕共享 CSS 和页面专属测试。
- `[代码证据]` 已把屏幕共享开始按钮补到当前实时字幕侧栏；相关专项测试通过。
- `[代码证据]` 已同步 DSH 0.2.2-rc.1 及 `cordis-plugin-group/include` 1.1.0；加入 computer-use、CUA、Typert 协议包和可选 macOS CUA 驱动，保留 `dshmarket`、Local Voice、MOSS 和当前桌面启动流程。
- `[代码证据]` 已为 ds-bot 增加上游轻量入口 `plugin.js`/`src/host/entry.js`，主运行时仍由当前 `index.js` 承载；插件的 MOSS Host relay、Profile 和会话记忆模块未被覆盖。
- `[代码证据]` 上游 `5e9b7da8` 已完整进入迁移分支的合并工作树，三批范围及其余上游源码、测试、移动端、link、Docker、CI 和文档均已集成。客户端注册和 Host 模块列表同时包含上游新能力与本地语音/插件模块。
- `[代码证据]` 保留聊天索引的用户私聊隔离字段，并接入上游并行会话的 `partsOfThread`；保留预设的创建、复制、群成员和换段传递；修复从预设模式切换到 Local Agent 后隐藏的预设状态仍阻塞创建或被错误提交的问题。
- `[代码证据]` 上游增加多语言后，本地语音/预设沿用中文和英文文案，其他语言对这些本地新增文案使用英文回退，上游已有翻译保留。
- `[代码证据]` Windows 验证适配：Doctor 的成功命令 fixture 使用 `.cmd`；Android 签名生成兼容 CRLF；迁移符号链接权限测试先检查当前账户能力，能重建悬空链接的账户跳过该权限拒绝用例。未以放宽产品限制替代测试。
- `[代码证据]` Desktop UI 新增直接引用 DSH UI primitives 后，需要从 app 解析共享 UI 包并显式补齐其只列在开发依赖中的构建依赖；保留原有 primitives 替换入口。

### 验证边界

- `[代码证据]` 移动端 68 项测试、TypeScript 检查通过；link 36 项测试及 TypeScript 检查通过；Local Voice 33 项 Node 测试通过。
- `[代码证据]` Desktop app 单元测试 503 项：497 通过、6 跳过、0 失败；跳过项包括当前平台不适用检查和上述符号链接权限用例。
- `[代码证据]` 插件全量合计 3124 项：3117 通过、7 跳过、0 失败（其余文件 3112 通过，gateway 单独 5/5）；插件构建、生成文件一致性与 lint 通过。Desktop UI 构建通过，保留体积与上游可选旧 API 导出警告；真实 Electron 生命周期检查退出码 0。
- `[代码证据]` 2026-11-19 已通过正式 `start.ps1` 重启 Desktop；Electron 位于本仓库 app/node_modules，使用 `.ds-bot-local` 数据目录；源码与安装副本 `client.js` SHA256 均为 `0595896b79f15afbcfc8e4cbd534d04299c145dcc242b2e70987648b27698387`。原有 4 个 Bot 均保留，正式窗口可见原聊天、MOSS 已绑定状态及上次对话内容。
- `[代码证据]` 原生窗口截图工具返回 `FrameArrived timed out`，元素点击返回 `coordinate input geometry is unavailable`；未把新版设置与插件页的逐项原生操作或视觉截图记为通过。对应源码和自动化回归已验证。
- `[代码证据]` 本机 Node 24.15.0 / Windows 对 `connectors-gateway.test.js` 使用 `--test-force-exit` 时，全部 5 项业务断言通过后触发 libuv 原生退出断言；不带该参数单独运行 5/5 通过。全量验证将该文件单独运行，其余文件保留上游的强制退出参数。
- `[代码证据]` 真人 MOSS 拨打、实际屏幕共享、真实外部连接器、手机配对、Computer Use 驱动与 Android/iOS 原生发布包不由单元测试代替；未把这些外部或设备流程记为已验收。
- `[代码证据]` MOSS 主动静默结果播报的空播放标识异常仍按 MOSS 模块记录跟进，本次迁移不宣称修复。

## 8. 继续入口

固定上游基线的代码迁移与本地验证已完成，交付分支为 `origin/codex/upstream-0.3.8-migration`，本项目 `main` 不自动合并。后续新上游提交作为下一轮同步基线；设备、原生视觉和外部服务验收按上节边界分别跟进。
