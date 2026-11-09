const SAMPLE_RATE = 48_000
const TARGET_RATE = 16_000
const FRAME_SAMPLES = 320

export function buildMossSessionUrl({ port, token }) {
  return `ws://127.0.0.1:${Number(port)}/?token=${encodeURIComponent(String(token ?? ''))}`
}

export function mossSessionUpdatePayload(config = {}) {
  const persona = {
    name: String(config.personaName ?? '').trim(),
    ...(Array.isArray(config.personaAliases) && config.personaAliases.length ? { aliases: config.personaAliases } : {}),
    ...(String(config.personaPrompt ?? '').trim() ? { prompt: String(config.personaPrompt).trim() } : {}),
  }
  return {
    action: 'session.update',
    session: {
      persona,
      ...(String(config.instructions ?? '').trim() ? { instructions: String(config.instructions).trim() } : {}),
    },
  }
}

export function transcriptEvent(action, data = {}) {
  if (action === 'input.transcript.updated' || action === 'input.transcript.done') return {
    kind: 'user', done: action.endsWith('.done'), text: String(data.text ?? ''),
    ...(data.turn === undefined ? {} : { id: `turn:${String(data.turn)}` }),
  }
  if (action === 'output.transcript.updated' || action === 'output.transcript.done') return {
    kind: 'assistant', done: action.endsWith('.done'), text: String(data.text ?? ''),
    ...(data.run_id === undefined ? {} : { id: `run:${String(data.run_id)}` }),
  }
  if (action === 'response.interrupted') return {
    kind: 'assistant', done: true, interrupted: true, text: String(data.text ?? ''),
    ...(data.run_id === undefined ? {} : { id: `run:${String(data.run_id)}` }),
  }
  return { kind: undefined, done: false, text: '' }
}

export function mergeTranscriptEvent(items = [], next) {
  if (!next?.kind || !String(next.text ?? '').trim()) return items
  const value = { ...next, text: String(next.text), at: next.at ?? new Date().toISOString() }
  let index = -1
  if (value.id) index = items.findLastIndex?.(item => item.id === value.id) ?? [...items].map(item => item.id).lastIndexOf(value.id)
  if (index < 0 && !value.id) {
    for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
      if (items[cursor].kind === value.kind && items[cursor].done !== true) { index = cursor; break }
      if (items[cursor].kind !== value.kind) break
    }
  }
  if (index >= 0 && items[index].done === true && value.done !== true) return items
  if (index < 0) return [...items, value]
  if (items[index].done === true && value.interrupted !== true && next.done === true) return items
  const updated = items.slice()
  updated[index] = { ...value, at: items[index].at ?? value.at }
  return updated
}

