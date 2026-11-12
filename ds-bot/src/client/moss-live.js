const SAMPLE_RATE = 48_000
const TARGET_RATE = 16_000
const FRAME_SAMPLES = 320
const SCREEN_FRAME_TAG = 0x02
const SCREEN_FRAME_INTERVAL_MS = 1000
const SCREEN_MAX_WIDTH = 1280
const SCREEN_MAX_FRAME_BYTES = 512 * 1024
const SCREEN_JPEG_QUALITY = 0.72

function tagScreenFrame(frame) {
  const payload = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  const tagged = new Uint8Array(payload.byteLength + 1)
  tagged[0] = SCREEN_FRAME_TAG
  tagged.set(payload, 1)
  return tagged
}

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

export function mossMediaConfigurePayload(config = {}) {
  return {
    action: 'media.configure',
    profile: config.mediaProfile === 'low' ? 'low' : 'standard',
    playback: 'client',
    video: {
      max_long_side: Number.isInteger(config.videoMaxLongSide) ? config.videoMaxLongSide : 1024,
      jpeg_quality: typeof config.videoJpegQuality === 'number' ? config.videoJpegQuality : 0.72,
      interval_ms: Number.isInteger(config.videoIntervalMs) ? config.videoIntervalMs : 1000,
    },
  }
}

function replyKey(runId, turnId) {
  return typeof runId === 'string' && runId && typeof turnId === 'string' && turnId ? JSON.stringify([runId, turnId]) : null
}

function transcriptReplyId(data) {
  const key = replyKey(data.run_id, data.turn_id)
  return key ? { id: `reply:${key}` } : data.run_id === undefined ? {} : { id: `run:${String(data.run_id)}` }
}

export function transcriptEvent(action, data = {}) {
  if (action === 'input.transcript.updated' || action === 'input.transcript.done' || action === 'input.transcript.revised') return {
    kind: 'user', done: action !== 'input.transcript.updated', text: String(data.text ?? ''),
    ...(action === 'input.transcript.revised' ? { revised: true } : {}),
    ...(data.turn === undefined ? {} : { id: `turn:${String(data.turn)}` }),
  }
  if (action === 'output.transcript.updated' || action === 'output.transcript.done') return {
    kind: 'assistant', done: action.endsWith('.done'), text: String(data.text ?? ''),
    ...transcriptReplyId(data),
  }
  if (action === 'response.interrupted') return {
    kind: 'assistant', done: true, interrupted: true, text: String(data.text ?? ''),
    ...transcriptReplyId(data),
  }
  return { kind: undefined, done: false, text: '' }
}

export function mergeTranscriptEvent(items = [], next) {
  if (!next?.kind || !String(next.text ?? '').trim()) return items
  const value = { ...next, text: String(next.text), at: next.at ?? new Date().toISOString() }
  let index = -1
  if (value.id) index = items.findLastIndex?.(item => item.id === value.id) ?? [...items].map(item => item.id).lastIndexOf(value.id)
  if (index < 0) {
    for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
      if (items[cursor].kind === value.kind && items[cursor].done !== true && (!value.id || !items[cursor].id)) { index = cursor; break }
      if (!value.id && items[cursor].kind !== value.kind) break
    }
  }
  if (index >= 0 && items[index].done === true && value.done !== true) return items
  if (index < 0) return [...items, value]
  if (items[index].done === true && value.interrupted !== true && value.revised !== true && next.done === true) return items
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
    this.setEnabled(this.enabled)
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

export class MossScreenCapture {
  constructor({ onFrame, onStream, onStopped, frameIntervalMs = SCREEN_FRAME_INTERVAL_MS, maxWidth = SCREEN_MAX_WIDTH, jpegQuality = SCREEN_JPEG_QUALITY } = {}) {
    this.onFrame = onFrame ?? (() => {})
    this.onStream = onStream ?? (() => {})
    this.onStopped = onStopped ?? (() => {})
    this.frameIntervalMs = frameIntervalMs
    this.maxWidth = maxWidth
    this.jpegQuality = jpegQuality
    this.stream = null
    this.video = null
    this.canvas = null
    this.timer = null
    this.capturing = false
    this.ended = false
    this.handleEnded = () => {
      if (this.ended) return
      this.ended = true
      this.onStopped()
      void this.stop()
    }
  }

