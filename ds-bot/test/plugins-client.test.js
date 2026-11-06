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
const { BotPresets, PresetPicker, openPluginManager } = module.exports

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
