# Phone Agent 语音插件

记录状态：首版开发进行中
最近更新：2026-11-07

## 模块目标

- [用户确认] 将 Phone Agent 的语音链路作为 DS Bot 插件接入。
- [用户确认] 每个 Bot 可以绑定一个主唤醒词，并通过语音唤醒对应 Bot；Bot 作为 Phone Agent 中的角色。
- [用户确认] 用户可以在 DS Bot UI 中修改 Bot 的唤醒词。
- [用户确认] 一个设备可以同时绑定多个 Bot；同一时刻由唤醒词选择一个激活 Bot。
- [用户确认] 第一版必须接入 Windows 音频，包括电脑麦克风输入与扬声器播放。
- [用户确认] TTS 音色允许每个 Bot 单独设置。
- [用户确认] 语义连续对话模型第一版接入并启用，同时保留为高级可选功能，可在高级设置中启用或关闭。
- [用户确认] 插件负责准备并管理本地语音运行依赖，在设置界面显示启动进度与错误；用户不需要手动运行 Phone Agent 脚本。
- [用户确认] 插话或切换 Bot 时停止旧 Bot 的音频播放，但不默认取消 Bot 的后台工作；只有用户明确停止任务时才取消执行。
- [用户确认] 语音转写进入对应 Bot 的现有聊天，并沿用该 Bot 的模型、上下文、权限和审批规则。
- [用户确认] 首版优先复用 Phone Agent 已接通的 ASR、TTS 和语义续话后端；新增供应商另行适配。
- [用户确认] 首版默认启用主人声纹校验，并要求先录入主人声纹。
- [用户确认] 首版只验收 Windows 音频；Android 不纳入首版验收，后续另行接入或验收。
- [用户确认] 语音交互采用“唤醒词选择 Bot → 首轮直接说需求 → ASR 与主人声纹校验 → 提交到该 Bot 原有会话 → 按 Bot 音色播放回复”的流程；默认保留短时连续对话窗口，由语义模型判断追问是否属于当前 Bot。插话或切换只停止旧播放，明确停止任务才取消后台工作。

## 规划基线

- [用户确认] P1 迁移 Phone Agent Python 音频链路到 DS Bot 仓库，DS Bot Node Host 负责 Bridge、Bot/session 和回复回流；状态：进行中。旧的“复用外部 Voice Gateway/ChannelBridge”基线已由 D-PAVP-015 supersede。开发基线见 [Phone Agent 语音插件开发文档](../development/cross-module/phone-agent-voice-plugin-development.md)。
- [用户确认] P2 实现设备端唤醒词到 Bot 的映射、切换和旧会话取消；状态：进行中。
- [用户确认] P3 实现单设备多 Bot 绑定、唤醒词编辑和冲突校验；状态：进行中。
- [用户确认] P4 实现语音输入、Bot 回复、TTS 播放、暂停、停止和重连状态；状态：进行中。
- [用户确认] P5 完成 Windows 真实麦克风、扬声器与 DS Bot 集成验收；状态：未开始。Android 不纳入首版验收。

## 决策记录

