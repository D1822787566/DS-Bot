import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

export const DEFAULT_MOSS_LIVE_WS_ENDPOINT = 'wss://api.mosi.cn/v1/realtime'
export const DEFAULT_MOSS_LIVE_MODEL = 'moss-live-1.0'
export const MOSS_LIVE_SECRET_NAME = 'MOSS_API_KEY'
export const MOSS_LIVE_MEDIA_MODE = 'tagged-v1'

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/
const MAX_BINARY_FRAME = 512 * 1024
const MAX_TEXT_MESSAGE = 64 * 1024
const MAX_NAME = 64
const MAX_ALIAS = 32
const MAX_ALIASES = 8
const MAX_PROMPT = 8000
const MAX_GREETING_TEXT = 240
const MAX_SESSION_SECONDS = 1800

const stringValue = (value, max, fallback = '') => typeof value === 'string' ? value.trim().slice(0, max) : fallback
const boundedInteger = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function defaultMossLiveConfig() {
  return {
    enabled: false,
    model: DEFAULT_MOSS_LIVE_MODEL,
    wsEndpoint: DEFAULT_MOSS_LIVE_WS_ENDPOINT,
    personaName: 'DS Bot',
    personaAliases: [],
    personaPrompt: '',
    instructions: '',
    greetingEnabled: true,
    greetingText: '你好，我是 DS Bot，现在可以直接和我说话。',
    maxSessionSeconds: MAX_SESSION_SECONDS,
  }
}

export function normalizeMossLiveConfig(raw = {}) {
  if (!object(raw)) throw new Error('MOSS Live configuration must be an object')
  const base = defaultMossLiveConfig()
  const model = stringValue(raw.model, 96, base.model)
  if (!MODEL_ID.test(model)) throw new Error('MOSS Live model id is invalid')
  const wsEndpoint = stringValue(raw.wsEndpoint, 300, base.wsEndpoint)
  if (wsEndpoint !== DEFAULT_MOSS_LIVE_WS_ENDPOINT) throw new Error('MOSS Live endpoint must use the official realtime endpoint')
  if (raw.maxSessionSeconds !== undefined && (!Number.isInteger(raw.maxSessionSeconds) || raw.maxSessionSeconds < 60 || raw.maxSessionSeconds > MAX_SESSION_SECONDS)) {
    throw new Error('MOSS Live session length must be between 60 and 1800 seconds')
  }
  const aliases = Array.isArray(raw.personaAliases)
    ? raw.personaAliases.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean).slice(0, MAX_ALIASES)
    : base.personaAliases
  if (aliases.some(value => value.length > MAX_ALIAS)) throw new Error(`MOSS Live persona aliases must be at most ${MAX_ALIAS} characters`)
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    model,
    wsEndpoint,
    personaName: stringValue(raw.personaName, MAX_NAME, base.personaName) || base.personaName,
    personaAliases: aliases,
    personaPrompt: stringValue(raw.personaPrompt, MAX_PROMPT, base.personaPrompt),
    instructions: stringValue(raw.instructions, MAX_PROMPT, base.instructions),
    greetingEnabled: typeof raw.greetingEnabled === 'boolean' ? raw.greetingEnabled : base.greetingEnabled,
    greetingText: stringValue(raw.greetingText, MAX_GREETING_TEXT, base.greetingText),
    maxSessionSeconds: boundedInteger(raw.maxSessionSeconds, base.maxSessionSeconds, 60, MAX_SESSION_SECONDS),
  }
}

function sanitizeAliases(value) {
  if (!Array.isArray(value)) throw new Error('persona.aliases must be an array')
  const aliases = value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, MAX_ALIASES)
  if (aliases.some(item => item.length > MAX_ALIAS)) throw new Error(`persona.aliases must be at most ${MAX_ALIAS} characters per item`)
  return aliases
}

function sanitizeSession(session) {
  if (!object(session)) throw new Error('session must be an object')
  const cleaned = {}
  if (session.persona !== undefined) {
    if (!object(session.persona)) throw new Error('persona must be an object')
    const persona = {}
    if (session.persona.name !== undefined) persona.name = stringValue(session.persona.name, MAX_NAME)
    if (session.persona.aliases !== undefined) persona.aliases = sanitizeAliases(session.persona.aliases)
    if (session.persona.prompt !== undefined) persona.prompt = stringValue(session.persona.prompt, MAX_PROMPT)
    if (Object.keys(persona).length > 0) cleaned.persona = persona
  }
  if (session.instructions !== undefined) cleaned.instructions = stringValue(session.instructions, MAX_PROMPT)
  if (Object.keys(cleaned).length === 0) throw new Error('session.update has no supported fields')
  return cleaned
}

