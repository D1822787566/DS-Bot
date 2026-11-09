# Local Voice 独立语音插件

记录状态：方案已确认，首版尚未实现
最近更新：2026-11-09

## 模块目标

- [用户确认] 新增独立语音插件，完成中文 Windows 单设备上的类全双工最小闭环。
- [用户确认] 插件保留唤醒词和主人声纹必经路径，使用现有 LLM 生成回复，显示完整最终 ASR 文本，并支持本地 TTS 流式播放和插话停止。
- [候选建议] 第一版 TTS 使用 MeloTTS 中文模型；ASR 使用现有 FunASR Paraformer-zh；CosyVoice2-0.5B 作为后续候选。

## 规划基线

| ID | 事项 | 状态 | 证据/性质 |
| --- | --- | --- | --- |
| LV-01 | 确认独立插件边界和与 Phone Agent 的并存规则 | 完成 | [用户确认] 2026-11-08 |
| LV-02 | 本地 TTS / ASR smoke test 和依赖准备 | 未开始 | [候选建议] 先验证 MeloTTS + Paraformer-zh |
| LV-03 | 独立插件 Host、Bridge、runtime 和 UI 骨架 | 未开始 | [候选建议] 不导入 Phone Agent 内部模块 |
| LV-04 | ASR → 现有 LLM → 本地 TTS → 可打断播放 | 未开始 | [用户确认] 最小闭环范围 |
| LV-05 | 中文 Windows 单设备真实验收 | 未开始 | [用户确认] 第一版平台范围 |

## 决策记录

- LV-D01 / 2026-11-08 / [用户确认] Local Voice 作为独立插件开发，不修改现有 Phone Agent 的功能、配置、生命周期和 UI。原因：避免新闭环影响已有语音功能。影响：新插件拥有自己的 Host、Bridge、Python runtime、配置、测试中心和 VoiceMode。
- LV-D02 / 2026-11-08 / [用户确认] 同一 Windows 设备的麦克风和唤醒词资源不允许被两个语音插件同时占用。原因：首版不实现音频共享和双唤醒仲裁。影响：Local Voice 检测到 Phone Agent 占用时拒绝启动并显示原因，不自动停止或修改 Phone Agent。
- LV-D03 / 2026-11-08 / [用户确认] 第一版范围限定为中文、Windows、单设备、完整最终 ASR 文本、唤醒词和主人声纹必经、本地 TTS、现有 LLM、可打断播放。原因：控制首版复杂度并保护现有安全边界。影响：流式 ASR 中间文本、Android、多设备和原生全双工模型延期。
- LV-D04 / 2026-11-09 / [用户确认] 独立插件采用 `local-voice/` 作为包目录和插件标识，显示名称使用 `Local Voice`。原因：用户确认按方案推进并需要清晰的独立边界。影响：后续 Host、客户端、Bridge、Python runtime、配置和测试均归属该插件；MeloTTS/CosyVoice2 仍按 smoke test 决定具体 TTS 后端。

## 开发状态

- [代码证据] 现有 Phone Agent 已有可复用的协议和音频处理经验，但新插件尚未创建。
- [代码证据] 本地语音最小闭环开发草案位于 [local-voice-minimal-loop-development.md](../development/cross-module/local-voice-minimal-loop-development.md)。
- [待完成] 本地 TTS 模型验证、独立插件骨架、设备互斥、Bridge/session 路由和真实设备验收均未开始。

## 继续入口

- 下一步：在当前 Windows 环境中验证 MeloTTS 中文和 FunASR Paraformer-zh 的启动、模型加载、固定中文句识别、PCM 输出和取消行为。
- 验证重点：冷启动、预热后 TTFA、ASR 最终文本、显存/CPU 占用、Phone Agent 并存时的设备冲突。
- 下一步：创建 `local-voice/` 插件骨架，并先执行 MeloTTS + Paraformer-zh 的本地 smoke test；若 MeloTTS 不满足目标，再评估 CosyVoice2-0.5B。
