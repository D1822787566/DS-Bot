import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildMossSessionUrl,
  MossAudioPlayer,
  MossLiveSession,
  mergeTranscriptEvent,
  mossMediaConfigurePayload,
  mossSessionUpdatePayload,
  speakMossGreeting,
  transcriptMarkdown,
  transcriptEvent,
  MossScreenCapture,
} from '../src/client/moss-live.js'

test('MOSS screen capture requests display media and emits JPEG frames', async () => {
  const oldNavigator = globalThis.navigator
  const oldDocument = globalThis.document
  const frames = []
  const streams = []
  let stopped = false
  const track = {
    addEventListener() {},
    stop() { stopped = true },
  }
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  }
  const optionsSeen = []
  const video = { videoWidth: 1920, videoHeight: 1080, play: () => Promise.resolve(), pause() {}, srcObject: null }
  const canvas = {
    getContext: () => ({ drawImage() {} }),
    toBlob: callback => callback({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getDisplayMedia: async options => { optionsSeen.push(options); return stream },
  } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => tag === 'video' ? video : canvas } })
  try {
    const capture = new MossScreenCapture({ onFrame: frame => frames.push([...frame]), onStream: value => streams.push(value), frameIntervalMs: 100_000 })
    await capture.start()
    await capture.stop()
    assert.deepEqual(optionsSeen, [{ video: { frameRate: { ideal: 2, max: 5 }, width: { ideal: 1280, max: 1920 } }, audio: false }])
    assert.deepEqual(frames, [[1, 2, 3]])
    assert.deepEqual(streams, [stream, null])
    assert.equal(stopped, true)
  } finally {
    if (oldNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator })
    if (oldDocument === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument })
  }
})

test('muting before microphone permission resolves disables the late stream and suppresses audio frames', async t => {
  const names = ['navigator', 'AudioContext', 'AudioWorkletNode', 'URL']
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  t.after(() => { for (const [name, value] of saved) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name] } })
  const track = { enabled: true, stop() {} }, sent = []
  let worklet
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } } })
  globalThis.AudioContext = class {
    state = 'running'; audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createGain() { return { gain: {}, connect() {}, disconnect() {} } }
    async close() {}
  }
  globalThis.AudioWorkletNode = class { constructor() { worklet = this } port = {}; connect() {} disconnect() {} }
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} }
  const session = new MossLiveSession()
  session.ws = { readyState: 1, send: value => sent.push(value), close() {} }
  session.mediaReady = true
  session.setMicEnabled(false)
  await session.startMic()
  assert.equal(track.enabled, false)
  worklet.port.onmessage({ data: new Int16Array([100, 100]).buffer })
  assert.equal(sent.filter(value => typeof value !== 'string').length, 0)
  await session.stop()
})

test('stopping while screen selection is pending releases the late display stream', async t => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  t.after(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else delete globalThis.document
  })
  let select
  let stopped = 0
  const streams = []
  const track = { stop() { stopped += 1 }, addEventListener() {} }
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] }
  const video = { play: async () => {}, pause() {} }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getDisplayMedia: () => new Promise(resolve => { select = resolve }),
  } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: name => name === 'video' ? video : {} } })
  const capture = new MossScreenCapture({ onStream: value => streams.push(value) })
  t.after(() => capture.stop())
  const starting = capture.start()
  await capture.stop()
  select(stream)
  await starting
  assert.equal(stopped, 1)
  assert.equal(streams.some(Boolean), false)
  assert.equal(capture.timer, null)
})

