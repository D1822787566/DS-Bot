# 本地语音类全双工最小闭环开发文档

## 文档状态

Confirmed（模型 smoke test 已完成，完整实现验收进行中）

本文件定义一个**独立的本地语音插件**，参考现有 [Phone Agent 语音插件开发文档](phone-agent-voice-plugin-development.md) 的稳定做法，但不修改或接管 Phone Agent。它只覆盖本地 TTS、语音最小闭环、首字延迟和可打断播放；唤醒词、主人声纹、Bot/session Bridge、Windows 音频和测试中心由新插件自己持有。

## 1. 目标与使用场景

### 目标

在不影响现有 Phone Agent 的前提下，新增一个独立 Windows 语音插件，完成一个不依赖原生全双工模型的类全双工语音闭环：用户说话后，系统尽快开始生成并播放第一段回复；播放期间继续监听用户；用户插话时立即停止旧回复并处理新输入。

### 使用场景

用户唤醒一个 Bot 后说出需求，系统将语音转写提交到该 Bot 现有会话，使用现有 LLM 生成回复，再通过本地 TTS 流式播放；用户可以在播放中插话，旧音频不会继续播放。

## 2. 当前行为

- [代码证据] `ds-bot/voice-runtime/` 已有 Windows 音频采集、VAD 分段、ASR、主人声纹、Bot/session Bridge、TTS worker、可打断播放和语音测试中心。
- [代码证据] 当前 TTS provider 是保留的 Qwen 云端 WebSocket TTS，`shared-tts.v1` 已支持 PCM16 流式块、取消和完成事件。
- [代码证据] 当前 ASR 适配器以语音段完成后的最终文本为主，不向用户承诺流式中间转写。
- [代码证据] 当前回复已经按 `output.segment` 进入 TTS 队列，播放支持插话中断；真实 Windows 麦克风、扬声器和完整 Desktop Bridge 验收仍未完成。
- [代码证据] 现有 Phone Agent 已拥有自己的配置、Host 生命周期、Python runtime、测试中心和音频设备控制；直接把本方案接入其中会扩大现有插件变更面。
- [用户确认] AnifLive-TTS 暂不作为第一版语音后端。
- [代码证据] `local-voice/` 已创建独立 DSH 插件包，包含 Host 配置校验、设备租约、loopback API、Local Voice 设置页、Node runtime client、分段 TTS loop 和并发 Python JSON-lines runtime。
- [代码证据] 独立 `.ds-bot-local/local-voice-env` 已可加载 FunASR Paraformer-zh 和本地 MeloTTS 中文 checkpoint；当前 PyTorch 为 CPU-only。
- [代码证据] 固定样例 smoke 已完成：runtime ready 同时报告 ASR/TTS，ASR 返回完整最终文本，MeloTTS 输出 16 kHz PCM16；预热后短句生成约 0.38–0.40 s，冷启动约 19.6 s。
- [现状重建] MeloTTS 上游元数据与当前 FunASR 依赖存在 pip check 版本差异；运行时通过 `unidic-lite`、中文导入兼容层和本地离线模型路径工作，正式安装脚本仍需固化。
- [代码证据] 2026-11-10 已将独立 Local Voice bundle 挂入 Desktop profile 和安装依赖，源码启动器同步插件包；重启后入口为“插件 → Local Voice（本地语音）”。已用隔离真实 Host 验证页面打开和独立配置保存；当前页面只提供模型加载与配置，明确标注完整对话仍在开发。

## 3. 期望行为

1. 本地语音运行时持续采集麦克风并使用 VAD 形成有界语音段。
2. 语音段完成后调用本地 ASR，输出最终文本并提交到目标 Bot 的现有会话。
3. 现有 LLM 以流式事件返回回复，系统按短句或安全语义边界将回复交给本地 TTS。
4. 本地 TTS 在模型常驻和预热后以 PCM16 音频块返回；播放器收到首块即可开始播放。
5. 播放期间麦克风仍持续监听；检测到有效用户语音时，停止当前播放、清空未播放队列并取消当前 TTS/回复生成。
6. 新一轮输入使用新的 `generation` / `response_id`，旧请求的迟到事件不得进入播放器或 Bot 会话。
7. 表情球和语音状态至少显示 `listening`、`thinking`、`speaking`、`interrupted`、`idle`、`error`。

## 4. 已确认决策

