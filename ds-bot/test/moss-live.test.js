import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import WebSocket from 'ws'

import {
  DEFAULT_MOSS_LIVE_WS_ENDPOINT,
  defaultMossLiveConfig,
  normalizeMossLiveConfig,
  sanitizeMossClientEvent,
  buildMossUpstreamUrl,
  MossLiveManager,
  MossLiveRelay,
  install,
} from '../src/host/moss-live.js'

test('MOSS Live defaults describe the supported realtime endpoint and model', () => {
  assert.deepEqual(defaultMossLiveConfig(), {
    enabled: false,
    model: 'moss-live-1.0',
    wsEndpoint: DEFAULT_MOSS_LIVE_WS_ENDPOINT,
    personaName: 'DS Bot',
    personaAliases: [],
    personaPrompt: '',
    instructions: '',
    greetingEnabled: true,
    greetingText: '你好，我是 DS Bot，现在可以直接和我说话。',
    maxSessionSeconds: 1800,
  })
})

test('MOSS Live configuration accepts bounded persona settings and rejects unsafe endpoints', () => {
  const value = normalizeMossLiveConfig({
    enabled: true,
    model: 'moss-live-1.0',
    personaName: 'Luna',
    personaAliases: ['露娜'],
    personaPrompt: '用自然口语回答。',
    instructions: '始终使用中文。',
    greetingEnabled: false,
    greetingText: '你好。',
    maxSessionSeconds: 600,
  })
  assert.equal(value.enabled, true)
  assert.equal(value.personaName, 'Luna')
  assert.deepEqual(value.personaAliases, ['露娜'])
  assert.equal(value.greetingEnabled, false)
  assert.equal(value.greetingText, '你好。')
  assert.throws(() => normalizeMossLiveConfig({ wsEndpoint: 'https://example.com/realtime' }), /MOSS Live endpoint/)
  assert.throws(() => normalizeMossLiveConfig({ maxSessionSeconds: 10 }), /session length/)
})

test('MOSS Live client events are allowlisted and session fields are cleaned', () => {
  assert.deepEqual(sanitizeMossClientEvent({
    action: 'session.update',
    session: {
      persona: { name: 'Luna', aliases: ['露娜'], prompt: 'prompt', unsupported: 'drop' },
      instructions: 'instructions',
      tools: [{ name: 'do-not-forward' }],
    },
  }), {
    action: 'session.update',
    session: { persona: { name: 'Luna', aliases: ['露娜'], prompt: 'prompt' }, instructions: 'instructions' },
  })
  assert.deepEqual(sanitizeMossClientEvent({ action: 'mic_state', enabled: false }), { action: 'mic_state', enabled: false })
  assert.throws(() => sanitizeMossClientEvent({ action: 'unknown' }), /unsupported action/)
  assert.throws(() => sanitizeMossClientEvent({ action: 'mic_state', enabled: 'false' }), /boolean/)
})

test('MOSS Live upstream URL contains only the model and optional user', () => {
  assert.equal(
    buildMossUpstreamUrl({ model: 'moss-live-1.0', wsEndpoint: DEFAULT_MOSS_LIVE_WS_ENDPOINT }, 'ds bot'),
    `${DEFAULT_MOSS_LIVE_WS_ENDPOINT}?model=moss-live-1.0&user=ds%20bot`,
  )
})

test('MOSS Live manager refuses to start without a stored API key', async () => {
  const manager = new MossLiveManager({ secretValue: () => '' })
  const view = await manager.start(defaultMossLiveConfig())
  assert.equal(view.state, 'error')
  assert.match(view.error, /API Key/)
})

test('MOSS Live manager can retry after a relay enters an error state', async () => {
  let created = 0
  const manager = new MossLiveManager({ secretValue: () => 'secret' }, { createRelay: () => {
    created += 1
    return {
      state: 'error',
      view: () => ({ state: 'error', error: 'upstream failed' }),
      start: async function () { this.state = 'error'; return this.view() },
      stop: async function () { this.state = 'stopped' },
    }
  } })
  await manager.start(defaultMossLiveConfig())
  await manager.start(defaultMossLiveConfig())
  assert.equal(created, 2)
})

test('MOSS Live host module exposes config and key actions without returning the key', async () => {
  const calls = []
  const rt = {
    state: { prefs: {} },
    ctx: { effect() {} },
    save: async () => calls.push('save'),
    secretValue: name => name === 'MOSS_API_KEY' ? 'secret-value' : '',
    secretEndpoint: async (endpoint, body) => { calls.push([endpoint, body.name, body.value]) },
  }
  install(rt)
  const view = await rt.mossLiveUpdate({ config: { personaName: 'Luna' } })
  assert.equal(view.config.personaName, 'Luna')
  assert.equal(view.apiKeyConfigured, true)
  assert.equal(view.config.apiKey, undefined)
  await rt.mossLiveSetKey({ value: 'new-secret' })
  assert.deepEqual(calls, ['save', ['secret-set', 'MOSS_API_KEY', 'new-secret']])
})

test('MOSS Live start restores defaults after a saved state reload has no MOSS config', async () => {
  const rt = {
    state: { prefs: {} },
    ctx: { effect() {} },
    save: async () => {},
    secretValue: () => '',
  }
  install(rt)
  delete rt.state.prefs.mossLive
  const view = await rt.mossLiveStart()
  assert.equal(view.config.model, 'moss-live-1.0')
  assert.equal(view.runtime.state, 'error')
  assert.match(view.runtime.error, /API Key/)
})

test('MOSS Live relay authenticates the local client and forwards only cleaned events', async () => {
  class FakeUpstream extends EventEmitter {
    static last = null
    constructor() {
      super()
      this.readyState = 0
      this.sent = []
      FakeUpstream.last = this
      setImmediate(() => { this.readyState = 1; this.emit('open') })
    }
    send(value) {
      this.sent.push(value)
      if (typeof value !== 'string') return
      const event = JSON.parse(value)
      if (event.action === 'attach_session') this.emit('message', JSON.stringify({ action: 'session_attached', data: { session_id: 's1' } }), false)
      if (event.action === 'session.update') this.emit('message', JSON.stringify({ action: 'session.updated', data: {} }), false)
    }
    close() { this.readyState = 3; this.emit('close') }
  }
  const relay = new MossLiveRelay({ config: defaultMossLiveConfig(), apiKey: 'secret', WebSocketImpl: FakeUpstream })
  await relay.start()
  const client = new WebSocket(`ws://127.0.0.1:${relay.port}/?token=${encodeURIComponent(relay.token)}`)
  const received = []
  client.on('message', data => received.push(JSON.parse(String(data))))
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
  client.send(JSON.stringify({ action: 'attach_session' }))
  client.send(JSON.stringify({ action: 'session.update', session: { persona: { name: 'Luna', tools: ['drop'] }, instructions: 'say hi' } }))
  client.send(JSON.stringify({ action: 'unknown' }))
  client.send(Buffer.from([0x00, 1, 2]))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(JSON.parse(FakeUpstream.last.sent[0]), { action: 'attach_session' })
  assert.deepEqual(JSON.parse(FakeUpstream.last.sent[1]), { action: 'session.update', session: { persona: { name: 'Luna' }, instructions: 'say hi' } })
  assert.ok(FakeUpstream.last.sent.some(value => Buffer.isBuffer(value) && value[0] === 0))
  assert.ok(received.some(value => value.action === 'error' && value.data.local === true))
  await relay.stop()
})
