# 模块记忆索引

| 模块 | 状态与继续入口 |
|---|---|
| [上游 0.3.8 迁移](upstream-migration.md) | 5/5 完成；固定上游全部源码与 DSH 0.2.2-rc.1 已集成，回归与正式 Desktop 核验通过；已合并推送到 main，设备和外部服务验收单独跟进 |
| [Bot 表情球](emotion-ball.md) | 设计与插件接入方向已确认，功能未开始；下一步细化内部接口与预览流程；记录已于 2026-11-17 并入统一模块记忆 |
| [插件与预设](plugin-presets.md) | MVP 已实现；默认 DSH Markets 真实目录查询通过；StudyMate learning 的 PTC 模式暂不能绑定，阅读端未验证 |
| [Phone Agent 语音插件](phone-agent-voice-plugin.md) | 架构与语音交互流程已确认；专用语音测试中心及 ASR/唤醒/声纹/TTS/完整链路板块已实现；D-PAVP-031 将本地最小闭环转入 Local Voice，Phone Agent 保持现有 provider；Windows 真实音频验收待完成 |
| [Local Voice 独立语音插件](local-voice-plugin.md) | Desktop 独立 bundle/入口接入已修复；重启后从“插件 → Local Voice（本地语音）”打开；Node 33 项及 Desktop 相关 10 项通过；完整语音链路仍在开发 |
| [MOSS Live 独立实时语音插件](moss-live-plugin.md) | 旧插件全页已移除，当前详情侧栏、实时字幕及历史保留；重拨失败的错误提示已修复，当前账号额度需按实际 HTTP 402 错误确认；主动结果播报仍有空播放标识异常 |
