import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LocalVoiceLoop } from '../src/host/voice-loop.js'

function audioStream(chunks, state) {
  return {
    requestId: state.requestId,
    cancel() { state.cancelled = true; return true },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (state.cancelled) return
        yield chunk
      }
    },
  }
}

test('Local Voice loop sends each LLM segment to TTS as soon as it arrives', async () => {
  const calls = []
  const runtime = {
    synthesize(text, options) {
      const state = { requestId: `tts-${calls.length}`, cancelled: false }
      calls.push({ text, options, state })
      return audioStream([new Uint8Array([1, 0])], state)
    },
  }
  const played = []
  const loop = new LocalVoiceLoop({
    runtime,
    ask: async function* () {
      yield { text: '第一段' }
      yield { text: '第二段' }
    },
    play: async (stream, meta) => {
      let bytes = 0
      for await (const chunk of stream) bytes += chunk.byteLength
      played.push({ text: meta.text, bytes })
    },
  })

  await loop.submitTranscript('用户问题', { voice: 'ZH' })
  assert.deepEqual(calls.map(call => call.text), ['第一段', '第二段'])
  assert.deepEqual(played, [{ text: '第一段', bytes: 2 }, { text: '第二段', bytes: 2 }])
  assert.equal(loop.view().state, 'listening')
})

test('Local Voice loop starts TTS for the next segment while the previous segment plays', async () => {
  const calls = []
  let finishFirst
  const firstPlayback = new Promise(resolve => { finishFirst = resolve })
  const runtime = {
    synthesize(text) {
      calls.push(text)
      return audioStream([], { cancelled: false })
    },
  }
  const loop = new LocalVoiceLoop({
    runtime,
    ask: async function* () {
      yield { text: '第一段' }
      yield { text: '第二段' }
    },
    play: async (_stream, meta) => {
      if (meta.text === '第一段') await firstPlayback
    },
  })
  const pending = loop.submitTranscript('用户问题')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, ['第一段', '第二段'])
  finishFirst()
  await pending
})

test('Local Voice loop cancels current audio and ignores late segments after interruption', async () => {
  const first = { requestId: 'tts-1', cancelled: false }
  let release
  const gate = new Promise(resolve => { release = resolve })
  let finishPlayback
  const playbackGate = new Promise(resolve => { finishPlayback = resolve })
  const calls = []
  const runtime = {
    synthesize(text) {
      calls.push(text)
      return text === '第一段' ? audioStream([new Uint8Array([1, 0])], first) : audioStream([], { cancelled: false })
    },
  }
  const played = []
  const loop = new LocalVoiceLoop({
    runtime,
    ask: async function* () {
      yield { text: '第一段' }
      await gate
      yield { text: '迟到段' }
    },
    play: async (stream, meta) => {
      for await (const _chunk of stream) {}
      played.push(meta.text)
      await playbackGate
    },
  })
  const pending = loop.submitTranscript('用户问题')
  await new Promise(resolve => setTimeout(resolve, 0))
  loop.interrupt()
  finishPlayback()
  release()
  await pending
  assert.equal(first.cancelled, true)
  assert.deepEqual(calls, ['第一段'])
  assert.deepEqual(played, ['第一段'])
  assert.equal(loop.view().state, 'listening')
})
