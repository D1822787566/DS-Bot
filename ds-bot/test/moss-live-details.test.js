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
  entryPoints: [fileURLToPath(new URL('../src/client/moss-live-details.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => React })
const { MossLiveDetailsPanel } = module.exports

async function mount(t, props) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  t.after(async () => { await act(() => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.IS_REACT_ACT_ENVIRONMENT })
  await act(async () => root.render(React.createElement(MossLiveDetailsPanel, props)))
  return dom.window.document
}

const baseValue = (config, overrides = {}) => ({
  config: { personaAliases: [], profiles: [], selectedProfileId: '', dsBot: { enabled: false, bots: [] }, ...config },
  apiKeyConfigured: false,
  runtime: { state: 'stopped' },
  ...overrides,
})

test('MOSS details panel opens the same setup dialog for an unbound Bot and saves its Profile voice', async t => {
  const updates = []
  const refreshes = []
  let current = baseValue({ voiceName: '' }, { apiKeyConfigured: true })
  const actions = {
    mossLive: async () => current,
    mossLiveUpdate: async body => { updates.push(body); current = baseValue(body.config); return current },
    mossLiveVoices: async () => ({ voices: [{ id: 'voice-a', name: 'Alice' }] }),
  }
  const document = await mount(t, { bot: { id: 'chief', name: 'Chief', role: '主 Bot' }, actions, controller: {
    getSnapshot: () => ({ active: false, busy: false, sessionState: 'idle', profileId: '', boundBotId: '', endedAt: '', error: '' }),
    subscribe: () => () => {}, start: () => Promise.resolve(null), stop: () => Promise.resolve(null),
    refreshBinding: () => refreshes.push('chief'),
  } })
  assert.match(document.body.textContent, /未绑定 MOSS Profile/)
  await act(async () => document.querySelector('[data-moss-details-bind]').click())
  assert.ok(document.querySelector('[data-moss-details-dialog]'))
  assert.ok(document.querySelector('[data-moss-details-profile-voice]'))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const voice = document.querySelector('[data-moss-details-profile-voice]')
  await act(async () => { voice.value = 'voice-a'; voice.dispatchEvent(new window.Event('change', { bubbles: true })) })
  await act(async () => document.querySelector('[data-moss-details-save]').click())
  assert.equal(updates.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0].config.profiles)), [{ id: 'moss-chief', botId: 'chief', name: 'Chief', voiceName: 'voice-a', readHistory: false, submitTasks: false }])
  assert.deepEqual(refreshes, ['chief'])
})

test('bound MOSS details panel starts the selected Profile and opens settings from the sidebar', async t => {
  const starts = []
  const controller = {
    active: false,
    busy: false,
    getSnapshot: () => ({ active: false, busy: false, sessionState: 'idle', profileId: '', boundBotId: '', endedAt: '', error: '' }),
    subscribe: () => () => {},
    start: id => { starts.push(id) },
    stop: () => {},
  }
  const config = { profiles: [{ id: 'profile-chief', botId: 'chief', name: 'Chief voice', voiceName: 'voice-a', readHistory: true, submitTasks: true }], selectedProfileId: 'profile-chief' }
  const document = await mount(t, { bot: { id: 'chief', name: 'Chief' }, actions: { mossLive: async () => baseValue(config, { apiKeyConfigured: true }), mossLiveVoices: async () => ({ voices: [] }) }, controller })
  assert.match(document.body.textContent, /已绑定/)
  await act(async () => document.querySelector('[data-moss-details-dial]').click())
  assert.deepEqual(starts, ['profile-chief'])
  await act(async () => document.querySelector('[data-moss-details-settings]').click())
  assert.ok(document.querySelector('[data-moss-details-dialog]'))
})

test('MOSS details panel consumes a settings request from the current-page sidebar', async t => {
  const listeners = new Set()
  let snapshot = { active: false, busy: false, sessionState: 'idle', profileId: '', boundBotId: '', endedAt: '', error: '', settingsRequest: { id: 1, botId: 'chief' } }
  let consumed = 0
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    consumeSettingsRequest: id => { consumed = id; snapshot = { ...snapshot, settingsRequest: null }; for (const listener of listeners) listener() },
    start: () => Promise.resolve(null), stop: () => Promise.resolve(null),
  }
  const config = { profiles: [{ id: 'profile-chief', botId: 'chief', name: 'Chief voice', voiceName: 'voice-a', readHistory: true, submitTasks: true }], selectedProfileId: 'profile-chief' }
  const document = await mount(t, { bot: { id: 'chief', name: 'Chief' }, actions: { mossLive: async () => baseValue(config, { apiKeyConfigured: true }), mossLiveVoices: async () => ({ voices: [] }) }, controller })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  assert.ok(document.querySelector('[data-moss-details-dialog]'))
  assert.equal(consumed, 1)
})
