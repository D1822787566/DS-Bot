# Phone Agent 语音插件开发文档

## 文档状态

Confirmed / Implementation not started

## 1. 目标与使用场景

将 Phone Agent 已验证的 Windows 音频、唤醒、ASR、主人声纹、语义续话和 TTS 链路迁入 DS Bot 仓库。迁移后的 Python 音频运行时由 DS Bot 托管为本地子进程；DS Bot Node Host 负责 Bot 角色、会话、模型调用和回复分段。运行时不得依赖外部 Phone Agent 项目路径，也不得依赖 Alife Core 或 Alife ChannelBridge。

## 2. 当前行为

- `[代码证据]` DS Bot 已有插件发现、安装、Bot 预设、Voice Mode 和 `/api/bot` 主机通道。
- `[代码证据]` Phone Agent 已有 Windows `MediaDevices` 音频适配、LiveKit 会话、唤醒映射、ASR、主人声纹、语义续话和 TTS Worker。
- `[代码证据]` 当前 DS Bot 的 `phone-agent.js` 主要是配置页、外部 `run-desktop.ps1` 启动器和文本提交骨架，没有迁移完整语音链路。
- `[代码证据]` Phone Agent 当前 Python runtime 的 `voice_agent.py`、`runtime.py` 和 C# ChannelBridge 仍绑定 Alife Core、Alife `character_id` 和 Alife ChannelBridge。
- `[代码证据]` Phone Agent 已有可迁移的 Windows 音频、唤醒、ASR、声纹、续话、TTS、LiveKit 和 `agent-events.v1` 测试基础。
- `[现状重建]` DS Bot 仍缺少 DS Bot Bot/session 到迁移后 Voice Runtime 的 Bridge、回复事件回流和音频生命周期适配层。

## 3. 期望行为

1. DS Bot 插件设置页提供运行状态、Windows 音频、Bot 唤醒词、Bot TTS 音色、ASR、LiveKit、主人声纹和高级语义续话设置。
2. 一个 Windows 设备可绑定多个 Bot；唤醒词映射选择当前 Bot，切换时停止旧音频播放。
3. 主人声纹默认启用；未录入或未通过时不提交语音输入。
4. 语音转写通过 DS Bot 自己的会话入口提交，沿用 Bot 的模型、上下文、权限和审批。
5. Bot 回复以分段事件发送给 Phone Agent，使用当前 Bot 的 TTS 音色播放。
6. 插件负责启动、停止和诊断 DS Bot 自有的本地语音运行时；Android 不纳入首版验收。

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
- 语音链路代码迁入 DS Bot 仓库；运行时可继续使用 Python 子进程，但不得把外部 Phone Agent 项目当作运行依赖。
- DS Bot Node Host 取代 Alife Core/ChannelBridge，成为语音输入对应 Bot 会话和回复事件的认知宿主。
- Python runtime 迁入 `ds-bot/voice-runtime/`；开发版直接运行仓库内 runtime，打包版随 app 资源分发。
- 保留 `agent-events.v1` 的事件语义；Bridge 绑定对象改为 DS Bot `bot_id` / `session_id`，不再使用 Alife `character_id`。
- 外部 Phone Agent 配置只做一次性迁移；迁移后由 DS Bot 持有和管理，运行时不再依赖外部 Phone Agent 项目。
- 插件默认启用时，由 DS Bot Host 自动启动和托管 Python voice-runtime；用户不需要单独打开终端或手动启动语音服务。Python 仍作为独立子进程运行，以隔离音频和模型依赖。

## 5. 待确认问题

无范围阻塞项。Python runtime 目录、协议语义和外部配置迁移方式已按第 4 节确认。

## 6. Agent 建议