export function sanitizeMossClientEvent(message) {
  if (!object(message) || typeof message.action !== 'string') throw new Error('MOSS Live action is required')
  const action = message.action
  if (action === 'attach_session') return { action }
  if (action === 'session.update') return { action, session: sanitizeSession(message.session) }
  if (action === 'mic_state') {
    if (typeof message.enabled !== 'boolean') throw new Error('mic_state.enabled must be boolean')
    return { action, enabled: message.enabled }
  }
  if (action === 'media.mode') {
    if (message.binary_protocol !== MOSS_LIVE_MEDIA_MODE) throw new Error('media.mode must use tagged-v1')
    return { action, binary_protocol: MOSS_LIVE_MEDIA_MODE }
  }
  if (action === 'video.state') {
    if (!['camera', 'screen'].includes(message.source)) throw new Error('video.state.source must be camera or screen')
    if (typeof message.enabled !== 'boolean') throw new Error('video.state.enabled must be boolean')
    return { action, source: message.source, enabled: message.enabled }
  }
  if (action === 'video.stream_focus') {
    if (!['camera', 'screen', 'auto'].includes(message.source)) throw new Error('video.stream_focus.source is invalid')
    return { action, source: message.source }
  }
  if (action === 'playback.chunk.completed') {
    if (typeof message.chunk_id !== 'string' || message.chunk_id.trim() === '') throw new Error('playback chunk id is required')
    return { action, chunk_id: message.chunk_id, run_id: message.run_id, turn_id: message.turn_id }
  }
  if (action === 'playback.completed') return { action, run_id: message.run_id, turn_id: message.turn_id }
  if (action === 'playback.stopped') {
    if (typeof message.played_audio_ms !== 'number' || !Number.isFinite(message.played_audio_ms) || message.played_audio_ms < 0) {
      throw new Error('played_audio_ms must be non-negative')
    }
    return { action, run_id: message.run_id, turn_id: message.turn_id, played_audio_ms: Math.floor(message.played_audio_ms) }
  }
  throw new Error(`unsupported action: ${action}`)
}

export function checkMossBinaryFrame(data, maxBytes = MAX_BINARY_FRAME) {
  if (!data || data.length === 0) throw new Error('empty MOSS Live binary frame')
  if (data.length > maxBytes) throw new Error('MOSS Live binary frame is too large')
  const tag = data[0]
  if (![0x00, 0x01, 0x02].includes(tag)) throw new Error('MOSS Live binary frame has an invalid tag')
  if (tag !== 0x00 && data.length < 4) throw new Error('MOSS Live video frame is empty')
  return tag
}

export function buildMossUpstreamUrl(config, userId = '') {
  const url = new URL(config.wsEndpoint)
  const query = [`model=${encodeURIComponent(config.model)}`]
  if (userId) query.push(`user=${encodeURIComponent(userId)}`)
  url.search = `?${query.join('&')}`
  return url.toString()
}

export function mossSessionUpdate(config) {
  const session = {
    persona: {
      name: config.personaName,
      ...(config.personaAliases.length ? { aliases: config.personaAliases } : {}),
      ...(config.personaPrompt ? { prompt: config.personaPrompt } : {}),
    },
    ...(config.instructions ? { instructions: config.instructions } : {}),
  }
  return { action: 'session.update', session }
}

export function mossLiveView(state, runtime = {}) {
  const config = normalizeMossLiveConfig(state?.prefs?.mossLive ?? {})
  return {
    config,
    apiKeyConfigured: runtime.apiKeyConfigured === true,
    runtime: {
      state: runtime.state ?? 'stopped',
      ...(runtime.error ? { error: stringValue(runtime.error, 300) } : {}),
      ...(runtime.port ? { port: runtime.port } : {}),
      ...(runtime.token ? { token: runtime.token } : {}),
      ...(runtime.startedAt ? { startedAt: runtime.startedAt } : {}),
    },
  }
}

function relayErrorPayload(message) {
  return JSON.stringify({ action: 'error', data: { type: 'error', error: { code: 'local_error', message }, local: true } })
}

