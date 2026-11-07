import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const textOf = content => Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  : typeof content === 'string' ? content : ''

const clean = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : ''

export function createVoiceRoleRoster(state = {}, activityEpoch = randomUUID(), sessionIdFor = botId => state.bots?.[botId]?.sessionId || botId) {
  const revision = Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0
  const roles = Object.values(state.bots ?? {}).map(bot => {
    const wakeName = clean(bot.phoneAgent?.wakeName || bot.name, 128)
    const ttsVoice = clean(bot.phoneAgent?.ttsVoice, 128)
    return {
      bot_id: clean(bot.id, 128),
      session_id: clean(sessionIdFor(bot.id) || bot.sessionId || bot.id, 128),
      wake_names: wakeName === '' ? [] : [wakeName],
      ...(ttsVoice === '' ? {} : { tts_voice: ttsVoice }),
      profile_version: revision,
    }
  }).filter(role => role.bot_id !== '' && role.session_id !== '' && role.wake_names.length > 0)
    .sort((a, b) => a.bot_id.localeCompare(b.bot_id))
  return { activity_epoch: clean(activityEpoch, 80) || randomUUID(), revision, roles }
}

export class VoiceBridgeSession {
  constructor({ rt, deviceId, send, activityEpoch = randomUUID(), roles = () => createVoiceRoleRoster(rt.state, activityEpoch) }) {
    this.rt = rt
    this.deviceId = clean(deviceId, 128)
    this.send = send
    this.activityEpoch = clean(activityEpoch, 80) || randomUUID()
    this.roles = roles
    this.binding = null
    this.nextSequence = 0
    this.pending = new Map()
    this.runs = new Map()
    this.inputs = new Map()
  }

  envelope(type, correlation = {}, payload = {}) {
    return {
      protocol: 'agent-events.v1', event_id: randomUUID(), type,
      binding: this.binding, sequence: this.nextSequence++, correlation, payload,
      occurred_at: new Date().toISOString(),
    }
  }

  emit(type, correlation, payload) { this.send(this.envelope(type, correlation, payload)) }

  assertBinding(value) {
    if (this.binding === null || JSON.stringify(value ?? null) !== JSON.stringify(this.binding)) throw new Error('invalid_binding')
  }

  async receive(value) {
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new Error('invalid_envelope')
    if (value.type === 'bridge.hello') return this.hello(value)
    this.assertBinding(value.binding)
    if (value.type === 'roles.snapshot.get') return this.roleSnapshot(value)
    if (value.type === 'context.snapshot.get') return this.contextSnapshot(value)
    if (value.type === 'input.submit') return this.submit(value)
    if (value.type === 'input.status') return this.inputStatus(value)
    if (value.type === 'input.cancel') return this.cancelInput(value)
    if (value.type === 'run.cancel') return this.cancelRun(value)
    if (value.type === 'output.cancel') return this.cancelOutput(value)
    if (value.type === 'delivery.progress' || value.type === 'delivery.ended') return true
    throw new Error('invalid_state')
  }

  hello(value) {
    if (this.binding !== null || value.payload?.channel !== 'voice' || value.payload?.target_id !== this.deviceId) throw new Error('invalid_state')
    this.binding = { device_id: this.deviceId, activity_epoch: this.activityEpoch, channel_session_id: randomUUID() }
    this.emit('bridge.ready', {}, { runtime: 'ds-bot-voice-runtime', idempotency_retention_seconds: 86400 })
    return this.binding
  }

  roleSnapshot(value) {
    const requestId = value.correlation?.request_id
    if (!clean(requestId, 128)) throw new Error('invalid_correlation')
    this.emit('roles.snapshot.result', { request_id: requestId }, this.roles())
    return true
  }

  rolesChanged() {
    if (this.binding !== null) this.emit('roles.changed', {}, this.roles())
  }

  contextSnapshot(value) {
    const requestId = value.correlation?.request_id
    const botId = clean(value.payload?.bot_id, 128)
    const userId = clean(value.payload?.user_id, 128) || 'owner'
    const bot = this.rt.botOf(botId)
    if (!clean(requestId, 128) || !bot) {
      this.emit('bridge.error', { request_id: requestId ?? '' }, { error_code: 'unknown_bot' })
      return false
    }
    const recentReply = clean(value.payload?.recent_reply, 2000)
    this.emit('context.snapshot.result', { request_id: requestId }, {
      bot_id: botId,
      user_id: userId,
      profile_version: Number.isSafeInteger(this.rt.state?.revision) ? this.rt.state.revision : 0,
      agent_names: [clean(bot.name, 160)].filter(Boolean),
      explicit_wake_required: true,
      negative_addressing_examples: [],
      rules: [clean(bot.role, 160)].filter(Boolean),
      dialogue_active: value.payload?.dialogue_active === true,
      recent_reply: recentReply,
      wake_names: [clean(bot.phoneAgent?.wakeName || bot.name, 128)].filter(Boolean),
    })
    return true
  }

