import test from 'node:test'
import assert from 'node:assert/strict'
import * as phoneAgent from '../src/host/phone-agent.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appendPhoneAgentOutput, defaultPhoneAgentConfig, mergePhoneAgentDefaults, normalizePhoneAgentConfig, phoneAgentDefaultsFromRuntime, phoneAgentEnvironmentFromRuntime, phoneAgentProjectRoot, phoneAgentRuntimeEvent, submitPhoneAgentInput, updatePhoneAgentProfile, phoneAgentView, phoneAgentRuntimeDiagnostics, voiceRuntimeLaunch } from '../src/host/phone-agent.js'

test('fills legacy empty Phone Agent fields from imported defaults', () => {
  const current = { ...defaultPhoneAgentConfig(), deviceId: 'windows-dsbot-01', targetId: 'windows-dsbot-01', runtimeRoot: '', configPath: '', asrModelDir: '' }
  const imported = { ...defaultPhoneAgentConfig(), deviceId: 'windows-office-01', targetId: 'windows-office-01', runtimeRoot: 'E:/project_space/phone_agent', configPath: 'D:/phone_agent_runtime/rebuild/device-smoke/runtime.json', asrModelDir: 'D:/models/asr' }
  const value = mergePhoneAgentDefaults(current, imported)
  assert.equal(value.deviceId, 'windows-office-01')
  assert.equal(value.runtimeRoot, 'E:/project_space/phone_agent')
  assert.equal(value.configPath, 'D:/phone_agent_runtime/rebuild/device-smoke/runtime.json')
  assert.equal(value.asrModelDir, 'D:/models/asr')
})

test('uses the bundled DS Bot voice runtime instead of the sibling Phone Agent checkout', () => {
  assert.match(phoneAgentProjectRoot(), /ds-bot[\\/]voice-runtime$/)
})

test('defaults the managed voice plugin to enabled and launches the bundled runtime', () => {
  assert.equal(defaultPhoneAgentConfig().enabled, true)
  assert.equal(defaultPhoneAgentConfig().ttsVoice, 'longanlingxi_v3.1')
  const launch = voiceRuntimeLaunch({ pythonPath: 'python', runtimeRoot: 'E:/project_space/ds-bot-dfl/ds-bot/voice-runtime' })
  assert.match(launch.command, /voice-runtime-env[\\/](Scripts[\\/]python\.exe|bin[\\/]python)$/)
  assert.deepEqual(launch.args, ['-u', 'main.py'])
  assert.match(launch.cwd, /ds-bot[\\/]voice-runtime$/)
})

test('runtime state includes the stage and safe failure code, and only ready declares listening', () => {
  assert.deepEqual(phoneAgentRuntimeEvent('{"type":"runtime.progress","stage":"models_loading"}'), { stage: 'models_loading' })
  assert.deepEqual(phoneAgentRuntimeEvent('{"type":"runtime.state","state":"error","stage":"owner_verification","error_code":"owner_profile_missing","text":"private transcript","credential":"secret"}'), {
    state: 'error', stage: 'owner_verification', errorCode: 'owner_profile_missing',
  })
  assert.deepEqual(phoneAgentRuntimeEvent('{"type":"runtime.ready","state":"listening"}'), { state: 'listening', stage: 'listening', error: '', errorCode: '' })
  assert.deepEqual(phoneAgentRuntimeEvent('{"type":"runtime.state","state":"listening","error_code":""}'), { state: 'listening', errorCode: '', error: '' })
})

test('stream parser preserves split JSON and removes private provider output', () => {
  const events = []
  const parser = phoneAgent.createPhoneAgentRuntimeParser(value => events.push(value))
  parser.write('{"type":"runtime.progress","sta')
  assert.equal(events.length, 0)
  parser.write('ge":"asr_loading","api_key":"secret"}\r\n{"type":"runtime.ready"}\n')
  assert.deepEqual(events, [{ stage: 'asr_loading' }, { state: 'listening', stage: 'listening', error: '', errorCode: '' }])
  assert.doesNotMatch(parser.output(), /secret|api_key/)
  parser.write('provider printed private transcript and credential\n')
  assert.doesNotMatch(parser.output(), /private transcript|credential/)
})

