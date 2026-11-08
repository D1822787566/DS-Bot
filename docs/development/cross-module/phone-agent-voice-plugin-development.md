# Phone Agent 语音插件开发文档

## 文档状态

Confirmed / Implementation in progress

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
- **诊断**：运行自检，显示内置 runtime、Python 命令、Bridge 端口、进程状态和最近 stderr/stdout；切换页面后再次进入仍从 Host 读取当前状态。
- **Bot 与唤醒词**：逐 Bot 编辑主唤醒词、设备绑定和 TTS 音色；重复唤醒词保存时拒绝并指出冲突 Bot。
- **Windows 音频**：输入/输出设备名称、设备扫描、连接测试。
- **ASR / TTS / LiveKit**：显示当前 Phone Agent 后端与可编辑的已支持配置。
- **高级**：语义续话开关、模型、阈值和超时；主人声纹录入/替换与测试。

状态至少包括 `stopped`、`starting`、`ready`、`listening`、`speaking`、`paused`、`error`。保存失败、设备缺失、声纹未录入和运行时断线都显示明确错误。

### 7.1 用户语音交互流程

`[用户确认]` 首版交互按以下流程实施。这里描述目标行为；当前唤醒后的输入闭环尚未完成。

1. 插件由 DS Bot 自动启动，进入 `listening`，等待设备上的任一 Bot 唤醒词。
2. 用户说出某个 Bot 的唤醒词，例如“华子”。该唤醒词映射到对应的 `bot_id`，并打开一次 `wake_session_id`。
3. 用户在唤醒后直接说需求，不需要重复说唤醒词。唤醒词本身不作为一条任务提交；首轮需求仍需通过主人声纹校验，但不需要语义续话模型再次判定是否对该 Bot 说话。
4. VAD 结束语音段后，运行时并行执行 ASR 和主人声纹校验。只有非空转写、同一 `segment_id` 的主人声纹通过且 runtime generation 仍有效时，才发送 `input.submit`。
5. `input.submit` 进入该 Bot 原有的 DS Bot 会话，沿用该 Bot 的模型、上下文、权限和审批。转写结果同时进入该 Bot 的文字聊天记录。
6. DS Bot 以 `output.started`、`output.segment`、`output.ended` 回流回复；运行时按目标 Bot 的 TTS 音色合成并从 Windows 扬声器播放。
7. 回复完成后的短时窗口内，用户可以继续追问，例如“再说具体一点”。每一段仍执行 ASR 和声纹校验，再由语义续话模型判断是否继续对当前 Bot 说话；未通过时不提交，窗口超时后需要重新唤醒。
8. 用户说另一个 Bot 的唤醒词时，停止当前回复的音频播放并切换目标 Bot；旧 Bot 的后台任务不因插话自动取消。通过 DS Bot 现有的“停止任务”操作明确取消时，才取消 Bot 工作。

设置页持续显示当前 Bot、当前阶段、最近一段语音的处理结果和失败原因；UI 只显示脱敏诊断，不显示原始 PCM、声纹文件或凭据。

`[代码证据]` 迁入的 `wake_session.py` 默认首轮等待 8 秒、连续对话窗口 12 秒、澄清等待 5 秒；这些是当前实现默认值，后续接线沿用现有配置。语义不确定时复用 Phone Agent 的确认提示与超时处理，不将不确定、模型失败或关闭语义判断等同于准入通过。

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

### 10.1 唤醒后的语音输入闭环（实现中）

- `[代码证据]` 当前日志已经证明 KWS 唤醒成功：`keyword_results`、`valid_hits`、`device.wake` 和 `runtime.wake` 均已产生。
- `[代码证据]` 当前日志没有 `input.submit`、`input.accepted`、`output.started` 或 `output.segment`；唤醒后的语音段、ASR、声纹和 Bot 提交尚未接通。
- `[用户确认]` 下面的链路是本轮确认后的实现清单；它们落实第 4 节已经确认的“语音转写进入对应 Bot 会话”和“默认主人声纹校验”，不新增供应商或新的权限边界。

