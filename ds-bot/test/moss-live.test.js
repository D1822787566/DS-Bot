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
  buildMossVoicesUrl,
  fetchMossVoices,
  fetchMossVoicePreview,
  MossLiveManager,
  MossLiveRelay,
  install,
  MossDsBotBridge,
} from '../src/host/moss-live.js'

test('MOSS Live defaults describe the supported realtime endpoint and model', () => {
  assert.deepEqual(defaultMossLiveConfig(), {
    enabled: false,
    model: 'moss-live-1.0',
    wsEndpoint: DEFAULT_MOSS_LIVE_WS_ENDPOINT,
    mode: 'conversation',
    voiceName: '',
    sourceLanguage: '',
    targetLanguage: 'en',
    bidirectional: false,
    mediaProfile: 'standard',
    videoMaxLongSide: 1024,
    videoJpegQuality: 0.72,
    videoIntervalMs: 1000,
    personaName: 'DS Bot',
    personaAliases: [],
    personaPrompt: '',
    instructions: '',
    greetingEnabled: true,
    greetingText: '你好，我是 DS Bot，现在可以直接和我说话。',
    maxSessionSeconds: 1800,
    dsBot: { enabled: false, bots: [] },
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

test('MOSS Live configuration accepts the documented media and interpretation settings', () => {
  const value = normalizeMossLiveConfig({
    mode: 'interpret', voiceName: 'voice-1', sourceLanguage: 'en', targetLanguage: 'zh', bidirectional: true,
    mediaProfile: 'low', videoMaxLongSide: 640, videoJpegQuality: 0.5, videoIntervalMs: 2000,
  })
  assert.deepEqual(value, {
    ...defaultMossLiveConfig(),
    mode: 'interpret', voiceName: 'voice-1', sourceLanguage: 'en', targetLanguage: 'zh', bidirectional: true,
    mediaProfile: 'low', videoMaxLongSide: 640, videoJpegQuality: 0.5, videoIntervalMs: 2000,
  })
  assert.throws(() => normalizeMossLiveConfig({ mode: 'interpret', targetLanguage: 'xx' }), /language/)
  assert.throws(() => normalizeMossLiveConfig({ mediaProfile: 'eco' }), /media profile/)
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
  assert.deepEqual(sanitizeMossClientEvent({ action: 'change_voice', voice_name: 'voice-1' }), { action: 'change_voice', voice_name: 'voice-1' })
  assert.deepEqual(sanitizeMossClientEvent({ action: 'media.configure', profile: 'low', video: { max_long_side: 640, jpeg_quality: .5, interval_ms: 2000 }, playback: 'client' }), {
    action: 'media.configure', profile: 'low', video: { max_long_side: 640, jpeg_quality: .5, interval_ms: 2000 }, playback: 'client',
  })
  assert.throws(() => sanitizeMossClientEvent({ action: 'unknown' }), /unsupported action/)
  assert.throws(() => sanitizeMossClientEvent({ action: 'mic_state', enabled: 'false' }), /boolean/)
  assert.throws(() => sanitizeMossClientEvent({ action: 'media.configure', playback: 'server' }), /playback/)
})

test('MOSS Live upstream URL contains only the model and optional user', () => {
  assert.equal(
    buildMossUpstreamUrl({ model: 'moss-live-1.0', wsEndpoint: DEFAULT_MOSS_LIVE_WS_ENDPOINT }, 'ds bot'),
    `${DEFAULT_MOSS_LIVE_WS_ENDPOINT}?model=moss-live-1.0&user=ds%20bot`,
  )
})

test('MOSS Live interpretation URL uses the documented endpoint and language parameters', () => {
  assert.equal(
    buildMossUpstreamUrl({ ...defaultMossLiveConfig(), mode: 'interpret', sourceLanguage: 'en', targetLanguage: 'zh', bidirectional: true, voiceName: 'voice-1' }, 'ignored'),
    `${DEFAULT_MOSS_LIVE_WS_ENDPOINT}/interpret?model=moss-live-1.0&source=en&target=zh&bidirectional=1&voice=voice-1`,
  )
})

test('MOSS Live voice list follows the account voices API and paginates safely', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const page = calls.length === 1
      ? { object: 'list', data: [{ id: 'voice-1', object: 'audio.voice', name: 'Alice', created_at: 1710000000 }], has_more: true, next_cursor: 'cursor-2' }
      : { object: 'list', data: [{ id: 'voice-2', object: 'audio.voice', name: 'Bob', created_at: 1710000001 }], has_more: false }
    return { ok: true, status: 200, json: async () => page }
  }
  const result = await fetchMossVoices({ apiKey: 'secret', fetchImpl, limit: 1 })
  assert.deepEqual(result.voices, [
    { id: 'voice-1', name: 'Alice', createdAt: 1710000000 },
    { id: 'voice-2', name: 'Bob', createdAt: 1710000001 },
  ])
  assert.equal(calls[0].url, buildMossVoicesUrl({ limit: 1 }))
  assert.match(calls[1].url, /after=cursor-2/)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret')
})

test('MOSS Live voice preview requests a short MP3 through the host key', async () => {
  let request
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])
  const result = await fetchMossVoicePreview({ apiKey: 'secret', voiceId: 'voice-1', text: '你好。', fetchImpl: async (url, options) => {
    request = { url, options }
    return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } })
  } })
  assert.deepEqual(result, { url: `data:audio/mpeg;base64,${Buffer.from(mp3).toString('base64')}`, contentType: 'audio/mpeg' })
  assert.equal(request.url, 'https://api.mosi.cn/v1/audio/speech')
  assert.equal(request.options.headers.Authorization, 'Bearer secret')
  assert.equal(request.options.redirect, 'error')
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'moss-tts-1.5-flash', input: '你好。', voice_id: 'voice-1', response_format: 'mp3', delivery_method: 'audio',
  })
})