test('MOSS Live session starts screen sharing with a screen focus and tags frames', async () => {
  const sent = []
  const streams = []
  class FakeScreenCapture {
    constructor(options) { this.options = options }
    async start() {
      this.options.onStream({ id: 'screen-stream' })
      this.options.onFrame(new Uint8Array([9, 8, 7]))
    }
    async stop() { this.options.onStream(null) }
  }
  const session = new MossLiveSession({
    screenCaptureFactory: options => new FakeScreenCapture(options),
    onScreenStream: stream => streams.push(stream),
  })
  session.ws = { readyState: 1, send: value => sent.push(value) }

  await session.startScreenShare()
  await session.stopScreenShare()

  assert.deepEqual(sent.slice(0, 2), [
    JSON.stringify({ action: 'video.state', source: 'screen', enabled: true }),
    JSON.stringify({ action: 'video.stream_focus', source: 'screen' }),
  ])
  assert.deepEqual([...sent[2]], [0x02, 9, 8, 7])
  assert.deepEqual(sent.at(-1), JSON.stringify({ action: 'video.state', source: 'screen', enabled: false }))
  assert.deepEqual(streams, [{ id: 'screen-stream' }, null])
})

test('MOSS Live media configuration follows the documented standard and low profiles', () => {
  assert.deepEqual(mossMediaConfigurePayload({ mediaProfile: 'standard', videoMaxLongSide: 1024, videoJpegQuality: .72, videoIntervalMs: 1000 }), {
    action: 'media.configure', profile: 'standard', playback: 'client',
    video: { max_long_side: 1024, jpeg_quality: .72, interval_ms: 1000 },
  })
  assert.deepEqual(mossMediaConfigurePayload({ mediaProfile: 'low', videoMaxLongSide: 384, videoJpegQuality: .5, videoIntervalMs: 2000 }), {
    action: 'media.configure', profile: 'low', playback: 'client',
    video: { max_long_side: 384, jpeg_quality: .5, interval_ms: 2000 },
  })
})

test('MOSS Live waits for voice change and media configuration before becoming ready', () => {
  const sent = []
  const session = new MossLiveSession({ config: { voiceName: 'voice-1', mediaProfile: 'low', videoMaxLongSide: 384, videoJpegQuality: .5, videoIntervalMs: 2000 } })
  session.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) }
  session.handleJson(JSON.stringify({ action: 'session_attached', data: {} }))
  assert.deepEqual(sent, [{ action: 'change_voice', voice_name: 'voice-1' }])
  session.handleJson(JSON.stringify({ action: 'voice_changed', data: {} }))
  assert.equal(sent.at(-1).action, 'session.update')
  session.handleJson(JSON.stringify({ action: 'session.updated', data: { error: '' } }))
  assert.deepEqual(sent.slice(-2), [{ action: 'media.mode', binary_protocol: 'tagged-v1' }, { action: 'media.configure', profile: 'low', playback: 'client', video: { max_long_side: 384, jpeg_quality: .5, interval_ms: 2000 } }])
  assert.notEqual(session.state, 'ready')
  session.handleJson(JSON.stringify({ action: 'media.configured', data: { error: '' } }))
  assert.equal(session.state, 'ready')
})

test('MOSS Live interpretation sessions skip conversational session.update', () => {
  const sent = []
  const session = new MossLiveSession({ config: { mode: 'interpret', mediaProfile: 'standard', videoMaxLongSide: 1024, videoJpegQuality: .72, videoIntervalMs: 1000 } })
  session.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) }
  session.handleJson(JSON.stringify({ action: 'session_attached', data: {} }))
  assert.deepEqual(sent, [{ action: 'media.mode', binary_protocol: 'tagged-v1' }, { action: 'media.configure', profile: 'standard', playback: 'client', video: { max_long_side: 1024, jpeg_quality: .72, interval_ms: 1000 } }])
})

test('microphone audio waits until conversational tools and media configuration have succeeded', async t => {
  const saved = new Map(['navigator', 'AudioContext', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  let worklet
  class Context {
    state = 'running'
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createGain() { return { gain: {}, connect() {}, disconnect() {} } }
    async close() {}
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } } })
  globalThis.AudioContext = Context
  globalThis.AudioWorkletNode = class { constructor() { this.port = {}; worklet = this } connect() {} disconnect() {} }
  const sent = []
  const session = new MossLiveSession()
  session.ws = { readyState: 1, send: data => sent.push(data), close() {} }
  t.after(() => session.stop())
  await session.startMic()
  const frame = () => worklet.port.onmessage({ data: new Int16Array([10, 20]).buffer })
  frame()
  assert.equal(sent.filter(value => typeof value !== 'string').length, 0, 'no microphone data may precede tools/media acknowledgement')
  session.handleJson(JSON.stringify({ action: 'session.updated', data: { error: '' } }))
  frame()
  assert.equal(sent.filter(value => typeof value !== 'string').length, 0)
  session.handleJson(JSON.stringify({ action: 'media.configured', data: { error: '' } }))
  frame()
  assert.equal(sent.filter(value => typeof value !== 'string').length, 1)
  assert.equal(sent.filter(value => typeof value !== 'string')[0][0], 0)
})

