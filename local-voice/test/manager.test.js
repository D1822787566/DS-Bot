import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LocalVoiceManager } from '../src/host/manager.js'

test('Local Voice manager persists normalized config without secret fields', async () => {
  const state = { prefs: {} }
  const saved = []
  const manager = new LocalVoiceManager({ state, save: async () => saved.push(true) })
  const view = await manager.update({ enabled: true, inputDeviceName: 'Mic' })
  assert.equal(view.config.enabled, true)
  assert.equal(view.config.inputDeviceName, 'Mic')
  assert.equal(state.prefs.localVoice.ttsModel, 'melotts-zh')
  assert.equal('apiKey' in state.prefs.localVoice, false)
  assert.deepEqual(saved, [true])
})

test('Local Voice manager refuses startup while another voice plugin owns the device', async () => {
  const manager = new LocalVoiceManager({ deviceConflict: () => 'phone-agent' })
  const view = await manager.start()
  assert.equal(view.runtime.state, 'error')
  assert.equal(view.runtime.error, 'audio_device_busy')
  assert.equal(manager.lease.owner(), null)
})

test('Local Voice manager does not claim ready before a real runtime is configured', async () => {
  const manager = new LocalVoiceManager()
  const view = await manager.start()
  assert.equal(view.runtime.state, 'error')
  assert.equal(view.runtime.error, 'runtime_not_configured')
})

test('Local Voice manager owns and releases the device around its runtime', async () => {
  const calls = []
  const manager = new LocalVoiceManager({
    runtimeFactory: async () => ({
      start: async () => { calls.push('start'); return { asr: true, tts: true } },
      stop: async () => calls.push('stop'),
    }),
  })
  let view = await manager.start()
  assert.equal(view.runtime.state, 'ready')
  assert.deepEqual(calls, ['start'])
  view = await manager.stop()
  assert.equal(view.runtime.state, 'stopped')
  assert.deepEqual(calls, ['start', 'stop'])
  assert.equal(manager.lease.owner(), null)
})

test('Local Voice manager refuses ready state when runtime lacks a speech capability', async () => {
  const manager = new LocalVoiceManager({
    runtimeFactory: async () => ({ start: async () => ({ asr: true, tts: false }), stop: async () => {} }),
  })
  const view = await manager.start()
  assert.equal(view.runtime.state, 'error')
  assert.equal(view.runtime.error, 'runtime_capability_missing')
})

test('Local Voice manager forwards speech requests only after runtime is ready', async () => {
  const calls = []
  const manager = new LocalVoiceManager({
    runtimeFactory: async () => ({
      start: async () => ({ asr: true, tts: true }),
      transcribe: async (audio, options) => { calls.push(['transcribe', audio, options]); return '你好' },
      synthesize: (text, options) => { calls.push(['synthesize', text, options]); return { async *[Symbol.asyncIterator]() {} } },
      cancel: requestId => { calls.push(['cancel', requestId]); return true },
      stop: async () => {},
    }),
  })
  await assert.rejects(manager.transcribe(new Uint8Array([1])), error => error.code === 'runtime_not_ready')
  await manager.start()
  assert.equal(await manager.transcribe(new Uint8Array([1]), { sampleRate: 16000 }), '你好')
  manager.synthesize('你好', { voice: 'ZH' })
  assert.equal(manager.cancel('r1'), true)
  assert.deepEqual(calls.map(([kind]) => kind), ['transcribe', 'synthesize', 'cancel'])
})
