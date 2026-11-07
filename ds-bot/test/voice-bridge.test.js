import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createVoiceRoleRoster, VoiceBridgeServer, VoiceBridgeSession } from '../src/host/voice-bridge.js'

test('creates a DS Bot role roster without Alife character ids', () => {
  const roster = createVoiceRoleRoster({ revision: 7, bots: {
    a: { id: 'a', name: 'Alpha', sessionId: 'session-a', phoneAgent: { wakeName: '阿尔法', ttsVoice: 'voice-a' } },
    b: { id: 'b', name: 'Beta', sessionId: 'session-b', phoneAgent: { wakeName: '贝塔', ttsVoice: 'voice-b' } },
  } }, 'epoch-1')
  assert.deepEqual(roster, {
    activity_epoch: 'epoch-1', revision: 7,
    roles: [
      { bot_id: 'a', session_id: 'session-a', wake_names: ['阿尔法'], tts_voice: 'voice-a', profile_version: 7 },
      { bot_id: 'b', session_id: 'session-b', wake_names: ['贝塔'], tts_voice: 'voice-b', profile_version: 7 },
    ],
  })
})

test('routes a voice submit to the selected Bot session and emits assistant output events', async () => {
  const sent = []
  const prompts = []
  const rt = {
    botOf: id => id === 'b' ? { id: 'b' } : undefined,
    chatOf: () => 'session-b',
    ensureCapabilities: async id => assert.equal(id, 'session-b'),
    ctx: { sessionController: { prompt: async value => prompts.push(value) } },
    selfOf: id => id === 'session-b' ? 'b' : undefined,
  }
  const bridge = new VoiceBridgeSession({ rt, deviceId: 'windows-1', send: value => sent.push(value), activityEpoch: 'epoch-1' })
  await bridge.receive({ type: 'bridge.hello', sequence: 0, payload: { channel: 'voice', target_id: 'windows-1' } })
  const binding = sent.at(-1).binding
  await bridge.receive({ type: 'input.submit', sequence: 1, binding, correlation: { input_id: 'input-1' }, payload: {
    bot_id: 'b', text: '你好', channel: 'voice', speaker: { status: 'owner_verified', score: .9 },
  } })
  assert.equal(prompts[0].sessionId, 'session-b')
  assert.equal(prompts[0].content[0].text, '你好')
  assert.equal(sent.at(-1).type, 'input.accepted')
  bridge.sessionEvent({ id: 'session-b' }, { type: 'turn/start', data: { turn: 1 } })
  bridge.sessionEvent({ id: 'session-b' }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '你好，我是 Beta。' }] } } })
  bridge.sessionEvent({ id: 'session-b' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(sent.slice(-6).map(event => event.type), ['input.accepted', 'run.started', 'output.started', 'output.segment', 'output.ended', 'run.ended'])
  assert.equal(sent.at(-3).payload.speak_text, '你好，我是 Beta。')
})

test('registers a pending voice run before prompt dispatch can synchronously emit session events', async () => {
  const sent = []
  const rt = {
    botOf: id => id === 'b' ? { id: 'b' } : undefined,
    chatOf: () => 'session-b',
    ensureCapabilities: async () => {},
    ctx: { sessionController: { prompt: async () => bridge.sessionEvent({ id: 'session-b' }, { type: 'turn/start', data: { turn: 1 } }) } },
  }
  const bridge = new VoiceBridgeSession({ rt, deviceId: 'windows-1', send: value => sent.push(value), activityEpoch: 'epoch-1' })
  await bridge.receive({ type: 'bridge.hello', sequence: 0, payload: { channel: 'voice', target_id: 'windows-1' } })
  const binding = sent.at(-1).binding
  await bridge.receive({ type: 'input.submit', binding, correlation: { input_id: 'input-1' }, payload: {
    bot_id: 'b', text: '你好', channel: 'voice', speaker: { status: 'owner_verified' },
  } })
  assert.deepEqual(sent.slice(-3).map(event => event.type), ['run.started', 'output.started', 'input.accepted'])
})

