import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

const requireHarness = createRequire(new URL('../dev/harness/package.json', import.meta.url))
const { JSDOM } = requireHarness('jsdom')
const React = requireHarness('react')
const { createRoot } = requireHarness('react-dom/client')
const { act } = React
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/plugin-page.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})
const module = { exports: {} }
const context = { module, exports: module.exports, require: () => React }
runInNewContext(outputFiles[0].text, context)
const { BotPresets, PresetPicker, PhoneAgentSettings, openPluginManager, voiceTestSummary } = module.exports

async function mount(t, component, props) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  context.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  t.after(async () => { await act(() => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.IS_REACT_ACT_ENVIRONMENT })
  await act(async () => root.render(React.createElement(component, props)))
  return dom.window.document
}

test('unverified preset selection stays blocked until the user accepts its current report', async t => {
  let picked
  const document = await mount(t, PresetPicker, {
    actions: {
      plugins: async () => ({ presets: [{ id: 'learning' }] }),
      checkPreset: async () => ({ id: 'learning', status: 'unverified', bindable: false, fingerprint: 'current' }),
    },
    onChange: value => { picked = value },
  })
  const select = document.querySelector('select')
  await act(async () => { select.value = 'learning'; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
  assert.equal(picked.ready, false)
  assert.match(document.body.textContent, /Needs verification/)
  await act(async () => document.querySelector('input[type=checkbox]').click())
  assert.equal(picked.ready, true)
  assert.equal(picked.fingerprint, 'current')
})

test('the native plugin page opens after source setup and closes Bot overlays without changing the session', async () => {
  const calls = []
  let snapshot = { newChat: 'new', settings: {}, details: 'chief', menu: {}, memory: 'chief', voice: 'chief', palette: {}, exchange: [], currentSession: 'chief' }
  const ui = { set: update => { snapshot = update(snapshot) } }
  await openPluginManager({ actions: { plugins: async () => calls.push('sources') }, ui, navigation: { openList: () => calls.push('native') } })
  assert.deepEqual(calls, ['sources', 'native'])
  for (const field of ['newChat', 'settings', 'details', 'menu', 'memory', 'voice', 'palette', 'exchange']) assert.equal(snapshot[field], null, field)
  assert.equal(snapshot.currentSession, 'chief')
})

test('failed source setup does not open the native page or discard a Bot dialog', async () => {
  let opened = false
  await assert.rejects(openPluginManager({ actions: { plugins: async () => { throw new Error('offline') } }, ui: { set: () => assert.fail('dialog was closed') }, navigation: { openList: () => { opened = true } } }), /offline/)
  assert.equal(opened, false)
})

test('Phone Agent settings edits Bot wake names and voices through the host actions', async t => {
  const calls = []
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: false, deviceId: 'windows-dsbot-01', inputDeviceName: '', outputDeviceName: '', ttsModel: 'qwen', ttsVoice: 'default', continuationEnabled: true, continuationModel: '' }, bots: [{ id: 'a', name: 'Alpha', wakeName: 'alpha', ttsVoice: 'voice-a' }], runtime: { state: 'stopped' } }),
    phoneAgentUpdate: async value => { calls.push(value); return undefined },
    phoneAgentStart: async () => ({ runtime: { state: 'ready' } }),
    phoneAgentStop: async () => ({ runtime: { state: 'stopped' } }),
  } })
  assert.match(document.body.textContent, /Phone Agent/)
  const wake = document.querySelector('[data-phone-agent-field="a:wakeName"]')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(wake, 'new-alpha')
  await act(async () => {
    wake.dispatchEvent(new window.Event('input', { bubbles: true }))
    wake.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => wake.closest('.bt-phone-bot').querySelector('button').click())
  assert.equal(calls.at(-1).botId, 'a')
  assert.equal(calls.at(-1).profile.wakeName, 'new-alpha')
  assert.equal(calls.at(-1).profile.ttsVoice, 'voice-a')
})

test('Phone Agent settings exposes a self-test and runtime diagnostics', async t => {
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'error', error: 'runtime exited' } }),
    phoneAgentTest: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'error', error: 'runtime exited', lastError: 'missing dependency' }, diagnostics: {
      status: 'error', bundledRuntime: true, pythonCommand: 'python.exe', processState: 'error', lastError: 'missing dependency',
    } }),
  } })
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === 'Run self-test').click())
  assert.match(document.body.textContent, /Needs attention/)
  assert.match(document.body.textContent, /missing dependency/)
})

