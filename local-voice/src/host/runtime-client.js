import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const text = value => typeof value === 'string' ? value : ''
const decode = value => Buffer.from(text(value), 'base64')

function runtimeError(message, code = 'local-voice/runtime') {
  const error = new Error(message)
  error.code = code
  return error
}

const localVoiceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function localVoiceEnvironmentRoot() {
  return process.env.DSH_HOME
    ? resolve(process.env.DSH_HOME, '..', 'local-voice-env')
    : resolve(localVoiceRoot, '..', '.ds-bot-local', 'local-voice-env')
}

export function localVoiceModelRoot() {
  return process.env.LOCAL_VOICE_MODEL_ROOT
    ? resolve(process.env.LOCAL_VOICE_MODEL_ROOT)
    : process.env.DSH_HOME
      ? resolve(process.env.DSH_HOME, '..', 'local-voice-models')
      : resolve(localVoiceRoot, '..', '.ds-bot-local', 'local-voice-models')
}

export function localVoicePythonPath() {
  return process.env.LOCAL_VOICE_PYTHON
    || join(localVoiceEnvironmentRoot(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}

class AsyncQueue {
  constructor() {
    this.values = []
    this.waiters = []
    this.closed = false
    this.failure = null
    this.cancelled = false
  }

  push(value) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  finish(error = null, discard = false) {
    if (discard) this.values = []
    if (this.closed) return
    this.closed = true
    this.failure = error
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter(Promise.reject(error))
      else waiter({ value: undefined, done: true })
    }
  }

  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false })
    if (this.closed) return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true })
    return new Promise(resolve => this.waiters.push(resolve))
  }

  [Symbol.asyncIterator]() { return this }
}