test('answers input status queries without exposing credentials', async () => {
  const sent = []
  const rt = {
    botOf: id => id === 'b' ? { id: 'b' } : undefined,
    chatOf: () => 'session-b', ensureCapabilities: async () => {},
    ctx: { sessionController: { prompt: async () => {} } },
  }
  const bridge = new VoiceBridgeSession({ rt, deviceId: 'windows-1', send: value => sent.push(value), activityEpoch: 'epoch-1' })
  await bridge.receive({ type: 'bridge.hello', payload: { channel: 'voice', target_id: 'windows-1' } })
  const binding = sent.at(-1).binding
  await bridge.receive({ type: 'input.submit', binding, correlation: { input_id: 'input-1' }, payload: {
    bot_id: 'b', text: '你好', channel: 'voice', speaker: { status: 'owner_verified' },
  } })
  await bridge.receive({ type: 'input.status', binding, correlation: { input_id: 'input-1' }, payload: {} })
  assert.equal(sent.at(-1).type, 'input.status.result')
  assert.equal(sent.at(-1).payload.status, 'queued')
})

test('returns a bounded DS Bot context snapshot for continuation checks', async () => {
  const sent = []
  const rt = { state: { revision: 4, bots: { b: { id: 'b', name: 'Beta', role: 'reviewer', instructions: 'private' } } },
    botOf: id => id === 'b' ? rt.state.bots.b : undefined,
    chatOf: () => 'session-b', send: () => {}, ensureCapabilities: async () => {},
    ctx: { sessionController: { prompt: async () => {} } } }
  const bridge = new VoiceBridgeSession({ rt, deviceId: 'windows-1', send: value => sent.push(value), activityEpoch: 'epoch-1' })
  await bridge.receive({ type: 'bridge.hello', payload: { channel: 'voice', target_id: 'windows-1' } })
  const binding = sent.at(-1).binding
  await bridge.receive({ type: 'context.snapshot.get', binding, correlation: { request_id: 'request-1' }, payload: {
    bot_id: 'b', user_id: 'owner', dialogue_active: true, recent_reply: 'done',
  } })
  assert.equal(sent.at(-1).type, 'context.snapshot.result')
  assert.deepEqual(sent.at(-1).payload, {
    bot_id: 'b', user_id: 'owner', profile_version: 4, agent_names: ['Beta'],
    explicit_wake_required: true, negative_addressing_examples: [], rules: ['reviewer'],
    dialogue_active: true, recent_reply: 'done', wake_names: ['Beta'],
  })
})

test('publishes role changes to an already connected runtime session', async () => {
  const sent = []
  const state = { revision: 1, bots: { b: { id: 'b', name: 'Beta', sessionId: 'session-b', phoneAgent: { wakeName: 'beta' } } } }
  const rt = { state, botOf: id => state.bots[id], chatOf: () => 'session-b' }
  const bridge = new VoiceBridgeSession({ rt, deviceId: 'windows-1', send: value => sent.push(value), activityEpoch: 'epoch-1', roles: () => createVoiceRoleRoster(state, 'epoch-1') })
  await bridge.receive({ type: 'bridge.hello', payload: { channel: 'voice', target_id: 'windows-1' } })
  state.revision = 2
  state.bots.b.phoneAgent.wakeName = '小贝'
  bridge.rolesChanged()
  assert.equal(sent.at(-1).type, 'roles.changed')
  assert.deepEqual(sent.at(-1).payload.roles[0].wake_names, ['小贝'])
})

test('accepts only an authenticated loopback Bridge connection', async () => {
  const server = new VoiceBridgeServer({
    rt: { state: { revision: 1, bots: {} } }, deviceId: 'windows-1', credential: 'secret',
    getRoles: () => ({ activity_epoch: 'epoch-1', revision: 1, roles: [] }),
  })
  const view = await server.start()
  const open = async authorization => new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${view.port}`, { headers: { authorization } })
    socket.once('open', () => resolve(socket))
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(null) })
    socket.once('error', () => resolve(null))
    setTimeout(() => resolve(null), 1000).unref?.()
  })
  assert.equal(await open('Bearer wrong'), null)
  const socket = await open('Bearer secret')
  socket.send(JSON.stringify({ type: 'bridge.hello', sequence: 0, payload: { channel: 'voice', target_id: 'windows-1' } }))
  const ready = await new Promise(resolve => socket.once('message', data => resolve(JSON.parse(String(data)))))
  assert.equal(ready.type, 'bridge.ready')
  socket.terminate()
  await server.stop()
})