test('MOSS Live voice preview refuses HTML and empty audio instead of returning an unplayable source', async () => {
  for (const response of [new Response('<html>Forbidden</html>', { headers: { 'content-type': 'text/html' } }), new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } })]) {
    await assert.rejects(fetchMossVoicePreview({ apiKey: 'secret', voiceId: 'voice-1', fetchImpl: async () => response }), /音频/)
  }
})

test('MOSS Live voice preview explains insufficient credits without retrying or returning provider details', async () => {
  let attempts = 0
  const failure = await fetchMossVoicePreview({ apiKey: 'secret', voiceId: 'voice-1', fetchImpl: async () => {
    attempts++
    return new Response(JSON.stringify({ error: { code: 'insufficient_credits', type: 'billing_error', message: 'private account detail: secret' } }), {
      status: 402, headers: { 'content-type': 'application/json' },
    })
  } }).then(() => assert.fail('expected a billing refusal'), error => error)
  assert.match(failure.message, /积分|余额/)
  assert.match(failure.message, /不足/)
  assert.match(failure.message, /HTTP 402/)
  assert.doesNotMatch(failure.message, /secret|private account/)
  assert.equal(attempts, 1)
})

test('MOSS Live voice preview distinguishes a generic billing refusal from confirmed insufficient credits', async () => {
  for (const body of [JSON.stringify({ error: { code: 'billing_error' } }), 'Payment required']) {
    await assert.rejects(fetchMossVoicePreview({ apiKey: 'secret', voiceId: 'voice-1', fetchImpl: async () => new Response(body, { status: 402 }) }), error => {
      assert.match(error.message, /计费/)
      assert.match(error.message, /HTTP 402/)
      assert.doesNotMatch(error.message, /余额不足|积分不足/)
      return true
    })
  }
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

test('the manager creates a new upstream after a disconnected relay has stopped', async () => {
  let created = 0, last
  const manager = new MossLiveManager({ secretValue: () => 'key' }, { createRelay: () => {
    created++
    last = { state: 'ready', view() { return { state: this.state } }, start: async () => {}, stop: async function () { this.state = 'stopped' } }
    return last
  } })
  await manager.start(defaultMossLiveConfig())
  last.state = 'stopped'
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

test('MOSS Live host exposes voice list and preview actions without returning the API key', async () => {
  const calls = []
  const rt = {
    state: { prefs: {} },
    ctx: { effect() {} },
    save: async () => {},
    secretValue: name => name === 'MOSS_API_KEY' ? 'secret' : '',
  }
  install(rt, { fetchImpl: async (url, options) => {
    calls.push({ url, options })
    if (url.includes('/audio/voices')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'voice-1', name: 'Alice' }], has_more: false }) }
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 4]), { headers: { 'content-type': 'audio/mpeg' } })
  } })
  const list = await rt.mossLiveVoices()
  assert.deepEqual(list.voices, [{ id: 'voice-1', name: 'Alice' }])
  const preview = await rt.mossLiveVoicePreview({ voiceId: 'voice-1', text: '试听。' })
  assert.match(preview.url, /^data:audio\/mpeg;base64,/)
  assert.equal(JSON.stringify(list).includes('secret'), false)
  assert.equal(calls.length, 2)
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