test('a rejected screen selection never announces an enabled video source', async () => {
  const sent = []
  const session = new MossLiveSession({ screenCaptureFactory: () => ({
    start: async () => { throw new DOMException('Not supported', 'NotSupportedError') },
    stop: async () => {},
  }) })
  session.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) }
  await assert.rejects(session.startScreenShare(), /屏幕共享/)
  assert.equal(sent.some(event => event.action === 'video.state' && event.enabled), false)
  assert.equal(session.screen, null)
})

test('video state stays disabled while the screen chooser is open', async () => {
  const sent = []
  let captureOptions
  let chosen
  const session = new MossLiveSession({ screenCaptureFactory: options => {
    captureOptions = options
    return { start: () => new Promise(resolve => { chosen = resolve }), stop: async () => {} }
  } })
  session.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) }
  const starting = session.startScreenShare()
  assert.deepEqual(sent, [])
  captureOptions.onStream({ id: 'selected-screen' })
  chosen()
  await starting
  assert.deepEqual(sent.map(event => event.action), ['video.state', 'video.stream_focus'])
  await session.stopScreenShare()
})

test('closing the MOSS socket releases the screen and clears its preview', async t => {
  const previous = globalThis.WebSocket
  t.after(() => { globalThis.WebSocket = previous })
  globalThis.WebSocket = class { readyState = 1; send() {} }
  let stopped = 0
  const streams = []
  const session = new MossLiveSession({
    screenCaptureFactory: options => ({
      start: async () => { options.onStream({ id: 'screen' }) },
      stop: async () => { stopped += 1; options.onStream(null) },
    }),
    onScreenStream: stream => streams.push(stream),
  })
  await session.connect()
  await session.startScreenShare()
  session.ws.onclose()
  await Promise.resolve()
  assert.equal(stopped, 1)
  assert.equal(streams.at(-1), null)
  assert.equal(session.screen, null)
})

test('MOSS Live client URL carries only the host-issued session token', () => {
  assert.equal(
    buildMossSessionUrl({ port: 4312, token: 'token value' }),
    'ws://127.0.0.1:4312/?token=token%20value',
  )
})

test('MOSS Live client session update contains the configurable persona fields', () => {
  assert.deepEqual(mossSessionUpdatePayload({
    personaName: 'Luna',
    personaAliases: ['露娜'],
    personaPrompt: '自然回答。',
    instructions: '使用中文。',
  }), {
    action: 'session.update',
    session: {
      persona: { name: 'Luna', aliases: ['露娜'], prompt: '自然回答。' },
      instructions: '使用中文。',
    },
  })
})

test('MOSS Live transcript events preserve the event kind and text', () => {
  assert.deepEqual(transcriptEvent('input.transcript.done', { text: '你好' }), { kind: 'user', done: true, text: '你好' })
  assert.deepEqual(transcriptEvent('output.transcript.updated', { text: '你好，我是 Luna' }), { kind: 'assistant', done: false, text: '你好，我是 Luna' })
  assert.equal(transcriptEvent('session.updated', {}).kind, undefined)
})

test('a final input with a provider turn id completes its unlabelled partial in place', () => {
  let items = mergeTranscriptEvent([], transcriptEvent('input.transcript.updated', { text: '查一下华子' }))
  items = mergeTranscriptEvent(items, transcriptEvent('input.transcript.done', { turn: '1', text: '查一下华子的记录。' }))
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'turn:1')
  assert.equal(items[0].done, true)
})

