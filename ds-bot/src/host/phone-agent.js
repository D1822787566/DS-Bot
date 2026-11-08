import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
export function appendPhoneAgentOutput(previous = '', chunk = '') {
  const lines = `${previous || ''}\n${String(chunk)}`.split(/\r?\n/).map(safeRuntimeLine).filter(Boolean)
  return lines.join('\n').slice(-2000)
}
const statusCode = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : ''
const RUNTIME_STATES = new Set(['stopped', 'starting', 'listening', 'speaking', 'paused', 'error'])
export function emptyPhoneAgentMetrics() {
  return {
    startedAt: new Date().toISOString(),
    microphoneFrames: 0, microphoneDrops: 0, microphonePeak: 0, microphoneRms: 0,
    wakeKeywordResults: 0, wakeValidHits: 0, wakePublished: 0, wakeAccepted: 0,
    wakeRejected: 0, wakeCooldownDrops: 0, wakeUnknownKeywords: 0, wakeBoundaries: 0,
    segmentStarted: 0, segmentEnded: 0, segmentDropped: 0, segmentDropReasons: {},
    asrAttempted: 0, asrCompleted: 0, asrFailed: 0, lastAsrError: '',
    ownerVerified: 0, ownerRejected: 0, ownerFailed: 0, lastOwnerError: '', ownerLastScore: null, ownerMinScore: null, ownerMaxScore: null,
    inputSubmitted: 0, inputAccepted: 0, inputRejected: 0,
    voiceprintTestStarted: 0, voiceprintTestCompleted: 0, voiceprintTestResult: '',
    voiceprintCandidateReady: false, voiceprintCandidateSegmentId: null,
    voiceprintPendingSamples: 0, voiceprintApprovedSamples: 0, recent: [],
  }
}

const metricNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function recordPhoneAgentMetric(metrics, event = {}) {
  if (!metrics || typeof event?.type !== 'string') return metrics
  const type = event.type
  const diagnostics = event.wake_diagnostics && typeof event.wake_diagnostics === 'object'
    ? event.wake_diagnostics : {}
  if (type === 'windows.wake.audio') {
    metrics.microphoneFrames = metricNumber(event.frames) ?? metrics.microphoneFrames
    metrics.microphoneDrops = metricNumber(event.dropped_chunks) ?? metrics.microphoneDrops
    metrics.microphonePeak = metricNumber(event.peak) ?? metrics.microphonePeak
    metrics.microphoneRms = metricNumber(event.rms) ?? metrics.microphoneRms
    for (const [field, key] of [['keyword_results', 'wakeKeywordResults'], ['valid_hits', 'wakeValidHits'],
      ['cooldown_drops', 'wakeCooldownDrops'], ['unknown_keywords', 'wakeUnknownKeywords'],
      ['utterance_boundaries', 'wakeBoundaries']]) {
      const value = metricNumber(diagnostics[field])
      if (value !== undefined) metrics[key] = value
    }
  } else if (type === 'windows.wake.published') metrics.wakePublished++
  else if (type === 'runtime.wake') metrics.wakeAccepted++
  else if (type === 'runtime.state' && event.result === 'wake_rejected') metrics.wakeRejected++
  else if (type === 'audio.segment.started') metrics.segmentStarted++
  else if (type === 'audio.segment.ended') { metrics.segmentEnded++; metrics.asrAttempted++ }
  else if (type === 'audio.segment.dropped') {
    metrics.segmentDropped++
    const reason = statusCode(event.reason) || 'unknown'
    metrics.segmentDropReasons[reason] = (metrics.segmentDropReasons[reason] ?? 0) + 1
  } else if (type === 'asr.completed') metrics.asrCompleted++
  else if (type === 'asr.failed') { metrics.asrFailed++; metrics.lastAsrError = statusCode(event.error_code) || 'asr_failed' }
  else if (type === 'owner.failed') { metrics.ownerFailed++; metrics.lastOwnerError = statusCode(event.error_code) || 'owner_failed' }
  else if (type === 'identity.verified' || type === 'identity.rejected') {
    if (type === 'identity.verified') metrics.ownerVerified++
    else metrics.ownerRejected++
    const score = metricNumber(event.score)
    if (score !== undefined) {
      metrics.ownerLastScore = score
      metrics.ownerMinScore = metrics.ownerMinScore === null ? score : Math.min(metrics.ownerMinScore, score)
      metrics.ownerMaxScore = metrics.ownerMaxScore === null ? score : Math.max(metrics.ownerMaxScore, score)
    }
  } else if (type === 'input.submit') metrics.inputSubmitted++
  else if (type === 'input.accepted') metrics.inputAccepted++
  else if (type === 'input.rejected') metrics.inputRejected++
  else if (type === 'voice.test.ready') metrics.voiceprintTestStarted++
  else if (type === 'voice.test.completed') {
    metrics.voiceprintTestCompleted++
    metrics.voiceprintTestResult = statusCode(event.result) || ''
    metrics.voiceprintCandidateReady = event.labelable === true && Number.isInteger(event.segment_id)
    metrics.voiceprintCandidateSegmentId = metrics.voiceprintCandidateReady ? event.segment_id : null
    metrics.voiceprintPendingSamples = metricNumber(event.pending_samples) ?? metrics.voiceprintPendingSamples
    metrics.voiceprintApprovedSamples = metricNumber(event.approved_samples) ?? metrics.voiceprintApprovedSamples
  } else if (type === 'voice.profile.status' || type === 'voice.sample.labeled' || type === 'voice.sample.applied' || type === 'voice.sample.discarded') {
    metrics.voiceprintPendingSamples = metricNumber(event.pending_samples) ?? metrics.voiceprintPendingSamples
    metrics.voiceprintApprovedSamples = metricNumber(event.approved_samples) ?? metrics.voiceprintApprovedSamples
    if (type !== 'voice.profile.status') {
      metrics.voiceprintCandidateReady = false
      metrics.voiceprintCandidateSegmentId = null
    }
  }

  if (type !== 'windows.wake.audio') {
    const recent = { type }
    for (const [source, target] of [['segment_id', 'segmentId'], ['reason', 'reason'], ['status', 'status'],
      ['result', 'result'], ['error_code', 'errorCode'], ['score', 'score']]) {
      if (event[source] !== undefined && (typeof event[source] === 'number' || statusCode(event[source]))) recent[target] = event[source]
    }
    metrics.recent = [...(Array.isArray(metrics.recent) ? metrics.recent : []), recent].slice(-24)
  }
  return metrics
}

