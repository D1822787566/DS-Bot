import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { createMossLiveController } from '../src/client/moss-live-controller.js'
import { createSource } from '../src/client/sources.js'

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
const { BotPresets, PresetPicker, PhoneAgentSettings, MossLiveSettings, MossLiveCallBar, openPluginManager, openMossLiveSettings, voiceTestSummary } = module.exports

async function mount(t, component, props, configure = () => {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  context.window = dom.window
  configure(dom.window)
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

test('MOSS Live settings edits the persona through the host action', async t => {
  const calls = []
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { enabled: false, model: 'moss-live-1.0', personaName: 'DS Bot', personaAliases: [], personaPrompt: '', instructions: '', maxSessionSeconds: 1800 }, apiKeyConfigured: false, runtime: { state: 'stopped' } }),
    mossLiveUpdate: async value => { calls.push(value); return undefined },
  } })
  assert.match(document.body.textContent, /MOSS Live/)
  const name = document.querySelector('[data-moss-live-field="personaName"]')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(name, 'Luna')
  await act(async () => name.dispatchEvent(new window.Event('input', { bubbles: true })))
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === '保存配置').click())
  assert.equal(calls.at(-1).config.personaName, 'Luna')
})

test('starting MOSS after an old ready relay always requests a fresh Host session', async t => {
  const calls = []
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { personaAliases: [], greetingEnabled: false }, apiKeyConfigured: true, runtime: { state: 'ready', port: 1234, token: 'old' } }),
    mossLiveStop: async () => { calls.push('stop') },
    mossLiveStart: async () => { calls.push('start'); return { config: { personaAliases: [], greetingEnabled: false }, runtime: { state: 'starting', port: 1235, token: 'fresh' } } },
  } })
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '开始 MOSS Live').click())
  assert.deepEqual(calls.slice(0, 2), ['stop', 'start'])
})

test('an unavailable opening greeting restores the microphone instead of muting the new session permanently', async t => {
  const names = ['WebSocket', 'navigator', 'AudioContext', 'AudioWorkletNode', 'URL', 'Blob', 'AbortController']
  const saved = new Map(names.map(key => [key, context[key]]))
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete context[key]; else context[key] = value } })
  const track = { enabled: true, stop() {} }
  context.WebSocket = class { readyState = 1; send() {} close() {} }
  context.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } }
  context.AudioContext = class {
    state = 'running'; audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createGain() { return { gain: {}, connect() {}, disconnect() {} } }
    async close() {}
  }
  context.AudioWorkletNode = class { port = {}; connect() {} disconnect() {} }
  context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} }
  context.Blob = globalThis.Blob; context.AbortController = globalThis.AbortController
  const config = { personaAliases: [], greetingEnabled: true, greetingText: '你好。' }
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config, apiKeyConfigured: true, runtime: { state: 'stopped' } }),
    mossLiveStop: async () => {},
    mossLiveStart: async () => ({ config, runtime: { state: 'starting', port: 1235, token: 'fresh' } }),
  } })
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '开始 MOSS Live').click())
  assert.equal(track.enabled, true)
})

test('MOSS DS Bot UI saves independent read and send grants without discarding unsaved model edits', async t => {
  const calls = []
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { personaName: 'MOSS', personaAliases: [], dsBot: { enabled: false, bots: [] } }, dsBot: { bots: [{ id: 'chief', name: 'Chief' }, { id: 'writer', name: 'Writer', private: true }], tasks: [], reads: [] }, runtime: { state: 'stopped' } }),
    mossLiveUpdate: async body => { calls.push(body); return undefined },
  } })
  assert.ok(document.querySelector('[data-moss-dsbot]'))
  assert.match(document.body.textContent, /发送给 MOSS/)
  await act(async () => document.querySelector('[data-moss-dsbot-enabled]').click())
  await act(async () => document.querySelector('[data-moss-dsbot-grant="chief:readHistory"]').click())
  await act(async () => document.querySelector('[data-moss-dsbot-grant="writer:submitTasks"]').click())
  const name = document.querySelector('[data-moss-live-field="personaName"]')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(name, 'unsaved name')
  await act(async () => name.dispatchEvent(new window.Event('input', { bubbles: true })))
  await act(async () => document.querySelector('[data-moss-dsbot-save]').click())
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { config: { dsBot: { enabled: true, bots: [
    { botId: 'chief', readHistory: true, submitTasks: false }, { botId: 'writer', readHistory: false, submitTasks: true },
  ] } } })
  assert.equal(document.querySelector('[data-moss-live-field="personaName"]').value, 'unsaved name')
})