- [用户确认] D-PAVP-001 · 2026-11-05 · DS Bot Bot 与 Phone Agent 角色一一对应；每个 Bot 绑定一个主唤醒词，语音唤醒后进入该 Bot 的会话。原因：让 Bot 成为可直接语音寻址的角色。影响：需要维护 Bot、唤醒词和设备会话之间的映射。
- [用户确认] D-PAVP-002 · 2026-11-05 · 唤醒词允许用户在 DS Bot UI 中修改。原因：唤醒词属于用户可配置的角色属性。影响：需要编辑入口、持久化、格式校验和冲突提示。
- [用户确认] D-PAVP-003 · 2026-11-05 · 一个设备允许同时绑定多个 Bot；一次只有一个 Bot 作为激活语音目标，明确唤醒另一个 Bot 时切换目标。原因：多 Bot 绑定是 DS Bot 的标准能力。影响：需要设备级唤醒映射、切换时取消旧会话和目标隔离。
- [候选建议] D-PAVP-004 · 2026-11-05 · 唤醒词分为主唤醒词和可选别名；同一设备内拒绝重复或高度相似的唤醒词。状态：待确认。
- [用户确认] D-PAVP-005 · 2026-11-05 · Windows 音频接入属于第一版必需范围。原因：用户明确纠正 Android 优先、Windows 留待后续的建议。影响：复用 Phone Agent 的 Windows 音频适配能力，验收覆盖真实麦克风输入、扬声器播放、唤醒和切换；Android 是否同时纳入首版仍待确认。
- [用户确认] D-PAVP-006 · 2026-11-05 · 每个 Bot 可以单独设置 TTS 音色。原因：用户明确接受按 Bot 配置音色。影响：合成请求需要携带目标 Bot 的音色，切换 Bot 时保持音色归属；模型与音色兼容性仍需设计和验证。
- [用户确认] D-PAVP-007 · 2026-11-05 · 语义连续对话模型第一版接入并启用，同时保留为高级可选功能。原因：用户要求首版可用且可选择。影响：高级设置提供启用/关闭入口及模型配置；关闭后的续话行为仍待定义，不将关闭语义判断等同于关闭唤醒或身份校验。
- [用户确认] D-PAVP-008 · 2026-11-06 · 插件负责准备、启动、停止和诊断本地 Gateway/LiveKit 等运行依赖。原因：用户接受“用户不需要手动运行脚本”的建议。影响：插件需要运行状态、启动进度、错误和停止入口。
- [用户确认] D-PAVP-009 · 2026-11-06 · 插话或 Bot 切换只停止旧音频播放，不默认取消旧 Bot 后台工作；用户明确停止任务时才取消执行。原因：区分语音播放控制和 Bot 工作取消。影响：需要区分 playback cancellation 与 run cancellation。
- [用户确认] D-PAVP-010 · 2026-11-06 · 语音转写复用对应 Bot 的现有聊天、模型、上下文、权限和审批规则。原因：保持文字与语音使用同一 Bot 会话语义。影响：插件不得绕过 DS Bot 的会话和权限边界。
- [用户确认] D-PAVP-011 · 2026-11-06 · 首版只复用 Phone Agent 已接通的 ASR、TTS 和语义续话后端；新增供应商另行适配。原因：控制首版复杂度。影响：设置页只暴露当前后端支持的配置项。
- [用户确认] D-PAVP-012 · 2026-11-06 · 首版默认启用主人声纹校验，使用前需要录入主人声纹。原因：用户确认采用默认启用。影响：插件需要提供声纹录入、状态显示、测试和失败提示；未完成录入时不能宣称语音链路可用。
- [用户确认] D-PAVP-013 · 2026-11-06 · 首版只验收 Windows 音频，Android 延后。原因：用户明确收窄首版验收平台。影响：首版测试覆盖 Windows 麦克风、扬声器、唤醒、切换、声纹和语义续话；Android 代码复用不纳入首版完成标准。
- [用户确认] D-PAVP-014 · 2026-11-06 · 按已确认开发文档开始实现，并在验证后提交、推送远程。原因：用户明确授权进入实施和交付。影响：本模块进入 In Progress；实现必须遵循开发文档，超出范围需记录并重新确认。
- [用户确认] D-PAVP-015 · 2026-11-07 · 将 Phone Agent 的 Python 音频链路迁入 DS Bot 仓库；Python 子进程只负责 Windows 音频、唤醒、ASR、声纹、续话和 TTS，DS Bot Node Host 负责 Bot 会话与 Bridge；不再把外部 Phone Agent 项目、Alife Core 或 Alife ChannelBridge 作为运行依赖。原因：用户明确纠正此前“启动外部 Phone Agent”方向。影响：旧 P1 技术基线被本决策 supersede；需重写迁移方案和协议适配后再实现。
- [用户确认] D-PAVP-016 · 2026-11-07 · Python runtime 迁入 `ds-bot/voice-runtime/`，开发版直接运行仓库内 runtime，打包版随 app 资源分发。原因：用户接受建议。影响：Phone Agent 运行时代码成为 DS Bot 仓库的一部分，不再依赖外部项目路径。
- [用户确认] D-PAVP-017 · 2026-11-07 · 保留 `agent-events.v1` 事件语义，但 Bridge 绑定对象改为 DS Bot `bot_id` / `session_id`。原因：复用已验证的协议顺序和幂等语义，同时切断 Alife `character_id` 依赖。影响：需要实现 DS Bot Host Bridge Server、roles snapshot 和 Bot/session 路由。
- [用户确认] D-PAVP-018 · 2026-11-07 · 外部 Phone Agent 配置只做一次性迁移，迁移后由 DS Bot 持有和管理，运行时不再依赖外部 Phone Agent 项目。原因：用户接受建议。影响：需要一次性配置迁移和 DS Bot 自有 runtime 配置持久化。
- [用户确认] D-PAVP-019 · 2026-11-07 · 插件默认启用时由 DS Bot Host 自动启动和托管 Python voice-runtime；用户不需要独立启动服务，Python 仍作为独立子进程运行。原因：延续“插件托管运行依赖、用户不手动运行脚本”和默认启用决策，同时隔离音频/模型依赖。影响：需要定义插件启动顺序、错误隔离、重连和退出回收。
- [用户确认] D-PAVP-020 · 2026-11-07 · 接受“唤醒后直接说需求、进入目标 Bot 原有会话、按 Bot 音色回复、短时语义续话、另一个唤醒词切换 Bot”的交互流程。来源：用户在流程说明后回复“可以的，那满足开发条件了吗”。影响：开发依据见[开发文档 7.1 和 10.1](../development/cross-module/phone-agent-voice-plugin-development.md)；首轮保留声纹校验，后续追问再做语义准入，切换只停止旧播放。
- [用户确认] D-PAVP-021 · 2026-11-07 · 首轮提交保留完整 ASR 文本，包括用户对 Bot 的称呼；仅在整段内容只有唤醒词时不提交。状态：已被 D-PAVP-022 supersede。原因：用户随后将范围扩展到连续对话中的每次提交。
- [用户确认] D-PAVP-022 · 2026-11-07 · 每个通过声纹和连续对话准入的语音段都把完整 ASR 文本发送给对应 Bot，包括 Bot 名称、标点和文本边界；不再按首轮/后续轮次删除称呼或其他内容。只有空转写和整段只有唤醒词时不提交。原因：用户明确要求所有轮次保留完整 ASR，避免任何内容遗漏。影响：语义连续对话模型仍决定后续语音段是否准入，但准入后的 Bridge/DS Bot prompt 使用原始 ASR 文本。