export function transcriptMarkdown(items = [], { personaName = 'MOSS', startedAt = '', endedAt = '' } = {}) {
  const lines = ['# MOSS Live 通话记录', '', `- Persona：${String(personaName || 'MOSS')}`]
  if (startedAt) lines.push(`- 开始时间：${startedAt}`)
  if (endedAt) lines.push(`- 结束时间：${endedAt}`)
  lines.push('', '---', '')
  for (const item of items) {
    const text = String(item?.text ?? '').trim()
    if (!text) continue
    const who = item.kind === 'user' ? '你' : 'MOSS'
    const at = item.at ? `[${item.at}] ` : ''
    lines.push(`${at}${who}：${text}${item.interrupted ? '（本轮被打断）' : ''}`, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function speakMossGreeting(text, { speechSynthesis = globalThis.speechSynthesis, SpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance, signal } = {}) {
  const value = String(text ?? '').trim()
  if (!value || !speechSynthesis || typeof SpeechSynthesisUtterance !== 'function' || typeof speechSynthesis.speak !== 'function') return Promise.resolve(false)
  if (signal?.aborted) return Promise.resolve(false)
  try { speechSynthesis.cancel?.() } catch { /* ignore */ }
  return new Promise(resolve => {
    let settled = false
    let timer = null
    const abort = () => { try { speechSynthesis.cancel?.() } catch { /* ignore */ }; finish(false) }
    const finish = value => { if (settled) return; settled = true; if (timer !== null) globalThis.clearTimeout?.(timer); resolve(value) }
    let utterance
    try { utterance = new SpeechSynthesisUtterance(value) } catch { finish(false); return }
    utterance.lang = 'zh-CN'
    utterance.rate = 1.04
    utterance.pitch = 1
    utterance.onend = () => finish(true)
    utterance.onerror = () => finish(false)
    signal?.addEventListener?.('abort', abort, { once: true })
    timer = globalThis.setTimeout(() => { try { speechSynthesis.cancel?.() } catch { /* ignore */ }; finish(false) }, 8000)
    try { speechSynthesis.speak(utterance) } catch { finish(false) }
  })
}

const WORKLET_SOURCE = `
class MossCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.source = []
    this.offset = 0
    this.ratio = sampleRate / ${TARGET_RATE}
    this.frame = []
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel || channel.length === 0) return true
    for (let index = 0; index < channel.length; index += 1) this.source.push(channel[index])
    while (this.offset + this.ratio < this.source.length) {
      const at = Math.floor(this.offset)
      const fraction = this.offset - at
      const sample = this.source[at] * (1 - fraction) + this.source[at + 1] * fraction
      this.frame.push(Math.max(-1, Math.min(1, sample)))
      this.offset += this.ratio
      if (this.frame.length === ${FRAME_SAMPLES}) {
        const pcm = new Int16Array(${FRAME_SAMPLES})
        for (let item = 0; item < pcm.length; item += 1) {
          const value = this.frame[item]
          pcm[item] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff)
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer])
        this.frame = []
      }
    }
    const remove = Math.floor(this.offset)
    if (remove > 0) { this.source.splice(0, remove); this.offset -= remove }
    return true
  }
}
registerProcessor('moss-capture', MossCaptureProcessor)
`

function levelOf(pcm) {
  if (!pcm.length) return 0
  let sum = 0
  for (const sample of pcm) { const value = sample / 32768; sum += value * value }
  return Math.min(1, Math.sqrt(sum / pcm.length) * 4)
}

export class MossMicCapture {
  constructor({ onFrame, onLevel } = {}) {
    this.onFrame = onFrame ?? (() => {})
    this.onLevel = onLevel ?? (() => {})
    this.ctx = null
    this.stream = null
    this.source = null
    this.node = null
    this.sink = null
    this.url = null
    this.enabled = true
  }

  async start() {
    if (this.node) return
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风')
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext
    if (!Context) throw new Error('当前环境不支持实时音频')
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false })
    this.ctx = new Context({ latencyHint: 'interactive' })
    this.url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
    await this.ctx.audioWorklet.addModule(this.url)
    this.node = new AudioWorkletNode(this.ctx, 'moss-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    this.node.port.onmessage = event => {
      if (!this.enabled) return
      const pcm = new Int16Array(event.data)
      this.onLevel(levelOf(pcm))
      this.onFrame(pcm)
    }
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.sink = this.ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(this.ctx.destination)
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    for (const track of this.stream?.getAudioTracks?.() ?? []) track.enabled = this.enabled
    if (!this.enabled) this.onLevel(0)
  }

  async stop() {
    this.enabled = false
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null }
    this.source?.disconnect?.(); this.source = null
    this.sink?.disconnect?.(); this.sink = null
    for (const track of this.stream?.getTracks?.() ?? []) track.stop()
    this.stream = null
    if (this.ctx) await this.ctx.close().catch(() => {})
    this.ctx = null
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
    this.onLevel(0)
  }
}