test('assistant transcripts use both reply identifiers and input revisions update finalized rows', () => {
  let items = mergeTranscriptEvent([], transcriptEvent('output.transcript.done', { run_id: 'shared-run', turn_id: '1', text: '第一轮答复' }))
  items = mergeTranscriptEvent(items, transcriptEvent('output.transcript.done', { run_id: 'shared-run', turn_id: '2', text: '第二轮答复' }))
  assert.deepEqual(items.map(item => item.text), ['第一轮答复', '第二轮答复'])
  items = mergeTranscriptEvent(items, transcriptEvent('input.transcript.done', { turn: '3', text: '才子的天气' }))
  items = mergeTranscriptEvent(items, transcriptEvent('input.transcript.revised', { turn: '3', previous: '才子的天气', text: '华子的天气' }))
  assert.equal(items.length, 3)
  assert.equal(items[2].text, '华子的天气')
})

test('playback completion waits for audio.done and actual local playback, once per reply', () => {
  const session = new MossLiveSession()
  const sent = []
  session.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) }
  const item = { info: { runId: 'r1', turnId: 't1', chunkId: 'c1' } }
  session.player.items.add(item)
  session.handleJson(JSON.stringify({ action: 'response.audio.done', data: { run_id: 'r1', turn_id: 't1' } }))
  assert.equal(sent.length, 0)
  session.player.items.delete(item)
  session.playbackChunkDone(item)
  session.player.onDrain()
  assert.deepEqual(sent, [
    { action: 'playback.chunk.completed', chunk_id: 'c1', run_id: 'r1', turn_id: 't1' },
    { action: 'playback.completed', run_id: 'r1', turn_id: 't1' },
  ])
  session.handleJson(JSON.stringify({ action: 'response.audio.done', data: { run_id: 'r1', turn_id: 't1' } }))
  session.player.onDrain()
  assert.equal(sent.length, 2)
  session.handleJson(JSON.stringify({ action: 'response.audio.done', data: { run_id: 'r2', turn_id: 't2' } }))
  assert.deepEqual(sent.at(-1), { action: 'playback.completed', run_id: 'r2', turn_id: 't2' })
})

test('recoverable MOSS request errors leave a ready voice session available', () => {
  const session = new MossLiveSession()
  session.state = 'ready'; session.mediaReady = true
  session.handleJson(JSON.stringify({ action: 'error', data: { error: { code: 'invalid_public_request', message: 'invalid or unsupported request' } } }))
  assert.equal(session.state, 'ready')
  assert.equal(session.mediaReady, true)
})

test('an early audio stop without reply identifiers never sends an invalid playback receipt', () => {
  const session = new MossLiveSession()
  const sent = []
  session.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) }
  session.handleJson(JSON.stringify({ action: 'response.audio.stop', data: { reason: 'interrupted-before-audio' } }))
  assert.equal(sent.length, 0)
})

test('socket closure releases the microphone and playback instead of retaining an orphan capture', async t => {
  const previous = globalThis.WebSocket
  t.after(() => { globalThis.WebSocket = previous })
  globalThis.WebSocket = class { readyState = 1; send() {} close() {} }
  const session = new MossLiveSession()
  await session.connect()
  let micStopped = 0, playerClosed = 0
  session.mic = { stop: async () => { micStopped++ } }
  session.player = { close: async () => { playerClosed++ } }
  session.ws.onclose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(micStopped, 1)
  assert.equal(playerClosed, 1)
  assert.equal(session.mic, null)
  assert.equal(session.ws, null)
})

test('MOSS Live transcript updates replace partial text and export readable Markdown', () => {
  let items = mergeTranscriptEvent([], { kind: 'user', done: false, text: '你好' })
  items = mergeTranscriptEvent(items, { kind: 'user', done: false, text: '你好，我是' })
  items = mergeTranscriptEvent(items, { kind: 'user', done: true, text: '你好，我是小明' })
  items = mergeTranscriptEvent(items, { kind: 'assistant', done: true, text: '你好，小明。', at: '2026-11-09T00:00:00.000Z' })
  assert.deepEqual(items.map(item => item.text), ['你好，我是小明', '你好，小明。'])
  assert.match(transcriptMarkdown(items, { personaName: 'Luna' }), /Luna/)
  assert.match(transcriptMarkdown(items, { personaName: 'Luna' }), /你：你好，我是小明/)
  assert.match(transcriptMarkdown(items, { personaName: 'Luna' }), /MOSS：你好，小明。/)
})