test('MOSS DS Bot task cards show actual status and open the target Bot', async t => {
  const opened = []
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { personaAliases: [], dsBot: { enabled: true, bots: [] } }, dsBot: { bots: [{ id: 'chief', name: 'Chief' }], tasks: [{ id: 'task1', botId: 'chief', botName: 'Chief', status: 'queued', text: '整理待办', context: '相关讨论' }], reads: [] }, runtime: { state: 'stopped' } }),
    mossLiveOpenBot: id => opened.push(id),
  } })
  const task = document.querySelector('[data-moss-dsbot-task="task1"]')
  assert.ok(task)
  assert.match(task.textContent, /排队中/)
  assert.match(task.textContent, /整理待办/)
  await act(async () => task.querySelector('button').click())
  assert.deepEqual(opened, ['chief'])
})

test('leaving MOSS settings and returning through the permanent bar preserves the live session and video preview', async t => {
  assert.equal(typeof MossLiveCallBar, 'function', 'The live call needs a root-mounted control bar')
  let session, stops = 0, starts = 0
  const config = { enabled: true, personaAliases: [], greetingEnabled: false }
  const actions = {
    mossLive: async () => ({ config, apiKeyConfigured: true, runtime: { state: 'ready' } }),
    mossLiveStart: async () => { starts++; return { config, runtime: { port: 1234, token: 'live' } } },
    mossLiveStop: async () => {},
  }
  const controller = createMossLiveController({ actions, createSession: options => (session = {
    ws: {}, state: 'ready', connect: async () => options.onState('ready'), startMic: async () => {}, setMicEnabled() {},
    stop: async () => { stops++ },
    startScreenShare: async () => { options.onScreenStream({ id: 'same-screen' }); return true },
    stopScreenShare: async () => options.onScreenStream(null), options,
  }) })
  await controller.start()
  controller.setMuted(true)
  await controller.startScreenShare()
  session.options.onTranscript({ kind: 'user', text: '别断线，我去看看华子', final: true })
  function Shell() {
    const [open, setOpen] = React.useState(true)
    return React.createElement(React.Fragment, null,
      React.createElement('button', { 'data-away': true, onClick: () => setOpen(false) }, '打开华子'),
      open ? React.createElement(MossLiveSettings, { actions, controller }) : null,
      React.createElement(MossLiveCallBar, { controller, onReturn: () => setOpen(true) }))
  }
  const document = await mount(t, Shell, {}, window => { window.HTMLMediaElement.prototype.play = async () => {} })
  t.after(() => controller.dispose())
  await act(async () => document.querySelector('[data-away]').click())
  assert.equal(document.querySelector('.bt-moss-live'), null)
  assert.equal(stops, 0)
  const bar = document.querySelector('[data-moss-call-bar]')
  assert.ok(bar)
  assert.equal(bar.querySelector('[data-moss-call-mute]').getAttribute('aria-pressed'), 'true')
  await act(async () => bar.querySelector('[data-moss-call-return]').click())
  assert.equal(starts, 1)
  assert.match(document.querySelector('.bt-moss-transcript').textContent, /别断线，我去看看华子/)
  assert.equal(document.querySelector('video').srcObject.id, 'same-screen')
  await act(async () => bar.querySelector('[data-moss-call-share-stop]').click())
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().screenStream, null)
  await act(async () => bar.querySelector('[data-moss-call-end]').click())
  assert.equal(stops, 1)
  assert.ok(document.querySelector('[data-moss-call-bar]'))
  assert.match(bar.textContent, /已挂断/)
  assert.equal(bar.querySelector('[data-moss-call-mute]'), null)
  const redial = bar.querySelector('[data-moss-call-redial]')
  assert.ok(redial)
  assert.equal(redial.getAttribute('aria-label'), '重新拨打')
  await act(async () => { redial.click(); redial.click() })
  assert.equal(starts, 2)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().screenStream, null)
  assert.equal(controller.getSnapshot().transcript.length, 0)
  assert.ok(bar.querySelector('[data-moss-call-end]'))
})

test('returning to MOSS selects its existing plugin tab without creating a voice session', async () => {
  assert.equal(typeof openMossLiveSettings, 'function')
  const calls = []
  await openMossLiveSettings({ actions: { plugins: async () => calls.push('plugins') }, ui: { set() {} },
    navigation: { openList: () => calls.push('list') },
    slots: { entries: () => [{ options: { key: 'plugins' }, store: { create: () => ({ actions: { setTab: id => calls.push(id) } }) } }] },
  })
  assert.deepEqual(calls, ['plugins', 'list', 'ds-bot-moss-live'])
})