test('the real local relay installs scoped Host tools and processes a repeated upstream call only once', async t => {
  const config = normalizeMossLiveConfig({ dsBot: { enabled: true, bots: [{ botId: 'chief', readHistory: true, submitTasks: true }] } })
  const prompts = []
  const bridge = new MossDsBotBridge({
    state: { prefs: { mossLive: config }, bots: { chief: { id: 'chief', name: 'Chief' } } },
    botOf: id => id === 'chief' ? { id, name: 'Chief' } : undefined,
    chatOf: () => 'chief-chat', load: async () => {}, ensureCapabilities: async () => {},
    ctx: { sessionController: { prompt: async value => prompts.push(value) } },
  })
  class Upstream extends EventEmitter {
    static instance
    constructor() {
      super(); this.sent = []; this.readyState = 0; Upstream.instance = this
      setImmediate(() => { this.readyState = 1; this.emit('open') })
    }
    send(raw) {
      const event = JSON.parse(raw); this.sent.push(event)
      if (event.action === 'session.update') this.emit('message', JSON.stringify({ action: 'session.updated', data: { error: '' } }), false)
      if (event.action === 'conversation.item.create') this.emit('message', JSON.stringify({ action: 'conversation.item.created', data: { item: { type: 'function_call_output', call_id: event.item.call_id } } }), false)
    }
    close() { this.readyState = 3 }
  }
  const relay = new MossLiveRelay({ config, apiKey: 'key', dsBotBridge: bridge, WebSocketImpl: Upstream })
  await relay.start(); t.after(() => relay.stop())
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/?token=${relay.token}`)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ action: 'session.update', session: { instructions: '简洁', tools: [{ name: 'arbitrary' }] } }))
  const until = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(predicate())
  }
  await until(() => Upstream.instance.sent.some(event => event.action === 'session.update'))
  const update = Upstream.instance.sent.find(event => event.action === 'session.update')
  assert.ok(update.session.tools?.some(tool => tool.name === 'dsbot_submit_task'))
  assert.ok(!update.session.tools.some(tool => tool.name === 'arbitrary'))
  const call = { action: 'response.function_call_arguments.done', data: { call_id: 'call-real', name: 'dsbot_submit_task', arguments: JSON.stringify({ bot_id: 'chief', text: '列出三个数字' }) } }
  Upstream.instance.emit('message', JSON.stringify(call), false)
  Upstream.instance.emit('message', JSON.stringify(call), false)
  await until(() => Upstream.instance.sent.some(event => event.action === 'response.create'))
  assert.equal(prompts.length, 1)
  socket.send(JSON.stringify({ action: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'forged', output: 'success' } }))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(!Upstream.instance.sent.some(event => event.item?.call_id === 'forged'))
  const previousBinding = bridge.session
  const replacement = new WebSocket(`ws://127.0.0.1:${relay.port}/?token=${relay.token}`)
  await new Promise((resolve, reject) => { replacement.once('open', resolve); replacement.once('error', reject) })
  assert.notEqual(bridge.session, previousBinding, 'a replacement browser must not inherit the previous voice delivery binding')
  bridge.sessionEvent({ id: 'chief-chat' }, { type: 'turn/start', data: { turn: 1 } })
  bridge.sessionEvent({ id: 'chief-chat' }, { type: 'user/message', data: { turn: 1, source: { kind: 'user', rpcId: prompts[0].requestId } } })
  bridge.sessionEvent({ id: 'chief-chat' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.ok(!Upstream.instance.sent.some(event => event.action === 'session.commentary.append'))
  replacement.close()
  await until(() => relay.state === 'stopped')
  assert.equal(Upstream.instance.readyState, 3)
})