test('MOSS Live opening greeting uses the browser speech synthesis when available', async () => {
  const calls = []
  class FakeUtterance {
    constructor(text) { this.text = text }
  }
  const result = await speakMossGreeting('你好', {
    SpeechSynthesisUtterance: FakeUtterance,
    speechSynthesis: {
      cancel() { calls.push('cancel') },
      speak(utterance) { calls.push(utterance.text); queueMicrotask(() => utterance.onend()) },
    },
  })
  assert.equal(result, true)
  assert.deepEqual(calls, ['cancel', '你好'])
})

test('a new transcript turn cannot overwrite another unfinished turn', () => {
  const first = { kind: 'user', id: 'turn:1', done: false, text: '第一句', at: '2026-11-09T00:00:00.000Z' }
  const second = { kind: 'user', id: 'turn:2', done: false, text: '第二句', at: '2026-11-09T00:00:01.000Z' }
  let items = mergeTranscriptEvent([first], second)
  items = mergeTranscriptEvent(items, { ...first, done: true, text: '第一句话', at: '2026-11-09T00:00:02.000Z' })
  assert.equal(items.length, 2)
  assert.equal(items[0].at, first.at)
  assert.deepEqual(items.map(item => item.text), ['第一句话', '第二句'])
  assert.deepEqual(mergeTranscriptEvent(items, { ...first, text: '第一' }), items, 'late partials cannot replace a final transcript')
})

test('an interrupted answer exports the text that was actually spoken once', () => {
  let items = mergeTranscriptEvent([], { kind: 'assistant', id: 'run:r1', text: '第一步，第二步，第三步。', done: true })
  items = mergeTranscriptEvent(items, transcriptEvent('response.interrupted', { run_id: 'r1', text: '第一步，' }))
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '第一步，')
  assert.equal(items[0].interrupted, true)
  const exported = transcriptMarkdown(items)
  assert.match(exported, /被打断/)
  assert.doesNotMatch(exported, /第二步/)
})

test('cancelling the opening greeting settles immediately without resuming speech', async () => {
  const controller = new AbortController()
  let cancelled = 0
  const result = await speakMossGreeting('你好', {
    signal: controller.signal,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    speechSynthesis: {
      cancel() { cancelled += 1 },
      speak(utterance) { controller.abort(); utterance.onend() },
    },
  })
  assert.equal(result, false)
  assert.ok(cancelled >= 1)
})

test('the speaking state follows queued playback after upstream generation ends', async () => {
  const session = new MossLiveSession()
  session.player.items.add({ source: { stop() {} }, startAt: 0, endAt: 1 })
  session.handleJson(JSON.stringify({ action: 'response.audio.started', data: {} }))
  session.handleJson(JSON.stringify({ action: 'response.ended', data: { status: 'completed' } }))
  assert.equal(session.state, 'speaking')
  session.player.items.clear()
  session.player.onDrain()
  assert.equal(session.state, 'ready')
  await session.stop()
})

test('MOSS Live audio player resumes a suspended browser context before playback', async () => {
  class FakeContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.resumeCount = 0 }
    resume() { this.resumeCount += 1; this.state = 'running'; return Promise.resolve() }
    createGain() { return { gain: { value: 1 }, connect() {} } }
    createAnalyser() { return { fftSize: 0, connect() {}, getByteTimeDomainData() {} } }
    createBuffer(_, length) { return { duration: length / 48000, getChannelData: () => new Float32Array(length) } }
    createBufferSource() { return { connect() {}, start() {}, stop() {} } }
    close() { return Promise.resolve() }
  }
  const player = new MossAudioPlayer({ contextFactory: () => new FakeContext() })
  player.enqueue(new Int16Array([0, 0]).buffer, null)
  await Promise.resolve()
  assert.equal(player.ctx.resumeCount, 1)
  await player.close()
})