test('the permanent bar reserves the visible sidebar width on desktop and the avatar rail on narrow windows', async t => {
  const controller = createSource({ visible: true, active: true, sessionState: 'ready', transcript: [], startedAt: '', endedAt: '' })
  const geometry = {
    frame: createSource({ viewport: 1320, sidebarWidth: 280, collapsed: false }),
    sidebarPref: createSource('open'), ui: createSource({ details: null }), surface: createSource({ mode: 'bot' }),
  }
  const document = await mount(t, MossLiveCallBar, { controller, geometry })
  assert.equal(document.querySelector('.bt-moss-call-seat').style.getPropertyValue('--moss-inset'), '280px')
  await act(async () => geometry.frame.set({ viewport: 430, sidebarWidth: 280, collapsed: true, collapsedWidth: 0 }))
  assert.equal(document.querySelector('.bt-moss-call-seat').style.getPropertyValue('--moss-inset'), '88px')
})

test('MOSS Live phase one exposes scene presets, greeting settings and the animated stage', async t => {
  const calls = []
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { enabled: false, model: 'moss-live-1.0', personaName: 'DS Bot', personaAliases: [], personaPrompt: '', instructions: '', greetingEnabled: true, greetingText: '你好。', maxSessionSeconds: 1800 }, apiKeyConfigured: false, runtime: { state: 'stopped' } }),
    mossLiveUpdate: async value => { calls.push(value); return undefined },
  } })
  assert.ok(document.querySelector('.bt-moss-stage'))
  const scene = document.querySelector('[data-moss-live-scene]')
  await act(async () => { scene.value = 'interpreter'; scene.dispatchEvent(new window.Event('change', { bubbles: true })) })
  const greeting = document.querySelector('[data-moss-live-field="greetingText"]')
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(greeting, '欢迎。')
  await act(async () => greeting.dispatchEvent(new window.Event('input', { bubbles: true })))
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === '保存配置').click())
  assert.equal(calls.at(-1).config.greetingText, '欢迎。')
  assert.match(calls.at(-1).config.instructions, /翻译/)
})

test('MOSS Live phase two exposes screen sharing without camera controls', async t => {
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { enabled: false, model: 'moss-live-1.0', personaName: 'DS Bot', personaAliases: [], personaPrompt: '', instructions: '', greetingEnabled: true, greetingText: '你好。', maxSessionSeconds: 1800 }, apiKeyConfigured: true, runtime: { state: 'ready' } }),
  } })
  assert.match(document.body.textContent, /屏幕共享/)
  assert.equal([...document.querySelectorAll('button')].some(node => /摄像头/.test(node.textContent)), false)
  assert.ok(document.querySelector('[data-moss-live-screen-share]'))
})

test('MOSS Live phase two exposes API-aligned media and interpretation settings', async t => {
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { enabled: false, model: 'moss-live-1.0', mode: 'conversation', voiceName: '', sourceLanguage: '', targetLanguage: 'en', bidirectional: false, mediaProfile: 'standard', videoMaxLongSide: 1024, videoJpegQuality: .72, videoIntervalMs: 1000, personaName: 'DS Bot', personaAliases: [], personaPrompt: '', instructions: '', greetingEnabled: true, greetingText: '你好。', maxSessionSeconds: 1800 }, apiKeyConfigured: false, runtime: { state: 'stopped' } }),
  } })
  assert.ok(document.querySelector('[data-moss-live-field="voiceName"]'))
  assert.ok(document.querySelector('[data-moss-live-field="mediaProfile"]'))
  assert.ok(document.querySelector('[data-moss-live-field="mode"]'))
})