- [用户确认] 第一版不采用 AnifLive-TTS。
- [用户确认] 第一版优先使用本地 TTS，不以云端 TTS 作为正式首选。
- [用户确认] 思考模型接入当前项目已有可用 LLM，不在本计划内更换思考模型。
- [用户确认] 先完成最小闭环，再扩展复杂 Agent、视觉输入和更多表达能力。
- [用户确认] 语音输出必须支持流式播放和可打断；不能等完整答案和完整音频生成后才开始播放。
- [用户确认] 保留现有唤醒词和主人声纹作为语音输入的必经路径。
- [用户确认] ASR 第一版向用户显示完整最终文本；不要求显示中间增量文本。
- [用户确认] 第一版只验收中文和 Windows 单设备。
- [用户确认] 本方案作为独立插件开发，不修改现有 Phone Agent 的功能、配置、生命周期和 UI。

## 5. 待确认问题

1. MeloTTS 中文模型能否在当前 Windows + RTX 5060 8 GB 环境稳定运行，并达到首字延迟目标？若失败，是否切换到 CosyVoice2-0.5B。
2. 角色音色克隆是否进入后续版本；MeloTTS MVP 先使用内置中文音色。
3. MeloTTS smoke test 失败时是否切换 CosyVoice2-0.5B；该项属于实施阶段的技术验收，不改变插件边界。

## 6. Agent 建议

