# Local Voice runtime

This process owns local speech models only. The host owns the plugin lifecycle,
DS Bot routing, permissions, and UI.

The process uses JSON lines on stdin/stdout:

- `hello` → `ready` (`asr`, `tts`, and `prewarmed` capabilities)
- `transcribe` → final `transcript`
- `synthesize` → `audio` PCM16 chunks and `complete`
- `cancel` → `cancelled`; the Python dispatcher keeps stdin responsive while a
  synthesis request is running, so cancellation can be observed between local
  TTS sentence/audio chunks.

Required model environment variables:

```text
LOCAL_VOICE_ASR_MODEL_DIR=<local Paraformer-zh model directory>
LOCAL_VOICE_ASR_DEVICE=cpu|cuda
LOCAL_VOICE_TTS_MODEL_DIR=<directory containing config.json and checkpoint.pth>
LOCAL_VOICE_TTS_DEVICE=cpu|cuda
LOCAL_VOICE_TTS_PREWARM=1
```

The Local Voice host fills these paths from its isolated
`.ds-bot-local/local-voice-models/` directory. `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` are set for serving, so model downloads must happen
before the runtime starts. `LOCAL_VOICE_TTS_PREWARM=1` runs a short Chinese
sentence before `ready`; this moves the first BERT/text-normalization cost into
startup and keeps warmed TTFA measurable.

The runtime intentionally fails with `runtime_not_ready` when dependencies or
model directories are missing. The host must show that state and must not claim
that the voice plugin is ready.

The first provider implementation uses FunASR Paraformer-zh for final Chinese
transcription and MeloTTS Chinese for PCM output. Model download and Python
environment preparation are deployment work; the runtime never downloads
models while serving requests.

Prepare the isolated Python environment before starting the host:

```powershell
python -3.12 runtime/prepare_runtime.py --environment ..\..\.ds-bot-local\local-voice-env
```

Populate `..\..\.ds-bot-local\local-voice-models\paraformer-zh` with the
ModelScope Paraformer-zh files and
`..\..\.ds-bot-local\local-voice-models\melotts-zh` with MeloTTS `config.json`
and `checkpoint.pth`. The setup environment can download the pinned assets:

```powershell
python -3.12 runtime/download_models.py --root .ds-bot-local/local-voice-models
```

The host supplies these paths and offline flags to the runtime automatically.
