export const LOCAL_VOICE_PLUGIN_ID = 'local-voice'
export const LOCAL_VOICE_DISPLAY_NAME = 'Local Voice'

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/
const MAX_DEVICE_NAME = 240

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const boundedText = (value, fallback, max = MAX_DEVICE_NAME) => {
  if (typeof value !== 'string') return fallback
  return value.trim().slice(0, max)
}

export function defaultLocalVoiceConfig() {
  return {
    enabled: false,
    language: 'zh',
    asrModel: 'paraformer-zh',
    ttsModel: 'melotts-zh',
    sampleRate: 16000,
    inputDeviceName: '',
    outputDeviceName: '',
  }
}

export function normalizeLocalVoiceConfig(raw = {}) {
  if (!object(raw)) throw new Error('Local Voice configuration must be an object')
  const base = defaultLocalVoiceConfig()
  if (raw.language !== undefined && raw.language !== 'zh') {
    throw new Error('Local Voice currently supports Chinese only')
  }
  if (raw.sampleRate !== undefined && raw.sampleRate !== 16000) {
    throw new Error('Local Voice audio contract must use 16 kHz')
  }
  const asrModel = boundedText(raw.asrModel, base.asrModel, 96)
  const ttsModel = boundedText(raw.ttsModel, base.ttsModel, 96)
  if (!MODEL_ID.test(asrModel) || !MODEL_ID.test(ttsModel)) throw new Error('Local Voice model id is invalid')
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    language: 'zh',
    asrModel,
    ttsModel,
    sampleRate: 16000,
    inputDeviceName: boundedText(raw.inputDeviceName, base.inputDeviceName),
    outputDeviceName: boundedText(raw.outputDeviceName, base.outputDeviceName),
  }
}

export function localVoiceView(state = {}, runtime = {}) {
  const config = normalizeLocalVoiceConfig(state?.prefs?.localVoice ?? {})
  const capabilities = runtime.capabilities && typeof runtime.capabilities === 'object'
    ? {
        asr: runtime.capabilities.asr === true,
        tts: runtime.capabilities.tts === true,
        prewarmed: runtime.capabilities.prewarmed === true,
      }
    : undefined
  return {
    plugin: LOCAL_VOICE_PLUGIN_ID,
    displayName: LOCAL_VOICE_DISPLAY_NAME,
    config,
    runtime: {
      state: boundedText(runtime.state, 'stopped', 32),
      modelReady: runtime.modelReady === true,
      ...(capabilities ? { capabilities } : {}),
      ...(Number.isInteger(runtime.bridgePort) && runtime.bridgePort > 0 ? { bridgePort: runtime.bridgePort } : {}),
      ...(boundedText(runtime.error, '') ? { error: boundedText(runtime.error, '', 300) } : {}),
    },
  }
}
