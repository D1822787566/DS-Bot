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
plays PCM through the Windows output device. When Windows wake is enabled, it opens the selected
microphone through PortAudio/WASAPI, resamples frames to 16 kHz and feeds the migrated Sherpa
keyword detector. The process reports `windows.audio.input_ready` before `runtime.ready`; a
microphone or wake-model failure terminates the voice runtime with diagnostics instead of
claiming that it is listening. Wake names outside the model's Chinese pinyin vocabulary are
reported as `windows.wake.unsupported_names` and do not prevent supported Bot wake names from
starting. Each detected candidate is sent to the DS Bot Bridge as `device.wake` and must receive
an authenticated acceptance for the mapped Bot. The runtime also reports `windows.wake.audio`
diagnostics with frame counts, peak level and detector counters, without including PCM. ASR,
owner verification and continuation remain behind this process boundary and are wired in later
acceptance steps. A missing provider reports a runtime error without affecting text chat.

Install the runtime dependencies in the Python environment used by the DS Bot host:
`requirements.txt`. No path under `E:/project_space/phone_agent` is read at runtime.
