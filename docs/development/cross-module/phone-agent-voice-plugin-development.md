# Phone Agent 语音插件开发文档

## 文档状态

Confirmed / In Progress

## 1. 目标与使用场景

将 `E:/project_space/phone_agent` 中已经验证的 Voice Runtime、Windows 音频、唤醒、ASR、主人声纹、语义续话和 TTS 链路接入 DS Bot。用户在 DS Bot 中为每个 Bot 配置唤醒词和 TTS 音色；Windows 麦克风识别唤醒词后，语音输入进入对应 Bot 的既有会话，回复通过 Windows 扬声器播放。

## 2. 当前行为

- `[代码证据]` DS Bot 已有插件发现、安装、Bot 预设、Voice Mode 和 `/api/bot` 主机通道。
- `[代码证据]` Phone Agent 已有 Windows `MediaDevices` 音频适配、LiveKit 会话、唤醒映射、ASR、主人声纹、语义续话和 TTS Worker。
- `[代码证据]` Phone Agent 现有 Bridge/Core 目标仍绑定 Alife `character_id` 和 Alife Core。
- `[现状重建]` 两个项目之间没有 DS Bot Bot/session 到 Phone Agent Voice Runtime 的适配层。

## 3. 期望行为

1. DS Bot 插件设置页提供运行状态、Windows 音频、Bot 唤醒词、Bot TTS 音色、ASR、LiveKit、主人声纹和高级语义续话设置。
2. 一个 Windows 设备可绑定多个 Bot；唤醒词映射选择当前 Bot，切换时停止旧音频播放。
3. 主人声纹默认启用；未录入或未通过时不提交语音输入。
4. 语音转写通过 DS Bot 自己的会话入口提交，沿用 Bot 的模型、上下文、权限和审批。
5. Bot 回复以分段事件发送给 Phone Agent，使用当前 Bot 的 TTS 音色播放。
6. 插件负责启动、停止和诊断 Phone Agent 运行依赖；Android 不纳入首版验收。

## 4. 已确认决策

- 每个 Bot 有一个可编辑主唤醒词。
- 一个设备可绑定多个 Bot，同一时刻只有一个激活 Bot。
- 首版必须包含 Windows 麦克风和扬声器。
- 每个 Bot 可单独配置 TTS 音色。
- 语义连续对话首版启用，但保留高级开关。
- 首版默认启用主人声纹校验。
- 插话或切换 Bot 停止旧音频播放；明确停止任务时才取消 Bot 工作。
- 语音转写使用 Bot 现有聊天模型、上下文、权限和审批。
- 首版复用 Phone Agent 已接通的 ASR、TTS 和语义续话后端。
- 首版只验收 Windows；Android 延后。

## 5. 待确认问题

无产品范围阻塞项。实现细节按本文件和现有协议选择；发现超出范围的必要变更时，先补入本节并暂停相关实现。

## 6. Agent 建议

- 将 DS Bot 侧适配实现放入 `ds-bot`，对外仍作为 DS Bot 的可装载语音能力；这样可以访问 Bot roster、session 和 `/api/bot`，避免外部 DSH 插件绕过 DS Bot 状态边界。
- 使用 Phone Agent `agent-events.v1` 的最小子集建立 DS Bot Bridge：`bridge.hello/ready`、`input.submit/accepted/rejected`、`run.started/ended`、`output.started/segment/ended`、`cancel.*` 和 `delivery.*`。
- 凭据不进入 `state.json` 或 `/api/bot` 返回值；运行配置中只保存非敏感路径、设备和模型选择，敏感值使用 DS Bot secret store。

## 7. UI 与交互依据

插件页面使用 DS Bot 已有 Plugins 页面风格，增加 Phone Agent 设置卡片：

- **总览**：启用开关、运行状态、当前设备、当前 Bot、最近错误、启动/停止。
- **Bot 与唤醒词**：逐 Bot 编辑主唤醒词、设备绑定和 TTS 音色；重复唤醒词保存时拒绝并指出冲突 Bot。
- **Windows 音频**：输入/输出设备名称、设备扫描、连接测试。
- **ASR / TTS / LiveKit**：显示当前 Phone Agent 后端与可编辑的已支持配置。
- **高级**：语义续话开关、模型、阈值和超时；主人声纹录入/替换与测试。

状态至少包括 `stopped`、`starting`、`ready`、`listening`、`speaking`、`paused`、`error`。保存失败、设备缺失、声纹未录入和运行时断线都显示明确错误。

## 8. 安全边界

- 保护对象：LiveKit secret、Bridge credential、TTS credential、ASR/声纹模型路径和主人声纹资料。
- 信任边界：DS Bot 主进程、Phone Agent 子进程、Windows 音频设备、LiveKit 服务和本机浏览器 UI。
- 允许操作：用户通过插件设置修改本机语音配置、Bot 唤醒词和音色；插件可启动/停止其自身的本地进程。
- 禁止操作：Bot 工具和语音输入不得读取或输出凭据、原始声纹文件、原始 PCM；插件不得绕过 DS Bot 权限和审批提交其他 Bot 的工作。
- 最低控制：所有配置字段严格校验；Bridge 仅监听 loopback；WebSocket/HTTP 使用已有 credential；状态返回脱敏；旧设备会话和迟到事件丢弃。

## 9. 功能范围

### 包含

- DS Bot host/client Phone Agent 模块。
- DS Bot Bot/session 与 Phone Agent Bridge 适配。
- Windows 音频进程编排和状态显示。
- 多 Bot 唤醒映射、冲突校验、按 Bot TTS 音色。
- ASR、主人声纹、语义续话、TTS 和播放打断的配置接线。
- 单元、协议和受控 Windows 集成测试。

### 不包含

