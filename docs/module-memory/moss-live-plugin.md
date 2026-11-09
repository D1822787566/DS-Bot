# MOSS Live 独立实时语音插件

记录状态：首版实现进行中
最近更新：2026-11-08

## 模块目标

- `[用户确认]` 采用独立 MOSS Live 实时会话方案，不把 MOSS 会话伪装成 DS Bot Bot 回合。
- `[候选建议]` 复用现有 `ds-bot` 插件承载方式，在插件页提供模型配置、API Key、麦克风输入、实时字幕和播放控制。

## 规划基线

| ID | 事项 | 状态 | 证据/性质 |
|---|---|---|---|
| ML-01 | 确认独立 MOSS Live 会话边界 | 完成 | `[用户确认]` 2026-11-08 |
| ML-02 | Host 配置、Secret Store 和 loopback relay | 完成 | `[代码证据]` 已实现 |
| ML-03 | 客户端麦克风、PCM 播放、字幕和抢话 | 完成 | `[代码证据]` 已实现，真实设备待验 |
| ML-04 | 插件设置页和 Host actions | 完成 | `[代码证据]` 已实现 |
| ML-05 | 真实 MOSS API 与 Desktop 音频验收 | 未开始 | `[待确认]` 需要 API Key 和设备测试 |

## 决策记录

- ML-D01 / 2026-11-08 / `[用户确认]` 用户选择方案 A：先做独立 MOSS Live 实时会话。影响：MOSS 语音输出不进入 DS Bot Bot/session，不承诺工具、记忆、权限和审批能力。
- ML-D02 / 2026-11-08 / `[候选建议]` 首版在现有 `ds-bot` 插件内部增加 MOSS Live 模块，API Key 使用 Secret Store，模型与 Persona 配置保存为非敏感偏好。实现已按该建议进行，待用户后续改变范围时再调整。
- ML-D03 / 2026-11-08 / `[候选建议]` 首版只实现麦克风输入、实时字幕和音频播放；摄像头、屏幕共享和直接文本输入延期，原因是 MOSS 当前公开协议未提供稳定的文本输入动作，且本轮先验证音频闭环。

## 开发状态

- `[代码证据]` `src/host/moss-live.js` 已提供配置校验、MOSS 协议白名单、API Key 读取、loopback token 和上游 WebSocket relay。
- `[代码证据]` `src/client/moss-live.js` 已提供 AudioWorklet 麦克风、16 kHz PCM、48 kHz 播放、字幕和 `response.audio.stop` 处理。
- `[代码证据]` 插件页、Host channel、客户端 actions 和构建入口已接入。
- `[代码证据]` 当前已通过 MOSS Live 配置、Host relay 本地认证/事件清洗、客户端会话和插件设置页专项测试；真实上游和物理设备仍未验收。
- `[代码证据]` 规划基线为 4/5 完成，真实 MOSS API 与 Desktop 音频验收 1 项未开始。

## 继续入口

- 运行仓库全量 Node 测试、构建和 lint。
- 使用真实 MOSS API Key 在 DS Bot Desktop 中测试配置保存、麦克风采集、字幕、下行播放、抢话和停止清理。
- 真实验收完成后，再决定是否加入摄像头、屏幕共享或 DS Bot Bot 桥接能力。