## 开发状态

- [代码证据] Phone Agent 已有角色唤醒映射、激活角色更新、会话绑定、切换取消和设备状态链路，可作为插件侧的复用基础。
- [代码证据] DS Bot 已有插件安装/检查、Voice Input、Voice Mode 和 Bot 预设绑定入口。
- [代码证据] 已建立首版开发文档；DS Bot 配置模型、脱敏状态、设置 UI、语音输入提交入口和 Windows launcher 编排骨架已实现；完整 Phone Agent Bridge、回复音频回流和真实 Windows 验收仍未完成。
- [代码证据] 首版基础实现已合并到 `main` 并推送远程，合并提交为 `45e911a`；当前工作区继续在 `main` 上实现迁移后的 Bridge 和 runtime，完整 Windows 链路仍未完成。
- [代码证据] 已在 `b19c471` 修正桌面 Host 的插件能力判断，并重新生成客户端包；当前启动窗口仍出现团队界面超时，Phone Agent 标签尚未完成运行中界面验收。
- [代码证据] 已在当前修复中让桌面启动握手在团队侧边栏首次挂载时立即调用 `dsBotApp.ready()`，不再等待首个 `state` 请求完成；新增回归测试覆盖空 roster 与 Agent 模式，客户端包已重新生成。
- [代码证据] Windows 源码启动实测已在引擎启动后约 1.2 秒完成团队界面 hand-off；日志未再出现 20 秒 `ready()` 超时，团队界面可见。
- [代码证据] Phone Agent 设置首次加载会从桌面 Phone Agent runtime 配置和 TTS `.env` 导入非敏感默认值；已保存的 DS Bot 配置优先覆盖导入值。新 Bot 未单独设置时显示 Bot 名称作为唤醒词，并继承全局 TTS 音色。
- [代码证据] 已修复旧版空配置覆盖导入默认值的问题：启动时会把现有 runtime、TTS 和 Windows 音频记录合并回 DS Bot 配置，并将 Phone Agent 工程根目录与 runtime 配置路径持久化；Windows launcher 启动时从本地 runtime 配置注入 Bridge 凭据到子进程环境，不返回到 UI。
- [代码证据] Windows 源码重启实测后配置已持久化为 `E:\\project_space\\phone_agent`、`D:\\phone_agent_runtime\\rebuild\\device-smoke\\runtime.json`、`C01` 和 `扬声器 (Philips SPA5308P)`；不再回退到 `.ds-bot-local\\phone_agent`。
- [代码证据] 上述配置导入和 launcher 修复属于被 D-PAVP-015 supersede 的过渡实现；当前不应视为语音链路迁移完成。
- [代码证据] 新架构的服务启动策略已实现首段：DS Bot Desktop Host 创建 loopback Bridge、注入一次性 credential 并托管 `voice-runtime/main.py` 子进程；Python runtime 现在会在报告 ready 前打开配置的 Windows 麦克风，使用 WASAPI 端点选择、采样率重采样和 Sherpa 唤醒模型处理 PCM，并把 stdout 诊断显示到设置页。模型不支持的唤醒词会显示为 `windows.wake.unsupported_names`，不会阻塞同一设备上其他可识别的中文唤醒词。
- [代码证据] Windows 源码桌面应用重启实测已看到托管 `python.exe main.py` 子进程持续运行；当前保存的 `Chief` 英文默认唤醒词被诊断为不支持，但 `华子` 等中文唤醒词仍可进入检测映射。唤醒候选现在通过认证 Bridge 的 `device.wake` 发送并由 DS Bot Host 确认，runtime 同时输出 `windows.wake.audio` 诊断；Phone Agent 设置每秒刷新运行状态和当前唤醒 Bot。
- [代码证据] 运行日志显示唤醒链路已产生 `device.wake` / `runtime.wake`，但没有 `input.submit` 或回复输出；下一阶段需要按开发文档 10.1 接入唤醒后语音段、VAD、ASR、声纹和 Bridge submit。
- [用户确认] 首版语音交互流程已确认并写入开发文档；真实 Windows 设备验收仍未完成，不能据此标记插件验收通过。
- [代码证据] DS Bot 自有 Python 3.12 环境已准备在 `.ds-bot-local/voice-runtime-env`，通过 pip check 和 FunASR/Torch/Torchaudio/LiveKit/Silero/Sherpa 导入验证；运行时不依赖外部 Phone Agent 虚拟环境。
- [代码证据] `voice-runtime` 已接入有界 PCM/VAD、Paraformer/CAM++、主人声纹准入、Bot/session/generation ownership、frozen 053 续话、TTS 排队/打断、Windows AEC 边界和回复回流；Python 定向测试当前为 `93 passed, 12 subtests passed`。
- [现状重建] 已用真实缓存音频做模型验收：主人语音转写且声纹通过；视频和 TTS 样本声纹拒绝。尚未用真实麦克风和扬声器完成 Desktop 端到端验收。
- [代码证据] 已在当前 Windows 设备打开并关闭配置的 `C01` 麦克风和 `扬声器 (Philips SPA5308P)`；已用私有 TTS 配置合成短 PCM 回复（3 个分片，23,040 字节）。这验证了设备打开和 provider 连接，尚未验证完整 Desktop Bridge 会话。
- [代码证据] 已修复 Windows 播放链路的音质失真：此前每个约 100 ms 的 TTS 小块单独从 16 kHz 插值到输出采样率，块边界会重置插值状态；现在使用 LiveKit 高质量有状态重采样器，跨 provider chunk 保持状态，停止时丢弃尾部，正常结束时先 flush 再停止设备。新增 7 个播放回归测试覆盖 16/44.1/48 kHz、不同 chunk 边界和打断；Python 测试为 `93 passed, 12 subtests passed`。
- [代码证据] 在用户反馈重采样修复后仍然沙哑后，已将 DS Bot 默认及当前 Windows Bot 配置从 `longshao_v3.1` 切换为已验证可用的 `longanlingxi_v3.1`；`qwen-audio-3.1-tts-flash` provider 直连合成和当前 48 kHz 扬声器播放均成功，应用已按新配置重启。音色是否主观清晰仍待用户复验。
- [代码证据] 已确认迁移差异：Phone Agent 原版使用 LiveKit `MediaDevices`/`OutputPlayer`，以 16 kHz `AudioTrack` 交给 LiveKit 的原生输出重采样；DS Bot 迁移版此前使用 `sounddevice.RawOutputStream` 接收 TTS PCM，再自行做 16→48 kHz 重采样。当前已改回 LiveKit 原生输出边界，TTS PCM 以 16 kHz `AudioSource`/`LocalAudioTrack` 输入，Windows 输出仍由 `MediaDevices` 处理。新增 native track、打断和不 drain 回归测试；Python 测试为 `88 passed, 12 subtests passed`。
- [代码证据] 已修复完整回复末尾被截断：正常结束时 `AudioSource.wait_for_playout()` 只代表源队列完成，`OutputPlayer` 内部 `_buffer` 仍可能有最后一个设备块；此前立即 `aclose()` 会丢掉尾音。现在 drain 会等待原生输出缓冲连续为空并覆盖一个设备块时长后再关闭；打断路径仍立即丢弃队列。新增回归覆盖“有 pending native buffer 时不得提前 close”。
- [代码证据] 已修复唤醒词与命令连续说出时的首段丢失：此前丢弃包含 KWS 命中的整个麦克风块，导致同一块中唤醒词之后的命令也被丢弃；现在把该块交给有界分段器，完整 ASR 继续进入后续准入流程。新增回归覆盖命中块仍进入 post-wake segment。
- [代码证据] 每个通过准入的语音段现在保留完整 ASR 文本；只用规范化比较判断“整段是否只有唤醒词”，不再修改带命令的文本。ASR、连续会话、Bridge 到 DS Bot prompt 均不再裁剪文本边界。新增回归覆盖首轮和后续轮次的 Bot 名称、标点及文本边界原样提交。