| 顺序 | 要接的模块 | 输入 | 输出与失败行为 |
|---|---|---|---|
| 1 | 唤醒后语音段采集器 | `device.wake`、连续 PCM、当前 `bot_id` 和 `wake_session_id` | 打开一次有界语音段；记录开始、结束、超时和取消；不保存原始 PCM 到日志 |
| 2 | VAD / 语音边界 | 16 kHz 单声道 PCM | 产生 `audio.segment.started` / `audio.segment.ended`；静音超时丢弃段，设备断开取消段 |
| 3 | ASR 适配器 | 完整 `AudioSegment`、ASR model directory、Bot 唤醒词热词 | 调用迁移后的 Paraformer/FunASR 适配器，输出最终文本；模型缺失、空文本和超时都拒绝提交 |
| 4 | 主人声纹校验 | 同一 `AudioSegment`、CAM++ model directory、主人 profile | 输出 `owner_verified`、`score`、`model_id` 和 `profile_version`；未录入、低分、超时或段 ID 不一致时 fail-closed |
| 5 | 语音准入与连续对话 | ASR 文本、声纹结果、当前唤醒会话和 Bot context | 复用 Phone Agent 的首轮/连续对话策略；切换 Bot 或旧 generation 的迟到结果丢弃 |
| 6 | Bridge submit | `bot_id`、最终文本、`owner_verified` speaker evidence | 发送 `input.submit`；等待 `input.accepted` / `input.rejected` / 状态结果；禁止绕过 DS Bot sessionController |
| 7 | 现有回复回流 | `run.started`、`output.started`、`output.segment`、`output.ended` | 沿用目标 Bot 的 TTS 音色，播放 PCM；插话或 Bot 切换只停止旧播放 |
| 8 | 可观测性 | 每一步状态和错误码 | UI 显示当前阶段和下一步；日志只记录计数、耗时、Bot/session ID、错误码，不记录 PCM、secret、原始声纹或完整转写 |

#### 10.1.1 运行依赖和边界

- `[候选建议]` ASR 和声纹依赖必须进入 DS Bot 自己管理的 Python runtime 环境。当前系统 Python 已有 `sherpa-onnx`，但没有 FunASR/Torch；开发版需要准备可复现的 ASR/声纹依赖环境，不能把 `E:\project_space\phone_agent` 的虚拟环境作为运行时依赖。
- `[候选建议]` `asrModelDir`、`speakerModelDir` 和 `speakerProfileDir` 仍由 DS Bot 配置持有；模型加载失败在 `starting` 阶段转为明确 `error`，不影响文字聊天。
- `[候选建议]` 每个语音段必须携带 `wake_session_id`、`bot_id`、`segment_id` 和 runtime generation。Bridge、ASR、声纹和 submit 只接受同一组标识。

#### 10.1.2 完成条件

- `[用户确认]` 说出有效唤醒词后，用户继续说一句话，日志依次出现 `audio.segment.ended`、ASR 完成、声纹完成、`input.submit`、`input.accepted` 和回复输出事件。
- `[用户确认]` 声纹失败时出现拒绝诊断，不产生 `input.submit`。
- `[用户确认]` ASR 或模型依赖失败时出现明确错误，不会把空文本提交给 Bot。
- `[用户确认]` Bot 切换、Bridge 重连或 runtime 停止后，旧语音段不能提交到旧 Bot/session。
- `[用户确认]` 语音测试面板清零后重复测试可以区分唤醒候选、音频丢帧、ASR、主人声纹和 Bridge 提交失败；面板不保存原始音频或完整转写。

