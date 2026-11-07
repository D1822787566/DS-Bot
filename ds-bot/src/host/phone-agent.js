import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VoiceBridgeServer, createVoiceRoleRoster } from './voice-bridge.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/
const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 120
  && !value.includes('\u0000') && !value.includes('\r') && !value.includes('\n')
const SECRET_KEYS = new Set(['bridgeCredential', 'livekitSecret', 'livekitKey', 'ttsWorkerCredential', 'continuationApiKey'])

const text = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const textOr = (value, fallback, max = 240) => text(value, max) || fallback
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback
const finite = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
const id = (value, label) => {
  const result = text(value, 96)
  if (!ID.test(result)) throw new Error(`${label} must contain only letters, digits, dots, colons, underscores or hyphens`)
  return result
}

export function defaultPhoneAgentConfig() {
  return {
    enabled: true,
    deviceId: 'windows-dsbot-01',
    targetId: 'windows-dsbot-01',
    inputDeviceName: '',
    outputDeviceName: '',
    audioBackend: 'media_devices',
    asrModel: 'paraformer',
    asrLanguage: 'zh-CN',
    asrModelDir: '',
    speakerModelDir: '',
    speakerProfileDir: '',
    ttsModel: 'qwen-audio-3.1-tts-flash',
    ttsVoice: 'longshao_v3.1',
    ttsConfigPath: '',
    livekitUrl: 'ws://127.0.0.1:7880',
    livekitRoom: 'dsbot-voice',
    continuationEnabled: true,
    continuationModel: '',
    continuationUrl: '',
    continuationTimeout: 2,
    wakeTimeout: 8,
    continuationTimeoutSeconds: 12,
    clarificationTimeoutSeconds: 5,
    bargeInEnabled: true,
    wakeEnabled: true,
    speakerVerificationEnabled: true,
    runtimeRoot: '',
    pythonPath: '',
    configPath: '',
  }
}

const PHONE_AGENT_FIELDS = new Set([
  'deviceId', 'targetId', 'inputDeviceName', 'outputDeviceName', 'audioBackend',
  'asrModel', 'asrLanguage', 'asrModelDir', 'speakerModelDir', 'speakerProfileDir',
  'ttsModel', 'ttsVoice', 'ttsConfigPath', 'livekitUrl', 'livekitRoom',
  'continuationEnabled', 'continuationModel', 'continuationUrl', 'continuationTimeout',
  'wakeTimeout', 'continuationTimeoutSeconds', 'clarificationTimeoutSeconds',
  'bargeInEnabled', 'wakeEnabled', 'speakerVerificationEnabled', 'runtimeRoot', 'pythonPath', 'configPath',
])

export function mergePhoneAgentDefaults(current = {}, imported = {}) {
  const base = defaultPhoneAgentConfig()
  const value = { ...current }
  for (const key of PHONE_AGENT_FIELDS) {
    if (imported[key] === undefined) continue
    if (current[key] === undefined || current[key] === '' || current[key] === base[key]) value[key] = imported[key]
  }
  return value
}

export function phoneAgentProjectRoot() {
  return voiceRuntimeRoot()
}

export function voiceRuntimeRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice-runtime')
}

export function voiceRuntimeLaunch(config = {}) {
  const command = text(config.pythonPath, 500) || (process.platform === 'win32' ? 'python.exe' : 'python3')
  return { command, args: ['main.py'], cwd: voiceRuntimeRoot() }
}

export function phoneAgentEnvironmentFromRuntime(runtime = {}, environment = {}) {
  const next = { ...environment }
  const credential = text(runtime.bridge_credential, 500)
  if (credential) {
    next.DS_BOT_BRIDGE_CREDENTIAL ??= credential
  }
  const bridgeUrl = text(runtime.bridge_url, 500)
  if (bridgeUrl) next.DS_BOT_BRIDGE_URL ??= bridgeUrl
  return next
}