- Android 首版验收。
- Alife Core、Live2D、Emotion Ball 或 Alife Context Snapshot。
- 新的通用 provider 平台、RBAC、审计系统或跨设备广播服务。

## 10. 技术方案

1. 在 DS Bot runtime 增加 `phoneAgent` 模块，维护非敏感配置、Bot voice profile、运行状态和进程句柄。
2. 在 `channel.js` 增加 Phone Agent API endpoint，并把脱敏状态纳入 state/live view。
3. 增加 DS Bot Bridge adapter，将 `input.submit` 转为目标 Bot 的现有 `send` 路径，将目标 Bot 的 assistant turn 转成 `output.segment`。
4. 复用 Phone Agent Windows Runtime 和 TTS/ASR 配置格式；由 DS Bot 生成临时运行配置并托管子进程。
5. 在插件页面增加设置卡片和 Bot profile 编辑；客户端只通过 `/api/bot` 操作。

## 11. 影响范围

- `ds-bot/index.js`、`src/host/channel.js`、新增 `src/host/phone-agent.js`。
- `src/client/plugin-page.js`、`src/client/index.js`、新增客户端设置组件。
- DS Bot state migration、secret store 和测试。
- `package.json` 仅在 WebSocket Bridge 必要时增加现有兼容依赖。

## 12. 实施步骤

### 步骤 1：协议和配置模型

- 修改对象：新增 Phone Agent host module、状态模型、校验和迁移。
- 完成条件：无效唤醒词、重复唤醒词、无效音色和不安全地址被拒绝；凭据不出现在 view。

### 步骤 2：DS Bot Bridge

- 修改对象：新增 Bridge adapter，接入 `channel.js` 和 Bot session。
- 完成条件：受控 WebSocket 客户端可完成 hello、input、reply segment、cancel 和 delivery 序列。

### 步骤 3：Windows Runtime 编排

- 修改对象：新增 Phone Agent 子进程启动/停止、配置生成和诊断。
- 完成条件：未配置时明确错误；配置后可启动、停止、重启并回收 Gateway/Windows runtime 子进程。

### 步骤 4：设置 UI

- 修改对象：Plugins 页面和客户端 API actions。
- 完成条件：用户可读取/保存所有首版设置，编辑每 Bot 唤醒词和音色，并看到运行状态与错误。

### 步骤 5：验证与验收

- 修改对象：DS Bot tests、Phone Agent protocol tests、Windows acceptance scripts。
- 完成条件：定向测试、构建、lint 和受控 Windows 麦克风/扬声器验收通过；Android 不作为阻塞项。

## 13. 验收标准

### 功能验收

- 两个 Bot 绑定同一 Windows 设备时，分别说出唤醒词可切换目标。
- 目标 Bot 收到转写并在原聊天中生成回复。
- 回复使用目标 Bot 的音色并从 Windows 扬声器播放。
- 主人声纹未通过时不产生 Bot 输入。
- 插话或切换停止旧播放；明确停止任务才取消运行。

### UI 与交互验收

- 设置页可完成设备、唤醒词、音色、ASR、TTS、LiveKit 和高级语义设置。
- 启动、连接、播放、暂停、错误和未录入声纹状态可见。
- 冲突和无效设置在保存时给出可理解错误。

### 安全验收

- API 返回和 UI 状态不包含 secret、API key、原始声纹或 PCM。
- Bridge 只允许受认证的 loopback 连接，旧 session 的事件不改变当前状态。

### 回归验收

- DS Bot 既有单元、构建和客户端 bundle 检查保持通过。
- Phone Agent 既有 Python 运行时定向协议测试保持通过。

## 14. 测试计划

- 先为配置校验、唤醒词冲突、状态脱敏和 Bridge 序列写失败测试，再实现。
- DS Bot：`npm test -- --test-name-pattern "phone agent|plugins"`、完整 `npm test`、`npm run build`、`npm run lint`。
- Phone Agent：`python -m pytest rebuild/livekit-agent/test_bridge_client.py rebuild/livekit-agent/test_windows_adapter.py -q`。
- Windows：受控 Gateway + Windows runtime，验证唤醒、声纹拒绝、Bot 切换、TTS 音色、播放打断和重连。

## 15. 风险与回滚方式

- Phone Agent 运行依赖缺失时，插件保持 stopped/error，不影响 DS Bot 文字聊天。
- Bridge 或 LiveKit 失败时，停止外部进程并保留 Bot 配置和历史。
- 回滚通过关闭 Phone Agent 能力和停止其子进程完成；不删除 Bot voice profile。

## 16. 复杂度控制

- 只实现 Windows 首版所需的 Bridge 子集。
- 复用现有 DS Bot session、secret、插件页面和 Phone Agent runtime，不新增通用语音 provider 框架。
- Android、Alife 专用协议和跨设备同步只记录为后续范围。

## 17. 范围偏差记录

- 2026-11-06：本轮完成 DS Bot 侧配置模型、脱敏状态、Bot 唤醒词/TTS 音色设置页、语音输入提交入口和 Windows launcher 编排骨架；Phone Agent `agent-events.v1` 的完整 WebSocket Bridge、回复分段回流、凭据安全注入和真实 Windows 音频验收仍未完成。原因是现有 Phone Agent Bridge 仍绑定 Alife Core，不能直接把它当作 DS Bot Bridge 使用。该部分保留为下一实施步骤，不能把本轮代码视为整链路完成。

## 18. 关联的 module-evolution 决策

见 `docs/module-memory/phone-agent-voice-plugin.md`：D-PAVP-001 至 D-PAVP-013。

## 19. 变更记录

- 2026-11-06：根据用户确认的 Windows-only 首版、默认声纹、Bot 唤醒词、TTS 音色和语义续话范围建立并开始实施。