test('MOSS Live keeps the voice catalogue inside a dropdown with one preview button', async t => {
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { enabled: false, model: 'moss-live-1.0', mode: 'conversation', voiceName: '', mediaProfile: 'standard', personaName: 'DS Bot', personaAliases: [], personaPrompt: '', instructions: '', greetingEnabled: true, greetingText: '你好。', maxSessionSeconds: 1800 }, apiKeyConfigured: true, runtime: { state: 'stopped' } }),
    mossLiveVoices: async () => ({ voices: [{ id: 'voice-1', name: 'Alice' }, { id: 'voice-2', name: 'Bob' }] }),
    mossLiveVoicePreview: async () => ({ url: 'data:audio/mpeg;base64,SUQzBA==' }),
  } }, win => { win.HTMLMediaElement.prototype.pause = () => {} })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const voice = document.querySelector('[data-moss-live-field="voiceName"]')
  assert.equal(voice.tagName, 'SELECT')
  assert.deepEqual([...voice.options].map(option => option.value), ['', 'voice-1', 'voice-2'])
  assert.equal(document.querySelectorAll('[data-moss-live-preview]').length, 1)
  assert.equal(document.querySelector('[data-moss-live-preview]').disabled, true)
  assert.equal(document.querySelector('.bt-moss-voice-list'), null)
  assert.match(document.querySelector('.bt-moss-voice-picker').textContent, /试听.*语音合成.*计费/)
  await act(async () => { voice.value = 'voice-2'; voice.dispatchEvent(new window.Event('change', { bubbles: true })) })
  assert.equal(document.querySelector('[data-moss-live-preview]').disabled, false)
  assert.equal(document.querySelector('[data-moss-live-preview]').dataset.mossLivePreview, 'voice-2')
})

test('MOSS Live voice preview asks the host for audio and starts the player', async t => {
  const previews = []
  let sourceChanges = 0
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { enabled: false, model: 'moss-live-1.0', voiceName: '', personaName: 'DS Bot', personaAliases: [], personaPrompt: '', instructions: '', greetingEnabled: true, greetingText: '你好。', maxSessionSeconds: 1800 }, apiKeyConfigured: true, runtime: { state: 'stopped' } }),
    mossLiveVoices: async () => ({ voices: [{ id: 'voice-1', name: 'Alice' }] }),
    mossLiveVoicePreview: async body => { previews.push(body); return { url: 'data:audio/mpeg;base64,SUQzBA==' } },
  } }, win => {
    const prototype = win.HTMLMediaElement.prototype
    const source = Object.getOwnPropertyDescriptor(prototype, 'src')
    const setAttribute = prototype.setAttribute
    Object.defineProperty(prototype, 'src', { configurable: true, get: source.get, set(value) { sourceChanges++; source.set.call(this, value) } })
    prototype.setAttribute = function (name, value) { if (name === 'src') sourceChanges++; return setAttribute.call(this, name, value) }
    prototype.play = () => Promise.resolve()
    prototype.pause = () => {}
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const voice = document.querySelector('[data-moss-live-field="voiceName"]')
  await act(async () => { voice.value = 'voice-1'; voice.dispatchEvent(new window.Event('change', { bubbles: true })) })
  await act(async () => document.querySelector('[data-moss-live-preview="voice-1"]').click())
  await act(async () => { await Promise.resolve() })
  assert.equal(previews.length, 1)
  assert.equal(previews[0].voiceId, 'voice-1')
  assert.equal(document.querySelector('audio').src, 'data:audio/mpeg;base64,SUQzBA==')
  assert.equal(sourceChanges, 1, 'rendering must not reload the audio after play starts')
  assert.equal(document.querySelector('[data-moss-live-preview]').textContent, '停止试听')
  await act(async () => document.querySelector('audio').dispatchEvent(new window.Event('ended')))
  assert.equal(document.querySelector('[data-moss-live-preview]').textContent, '试听')
})

test('MOSS Live status polling keeps unsaved persona and greeting edits', async t => {
  let poll
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { personaName: 'DS Bot', personaAliases: [], instructions: '', greetingText: '你好。' }, runtime: { state: 'stopped' } }),
  } }, win => {
    win.setInterval = callback => { poll = callback; return 1 }
    win.clearInterval = () => {}
  })
  const name = document.querySelector('[data-moss-live-field="personaName"]')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(name, '小莫')
  await act(async () => name.dispatchEvent(new window.Event('input', { bubbles: true })))
  await act(async () => { poll(); await Promise.resolve() })
  assert.equal(name.value, '小莫')
})

test('MOSS Live restores a saved scene and offers a custom selection for user instructions', async t => {
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { personaName: 'DS Bot', personaAliases: [], instructions: '这是我自己的会话指令。' }, runtime: { state: 'stopped' } }),
  } })
  assert.equal(document.querySelector('[data-moss-live-scene]').value, 'custom')
  assert.equal(document.querySelector('[data-moss-live-field="instructions"]').value, '这是我自己的会话指令。')
})

