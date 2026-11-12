import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'

test('the installed plugin restores its own settings across host restarts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'local-voice-settings-'))
  const settingsPath = join(home, 'settings.json')
  const ctx = () => ({ provide() {}, effect(fn) { return fn() } })
  try {
    const first = apply(ctx(), { settingsPath })
    await first.update({ inputDeviceName: '测试麦克风', outputDeviceName: '测试扬声器' })
    const second = apply(ctx(), { settingsPath })
    assert.equal(second.view().config.inputDeviceName, '测试麦克风')
    assert.equal(second.view().config.outputDeviceName, '测试扬声器')
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).config.inputDeviceName, '测试麦克风')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