export class MossLiveRelay {
  constructor({ config, apiKey, userId = 'ds-bot', WebSocketImpl = WebSocket, WebSocketServerImpl = WebSocketServer } = {}) {
    this.config = normalizeMossLiveConfig(config)
    this.apiKey = String(apiKey ?? '').trim()
    this.userId = stringValue(userId, 64, 'ds-bot')
    this.WebSocketImpl = WebSocketImpl
    this.WebSocketServerImpl = WebSocketServerImpl
    this.server = null
    this.client = null
    this.upstream = null
    this.port = null
    this.token = randomUUID()
    this.state = 'stopped'
    this.error = ''
    this.queue = []
    this.timer = null
    this.startedAt = ''
  }

  view() {
    return {
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      ...(this.port ? { port: this.port } : {}),
      ...(this.token && this.state !== 'stopped' ? { token: this.token } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
    }
  }

  async start({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.state !== 'stopped') return this.view()
    if (!this.apiKey) throw new Error('MOSS API Key is not configured')
    this.state = 'starting'
    this.error = ''
    this.startedAt = new Date().toISOString()
    const token = this.token
    const WebSocketServerImpl = this.WebSocketServerImpl
    const WebSocketImpl = this.WebSocketImpl
    const server = new WebSocketServerImpl({
      host,
      port,
      maxPayload: MAX_BINARY_FRAME,
      verifyClient: ({ req }, done) => {
        let accepted = false
        try {
          const url = new URL(req.url, 'ws://127.0.0.1')
          accepted = url.searchParams.get('token') === token
        } catch { accepted = false }
        done(accepted, 401, 'Unauthorized')
      },
    })
    this.server = server
    server.on('connection', socket => this.attachClient(socket))
    try {
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
      this.port = server.address()?.port ?? null
      const upstream = new WebSocketImpl(buildMossUpstreamUrl(this.config, this.userId), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        maxPayload: 8 * 1024 * 1024,
      })
      this.upstream = upstream
      upstream.on('open', () => {
        if (this.state === 'stopped') return
        this.state = 'ready'
        this.flushQueue()
      })
      upstream.on('message', (data, isBinary) => this.forwardUpstream(data, isBinary))
      upstream.on('error', error => this.fail(error?.message || 'MOSS Live upstream connection failed'))
      upstream.on('close', () => { if (this.state !== 'stopped') this.fail('MOSS Live upstream connection closed') })
      this.timer = setTimeout(() => this.fail('MOSS Live session reached its time limit'), this.config.maxSessionSeconds * 1000)
      this.timer.unref?.()
      return this.view()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  attachClient(socket) {
    if (this.client && this.client !== socket) {
      try { this.client.close(1000, 'replaced') } catch { /* ignore */ }
    }
    this.client = socket
    socket.on('message', (data, isBinary) => this.forwardClient(data, isBinary))
    socket.on('close', () => { if (this.client === socket) this.client = null })
    socket.on('error', () => { if (this.client === socket) this.client = null })
    if (this.state === 'ready') this.flushQueue()
  }

  sendLocalError(message) {
    if (this.client?.readyState === 1) this.client.send(relayErrorPayload(message))
  }

  enqueue(payload, isBinary) {
    if (this.queue.length >= 64) {
      this.fail('MOSS Live relay backpressure')
      return
    }
    this.queue.push({ payload, isBinary })
  }

  forwardClient(data, isBinary) {
    if (isBinary) {
      try { checkMossBinaryFrame(data) } catch (error) { this.sendLocalError(error.message); return }
      if (this.upstream?.readyState === 1) this.upstream.send(data)
      else this.enqueue(data, true)
      return
    }
    if (Buffer.byteLength(String(data), 'utf8') > MAX_TEXT_MESSAGE) { this.sendLocalError('MOSS Live message is too large'); return }
    let event
    try { event = sanitizeMossClientEvent(JSON.parse(String(data))) } catch (error) { this.sendLocalError(error.message); return }
    const encoded = JSON.stringify(event)
    if (event.action === 'session.update') {
      // The host owns the session configuration. The browser may send a valid
      // update, but unsupported fields can never reach the upstream service.
      event.session = sanitizeSession(event.session)
    }
    if (this.upstream?.readyState === 1) this.upstream.send(encoded)
    else this.enqueue(encoded, false)
  }

  flushQueue() {
    if (this.upstream?.readyState !== 1) return
    for (const item of this.queue.splice(0)) this.upstream.send(item.payload)
  }

  forwardUpstream(data, isBinary) {
    if (this.client?.readyState !== 1) return
    this.client.send(data, { binary: isBinary })
  }

  fail(message) {
    if (this.state === 'stopped') return
    this.error = stringValue(message, 300, 'MOSS Live relay failed')
    this.state = 'error'
    this.sendLocalError(this.error)
    try { this.client?.close(1011, this.error.slice(0, 120)) } catch { /* ignore */ }
    try { this.upstream?.close() } catch { /* ignore */ }
  }

  async stop() {
    clearTimeout(this.timer)
    this.timer = null
    this.state = 'stopped'
    this.error = ''
    this.port = null
    this.queue = []
    try { this.client?.close(1000, 'stopped') } catch { /* ignore */ }
    try { this.upstream?.close() } catch { /* ignore */ }
    this.client = null
    this.upstream = null
    const server = this.server
    this.server = null
    if (server) await new Promise(resolve => server.close(() => resolve()))
    return this.view()
  }
}

export class MossLiveManager {
  constructor(rt, { createRelay = options => new MossLiveRelay(options) } = {}) {
    this.rt = rt
    this.createRelay = createRelay
    this.relay = null
    this.state = 'stopped'
    this.error = ''
  }

  view() {
    const relay = this.relay?.view?.() ?? { state: this.state }
    return { ...relay, ...(this.error ? { error: this.error } : {}) }
  }

  async start(config) {
    if (this.relay && this.state !== 'stopped') {
      if (this.state !== 'error' && this.relay.view?.().state !== 'error') return this.view()
      await this.stop()
    }
    const apiKey = this.rt.secretValue?.(MOSS_LIVE_SECRET_NAME) ?? ''
    if (!apiKey) {
      this.state = 'error'
      this.error = 'MOSS API Key is not configured'
      return this.view()
    }
    this.state = 'starting'
    this.error = ''
    try {
      const relay = this.createRelay({ config: normalizeMossLiveConfig(config), apiKey, userId: 'ds-bot' })
      this.relay = relay
      await relay.start()
      this.state = relay.state
      return this.view()
    } catch (error) {
      this.state = 'error'
      this.error = stringValue(error?.message, 300, 'MOSS Live failed to start')
      await this.relay?.stop?.()
      this.relay = null
      return this.view()
    }
  }

  async stop() {
    await this.relay?.stop?.()
    this.relay = null
    this.state = 'stopped'
    this.error = ''
    return this.view()
  }
}

export function install(rt) {
  const { state } = rt
  const ensureConfig = () => {
    state.prefs ??= {}
    state.prefs.mossLive = normalizeMossLiveConfig(state.prefs.mossLive ?? {})
    return state.prefs.mossLive
  }
  ensureConfig()
  const manager = new MossLiveManager(rt)
  const view = () => { ensureConfig(); return mossLiveView(state, { ...manager.view(), apiKeyConfigured: Boolean(rt.secretValue?.(MOSS_LIVE_SECRET_NAME)) }) }
  const save = async () => { await rt.save(); return view() }
  const mossLive = () => view()
  const mossLiveUpdate = async body => {
    const config = ensureConfig()
    if (body?.config !== undefined) state.prefs.mossLive = normalizeMossLiveConfig({ ...config, ...body.config })
    if (manager.state !== 'stopped') await manager.stop()
    return save()
  }
  const mossLiveSetKey = async body => {
    const value = typeof body?.value === 'string' ? body.value.trim() : ''
    if (!value) throw new Error('MOSS API Key is required')
    await rt.secretEndpoint('secret-set', { name: MOSS_LIVE_SECRET_NAME, value, purpose: 'MOSS Live realtime model' })
    return view()
  }
  const mossLiveClearKey = async () => {
    if (rt.secretValue?.(MOSS_LIVE_SECRET_NAME)) await rt.secretEndpoint('secret-delete', { name: MOSS_LIVE_SECRET_NAME })
    return view()
  }
  const mossLiveStart = async () => {
    const config = ensureConfig()
    config.enabled = true
    await rt.save()
    await manager.start(config)
    return view()
  }
  const mossLiveStop = async () => {
    ensureConfig().enabled = false
    await manager.stop()
    return save()
  }
  Object.assign(rt, { mossLive, mossLiveUpdate, mossLiveSetKey, mossLiveClearKey, mossLiveStart, mossLiveStop })
  rt.ctx.effect(() => () => { void manager.stop() }, 'ds-bot: MOSS Live relay')
}