function safeRuntimeLine(line) {
  try {
    const event = JSON.parse(String(line))
    if (typeof event?.type !== 'string' || !/^(runtime|windows|audio|input|output|asr|owner|identity|continuation|voice)\.[a-zA-Z0-9._]+$/.test(event.type)) return ''
    const safe = { type: event.type }
    for (const key of ['state', 'stage', 'error_code', 'result', 'bot_id', 'wake_session_id', 'status', 'reason']) {
      if (statusCode(event[key])) safe[key] = event[key]
    }
    if (Number.isInteger(event.segment_id) && event.segment_id >= 0) safe.segment_id = event.segment_id
    if (event.error_code === '') safe.error_code = ''
    for (const key of ['sample_rate', 'device_index', 'frames', 'samples', 'dropped', 'dropped_chunks', 'keyword_results', 'valid_hits', 'duration_ms', 'speech_duration_ms', 'characters', 'generation', 'peak', 'rms', 'score', 'utterance_index', 'pending_samples', 'approved_samples']) {
      if (typeof event[key] === 'number' && Number.isFinite(event[key])) safe[key] = event[key]
    }
    if (event.labelable === true || event.labelable === false) safe.labelable = event.labelable
    if (event.wake_diagnostics && typeof event.wake_diagnostics === 'object' && !Array.isArray(event.wake_diagnostics)) {
      const diagnostics = {}
      for (const key of ['frames', 'keyword_results', 'valid_hits', 'utterance_boundaries', 'cooldown_drops', 'unknown_keywords', 'generation']) {
        if (Number.isFinite(event.wake_diagnostics[key])) diagnostics[key] = event.wake_diagnostics[key]
      }
      if (Object.keys(diagnostics).length) safe.wake_diagnostics = diagnostics
    }
    return JSON.stringify(safe)
  } catch { return '' }
}

export function createPhoneAgentRuntimeParser(onEvent) {
  let pending = '', output = ''
  return {
    write(chunk) {
      pending += String(chunk)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop().slice(-65536)
      for (const line of lines) {
        const safe = safeRuntimeLine(line)
        if (!safe) continue
        output = appendPhoneAgentOutput(output, safe)
        const event = JSON.parse(safe)
        onEvent(phoneAgentRuntimeEvent(safe), event.type, event)
      }
    },
    output: () => output,
  }
}