export class MossAudioPlayer {
  constructor({ onChunkDone, onDrain, onLevel, contextFactory } = {}) {
    this.onChunkDone = onChunkDone ?? (() => {})
    this.onDrain = onDrain ?? (() => {})
    this.onLevel = onLevel ?? (() => {})
    this.contextFactory = contextFactory ?? (() => {
      const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext
      if (!Context) throw new Error('当前环境不支持音频播放')
      return new Context({ latencyHint: 'interactive' })
    })
    this.ctx = null
    this.gain = null
    this.analyser = null
    this.levelData = null
    this.items = new Set()
    this.nextTime = 0
    this.levelFrame = null
    this.levelTimer = null
  }

  ensureContext() {
    if (this.ctx) return this.ctx
    this.ctx = this.contextFactory()
    this.gain = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.levelData = new Uint8Array(this.analyser.frequencyBinCount)
    this.gain.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
    this.nextTime = this.ctx.currentTime
    return this.ctx
  }

  enqueue(buffer, info) {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const view = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2))
    if (!view.length) return
    const audio = ctx.createBuffer(1, view.length, SAMPLE_RATE)
    const channel = audio.getChannelData(0)
    for (let index = 0; index < view.length; index += 1) channel[index] = view[index] / 32768
    const source = ctx.createBufferSource()
    source.buffer = audio
    source.connect(this.gain)
    const startAt = Math.max(ctx.currentTime + 0.08, this.nextTime)
    const item = { source, info, startAt, endAt: startAt + audio.duration, stopped: false }
    this.items.add(item)
    this.nextTime = item.endAt
    this.monitorLevel()
    source.onended = () => {
      if (item.stopped) return
      this.items.delete(item)
      this.onChunkDone(item)
      if (this.items.size === 0) {
        this.stopLevelMonitor()
        this.onLevel(0, 'playback')
        this.onDrain()
      }
    }
    source.start(startAt)
  }

  stop() {
    const now = this.ctx?.currentTime ?? 0
    let playedMs = 0
    let info = null
    for (const item of this.items) {
      item.stopped = true
      info ||= item.info
      if (now >= item.startAt && now <= item.endAt) { playedMs = Math.max(0, (now - item.startAt) * 1000); info = item.info ?? info }
      try { item.source.stop() } catch { /* already stopped */ }
    }
    this.items.clear()
    this.stopLevelMonitor()
    this.onLevel(0, 'playback')
    if (this.ctx) this.nextTime = now
    return { playedMs, info }
  }

  level() {
    if (!this.analyser || !this.levelData) return 0
    this.analyser.getByteTimeDomainData(this.levelData)
    let sum = 0
    for (const value of this.levelData) { const sample = (value - 128) / 128; sum += sample * sample }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 4)
  }

  monitorLevel() {
    if (this.levelFrame !== null || this.levelTimer !== null) return
    const tick = () => {
      this.levelFrame = null
      this.levelTimer = null
      if (!this.items.size) return
      this.onLevel(this.level(), 'playback')
      if (typeof globalThis.requestAnimationFrame === 'function') this.levelFrame = globalThis.requestAnimationFrame(tick)
      else this.levelTimer = globalThis.setTimeout(tick, 50)
    }
    tick()
  }

  stopLevelMonitor() {
    if (this.levelFrame !== null) globalThis.cancelAnimationFrame?.(this.levelFrame)
    if (this.levelTimer !== null) globalThis.clearTimeout?.(this.levelTimer)
    this.levelFrame = null
    this.levelTimer = null
  }

  async close() {
    this.stop()
    this.stopLevelMonitor()
    if (this.ctx) await this.ctx.close().catch(() => {})
    this.ctx = null; this.gain = null; this.analyser = null; this.levelData = null
  }
}

