# 模块记忆索引

| 模块 | 状态与继续入口 |
|---|---|
| [Bot 表情球](emotion-ball.md) | 设计与插件接入方向已确认，功能未开始；下一步细化内部接口与预览流程；记录已于 2026-11-17 并入统一模块记忆 |
| [插件与预设](plugin-presets.md) | MVP 已实现；默认 DSH Markets 真实目录查询通过；StudyMate learning 的 PTC 模式暂不能绑定，阅读端未验证 |
| [Phone Agent 语音插件](phone-agent-voice-plugin.md) | 架构与语音交互流程已确认；专用语音测试中心及 ASR/唤醒/声纹/TTS/完整链路板块已实现；D-PAVP-031 将本地最小闭环转入 Local Voice，Phone Agent 保持现有 provider；Windows 真实音频验收待完成 |
| [Local Voice 独立语音插件](local-voice-plugin.md) | Desktop 独立 bundle/入口接入已修复；重启后从“插件 → Local Voice（本地语音）”打开；Node 33 项及 Desktop 相关 10 项通过；完整语音链路仍在开发 |
| [MOSS Live 独立实时语音插件](moss-live-plugin.md) | Profile/侧栏/会话记忆已实现，问候已关闭；客户端打断修复及空关联字段兼容已验证，主动结果播报仍有空播放标识异常，MLF-04 继续排查 |
