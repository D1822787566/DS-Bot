# DS Bot Voice Runtime

This directory contains the migrated Python audio runtime for the DS Bot Phone Agent plugin.

The runtime owns Windows audio, wake detection, ASR, owner verification, continuation policy,
TTS and playback. DS Bot owns Bot sessions, model calls and the local `agent-events.v1` Bridge.

The runtime is migrated from the Phone Agent project as source code. It must not import Alife Core,
Alife ChannelBridge or an external Phone Agent checkout. Role identifiers are DS Bot `bot_id`
values; session routing uses DS Bot `session_id` values.

`main.py` is the managed entrypoint. DS Bot passes the Bridge URL, credential, device identity and
non-secret voice configuration through `DS_BOT_*` environment variables. It opens the local
Bridge, receives the DS Bot role roster, routes output segments to the configured TTS voice and
plays PCM through the Windows output device. The migrated wake, ASR, owner verification and
continuation adapters stay behind this process boundary; their live Windows capture wiring is
the next acceptance step. A missing provider reports a runtime error without affecting text chat.

Install the runtime dependencies in the Python environment used by the DS Bot host:
`requirements.txt`. No path under `E:/project_space/phone_agent` is read at runtime.