test('sanitized diagnostics retain integer segment IDs, identity outcomes and nested wake counters', () => {
  const parser = phoneAgent.createPhoneAgentRuntimeParser(() => {})
  parser.write('{"type":"identity.verified","segment_id":7,"text":"private transcript","pcm":[1,2]}\n')
  parser.write('{"type":"identity.rejected","segment_id":8,"credential":"private-key"}\n')
  parser.write('{"type":"windows.wake.audio","frames":24,"wake_diagnostics":{"frames":12,"keyword_results":3,"valid_hits":2,"utterance_boundaries":1,"text":"private transcript","credential":"private-key"}}\n')
  const lines = parser.output().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines, [
    { type: 'identity.verified', segment_id: 7 },
    { type: 'identity.rejected', segment_id: 8 },
    { type: 'windows.wake.audio', frames: 24, wake_diagnostics: { frames: 12, keyword_results: 3, valid_hits: 2, utterance_boundaries: 1 } },
  ])
  assert.doesNotMatch(parser.output(), /private transcript|private-key|pcm/)
})

test('runtime view survives page loads with structured startup and segment diagnostics', () => {
  const state = { prefs: { phoneAgent: defaultPhoneAgentConfig() }, bots: {} }
  const runtime = { state: 'starting', stage: 'environment_installing', errorCode: 'dependency_install_failed', lastResult: 'owner_rejected' }
  assert.deepEqual(phoneAgentView(state, runtime).runtime, runtime)
})

test('normalizes supported continuation mode, thresholds and model device', () => {
  const value = normalizePhoneAgentConfig({ continuationMode: 'frozen_llm', continuationAcceptThreshold: .8, continuationRejectThreshold: .2, modelDevice: 'cpu' })
  assert.equal(value.continuationMode, 'frozen_llm')
  assert.equal(value.continuationAcceptThreshold, .8)
  assert.equal(value.continuationRejectThreshold, .2)
  assert.equal(value.modelDevice, 'cpu')
  assert.equal(defaultPhoneAgentConfig().continuationAcceptThreshold, .8)
  assert.equal(defaultPhoneAgentConfig().continuationRejectThreshold, .25)
  assert.throws(() => normalizePhoneAgentConfig({ continuationAcceptThreshold: .5, continuationRejectThreshold: .5 }), /reject threshold/)
})

test('imports TTS configuration into DS Bot private storage once without copying unrelated credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-voice-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir())))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'external.env')
  writeFileSync(source, 'TTS_API_KEY=sample-tts-key\nTTS_MODEL=qwen\nUNRELATED_SECRET=must-not-copy\n')
  const result = phoneAgent.migratePhoneAgentOwnedConfig({ ...defaultPhoneAgentConfig(), ttsConfigPath: source }, join(root, 'private'))
  assert.equal(result.ttsConfigPath, join(root, 'private', '.env.tts'))
  assert.match(readFileSync(result.ttsConfigPath, 'utf8'), /TTS_API_KEY=sample-tts-key/)
  assert.doesNotMatch(readFileSync(result.ttsConfigPath, 'utf8'), /UNRELATED_SECRET|must-not-copy/)
  rmSync(source)
  assert.deepEqual(phoneAgent.migratePhoneAgentOwnedConfig(result, join(root, 'private')), result)
})

test('imports an explicit replacement TTS source and retains the rotated owned key after source removal', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-tts-replacement-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir())))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceA = join(root, 'a.env'), sourceB = join(root, 'b.env'), privateRoot = join(root, 'private')
  writeFileSync(sourceA, 'TTS_API_KEY=first-provider-key\nTTS_MODEL=old-model\n')
  const initial = phoneAgent.migratePhoneAgentOwnedConfig({ ...defaultPhoneAgentConfig(), ttsConfigPath: sourceA }, privateRoot)
  writeFileSync(sourceB, 'TTS_API_KEY=rotated-provider-key\nTTS_MODEL=new-model\nUNRELATED_SECRET=private-other-key\n')
  const replacement = phoneAgent.migratePhoneAgentOwnedConfig({ ...initial, ttsConfigPath: sourceB }, privateRoot)
  assert.equal(replacement.ttsConfigPath, initial.ttsConfigPath)
  assert.match(readFileSync(replacement.ttsConfigPath, 'utf8'), /TTS_API_KEY=rotated-provider-key/)
  assert.match(readFileSync(replacement.ttsConfigPath, 'utf8'), /TTS_MODEL=new-model/)
  assert.doesNotMatch(readFileSync(replacement.ttsConfigPath, 'utf8'), /first-provider-key|private-other-key/)
  rmSync(sourceA); rmSync(sourceB)
  assert.deepEqual(phoneAgent.migratePhoneAgentOwnedConfig(replacement, privateRoot), replacement)
  const view = phoneAgentView({ prefs: { phoneAgent: replacement }, bots: {} })
  assert.doesNotMatch(JSON.stringify(view), /rotated-provider-key|first-provider-key|private-other-key/)
})

