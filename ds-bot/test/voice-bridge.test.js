import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createVoiceRoleRoster, VoiceBridgeServer, VoiceBridgeSession } from '../src/host/voice-bridge.js'

const envelope = (type, sequence, binding, correlation = {}, payload = {}) => ({
  protocol: 'agent-events.v1', event_id: randomUUID(), type, sequence, binding, correlation, payload,
  occurred_at: new Date().toISOString(),
})

async function harness(options = {}) {
  const sent = [], prompts = [], cancels = [], removals = []
  const state = { revision: 1, bots: {
    a: { id: 'a', name: 'Alpha', sessionId: 'session-a', phoneAgent: { wakeName: '阿尔法', ttsVoice: 'voice-a' } },
    b: { id: 'b', name: 'Beta', sessionId: 'session-b', phoneAgent: { wakeName: '小贝', ttsVoice: 'voice-b' } },
  } }
  const rt = {
    state, botOf: id => state.bots[id], chatOf: id => state.bots[id]?.sessionId,
    ensureCapabilities: options.ensureCapabilities ?? (async () => {}),
    ctx: { sessionController: {
      prompt: async value => { prompts.push(value); await options.prompt?.(value, bridge) },
      cancel: async value => { cancels.push(value) },
      updateQueue: async value => { removals.push(value) },
    } },
  }
  const bridge = new VoiceBridgeSession({ rt, deviceId: 'windows-1', send: value => sent.push(value), activityEpoch: 'epoch-1',
    roles: () => createVoiceRoleRoster(state, 'epoch-1'), ...(options.inputs ? { inputs: options.inputs } : {}) })
  let sequence = 0
  const receive = (type, correlation = {}, payload = {}) => bridge.receive(envelope(type, sequence++, bridge.binding, correlation, payload))
  await receive('bridge.hello', {}, { channel: 'voice', target_id: 'windows-1' })
  const wake = async (botId = 'b', wakeId = 'wake-1', generation = 1) => receive('device.wake', { wake_session_id: wakeId }, {
    wake_session_id: wakeId, bot_id: botId, wake_mapping_version: `epoch-1:${state.revision}`, generation,
  })
  const submit = (inputId = 'input-1', payload = {}) => receive('input.submit', { input_id: inputId }, {
    bot_id: 'b', session_id: 'session-b', wake_session_id: 'wake-1', generation: 1,
    segment_id: 'segment-1', text: '你好', channel: 'voice',
    speaker: { status: 'owner_verified', score: .9, segment_id: 'segment-1' }, ...payload,
  })
  const start = (request, turn = 1) => {
    bridge.sessionEvent({ id: request.sessionId }, { type: 'turn/start', data: { turn } })
    bridge.sessionEvent({ id: request.sessionId }, { type: 'user/message', data: {
      turn, id: `message-${request.requestId}`, source: { kind: 'user', rpcId: request.requestId }, content: request.content,
    } })
  }
  const reply = (text = '你好，我是 Beta。', turn = 1, sessionId = 'session-b') => bridge.sessionEvent({ id: sessionId }, {
    type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } },
  })
  const end = (turn = 1, reason = { kind: 'completed' }) => bridge.sessionEvent({ id: 'session-b' }, { type: 'turn/end', data: { turn, reason } })
  return { bridge, rt, state, sent, prompts, cancels, removals, receive, wake, submit, start, reply, end }
}

test('creates the DS Bot roster with stable Bot/session and voice mappings', () => {
  assert.deepEqual(createVoiceRoleRoster({ revision: 7, bots: {
    b: { id: 'b', name: 'Beta', sessionId: 'session-b', phoneAgent: { wakeName: '小贝', ttsVoice: 'voice-b' } },
  } }, 'epoch-1'), { activity_epoch: 'epoch-1', revision: 7, roles: [
    { bot_id: 'b', session_id: 'session-b', wake_names: ['小贝'], tts_voice: 'voice-b', profile_version: 7 },
  ] })
})