  async start() {
    if (this.stream) return this.stream
    this.ended = false
    const getDisplayMedia = globalThis.navigator?.mediaDevices?.getDisplayMedia
    if (typeof getDisplayMedia !== 'function') throw new Error('当前环境不支持屏幕共享')
    const documentRef = globalThis.document
    const video = documentRef?.createElement?.('video')
    const canvas = documentRef?.createElement?.('canvas')
    if (!video || !canvas) throw new Error('当前环境不支持屏幕采集')
    const stream = await getDisplayMedia.call(globalThis.navigator.mediaDevices, {
      video: { frameRate: { ideal: 2, max: 5 }, width: { ideal: this.maxWidth, max: 1920 } },
      audio: false,
    })
    if (this.ended) {
      for (const track of stream.getTracks()) track.stop()
      return null
    }
    this.stream = stream
    this.video = video
    this.canvas = canvas
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    const track = stream.getVideoTracks?.()[0]
    track?.addEventListener?.('ended', this.handleEnded)
    if (track) track.onended = this.handleEnded
    await video.play?.()
    if (this.ended || this.stream !== stream) return null
    this.onStream(stream)
    await this.captureFrame()
    if (!this.ended) this.timer = globalThis.setInterval?.(() => { void this.captureFrame().catch(() => this.handleEnded()) }, this.frameIntervalMs) ?? null
    return stream
  }