test('Phone Agent settings shows the latest runtime stdout for audio readiness', async t => {
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: {
      state: 'ready', lastOutput: '{"type":"windows.audio.input_ready","sample_rate":48000}',
    } }),
    phoneAgentTest: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'ready' }, diagnostics: {
      status: 'pass', bundledRuntime: true, pythonCommand: 'python.exe', processState: 'ready',
      lastOutput: '{"type":"windows.audio.input_ready","sample_rate":48000}',
    } }),
  } })
  assert.match(document.body.textContent, /windows\.audio\.input_ready/)
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === 'Run self-test').click())
  assert.match(document.body.textContent, /sample_rate/)
})

test('Phone Agent settings provides a voice test panel with wake and owner metrics', async t => {
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: {
      state: 'listening', metrics: { wakePublished: 3, wakeAccepted: 2, asrCompleted: 2, ownerVerified: 1, ownerRejected: 1, ownerLastScore: .42 },
    } }),
    phoneAgentDiagnosticsReset: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {} } }),
  } })
  assert.match(document.body.textContent, /Voice test panel/)
  assert.match(document.body.textContent, /Wake detections/)
  assert.match(document.body.textContent, /Owner verified/)
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === 'Clear test counters').click())
})

test('voice test summary explains when only near-silent microphone audio arrived', () => {
  const summary = voiceTestSummary({ microphoneFrames: 12051, microphonePeak: 1721, microphoneRms: .002,
    wakeKeywordResults: 0, wakePublished: 0, segmentEnded: 0, asrAttempted: 0, ownerVerified: 0 })
  assert.match(summary, /almost silent/)
  assert.match(summary, /ASR and owner verification did not run/)
})

test('Phone Agent settings shows the Bot selected by a wake event', async t => {
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [{ id: 'b', name: '华子' }], runtime: { state: 'listening', activeBotId: 'b' } }),
  } })
  assert.match(document.body.textContent, /Active Bot: 华子/)
})

test('Phone Agent settings restores startup stage and actionable failure from the host', async t => {
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: {
      state: 'error', stage: 'environment_installing', errorCode: 'dependency_install_failed', lastResult: 'owner_rejected',
    } }),
  } })
  assert.match(document.body.textContent, /Installing voice dependencies/)
  assert.match(document.body.textContent, /dependency_install_failed/)
  assert.match(document.body.textContent, /Retry/)
  assert.match(document.body.textContent, /owner_rejected/)
})

test('the Bot extension checks presets without drawing a second market or claiming plugin ownership', async t => {
  const calls = []
  const document = await mount(t, BotPresets, { actions: {
    plugins: async () => ({ presets: [{ id: 'learning', name: 'Learning' }], affected: [] }),
    checkPreset: async id => { calls.push(id); return { id, status: 'incompatible', reason: 'Programmatic tools are not supported.' } },
  } })
  assert.equal(document.querySelector('[aria-label="Search plugins"]'), null)
  assert.match(document.body.textContent, /names do not prove which plugin/)
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent.includes('Learning')).click())
  assert.deepEqual(calls, ['learning'])
  assert.match(document.body.textContent, /Not compatible/)
})

test('a retained Bot requires current review consent and still offers explicit standard recovery', async t => {
  const calls = []
  const document = await mount(t, BotPresets, { actions: {
    plugins: async () => ({ presets: [], affected: [{ id: 'teacher', name: 'Teacher', agentPreset: 'learning' }] }),
    checkPreset: async () => ({ id: 'learning', status: 'unverified', fingerprint: 'current' }),
    confirmPreset: async (...args) => calls.push(['confirm', ...args]),
    recoverPreset: async id => calls.push(['recover', id]),
  } })
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === 'Review preset').click())
  const confirm = [...document.querySelectorAll('button')].find(node => node.textContent === 'Confirm')
  assert.equal(confirm.disabled, true)
  await act(async () => document.querySelector('input[type=checkbox]').click())
  await act(async () => confirm.click())
  assert.deepEqual(calls[0], ['confirm', 'teacher', 'current'])
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === 'Use standard').click())
  assert.deepEqual(calls[1], ['recover', 'teacher'])
  assert.match(document.body.textContent, /Earlier chat history is kept/)
})