test('keeps an invalid TTS source available for repair and only switches paths after a successful import', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-tts-retry-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir())))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source.env'), privateRoot = join(root, 'private'), owned = join(privateRoot, '.env.tts')
  writeFileSync(source, 'TTS_MODEL=qwen\n')
  const requested = { ...defaultPhoneAgentConfig(), ttsConfigPath: source }
  const pending = phoneAgent.migratePhoneAgentOwnedConfig(requested, privateRoot)
  assert.deepEqual(pending, requested)
  assert.equal(existsSync(owned), false)
  writeFileSync(source, 'TTS_API_KEY=repaired-provider-key\nTTS_MODEL=qwen\n')
  const repaired = phoneAgent.migratePhoneAgentOwnedConfig(pending, privateRoot)
  assert.equal(repaired.ttsConfigPath, owned)
  assert.match(readFileSync(owned, 'utf8'), /repaired-provider-key/)
  writeFileSync(source, 'TTS_MODEL=invalid-replacement\n')
  assert.equal(phoneAgent.migratePhoneAgentOwnedConfig({ ...repaired, ttsConfigPath: source }, privateRoot).ttsConfigPath, source)
  assert.match(readFileSync(owned, 'utf8'), /repaired-provider-key/)
})

test('never launches a runtime using a source TTS configuration that has not imported successfully', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-tts-unimported-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir())))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source.env')
  writeFileSync(source, 'TTS_MODEL=qwen\n')
  let spawned = false
  const manager = new phoneAgent.RuntimeManager({}, { spawnProcess: () => { spawned = true; throw new Error('must not spawn') } })
  const result = await manager.start({ ...defaultPhoneAgentConfig(), ttsConfigPath: source })
  assert.equal(result.errorCode, 'tts_config_migration_failed')
  assert.equal(spawned, false)
  await manager.stop()
})

test('migrates the supported continuation provider once and preserves explicit user settings', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-continuation-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir())))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceEnvPath = join(root, 'external.env'), candidatePath = join(root, 'candidate.json'), privateRoot = join(root, 'private')
  writeFileSync(sourceEnvPath, 'base_url=https://api.deepseek.com/\nmodel=deepseek-flash\napikey=sample-provider-key\nUNRELATED_SECRET=must-not-copy\n')
  writeFileSync(candidatePath, JSON.stringify({ continuation_mode: 'frozen_llm', continuation_model: 'deepseek-flash-continuation-prompt-v2-053', continuation_url: 'http://127.0.0.1:30223/v1/systemone' }))
  const options = { sourceEnvPath, candidatePath, privateRoot }
  const result = phoneAgent.migratePhoneAgentContinuationConfig({ continuationUrl: '' }, options)
  assert.equal(result.continuationUrl, '')
  assert.equal(result.continuationModel, 'deepseek-flash-continuation-prompt-v2-053')
  assert.equal(result.continuationMode, 'frozen_llm')
  const privateFile = readFileSync(join(privateRoot, 'continuation.env'), 'utf8')
  assert.match(privateFile, /API_KEY=sample-provider-key/)
  assert.doesNotMatch(privateFile, /must-not-copy|UNRELATED_SECRET/)
  rmSync(sourceEnvPath)
  assert.deepEqual(phoneAgent.migratePhoneAgentContinuationConfig(result, options), result)
  const explicit = { continuationUrl: 'http://127.0.0.1:31337/v1/systemone', continuationModel: 'custom-nli', continuationMode: 'legacy_nli' }
  assert.deepEqual(phoneAgent.migratePhoneAgentContinuationConfig(explicit, options), explicit)
})

