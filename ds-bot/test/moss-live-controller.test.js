import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSource } from '../src/client/sources.js'

import { createMossLiveController, bindMossLiveLifecycle } from '../src/client/moss-live-controller.js'
import { transcriptEvent } from '../src/client/moss-live.js'
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(extra = {}) {
  assert.equal(typeof createMossLiveController, 'function', 'MOSS needs a page-independent session owner')
  const calls = [], sessions = []
  const config = { enabled: true, greetingEnabled: false, profiles: [{ id: 'profile-h', botId: 'bot-h', name: '华子', readHistory: true, submitTasks: true }], selectedProfileId: 'profile-h' }
  const actions = {
    mossLiveStop: async () => { calls.push('host-stop'); return { config: { ...config, enabled: false }, runtime: { state: 'stopped' } } },
    mossLiveStart: async () => { calls.push('host-start'); return { config, runtime: { port: 1234, token: 'test' } } },
    ...extra.actions,
  }
  const createSession = options => {
    const session = {
      options, state: 'idle', ws: {}, micEnabled: true, stops: 0,
      async connect() { calls.push('connect'); options.onState('connecting') },
      async startMic() { calls.push('mic'); session.state = 'ready'; options.onState('ready') },
      setMicEnabled(enabled) { session.micEnabled = enabled },
      async startScreenShare() { options.onScreenStream({ id: 'screen-stream' }); return true },
      async stopScreenShare() { options.onScreenStream(null) },
      async stop() { session.stops++; session.ws = null; options.onScreenStream(null); options.onState('stopped') },
    }
    sessions.push(session)
    return session
  }
  const controller = createMossLiveController({ ...extra, actions, createSession: extra.createSession ?? createSession })
  return { controller, sessions, calls, config }
}

test('removing every view subscriber preserves the same session, captions, mute and screen stream', async () => {
  const { controller, sessions, calls } = fixture()
  await controller.start()
  const session = sessions[0]
  session.options.onTranscript({ kind: 'user', text: '先看看华子的记录', final: true })
  controller.setMuted(true)
  await controller.startScreenShare()
  const before = controller.getSnapshot()
  const off = controller.subscribe(() => {})
  off()
  assert.equal(session.stops, 0)
  assert.equal(controller.getSnapshot(), before)
  assert.equal(before.transcript[0].text, '先看看华子的记录')
  assert.equal(before.muted, true)
  assert.equal(before.screenStream.id, 'screen-stream')
  assert.equal(calls.filter(item => item === 'host-start').length, 1)
  await controller.dispose()
  assert.equal(session.stops, 1)
})

test('stopping screen sharing keeps voice alive, while ending clears resources and rejects late events', async () => {
  const { controller, sessions } = fixture()
  await controller.start()
  const session = sessions[0]
  await controller.startScreenShare()
  await controller.stopScreenShare()
  assert.equal(controller.getSnapshot().screenStream, null)
  assert.equal(controller.getSnapshot().active, true)
  await controller.stop()
  assert.equal(session.stops, 1)
  assert.equal(controller.getSnapshot().visible, true)
  assert.equal(controller.getSnapshot().active, false)
  assert.ok(controller.getSnapshot().endedAt)
  session.options.onTranscript({ kind: 'assistant', text: '迟到结果' })
  session.options.onState('speaking')
  assert.equal(controller.getSnapshot().transcript.length, 0)
  assert.equal(controller.getSnapshot().sessionState, 'stopped')
})

test('hanging up keeps the bar and captions, while redial starts one fresh session without resuming screen sharing', async () => {
  const { controller, sessions, calls } = fixture()
  await controller.start()
  sessions[0].options.onTranscript({ kind: 'user', text: '上一通电话', done: true })
  await controller.startScreenShare()
  await controller.stop()
  assert.equal(controller.getSnapshot().visible, true)
  assert.equal(controller.getSnapshot().transcript[0].text, '上一通电话')
  assert.equal(controller.getSnapshot().screenStream, null)
  await Promise.all([controller.start(), controller.start()])
  assert.equal(sessions.length, 2)
  assert.equal(calls.filter(item => item === 'host-start').length, 2)
  assert.equal(controller.getSnapshot().active, true)
  assert.equal(controller.getSnapshot().transcript.length, 0)
  assert.equal(controller.getSnapshot().screenStream, null)
  sessions[0].options.onTranscript({ kind: 'assistant', text: '上一通的迟到结果' })
  assert.equal(controller.getSnapshot().transcript.length, 0)
  await controller.dispose()
  assert.equal(controller.getSnapshot().visible, false)
})

test('hanging up persists the final timestamp on the current Profile recording', async () => {
  const memoryCalls = []
  const { controller, sessions, calls, config } = fixture({ actions: {
    mossLiveMemorySave: async value => { memoryCalls.push(value); return { config } },
  } })
  await controller.start()
  sessions[0].options.onTranscript({ kind: 'user', text: '把这一段记住', done: true })
  await controller.stop()
  assert.equal(memoryCalls.at(-1).profileId, 'profile-h')
  assert.equal(memoryCalls.at(-1).transcript[0].text, '把这一段记住')
  assert.ok(memoryCalls.at(-1).endedAt)
  assert.equal(new Set(memoryCalls.map(value => value.recordId)).size, 1)
  assert.ok(calls.includes('host-stop'))
})

