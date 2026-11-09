# MOSS Live 独立实时语音插件开发文档

## 文档状态

Confirmed / Implementation in progress

## 1. 目标与使用场景

用户在 DS Bot 插件页配置 MOSS Live，并从同一页面启动一个独立的全双工实时语音会话。麦克风音频进入 MOSS Live，实时字幕和语音回复回到插件面板。该会话不创建 DS Bot Bot 回合，不读取 Bot 工具、记忆、权限或审批。

## 2. 当前行为

- `[代码证据]` `moss-live` Demo 使用本地 FastAPI 中继连接 `wss://api.mosi.cn/v1/realtime`，API Key 只放在上游 WebSocket 握手头。
- `[代码证据]` MOSS Live 当前协议支持 Persona、Instructions、16 kHz 上行 PCM、48 kHz 下行 PCM、实时字幕和播放打断。
- `[代码证据]` DS Bot 已有 Node Host、插件设置页、Secret Store 和 `ws` 依赖，可承载 loopback 中继。

## 3. 期望行为

1. 用户在 MOSS Live 设置页填写 Persona、Instructions、模型 ID 和 API Key。
2. API Key 保存到 DS Bot Secret Store；状态只显示是否已配置。
3. 用户启动会话后，Host 建立带认证的 loopback WebSocket 中继，并由客户端取得麦克风权限。
4. 客户端持续发送 16 kHz PCM，接收 48 kHz PCM，显示用户和 MOSS 的实时字幕，并支持 MOSS 的抢话停止。
5. 用户停止会话后，客户端、上游 WebSocket 和 Host 中继都被释放。

## 4. 已确认决策

- `[用户确认]` 2026-11-08：先采用方案 A，即独立 MOSS Live 实时会话。
- `[候选建议]` 首版继续作为现有 `ds-bot` 插件的内部模块，使用独立的 MOSS Live 设置页，不注册到通用 DSH Models provider 列表。
- `[候选建议]` 首版输入先实现麦克风；摄像头、屏幕共享和直接文本输入留待协议验证后的后续迭代。

## 5. 待确认问题

- MOSS 上游是否开放工具调用或文本输入协议；当前实现不假设存在。
- `moss-live` 仓库当前未发现 LICENSE/SPDX 声明；直接复制源码或素材前需要确认授权。

## 6. 功能范围

### 包含

- MOSS Live 模型 ID、Persona、Aliases、Prompt、Instructions、会话时长配置。
- DS Bot Secret Store 中的 `MOSS_API_KEY`。
- Host loopback WebSocket 中继、上游鉴权、指令白名单、二进制帧上限和会话时长上限。
- 麦克风 PCM 采集、实时字幕、48 kHz PCM 播放、播放回执和抢话停止。
- 插件页的启动、停止、状态、音量和字幕显示。

### 不包含

- DS Bot Bot/session 回合、工具、记忆、权限、审批或普通模型路由。
- MOSS 直接文本输入、MOSS 工具调用、摄像头和屏幕共享。
- Android、离线运行、MOSS 源码或音频素材的直接复制。

## 7. 安全边界

- API Key 只在 Host Secret Store 和上游握手中出现，不进入 `state.json`、客户端配置或日志。
- loopback 中继使用随机 token；只接受本机地址和当前会话 token。
- 上游地址固定为官方 realtime endpoint；客户端事件和 `session.update` 字段按白名单清洗。
- 单帧、单条消息和单次会话时长有上限；停止、错误和插件卸载都关闭上游连接。

## 8. 技术方案

- `ds-bot/src/host/moss-live.js`：配置规范化、Secret Store 接线、loopback 中继和上游 WebSocket。
- `ds-bot/src/client/moss-live.js`：AudioWorklet 麦克风采集、PCM 播放队列、字幕事件和会话状态。
- `ds-bot/src/client/plugin-page.js`：配置与实时会话面板。
- `ds-bot/src/host/channel.js`、`ds-bot/src/client/index.js`：Host actions 和插件页注册。

## 9. 验收标准

- 未配置 API Key 时，启动按钮不可用，Host 不建立上游连接。
- API Key 不出现在 `mossLive()` 返回值、状态接口、页面文本和诊断输出中。
- 配置保存后，重载插件仍保留模型和 Persona 配置。
- 会话启动后完成 loopback 认证、上游连接、`attach_session`、`session.update` 和 `media.mode` 顺序。
- 麦克风帧带 `0x00` 音频标签；下行音频能按 `response.audio.context` 配对播放。
- 上游发出 `response.audio.stop` 时，本地播放停止并回传 `playback.stopped`。
- 停止或错误后无旧 WebSocket、麦克风轨道或播放队列残留。
- 单元测试、客户端构建和 lint 通过；真实 MOSS Key 下完成一次 Desktop 麦克风和扬声器 smoke test。

## 10. 当前实现状态

- `[代码证据]` 已完成 Host 配置、Secret Store action、loopback relay、MOSS 协议清洗、客户端会话、麦克风采集、PCM 播放、字幕和插件页入口。
- `[代码证据]` 已添加 Host、客户端和设置页回归测试；真实 MOSS API、物理麦克风和扬声器尚未验证。

## 11. 继续入口

先运行 `node --import ./test/harness-resolve.mjs --test test/moss-live.test.js test/moss-live-client.test.js test/plugins-client.test.js`，再运行 `npm run build`、`npm run lint` 和全量 `npm test`。有可用 MOSS API Key 后，在 DS Bot Desktop 中完成一次真实会话 smoke test。
