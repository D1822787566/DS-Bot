import test from 'node:test'
import assert from 'node:assert/strict'
import { appendPhoneAgentOutput, defaultPhoneAgentConfig, mergePhoneAgentDefaults, normalizePhoneAgentConfig, phoneAgentDefaultsFromRuntime, phoneAgentEnvironmentFromRuntime, phoneAgentProjectRoot, submitPhoneAgentInput, updatePhoneAgentProfile, phoneAgentView, phoneAgentRuntimeDiagnostics, voiceRuntimeLaunch } from '../src/host/phone-agent.js'

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
  const launch = voiceRuntimeLaunch({ pythonPath: 'python', runtimeRoot: 'E:/project_space/ds-bot-dfl/ds-bot/voice-runtime' })
  assert.equal(launch.command, 'python')
  assert.deepEqual(launch.args, ['main.py'])
  assert.match(launch.cwd, /ds-bot[\\/]voice-runtime$/)
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

test('self-test checks the bundled runtime boundary and current process state', () => {
  const result = phoneAgentRuntimeDiagnostics(defaultPhoneAgentConfig(), { state: 'error', lastError: 'boom' })
  assert.equal(result.bundledRuntime, true)
  assert.equal(result.processState, 'error')
  assert.equal(result.lastError, 'boom')
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
