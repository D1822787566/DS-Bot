import { DeviceLease } from './device-lock.js'
import { localVoiceView, normalizeLocalVoiceConfig } from './config.js'

const noop = async () => {}
const unconfiguredRuntime = async () => {
  const error = new Error('runtime_not_configured')
  error.code = 'runtime_not_configured'
  throw error
}

export class LocalVoiceManager {
  constructor({ state = { prefs: {} }, save = noop, deviceConflict = () => null, runtimeFactory = unconfiguredRuntime } = {}) {
    this.state = state
    this.state.prefs ??= {}
    this.save = save
    this.deviceConflict = deviceConflict
    this.runtimeFactory = runtimeFactory
    this.lease = new DeviceLease()
    this.runtime = { state: 'stopped', modelReady: false }
    this.worker = null
  }

  config() {
    return normalizeLocalVoiceConfig(this.state.prefs.localVoice ?? {})
  }

  view() {
    return localVoiceView(this.state, this.runtime)
  }

  async update(patch = {}) {
    const next = normalizeLocalVoiceConfig({ ...this.config(), ...patch })
    this.state.prefs.localVoice = next
    await this.save()
    return this.view()
  }

  async start() {
    if (this.runtime.state === 'ready' || this.runtime.state === 'starting') return this.view()
    const conflict = this.deviceConflict()
    if (typeof conflict === 'string' && conflict) {
      this.runtime = { state: 'error', modelReady: false, error: 'audio_device_busy' }
      return this.view()
    }
    this.runtime = { state: 'starting', modelReady: false }
    try {
      this.lease.acquire('local-voice')
      this.worker = await this.runtimeFactory(this.config())
      const capabilities = await this.worker?.start?.()
      if (capabilities?.asr !== true || capabilities?.tts !== true) {
        const error = new Error('runtime_capability_missing')
        error.code = 'runtime_capability_missing'
        throw error
      }
      this.runtime = { state: 'ready', modelReady: true, capabilities }
      return this.view()
    } catch (error) {
      await this.#releaseWorker()
      this.runtime = { state: 'error', modelReady: false, error: error?.code ?? 'runtime_start_failed' }
      return this.view()
    }
  }

  async stop() {
    await this.#releaseWorker()
    this.runtime = { state: 'stopped', modelReady: false }
    return this.view()
  }

  #requireReady() {
    if (this.runtime.state !== 'ready' || !this.worker) {
      const error = new Error('runtime_not_ready')
      error.code = 'runtime_not_ready'
      throw error
    }
    return this.worker
  }

  async transcribe(audio, options = {}) {
    return this.#requireReady().transcribe(audio, options)
  }

  synthesize(text, options = {}) {
    return this.#requireReady().synthesize(text, options)
  }

  cancel(requestId) {
    return this.#requireReady().cancel(requestId)
  }

  async #releaseWorker() {
    try { await this.worker?.stop?.() } finally {
      this.worker = null
      this.lease.release('local-voice')
    }
  }
}
