import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function start(t, { desktop = true, broken, rows = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-plugins-'))
  const calls = []
  const bundles = [{ name: 'study', version: '1.0.0', enabled: true, installed: true, removable: true, rows: [] }]
  const indexes = []
  const savedIndexes = []
  const services = {
    pluginManager: {
      listBundles: async () => bundles,
      inspect: async spec => ({ status: 'accepted', kind: 'registry', name: spec, bundle: true }),
      installBundle: async spec => { calls.push(spec); return { application: 'restart-required', bundle: spec } },
      removeBundle: async name => { calls.push(name); return { application: 'applied' } },
    },
    agentPresets: {
      list: async () => [{ id: 'standard' }, { id: 'learning', ...(broken ? { broken } : {}) }],
      compositionInventory: async () => [{ id: 'standard', rows }, { id: 'learning', rows }],
    },
    pluginMarket: {
      listIndexes: () => indexes.map(url => ({ url })),
      setIndexes: async urls => { savedIndexes.push([...urls]); indexes.splice(0, indexes.length, ...urls) },
    },
  }
  const ctx = fakeContext({ services })
  const previous = process.env.DS_BOT_APP
  if (desktop) process.env.DS_BOT_APP = '1'
  else delete process.env.DS_BOT_APP
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  if (previous === undefined) delete process.env.DS_BOT_APP
  else process.env.DS_BOT_APP = previous
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  return { rt, calls, bundles, indexes, savedIndexes }
}

test('desktop exposes the current-profile plugin inventory and loaded presets', async t => {
  const { rt } = start(t)
  assert.equal(typeof rt.pluginCatalog, 'function')
  const result = await rt.pluginCatalog()
  assert.equal(result.available, true)
  assert.equal(result.bundles[0].name, 'study')
  assert.equal(result.presets[1].id, 'learning')
})

test('plugin management is unavailable in the DSH plugin form', async t => {
  const { rt, calls } = start(t, { desktop: false })
  assert.equal(typeof rt.pluginChange, 'function')
  await assert.rejects(rt.pluginChange({ action: 'install', spec: 'study' }), /desktop/i)
  assert.deepEqual(calls, [])
})

test('broken and programmatic tool presets cannot be bound', async t => {
  const { rt } = start(t, { broken: 'dependency missing' })
  assert.equal(typeof rt.checkBotPreset, 'function')
  const result = await rt.checkBotPreset('learning')
  assert.equal(result.status, 'incompatible')
  assert.equal(result.bindable, false)
  const ptc = start(t, { rows: [{ moduleName: '@deepseek-ai/dsh-workflow-ptc', enabled: true }] })
  assert.equal((await ptc.rt.checkBotPreset('learning')).bindable, false)
})

test('unclassified presets are explicitly unverified, never reported ready', async t => {
  const { rt } = start(t, { rows: [{ moduleName: 'external-learning', enabled: true }] })
  assert.equal(typeof rt.checkBotPreset, 'function')
  const result = await rt.checkBotPreset('learning')
  assert.equal(result.status, 'unverified')
  assert.equal(result.bindable, false)
})

test('the verified standard preset remains usable when its composition includes workflow helpers', async t => {
  const { rt } = start(t, { rows: [{ moduleName: '@deepseek-ai/dsh-workflow-ptc', enabled: true }] })
  const result = await rt.checkBotPreset('standard')
  assert.equal(result.status, 'ready')
  assert.equal(result.bindable, true)
})

test('incompatible Bot presets do not block installing their plugin', async t => {
  const { rt, calls } = start(t, { broken: 'not usable' })
  assert.equal(typeof rt.pluginChange, 'function')
  const result = await rt.pluginChange({ action: 'install', spec: 'study' })
  assert.equal(result.application, 'restart-required')
  assert.deepEqual(calls, ['study'])
})

test('stale checks cannot authorize a preset after its composition changes', async t => {
  const rows = []
  const { rt } = start(t, { rows })
  assert.equal(typeof rt.checkBotPreset, 'function')
  const before = await rt.checkBotPreset('learning')
  rows.push({ moduleName: '@deepseek-ai/dsh-workflow-ptc', enabled: true })
  const after = await rt.checkBotPreset('learning')
  assert.notEqual(before.fingerprint, after.fingerprint)
  assert.equal(after.bindable, false)
})

test('explicit recovery preserves old parts and uses standard for the next part', async t => {
  const { rt } = start(t, { broken: 'removed' })
  await rt.load()
  rt.state.bots.teacher = { id: 'teacher', name: 'Teacher', sessionId: 'old-part', agentPreset: 'learning', createdAt: 1 }
  rt.createSession = async (_name, options) => { assert.equal(options.agentPreset, 'standard'); return 'fresh-part' }
  rt.resolveAgent = async () => ({ status: 'idle' })
  assert.equal(typeof rt.recoverBotPreset, 'function')
  await rt.recoverBotPreset('teacher')
  const bot = rt.state.bots.teacher
  assert.equal(bot.sessionId, 'fresh-part')
  assert.equal(bot.agentPreset, 'standard')
  assert.equal(bot.segments[0].sessionId, 'old-part')
})

test('an unverified preset needs the current confirmation fingerprint', async t => {
  const { rt } = start(t)
  await assert.rejects(rt.selectBotPreset('learning'), /confirm/i)
  const report = await rt.checkBotPreset('learning')
  assert.equal((await rt.selectBotPreset('learning', report.fingerprint)).id, 'learning')
  await assert.rejects(rt.selectBotPreset('learning', 'stale'), /confirm/i)
})

test('an unavailable preset blocks a retained Bot without changing its saved choice', async t => {
  const { rt } = start(t, { broken: 'removed' })
  const bot = { id: 'teacher', agentPreset: 'learning' }
  await assert.rejects(rt.ensureBotPreset(bot), /preset unavailable/i)
  assert.equal(bot.agentPreset, 'learning')
})

test('preset recovery refuses while the Bot is working', async t => {
  const { rt } = start(t, { broken: 'removed' })
  await rt.load()
  rt.state.bots.teacher = { id: 'teacher', sessionId: 'teacher', name: 'Teacher', agentPreset: 'learning' }
  rt.live.set('teacher', { turn: 1 })
  await assert.rejects(rt.recoverBotPreset('teacher'), /Stop this Bot/i)
  assert.equal(rt.state.bots.teacher.agentPreset, 'learning')
})

test('plugin controls cannot disable or remove the app core', async t => {
  const { rt, calls } = start(t)
  await assert.rejects(rt.pluginChange({ action: 'remove', name: 'ds-bot' }), /built in/i)
  await assert.rejects(rt.pluginChange({ action: 'enable', name: '@deepseek-ai/dsh-base', enabled: false }), /built in/i)
  assert.deepEqual(calls, [])
})

test('a regular Bot cannot use the new plugin tool to change profile packages', async t => {
  const { rt, calls } = start(t)
  const tool = rt.teamTools.find(tool => tool.name === 'bot_plugins')
  const answer = await tool.execute({ action: 'install', spec: 'study' }, { agent: { id: 'regular' } })
  assert.match(answer, /Only a Main Bot/)
  assert.deepEqual(calls, [])
})

test('DSH Markets supplies its catalog once while preserving later source removal', async t => {
  const { rt, bundles, indexes, savedIndexes } = start(t)
  bundles.push({ name: 'dshmarket', version: '1.73.11', enabled: true })
  const first = await rt.pluginCatalog()
  assert.equal(first.market.name, 'dshmarket')
  assert.equal(first.market.enabled, true)
  assert.equal(first.indexes[0].url, 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json')
  indexes.length = 0
  await rt.pluginCatalog()
  assert.equal(savedIndexes.length, 1)
  assert.equal(indexes.length, 0)
})

test('DSH Markets keeps existing sources instead of replacing them with its default', async t => {
  const { rt, bundles, indexes, savedIndexes } = start(t)
  bundles.push({ name: 'dshmarket', enabled: true })
  indexes.push('https://example.test/team.json')
  const catalog = await rt.pluginCatalog()
  assert.equal(catalog.indexes[0].url, 'https://example.test/team.json')
  assert.equal(savedIndexes.length, 0)
})