- 将 Phone Agent Python 语音模块迁入 DS Bot 仓库并保持独立进程边界，避免把 Python LiveKit/ASR/TTS 依赖塞进 Electron/Node 主进程。
- 在 DS Bot Host 内实现本地 Bridge Server，使用 `agent-events.v1` 语义，但将 `character_id` 替换为 DS Bot `bot_id` / `session_id`，并由 DS Bot roster 生成 roles snapshot。
- `input.submit` 进入 DS Bot 的 `sessionController.prompt`；DS Bot 的 `session/event` 和 `agent/assistant-stream` 转换为 `output.started/segment/ended`，每段携带目标 Bot 的 TTS 音色。
- LiveKit 保留为迁移后 Python 音频运行时的音频传输层；LiveKit server、Python runtime 和 Bridge 都由 DS Bot 插件生命周期托管。
- 启动顺序为：DS Bot Host 加载插件 → 读取/迁移配置 → 启动本地 Bridge → 启动 Python voice-runtime → 建立 LiveKit/音频连接 → 发布 `listening`；任一步失败只让语音插件进入 `error`，不阻塞文字聊天。
- 凭据不进入 `state.json` 或 `/api/bot` 返回值；敏感值由 DS Bot secret store 或受控子进程环境注入。

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
- 外部 Phone Agent 项目作为 DS Bot 运行时依赖。

## 10. 技术方案

1. 盘点并迁入 Phone Agent 的可复用 Python 链路：Windows audio adapter/playback、wake mapping/session、bounded STT、owner verification、continuation、TTS worker、LiveKit runtime 及测试。
2. 删除迁移链路对 AlifeVoiceAgent、Alife Core、C# ChannelBridge 和外部项目路径的运行依赖；保留音频运行时需要的最小本地协议边界。
3. 在 DS Bot Host 增加 Bridge Server 和 session adapter：维护本地认证、绑定、序列、幂等、roles snapshot、input 状态、run/output/delivery/cancel。
4. 将 DS Bot Bot roster 映射为 runtime roles；将 `input.submit` 映射到目标 Bot 的既有 session；将 assistant stream 映射为分段 TTS 输出。
5. 将迁移后的 Python runtime、LiveKit 和 TTS worker 纳入 DS Bot 插件生命周期；开发版使用仓库内路径，打包版使用 app 资源路径。
6. 重做设置页，只展示 DS Bot 管理的设备、ASR、TTS、LiveKit、声纹和续话配置；外部路径只用于一次性迁移，不作为运行时必填项。

## 11. 影响范围

- `ds-bot/index.js`、`src/host/channel.js`、新增 `src/host/phone-agent.js`。
- `src/client/plugin-page.js`、`src/client/index.js`、新增客户端设置组件。
- DS Bot state migration、secret store 和测试。
- `package.json` 仅在 WebSocket Bridge 必要时增加现有兼容依赖。

## 12. 实施步骤

### 步骤 1：协议和配置模型

- 修改对象：迁移后的 runtime 配置模型、Bot voice profile、roles 映射和 DS Bot Bridge 状态。
- 完成条件：配置和角色映射不再出现 Alife `character_id` 依赖；无效唤醒词、重复唤醒词、无效音色和不安全地址被拒绝；凭据不出现在 view。

### 步骤 2：DS Bot Bridge

- 修改对象：DS Bot Host Bridge Server、Python runtime Bridge client、协议 schema 和角色快照。
- 完成条件：本地受控客户端可完成 hello/ready、roles snapshot、input submit、run/output、cancel、delivery 和重连；每个事件只影响绑定的 Bot/session。

### 步骤 3：Windows Runtime 编排

- 修改对象：仓库内 Python runtime、LiveKit/TTS worker 启停和 app 资源分发。
- 完成条件：不依赖 `E:\\project_space\\phone_agent`；DS Bot 可启动、停止、重启并回收迁移后的本地进程；缺少模型或设备时给出明确错误。

### 步骤 4：设置 UI

- 修改对象：Plugins 页面和客户端 API actions。
- 完成条件：用户可读取/保存 DS Bot 自有设置，编辑每 Bot 唤醒词和音色，并看到 Bridge、音频、声纹、TTS 和错误状态；页面不要求填写外部 Phone Agent 工程路径。

### 步骤 5：验证与验收

- 修改对象：DS Bot Host/Bridge tests、迁移后的 Python runtime tests、Windows acceptance scripts。
- 完成条件：协议、路由、幂等、回复回流、构建、lint 和受控 Windows 麦克风/扬声器验收通过；Android 不作为阻塞项。