test('routes only accepted wake input to the existing session and correlates its reply', async () => {
  const h = await harness()
  await h.wake(); await h.submit()
  assert.equal(h.prompts[0].sessionId, 'session-b')
  assert.equal(h.prompts[0].mode, 'queue')
  assert.equal(h.prompts[0].content[0].text, '你好')
  h.start(h.prompts[0]); h.reply(); h.end()
  assert.deepEqual(h.sent.slice(-6).map(event => event.type), [
    'input.accepted', 'run.started', 'output.started', 'output.segment', 'output.ended', 'run.ended',
  ])
  const segment = h.sent.find(event => event.type === 'output.segment')
  assert.equal(segment.payload.speak_text, '你好，我是 Beta。')
  assert.equal(segment.payload.tts_voice, 'voice-b')
  assert.deepEqual({ ...segment.correlation, run_id: '', response_id: '' }, {
    input_id: 'input-1', run_id: '', response_id: '', bot_id: 'b', session_id: 'session-b',
    wake_session_id: 'wake-1', generation: 1, target_id: 'windows-1',
  })
})

test('passes the complete voice transcript to the existing session', async () => {
  const h = await harness()
  await h.wake()
  await h.submit('input-full', { text: '  华子，请继续检查项目。  ' })
  assert.equal(h.prompts[0].content[0].text, '  华子，请继续检查项目。  ')
})

test('acknowledges input before synchronous prompt replies reach the runtime', async () => {
  const h = await harness({ prompt: (request, bridge) => {
    bridge.sessionEvent({ id: request.sessionId }, { type: 'turn/start', data: { turn: 1 } })
    bridge.sessionEvent({ id: request.sessionId }, { type: 'user/message', data: { turn: 1, source: { kind: 'user', rpcId: request.requestId } } })
    bridge.sessionEvent({ id: request.sessionId }, { type: 'assistant/message', data: { turn: 1, message: { content: 'fast' } } })
  } })
  await h.wake(); await h.submit()
  assert.deepEqual(h.sent.slice(-4).map(event => event.type), ['input.accepted', 'run.started', 'output.started', 'output.segment'])
})

test('keeps queued input identities and ignores unrelated text turns', async () => {
  const h = await harness()
  await h.wake(); await h.submit('first'); await h.submit('second')
  h.bridge.sessionEvent({ id: 'session-b' }, { type: 'turn/start', data: { turn: 1 } })
  h.bridge.sessionEvent({ id: 'session-b' }, { type: 'user/message', data: { turn: 1, source: { kind: 'user', rpcId: 'text-request' } } })
  h.reply('text reply'); h.end()
  assert.equal(h.sent.filter(event => event.type === 'run.started').length, 0)
  h.start(h.prompts[0], 2); h.reply('first reply', 2); h.end(2)
  h.start(h.prompts[1], 3); h.reply('second reply', 3); h.end(3)
  assert.deepEqual(h.sent.filter(event => event.type === 'output.segment').map(event => [event.correlation.input_id, event.payload.speak_text]), [
    ['first', 'first reply'], ['second', 'second reply'],
  ])
})

test('speaks one reply when DS Bot consumes multiple queued inputs in one turn', async () => {
  const h = await harness()
  await h.wake(); await h.submit('first'); await h.submit('second')
  h.start(h.prompts[0]); h.start(h.prompts[1]); h.reply('shared answer'); h.end()
  assert.deepEqual(h.sent.filter(event => event.type === 'output.segment').map(event => event.correlation.input_id), ['second'])
  assert.deepEqual(h.sent.filter(event => event.type === 'run.ended').map(event => event.correlation.input_id), ['first', 'second'])
})

test('splits long assistant messages into bounded ordered TTS segments', async () => {
  const h = await harness()
  await h.wake(); await h.submit(); h.start(h.prompts[0])
  const text = '你好😀'.repeat(10000)
  h.reply(text); h.end()
  const segments = h.sent.filter(event => event.type === 'output.segment')
  assert.ok(segments.length > 1)
  assert.equal(segments.map(event => event.payload.speak_text).join(''), text)
  for (const [index, event] of segments.entries()) {
    assert.equal(event.payload.segment_index, index)
    assert.ok(Buffer.byteLength(JSON.stringify(event)) < 65536)
  }
})

test('rejects missing, switched, stale-generation and mismatched owner segments before dispatch', async () => {
  const h = await harness()
  await h.submit('missing')
  await h.wake()
  await h.submit('generation', { generation: 0 })
  await h.submit('owner', { speaker: { status: 'owner_verified', segment_id: 'other' } })
  await h.submit('no-segment', { segment_id: undefined, speaker: { status: 'owner_verified' } })
  await h.wake('a', 'wake-2', 2)
  await h.submit('old')
  assert.equal(h.prompts.length, 0)
  assert.deepEqual(h.sent.filter(event => event.type === 'input.rejected').map(event => event.payload.error_code), [
    'invalid_wake', 'invalid_wake', 'identity_not_verified', 'identity_not_verified', 'invalid_wake',
  ])
})

