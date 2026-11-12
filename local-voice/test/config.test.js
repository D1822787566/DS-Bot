import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LOCAL_VOICE_PLUGIN_ID,
  defaultLocalVoiceConfig,
  normalizeLocalVoiceConfig,
  localVoiceView,
} from '../src/host/config.js'

test('Local Voice defaults to Chinese local speech models', () => {
  assert.deepEqual(defaultLocalVoiceConfig(), {
    enabled: false,
    language: 'zh',
    asrModel: 'paraformer-zh',
    ttsModel: 'melotts-zh',
    sampleRate: 16000,
    inputDeviceName: '',
    outputDeviceName: '',
  })
})

test('Local Voice normalizes bounded configuration and rejects other languages', () => {
  const value = normalizeLocalVoiceConfig({
    enabled: true,
    language: 'zh',
    asrModel: 'paraformer-zh',
    ttsModel: 'melotts-zh',
    inputDeviceName: 'Microphone',
    outputDeviceName: 'Speaker',
  })
  assert.equal(value.enabled, true)
  assert.equal(value.inputDeviceName, 'Microphone')
  assert.throws(() => normalizeLocalVoiceConfig({ language: 'en' }), /Chinese only/)
  assert.throws(() => normalizeLocalVoiceConfig({ sampleRate: 48000 }), /16 kHz/)
})

test('Local Voice view exposes runtime state without secrets or raw paths', () => {
  const view = localVoiceView({ prefs: { localVoice: { enabled: true } } }, {
    state: 'ready',
    modelReady: true,
    capabilities: { asr: true, tts: true, prewarmed: true },
    bridgePort: 4319,
    bridgeToken: 'secret-token',
    modelPath: 'C:\\models\\tts',
  })
  assert.equal(LOCAL_VOICE_PLUGIN_ID, 'local-voice')
  assert.equal(view.config.enabled, true)
  assert.equal(view.runtime.state, 'ready')
  assert.equal(view.runtime.modelReady, true)
  assert.deepEqual(view.runtime.capabilities, { asr: true, tts: true, prewarmed: true })
  assert.equal(view.runtime.bridgePort, 4319)
  assert.equal(view.runtime.bridgeToken, undefined)
  assert.equal(view.runtime.modelPath, undefined)
})