export class LocalVoiceRuntimeClient {
  constructor({ command = localVoicePythonPath(), args = [], cwd, env, spawn = nodeSpawn, startupTimeoutMs = 120_000, requestTimeoutMs = 60_000 } = {}) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.spawn = spawn
    this.child = null
    this.buffer = ''
    this.ready = null
    this.pending = new Map()
    this.capabilities = null
    this.stopped = false
    this.waiter = null
    this.startupTimeoutMs = startupTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.startupTimer = null
    this.decoder = new StringDecoder('utf8')
  }

  start() {
    if (this.ready) return this.ready
    this.stopped = false
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.ready = new Promise((resolve, reject) => {
      let child
      try { child = this.spawn(this.command, this.args, { cwd: this.cwd, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (error) {
        this.ready = null
        reject(error)
        return
      }
      this.child = child
      child.stdout?.on('data', chunk => { if (this.child === child) this.#read(chunk) })
      child.stderr?.on('data', () => {})
      child.once('error', error => { if (this.child === child) this.#failAll(runtimeError(`runtime process error: ${error.message}`, 'runtime_process_error')) })
      child.stdin?.on?.('error', () => { if (this.child === child) this.#failAll(runtimeError('Runtime input closed', 'runtime_process_error')) })
      child.once('exit', code => {
        if (this.child === child && !this.stopped) {
          this.#failAll(runtimeError(`runtime exited (${code ?? 'unknown'})`, 'runtime_exited'))
          this.child = null
          this.ready = null
        }
      })
      this.waiter = { resolve, reject }
      this.startupTimer = setTimeout(() => {
        if (this.child !== child || !this.waiter) return
        this.#failAll(runtimeError('Runtime startup timed out', 'runtime_start_timeout'))
        child.kill?.()
      }, this.startupTimeoutMs)
      this.#send({ type: 'hello' })
    })
    return this.ready
  }

  async transcribe(audio, { sampleRate = 16000 } = {}) {
    await this.start()
    const requestId = randomUUID()
    const promise = new Promise((resolve, reject) => this.pending.set(requestId, { kind: 'transcribe', resolve, reject }))
    this.#setRequestTimeout(requestId)
    this.#send({ type: 'transcribe', request_id: requestId, sample_rate: sampleRate, audio_b64: Buffer.from(audio).toString('base64') })
    return promise
  }

  synthesize(textValue, { voice = '', sampleRate = 16000 } = {}) {
    const requestId = randomUUID()
    const queue = new AsyncQueue()
    queue.requestId = requestId
    queue.cancel = () => {
      queue.cancelled = true
      queue.finish(null, true)
      this.cancel(requestId)
      return true
    }
    this.start().then(() => {
      if (queue.cancelled) {
        queue.finish()
        return
      }
      this.pending.set(requestId, { kind: 'synthesize', queue })
      this.#setRequestTimeout(requestId)
      this.#send({ type: 'synthesize', request_id: requestId, text: textValue, voice, sample_rate: sampleRate })
    }).catch(error => queue.finish(error, true))
    return queue
  }

  cancel(requestId) {
    const request = this.pending.get(requestId)
    if (!request) return false
    clearTimeout(request.timer)
    this.pending.delete(requestId)
    if (request.kind === 'synthesize') request.queue.finish(null, true)
    else request.reject(runtimeError('Request cancelled', 'runtime_cancelled'))
    this.#send({ type: 'cancel', request_id: requestId })
    return true
  }

  async stop() {
    this.stopped = true
    this.#failAll(runtimeError('runtime stopped', 'runtime_stopped'))
    const child = this.child
    this.child = null
    this.ready = null
    if (!child) return
    try { child.stdin?.end?.() } catch { /* process may already be closed */ }
    try { child.kill?.() } catch { /* process may already be closed */ }
  }

  #send(message) {
    if (!this.child?.stdin?.write) throw runtimeError('runtime is not running', 'runtime_not_running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #read(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      this.#handle(message)
    }
  }

  #handle(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'ready') {
      clearTimeout(this.startupTimer)
      this.capabilities = {
        asr: message.asr === true,
        tts: message.tts === true,
        prewarmed: message.prewarmed === true,
      }
      this.waiter?.resolve(this.capabilities)
      this.waiter = null
      return
    }
    if (message.type === 'error' && !message.request_id && this.waiter) {
      clearTimeout(this.startupTimer)
      const error = runtimeError(text(message.message) || 'runtime is not ready', text(message.code) || 'runtime_not_ready')
      this.waiter.reject(error)
      this.waiter = null
      return
    }
    const request = this.pending.get(message.request_id)
    if (!request) return
    if (message.type !== 'audio') clearTimeout(request.timer)
    if (message.type === 'transcript' && request.kind === 'transcribe') {
      this.pending.delete(message.request_id)
      request.resolve(text(message.text))
    } else if (message.type === 'audio' && request.kind === 'synthesize') {
      request.queue.push(decode(message.data))
    } else if (message.type === 'complete' && request.kind === 'synthesize') {
      this.pending.delete(message.request_id)
      request.queue.finish()
    } else if (message.type === 'cancelled' && request.kind === 'synthesize') {
      this.pending.delete(message.request_id)
      request.queue.finish()
    } else if (message.type === 'error') {
      this.pending.delete(message.request_id)
      const error = runtimeError(text(message.message) || 'runtime request failed', text(message.code) || 'runtime_request_failed')
      request.kind === 'synthesize' ? request.queue.finish(error) : request.reject(error)
    }
  }

  #failAll(error) {
    clearTimeout(this.startupTimer)
    this.waiter?.reject(error)
    this.waiter = null
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer)
      if (request.kind === 'synthesize') request.queue.finish(error, true)
      else request.reject(error)
      this.pending.delete(requestId)
    }
  }

  #setRequestTimeout(requestId) {
    const request = this.pending.get(requestId)
    request.timer = setTimeout(() => {
      if (!this.pending.delete(requestId)) return
      const error = runtimeError('Speech request timed out', 'runtime_request_timeout')
      if (request.kind === 'synthesize') request.queue.finish(error, true)
      else request.reject(error)
      try { this.#send({ type: 'cancel', request_id: requestId }) } catch { /* child already exited */ }
    }, this.requestTimeoutMs)
    request.timer.unref?.()
  }
}

export function createLocalVoiceRuntimeFactory({ command, runtimeMain = resolve(dirname(fileURLToPath(import.meta.url)), '../../runtime/main.py'), spawn = nodeSpawn, env = process.env } = {}) {
  const runtimeEnv = { ...process.env, ...env }
  const modelRoot = localVoiceModelRoot()
  runtimeEnv.LOCAL_VOICE_ASR_MODEL_DIR ??= join(modelRoot, 'paraformer-zh')
  runtimeEnv.LOCAL_VOICE_TTS_MODEL_DIR ??= join(modelRoot, 'melotts-zh')
  runtimeEnv.LOCAL_VOICE_ASR_DEVICE ??= 'cpu'
  runtimeEnv.LOCAL_VOICE_TTS_DEVICE ??= 'cpu'
  runtimeEnv.LOCAL_VOICE_TTS_PREWARM ??= '1'
  runtimeEnv.HF_HUB_OFFLINE ??= '1'
  runtimeEnv.TRANSFORMERS_OFFLINE ??= '1'
  runtimeEnv.PYTHONUTF8 ??= '1'
  runtimeEnv.PYTHONIOENCODING ??= 'utf-8'
  return async () => new LocalVoiceRuntimeClient({ command: command ?? runtimeEnv.LOCAL_VOICE_PYTHON ?? localVoicePythonPath(), args: [runtimeMain], spawn, env: runtimeEnv })
}
