import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('Local Voice client declares a plugin tab and uses the isolated host route', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /id:\s*['"]local-voice['"]/)
  assert.match(source, /plugins\.tab/)
  assert.match(source, /api\/local-voice/)
  assert.match(source, /Local Voice/)
})

test('client registers and disposes its own tab through the loader lifecycle', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let plugin
  let entry
  let disposer
  let disposed = false
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value.factory(() => ({})) } } } })
  plugin.apply({
    effect(fn) { disposer = fn() },
    slots: {
      inject(name, fn) { assert.equal(name, 'plugins.tab'); return fn() },
      register(options) { entry = options; return () => { disposed = true } },
    },
  })
  assert.equal(entry.id, 'local-voice')
  assert.equal(entry.label, 'Local Voice（本地语音）')
  assert.equal(typeof disposer, 'function')
  disposer()
  assert.equal(disposed, true)
})