test('starting a remembered Profile can explicitly begin a new context', async () => {
  const startArgs = []
  const { controller, config } = fixture({ actions: {
    mossLiveStart: async body => { startArgs.push(body); return { config, runtime: { port: 1234, token: 'test' } } },
  } })
  await controller.start('profile-h', { resume: false })
  assert.deepEqual(startArgs, [{ profileId: 'profile-h', resume: false }])
})

test('final captions checkpoint memory before hangup and media stop does not wait for disk storage', async () => {
  const gate = pending(), memoryCalls = []
  const { controller, sessions } = fixture({ actions: { mossLiveMemorySave: value => { memoryCalls.push(value); return gate.promise } } })
  await controller.start('profile-h')
  sessions[0].options.onTranscript({ kind: 'user', text: '本轮练习。', done: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(memoryCalls.length, 1)
  const stopping = controller.stop()
  assert.equal(sessions[0].stops, 1, 'hanging up must release the microphone before waiting for storage')
  gate.resolve({ config: { profiles: [] } })
  await stopping
  assert.ok(memoryCalls[0].recordId)
  assert.equal(new Set(memoryCalls.map(value => value.recordId)).size, 1)
  await controller.dispose()
})

test('an empty interruption checkpoints the terminal caption without saving unspoken text', async () => {
  const saved = []
  const { controller, sessions } = fixture({ actions: { mossLiveMemorySave: async value => { saved.push(value); return { config: { profiles: [] } } } } })
  await controller.start('profile-h')
  const emit = sessions[0].options.onTranscript
  emit(transcriptEvent('input.transcript.done', { turn: 'u1', text: '本轮问题' }))
  emit(transcriptEvent('output.transcript.updated', { run_id: 'r1', turn_id: 't1', text: '还没有实际播出的回答' }))
  emit(transcriptEvent('response.interrupted', { run_id: 'r1', turn_id: 't1', text: '' }))
  emit(transcriptEvent('output.transcript.done', { run_id: 'r1', turn_id: 't1', text: '迟到的完整回答' }))
  await controller.stop()
  assert.equal(controller.getSnapshot().transcript.at(-1).done, true)
  assert.equal(controller.getSnapshot().transcript.at(-1).text, '')
  assert.doesNotMatch(JSON.stringify(saved.at(-1)), /还没有实际播出|迟到的完整/)
  assert.equal(new Set(saved.map(value => value.recordId)).size, 1)
  await controller.dispose()
})

test('a memory write error is visible and repeated hangup does not duplicate the call', async () => {
  const memoryCalls = []
  const { controller, sessions } = fixture({ actions: { mossLiveMemorySave: async value => { memoryCalls.push(value); throw new Error('disk full') } } })
  await controller.start('profile-h')
  sessions[0].options.onTranscript({ kind: 'assistant', text: '保留的对话。', done: true })
  await controller.stop()
  assert.match(controller.getSnapshot().memoryError, /保存/)
  assert.equal(controller.getSnapshot().active, false)
  await controller.stop()
  assert.equal(new Set(memoryCalls.map(value => value.recordId)).size, 1)
  await controller.dispose()
})

test('disabling the plugin during hangup hides the retained bar before cleanup finishes', async () => {
  const gate = pending()
  let ending = false
  const { controller } = fixture({ actions: { mossLiveStop: () => ending ? gate.promise : Promise.resolve() } })
  const roster = createSource({ pluginsEnabled: true })
  const release = bindMossLiveLifecycle(controller, { roster, events: new EventTarget() })
  await controller.start()
  ending = true
  const stopped = controller.stop()
  assert.equal(controller.getSnapshot().visible, true)
  roster.set({ pluginsEnabled: false })
  assert.equal(controller.getSnapshot().visible, false)
  gate.resolve()
  await stopped
  await release()
})

test('ending during Host startup closes the late relay and never acquires a microphone', async () => {
  const gate = pending()
  const { controller, sessions, calls, config } = fixture({ actions: { mossLiveStart: () => { calls.push('host-start'); return gate.promise } } })
  const started = controller.start()
  await new Promise(resolve => setImmediate(resolve))
  const stopped = controller.stop()
  gate.resolve({ config, runtime: { port: 1234, token: 'late' } })
  await Promise.all([started, stopped])
  assert.equal(sessions.length, 0)
  assert.equal(controller.getSnapshot().active, false)
  assert.equal(controller.getSnapshot().busy, false)
  assert.equal(calls.at(-1), 'host-stop')
})

test('mute chosen during the greeting survives its completion and a return to listening', async () => {
  const gate = pending()
  const { controller, sessions, config } = fixture({ greet: () => gate.promise })
  config.greetingEnabled = true
  const started = controller.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getSnapshot().sessionState, 'greeting')
  controller.setMuted(true)
  gate.resolve()
  await started
  assert.equal(sessions[0].micEnabled, false)
  assert.equal(controller.getSnapshot().muted, true)
  await controller.dispose()
})

test('a ready event during the greeting cannot enable the microphone early', async () => {
  const gate = pending()
  const { controller, sessions, config } = fixture({ greet: () => gate.promise })
  config.greetingEnabled = true
  const started = controller.start()
  await new Promise(resolve => setImmediate(resolve))
  sessions[0].options.onState('ready')
  controller.setMuted(false)
  assert.equal(sessions[0].micEnabled, false)
  gate.resolve()
  await started
  assert.equal(sessions[0].micEnabled, true)
  await controller.dispose()
})

test('plugin disable and application teardown stop the owner, not navigation', async () => {
  const { controller, sessions } = fixture()
  const roster = createSource({ pluginsEnabled: true })
  const events = new EventTarget()
  assert.equal(typeof bindMossLiveLifecycle, 'function')
  const release = bindMossLiveLifecycle(controller, { roster, events })
  await controller.start()
  roster.set({ pluginsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sessions[0].stops, 1)
  assert.equal(controller.getSnapshot().visible, false)
  roster.set({ pluginsEnabled: true })
  await controller.start()
  events.dispatchEvent(new Event('pagehide'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sessions[1].stops, 1)
  await release()
})

test('leaving the bound Bot page ends the MOSS call and releases its resources', async () => {
  const { controller, sessions } = fixture()
  const roster = createSource({ pluginsEnabled: true })
  const page = createSource('bot-h')
  const release = bindMossLiveLifecycle(controller, { roster, currentBotId: () => page.getSnapshot(), currentBotSource: page, events: new EventTarget() })
  await controller.start()
  page.set('bot-w')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sessions[0].stops, 1)
  assert.equal(controller.getSnapshot().active, false)
  await release()
})

test('a bound current Bot shows the idle MOSS sidebar before dialing', async () => {
  const { controller, config } = fixture()
  const roster = createSource({ pluginsEnabled: true })
  const page = createSource('bot-h')
  const release = bindMossLiveLifecycle(controller, {
    roster,
    currentBotId: () => page.getSnapshot(),
    currentBotSource: page,
    resolveBinding: async botId => config.profiles.find(profile => profile.botId === botId) ?? null,
    events: new EventTarget(),
  })
  await new Promise(resolve => setImmediate(resolve))
  const state = controller.getSnapshot()
  assert.equal(state.visible, true)
  assert.equal(state.active, false)
  assert.equal(state.boundBotId, 'bot-h')
  assert.equal(state.boundProfile.id, 'profile-h')
  page.set('bot-unbound')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getSnapshot().visible, false)
  await release()
})

test('switching from one bound Bot to another ends the call and reveals the new idle Profile', async () => {
  const { controller, sessions, config } = fixture()
  config.profiles.push({ id: 'profile-w', botId: 'bot-w', name: '才子', readHistory: false, submitTasks: true })
  const roster = createSource({ pluginsEnabled: true })
  const page = createSource('bot-h')
  const release = bindMossLiveLifecycle(controller, {
    roster,
    currentBotId: () => page.getSnapshot(),
    currentBotSource: page,
    resolveBinding: async botId => config.profiles.find(profile => profile.botId === botId) ?? null,
    events: new EventTarget(),
  })
  await new Promise(resolve => setImmediate(resolve))
  await controller.start('profile-h')
  page.set('bot-w')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sessions[0].stops, 1)
  assert.equal(controller.getSnapshot().visible, true)
  assert.equal(controller.getSnapshot().active, false)
  assert.equal(controller.getSnapshot().boundBotId, 'bot-w')
  assert.equal(controller.getSnapshot().boundProfile.id, 'profile-w')
  await release()
})