export function phoneAgentRuntimeEvent(line = '') {
  try {
    const event = JSON.parse(String(line))
    if (event?.type === 'runtime.ready') return { state: 'listening', stage: 'listening', error: '', errorCode: '' }
    if (event?.type === 'runtime.progress' && statusCode(event.stage)) return { stage: event.stage }
    if (event?.type === 'runtime.state') return {
      ...(RUNTIME_STATES.has(event.state) ? { state: event.state } : {}),
      ...(statusCode(event.stage) ? { stage: event.stage } : {}),
      ...(statusCode(event.error_code) ? { errorCode: event.error_code } : {}),
      ...(event.error_code === '' ? { errorCode: '', error: '' } : {}),
      ...(statusCode(event.result) ? { lastResult: event.result } : {}),
      ...(['waiting_for_wake', 'bridge_reconnecting', 'wake_mapping'].includes(event.stage) ? { activeBotId: '', wakeSessionId: '' } : {}),
    }
    if (event?.type === 'runtime.wake' && statusCode(event.bot_id) && statusCode(event.wake_session_id)) {
      return { activeBotId: event.bot_id, wakeSessionId: event.wake_session_id }
    }
    return {}
  } catch {
    return {}
  }
}
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
    ttsVoice: 'longanlingxi_v3.1',
    ttsConfigPath: '',
    livekitUrl: 'ws://127.0.0.1:7880',
    livekitRoom: 'dsbot-voice',
    continuationEnabled: true,
    continuationModel: '',
    continuationUrl: '',
    continuationTimeout: 2,
    continuationMode: 'legacy_nli',
    continuationAcceptThreshold: .8,
    continuationRejectThreshold: .25,
    modelDevice: 'cpu',
    wakeTimeout: 8,
    continuationTimeoutSeconds: 12,
    clarificationTimeoutSeconds: 5,
    bargeInEnabled: true,
    wakeEnabled: true,
    windowsWakeEnabled: true,
    windowsWakeModelDir: '',
    windowsWakeKeywordsScore: 1.5,
    windowsWakeKeywordsThreshold: 0.35,
    windowsWakeCooldownSeconds: 1,
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
  'continuationMode', 'continuationAcceptThreshold', 'continuationRejectThreshold', 'modelDevice',
  'wakeTimeout', 'continuationTimeoutSeconds', 'clarificationTimeoutSeconds',
  'bargeInEnabled', 'wakeEnabled', 'speakerVerificationEnabled', 'runtimeRoot', 'pythonPath', 'configPath',
  'windowsWakeEnabled', 'windowsWakeModelDir', 'windowsWakeKeywordsScore', 'windowsWakeKeywordsThreshold', 'windowsWakeCooldownSeconds',
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

export function voiceRuntimeEnvironmentRoot() {
  return process.env.DSH_HOME
    ? resolve(process.env.DSH_HOME, '..', 'voice-runtime-env')
    : resolve(voiceRuntimeRoot(), '..', '..', '.ds-bot-local', 'voice-runtime-env')
}

