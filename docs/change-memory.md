# Change Memory

This log records verified behavior changes and their follow-up checks.

## Records

- 2026-11-07 | fix | voice playback | per-chunk interpolation reset caused hoarse Windows TTS; stateful LiveKit resampler now spans chunks and flushes only on normal drain | `ds-bot/voice-runtime/main.py`, `test_pcm_playback.py`; 93 passed + 12 subtests, Node 1706 passed | follow-up: user listening check