test('invalidates an accepted wake after Bot rename or session replacement', async () => {
  for (const change of [h => { h.state.bots.b.phoneAgent.wakeName = '新名字' }, h => { h.state.bots.b.sessionId = 'replacement' }]) {
    const h = await harness()
    await h.wake(); change(h)
    await h.submit()
    assert.equal(h.prompts.length, 0)
    assert.equal(h.sent.at(-1).payload.error_code, 'invalid_wake')
  }
})

test('rechecks wake/session ownership after asynchronous capability setup', async () => {
  let ready
  const gate = new Promise(resolve => { ready = resolve })
  const h = await harness({ ensureCapabilities: () => gate })
  await h.wake()
  const submit = h.submit()
  await h.wake('a', 'wake-2', 2)
  ready(); await submit
  assert.equal(h.prompts.length, 0)
  assert.equal(h.sent.at(-1).payload.error_code, 'invalid_wake')
})

test('publishes changed roles once and rejects old wake mappings', async () => {
  const h = await harness()
  await h.wake()
  h.state.revision = 2; h.state.bots.b.phoneAgent.wakeName = '新名字'
  h.bridge.rolesChanged(); h.bridge.rolesChanged()
  assert.equal(h.sent.filter(event => event.type === 'roles.changed').length, 1)
  await h.receive('device.wake', { wake_session_id: 'stale' }, {
    wake_session_id: 'stale', bot_id: 'b', wake_mapping_version: 'epoch-1:1', generation: 2,
  })
  assert.equal(h.sent.at(-1).type, 'bridge.error')
  await h.submit()
  assert.equal(h.prompts.length, 0)
})

test('keeps wakes and reply delivery valid across unrelated state saves', async () => {
  const h = await harness()
  await h.wake()
  h.state.revision = 2
  h.bridge.rolesChanged()
  assert.equal(h.sent.some(event => event.type === 'roles.changed'), false)
  await h.submit(); h.start(h.prompts[0]); h.reply()
  assert.equal(h.sent.at(-1).type, 'output.segment')
})

test('rejects delayed earlier wake generations instead of reactivating an old Bot', async () => {
  const h = await harness()
  await h.wake(); await h.wake('a', 'wake-2', 2); await h.wake('b', 'wake-1', 1)
  assert.equal(h.sent.at(-1).type, 'bridge.error')
  await h.submit()
  assert.equal(h.prompts.length, 0)
})

test('accepts the positive integer segment identities produced by the PCM collector', async () => {
  const h = await harness()
  await h.wake()
  await h.submit('input-1', { segment_id: 1, speaker: { status: 'owner_verified', segment_id: 1 } })
  assert.equal(h.sent.at(-1).type, 'input.accepted')
  assert.equal(h.prompts.length, 1)
})

test('queries an existing input instead of dispatching it twice', async () => {
  const h = await harness()
  await h.wake(); await h.submit(); await h.submit()
  assert.equal(h.prompts.length, 1)
  assert.equal(h.sent.at(-1).type, 'input.status.result')
  assert.equal(h.sent.at(-1).payload.status, 'queued')
})

test('reports submission failures and refuses to attribute later unrelated turns', async () => {
  const h = await harness({ prompt: () => { throw new Error('provider private failure') } })
  await h.wake(); await h.submit()
  assert.equal(h.sent.at(-1).payload.error_code, 'submit_failed')
  h.start(h.prompts[0]); h.reply()
  assert.equal(h.sent.some(event => event.type === 'run.started'), false)
  await h.receive('input.status', { input_id: 'input-1' })
  assert.equal(h.sent.at(-1).payload.status, 'failed')
})

test('returns bounded Bot context without private instructions or credentials', async () => {
  const h = await harness()
  h.state.bots.b.role = 'reviewer'
  h.state.bots.b.instructions = 'private'
  await h.receive('context.snapshot.get', { request_id: 'context-1' }, { bot_id: 'b', recent_reply: 'done', dialogue_active: true })
  assert.deepEqual(h.sent.at(-1).payload, {
    bot_id: 'b', user_id: 'owner', profile_version: 1, agent_names: ['Beta'], explicit_wake_required: true,
    negative_addressing_examples: [], rules: ['reviewer'], dialogue_active: true, recent_reply: 'done', wake_names: ['小贝'],
  })
})

