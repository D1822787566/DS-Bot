import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from 'local-voice'

test('the installed Local Voice package activates on a real Cordis context', async () => {
  const ctx = new Context()
  let route
  const removeConnection = ctx.provide('connection', { fetch: { register(value) {
    assert.match(value.path, /^\/api\//)
    route = value
    return () => {}
  } } })
  const manager = apply(ctx, { state: { prefs: {} }, save: async () => {} })
  try {
    assert.equal(ctx.get('localVoice'), manager)
    const response = await route.fetch(new Request('http://localhost/api/local-voice', {
      method: 'POST', body: JSON.stringify({ action: 'view' }),
    }))
    const result = await response.json()
    assert.equal(result.ok, true)
    assert.equal(result.value.plugin, 'local-voice')
    assert.equal(result.value.runtime.state, 'stopped')
  } finally {
    await manager.stop()
    await removeConnection()
  }
})
