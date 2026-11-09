import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildMossSessionUrl,
  MossAudioPlayer,
  MossLiveSession,
  mergeTranscriptEvent,
  mossSessionUpdatePayload,
  speakMossGreeting,
  transcriptMarkdown,
  transcriptEvent,
} from '../src/client/moss-live.js'

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
