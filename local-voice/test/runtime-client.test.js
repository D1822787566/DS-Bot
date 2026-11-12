import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  LocalVoiceRuntimeClient,
  createLocalVoiceRuntimeFactory,
  localVoiceEnvironmentRoot,
  localVoiceModelRoot,
} from '../src/host/runtime-client.js'

const wait = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('test timeout')), 500))])

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdin = { writes: [], write: value => { this.stdin.writes.push(value); return true }, end: () => {} }
    this.killed = false
  }

  kill() { this.killed = true; this.emit('exit', 0, null) }

  emitLine(value) { this.stdout.emit('data', `${JSON.stringify(value)}\n`) }
}

test('runtime client waits for ready and serves final transcription', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child, command: 'python', args: ['main.py'] })
  const started = client.start()
  child.emitLine({ type: 'ready', asr: true, tts: true })
  await wait(started)
  const request = client.transcribe(new Uint8Array([1, 2, 3]).buffer)
  await Promise.resolve()
  const message = JSON.parse(child.stdin.writes.at(-1))
  assert.equal(message.type, 'transcribe')
  child.emitLine({ type: 'transcript', request_id: message.request_id, text: '你好' })
  assert.equal(await wait(request), '你好')
})

test('runtime client streams PCM chunks and cancels a request', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child, command: 'python', args: ['main.py'] })
  const started = client.start()
  child.emitLine({ type: 'ready', asr: true, tts: true })
  await wait(started)
  const stream = client.synthesize('你好')
  assert.match(stream.requestId, /^[0-9a-f-]{36}$/)
  await Promise.resolve()
  const message = JSON.parse(child.stdin.writes.at(-1))
  const chunks = []
  const read = (async () => { for await (const chunk of stream) chunks.push(chunk) })()
  child.emitLine({ type: 'audio', request_id: message.request_id, data: 'AQACAA==' })
  child.emitLine({ type: 'complete', request_id: message.request_id })
  await wait(read)
  assert.deepEqual([...chunks[0]], [1, 0, 2, 0])
  await client.stop()
  assert.equal(child.killed, true)
})

test('runtime client closes a synthesis stream when runtime confirms cancellation', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child, command: 'python', args: ['main.py'] })
  const started = client.start()
  child.emitLine({ type: 'ready', asr: true, tts: true, prewarmed: true })
  await wait(started)
  const stream = client.synthesize('你好')
  await Promise.resolve()
  const message = JSON.parse(child.stdin.writes.at(-1))
  assert.equal(stream.cancel(), true)
  const cancel = JSON.parse(child.stdin.writes.at(-1))
  assert.equal(cancel.type, 'cancel')
  assert.equal(cancel.request_id, message.request_id)
  const read = (async () => { for await (const _chunk of stream) {} })()
  child.emitLine({ type: 'cancelled', request_id: message.request_id })
  await wait(read)
  await client.stop()
})

test('runtime client remembers cancellation requested before runtime startup finishes', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child, command: 'python', args: ['main.py'] })
  const stream = client.synthesize('你好')
  assert.equal(stream.cancel(), true)
  const read = (async () => { for await (const _chunk of stream) {} })()
  const started = client.start()
  child.emitLine({ type: 'ready', asr: true, tts: true })
  await wait(started)
  await wait(read)
  assert.equal(JSON.parse(child.stdin.writes.at(-1)).type, 'hello')
  await client.stop()
})

test('runtime client rejects pending calls when the child exits', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child, command: 'python', args: ['main.py'] })
  const started = client.start()
  child.emitLine({ type: 'ready', asr: true, tts: true })
  await wait(started)
  const request = client.transcribe(new ArrayBuffer(0))
  await Promise.resolve()
  child.emit('exit', 1, null)
  await assert.rejects(wait(request), /runtime exited/)
})

test('runtime client rejects startup when the runtime reports missing models', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child, command: 'python', args: ['main.py'] })
  const started = client.start()
  child.emitLine({ type: 'error', code: 'runtime_not_ready', message: 'MeloTTS dependency is missing' })
  await assert.rejects(wait(started), /MeloTTS dependency is missing/)
})

test('runtime factory selects the isolated local voice environment and model roots', async () => {
  const factory = createLocalVoiceRuntimeFactory({
    spawn: () => new FakeChild(),
    runtimeMain: 'runtime/main.py',
    env: {},
  })
  const client = await factory()
  assert.equal(client.command, join(localVoiceEnvironmentRoot(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
  assert.equal(client.env.LOCAL_VOICE_ASR_MODEL_DIR, join(localVoiceModelRoot(), 'paraformer-zh'))
  assert.equal(client.env.LOCAL_VOICE_TTS_MODEL_DIR, join(localVoiceModelRoot(), 'melotts-zh'))
  assert.equal(client.env.HF_HUB_OFFLINE, '1')
  assert.equal(client.env.TRANSFORMERS_OFFLINE, '1')
})

test('runtime client immediately drops queued and late audio when cancelled', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child })
  const started = client.start()
  child.emitLine({ type: 'ready', asr: true, tts: true })
  await started
  const stream = client.synthesize('你好')
  await Promise.resolve()
  child.emitLine({ type: 'audio', request_id: stream.requestId, data: 'AQACAA==' })
  stream.cancel()
  child.emitLine({ type: 'audio', request_id: stream.requestId, data: 'AQACAA==' })
  assert.deepEqual(await wait(stream.next()), { value: undefined, done: true })
  await client.stop()
})

test('runtime client preserves a Chinese transcript split across UTF-8 chunks', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child })
  const started = client.start()
  child.emitLine({ type: 'ready', asr: true, tts: true })
  await started
  const pending = client.transcribe(Buffer.from([0, 0]))
  await Promise.resolve()
  const request = JSON.parse(child.stdin.writes.at(-1))
  const line = Buffer.from(`${JSON.stringify({ type: 'transcript', request_id: request.request_id, text: '你好，中国。' })}\n`)
  const split = line.indexOf(Buffer.from('你')) + 1
  child.stdout.emit('data', line.subarray(0, split))
  child.stdout.emit('data', line.subarray(split))
  assert.equal(await pending, '你好，中国。')
  await client.stop()
})

test('runtime client times out startup and terminates the stalled process', async () => {
  const child = new FakeChild()
  const client = new LocalVoiceRuntimeClient({ spawn: () => child, startupTimeoutMs: 20 })
  await assert.rejects(wait(client.start()), error => error.code === 'runtime_start_timeout')
  assert.equal(child.killed, true)
})