test('host waits for validated setup and runtime.ready, parses split events and ignores stopped generations', async () => {
  const children = []
  const bridge = { start: async () => ({ port: 4567 }), stop: async () => {}, view: () => ({ port: 4567 }) }
  const manager = new phoneAgent.RuntimeManager({ state: { bots: {} }, chatOf: () => 'session' }, {
    createBridge: () => bridge,
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true } })
      children.push(child)
      return child
    },
  })
  const started = await manager.start(defaultPhoneAgentConfig())
  assert.equal(started.state, 'starting')
  assert.equal(children.length, 1)
  children[0].emit('close', 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(children.length, 2)
  assert.equal(manager.view().state, 'starting')
  children[1].stdout.write('{"type":"runtime.state","state":"listening"}\n')
  assert.equal(manager.view().state, 'starting')
  children[1].stdout.write('{"type":"runtime.re')
  children[1].stdout.write('ady"}\n')
  assert.equal(manager.view().state, 'listening')
  children[1].stdout.write('{"type":"runtime.state","state":"listening","error_code":"owner_rejected"}\n')
  assert.equal(manager.view().errorCode, 'owner_rejected')
  children[1].stdout.write('{"type":"runtime.state","state":"listening","error_code":""}\n')
  assert.equal(manager.view().error, undefined)
  children[1].stdout.write('{"type":"runtime.wake","bot_id":"bot-a","wake_session_id":"wake-a"}\n')
  children[1].stdout.write('{"type":"runtime.state","state":"listening","stage":"waiting_for_reply"}\n')
  assert.equal(manager.view().activeBotId, 'bot-a')
  assert.equal(manager.view().wakeSessionId, 'wake-a')
  for (const stage of ['waiting_for_wake', 'bridge_reconnecting', 'wake_mapping']) {
    children[1].stdout.write('{"type":"runtime.wake","bot_id":"bot-a","wake_session_id":"wake-a"}\n')
    children[1].stdout.write(`${JSON.stringify({ type: 'runtime.state', state: 'listening', stage })}\n`)
    assert.equal(manager.view().activeBotId, undefined, stage)
    assert.equal(manager.view().wakeSessionId, undefined, stage)
  }
  await manager.stop()
  children[1].stdout.write('{"type":"runtime.wake","bot_id":"old","wake_session_id":"old"}\n')
  children[1].emit('close', 1)
  assert.equal(manager.view().state, 'stopped')
  assert.equal(manager.view().activeBotId, undefined)
})

test('failed environment preparation is actionable, keeps the failed stage and supports retry', async () => {
  const children = []
  const manager = new phoneAgent.RuntimeManager({}, { spawnProcess: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} })
    children.push(child); return child
  }, createBridge: () => assert.fail('must not open Bridge before setup succeeds') })
  await manager.start(defaultPhoneAgentConfig())
  children[0].stdout.write('{"type":"runtime.state","state":"error","stage":"environment_installing","error_code":"dependency_install_failed"}\n')
  children[0].emit('close', 1)
  assert.equal(manager.view().state, 'error')
  assert.equal(manager.view().stage, 'environment_installing')
  assert.match(manager.view().error, /network connection.*disk space.*retry/)
  await manager.start(defaultPhoneAgentConfig())
  assert.equal(manager.view().state, 'starting')
  assert.equal(manager.view().errorCode, undefined)
  await manager.stop()
})

test('Retry restarts an existing runtime process that reported an error', async () => {
  const children = []
  let bridgeStops = 0
  const bridge = { start: async () => ({ port: 4567 }), stop: async () => { bridgeStops++ }, view: () => ({ port: 4567 }) }
  const manager = new phoneAgent.RuntimeManager({ state: { bots: {} } }, {
    createBridge: () => bridge,
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true } })
      children.push(child); return child
    },
  })
  await manager.start(defaultPhoneAgentConfig())
  children[0].emit('close', 0)
  await new Promise(resolve => setImmediate(resolve))
  children[1].stdout.write('{"type":"runtime.ready"}\n{"type":"runtime.state","state":"error","stage":"asr","error_code":"asr_failed"}\n')
  assert.equal(manager.view().state, 'error')
  const result = await manager.start(defaultPhoneAgentConfig())
  assert.equal(children[1].killed, true)
  assert.equal(bridgeStops, 1)
  assert.equal(children.length, 3)
  assert.equal(result.state, 'starting')
  assert.equal(result.errorCode, undefined)
  await manager.stop()
})