export class MossLiveSession {
  constructor({ port, token, config, onState, onTranscript, onEvent, onLevel } = {}) {
    this.port = port
    this.token = token
    this.config = config ?? {}
    this.onState = onState ?? (() => {})
    this.onTranscript = onTranscript ?? (() => {})
    this.onEvent = onEvent ?? (() => {})
    this.onLevel = onLevel ?? (() => {})
    this.ws = null
    this.mic = null
    this.player = new MossAudioPlayer({
      onChunkDone: item => this.playbackChunkDone(item),
      onDrain: () => {
        if (this.state === 'speaking') this.setState('ready')
        this.onEvent({ type: 'ui.playback_idle' })
      },
      onLevel: (level, source) => this.onLevel(level, source),
    })
    this.pendingInfo = null
    this.state = 'idle'
  }

  setState(state) { this.state = state; this.onState(state) }

  send(value) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(value))
  }

  async connect() {
    if (this.ws) return
    const Socket = globalThis.WebSocket
    if (!Socket) throw new Error('当前环境不支持 WebSocket')
    this.setState('connecting')
    const ws = new Socket(buildMossSessionUrl({ port: this.port, token: this.token }))
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => this.send({ action: 'attach_session' })
    ws.onmessage = event => typeof event.data === 'string' ? this.handleJson(event.data) : this.handleBinary(event.data)
    ws.onerror = () => this.setState('error')
    ws.onclose = () => { this.ws = null; if (this.state !== 'stopped') this.setState('closed') }
  }

  handleJson(raw) {
    let message
    try { message = JSON.parse(raw) } catch { return }
    const action = message.action
    const data = message.data ?? {}
    this.onEvent({ type: action, data })
    const transcript = transcriptEvent(action, data)
    if (transcript.kind) this.onTranscript(transcript)
    if (action === 'session_attached') {
      this.setState('attached')
      this.send(mossSessionUpdatePayload(this.config))
    } else if (action === 'session.updated') {
      if (data.error) { this.setState('error'); return }
      this.send({ action: 'media.mode', binary_protocol: 'tagged-v1' })
      this.setState('ready')
    } else if (action === 'input.speech.started') this.setState('listening')
    else if (action === 'input.speech.stopped') this.setState('thinking')
    else if (action === 'response.audio.started') this.setState('speaking')
    else if (action === 'response.audio.context') this.pendingInfo = { chunkId: data.chunk_id, runId: data.run_id, turnId: data.turn_id }
    else if (action === 'response.audio.stop') {
      const stopped = this.player.stop()
      const info = stopped.info
      this.send({ action: 'playback.stopped', run_id: data.run_id ?? info?.runId, turn_id: data.turn_id ?? info?.turnId, played_audio_ms: Math.round(stopped.playedMs) })
      this.setState('listening')
    } else if (action === 'response.ended') {
      if (this.player.items.size === 0) this.setState('ready')
      else this.setState('speaking')
    }
    else if (action === 'error' && !data.local) this.setState('error')
  }

  handleBinary(buffer) {
    const info = this.pendingInfo
    this.pendingInfo = null
    this.player.enqueue(buffer, info)
  }

  playbackChunkDone(item) {
    if (!item.info) return
    const info = item.info
    this.send({ action: 'playback.chunk.completed', chunk_id: info.chunkId, run_id: info.runId, turn_id: info.turnId })
  }

  async startMic() {
    if (!this.ws) await this.connect()
    if (this.mic) return
    this.mic = new MossMicCapture({ onFrame: pcm => {
      const bytes = new Uint8Array(1 + pcm.byteLength)
      bytes[0] = 0
      bytes.set(new Uint8Array(pcm.buffer), 1)
      if (this.ws?.readyState === 1) this.ws.send(bytes)
    }, onLevel: level => this.onLevel(level, 'mic') })
    await this.mic.start()
    this.send({ action: 'mic_state', enabled: true })
  }

  setMicEnabled(enabled) {
    this.mic?.setEnabled(enabled)
    this.send({ action: 'mic_state', enabled: Boolean(enabled) })
  }

  async stop() {
    this.setState('stopped')
    await this.mic?.stop?.()
    this.mic = null
    await this.player.close()
    try { this.ws?.close(1000, 'stopped') } catch { /* ignore */ }
    this.ws = null
  }
}
