import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildMossSessionUrl,
  MossAudioPlayer,
  mossSessionUpdatePayload,
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