test('normal saved Bot state has a hook that refreshes the managed voice roster', t => {
  let refreshed = 0
  const original = phoneAgent.RuntimeManager.prototype.rolesChanged
  phoneAgent.RuntimeManager.prototype.rolesChanged = () => { refreshed++ }
  t.after(() => { phoneAgent.RuntimeManager.prototype.rolesChanged = original })
  const rt = { state: { prefs: {}, bots: {} }, ctx: { get: () => undefined, effect() {}, on() {} }, save: async () => {}, load: async () => {} }
  phoneAgent.install(rt)
  assert.equal(typeof rt.phoneAgentStateSaved, 'function')
  rt.phoneAgentStateSaved()
  assert.equal(refreshed, 1)
})

test('passes local Bridge credentials to the Windows launcher without exposing them in the view', () => {
  const env = phoneAgentEnvironmentFromRuntime({ bridge_credential: 'bridge-secret' }, { EXISTING: 'keep' })
  assert.equal(env.EXISTING, 'keep')
  assert.equal(env.DS_BOT_BRIDGE_CREDENTIAL, 'bridge-secret')
  assert.equal(env.CHANNEL_BRIDGE_VOICE_CREDENTIAL, undefined)
})

test('imports recorded Windows runtime settings into Phone Agent defaults', () => {
  const value = phoneAgentDefaultsFromRuntime({
    device_id: 'meizu-18x', room: 'owner-device-smoke', livekit_url: 'ws://127.0.0.1:7880',
    asr_model_dir: 'D:/models/asr', speaker_model_dir: 'D:/models/speaker', speaker_profile_dir: 'D:/voice/profile',
    tts_config_path: 'E:/phone_agent/.env.tts', wake_first_turn_timeout: 8, wake_continuation_timeout: 12,
  }, {
    device_id: 'windows-office-01', target_id: 'windows-office-01', windows_input_device_name: 'C01',
    windows_audio_backend: 'media_devices',
  }, { TTS_MODEL: 'qwen-audio-3.1-tts-flash', TTS_VOICE: 'longshao_v3.1' }, {
    runtimeRoot: 'D:/phone_agent_runtime', configPath: 'D:/phone_agent_runtime/rebuild/device-smoke/runtime.json',
  }, { input_device: 'Microphone (C01)', output_device: 'Speakers (Philips)' })
  assert.equal(value.deviceId, 'windows-office-01')
  assert.equal(value.inputDeviceName, 'C01')
  assert.equal(value.asrModelDir, 'D:/models/asr')
  assert.equal(value.ttsModel, 'qwen-audio-3.1-tts-flash')
  assert.equal(value.ttsVoice, 'longshao_v3.1')
  assert.equal(value.outputDeviceName, 'Speakers (Philips)')
  assert.equal(value.runtimeRoot, 'D:/phone_agent_runtime')
  assert.equal(value.configPath, 'D:/phone_agent_runtime/rebuild/device-smoke/runtime.json')
})

test('normalizes a safe Windows-first Phone Agent configuration', () => {
  const value = normalizePhoneAgentConfig({
    enabled: true,
    deviceId: ' win-office-01 ',
    inputDeviceName: 'Microphone (C01)',
    outputDeviceName: 'Speakers',
    continuationEnabled: true,
    continuationModel: 'continuation-v1',
  })
  assert.equal(value.enabled, true)
  assert.equal(value.deviceId, 'win-office-01')
  assert.equal(value.inputDeviceName, 'Microphone (C01)')
  assert.equal(value.continuationEnabled, true)
  assert.equal(value.continuationModel, 'continuation-v1')
})

test('rejects duplicate wake names on one device', () => {
  const state = { prefs: { phoneAgent: defaultPhoneAgentConfig() }, bots: {
    a: { id: 'a', name: 'Alpha', phoneAgent: { wakeName: '流明' } },
    b: { id: 'b', name: 'Beta', phoneAgent: { wakeName: 'beta' } },
  } }
  assert.throws(() => updatePhoneAgentProfile(state, 'b', { wakeName: ' 流明 ' }), /already used by Alpha/)
})

