# Local Voice 独立语音插件

记录状态：方案已确认，首版实现进行中
最近更新：2026-11-10

## 模块目标

- [用户确认] 新增独立语音插件，完成中文 Windows 单设备上的类全双工最小闭环。
- [用户确认] 插件保留唤醒词和主人声纹必经路径，使用现有 LLM 生成回复，显示完整最终 ASR 文本，并支持本地 TTS 流式播放和插话停止。
- [候选建议] 第一版 TTS 使用 MeloTTS 中文模型；ASR 使用现有 FunASR Paraformer-zh；CosyVoice2-0.5B 作为后续候选。

## 规划基线

| ID | 事项 | 状态 | 证据/性质 |
| --- | --- | --- | --- |
| LV-01 | 确认独立插件边界和与 Phone Agent 的并存规则 | 完成 | [用户确认] 2026-11-08 |
| LV-02 | 本地 TTS / ASR smoke test 和依赖准备 | 进行中 | [代码证据] 本地 Paraformer-zh 与 MeloTTS 已完成固定样例 smoke；依赖版本仍有 pip check 冲突，安装脚本未固化 |
| LV-03 | 独立插件 Host、Bridge、runtime 和 UI 骨架 | 进行中 | [代码证据] 独立 bundle 已加入 Desktop profile、安装依赖和源码启动同步；插件页入口、Host API 与独立配置保存已真实验证；Bridge 仍待接入 |
| LV-04 | ASR → 现有 LLM → 本地 TTS → 可打断播放 | 进行中 | [代码证据] 已实现分段 TTS loop、generation 隔离、PCM 流取消；尚未接入 DS Bot session、Windows 麦克风、VAD、唤醒词和主人声纹 |
| LV-05 | 中文 Windows 单设备真实验收 | 未开始 | [用户确认] 第一版平台范围 |

- [代码证据] 基线进度：LV-01 完成；LV-02、LV-03、LV-04 进行中；LV-05 未开始。ASR/TTS runtime 已能在本机 CPU 环境启动并完成协议级 smoke，完整音频闭环尚未接入。

## 决策记录

- LV-D01 / 2026-11-08 / [用户确认] Local Voice 作为独立插件开发，不修改现有 Phone Agent 的功能、配置、生命周期和 UI。原因：避免新闭环影响已有语音功能。影响：新插件拥有自己的 Host、Bridge、Python runtime、配置、测试中心和 VoiceMode。
- LV-D02 / 2026-11-08 / [用户确认] 同一 Windows 设备的麦克风和唤醒词资源不允许被两个语音插件同时占用。原因：首版不实现音频共享和双唤醒仲裁。影响：Local Voice 检测到 Phone Agent 占用时拒绝启动并显示原因，不自动停止或修改 Phone Agent。
- LV-D03 / 2026-11-08 / [用户确认] 第一版范围限定为中文、Windows、单设备、完整最终 ASR 文本、唤醒词和主人声纹必经、本地 TTS、现有 LLM、可打断播放。原因：控制首版复杂度并保护现有安全边界。影响：流式 ASR 中间文本、Android、多设备和原生全双工模型延期。
- LV-D04 / 2026-11-09 / [用户确认] 独立插件采用 `local-voice/` 作为包目录和插件标识，显示名称使用 `Local Voice`。原因：用户确认按方案推进并需要清晰的独立边界。影响：后续 Host、客户端、Bridge、Python runtime、配置和测试均归属该插件；MeloTTS/CosyVoice2 仍按 smoke test 决定具体 TTS 后端。

## 开发状态