// The Phone Agent project already records the machine's Windows runtime values
// outside DS Bot. Import only non-secret fields so the first settings view is
// useful instead of showing an empty form.
export function phoneAgentDefaultsFromRuntime(runtime = {}, desktop = {}, tts = {}, paths = {}, recorded = {}) {
  const base = defaultPhoneAgentConfig()
  const deviceId = textOr(desktop.device_id ?? runtime.device_id, base.deviceId, 96)
  return {
    ...base,
    deviceId,
    targetId: textOr(desktop.target_id ?? runtime.target_id, deviceId, 96),
    inputDeviceName: textOr(desktop.windows_input_device_name ?? runtime.windows_input_device_name ?? recorded.input_device, base.inputDeviceName, 160),
    outputDeviceName: textOr(desktop.windows_output_device_name ?? runtime.windows_output_device_name ?? recorded.output_device, base.outputDeviceName, 160),
    audioBackend: desktop.windows_audio_backend === 'platform_audio' || runtime.windows_audio_backend === 'platform_audio' ? 'platform_audio' : base.audioBackend,
    asrModelDir: textOr(runtime.asr_model_dir, base.asrModelDir, 500),
    speakerModelDir: textOr(runtime.speaker_model_dir, base.speakerModelDir, 500),
    speakerProfileDir: textOr(runtime.speaker_profile_dir, base.speakerProfileDir, 500),
    ttsModel: textOr(tts.TTS_MODEL ?? runtime.tts_model, base.ttsModel, 160),
    ttsVoice: textOr(tts.TTS_VOICE ?? runtime.tts_voice, base.ttsVoice, 120),
    ttsConfigPath: textOr(runtime.tts_config_path, base.ttsConfigPath, 500),
    livekitUrl: textOr(runtime.livekit_url ?? runtime.device_livekit_url, base.livekitUrl, 300),
    livekitRoom: textOr(runtime.room, base.livekitRoom, 120),
    continuationEnabled: bool(runtime.wake_gated_continuation_enabled ?? runtime.continuation_enabled, base.continuationEnabled),
    continuationModel: textOr(runtime.continuation_model, base.continuationModel, 160),
    continuationUrl: textOr(runtime.continuation_url, base.continuationUrl, 300),
    continuationTimeout: finite(runtime.continuation_timeout, base.continuationTimeout, .1, 30),
    wakeTimeout: finite(runtime.wake_first_turn_timeout, base.wakeTimeout, 1, 60),
    continuationTimeoutSeconds: finite(runtime.wake_continuation_timeout, base.continuationTimeoutSeconds, 1, 120),
    clarificationTimeoutSeconds: finite(runtime.wake_clarification_timeout, base.clarificationTimeoutSeconds, 1, 60),
    bargeInEnabled: bool(runtime.windows_barge_in_enabled, base.bargeInEnabled),
    wakeEnabled: bool(runtime.windows_wake_enabled, base.wakeEnabled),
    speakerVerificationEnabled: bool(runtime.speaker_verification_enabled, base.speakerVerificationEnabled),
    runtimeRoot: textOr(paths.runtimeRoot, base.runtimeRoot, 500),
    configPath: textOr(paths.configPath, base.configPath, 500),
  }
}

function jsonFile(path) {
  if (!path || !existsSync(path)) return {}
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function envFile(path) {
  if (!path || !existsSync(path)) return {}
  try {
    return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).flatMap(line => {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : []
    }))
  } catch { return {} }
}

function latestCaptureMetadata(root) {
  const profileRoot = join(root, 'voice-profile')
  let newest = { at: -1, value: {} }
  const visit = directory => {
    if (!existsSync(directory)) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === 'capture-metadata.json') {
        try {
          const at = statSync(path).mtimeMs
          if (at > newest.at) newest = { at, value: jsonFile(path) }
        } catch { /* ignore stale diagnostic records */ }
      }
    }
  }
  visit(profileRoot)
  return newest.value
}