test('unexpected disconnect ends the timer, keeps an honest status, and cannot resume a greeting', async () => {
  const gate = pending()
  const { controller, sessions, config } = fixture({ greet: () => gate.promise })
  config.greetingEnabled = true
  const started = controller.start()
  await new Promise(resolve => setImmediate(resolve))
  sessions[0].ws = null
  sessions[0].options.onState('closed')
  gate.resolve()
  await started
  const state = controller.getSnapshot()
  assert.equal(state.active, false)
  assert.equal(state.visible, true)
  assert.equal(state.sessionState, 'closed')
  assert.ok(state.endedAt)
  assert.equal(sessions[0].micEnabled, false)
  await controller.dispose()
})

test('unexpected disconnect also preserves the finished transcript in Profile memory', async () => {
  const memoryCalls = []
  const { controller, sessions } = fixture({ actions: {
    mossLiveMemorySave: async value => { memoryCalls.push(value); return { config: { profiles: [] } } },
  } })
  await controller.start()
  sessions[0].options.onTranscript({ kind: 'assistant', text: '这段结果也要保留。', done: true })
  sessions[0].options.onState('closed')
  await new Promise(resolve => setImmediate(resolve))
  assert.match(memoryCalls.at(-1).transcript[0].text, /保留/)
  assert.ok(memoryCalls.at(-1).endedAt)
  assert.equal(new Set(memoryCalls.map(value => value.recordId)).size, 1)
  await controller.dispose()
})
