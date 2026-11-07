import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const textOf = content => Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  : typeof content === 'string' ? content : ''
const clean = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128
const segmentIdentifier = value => identifier(value) || (Number.isSafeInteger(value) && value > 0)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const terminal = status => !['queued', 'running'].includes(status)
const RETENTION_MS = 86400_000
const MAX_INPUTS = 512
const incomingTypes = new Set(['bridge.hello', 'roles.snapshot.get', 'device.wake', 'context.snapshot.get',
  'input.submit', 'input.status', 'input.cancel', 'run.cancel', 'output.cancel', 'delivery.progress', 'delivery.ended'])

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
  constructor({ rt, deviceId, send, activityEpoch = randomUUID(), roles = () => createVoiceRoleRoster(rt.state, activityEpoch), inputs = new Map() }) {
    this.rt = rt
    this.deviceId = clean(deviceId, 128)
    this.send = send
    this.activityEpoch = clean(activityEpoch, 80) || randomUUID()
    this.rawRoles = roles
    this.binding = null
    this.connected = true
    this.nextSequence = 0
    this.nextIncoming = 0
    this.pending = new Map()
    this.runs = new Map()
    this.outputs = new Map()
    this.turns = new Map()
    // Shared by connections to this local device: reconnection queries status,
    // but never acquires the old connection's audio delivery target.
    this.inputs = inputs
    this.activeWake = null
    this.lastGeneration = -1
    this.rosterKey = JSON.stringify(this.roles())
  }

  roles() {
    const value = this.rawRoles()
    // Team persistence increments state.revision for unrelated changes too.
    // A wake mapping advances only when its actual routing/profile changes.
    const roles = value.roles.map(({ profile_version: _version, ...role }) => role)
    const key = JSON.stringify({ activity_epoch: value.activity_epoch, roles })
    if (key !== this.rolesKey) {
      const revision = this.rolesValue ? Math.max(value.revision, this.rolesValue.revision + 1) : value.revision
      this.rolesKey = key
      this.rolesValue = { activity_epoch: value.activity_epoch, revision, roles: roles.map(role => ({ ...role, profile_version: revision })) }
    }
    return this.rolesValue
  }

  envelope(type, correlation = {}, payload = {}) {
    return {
      protocol: 'agent-events.v1', event_id: randomUUID(), type,
      binding: this.binding, sequence: this.nextSequence++, correlation, payload,
      occurred_at: new Date().toISOString(),
    }
  }

  emit(type, correlation, payload) {
    if (this.connected) this.send(this.envelope(type, correlation, payload))
  }

  error(value, code) { this.emit('bridge.error', object(value?.correlation) ? value.correlation : {}, { error_code: code }) }

  assertBinding(value) {
    if (!this.connected || !this.binding || !object(value) || Object.keys(value).length !== 3
      || Object.keys(this.binding).some(key => value[key] !== this.binding[key])) throw new Error('invalid_binding')
  }

  validate(value) {
    const keys = ['protocol', 'event_id', 'type', 'binding', 'sequence', 'correlation', 'payload', 'occurred_at']
    if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))
      || value.protocol !== 'agent-events.v1' || !identifier(value.event_id) || !incomingTypes.has(value.type)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !object(value.correlation) || !object(value.payload)
      || typeof value.occurred_at !== 'string' || !Number.isFinite(Date.parse(value.occurred_at))) throw new Error('invalid_envelope')
    if (value.sequence !== this.nextIncoming) throw new Error('invalid_sequence')
    if (value.type === 'bridge.hello') {
      if (value.binding !== null) throw new Error('invalid_binding')
    } else this.assertBinding(value.binding)
    this.nextIncoming++
  }

  async receive(value) {
    this.validate(value)
    if (value.type === 'bridge.hello') return this.hello(value)
    if (value.type === 'roles.snapshot.get') return this.roleSnapshot(value)
    if (value.type === 'device.wake') return this.wake(value)
    if (value.type === 'context.snapshot.get') return this.contextSnapshot(value)
    if (value.type === 'input.submit') return this.submit(value)
    if (value.type === 'input.status') return this.inputStatus(value)
    if (value.type === 'input.cancel') return this.cancelInput(value)
    if (value.type === 'run.cancel') return this.cancelRun(value)
    if (value.type === 'output.cancel') return this.cancelOutput(value)
    return this.delivery(value)
  }

  hello(value) {
    if (!this.connected || this.binding !== null || value.payload.channel !== 'voice' || value.payload.target_id !== this.deviceId) throw new Error('invalid_state')
    this.binding = { device_id: this.deviceId, activity_epoch: this.activityEpoch, channel_session_id: randomUUID() }
    this.emit('bridge.ready', {}, { runtime: 'ds-bot-voice-runtime', idempotency_retention_seconds: RETENTION_MS / 1000 })
    return this.binding
  }

  roleSnapshot(value) {
    const requestId = value.correlation.request_id
    if (!identifier(requestId)) throw new Error('invalid_correlation')
    this.emit('roles.snapshot.result', { request_id: requestId }, this.roles())
    return true
  }

  rolesChanged() {
    const roster = this.roles()
    const key = JSON.stringify(roster)
    if (key === this.rosterKey) return
    this.rosterKey = key
    this.activeWake = null
    for (const item of this.runs.values()) this.muteOutput(item)
    if (this.binding) this.emit('roles.changed', {}, roster)
  }

  wake(value) {
    const { wake_session_id: wakeSessionId, bot_id: botId, wake_mapping_version: mappingVersion, generation } = value.payload
    const roster = this.roles()
    const role = roster.roles.find(item => item.bot_id === botId)
    if (!identifier(wakeSessionId) || value.correlation.wake_session_id !== wakeSessionId || !identifier(botId)
      || !role || mappingVersion !== `${roster.activity_epoch}:${roster.revision}`
      || !this.rt.botOf(botId) || this.rt.chatOf(botId) !== role.session_id
      || !Number.isSafeInteger(generation) || generation < 0) {
      this.error(value, 'invalid_wake')
      return false
    }
    if (this.activeWake?.wakeSessionId === wakeSessionId) {
      if (this.activeWake.botId !== botId || this.activeWake.generation !== generation
        || this.activeWake.rosterKey !== JSON.stringify(roster)) {
        this.error(value, 'invalid_wake'); return false
      }
    } else {
      if (generation <= this.lastGeneration) { this.error(value, 'invalid_wake'); return false }
      for (const item of this.runs.values()) this.muteOutput(item)
      this.activeWake = { wakeSessionId, botId, sessionId: role.session_id, generation, rosterKey: JSON.stringify(roster) }
      this.lastGeneration = generation
    }
    this.emit('device.wake.accepted', { wake_session_id: wakeSessionId }, {
      wake_session_id: wakeSessionId, bot_id: botId, session_id: role.session_id, wake_mapping_version: mappingVersion,
      ...(generation === undefined ? {} : { generation }),
    })
    return true
  }

  ownsWake(payload) {
    const wake = this.activeWake
    return this.connected && wake !== null && wake.botId === payload.bot_id
      && wake.wakeSessionId === payload.wake_session_id && wake.generation === payload.generation
      && (payload.session_id === undefined || wake.sessionId === payload.session_id)
      && this.rt.botOf(wake.botId) !== undefined && this.rt.chatOf(wake.botId) === wake.sessionId
      && JSON.stringify(this.roles()) === wake.rosterKey
  }

  contextSnapshot(value) {
    const requestId = value.correlation.request_id
    const botId = clean(value.payload.bot_id, 128)
    const userId = clean(value.payload.user_id, 128) || 'owner'
    const bot = this.rt.botOf(botId)
    if (!identifier(requestId) || !bot) { this.error(value, 'unknown_bot'); return false }
    this.emit('context.snapshot.result', { request_id: requestId }, {
      bot_id: botId, user_id: userId,
      profile_version: Number.isSafeInteger(this.rt.state?.revision) ? this.rt.state.revision : 0,
      agent_names: [clean(bot.name, 160)].filter(Boolean), explicit_wake_required: true,
      negative_addressing_examples: [], rules: [clean(bot.role, 160)].filter(Boolean),
      dialogue_active: value.payload.dialogue_active === true,
      recent_reply: clean(value.payload.recent_reply, 2000),
      wake_names: [clean(bot.phoneAgent?.wakeName || bot.name, 128)].filter(Boolean),
    })
    return true
  }

  pruneInputs() {
    for (const [id, item] of this.inputs) {
      if (terminal(item.status) && Date.now() - item.updatedAt > RETENTION_MS) {
        item.owner.outputs.delete(item.responseId)
        this.inputs.delete(id)
      }
    }
  }

  async submit(value) {
    const { input_id: inputId } = value.correlation
    const { bot_id: botId, text, speaker, segment_id: segmentId } = value.payload
    if (!identifier(inputId) || !identifier(botId) || typeof text !== 'string' || !text.trim() || text.length > 20_000
      || value.payload.channel !== 'voice') return this.reject(inputId, 'invalid_input')
    if (!this.rt.botOf(botId)) return this.reject(inputId, 'unknown_bot')
    if (!speaker || speaker.status !== 'owner_verified'
      || !segmentIdentifier(segmentId) || speaker.segment_id !== segmentId) return this.reject(inputId, 'identity_not_verified')
    const previous = this.inputs.get(inputId)
    if (previous) {
      if (previous.botId !== botId || (value.payload.session_id !== undefined && previous.sessionId !== value.payload.session_id)) return this.reject(inputId, 'input_id_conflict')
      return this.inputStatus(value)
    }
    if (!this.ownsWake(value.payload)) return this.reject(inputId, 'invalid_wake')
    this.pruneInputs()
    if (this.inputs.size >= MAX_INPUTS) return this.reject(inputId, 'input_backpressure')
    const wake = this.activeWake
    const item = { inputId, botId, sessionId: wake.sessionId, wakeSessionId: wake.wakeSessionId,
      generation: wake.generation, status: 'queued', updatedAt: Date.now(), requestId: randomUUID(),
      accepted: false, dispatched: false, buffer: [], bufferBytes: 0, owner: this,
      nextSegment: 0, lastDelivered: -1, outputMuted: false, outputStarted: false, outputEnded: false }
    this.inputs.set(inputId, item)
    this.pending.set(item.requestId, item)
    try {
      await this.rt.ensureCapabilities(item.sessionId)
      if (item.status === 'cancelled') return this.reject(inputId, 'cancelled')
      if (!this.ownsWake(value.payload)) throw new Error('invalid_wake')
      item.dispatched = true
      await this.rt.ctx.sessionController.prompt({
        requestId: item.requestId, sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      // A matching durable user/message is stronger admission evidence than an
      // uncertain RPC completion. Never invite a resubmit of admitted work.
      if (!item.runId) {
        this.pending.delete(item.requestId)
        item.status = 'failed'; item.updatedAt = Date.now()
        return this.reject(inputId, error?.message === 'invalid_wake' ? 'invalid_wake' : 'submit_failed')
      }
    }
    item.accepted = true
    this.emit('input.accepted', { input_id: inputId }, { status: item.status, bot_id: botId, session_id: item.sessionId })
    for (const event of item.buffer) {
      if (!event.type.startsWith('output.') || (this.outputCurrent(item) && !item.outputMuted)) this.emit(event.type, event.correlation, event.payload)
    }
    item.buffer = []; item.bufferBytes = 0
    return true
  }

  inputStatus(value) {
    const inputId = value.correlation.input_id
    if (!identifier(inputId)) throw new Error('invalid_correlation')
    this.pruneInputs()
    const item = this.inputs.get(inputId)
    this.emit('input.status.result', { input_id: inputId }, item
      ? { status: item.status, bot_id: item.botId, session_id: item.sessionId }
      : { status: 'unknown' })
    return true
  }

  reject(inputId, errorCode) {
    this.emit('input.rejected', identifier(inputId) ? { input_id: inputId } : {}, { error_code: errorCode })
    return false
  }

  correlation(item, output = false) {
    return { input_id: item.inputId, run_id: item.runId, bot_id: item.botId, session_id: item.sessionId,
      wake_session_id: item.wakeSessionId, ...(item.generation === undefined ? {} : { generation: item.generation }),
      target_id: this.deviceId, ...(output ? { response_id: item.responseId } : {}) }
  }

  record(item, type, payload) {
    const correlation = this.correlation(item, type.startsWith('output.'))
    if (item.accepted) return this.emit(type, correlation, payload)
    const bytes = JSON.stringify(payload).length
    if (item.buffer.length >= 64 || item.bufferBytes + bytes > 65536) {
      item.outputMuted = true
      item.buffer = item.buffer.filter(event => !event.type.startsWith('output.'))
      return
    }
    item.buffer.push({ type, correlation, payload }); item.bufferBytes += bytes
  }

  outputCurrent(item) {
    return this.ownsWake({ bot_id: item.botId, session_id: item.sessionId,
      wake_session_id: item.wakeSessionId, generation: item.generation })
  }

  startRun(item, turn) {
    for (const previous of this.runs.values()) {
      if (previous.sessionId === item.sessionId && previous.turn === turn) this.muteOutput(previous)
    }
    this.pending.delete(item.requestId)
    item.status = 'running'; item.updatedAt = Date.now()
    item.runId = randomUUID(); item.responseId = randomUUID(); item.turn = turn
    this.runs.set(item.runId, item); this.outputs.set(item.responseId, item)
    this.record(item, 'run.started', { origin: 'voice_input' })
    if (this.outputCurrent(item)) {
      item.outputStarted = true
      this.record(item, 'output.started', { tts_voice: this.voiceFor(item.botId) })
    }
  }

  sessionEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId || !event?.type) return
    if (event.type === 'turn/start') {
      if ([...this.pending.values()].some(item => item.sessionId === sessionId)) this.turns.set(sessionId, event.data?.turn)
      return
    }
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data?.inserted ?? []) {
        const item = this.pending.get(message.source?.rpcId)
        if (item?.sessionId === sessionId && message.source?.kind === 'user') item.messageId = message.id
      }
      return
    }
    if (event.type === 'user/message') {
      const item = this.pending.get(event.data?.source?.rpcId)
      const turn = event.data?.turn ?? this.turns.get(sessionId)
      if (item?.sessionId === sessionId && event.data.source.kind === 'user' && Number.isSafeInteger(turn)) this.startRun(item, turn)
      return
    }
    for (const item of this.runs.values()) {
      if (item.sessionId !== sessionId || item.turn !== event.data?.turn) continue
      if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (!text || item.outputMuted || !this.outputCurrent(item)) continue
        for (const part of text.match(/[\s\S]{1,2000}/gu)) {
          this.record(item, 'output.segment', { segment_index: item.nextSegment++,
            display_text: part, speak_text: part, tts_voice: this.voiceFor(item.botId) })
        }
      } else if (event.type === 'turn/end') {
        const reason = event.data.reason?.kind
        const status = reason === 'completed' ? 'completed' : reason === 'error' || reason === 'blocked' ? 'failed' : 'cancelled'
        if (item.outputStarted && !item.outputEnded && this.outputCurrent(item)) {
          item.outputEnded = true
          this.record(item, 'output.ended', { status, final_segment_index: item.nextSegment - 1 })
        }
        this.record(item, 'run.ended', { status })
        item.status = status; item.updatedAt = Date.now()
        this.runs.delete(item.runId)
      }
    }
    if (event.type === 'turn/end') this.turns.delete(sessionId)
  }

  voiceFor(botId) { return clean(this.rt.botOf(botId)?.phoneAgent?.ttsVoice, 128) || undefined }

  muteOutput(item) {
    item.outputMuted = true
    if (item.outputStarted && !item.outputEnded) {
      item.outputEnded = true
      this.record(item, 'output.ended', { status: 'cancelled', final_segment_index: item.nextSegment - 1 })
    }
  }

  cancelResult(value, scope, result) {
    this.emit('cancel.result', value.correlation, { request_event_id: value.event_id, scope, result })
    return result === 'cancelled'
  }

  async cancelInput(value) {
    const item = this.inputs.get(value.correlation.input_id)
    if (!item || item.owner !== this) return this.cancelResult(value, 'input', 'not_found')
    if (item.status !== 'queued') return this.cancelResult(value, 'input', 'already_started')
    if (item.dispatched) {
      if (!item.messageId) return this.cancelResult(value, 'input', 'already_started')
      try {
        await this.rt.ctx.sessionController.updateQueue({ sessionId: item.sessionId, itemId: item.messageId, action: { kind: 'remove' } })
      } catch { return this.cancelResult(value, 'input', 'already_started') }
    }
    item.status = 'cancelled'; item.updatedAt = Date.now()
    this.pending.delete(item.requestId)
    return this.cancelResult(value, 'input', 'cancelled')
  }

  async cancelRun(value) {
    const item = this.runs.get(value.correlation.run_id)
    if (!item || this.rt.chatOf(item.botId) !== item.sessionId) return this.cancelResult(value, 'run', 'not_found')
    try { await this.rt.ctx.sessionController.cancel({ sessionId: item.sessionId }) }
    catch { return this.cancelResult(value, 'run', 'failed') }
    this.muteOutput(item)
    return this.cancelResult(value, 'run', 'cancelled')
  }

  cancelOutput(value) {
    const item = this.outputs.get(value.correlation.response_id)
    if (!item || value.correlation.target_id !== this.deviceId) return this.cancelResult(value, 'output', 'not_found')
    this.muteOutput(item)
    return this.cancelResult(value, 'output', 'cancelled')
  }

  delivery(value) {
    const item = this.outputs.get(value.correlation.response_id)
    const index = value.payload.last_completed_segment_index
    if (!item || value.correlation.target_id !== this.deviceId || !Number.isSafeInteger(index)
      || index < item.lastDelivered || index >= item.nextSegment || item.deliveryEnded
      || (value.type === 'delivery.ended' && !['delivered', 'cancelled', 'failed'].includes(value.payload.status))) throw new Error('invalid_delivery')
    item.lastDelivered = index
    if (value.type === 'delivery.ended') item.deliveryEnded = true
    return true
  }

  close() {
    this.connected = false
    this.activeWake = null
    for (const item of this.runs.values()) this.muteOutput(item)
  }
}

