# Change Memory

This log records verified behavior changes and their follow-up checks.

## Records

- 2026-11-07 | fix | voice playback | per-chunk interpolation reset caused hoarse Windows TTS; stateful LiveKit resampler now spans chunks and flushes only on normal drain | `ds-bot/voice-runtime/main.py`, `test_pcm_playback.py`; 93 passed + 12 subtests, Node 1706 passed | follow-up: user listening check
- 2026-11-07 | fix | voice default | playback repair did not resolve subjective hoarseness; switched default/current Bot voice to verified `longanlingxi_v3.1` and replayed on 48 kHz Windows output | `ds-bot/src/host/phone-agent.js`; provider and physical playback succeeded | follow-up: user listening check
- 2026-11-07 | fix | voice playback boundary | migration had replaced Phone Agent LiveKit `MediaDevices`/`OutputPlayer` with RawOutputStream plus custom resampling; restored 16 kHz AudioSource/LocalAudioTrack into native output path | `ds-bot/voice-runtime/main.py`, `test_pcm_playback.py`; 88 passed + 12 subtests | follow-up: user listening check
- 2026-11-07 | fix | voice tail | normal drain closed OutputPlayer before its final device buffer rendered; wait for a stable empty buffer plus one output block before close | `ds-bot/voice-runtime/main.py`, `test_pcm_playback.py`; Python 88 passed + 12 subtests | follow-up: user listening check
- 2026-11-07 | fix | wake input | KWS hit chunk was discarded wholesale, losing a command spoken immediately after the wake word; forward hit chunk to VAD/ASR and strip only the leading configured address on first turn | `ds-bot/voice-runtime/main.py`, `test_main.py`; Python 89 passed + 12 subtests | follow-up: user listening check
- 2026-11-07 | change | transcript | user confirmed first-turn submit must preserve the full ASR text, including the Bot name; only wake-name-only utterances are dropped | `ds-bot/voice-runtime/voice_input.py`, `test_voice_input.py`; Python 90 passed + 12 subtests | follow-up: user listening check
