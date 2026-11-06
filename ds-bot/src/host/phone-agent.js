import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/
const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 120
  && !value.includes('\u0000') && !value.includes('\r') && !value.includes('\n')
const SECRET_KEYS = new Set(['bridgeCredential', 'livekitSecret', 'livekitKey', 'ttsWorkerCredential', 'continuationApiKey', 'runtimeRoot', 'pythonPath', 'configPath'])

const text = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback
const finite = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
const id = (value, label) => {
  const result = text(value, 96)
  if (!ID.test(result)) throw new Error(`${label} must contain only letters, digits, dots, colons, underscores or hyphens`)
  return result
}

export function defaultPhoneAgentConfig() {
  return {
    enabled: false,
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
  return {
    config,
    bots: profilesOf(state).map(bot => ({ id: bot.id, name: bot.name,
      wakeName: profileValue(bot, 'wakeName'), ttsVoice: profileValue(bot, 'ttsVoice') })),
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
  constructor(rt) { this.rt = rt; this.child = null; this.state = 'stopped'; this.error = '' }

  view() { return { state: this.state, ...(this.child?.pid ? { pid: this.child.pid } : {}), ...(this.error ? { error: this.error } : {}) } }

  async start(config) {
    if (this.child) return this.view()
    const root = resolve(config.runtimeRoot || process.env.PHONE_AGENT_ROOT || join(this.rt.dshHome, '..', 'phone_agent'))
    const script = join(root, 'scripts', 'run-desktop.ps1')
    if (!existsSync(script)) throw new Error(`Phone Agent Windows launcher was not found: ${script}`)
    const shell = process.env.ComSpec || 'powershell.exe'
    const args = shell.toLowerCase().endsWith('cmd.exe')
      ? ['/d', '/s', '/c', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
      : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
    this.state = 'starting'; this.error = ''
    const environment = { ...process.env }
    if (config.configPath) environment.PHONE_AGENT_RUNTIME_CONFIG = config.configPath
    const child = spawn(shell, args, { cwd: root, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.on('error', error => { this.state = 'error'; this.error = error.message.slice(0, 300); this.child = null })
    child.on('exit', (code, signal) => { if (this.child === child) this.child = null; if (this.state !== 'stopped') { this.state = code === 0 ? 'stopped' : 'error'; this.error = code === 0 ? '' : `Phone Agent exited (${code ?? signal ?? 'unknown'})` } })
    this.state = 'ready'
    return this.view()
  }

  async stop() {
    const child = this.child
    this.state = 'stopped'; this.error = ''
    this.child = null
    if (child && !child.killed) child.kill()
    return this.view()
  }
}

export function install(rt) {
  const { state } = rt
  state.prefs.phoneAgent = normalizePhoneAgentConfig(state.prefs.phoneAgent ?? {})
  const manager = new RuntimeManager(rt)
  const save = async () => { await rt.save(); return phoneAgentView(state, manager.view()) }
  const phoneAgent = () => phoneAgentView(state, manager.view())
  const phoneAgentUpdate = async body => {
    if (body?.config !== undefined) state.prefs.phoneAgent = normalizePhoneAgentConfig({ ...state.prefs.phoneAgent, ...body.config })
    if (body?.botId !== undefined) updatePhoneAgentProfile(state, String(body.botId), body.profile ?? {})
    return save()
  }
  const phoneAgentStart = async () => { state.prefs.phoneAgent.enabled = true; await rt.save(); await manager.start(state.prefs.phoneAgent); return phoneAgent() }
  const phoneAgentStop = async () => { state.prefs.phoneAgent.enabled = false; await manager.stop(); return save() }
  const phoneAgentSubmit = body => submitPhoneAgentInput(rt, body)
  Object.assign(rt, { phoneAgent, phoneAgentUpdate, phoneAgentStart, phoneAgentStop, phoneAgentSubmit })
}