- `[代码证据]` 已实现 `speech_capture.py` 的有界 PCM/Silero VAD 分段、`speech_models.py` 的 Paraformer/CAM++ 并行推理与超时占位、`voice_input.py` 的首轮/连续对话准入、`voice_output.py` 的可打断 TTS 队列、`audio_processing.py` 的 Windows AEC 处理边界，以及 `main.py` 到这些组件的托管接线。
- `[代码证据]` 已实现 DS Bot 自有 Python 3.12 环境准备、模型和 TTS 私有配置迁移、frozen 053 续话 provider 的 DS Bot 私有适配、Bridge wake/session/generation 隔离和 roster 变更刷新。
- `[代码证据]` 固定 PCM、ASR/CAM++ fixture、续话服务、Bridge、环境准备和 Python runtime 测试已通过；真实模型 fixture 已验证主人语音转写/声纹通过，视频和 TTS 样本未通过主人声纹。
- `[代码证据]` 当前 Windows 设备的配置麦克风 `C01` 和扬声器 `Philips SPA5308P` 已成功打开并关闭；私有 TTS provider 已成功合成短 PCM 流。该检查尚未替代 Desktop Bridge 端到端验收。
- `[代码证据]` 已修复 Windows 播放的跨块重采样失真：TTS 的 16 kHz PCM 现在由有状态的高质量重采样器连续转换到设备采样率，再按输出设备块大小写入；正常结束会 flush，打断会丢弃重采样尾部。该修复覆盖 16 kHz、44.1 kHz、48 kHz 设备及多种 provider chunk 边界，已通过 `93 passed, 12 subtests passed` 的 Python runtime 测试。真实桌面听感仍需用户复验。
- `[代码证据]` 用户反馈上述修复后仍然沙哑。为区分播放链路与音色本身，已将默认及当前 Bot 音色切换为已验证兼容 `qwen-audio-3.1-tts-flash` 的 `longanlingxi_v3.1`，并在当前 48 kHz Windows 输出设备上完成直连合成与播放测试；主观清晰度仍待用户复验。音色仍可通过 Bot 设置单独修改。
- `[代码证据]` 迁移对比发现原版 Phone Agent 通过 LiveKit `MediaDevices`/`OutputPlayer` 播放 16 kHz TTS track；DS Bot 之前绕过该边界，使用 `RawOutputStream` 和自有重采样。当前已恢复 LiveKit 原生输出：`AudioSource(16000)` → `LocalAudioTrack` → `MediaDevices.open_output(48000)`，避免迁移版自行解释 PCM 播放时引入音质差异。Python runtime 当前为 `88 passed, 12 subtests passed`。
- `[代码证据]` 已补齐正常结束的尾音收尾：`AudioSource.wait_for_playout()` 后继续等待 `OutputPlayer` 内部缓冲为空并经过一个输出 block，再关闭播放器；插话和切换仍直接停止。该修复针对“最后几个字没有说完”，避免正常完成路径误用打断式关闭。
- `[用户确认]` 每个通过声纹和连续对话准入的语音段都提交完整 ASR 文本，包括配置唤醒词、标点和文本边界；只有 ASR 内容为空或规范化后完全等于唤醒词时才不提交。语义连续对话模型仍负责后续语音段的准入判断，准入后不再删除任何称呼或其他内容。
- `[代码证据]` 已修复所有轮次的 ASR 内容裁剪：ASR 返回、首轮/连续对话准入、澄清暂存和 DS Bot Bridge prompt 均保留原始文本；回归测试确认“华子，检查项目”和“华子，再具体一点”原样进入 Bridge submit。
- `[代码证据]` 已修复唤醒词和命令在同一音频块中时的输入截断：Windows KWS 命中后不再丢弃命中块，命中块继续进入 VAD/ASR。
- `[代码证据]` 已增加 Phone Agent 语音测试面板和安全指标聚合：清零后重复说唤醒词和短指令，UI 显示输入帧/丢帧、RMS/峰值、KWS 结果和命中、VAD 段、ASR、主人声纹分数与拒绝原因、Bridge 提交结果及最近事件；不显示 PCM、完整转写、声纹原文或 secret。
- `[代码证据]` 测试面板会把指标转换成自然语言结论，例如近乎静音、没有唤醒词、没有 VAD 语音段、ASR 未完成或声纹拒绝。
- `[代码证据]` 语音测试面板的用户可见文字已中文化，最近事件也使用中文阶段名称。
- `[用户确认]` 面板的独立声纹测试不依赖唤醒词；下一段 VAD 语音只做 ASR/CAM++ 验证，不提交 Bot，20 秒无语音自动结束。
- `[代码证据]` 已修复 Windows 输入重采样跨块状态丢失：采集设备常见的 48 kHz PCM 现在通过有状态重采样器连续转换到 16 kHz，再进入 KWS、VAD、ASR 和声纹；新增回归覆盖分块转换一致性。输入诊断增加 RMS、峰值和丢块计数。
- `[待完成]` 现有历史启动日志只有 runtime ready 信息，不能回溯此前的失败阶段；需要在新面板清零后做一轮真实 Windows 重复测试，才能判断主要损失发生在音量/丢帧、KWS、VAD、ASR 还是声纹。
- `[待完成]` 仍需在 DS Bot Desktop 中启动托管 runtime，验证真实 Windows 麦克风、主人声纹、TTS 网络回复、扬声器播放、Bot 切换和重连；这些物理设备验收未由自动化测试替代。

### 10.2 开发条件核对