function existingRuntimeDefaults() {
  const root = text(process.env.PHONE_AGENT_RUNTIME_ROOT, '')
  const candidates = [
    text(process.env.PHONE_AGENT_RUNTIME_CONFIG, ''),
    root ? join(root, 'rebuild', 'device-smoke', 'runtime.json') : '',
    process.platform === 'win32' ? 'D:\\phone_agent_runtime\\rebuild\\device-smoke\\runtime.json' : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'PhoneAgent', 'rebuild', 'device-smoke', 'runtime.json') : '',
  ].filter(Boolean)
  const configPath = candidates.find(path => existsSync(path))
  if (!configPath) return {}
  const runtime = jsonFile(configPath)
  const runtimeDataRoot = resolve(dirname(configPath), '..', '..')
  const desktop = jsonFile(join(runtimeDataRoot, 'desktop-voice-gateway.json'))
  const tts = envFile(runtime.tts_config_path)
  return phoneAgentDefaultsFromRuntime(runtime, desktop, tts, { runtimeRoot: phoneAgentProjectRoot(), configPath }, latestCaptureMetadata(runtimeDataRoot))
}

export function normalizePhoneAgentConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Phone Agent configuration must be an object')
  const base = defaultPhoneAgentConfig()
  const value = { ...base }
  value.enabled = bool(raw.enabled, base.enabled)
  value.deviceId = id(raw.deviceId ?? base.deviceId, 'Device ID')
  value.targetId = id(raw.targetId ?? value.deviceId, 'Target ID')
  value.inputDeviceName = text(raw.inputDeviceName, 160)
  value.outputDeviceName = text(raw.outputDeviceName, 160)
  value.audioBackend = raw.audioBackend === 'media_devices' || raw.audioBackend === 'platform_audio' ? raw.audioBackend : base.audioBackend
  value.asrModel = text(raw.asrModel, 120) || base.asrModel
  value.asrLanguage = text(raw.asrLanguage, 32) || base.asrLanguage
  value.asrModelDir = text(raw.asrModelDir, 500)
  value.speakerModelDir = text(raw.speakerModelDir, 500)
  value.speakerProfileDir = text(raw.speakerProfileDir, 500)
  value.ttsModel = text(raw.ttsModel, 160) || base.ttsModel
  value.ttsVoice = text(raw.ttsVoice, 120) || base.ttsVoice
  value.ttsConfigPath = text(raw.ttsConfigPath, 500)
  value.livekitUrl = text(raw.livekitUrl, 300) || base.livekitUrl
  if (!/^wss?:\/\/127\.0\.0\.1(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(value.livekitUrl)) throw new Error('LiveKit URL must use the local ws:// or wss:// endpoint')
  value.livekitRoom = text(raw.livekitRoom, 120) || base.livekitRoom
  value.continuationEnabled = bool(raw.continuationEnabled, base.continuationEnabled)
  value.continuationModel = text(raw.continuationModel, 160)
  value.continuationUrl = text(raw.continuationUrl, 300)
  if (value.continuationUrl && !/^https?:\/\/127\.0\.0\.1(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(value.continuationUrl)) throw new Error('Continuation URL must use the local HTTP endpoint')
  value.continuationTimeout = finite(raw.continuationTimeout, base.continuationTimeout, .1, 30)
  value.wakeTimeout = finite(raw.wakeTimeout, base.wakeTimeout, 1, 60)
  value.continuationTimeoutSeconds = finite(raw.continuationTimeoutSeconds, base.continuationTimeoutSeconds, 1, 120)
  value.clarificationTimeoutSeconds = finite(raw.clarificationTimeoutSeconds, base.clarificationTimeoutSeconds, 1, 60)
  value.bargeInEnabled = bool(raw.bargeInEnabled, base.bargeInEnabled)
  value.wakeEnabled = bool(raw.wakeEnabled, base.wakeEnabled)
  value.speakerVerificationEnabled = bool(raw.speakerVerificationEnabled, base.speakerVerificationEnabled)
  // These values are accepted for host-side use but never returned to the client.
  value.runtimeRoot = text(raw.runtimeRoot, 500)
  value.pythonPath = text(raw.pythonPath, 500)
  value.configPath = text(raw.configPath, 500)
  return value
}

function profilesOf(state) {
  return Object.values(state?.bots ?? {})
}

function profileValue(bot, key, fallback = '') {
  return bot?.phoneAgent?.[key] === undefined ? fallback : bot.phoneAgent[key]
}

export function updatePhoneAgentProfile(state, botId, patch = {}) {
  const bot = state?.bots?.[botId]
  if (!bot) throw new Error('Unknown Bot')
  const wakeName = text(patch.wakeName, 120)
  if (!validName(wakeName)) throw new Error('Wake name must be one to 120 characters')
  const normalized = wakeName.toLocaleLowerCase()
  const conflict = profilesOf(state).find(other => other.id !== botId
    && text(profileValue(other, 'wakeName')).toLocaleLowerCase() === normalized)
  if (conflict) throw new Error(`Wake name is already used by ${conflict.name}`)
  const ttsVoice = text(patch.ttsVoice, 120)
  if (!validName(ttsVoice)) throw new Error('TTS voice must be one to 120 characters')
  bot.phoneAgent = { ...bot.phoneAgent, wakeName, ttsVoice }
  return { wakeName, ttsVoice }
}

export function phoneAgentView(state, runtime = { state: 'stopped' }) {
  const config = normalizePhoneAgentConfig(state?.prefs?.phoneAgent ?? {})
  for (const key of SECRET_KEYS) delete config[key]
  delete config.runtimeRoot
  delete config.pythonPath
  delete config.configPath
  return {
    config,
    bots: profilesOf(state).map(bot => ({ id: bot.id, name: bot.name,
      wakeName: profileValue(bot, 'wakeName', bot.name), ttsVoice: profileValue(bot, 'ttsVoice', config.ttsVoice) })),
    runtime: { state: runtime.state, ...(Number.isInteger(runtime.pid) ? { pid: runtime.pid } : {}), ...(runtime.error ? { error: text(runtime.error, 300) } : {}) },
  }
}

export async function submitPhoneAgentInput(rt, { botId, text: rawText, speaker } = {}) {
  const bot = rt.botOf(String(botId ?? ''))
  const textValue = typeof rawText === 'string' ? rawText.trim() : ''
  if (!bot) throw new Error('Unknown Bot')
  if (!textValue) throw new Error('Nothing to send')
  if (!speaker || speaker.status !== 'owner_verified') throw new Error('Owner verification is required before voice input')
  const sessionId = rt.chatOf(bot.id)
  await rt.ensureCapabilities(sessionId)
  await rt.ctx.sessionController.prompt({
    requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: textValue }],
  }, AbortSignal.timeout(30_000))
  return { accepted: true, botId: bot.id, sessionId }
}