- [候选建议] 新插件拥有独立的 Python 子进程、Bridge、配置目录、状态和测试；只复用 DSH 公开插件 API，不导入 Phone Agent 的内部模块。
- [候选建议] 新插件可以复用已经验证的协议思想和纯数据模型，但第一版不提取共享运行时库，避免新旧插件互相牵制；重复部分稳定后再评估抽取。
- [用户确认] 独立插件采用 `local-voice/` 作为包目录和插件标识，显示名称使用 `Local Voice`。
- [候选建议] 第一版 TTS 选用 **MeloTTS 中文模型**：官方项目支持中文、宣称 CPU 实时推理、Python 接入简单并采用 MIT 许可证；MVP 以短句级流式衔接实现首字快速播放，不把模型内部 token 级流式作为硬依赖。来源：[MeloTTS 官方仓库](https://github.com/myshell-ai/MeloTTS)。
- [候选建议] **CosyVoice2-0.5B** 作为第二候选：官方项目明确支持流式推理和零样本音色克隆，但运行时和显存风险更高，待 MeloTTS MVP 验收后再评估。来源：[CosyVoice 官方仓库](https://github.com/FunAudioLLM/CosyVoice)。
- [候选建议] ASR 继续使用当前已接入的 **FunASR Paraformer-zh** 做分段最终识别，保留现有 Silero VAD、Sherpa 唤醒和 CAM++ 主人声纹；FunASR 官方将 Paraformer-zh 列为中文生产路径，并另提供 `paraformer-zh-streaming` 供后续增量识别。来源：[FunASR 官方仓库](https://github.com/modelscope/FunASR)。
- [候选建议] 第一版不切换到 Whisper 或更大的 LLM ASR；先保持现有 ASR 适配器和模型依赖，减少迁移风险。
- [候选建议] 先把现有云端 TTS provider 抽象为可替换的本地 provider，保留云端 provider 作为回归和回滚选项，直到本地模型完成真实听感验收。
- [候选建议] ASR 第一版继续使用分段最终文本，先把首字延迟和打断链路做稳定；流式中间转写另列为后续优化。
- [候选建议] 先用现有 `output.segment` 作为 TTS 分段输入，不在本计划中重新设计 LLM 输出协议。
- [候选建议] 以“语音段结束到首个可听音时间”作为主指标，以阶段耗时和插话停止时间作为诊断指标；所有指标按预热后固定中文短句重复 10 次报告 P50/P95。
- [代码证据] `LocalVoiceLoop` 已按 LLM segment 调用本地 TTS，并以 generation 丢弃迟到 segment；runtime client 的 PCM 流支持 request-level cancel。

## 7. UI 与交互依据

### 现有 UI 复用

- [代码证据] 现有 Phone Agent 设置和语音测试中心已经有运行状态、ASR、TTS/扬声器、完整链路测试入口。
- [用户确认] 第一版只验收中文和 Windows 单设备；新插件沿用 DS Bot 的界面规范，不引入 AnifLive-TTS 的独立 WebUI。
- [候选建议] 新插件拥有自己的设置页和测试中心，视觉样式复用 DS Bot 设计原语，不修改 Phone Agent 的测试中心。
- [候选建议] 在 TTS/扬声器测试中显示 provider 类型、模型是否已加载、预热状态、首块延迟、TTFA、取消结果和错误原因。

### 用户可见的语音对话界面

新插件提供自己的 VoiceMode 浮层，沿用 DS Bot 的视觉原语和现有语音面板交互，但不修改 Phone Agent 的 VoiceMode。BotMark、当前阶段、最近一条完整用户文本和当前播放中的助手文本在同一个面板内变化。

| 状态 | 主视觉 | 文本 | 可用操作 |
|---|---|---|---|
| `idle` | BotMark 静止 | “等待唤醒词” | 开始/关闭语音对话 |
| `listening` | 光环轻微呼吸，显示输入音量 | “正在听” | 暂停监听、结束语音 |
| `thinking` | 光环缓慢呼吸 | “正在思考” | 结束语音 |
| `speaking` | 光环随播放音量律动 | 显示当前完整用户文本和已生成的助手文本 | 插话/停止播放、结束语音 |
| `interrupted` | 光环立即收缩后回到监听 | “已打断，正在听” | 无需额外确认 |
| `error` | 使用错误状态色，不持续动画 | 显示可理解的错误和下一步 | 重试、打开设置 |

主界面只显示用户需要的信息，不显示模型路径、凭据、PCM、声纹分数和详细阶段耗时。用户说完后显示完整最终 ASR 文本；不显示不断变化的中间文本。

### 语音测试中心

现有测试中心继续使用两个层级：

1. **运行配置**：语音开关、设备、模型状态、Bot 唤醒词、Bot 音色、主人声纹状态。
2. **语音测试中心**：麦克风、唤醒词、ASR、主人声纹、TTS/扬声器、完整链路。

新增一个“延迟与打断”结果卡片，显示：

- 最近一次和最近十次的 TTFA P50/P95；
- ASR 完成耗时、LLM 首段耗时、TTS 首 PCM 耗时；
- 播放开始、正常完成和插话停止结果；
- 当前模型是否为预热状态；
- 失败阶段和安全错误码。

测试中心显示完整最终 ASR 文本，且明确标注“测试不会提交 Bot”。

### 用户流程

```text
idle
  ↓ 唤醒
listening
  ↓ 语音段完成
thinking
  ↓ 第一段音频开始
speaking
  ├─ 有效插话 → interrupted → listening
  ├─ 播放完成 → idle 或 listening
  └─ 错误 → error
```

### UI 仍需在原型评审中确认

- “思考中”是否播放短提示音；
- 插话时使用立即停止、短淡出还是静音切换；
- 语音对话浮层在小窗口下的收缩顺序；
- 延迟指标是否只在测试中心展示，还是允许高级用户在语音浮层中查看最近一次结果。

## 8. 安全边界

### 保护对象

- 本地 TTS 模型和音色配置；
- ASR 模型和本地语音数据；
- Bot/session 凭据；
- 主人声纹向量和音频设备。

### 信任边界

```text
DS Bot Host
  ↕ loopback authenticated Bridge
Python voice-runtime
  ├─ Windows microphone / speaker
  ├─ local ASR
  └─ local TTS
```

### 最低控制

- [代码证据] Python runtime 已通过本地 Bridge credential 和 generation/session 归属限制事件。
- [候选建议] 本地 TTS provider 只接受 loopback worker 请求，不监听公网地址。
- [候选建议] 日志只记录阶段、耗时、错误码和计数，不记录完整 PCM、声纹内容或凭据。
- [候选建议] 插话取消必须同时清理播放队列、TTS 取消 token 和当前回复 generation。
- [候选建议] 继续沿用现有主人声纹和 DS Bot 权限边界；不因更换 TTS 放宽语音提交准入。
- [候选建议] 同一 Windows 设备的麦克风和唤醒词资源只能由一个语音插件持有。Local Voice 启动时如果 Phone Agent 正在占用设备，应显示冲突并停止启动，不自动停止或改写 Phone Agent。

## 9. 功能范围

### 包含

- 本地 TTS provider 选型和可复现安装；
- 现有 TTS worker 接入本地 provider；
- TTS 模型常驻和启动预热；
- LLM 分段回复到 TTS 的流式衔接；
- PCM 音频块播放、队列、正常 drain 和插话取消；
- ASR → 现有 LLM → 本地 TTS → 播放的最小闭环；
- `generation` / `response_id` 迟到事件隔离；
- 语音测试中心的 TTS、完整链路、首字延迟和打断观测；
- 独立插件的安装、启停、配置、诊断和 UI；
- Windows 单设备回归与真实设备验收。

### 不包含

- AnifLive-TTS、TensorRT、Docker 或 GPT-SoVITS 模型转换；
- 原生全双工语音模型；
- 摄像头、屏幕共享和视觉理解；
- 新的思考模型、Agent 编排平台或工具系统；
- Android 验收；
- 多用户、多设备广播和公网语音服务；
- 流式 ASR 中间文本。

## 10. 技术方案

### 10.1 链路

```text
Windows microphone
  ↓ PCM
VAD / segmenter
  ↓ completed AudioSegment
local ASR
  ↓ final transcript
DS Bot Bridge / existing LLM session
  ↓ output.started + output.segment
local TTS worker
  ↓ PCM16 chunks
interruptible playback
  ↓ state / emotion events
Bot UI and emotion ball
```

### 10.2 TTS 接口

沿用当前 `shared-tts.v1`，请求和音频契约保持：

```text
input: text, voice, request_id, response_id
output: 16 kHz, mono, PCM S16LE chunks
control: ready, audio, complete, cancel, error
```

本地 provider 必须满足：

- 模型启动时加载或明确报告未加载；
- 请求期间不下载依赖；
- 首个音频块可以在完整短句提交后尽快返回；MeloTTS MVP 允许以完整短句为最小 TTS 单元，不要求 token 级输入流；
- 收到取消后停止产生新音频；
- 同一 voice 配置下输出可重复验证；
- 能在当前目标 Windows 环境中稳定运行。

### 10.3 回复分段

- 复用 DS Bot 当前 `output.segment` 事件；
- TTS 队列按 segment 顺序提交；
- 第一段生成后立即提交 TTS；
- 后续段在前一段播放时继续准备；
- 用户插话后丢弃当前 response 的未播放 segment；
- 新 response 只能使用新 generation。

### 10.4 取消和打断

```text
有效用户语音
  ↓
mark current response interrupted
  ↓
stop playback
  ↓
clear queued PCM
  ↓
cancel TTS request
  ↓
cancel or supersede current LLM stream
  ↓
accept new AudioSegment
```

播放停止与 Bot 后台任务取消继续分离：插话默认只停止旧播放和语音输出；是否取消后台 Bot 工作沿用现有 Phone Agent 决策。

## 11. 影响范围

- 独立 Local Voice 插件包：Host、客户端、Bridge、Python runtime、配置和测试；
- DSH 公开插件 API：插件安装、启停、Bot/session 访问和界面挂载；
- `docs/module-memory/local-voice-plugin.md`：新插件的长期决策和继续入口；
- 现有 Phone Agent 仅作为并存和资源冲突检查对象，不在本方案中修改。

## 12. 实施步骤

### 步骤 1：基线与模型选型

- 修改对象：语音运行时依赖、实验记录。
- 修改内容：优先验证 MeloTTS 中文模型；记录 Python 版本、GPU/CPU 使用、模型大小、启动时间、首块时间、音质和取消行为；失败时再验证 CosyVoice2-0.5B。
- 完成条件：MeloTTS 在目标 Windows 设备启动并通过固定短句 smoke test，或记录切换 CosyVoice2 的具体原因。

### 步骤 2：独立插件骨架和设备互斥

- 修改对象：Local Voice 独立插件包、插件清单、Host 生命周期、配置目录和 loopback Bridge。
- 修改内容：创建独立设置页、VoiceMode、runtime 启停和设备占用检查；Phone Agent 未停止时拒绝启动并显示原因。
- 完成条件：Local Voice 可以独立安装、启停、保存脱敏配置；Phone Agent 的现有测试和启动行为不变。

### 步骤 3：本地 TTS provider 适配

- 修改对象：Local Voice runtime 的 `shared_tts.py`、provider 模块、runtime 配置和安装脚本。
- 修改内容：实现本地模型加载、流式 PCM 输出、取消、超时和错误码；保留当前 provider 作为回滚路径。
- 完成条件：固定文本可返回合法 PCM16 流，取消后不再产生新音频，依赖检查可重复执行。

### 步骤 4：流式回复衔接

- 修改对象：`voice_output.py`、Bridge 输出事件处理。
- 修改内容：第一段 `output.segment` 到达后立即送 TTS，后续段并行排队；记录首块和首个可听音时间。
- 完成条件：未等待完整回复即可开始播放，段落顺序正确，正常结束不丢尾音。

### 步骤 5：插话和迟到事件隔离

- 修改对象：语音输入、输出、generation 管理和测试。
- 修改内容：用户有效语音触发停止播放、清空队列、取消 TTS，并丢弃旧 response 的迟到事件。
- 完成条件：插话后旧音频不再播放，新输入只进入新 generation；显式停止任务仍按原有规则执行。

### 步骤 6：测试中心和真实设备验收

- 修改对象：Local Voice 测试中心、Python/Node 回归测试和 Windows 验收记录。
- 修改内容：增加 provider ready、模型加载、TTFA、取消、ASR→LLM→TTS 完整链路和打断结果。
- 完成条件：固定句、短句连续回复、长句分段、插话、TTS 失败、ASR 失败、设备断开均有可观察结果。

## 13. 验收标准

### 功能验收

- 本地 TTS 服务启动后报告模型 ready；未 ready 时语音插件显示明确错误。
- 一段已完成 ASR 文本进入现有 Bot session，并收到回复事件。
- 第一段回复进入 TTS 后，完整回答尚未结束时播放器已经开始输出。
- 多段回复按顺序播放，不重复、不丢段。

### 性能验收

- 记录 `audio.segment.ended`、`output.segment`、TTS 请求开始、首个 PCM 块、首个播放设备块和播放完成。
- 主指标：`TTFA = 首个播放设备块时间 - audio.segment.ended`；预热后固定中文短句重复 10 次，P50 ≤ 1.5 s、P95 ≤ 2.5 s 为第一版目标。
- 诊断指标：ASR 最终文本耗时、LLM 首段耗时、TTS 首块耗时、设备启动耗时；不把单个阶段目标误当成端到端保证。
- 另记录冷启动时间和显存峰值；冷启动不计入 TTFA 主指标，但必须显示在测试中心。

### 打断验收

- 播放中用户说话，旧播放在可接受时间内停止。
- 清空队列后旧 response 的迟到音频不会播放。
- 新 response 可以正常开始；正常完成路径仍保留尾音。

### UI 与交互验收

- VoiceMode 在 `listening`、`thinking`、`speaking`、`interrupted` 和 `error` 状态显示对应中文状态，状态变化不会产生第二个重叠语音面板。
- Local Voice 和 Phone Agent 同时启用时，设备占用冲突有明确提示；Local Voice 不会静默停止或修改 Phone Agent。
- 用户说完后，VoiceMode 和 ASR 测试中心显示完整最终文本；中间识别结果不会覆盖已确认文本。
- `speaking` 状态显示当前 Bot 和当前助手文本，插话后显示“已打断，正在听”并回到监听状态。
- 设置页和测试中心显示中文 Windows 单设备的运行状态；未配置模型、设备或主人声纹时显示具体下一步。
- 测试中心的延迟卡片显示最近一次结果和最近十次 P50/P95，并明确区分冷启动和预热结果。
- 减少动态效果开启时，光环和表情球停止持续动画，但状态文字、错误和插话结果仍可理解。

### 安全验收

- TTS worker 只监听 loopback 并要求本地 credential。
- 日志和 UI 不显示 API Key、完整 PCM、声纹向量或原始声纹文件。
- TTS 替换不绕过主人声纹、Bot/session 权限和 Bridge generation 校验。

### 回归验收

- 现有 Python runtime 测试、Node 测试、客户端构建和 compileall 通过。
- 真实 Windows 麦克风、扬声器、Bot 切换、重连和测试中心流程完成一轮验收。

## 14. 测试计划

- 单元测试：provider 配置、PCM 合同、分段、取消、generation 隔离。
- 协议测试：`shared-tts.v1` ready/audio/complete/cancel/error 顺序。
- 集成测试：固定 ASR fixture → mock LLM segment → local TTS fixture → playback mock。
- 性能测试：预热前后首块延迟、首个可听音、连续播放和显存占用。
- 真实设备测试：Windows 麦克风、扬声器、插话、Bot 切换、设备断开和重连。

## 15. 风险与回滚方式

- 本地模型显存不足：保留当前 TTS provider，降低模型规格或暂缓本地 provider。
- 本地模型无真实流式输出：先按短句输出，明确记录该限制，不伪称为 token 级流式。
- 本地模型启动慢：启动阶段预热，语音插件进入 `starting`，不阻塞文字聊天。
- 本地 TTS 音质不达标：按 provider 配置回退到当前已验证 provider，保留统一接口。
- 插话取消不完整：关闭流式播放优化，恢复当前串行播放路径，保留诊断和测试。

## 16. 复杂度控制

- 复用已验证的协议语义和 DS Bot 公开插件模式，但使用 Local Voice 自己的 Python 子进程、Bridge、`shared-tts.v1`、VoiceOutput 和测试中心。
- 不修改 Phone Agent，不新增通用 provider 平台、消息队列、数据库、Docker 编排或独立 WebUI。
- 每个新增文件、配置项和依赖必须直接服务于本地 TTS provider 或最小闭环验收。
- 流式 ASR 中间结果、复杂 Agent、视觉输入和多设备能力单独排期。

## 17. 范围偏差记录

| 日期 | 偏差 | 原因 | 处理 |
|---|---|---|---|
| 2026-11-08 | AnifLive-TTS 不进入第一版 | 显存、Docker、TensorRT 和模型包会阻塞最小闭环验证 | 保留为未来候选，不接入本计划实施步骤 |

## 18. 关联的 module-evolution 决策

- 关联 [Phone Agent 语音插件模块记忆](../../module-memory/phone-agent-voice-plugin.md) 作为并存和复用参考；本方案的长期记录见 [Local Voice 插件模块记忆](../../module-memory/local-voice-plugin.md)。
- 现有 D-PAVP-011、D-PAVP-015 至 D-PAVP-028 继续生效；本文件的本地 TTS 选择在确认后补充新的决策记录。
- D-PAVP-029 记录暂缓 AnifLive-TTS；本轮新增的唤醒词、主人声纹、中文 Windows 范围和完整 ASR 文本约束待写入模块决策。

## 19. 变更记录

- 2026-11-08：建立 Draft。根据用户确认暂缓 AnifLive-TTS，保留现有 DS Bot 语音插件作为基础，新增本地 TTS、流式衔接、首字延迟和可打断播放的方案草案。
- 2026-11-08：根据用户确认保留唤醒词和主人声纹、显示完整 ASR 文本、首版只验收中文 Windows 单设备；Agent 推荐 MeloTTS 中文作为 MVP TTS，FunASR Paraformer-zh 作为最终 ASR，CosyVoice2-0.5B 作为后续候选，并确定 TTFA 与阶段耗时指标。
- 2026-11-08：用户提出将最小闭环独立为新插件，以避免影响 Phone Agent；方案改为独立生命周期、配置、runtime、UI 和设备互斥检查，Phone Agent 保持原功能。
- 2026-11-09：用户确认按建议执行；文档进入 Confirmed，独立插件包目录和标识确定为 `local-voice/`，显示名称为 `Local Voice`。MeloTTS 与 CosyVoice2 的取舍保留为实施阶段的本地 smoke test。
- 2026-11-09：开始实现 `local-voice/`：完成独立包清单、Host 配置/设备租约/生命周期、loopback API、设置页 client bundle、Node runtime client 和 Python JSON-lines runtime；Node `npm test` 通过 16 项，Python runtime 测试通过 5 项。模型 smoke test 暂因 MeloTTS Windows 依赖未准备完成而保留。
- 2026-11-09：完成本地 Paraformer-zh 与 MeloTTS 中文 checkpoint 的 CPU smoke；runtime 增加本地模型路径、离线运行、启动预热、并发取消和请求级错误回传；新增 `LocalVoiceLoop` 覆盖 LLM 分段到 TTS、generation 隔离和插话取消。Node 测试 21 项、Python 测试 11 项通过。DS Bot session、Windows 音频和唤醒/声纹路径仍待实现。
- 2026-11-09：继续实现 runtime 可靠性：Python 仅使用 stdout 发送协议、支持后台推理期间 cancel、单模型忙状态和请求错误关联；Node client 增加启动/请求超时、UTF-8 增量解码、取消清队列和本地环境/模型路径；`LocalVoiceLoop` 在前段播放期间启动后段 TTS；加入独立环境准备脚本和 WAVE/延迟 smoke 工具。Node 测试 30 项、Python 测试 14 项通过。
- 2026-11-10：修复独立插件在 Desktop 不可见：补齐包 bundle/patch、app 依赖/锁文件/profile、源码启动同步、Cordis service 提供和 exact API 路由；设置页增加独立配置持久化和开发状态提示。隔离真实 Host 页面和保存验证通过，Local Voice 33 项及 Desktop 相关 10 项测试通过；完整语音能力继续按原计划实现。