test('suppresses old playback on Bot switch while keeping background work alive', async () => {
  const h = await harness()
  await h.wake(); await h.submit(); h.start(h.prompts[0])
  await h.wake('a', 'wake-2', 2)
  h.reply('late old answer'); h.end()
  assert.equal(h.sent.some(event => event.type === 'output.segment'), false)
  assert.equal(h.cancels.length, 0)
  await h.receive('input.status', { input_id: 'input-1' })
  assert.equal(h.sent.at(-1).payload.status, 'completed')
})

test('output cancellation leaves work running, explicit run cancellation uses sessionController', async () => {
  const h = await harness()
  await h.wake(); await h.submit(); h.start(h.prompts[0])
  const output = h.sent.find(event => event.type === 'output.started')
  await h.receive('output.cancel', { response_id: output.correlation.response_id, target_id: 'windows-1' })
  h.reply('muted')
  assert.equal(h.sent.some(event => event.type === 'output.segment'), false)
  assert.equal(h.cancels.length, 0)
  await h.receive('run.cancel', { run_id: output.correlation.run_id })
  assert.deepEqual(h.cancels, [{ sessionId: 'session-b' }])
  assert.equal(h.sent.at(-1).payload.result, 'cancelled')
})

test('input cancellation removes only its exact queued controller message', async () => {
  const h = await harness()
  await h.wake(); await h.submit()
  h.bridge.sessionEvent({ id: 'session-b' }, { type: 'agent/inbox/spliced', data: { inserted: [{
    id: 'queue-message', source: { kind: 'user', rpcId: h.prompts[0].requestId },
  }] } })
  await h.receive('input.cancel', { input_id: 'input-1' })
  assert.deepEqual(h.removals, [{ sessionId: 'session-b', itemId: 'queue-message', action: { kind: 'remove' } }])
  assert.equal(h.cancels.length, 0)
  await h.receive('input.status', { input_id: 'input-1' })
  assert.equal(h.sent.at(-1).payload.status, 'cancelled')
})

test('delivery rejects foreign targets and decreasing segment acknowledgements', async () => {
  const h = await harness()
  await h.wake(); await h.submit(); h.start(h.prompts[0]); h.reply()
  const output = h.sent.find(event => event.type === 'output.started')
  await assert.rejects(h.receive('delivery.progress', { response_id: output.correlation.response_id, target_id: 'another' }, { last_completed_segment_index: 0 }), /invalid_delivery/)
  await h.receive('delivery.progress', output.correlation, { last_completed_segment_index: 0 })
  await assert.rejects(h.receive('delivery.progress', output.correlation, { last_completed_segment_index: -1 }), /invalid_delivery/)
})

test('retains status after disconnect without delivering replies into the new connection', async () => {
  const inputs = new Map()
  const old = await harness({ inputs })
  await old.wake(); await old.submit(); old.start(old.prompts[0])
  old.bridge.close()
  const size = old.sent.length
  const next = await harness({ inputs })
  old.reply('finished offscreen'); old.end()
  assert.equal(old.sent.length, size)
  await next.receive('input.status', { input_id: 'input-1' })
  assert.equal(next.sent.at(-1).payload.status, 'completed')
  assert.equal(next.sent.some(event => event.type.startsWith('output.')), false)
})

test('attributes real DS Bot user messages that carry no turn field', async () => {
  const h = await harness()
  await h.wake(); await h.submit()
  h.bridge.sessionEvent({ id: 'session-b' }, { type: 'turn/start', data: { turn: 7 } })
  h.bridge.sessionEvent({ id: 'session-b' }, { type: 'user/message', data: {
    source: { kind: 'user', rpcId: h.prompts[0].requestId },
  } })
  h.reply('correct turn', 7)
  h.reply('wrong turn', 6)
  assert.deepEqual(h.sent.filter(event => event.type === 'output.segment').map(event => event.payload.speak_text), ['correct turn'])
})