class RuntimeManager {
  constructor(rt) {
    this.rt = rt
    this.child = null
    this.bridge = null
    this.state = 'stopped'
    this.error = ''
    this.activityEpoch = randomUUID()
  }

  view() {
    return {
      state: this.state,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.bridge?.view?.().port ? { bridgePort: this.bridge.view().port } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async start(config) {
    if (this.child) return this.view()
    this.state = 'starting'
    this.error = ''
    const credential = randomUUID()
    const bridge = new VoiceBridgeServer({
      rt: this.rt,
      deviceId: config.deviceId,
      credential,
      activityEpoch: this.activityEpoch,
      getRoles: () => createVoiceRoleRoster(this.rt.state, this.activityEpoch, botId => this.rt.chatOf(botId)),
    })
    try {
      const bridgeView = await bridge.start({ host: '127.0.0.1', port: 0 })
      const launch = voiceRuntimeLaunch(config)
      const environment = {
        ...process.env,
        DS_BOT_BRIDGE_URL: `ws://127.0.0.1:${bridgeView.port}`,
        DS_BOT_BRIDGE_CREDENTIAL: credential,
        DS_BOT_DEVICE_ID: config.deviceId,
        DS_BOT_TARGET_ID: config.targetId,
        DS_BOT_VOICE_CONFIG: JSON.stringify({
          ...config,
          runtimeRoot: undefined,
          pythonPath: undefined,
          configPath: undefined,
        }),
      }
      const child = spawn(launch.command, launch.args, { cwd: launch.cwd, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      this.bridge = bridge
      this.child = child
      child.on('error', error => {
        this.state = 'error'
        this.error = error.message.slice(0, 300)
        this.child = null
        void this.bridge?.stop()
        this.bridge = null
      })
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null
        if (this.state !== 'stopped') {
          this.state = code === 0 ? 'stopped' : 'error'
          this.error = code === 0 ? '' : `DS Bot voice runtime exited (${code ?? signal ?? 'unknown'})`
          void this.bridge?.stop()
          this.bridge = null
        }
      })
      this.state = 'ready'
      return this.view()
    } catch (error) {
      await bridge.stop().catch(() => {})
      this.state = 'error'
      this.error = error?.message?.slice(0, 300) || String(error).slice(0, 300)
      return this.view()
    }
  }

  async stop() {
    const child = this.child
    this.state = 'stopped'; this.error = ''
    this.child = null
    if (child && !child.killed) child.kill()
    const bridge = this.bridge
    this.bridge = null
    await bridge?.stop?.()
    return this.view()
  }

  sessionEvent(session, event) { this.bridge?.sessionEvent(session, event) }
  rolesChanged() { this.bridge?.rolesChanged() }
}

export function install(rt) {
  const { state } = rt
  const desktop = process.env.DS_BOT_APP === '1' || rt.ctx.get?.('profileContext')?.name === 'desktop'
  const imported = desktop ? existingRuntimeDefaults() : {}
  const applyImportedDefaults = () => {
    const next = normalizePhoneAgentConfig(mergePhoneAgentDefaults(state.prefs.phoneAgent, imported))
    if (JSON.stringify(next) === JSON.stringify(state.prefs.phoneAgent)) return false
    state.prefs.phoneAgent = next
    return true
  }
  applyImportedDefaults()
  // Store installation reloads the persisted team after all modules are wired.
  // Apply the import once more after that reload and persist the migration so
  // the launcher never falls back to the data directory on the next start.
  rt.ctx.effect(() => {
    let stopped = false
    void rt.load().then(() => {
      if (stopped || !applyImportedDefaults()) return
      return rt.save()
    }).catch(() => {})
    return () => { stopped = true }
  }, 'ds-bot: Phone Agent runtime defaults')
  const manager = new RuntimeManager(rt)
  rt.ctx.on('session/event', (session, event) => manager.sessionEvent(session, event))
  const save = async () => { applyImportedDefaults(); await rt.save(); return phoneAgentView(state, manager.view()) }
  const phoneAgent = () => { applyImportedDefaults(); return phoneAgentView(state, manager.view()) }
  const phoneAgentUpdate = async body => {
    applyImportedDefaults()
    const wasRunning = Boolean(manager.child)
    if (body?.config !== undefined) state.prefs.phoneAgent = normalizePhoneAgentConfig({ ...state.prefs.phoneAgent, ...body.config })
    if (body?.botId !== undefined) updatePhoneAgentProfile(state, String(body.botId), body.profile ?? {})
    await save()
    manager.rolesChanged()
    if (!state.prefs.phoneAgent.enabled) await manager.stop()
    else if (wasRunning) {
      await manager.stop()
      await manager.start(state.prefs.phoneAgent)
    }
    return phoneAgent()
  }
  const phoneAgentStart = async () => {
    if (process.env.DS_BOT_APP !== '1') throw new Error('Managed Windows voice runtime is available in the DS Bot Desktop app')
    applyImportedDefaults(); state.prefs.phoneAgent.enabled = true; await rt.save(); await manager.start(state.prefs.phoneAgent); return phoneAgent()
  }
  const phoneAgentStop = async () => { state.prefs.phoneAgent.enabled = false; await manager.stop(); return save() }
  const phoneAgentSubmit = body => submitPhoneAgentInput(rt, body)
  Object.assign(rt, { phoneAgent, phoneAgentUpdate, phoneAgentStart, phoneAgentStop, phoneAgentSubmit })
  // Only the packaged Desktop host owns local Windows processes. Web hosts may
  // load the plugin and display its settings, but must never spawn audio.
  const desktopRuntime = process.env.DS_BOT_APP === '1'
  rt.ctx.effect(() => {
    let stopped = false
    void rt.load().then(async () => {
      if (stopped || !desktopRuntime || !state.prefs.phoneAgent.enabled) return
      const view = await manager.start(state.prefs.phoneAgent)
      if (view.state === 'error') rt.warn('ds-bot: managed voice runtime failed to start: %s', view.error)
    }).catch(error => rt.warn('ds-bot: managed voice runtime setup failed: %s', error))
    return () => { stopped = true; void manager.stop() }
  }, 'ds-bot: managed voice runtime')
}