export function voiceRuntimeLaunch() {
  const command = join(voiceRuntimeEnvironmentRoot(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return { command, args: ['-u', 'main.py'], cwd: voiceRuntimeRoot() }
}

export function voiceRuntimePreparationLaunch() {
  const installed = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : ''
  const command = process.platform === 'win32' ? (installed && existsSync(installed) ? installed : 'py.exe') : 'python3.12'
  return {
    command,
    args: [...(command === 'py.exe' ? ['-3.12'] : []), '-u', 'prepare_runtime.py', '--environment', voiceRuntimeEnvironmentRoot()],
    cwd: voiceRuntimeRoot(),
  }
}

export function migratePhoneAgentOwnedConfig(config, privateRoot = resolve(voiceRuntimeEnvironmentRoot(), '..', 'voice-runtime-private')) {
  const next = { ...config }
  if (!config.ttsConfigPath) return next
  const owned = join(privateRoot, '.env.tts')
  if (resolve(config.ttsConfigPath) === resolve(owned)) return next
  const source = envFile(config.ttsConfigPath)
  if (!source.TTS_API_KEY) return next
  const keys = ['TTS_API_KEY', 'TTS_MODEL', 'TTS_VOICE', 'TTS_PROVIDER', 'TTS_AUDIO_FORMAT', 'TTS_SAMPLE_RATE', 'TTS_WS_URL']
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
  const temporary = join(privateRoot, `.env.tts-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, keys.filter(key => source[key] !== undefined).map(key => `${key}=${source[key].replace(/[\r\n]/g, '')}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, owned)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  next.ttsConfigPath = owned
  return next
}

export function voiceRuntimeContinuationConfigPath() {
  return resolve(voiceRuntimeEnvironmentRoot(), '..', 'voice-runtime-private', 'continuation.env')
}

export function voiceRuntimeDiagnosticsCommandPath() {
  return join(dirname(voiceRuntimeContinuationConfigPath()), 'voice-diagnostics-command.json')
}

export function migratePhoneAgentContinuationConfig(config = {}, {
  privateRoot = dirname(voiceRuntimeContinuationConfigPath()),
  sourceEnvPath = resolve(voiceRuntimeRoot(), '..', '..', '..', 'phone_agent', '.env'),
  candidatePath = process.platform === 'win32' ? 'D:/phone_agent_runtime/voice-profile/continuation-runtime-wiring-20261101/runtime.candidate.json' : '',
} = {}) {
  const owned = join(privateRoot, 'continuation.env')
  if (!existsSync(owned)) {
    const source = envFile(sourceEnvPath)
    let endpoint
    try { endpoint = new URL(source.base_url) } catch { /* unsupported source is not imported */ }
    if (source.model === 'deepseek-flash' && source.apikey && endpoint
        && ['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash) {
      mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
      writeFileSync(owned, `BASE_URL=${source.base_url}\nMODEL=deepseek-flash\nAPI_KEY=${source.apikey}\n`, { mode: 0o600, flag: 'wx' })
      chmodSync(owned, 0o600)
    }
  }
  const next = { ...config }
  const candidate = jsonFile(candidatePath)
  if (candidate.continuation_mode === 'frozen_llm' && candidate.continuation_model === 'deepseek-flash-continuation-prompt-v2-053') {
    if (!text(config.continuationMode)) next.continuationMode = 'frozen_llm'
    if (!text(config.continuationModel)) next.continuationModel = candidate.continuation_model
  }
  return next
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
    continuationMode: runtime.continuation_mode === 'frozen_llm' ? 'frozen_llm' : base.continuationMode,
    continuationAcceptThreshold: finite(runtime.continuation_accept_threshold, base.continuationAcceptThreshold, 0, 1),
    continuationRejectThreshold: finite(runtime.continuation_reject_threshold, base.continuationRejectThreshold, 0, 1),
    modelDevice: textOr(runtime.model_device, base.modelDevice, 32),
    wakeTimeout: finite(runtime.wake_first_turn_timeout, base.wakeTimeout, 1, 60),
    continuationTimeoutSeconds: finite(runtime.wake_continuation_timeout, base.continuationTimeoutSeconds, 1, 120),
    clarificationTimeoutSeconds: finite(runtime.wake_clarification_timeout, base.clarificationTimeoutSeconds, 1, 60),
    bargeInEnabled: bool(runtime.windows_barge_in_enabled, base.bargeInEnabled),
    wakeEnabled: bool(runtime.windows_wake_enabled, base.wakeEnabled),
    windowsWakeEnabled: bool(runtime.windows_wake_enabled, base.windowsWakeEnabled),
    windowsWakeModelDir: textOr(runtime.windows_wake_model_dir ?? process.env.DS_BOT_WAKE_MODEL_DIR ?? '', base.windowsWakeModelDir, 500),
    windowsWakeKeywordsScore: finite(runtime.windows_wake_keywords_score, base.windowsWakeKeywordsScore, .01, 20),
    windowsWakeKeywordsThreshold: finite(runtime.windows_wake_keywords_threshold, base.windowsWakeKeywordsThreshold, .01, 1),
    windowsWakeCooldownSeconds: finite(runtime.windows_wake_cooldown_seconds, base.windowsWakeCooldownSeconds, .1, 30),
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
      const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
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
  value.continuationMode = raw.continuationMode === 'frozen_llm' ? 'frozen_llm' : base.continuationMode
  value.continuationAcceptThreshold = finite(raw.continuationAcceptThreshold, base.continuationAcceptThreshold, 0, 1)
  value.continuationRejectThreshold = finite(raw.continuationRejectThreshold, base.continuationRejectThreshold, 0, 1)
  if (value.continuationRejectThreshold >= value.continuationAcceptThreshold) throw new Error('Continuation reject threshold must be below its accept threshold')
  value.modelDevice = raw.modelDevice === 'cpu' || /^cuda(?::\d{1,2})?$/.test(raw.modelDevice ?? '') ? raw.modelDevice : base.modelDevice
  value.wakeTimeout = finite(raw.wakeTimeout, base.wakeTimeout, 1, 60)
  value.continuationTimeoutSeconds = finite(raw.continuationTimeoutSeconds, base.continuationTimeoutSeconds, 1, 120)
  value.clarificationTimeoutSeconds = finite(raw.clarificationTimeoutSeconds, base.clarificationTimeoutSeconds, 1, 60)
  value.bargeInEnabled = bool(raw.bargeInEnabled, base.bargeInEnabled)
  value.wakeEnabled = bool(raw.wakeEnabled, base.wakeEnabled)
  value.windowsWakeEnabled = bool(raw.windowsWakeEnabled, base.windowsWakeEnabled)
  value.windowsWakeModelDir = text(raw.windowsWakeModelDir, 500)
  value.windowsWakeKeywordsScore = finite(raw.windowsWakeKeywordsScore, base.windowsWakeKeywordsScore, .01, 20)
  value.windowsWakeKeywordsThreshold = finite(raw.windowsWakeKeywordsThreshold, base.windowsWakeKeywordsThreshold, .01, 1)
  value.windowsWakeCooldownSeconds = finite(raw.windowsWakeCooldownSeconds, base.windowsWakeCooldownSeconds, .1, 30)
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

export function phoneAgentRuntimeDiagnostics(config = defaultPhoneAgentConfig(), runtime = { state: 'stopped' }) {
  const root = voiceRuntimeRoot()
  const bundledRuntime = existsSync(join(root, 'main.py'))
  const pythonCommand = voiceRuntimeLaunch().command
  const processState = text(runtime.state, 32) || 'stopped'
  const bridgePort = Number.isInteger(runtime.bridgePort) ? runtime.bridgePort : undefined
  const environmentReady = existsSync(join(voiceRuntimeEnvironmentRoot(), 'ds-bot-environment.json'))
  return {
    status: bundledRuntime && environmentReady && ['listening', 'speaking', 'paused'].includes(processState) ? 'pass' : 'error',
    bundledRuntime,
    pythonCommand,
    processState,
    environmentReady,
    ...(runtime.stage ? { stage: statusCode(runtime.stage) } : {}),
    ...(runtime.errorCode ? { errorCode: statusCode(runtime.errorCode) } : {}),
    ...(bridgePort === undefined ? {} : { bridgePort }),
    ...(runtime.lastError ? { lastError: text(runtime.lastError, 2000) } : {}),
    ...(runtime.lastOutput ? { lastOutput: text(runtime.lastOutput, 2000) } : {}),
    ...(runtime.metrics ? { metrics: runtime.metrics } : {}),
  }
}

export function phoneAgentView(state, runtime = { state: 'stopped' }) {
  const config = normalizePhoneAgentConfig(state?.prefs?.phoneAgent ?? {})
  for (const key of SECRET_KEYS) delete config[key]
  delete config.runtimeRoot
  delete config.pythonPath
  delete config.configPath
  delete config.windowsWakeModelDir
  return {
    config,
    bots: profilesOf(state).map(bot => ({ id: bot.id, name: bot.name,
      wakeName: profileValue(bot, 'wakeName', bot.name), ttsVoice: profileValue(bot, 'ttsVoice', config.ttsVoice) })),
    runtime: {
      state: runtime.state,
      ...(runtime.stage ? { stage: statusCode(runtime.stage) } : {}),
      ...(runtime.errorCode ? { errorCode: statusCode(runtime.errorCode) } : {}),
      ...(runtime.lastResult ? { lastResult: statusCode(runtime.lastResult) } : {}),
      ...(Number.isInteger(runtime.pid) ? { pid: runtime.pid } : {}),
      ...(Number.isInteger(runtime.bridgePort) ? { bridgePort: runtime.bridgePort } : {}),
      ...(runtime.error ? { error: text(runtime.error, 300) } : {}),
      ...(runtime.lastError ? { lastError: text(runtime.lastError, 2000) } : {}),
      ...(runtime.lastOutput ? { lastOutput: text(runtime.lastOutput, 2000) } : {}),
      ...(runtime.metrics ? { metrics: runtime.metrics } : {}),
      ...(runtime.activeBotId ? { activeBotId: text(runtime.activeBotId, 128) } : {}),
      ...(runtime.wakeSessionId ? { wakeSessionId: text(runtime.wakeSessionId, 128) } : {}),
    },
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

const runtimeFailure = code => ({
  python_312_required: 'Install Python 3.12 for this Windows account, then retry. DS Bot prepares its own voice environment.',
  dependency_install_failed: 'Voice dependency installation failed. Check the network connection and free disk space, then retry.',
  dependency_import_failed: 'Voice dependencies could not load. Retry to repair the DS Bot voice environment.',
  dependency_conflict: 'Voice dependencies are incompatible. Retry to repair the DS Bot voice environment.',
  environment_setup_failed: 'The DS Bot voice environment could not be prepared. Check available disk space and retry.',
  tts_config_migration_failed: 'The TTS configuration could not be imported. Choose a configuration file with a TTS_API_KEY, then retry.',
  startup_timeout: 'Voice startup timed out. Check the reported stage and model or audio settings, then retry.',
  runtime_exited: 'The voice runtime stopped unexpectedly. Check the reported stage and settings, then retry.',
}[code] ?? `Voice runtime failed (${code}). Check the reported stage and settings, then retry.`)

export class RuntimeManager {
  constructor(rt, { spawnProcess = spawn, createBridge = options => new VoiceBridgeServer(options) } = {}) {
    this.rt = rt
    this.spawnProcess = spawnProcess
    this.createBridge = createBridge
    this.child = null
    this.preparation = null
    this.bridge = null
    this.state = 'stopped'
    this.error = ''
    this.lastError = ''
    this.lastOutput = ''
    this.activeBotId = ''
    this.wakeSessionId = ''
    this.activityEpoch = randomUUID()
    this.generation = 0
    this.stage = ''
    this.errorCode = ''
    this.lastResult = ''
    this.metrics = emptyPhoneAgentMetrics()
    this.diagnosticCommandPath = voiceRuntimeDiagnosticsCommandPath()
    this.runtimeReady = false
    this.starting = false
    this.timeout = null
  }

  view() {
    return {
      state: this.state,
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.bridge?.view?.().port ? { bridgePort: this.bridge.view().port } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastOutput ? { lastOutput: this.lastOutput } : {}),
      metrics: this.metrics,
      ...(this.activeBotId ? { activeBotId: this.activeBotId } : {}),
      ...(this.wakeSessionId ? { wakeSessionId: this.wakeSessionId } : {}),
    }
  }

  async start(config) {
    if (this.state === 'error' && (this.child || this.preparation)) await this.stop()
    if (this.child || this.preparation || this.starting) return this.view()
    const generation = ++this.generation
    try { unlinkSync(this.diagnosticCommandPath) } catch { /* no pending voiceprint test */ }
    this.starting = true
    this.runtimeReady = false
    this.state = 'starting'
    this.stage = 'environment_checking'
    this.error = ''
    this.errorCode = ''
    this.lastError = ''
    this.lastOutput = ''
    this.lastResult = ''
    this.metrics = emptyPhoneAgentMetrics()
    this.activeBotId = ''
    this.wakeSessionId = ''
    this.activityEpoch = randomUUID()
    this.setTimeout(15 * 60_000, generation)
    try { config = migratePhoneAgentOwnedConfig(config) }
    catch { this.fail('tts_config_migration_failed', generation); return this.view() }
    if (config.ttsConfigPath && resolve(config.ttsConfigPath) !== resolve(voiceRuntimeEnvironmentRoot(), '..', 'voice-runtime-private', '.env.tts')) {
      this.fail('tts_config_migration_failed', generation)
      return this.view()
    }
    try {
      const launch = voiceRuntimePreparationLaunch()
      const child = this.spawnProcess(launch.command, launch.args, { cwd: launch.cwd, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
      this.preparation = child
      this.watchOutput(child, generation, false)
      child.on('error', () => this.fail('python_312_required', generation))
      child.on('close', code => {
        if (generation !== this.generation || this.preparation !== child) return
        this.preparation = null
        if (code !== 0) { this.fail(this.errorCode || 'environment_setup_failed', generation); return }
        void this.launchRuntime(config, generation).catch(() => this.fail('runtime_exited', generation))
      })
    } catch { this.fail('python_312_required', generation) }
    return this.view()
  }

  setTimeout(milliseconds, generation) {
    clearTimeout(this.timeout)
    this.timeout = setTimeout(() => this.fail('startup_timeout', generation), milliseconds)
    this.timeout.unref?.()
  }

  watchOutput(child, generation, runtime) {
    const parser = createPhoneAgentRuntimeParser((change, type, event) => {
      if (generation !== this.generation) return
      if (type === 'runtime.ready' && runtime) {
        this.runtimeReady = true
        this.starting = false
        clearTimeout(this.timeout)
      } else if (change.state && change.state !== 'error' && (!runtime || !this.runtimeReady)) {
        delete change.state
      }
      Object.assign(this, change)
      recordPhoneAgentMetric(this.metrics, event)
      if (this.errorCode) this.error = runtimeFailure(this.errorCode)
    })
    child.stdout?.on('data', data => {
      if (generation !== this.generation) return
      parser.write(data)
      this.lastOutput = parser.output()
    })
    child.stderr?.on('data', () => {
      if (generation === this.generation) this.lastError = 'The speech provider wrote diagnostic output. Structured status and error codes are shown above.'
    })
  }

  killProcess(child) {
    if (!child || child.killed) return
    // The preparer can own pip/model subprocesses. Stop its complete Windows tree.
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      const killer = this.spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
    } else child.kill()
  }

  fail(code, generation) {
    if (generation !== this.generation) return
    ++this.generation
    clearTimeout(this.timeout)
    this.starting = false
    this.state = 'error'
    this.errorCode = code
    this.error = runtimeFailure(code)
    this.killProcess(this.preparation)
    this.killProcess(this.child)
    this.preparation = null
    this.child = null
    const bridge = this.bridge
    this.bridge = null
    void bridge?.stop?.()
  }

  async launchRuntime(config, generation) {
    if (generation !== this.generation) return
    this.stage = 'bridge_connecting'
    this.setTimeout(120_000, generation)
    const credential = randomUUID()
    const bridge = this.createBridge({
      rt: this.rt,
      deviceId: config.deviceId,
      credential,
      activityEpoch: this.activityEpoch,
      getRoles: () => createVoiceRoleRoster(this.rt.state, this.activityEpoch, botId => this.rt.chatOf(botId)),
    })
    try {
      const bridgeView = await bridge.start({ host: '127.0.0.1', port: 0 })
      if (generation !== this.generation) { await bridge.stop(); return }
      const launch = voiceRuntimeLaunch(config)
      const environment = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        DS_BOT_BRIDGE_URL: `ws://127.0.0.1:${bridgeView.port}`,
        DS_BOT_BRIDGE_CREDENTIAL: credential,
        DS_BOT_DEVICE_ID: config.deviceId,
        DS_BOT_TARGET_ID: config.targetId,
        DS_BOT_CONTINUATION_CONFIG: voiceRuntimeContinuationConfigPath(),
        DS_BOT_VOICE_DIAGNOSTICS_COMMAND: this.diagnosticCommandPath,
        DS_BOT_VOICE_CONFIG: JSON.stringify({
          ...config,
          runtimeRoot: undefined,
          pythonPath: undefined,
          configPath: undefined,
        }),
      }
      const child = this.spawnProcess(launch.command, launch.args, { cwd: launch.cwd, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      this.bridge = bridge
      this.child = child
      this.stage = 'runtime_starting'
      this.watchOutput(child, generation, true)
      child.on('error', () => this.fail('runtime_launch_failed', generation))
      child.on('close', () => this.fail(this.errorCode || 'runtime_exited', generation))
    } catch {
      await bridge.stop().catch(() => {})
      this.fail('bridge_start_failed', generation)
    }
  }

  async stop() {
    ++this.generation
    clearTimeout(this.timeout)
    const child = this.child
    this.state = 'stopped'; this.error = ''; this.errorCode = ''; this.stage = ''; this.lastResult = ''
    this.starting = false; this.runtimeReady = false; this.activeBotId = ''; this.wakeSessionId = ''
    this.child = null
    this.killProcess(child)
    this.killProcess(this.preparation)
    this.preparation = null
    const bridge = this.bridge
    this.bridge = null
    try { unlinkSync(this.diagnosticCommandPath) } catch { /* no pending voiceprint test */ }
    await bridge?.stop?.()
    return this.view()
  }

  sessionEvent(session, event) { this.bridge?.sessionEvent(session, event) }
  rolesChanged() { this.bridge?.rolesChanged() }
  diagnose(config) { return phoneAgentRuntimeDiagnostics(config, this.view()) }
  resetMetrics() { this.metrics = emptyPhoneAgentMetrics(); return this.view() }
  requestVoiceprintCommand(mode, segmentId) {
    if (!this.child || !this.runtimeReady) throw new Error('Voice runtime is not ready for a voiceprint test')
    if (!['voiceprint', 'voiceprint_label', 'voiceprint_apply', 'voiceprint_discard'].includes(mode)) throw new Error('Unknown voiceprint command')
    if (mode === 'voiceprint_label' && (!Number.isInteger(segmentId) || segmentId < 0)) throw new Error('A voiceprint test segment is required')
    mkdirSync(dirname(this.diagnosticCommandPath), { recursive: true, mode: 0o700 })
    const payload = { mode, created_at: new Date().toISOString() }
    if (mode === 'voiceprint_label') payload.segment_id = segmentId
    writeFileSync(this.diagnosticCommandPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    return this.view()
  }
  requestVoiceprintTest() { return this.requestVoiceprintCommand('voiceprint') }
  labelVoiceprintSample(segmentId) { return this.requestVoiceprintCommand('voiceprint_label', segmentId) }
  applyVoiceprintSamples() { return this.requestVoiceprintCommand('voiceprint_apply') }
  discardVoiceprintSamples() { return this.requestVoiceprintCommand('voiceprint_discard') }
}

export function install(rt) {
  const { state } = rt
  const desktop = process.env.DS_BOT_APP === '1' || rt.ctx.get?.('profileContext')?.name === 'desktop'
  const imported = desktop ? existingRuntimeDefaults() : {}
  const applyImportedDefaults = () => {
    state.prefs ??= {}
    let current = state.prefs.phoneAgent
    if (desktop) {
      try { current = migratePhoneAgentContinuationConfig(current) } catch { /* the runtime reports unavailable private settings */ }
    }
    const normalized = normalizePhoneAgentConfig(mergePhoneAgentDefaults(current, imported))
    let next = normalized
    if (desktop) {
      // A private-file failure belongs to the voice plugin, not host startup.
      // The manager reports it when the enabled plugin starts.
      try { next = migratePhoneAgentOwnedConfig(normalized) } catch { /* retain the source for a retry */ }
    }
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
    if (!desktop) return () => {}
    queueMicrotask(() => {
      if (stopped) return
      void rt.load().then(() => {
        if (stopped || !applyImportedDefaults()) return
        return rt.save()
      }).catch(() => {})
    })
    return () => { stopped = true }
  }, 'ds-bot: Phone Agent runtime defaults')
  const manager = new RuntimeManager(rt)
  rt.phoneAgentStateSaved = () => manager.rolesChanged()
  rt.ctx.on('session/event', (session, event) => manager.sessionEvent(session, event))
  const save = async () => { applyImportedDefaults(); await rt.save(); return phoneAgentView(state, manager.view()) }
  const phoneAgent = () => { applyImportedDefaults(); return phoneAgentView(state, manager.view()) }
  const phoneAgentUpdate = async body => {
    applyImportedDefaults()
    const wasRunning = Boolean(manager.child || manager.preparation || manager.starting)
    if (body?.config !== undefined) state.prefs.phoneAgent = normalizePhoneAgentConfig({ ...state.prefs.phoneAgent, ...body.config })
    if (body?.botId !== undefined) updatePhoneAgentProfile(state, String(body.botId), body.profile ?? {})
    await save()
    manager.rolesChanged()
    if (!state.prefs.phoneAgent.enabled) await manager.stop()
    else if (process.env.DS_BOT_APP === '1') {
      if (wasRunning) await manager.stop()
      await manager.start(state.prefs.phoneAgent)
    }
    return phoneAgent()
  }
  const phoneAgentStart = async () => {
    if (process.env.DS_BOT_APP !== '1') throw new Error('Managed Windows voice runtime is available in the DS Bot Desktop app')
    applyImportedDefaults(); state.prefs.phoneAgent.enabled = true; await rt.save(); await manager.start(state.prefs.phoneAgent); return phoneAgent()
  }
  const phoneAgentStop = async () => { state.prefs.phoneAgent.enabled = false; await manager.stop(); return save() }
  const phoneAgentTest = () => ({ ...phoneAgent(), diagnostics: manager.diagnose(state.prefs.phoneAgent) })
  const phoneAgentDiagnosticsReset = () => { manager.resetMetrics(); return phoneAgent() }
  const phoneAgentVoiceprintTest = () => { manager.requestVoiceprintTest(); return phoneAgent() }
  const phoneAgentVoiceprintLabel = segmentId => { manager.labelVoiceprintSample(segmentId); return phoneAgent() }
  const phoneAgentVoiceprintApply = () => { manager.applyVoiceprintSamples(); return phoneAgent() }
  const phoneAgentVoiceprintDiscard = () => { manager.discardVoiceprintSamples(); return phoneAgent() }
  const phoneAgentSubmit = body => submitPhoneAgentInput(rt, body)
  Object.assign(rt, { phoneAgent, phoneAgentUpdate, phoneAgentStart, phoneAgentStop, phoneAgentTest, phoneAgentDiagnosticsReset,
    phoneAgentVoiceprintTest, phoneAgentVoiceprintLabel, phoneAgentVoiceprintApply, phoneAgentVoiceprintDiscard, phoneAgentSubmit })
  // Only the packaged Desktop host owns local Windows processes. Web hosts may
  // load the plugin and display its settings, but must never spawn audio.
  const desktopRuntime = process.env.DS_BOT_APP === '1'
  rt.ctx.effect(() => {
    let stopped = false
    if (!desktopRuntime) return () => {}
    queueMicrotask(() => {
      if (stopped) return
      void rt.load().then(async () => {
        if (stopped || !state.prefs.phoneAgent.enabled) return
        const view = await manager.start(state.prefs.phoneAgent)
        if (view.state === 'error') rt.warn('ds-bot: managed voice runtime failed to start: %s', view.error)
      }).catch(error => rt.warn('ds-bot: managed voice runtime setup failed: %s', error))
    })
    return () => { stopped = true; void manager.stop() }
  }, 'ds-bot: managed voice runtime')
}