## 13. 验收标准

### 功能验收

- 两个 Bot 绑定同一 Windows 设备时，分别说出唤醒词可切换目标。
- 目标 Bot 收到转写并在原聊天中生成回复。
- 回复使用目标 Bot 的音色并从 Windows 扬声器播放。
- 主人声纹未通过时不产生 Bot 输入。
- 插话或切换停止旧播放；明确停止任务才取消运行。
- DS Bot 关闭或 Bridge 断开后，Python runtime 不得继续向旧 Bot/session 投递事件。

### UI 与交互验收

- 设置页可完成设备、唤醒词、音色、ASR、TTS、LiveKit 和高级语义设置。
- 启动、连接、播放、暂停、错误和未录入声纹状态可见。
- DS Bot 启动后，在插件启用且配置有效时，用户无需手动运行脚本即可看到语音运行时进入 `listening` 或明确的 `error` 状态。
- 冲突和无效设置在保存时给出可理解错误。

### 安全验收

- API 返回和 UI 状态不包含 secret、API key、原始声纹或 PCM。
- Bridge 只允许受认证的 loopback 连接，旧 session 的事件不改变当前状态。

### 回归验收

- DS Bot 既有单元、构建和客户端 bundle 检查保持通过。
- Phone Agent 既有 Python 运行时定向协议测试保持通过。
- 迁移后不需要外部 Phone Agent 项目目录即可启动开发版 runtime。

## 14. 测试计划

- 先为 DS Bot roles snapshot、Bot/session 路由、Bridge 序列、幂等和回复回流写失败测试，再实现。
- DS Bot：定向 Phone Agent/Bridge 测试、完整 `npm test`、`npm run build`、`npm run lint`。
- 迁移后的 Python runtime：原有 `test_windows_*`、`test_wake_*`、`test_continuation_*`、`test_bridge_client.py` 及新增 DS Bot Bridge 集成测试。
- Windows：由 DS Bot 启动迁移后的 runtime，验证唤醒、声纹拒绝、Bot 切换、TTS 音色、播放打断、Bridge 重连和旧 session 丢弃。

## 15. 风险与回滚方式

- 迁移后的运行依赖缺失时，插件保持 stopped/error，不影响 DS Bot 文字聊天。
- Bridge 或 LiveKit 失败时，停止 DS Bot 托管的本地进程并保留 Bot 配置和历史。
- 回滚通过关闭 Phone Agent 能力和停止其子进程完成；不删除 Bot voice profile。

## 16. 复杂度控制

- 只实现 Windows 首版所需的 Bridge 子集。
- 复用现有 DS Bot session、secret、插件页面和迁移后的 Phone Agent runtime，不新增通用语音 provider 框架。
- 保留 Python 子进程边界，避免第一版重写 LiveKit/ASR/TTS 到 Node。
- Android、Alife 专用协议和跨设备同步只记录为后续范围。

## 17. 范围偏差记录

- 2026-11-06：曾按“启动外部 Phone Agent 项目”的方向实现配置页和 launcher 骨架；该方向被用户纠正并由本 Draft supersede，不作为迁移实现基线。
- 2026-11-07：用户确认采用“迁移 Python 音频链路到 DS Bot 仓库，DS Bot Node Host 接管 Bot 会话与 Bridge”的方向，并确认 `ds-bot/voice-runtime/`、保留 `agent-events.v1` 语义、外部配置一次性迁移三个细节；文档进入 Confirmed，尚未开始实现。

## 18. 关联的 module-evolution 决策

见 `docs/module-memory/phone-agent-voice-plugin.md`：D-PAVP-001 至 D-PAVP-013；迁移架构决策待本 Draft 确认后写入。

## 19. 变更记录

- 2026-11-06：根据用户确认的 Windows-only 首版、默认声纹、Bot 唤醒词、TTS 音色和语义续话范围建立并开始实施。
- 2026-11-07：根据用户纠正，技术方案改为“迁移 Phone Agent 语音链路进 DS Bot 仓库；Python 只负责音频与语音模型；DS Bot Node Host 负责 Bot 会话和 Bridge”，文档退回 Draft，等待完整确认。