test('preserves running input status through a real socket reconnect', { timeout: 5000 }, async () => {
  let prompt
  const state = { revision: 1, bots: { b: { id: 'b', name: 'Beta', sessionId: 'session-b' } } }
  const rt = { state, botOf: id => state.bots[id], chatOf: id => state.bots[id]?.sessionId,
    ensureCapabilities: async () => {}, ctx: { sessionController: { prompt: async request => { prompt = request } } } }
  const server = new VoiceBridgeServer({ rt, deviceId: 'windows-1', credential: 'secret', activityEpoch: 'epoch-1',
    getRoles: () => createVoiceRoleRoster(state, 'epoch-1') })
  const view = await server.start()
  try {
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${view.port}`, { headers: { authorization: 'Bearer secret' } })
      await once(socket, 'open')
      let sequence = 0, binding = null
      const request = async (type, correlation = {}, payload = {}) => {
        const next = once(socket, 'message')
        socket.send(JSON.stringify(envelope(type, sequence++, binding, correlation, payload)))
        return JSON.parse(String((await next)[0]))
      }
      binding = (await request('bridge.hello', {}, { channel: 'voice', target_id: 'windows-1' })).binding
      return { socket, request }
    }
    const first = await connect()
    await first.request('device.wake', { wake_session_id: 'wake' }, {
      wake_session_id: 'wake', bot_id: 'b', generation: 1, wake_mapping_version: 'epoch-1:1',
    })
    await first.request('input.submit', { input_id: 'input' }, {
      channel: 'voice', bot_id: 'b', session_id: 'session-b', wake_session_id: 'wake', generation: 1,
      segment_id: 1, speaker: { status: 'owner_verified', segment_id: 1 }, text: 'hello',
    })
    server.sessionEvent({ id: 'session-b' }, { type: 'turn/start', data: { turn: 1 } })
    server.sessionEvent({ id: 'session-b' }, { type: 'user/message', data: { source: { kind: 'user', rpcId: prompt.requestId } } })
    first.socket.terminate(); await once(first.socket, 'close')
    const next = await connect()
    assert.equal((await next.request('input.status', { input_id: 'input' })).payload.status, 'running')
    server.sessionEvent({ id: 'session-b' }, { type: 'assistant/message', data: { turn: 1, message: { content: 'old answer' } } })
    server.sessionEvent({ id: 'session-b' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const status = await next.request('input.status', { input_id: 'input' })
    assert.equal(status.type, 'input.status.result')
    assert.equal(status.payload.status, 'completed')
    next.socket.terminate()
  } finally { await server.stop() }
})

test('checks complete envelopes and monotonically increasing per-connection sequence', async () => {
  const h = await harness()
  await assert.rejects(h.bridge.receive({ type: 'input.submit' }), /invalid_envelope/)
  await assert.rejects(h.bridge.receive(envelope('roles.snapshot.get', 4, h.bridge.binding, { request_id: 'r' })), /invalid_sequence/)
  const binding = { channel_session_id: h.bridge.binding.channel_session_id, device_id: 'windows-1', activity_epoch: 'epoch-1' }
  await h.bridge.receive(envelope('roles.snapshot.get', 1, binding, { request_id: 'r' }))
  assert.equal(h.sent.at(-1).type, 'roles.snapshot.result')
})

test('accepts only authenticated loopback connections and returns full error envelopes', async () => {
  const server = new VoiceBridgeServer({ rt: { state: { revision: 1, bots: {} } }, deviceId: 'windows-1', credential: 'secret',
    getRoles: () => ({ activity_epoch: 'epoch-1', revision: 1, roles: [] }) })
  await assert.rejects(server.start({ host: '0.0.0.0' }), /loopback/)
  const view = await server.start()
  try {
    const open = authorization => new Promise(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${view.port}`, { headers: { authorization } })
      socket.once('open', () => resolve(socket))
      socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(null) })
      socket.once('error', () => resolve(null))
    })
    assert.equal(await open('Bearer wrong'), null)
    const socket = await open('Bearer secret')
    const receive = () => new Promise(resolve => socket.once('message', data => resolve(JSON.parse(String(data)))))
    let next = receive()
    socket.send(JSON.stringify(envelope('bridge.hello', 0, null, {}, { channel: 'voice', target_id: 'windows-1' })))
    const ready = await next
    next = receive()
    socket.send(JSON.stringify(envelope('roles.snapshot.get', 4, ready.binding, { request_id: 'r' })))
    const error = await next
    assert.equal(error.type, 'bridge.error')
    assert.equal(error.protocol, 'agent-events.v1')
    assert.equal(error.sequence, 1)
    assert.deepEqual(error.binding, ready.binding)
    assert.equal(error.payload.error_code, 'invalid_sequence')
    socket.terminate()
  } finally { await server.stop() }
})