- [代码证据] 现有 Phone Agent 已有可复用的协议和音频处理经验；Local Voice 不导入 Phone Agent 内部模块。
- [代码证据] `local-voice/` 已创建独立包清单、Host manager、中文配置校验、设备占用租约、loopback API route、设置页 client bundle、Node runtime client 和 Python JSON-lines runtime。
- [代码证据] `local-voice` Node 测试当前为 `33 passed`；2026-11-10 Desktop profile/真实 Cordis 激活/overlay 相关测试 `10 passed`；上轮 Python runtime 测试 `14 passed`。
- [代码证据] `.ds-bot-local/local-voice-env` 已安装 FunASR 1.4.16、MeloTTS 0.1.2、CPU-only PyTorch 2.11.0；本地 Paraformer-zh 和 MeloTTS 中文 checkpoint 已准备。
- [代码证据] 真实 runtime smoke 已通过：`ready(asr=true, tts=true, prewarmed=true)`；Paraformer-zh 固定样例最终转写约 0.23–0.26 s；MeloTTS 预热后“你好”约 0.38–0.40 s，输出 16 kHz PCM16。冷启动含模型加载约 19.6 s。
- [现状重建] `pip check` 仍报告 MeloTTS 元数据与当前 FunASR 环境的 transformers/fugashi/unidic/gradio 版本差异；运行时通过中文兼容层和离线本地模型路径工作，但依赖锁定和安装脚本尚未完成。
- [代码证据] 新增 `LocalVoiceLoop`：按 LLM segment 立即启动 TTS，前段播放时继续准备后段，支持 generation 迟到段隔离和当前/排队音频取消；该 loop 尚未连接 DS Bot LLM 和 Windows 播放设备。
- [代码证据] runtime client 已增加启动/请求超时、UTF-8 增量解析、子进程 Windows 隐藏启动、预热 capability、离线模型环境和请求级错误处理；Python dispatcher 可在 TTS 运行时接收 cancel。
- [代码证据] `runtime/prepare_runtime.py` 与 `runtime/download_models.py` 已加入独立环境和模型准备入口；运行服务不会自行安装依赖或下载模型。
- [代码证据] 2026-11-10 修复“看不到插件”：此前包未加入 Desktop bundles/dependencies，也没有 `dsh.bundle`；补齐 `cordis.patch.yml`、app 依赖/lock/profile 和 `start.ps1` 同步后，已在隔离真实 Host 的“插件 → Local Voice（本地语音）”打开设置页并保存设置。
- [代码证据] 真实 Host 额外暴露并已修复两处激活错误：用 `ctx.provide('localVoice', manager)` 注册服务，Host exact route 改为 `/api/local-voice`；独立配置存于数据根下 `local-voice/settings.json`，页面明确说明完整对话未接入。
- [代码证据] 本轮 app 全量测试 `430 passed / 1 failed / 2 skipped`；未修改的 `app/test/move-data.test.mjs:160` 因当前 Windows 能创建目标 junction 而未抛预期 EPERM，单独重跑同样失败；不是 Local Voice 启动验收结果。
- [代码证据] 本地语音最小闭环开发草案位于 [local-voice-minimal-loop-development.md](../development/cross-module/local-voice-minimal-loop-development.md)。
- [待完成] 依赖准备脚本已加入但未在干净环境复现；Local Voice 的 DS Bot session/LLM 适配、Windows 音频采集/VAD/唤醒词/主人声纹、PCM 播放、Phone Agent 实际占用检测和真实设备验收仍未完成。

## 继续入口

- 下一步：把 `LocalVoiceLoop` 接到 Local Voice Host 的 DS Bot session/LLM 回调，先用固定 ASR fixture 和 mock LLM 验证首段 TTS、播放取消和 generation 隔离，再接入 Windows 音频。
- 当前用户进程仍运行旧 Desktop profile；需从托盘完全退出后通过 `start.ps1` 重启，随后打开“插件 → Local Voice（本地语音）”。本轮只刷新 Local Voice 已安装文件，未关闭用户的 DS Bot 或 Phone Agent。
- 已完成：Node runtime client 支持 ready/capability、最终转写、PCM 流、request-level cancel；Python runtime 支持 hello、并发 transcribe/synthesize、cancel、PCM16 校验、离线模型路径和 TTS 预热。
- 验证重点：DS Bot session 路由、首段播放开始、打断后的迟到事件隔离、唤醒词/主人声纹必经路径、真实设备 TTFA。
- 若 MeloTTS 的 Windows 依赖或延迟不满足目标，再按开发文档评估 CosyVoice2-0.5B；在 smoke test 完成前不宣称本地 TTS 已可用。