  async submit(value) {
    const inputId = clean(value.correlation?.input_id, 128)
    const botId = clean(value.payload?.bot_id, 128)
    const text = clean(value.payload?.text, 20_000)
    const speaker = value.payload?.speaker
    const bot = this.rt.botOf(botId)
    if (!inputId || !botId || !text) return this.reject(inputId, 'invalid_input')
    if (!bot) return this.reject(inputId, 'unknown_bot')
    if (!speaker || speaker.status !== 'owner_verified') return this.reject(inputId, 'identity_not_verified')
    const previous = this.inputs.get(inputId)
    if (previous) {
      this.emit('input.status.result', { input_id: inputId }, { status: previous.status, bot_id: previous.botId, session_id: previous.sessionId })
      return true
    }
    const sessionId = this.rt.chatOf(bot.id)
    this.inputs.set(inputId, { status: 'queued', botId, sessionId })
    this.pending.set(sessionId, { inputId, botId, sessionId })
    try {
      await this.rt.ensureCapabilities(sessionId)
      await this.rt.ctx.sessionController.prompt({
        requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      this.pending.delete(sessionId)
      this.inputs.set(inputId, { status: 'failed', botId, sessionId })
      return this.reject(inputId, error?.message === 'timeout' ? 'timeout' : 'submit_failed')
    }
    this.emit('input.accepted', { input_id: inputId }, { status: 'queued', bot_id: botId, session_id: sessionId })
    return true
  }

  inputStatus(value) {
    const inputId = clean(value.correlation?.input_id, 128)
    const item = this.inputs.get(inputId)
    this.emit('input.status.result', { input_id: inputId }, item
      ? { status: item.status, bot_id: item.botId, session_id: item.sessionId }
      : { status: 'unknown' })
    return true
  }

  reject(inputId, errorCode) {
    this.emit('input.rejected', { input_id: inputId }, { error_code: errorCode })
    return false
  }

  sessionEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId || !event?.type) return
    if (event.type === 'turn/start') {
      const pending = this.pending.get(sessionId)
      if (!pending) return
      const runId = randomUUID()
      const responseId = randomUUID()
      const run = { ...pending, runId, responseId, nextSegment: 0, turn: event.data?.turn }
      this.pending.delete(sessionId)
      this.inputs.set(run.inputId, { status: 'running', botId: run.botId, sessionId })
      this.runs.set(sessionId, run)
      const correlation = { input_id: run.inputId, run_id: runId, bot_id: run.botId, session_id: sessionId }
      this.emit('run.started', correlation, { origin: 'voice_input' })
      this.emit('output.started', { ...correlation, response_id: responseId }, { tts_voice: this.voiceFor(run.botId) })
      return
    }
    const run = this.runs.get(sessionId)
    if (!run) return
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text === '') return
      this.emit('output.segment', { input_id: run.inputId, run_id: run.runId, response_id: run.responseId, bot_id: run.botId, session_id: sessionId }, {
        segment_index: run.nextSegment++, display_text: text, speak_text: text, tts_voice: this.voiceFor(run.botId),
      })
    } else if (event.type === 'turn/end') {
      this.emit('output.ended', { input_id: run.inputId, run_id: run.runId, response_id: run.responseId, bot_id: run.botId, session_id: sessionId }, { status: 'completed', final_segment_index: run.nextSegment - 1 })
      this.emit('run.ended', { input_id: run.inputId, run_id: run.runId, bot_id: run.botId, session_id: sessionId }, { status: 'completed' })
      this.inputs.set(run.inputId, { status: 'completed', botId: run.botId, sessionId })
      this.runs.delete(sessionId)
    }
  }

  voiceFor(botId) {
    const bot = this.rt.botOf(botId)
    return clean(bot?.phoneAgent?.ttsVoice, 128) || undefined
  }

  cancelInput(value) {
    const inputId = clean(value.correlation?.input_id, 128)
    this.emit('cancel.result', { input_id: inputId }, { request_event_id: value.event_id ?? '', scope: 'input', result: 'not_implemented' })
    return true
  }

  cancelRun(value) {
    this.emit('cancel.result', value.correlation ?? {}, { request_event_id: value.event_id ?? '', scope: 'run', result: 'not_implemented' })
    return true
  }

  cancelOutput(value) {
    this.emit('cancel.result', value.correlation ?? {}, { request_event_id: value.event_id ?? '', scope: 'output', result: 'not_implemented' })
    return true
  }
}

export class VoiceBridgeServer {
  constructor({ rt, deviceId, credential, activityEpoch = randomUUID(), getRoles }) {
    this.rt = rt
    this.deviceId = deviceId
    this.credential = credential
    this.activityEpoch = activityEpoch
    this.getRoles = getRoles
    this.server = null
    this.sessions = new Set()
    this.sockets = new Set()
    this.port = null
  }

  async start({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.server) return this.view()
    const server = new WebSocketServer({
      host, port,
      verifyClient: ({ req }, done) => done(req.headers.authorization === `Bearer ${this.credential}`, 1008, 'Unauthorized'),
    })
    this.server = server
    server.on('connection', socket => {
      const session = new VoiceBridgeSession({
        rt: this.rt, deviceId: this.deviceId, activityEpoch: this.activityEpoch,
        roles: () => this.getRoles(), send: value => { if (socket.readyState === 1) socket.send(JSON.stringify(value)) },
      })
      this.sessions.add(session)
      this.sockets.add(socket)
      socket.on('message', data => {
        let value
        try { value = JSON.parse(String(data)) } catch { socket.close(1003, 'invalid_json'); return }
        void session.receive(value).catch(error => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'bridge.error', error_code: error.message })) })
      })
      socket.on('close', () => { this.sessions.delete(session); this.sockets.delete(socket) })
    })
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    this.port = server.address()?.port ?? null
    return this.view()
  }

  view() { return { state: this.server ? 'ready' : 'stopped', ...(this.port ? { port: this.port } : {}) } }

  async stop() {
    for (const session of this.sessions) this.sessions.delete(session)
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
    const server = this.server
    this.server = null; this.port = null
    if (server) await new Promise(resolve => server.close(() => resolve()))
    return this.view()
  }

  sessionEvent(session, event) {
    for (const bridge of this.sessions) bridge.sessionEvent(session, event)
  }

  rolesChanged() {
    for (const bridge of this.sessions) bridge.rolesChanged()
  }
}
