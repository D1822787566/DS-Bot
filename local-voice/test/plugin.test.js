import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'

test('the host provides its Cordis service instead of assigning an undeclared property', () => {
  let service
  const ctx = new Proxy({
    provide(name, value) { assert.equal(name, 'localVoice'); service = value },
    effect(fn) { return fn() },
  }, { set() { throw new Error('cannot set property without provide') } })
  const manager = apply(ctx, { state: { prefs: {} }, save: async () => {} })
  assert.equal(service, manager)
})

test('Local Voice plugin registers an isolated authenticated host route', async () => {
  let route
  const ctx = {
    provide(name, value) { Object.defineProperty(this, name, { value }) },
    connection: { fetch: { register(spec) { route = spec; return () => {} } } },
    effect(fn) { return fn() },
  }
  const state = { prefs: {} }
  const manager = apply(ctx, { state, save: async () => {} })
  assert.equal(ctx.localVoice, manager)
  assert.equal(route.path, '/api/local-voice')
  assert.deepEqual(route.methods, ['POST'])

  const response = await route.fetch(new Request('http://localhost/api/local-voice', {
    method: 'POST',
    body: JSON.stringify({ action: 'update', config: { enabled: true } }),
    headers: { 'content-type': 'application/json' },
  }))
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.value.config.enabled, true)
})

test('Local Voice host route rejects unknown actions', async () => {
  let route
  const ctx = {
    provide(name, value) { Object.defineProperty(this, name, { value }) },
    connection: { fetch: { register(spec) { route = spec; return () => {} } } },
    effect(fn) { return fn() },
  }
  apply(ctx, { state: { prefs: {} }, save: async () => {} })
  const response = await route.fetch(new Request('http://localhost/api/local-voice', {
    method: 'POST',
    body: JSON.stringify({ action: 'unknown' }),
    headers: { 'content-type': 'application/json' },
  }))
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'local-voice/invalid')
})

test('Local Voice host route forwards final transcription through the ready runtime', async () => {
  let route
  const ctx = {
    provide(name, value) { Object.defineProperty(this, name, { value }) },
    connection: { fetch: { register(spec) { route = spec; return () => {} } } },
    effect(fn) { return fn() },
  }
  apply(ctx, {
    state: { prefs: {} },
    save: async () => {},
    runtimeFactory: async () => ({
      start: async () => ({ asr: true, tts: true }),
      transcribe: async audio => `bytes:${audio.byteLength}`,
      stop: async () => {},
    }),
  })
  await ctx.localVoice.start()
  const response = await route.fetch(new Request('http://localhost/api/local-voice', {
    method: 'POST',
    body: JSON.stringify({ action: 'transcribe', audio_b64: 'AQID', sampleRate: 16000 }),
    headers: { 'content-type': 'application/json' },
  }))
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.value, 'bytes:3')
})