test('redacts credentials and runtime internals from the client view', () => {
  const state = { prefs: { phoneAgent: {
    ...defaultPhoneAgentConfig(),
    bridgeCredential: 'secret',
    livekitSecret: 'secret2',
    runtimeRoot: 'E:/private',
  } }, bots: { a: { id: 'a', name: 'Alpha', phoneAgent: { wakeName: 'alpha', ttsVoice: 'voice-a' } } } }
  const view = phoneAgentView(state, { state: 'ready', pid: 12 })
  assert.equal(view.config.bridgeCredential, undefined)
  assert.equal(view.config.livekitSecret, undefined)
  assert.equal(view.config.runtimeRoot, undefined)
  assert.equal(view.config.configPath, undefined)
  assert.equal(view.config.pythonPath, undefined)
  assert.deepEqual(view.bots, [{ id: 'a', name: 'Alpha', wakeName: 'alpha', ttsVoice: 'voice-a' }])
})

test('keeps runtime diagnostics visible for the status and self-test panels', () => {
  const state = { prefs: { phoneAgent: defaultPhoneAgentConfig() }, bots: {} }
  const view = phoneAgentView(state, {
    state: 'error', pid: 12, bridgePort: 4567,
    error: 'DS Bot voice runtime exited (1)',
    lastError: 'ModuleNotFoundError: No module named jsonschema',
    lastOutput: '{"type":"runtime.starting"}',
  })
  assert.deepEqual(view.runtime, {
    state: 'error', pid: 12, bridgePort: 4567,
    error: 'DS Bot voice runtime exited (1)',
    lastError: 'ModuleNotFoundError: No module named jsonschema',
    lastOutput: '{"type":"runtime.starting"}',
  })
})

test('keeps the bounded runtime stdout history for audio readiness diagnostics', () => {
  const value = appendPhoneAgentOutput('', '{"type":"windows.audio.input_ready"}\n{"type":"runtime.ready"}\n')
  assert.match(value, /windows\.audio\.input_ready/)
  assert.match(value, /runtime\.ready/)
  assert.ok(value.length <= 2000)
})

test('records the Bot selected by a runtime wake event', () => {
  assert.deepEqual(phoneAgentRuntimeEvent('{"type":"runtime.wake","bot_id":"b","wake_session_id":"wake-1"}'), {
    activeBotId: 'b', wakeSessionId: 'wake-1',
  })
  assert.deepEqual(phoneAgentRuntimeEvent('{"type":"windows.wake.audio","frames":1}'), {})
})

test('self-test checks the bundled runtime boundary and current process state', () => {
  const result = phoneAgentRuntimeDiagnostics(defaultPhoneAgentConfig(), { state: 'error', lastError: 'boom' })
  assert.equal(result.bundledRuntime, true)
  assert.equal(result.processState, 'error')
  assert.equal(result.lastError, 'boom')
  assert.equal(phoneAgentRuntimeDiagnostics(defaultPhoneAgentConfig(), { state: 'starting' }).status, 'error')
})

test('uses Bot names and the recorded global TTS voice for new Bot profiles', () => {
  const state = { prefs: { phoneAgent: { ...defaultPhoneAgentConfig(), ttsVoice: 'longshao_v3.1' } }, bots: { a: { id: 'a', name: 'Chief' } } }
  const view = phoneAgentView(state)
  assert.deepEqual(view.bots, [{ id: 'a', name: 'Chief', wakeName: 'Chief', ttsVoice: 'longshao_v3.1' }])
})

test('submits an owner-verified transcript through the Bot session controller', async () => {
  const calls = []
  const rt = {
    botOf: id => id === 'a' ? { id: 'a' } : undefined,
    chatOf: () => 'session-a',
    ensureCapabilities: async id => calls.push(['capabilities', id]),
    ctx: { sessionController: { prompt: async value => calls.push(['prompt', value]) } },
  }
  const result = await submitPhoneAgentInput(rt, { botId: 'a', text: '你好', speaker: { status: 'owner_verified' } })
  assert.equal(result.accepted, true)
  assert.equal(calls[0][0], 'capabilities')
  assert.equal(calls[1][1].sessionId, 'session-a')
  assert.equal(calls[1][1].content[0].text, '你好')
})