  async captureFrame() {
    if (!this.stream || !this.video || !this.canvas || this.capturing) return
    const width = Number(this.video.videoWidth) || 0
    const height = Number(this.video.videoHeight) || 0
    if (!width || !height) return
    const scale = Math.min(1, this.maxWidth / width)
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))
    this.canvas.width = targetWidth
    this.canvas.height = targetHeight
    const context = this.canvas.getContext?.('2d')
    if (!context || typeof this.canvas.toBlob !== 'function') return
    this.capturing = true
    try {
      context.drawImage(this.video, 0, 0, targetWidth, targetHeight)
      const blob = await new Promise(resolve => this.canvas.toBlob(resolve, 'image/jpeg', this.jpegQuality))
      if (!this.stream || this.ended || !blob || blob.size <= 0 || blob.size > SCREEN_MAX_FRAME_BYTES) return
      const frame = new Uint8Array(await blob.arrayBuffer())
      if (!this.stream || this.ended) return
      this.onFrame(frame)
    } finally {
      this.capturing = false
    }
  }

  async stop() {
    this.ended = true
    if (!this.stream && !this.video && !this.canvas) return
    if (this.timer !== null) globalThis.clearInterval?.(this.timer)
    this.timer = null
    const stream = this.stream
    this.stream = null
    this.video?.pause?.()
    if (this.video) this.video.srcObject = null
    for (const track of stream?.getTracks?.() ?? []) track.stop()
    this.video = null
    this.canvas = null
    this.capturing = false
    this.onStream(null)
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
  constructor({ port, token, config, onState, onTranscript, onEvent, onLevel, onScreenStream, screenCaptureFactory } = {}) {
    this.port = port
    this.token = token
    this.config = config ?? {}
    this.onState = onState ?? (() => {})
    this.onTranscript = onTranscript ?? (() => {})
    this.onEvent = onEvent ?? (() => {})
    this.onLevel = onLevel ?? (() => {})
    this.onScreenStream = onScreenStream ?? (() => {})
    this.screenCaptureFactory = screenCaptureFactory ?? (options => new MossScreenCapture(options))
    this.ws = null
    this.mic = null
    this.screen = null
    this.micEnabled = true
    this.player = new MossAudioPlayer({
      onChunkDone: item => this.playbackChunkDone(item),
      onDrain: () => {
        this.completePlayback()
        if (this.state === 'speaking') this.setState('ready')
        this.onEvent({ type: 'ui.playback_idle' })
      },
      onLevel: (level, source) => this.onLevel(level, source),
    })
    this.pendingInfo = null
    this.voiceChangePending = false
    this.mediaConfigurationPending = false
    this.mediaReady = false
    this.playbackReplies = new Map()
    this.closePromise = null
    this.state = 'idle'
  }

  setState(state) { this.state = state; this.onState(state) }

  send(value) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(value))
  }

  sendBinary(value) {
    if (this.ws?.readyState === 1) this.ws.send(value)
  }

  async connect() {
    if (this.ws) return
    if (this.closePromise) { await this.closePromise; this.closePromise = null }
    const Socket = globalThis.WebSocket
    if (!Socket) throw new Error('当前环境不支持 WebSocket')
    this.setState('connecting')
    const ws = new Socket(buildMossSessionUrl({ port: this.port, token: this.token }))
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => { if (this.ws === ws) this.send({ action: 'attach_session' }) }
    ws.onmessage = event => {
      if (this.ws !== ws) return
      if (typeof event.data === 'string') this.handleJson(event.data)
      else this.handleBinary(event.data)
    }
    ws.onerror = () => { if (this.ws === ws) void this.endConnection('error') }
    ws.onclose = () => { if (this.ws === ws) void this.endConnection('closed') }
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
      if (this.config.mode === 'interpret') {
        this.sendMediaConfiguration()
      } else if (String(this.config.voiceName ?? '').trim()) {
        this.voiceChangePending = true
        this.send({ action: 'change_voice', voice_name: String(this.config.voiceName).trim() })
      } else {
        this.sendSessionUpdate()
      }
    } else if (action === 'voice_changed') {
      if (this.voiceChangePending) {
        this.voiceChangePending = false
        this.sendSessionUpdate()
      }
    } else if (action === 'session.updated') {
      if (data.error) { void this.endConnection('error'); return }
      this.sendMediaConfiguration()
    } else if (action === 'media.configured') {
      if (data.error) { void this.endConnection('error'); return }
      this.mediaConfigurationPending = false
      this.mediaReady = true
      if (this.mic) this.send({ action: 'mic_state', enabled: this.mic.enabled !== false })
      this.setState('ready')
    } else if (action === 'input.speech.started') this.setState('listening')
    else if (action === 'input.speech.stopped') this.setState('thinking')
    else if (action === 'response.audio.started') this.setState('speaking')
    else if (action === 'response.audio.context') this.pendingInfo = { chunkId: data.chunk_id, runId: data.run_id, turnId: data.turn_id }
    else if (action === 'response.audio.done') {
      const key = replyKey(data.run_id, data.turn_id)
      if (key) {
        this.playbackReplies.set(key, { ...this.playbackReplies.get(key), runId: data.run_id, turnId: data.turn_id, audioDone: true })
        this.completePlayback()
      }
    }
    else if (action === 'response.audio.stop') {
      for (const reply of this.playbackReplies.values()) reply.cancelled = true
      const stopped = this.player.stop()
      const info = stopped.info
      const runId = data.run_id ?? info?.runId, turnId = data.turn_id ?? info?.turnId
      const key = replyKey(runId, turnId)
      if (key) {
        this.playbackReplies.set(key, { runId, turnId, cancelled: true })
        this.send({ action: 'playback.stopped', run_id: runId, turn_id: turnId, played_audio_ms: Math.round(stopped.playedMs) })
      }
      this.setState('listening')
    } else if (action === 'response.ended') {
      if (this.player.items.size === 0) this.setState('ready')
      else this.setState('speaking')
    }
    else if (action === 'error' && (data.fatal === true || data.error?.fatal === true || ['session_expired', 'session_closed', 'unauthorized', 'invalid_api_key'].includes(data.error?.code))) void this.endConnection('error')
  }

  sendSessionUpdate() {
    this.send(mossSessionUpdatePayload(this.config))
  }

  sendMediaConfiguration() {
    if (this.mediaConfigurationPending) return
    this.mediaConfigurationPending = true
    this.send({ action: 'media.mode', binary_protocol: 'tagged-v1' })
    this.send(mossMediaConfigurePayload(this.config))
  }

  handleBinary(buffer) {
    if (this.closePromise) return
    const info = this.pendingInfo
    this.pendingInfo = null
    this.player.enqueue(buffer, info)
  }

  playbackChunkDone(item) {
    if (!item.info) return
    const info = item.info
    if (!replyKey(info.runId, info.turnId) || typeof info.chunkId !== 'string' || !info.chunkId) return
    this.send({ action: 'playback.chunk.completed', chunk_id: info.chunkId, run_id: info.runId, turn_id: info.turnId })
    this.completePlayback()
  }

  completePlayback() {
    for (const reply of this.playbackReplies.values()) {
      if (!reply.audioDone || reply.completed || reply.cancelled) continue
      if ([...this.player.items].some(item => item.info?.runId === reply.runId && item.info?.turnId === reply.turnId)) continue
      reply.completed = true
      this.send({ action: 'playback.completed', run_id: reply.runId, turn_id: reply.turnId })
    }
  }

  async startMic() {
    if (!this.ws) await this.connect()
    if (this.mic) return
    const capture = new MossMicCapture({ onFrame: pcm => {
      if (!this.mediaReady) return
      const bytes = new Uint8Array(1 + pcm.byteLength)
      bytes[0] = 0
      bytes.set(new Uint8Array(pcm.buffer), 1)
      if (this.ws?.readyState === 1) this.ws.send(bytes)
    }, onLevel: level => this.onLevel(level, 'mic') })
    this.mic = capture
    capture.setEnabled(this.micEnabled)
    try { await capture.start() } catch (error) { await capture.stop(); if (this.mic === capture) this.mic = null; throw error }
    if (this.mic !== capture || !this.ws) { await capture.stop(); return }
    if (this.mediaReady) this.send({ action: 'mic_state', enabled: capture.enabled !== false })
  }

  setMicEnabled(enabled) {
    this.micEnabled = Boolean(enabled)
    this.mic?.setEnabled(enabled)
    if (this.mediaReady) this.send({ action: 'mic_state', enabled: Boolean(enabled) })
  }

  async startScreenShare() {
    if (this.ws?.readyState !== 1) throw new Error('请先连接 MOSS Live，再开启屏幕共享。')
    if (this.screen) return
    let capture
    capture = this.screenCaptureFactory({
      frameIntervalMs: Number.isInteger(this.config.videoIntervalMs) ? this.config.videoIntervalMs : SCREEN_FRAME_INTERVAL_MS,
      maxWidth: Number.isInteger(this.config.videoMaxLongSide) ? this.config.videoMaxLongSide : SCREEN_MAX_WIDTH,
      jpegQuality: typeof this.config.videoJpegQuality === 'number' ? this.config.videoJpegQuality : SCREEN_JPEG_QUALITY,
      onFrame: frame => { if (this.screen === capture) this.sendBinary(tagScreenFrame(frame)) },
      onStream: stream => {
        if (this.screen !== capture) return
        if (stream) {
          this.send({ action: 'video.state', source: 'screen', enabled: true })
          this.send({ action: 'video.stream_focus', source: 'screen' })
        }
        this.onScreenStream(stream)
      },
      onStopped: () => {
        if (this.screen !== capture) return
        this.screen = null
        this.send({ action: 'video.state', source: 'screen', enabled: false })
        this.onScreenStream(null)
      },
    })
    this.screen = capture
    try {
      await capture.start()
      return this.screen === capture
    } catch (error) {
      try { await capture.stop?.() } catch { /* ignore screen cleanup failure */ }
      if (this.screen === capture) {
        this.screen = null
        this.send({ action: 'video.state', source: 'screen', enabled: false })
        this.onScreenStream(null)
      }
      const message = error?.name === 'NotSupportedError' ? '当前桌面环境不支持屏幕共享，请重启最新版 DS Bot 后重试。'
        : error?.name === 'NotAllowedError' || error?.name === 'AbortError' ? '屏幕共享已取消或未获授权，请重新点击「共享屏幕」。'
          : error?.message || '屏幕共享失败，请重试。'
      throw new Error(message, { cause: error })
    }
  }

  async stopScreenShare() {
    const capture = this.screen
    this.screen = null
    if (!capture) return
    try { await capture.stop?.() }
    finally {
      this.send({ action: 'video.state', source: 'screen', enabled: false })
      this.onScreenStream(null)
    }
  }

  endConnection(state) {
    this.setState(state)
    if (this.closePromise) return this.closePromise
    this.mediaReady = false
    this.mediaConfigurationPending = false
    this.voiceChangePending = false
    this.pendingInfo = null
    this.playbackReplies.clear()
    const socket = this.ws
    this.ws = null
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null
      try { socket.close?.(1000, 'stopped') } catch { /* ignore */ }
    }
    const mic = this.mic
    this.mic = null
    this.closePromise = Promise.allSettled([this.stopScreenShare(), mic?.stop?.(), this.player.close()]).then(() => {})
    return this.closePromise
  }

  async stop() { await this.endConnection('stopped') }
}