## 继续入口

- 当前入口：启动 DS Bot Desktop，检查 Phone Agent 状态进入 `listening`，说有效中文唤醒词后继续说需求，核对 `audio.segment.ended`、`identity.verified`、`input.submit`、`input.accepted`、`output.segment` 和扬声器输出；再验收切换 Bot、声纹拒绝、TTS 打断和 Bridge 重连。交互流程和代码链路已完成，Windows 物理设备验收仍待完成。
- 已完成：DS Bot roles snapshot、Bot/session submit 路由、assistant 分段回流、Bridge 鉴权/状态查询、托管 Python 子进程、设置页移除外部 Phone Agent 路径、运行诊断和自检面板、迁移 runtime 定向测试；已修复 runtime 将 `BridgeEvent` 错当作 roster mapping 的启动错误、Windows 重复音频设备名导致的 sounddevice 歧义错误、WASAPI 设备 48 kHz 与 TTS 16 kHz 的采样率不匹配、跨 TTS chunk 的重采样边界失真、Bridge 空闲超时误退出、桌面打包依赖缓存旧 runtime 文件、一个不支持的英文默认唤醒词导致整个 Windows runtime 无法启动的问题，以及唤醒候选未发送到 DS Bot Bridge 的问题。
- [候选建议] 若用户确认 `longanlingxi_v3.1` 听感清晰，将其作为首版默认音色保留；`longshao_v3.1` 仍可在每个 Bot 的音色设置中手动切回。
- 需要继续：将 `VoiceRuntime` 的唤醒事件连接到 ASR、声纹和 Bridge submit，增加进程重连、打包依赖和 Windows 端到端验收；当前错误、stdout、音频帧和检测计数诊断已在设置页显示。
- 验证入口：`node --import ./test/harness-resolve.mjs --test test/phone-agent.test.js test/voice-bridge.test.js test/plugins-client.test.js`；`python -m compileall -q voice-runtime`；`C:\Program Files\Python314\python.exe -m pytest -q ds-bot/voice-runtime`；受控 Windows 检查需看到 `windows.audio.input_ready`、`runtime.ready` 且唤醒任务持续运行。现有 launcher 过渡代码不作为完成标准。