test('MOSS Live settings saves the API key through a host secret action', async t => {
  const calls = []
  const document = await mount(t, MossLiveSettings, { actions: {
    mossLive: async () => ({ config: { enabled: false, model: 'moss-live-1.0', personaName: 'DS Bot', personaAliases: [], personaPrompt: '', instructions: '', maxSessionSeconds: 1800 }, apiKeyConfigured: false, runtime: { state: 'stopped' } }),
    mossLiveSetKey: async body => { calls.push(body); return undefined },
  } })
  const key = document.querySelector('[data-moss-live-field="apiKey"]')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(key, 'secret-value')
  await act(async () => key.dispatchEvent(new window.Event('input', { bubbles: true })))
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === '保存 API Key').click())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].value, 'secret-value')
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
  assert.match(document.body.textContent, /语音测试面板/)
  assert.match(document.body.textContent, /唤醒检测/)
  assert.match(document.body.textContent, /主人声纹/)
  await act(async () => [...document.querySelectorAll('button')].find(node => node.textContent === '清零测试数据').click())
})

test('Phone Agent has a dedicated voice test center with separate ASR and audio sections', async t => {
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {
      asrTestState: 'completed', asrTestTranscript: '华子，检查项目。', asrTestDurationMs: 321,
    } } }),
    phoneAgentAsrTest: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: { asrTestState: 'requested' } } }),
    phoneAgentDiagnosticsReset: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {} } }),
  } })
  assert.match(document.body.textContent, /语音测试中心/)
  assert.match(document.body.textContent, /麦克风与音频输入/)
  assert.match(document.body.textContent, /唤醒词测试/)
  assert.match(document.body.textContent, /ASR 测试/)
  assert.match(document.body.textContent, /主人声纹测试/)
  assert.match(document.body.textContent, /TTS 与扬声器测试/)
  assert.match(document.body.textContent, /完整链路测试/)
  assert.match(document.body.textContent, /华子，检查项目。/)
})

test('Phone Agent settings can start the continuous voiceprint test without a wake word', async t => {
  let called = 0
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {} } }),
    phoneAgentVoiceprintStart: async () => { called++; return { config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: { voiceprintTestActive: true, voiceprintTestState: 'listening' } } } },
  } })
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === '启动声纹测试')
  assert.ok(button)
  await act(async () => button.click())
  assert.equal(called, 1)
})

test('Phone Agent settings keeps the voiceprint test running until the user stops it', async t => {
  const calls = []
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {
      voiceprintTestActive: false, voiceprintTestState: 'idle', voiceprintTestCompleted: 0,
    } } }),
    phoneAgentVoiceprintStart: async () => { calls.push('start'); return { config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: { voiceprintTestActive: true, voiceprintTestState: 'listening' } } } },
    phoneAgentVoiceprintStop: async () => { calls.push('stop'); return { config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: { voiceprintTestActive: false, voiceprintTestState: 'stopped' } } } },
  } })
  const start = [...document.querySelectorAll('button')].find(node => node.textContent === '启动声纹测试')
  assert.ok(start)
  await act(async () => start.click())
  assert.deepEqual(calls, ['start'])
  assert.match(document.body.textContent, /持续监听/)
})

test('Phone Agent settings binds explicit voiceprint labeling to the latest test segment', async t => {
  const calls = []
  const document = await mount(t, PhoneAgentSettings, { actions: {
    phoneAgent: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {
      voiceprintTestCompleted: 1, voiceprintTestResult: 'owner_rejected', voiceprintCandidateReady: true,
      voiceprintCandidateSegmentId: 9, voiceprintPendingSamples: 0, voiceprintApprovedSamples: 3,
    } } }),
    phoneAgentVoiceprintLabel: async segmentId => { calls.push(['label', segmentId]); return { config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: { voiceprintPendingSamples: 1 } } } },
    phoneAgentVoiceprintApply: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {} } }),
    phoneAgentVoiceprintDiscard: async () => ({ config: { enabled: true }, bots: [], runtime: { state: 'listening', metrics: {} } }),
  } })
  const label = [...document.querySelectorAll('button')].find(node => node.textContent.includes('确认这是我'))
  assert.ok(label)
  await act(async () => label.click())
  assert.deepEqual(calls, [['label', 9]])
})

test('voice test summary explains when only near-silent microphone audio arrived', () => {
  const summary = voiceTestSummary({ microphoneFrames: 12051, microphonePeak: 1721, microphoneRms: .002,
    wakeKeywordResults: 0, wakePublished: 0, segmentEnded: 0, asrAttempted: 0, ownerVerified: 0 })
  assert.match(summary, /音量接近静音/)
  assert.match(summary, /没有进行语音转写和主人声纹验证/)
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