- `[用户确认]` 需求范围、Python/Node 职责边界、插件托管启动、Bot 会话复用和第 7.1 节的交互流程已有确认，可以继续开发第 10.1 节，无需再确认主方案。
- `[代码证据]` Windows 麦克风采集、Sherpa 唤醒和 `device.wake` Bridge 路由已有实现及运行日志；ASR/CAM++、短时会话和语义续话模块已有迁入源码，但尚未组成可验收的完整语音对话。
- `[代码证据]` 当前默认 Windows Python 3.14 未安装 FunASR/Torch；外部 Phone Agent 的 Python 3.12 环境可导入这些依赖。开发时需要为 DS Bot 单独准备兼容环境，不能把外部项目虚拟环境作为正式运行依赖。
- `[代码证据]` DS Bot 自有语音依赖已准备并通过 `pip check`、FunASR/Torch/Torchaudio/LiveKit/Silero/Sherpa 导入检查；固定 PCM、模型和 Bridge 测试已补齐失败、切换和迟到结果。
- 后续工程工作：启动 Desktop 做真实 Windows 设备验收，并根据设备日志修复只在物理音频链路出现的问题。
- 完成以上实现并通过第 13 节 Windows 真实麦克风和扬声器验收后，才能标记语音插件可用；“满足开发条件”和“验收通过”分别记录。

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
- 下一执行顺序：准备 DS Bot 自有且兼容 FunASR/Torch 的 Python 语音环境；实现 10.1 的语音段采集和 VAD，再接 ASR/声纹 provider，最后接 `input.submit`、现有回复回流和语义续话，并做 Windows 端到端验收。

### 步骤 4：设置 UI

- 修改对象：Plugins 页面和客户端 API actions。
- 完成条件：用户可读取/保存 DS Bot 自有设置，编辑每 Bot 唤醒词和音色，并看到 Bridge、音频、声纹、TTS 和错误状态；页面不要求填写外部 Phone Agent 工程路径。
- `[代码证据]` 设置页已提供语音测试面板、计数清零和最近安全事件视图。

### 步骤 5：验证与验收

- 修改对象：DS Bot Host/Bridge tests、迁移后的 Python runtime tests、Windows acceptance scripts。
- 完成条件：协议、路由、幂等、回复回流、构建、lint 和受控 Windows 麦克风/扬声器验收通过；Android 不作为阻塞项。
- `[待完成]` 使用测试面板完成至少一轮清零后的重复唤醒、ASR、声纹和提交统计；当前不能用历史启动日志替代这轮物理设备验收。

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
- 下一阶段专项测试：使用固定 PCM fixture 验证 VAD 边界、ASR 文本、声纹通过/拒绝、空文本拒绝、`device.wake` 到 `input.submit` 的事件顺序，以及旧 generation 丢弃；再做真实 Windows 麦克风和主人声纹验收。

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

见 `docs/module-memory/phone-agent-voice-plugin.md`：D-PAVP-001 至 D-PAVP-020。

## 19. 变更记录

- 2026-11-06：根据用户确认的 Windows-only 首版、默认声纹、Bot 唤醒词、TTS 音色和语义续话范围建立并开始实施。
- 2026-11-07：根据用户纠正，技术方案改为“迁移 Phone Agent 语音链路进 DS Bot 仓库；Python 只负责音频与语音模型；DS Bot Node Host 负责 Bot 会话和 Bridge”，并确认 runtime 目录、协议语义、一次性配置迁移和插件自动启动策略。
- 2026-11-07：开始按确认架构实现 DS Bot Host Bridge、仓库内 Python runtime 入口、托管子进程生命周期和设置页去外部路径化；随后接入 Windows 麦克风采集、WASAPI 端点选择和 Sherpa 唤醒检测，并把运行时 stdout 诊断显示到设置页；发现英文默认 Bot 名称不在当前中文 KWS 模型词表后改为跳过不支持的名称并保留可识别 Bot，避免一个配置阻塞整个 runtime；ASR、主人声纹、唤醒后的语音段提交和端到端播放验收仍未完成。
- 2026-11-07：补齐 `device.wake` 的 DS Bot Bridge 路由和 `windows.wake.audio` 诊断，使唤醒候选可被 Host 确认并能区分“没有音频”“没有命中”和“未完成后续 ASR”三种状态。
- 2026-11-07：根据运行日志补充“唤醒后的语音输入闭环”清单，明确下一阶段需要接入语音段采集、VAD、Paraformer/FunASR ASR、CAM++ 声纹、语音准入、`input.submit`、回复回流和可观测性；当前仍未把这些候选步骤标记为已完成。
- 2026-11-07：用户确认首版 Bot 语音交互流程，补充第 7.1 节和开发条件核对；第 10.1 节从候选清单改为确认后的开发依据。依赖环境准备、唤醒后的输入闭环和 Windows 端到端验收仍待完成。
- 2026-11-07：开始实现 10.1：迁入 DS Bot 自有 Python 3.12 依赖准备，接入有界 PCM/VAD、Paraformer/CAM++、主人声纹、wake/session/generation ownership、frozen 053 续话、TTS 队列/打断、Windows AEC 边界和 roster 刷新；固定测试和缓存音频模型验证通过，真实 Windows Desktop 设备验收待完成。
