import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installChannel } from '../src/host/channel.js'
import { install as installMossLive } from '../src/host/moss-live.js'

function channel(t, { apiKey = 'test-moss-key', fetchImpl } = {}) {
  let route
  const disposers = []
  const rt = {
    state: { prefs: {}, bots: {} },
    ctx: {
      effect(callback) { disposers.push(callback()) },
      connection: { fetch: { register(value) { route = value } } },
    },
    load: async () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    secretValue: () => apiKey,
    noteFailure: error => assert.fail(JSON.stringify(error)),
  }
  installMossLive(rt, { fetchImpl })
  installChannel(rt)
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.() })
  return async (endpoint, payload) => {
    const response = await route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    }))
    assert.equal(response.status, 200)
    return response.json()
  }
}

test('the MOSS voice list endpoint reaches the account API through the registered client channel', async t => {
  const requests = []
  const call = channel(t, { fetchImpl: async (url, options) => {
    requests.push({ url, options })
    return { ok: true, json: async () => ({ data: [{ id: 'voice-1', name: 'Alice' }], has_more: false }) }
  } })
  const result = await call('moss-live-voices')
  assert.deepEqual(result, { ok: true, value: { voices: [{ id: 'voice-1', name: 'Alice' }], hasMore: false } })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.mosi.cn/v1/audio/voices?limit=100')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-moss-key')
  assert.doesNotMatch(JSON.stringify(result), /test-moss-key/)
})

test('the MOSS voice preview endpoint forwards the selected voice and sample through the client channel', async t => {
  const requests = []
  const call = channel(t, { fetchImpl: async (url, options) => {
    requests.push({ url, options })
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 4]), { headers: { 'content-type': 'audio/mpeg' } })
  } })
  const result = await call('moss-live-voice-preview', { voiceId: 'voice-1', text: '试听音色。' })
  assert.deepEqual(result, { ok: true, value: { url: 'data:audio/mpeg;base64,SUQzBA==', contentType: 'audio/mpeg' } })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.mosi.cn/v1/audio/speech')
  assert.equal(JSON.parse(requests[0].options.body).voice_id, 'voice-1')
  assert.equal(JSON.parse(requests[0].options.body).input, '试听音色。')
  assert.doesNotMatch(JSON.stringify(result), /test-moss-key/)
})

test('the MOSS voice endpoints report a missing key without making an upstream request', async t => {
  const call = channel(t, { apiKey: '', fetchImpl: () => assert.fail('must not contact MOSS without a key') })
  for (const endpoint of ['moss-live-voices', 'moss-live-voice-preview']) {
    const result = await call(endpoint, { voiceId: 'voice-1' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bot/refused')
    assert.match(result.error.message, /API Key is not configured/)
  }
})