export class VoiceBridgeServer {
  constructor({ rt, deviceId, credential, activityEpoch = randomUUID(), getRoles }) {
    this.rt = rt; this.deviceId = deviceId; this.credential = credential
    this.activityEpoch = activityEpoch; this.getRoles = getRoles
    this.server = null; this.port = null
    this.sessions = new Set(); this.sockets = new Set(); this.inputs = new Map()
  }

  async start({ host = '127.0.0.1', port = 0 } = {}) {
    if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Bridge requires loopback')
    if (this.server) return this.view()
    if (!this.credential) throw new Error('Bridge requires credential')
    const server = new WebSocketServer({ host, port, maxPayload: 65536,
      verifyClient: ({ req }, done) => done(req.headers.authorization === `Bearer ${this.credential}`, 401, 'Unauthorized') })
    this.server = server
    server.on('connection', socket => {
      // A device has one current authenticated connection. Old work remains in
      // DS Bot, while its delivery binding is permanently invalidated.
      for (const previous of this.sessions) previous.close()
      for (const previous of this.sockets) previous.close(1000, 'replaced')
      const session = new VoiceBridgeSession({ rt: this.rt, deviceId: this.deviceId, activityEpoch: this.activityEpoch,
        inputs: this.inputs, roles: () => this.getRoles(), send: value => {
          if (socket.readyState !== 1) return
          if (socket.bufferedAmount > 262144) { session.close(); socket.close(1013, 'output_backpressure'); return }
          socket.send(JSON.stringify(value))
        } })
      this.sessions.add(session); this.sockets.add(socket)
      socket.on('error', () => session.close())
      socket.on('message', data => {
        let value
        try { value = JSON.parse(String(data)) } catch { socket.close(1003, 'invalid_json'); return }
        void session.receive(value).catch(error => session.error(value, error.message))
      })
      socket.on('close', () => { session.close(); this.sessions.delete(session); this.sockets.delete(socket) })
    })
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    this.port = server.address()?.port ?? null
    return this.view()
  }

  view() { return { state: this.server ? 'ready' : 'stopped', ...(this.port ? { port: this.port } : {}) } }

  async stop() {
    for (const session of this.sessions) session.close()
    this.sessions.clear()
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
    const server = this.server
    this.server = null; this.port = null
    if (server) await new Promise(resolve => server.close(() => resolve()))
    this.inputs.clear()
    return this.view()
  }

  sessionEvent(session, event) {
    const targets = new Set(this.sessions)
    for (const item of this.inputs.values()) if (!terminal(item.status)) targets.add(item.owner)
    for (const bridge of targets) bridge.sessionEvent(session, event)
  }

  rolesChanged() { for (const bridge of this.sessions) bridge.rolesChanged() }
}
