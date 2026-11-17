import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import WebSocket from 'ws'
import { install, MossLiveManager, MossLiveRelay, normalizeMossLiveConfig, normalizeMossProfileMemory, mossProfileMemoryContext } from '../src/host/moss-live.js'

const profiles = () => [
  { id: 'practice', botId: 'coach', name: '口语练习' },
  { id: 'work', botId: 'chief', name: '工作' },
]
function host() {
  const rt = { state: { prefs: { mossLive: { profiles: profiles(), selectedProfileId: 'practice' } } }, ctx: { effect() {} }, save: async () => {}, secretValue: () => '' }
  install(rt)
  return rt
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('Profile recording checkpoints update one call and survive configuration reload and stale settings', async () => {
  const rt = host()
  const stale = structuredClone(rt.mossLive().config)
  const call = { profileId: 'practice', recordId: 'call-a', startedAt: '2026-11-17T01:00:00Z', transcript: [{ kind: 'user', text: '练习电话预约。' }] }
  await rt.mossLiveMemorySave(call)
  await rt.mossLiveMemorySave({ ...call, endedAt: '2026-11-17T01:05:00Z', transcript: [...call.transcript, { kind: 'assistant', text: '下一步说明预约时间。' }] })
  await rt.mossLiveUpdate({ config: stale })
  const reloaded = normalizeMossLiveConfig(JSON.parse(JSON.stringify(rt.state.prefs.mossLive)))
  assert.equal(reloaded.profiles[0].memory.turns.length, 1)
  assert.equal(reloaded.profiles[0].memory.turns[0].items[1].text, '下一步说明预约时间。')
  assert.equal(reloaded.profiles[1].memory, undefined)
  assert.match(reloaded.profiles[0].memory.summary, /预约/)
})

test('starting a fresh exercise archives older calls without restoring their context later', async () => {
  const rt = host()
  await rt.mossLiveMemorySave({ profileId: 'practice', recordId: 'old', transcript: [{ kind: 'user', text: '旧练习：飞机驾驶。' }] })
  await rt.mossLiveMemorySave({ profileId: 'practice', recordId: 'new', resume: false, transcript: [{ kind: 'user', text: '新练习：餐厅点菜。' }] })
  await rt.mossLiveMemorySave({ profileId: 'practice', recordId: 'new', resume: false, transcript: [{ kind: 'user', text: '新练习：餐厅点菜。' }, { kind: 'assistant', text: '先说你想点什么。' }] })
  const memory = rt.mossLive().config.profiles[0].memory
  assert.equal(memory.turns.length, 2)
  assert.match(JSON.stringify(memory.turns), /飞机驾驶/)
  assert.match(mossProfileMemoryContext(memory), /餐厅点菜/)
  assert.doesNotMatch(mossProfileMemoryContext(memory), /飞机驾驶/)
})

test('bounded context retains the latest sentences and does not cut Unicode characters in half', () => {
  const memory = normalizeMossProfileMemory({ turns: Array.from({ length: 9 }, (_, n) => ({
    id: `call-${n}`, items: Array.from({ length: 12 }, (_, m) => ({ kind: 'user', text: `${n}-${m}：${'😀'.repeat(1300)}` })),
  })) })
  assert.equal([...memory.turns[0].items[0].text].length, 1200)
  const context = mossProfileMemoryContext(memory)
  assert.ok([...context].length <= 6000)
  assert.match(context, /8-11：/)
  assert.equal(context.isWellFormed(), true)
})

test('resuming sends saved Profile context over the actual relay before microphone input', async t => {
  class Upstream extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = [] }
    send(raw) {
      const value = JSON.parse(raw)
      this.sent.push(value)
      if (value.action === 'session.update') this.emit('message', JSON.stringify({ action: 'session.updated', data: { error: '' } }), false)
    }
    close() { this.readyState = 3 }
  }
  const config = normalizeMossLiveConfig({ profiles: [{ ...profiles()[0], memory: { turns: [{ id: 'saved', items: [{ kind: 'user', text: '只属于口语练习的记忆。' }] }] } }, profiles()[1]], selectedProfileId: 'practice' })
  const manager = new MossLiveManager({ secretValue: () => 'synthetic-key' }, { createRelay: options => new MossLiveRelay({ ...options, WebSocketImpl: Upstream }) })
  t.after(() => manager.stop())
  await manager.start(config)
  const socket = new WebSocket(`ws://127.0.0.1:${manager.view().port}/?token=${manager.view().token}`)
  t.after(() => socket.close())
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const ready = new Promise(resolve => socket.once('message', resolve))
  socket.send(JSON.stringify({ action: 'session.update', session: { instructions: '简短回答。' } }))
  await ready
  assert.match(JSON.stringify(manager.relay.upstream.sent), /只属于口语练习的记忆/)
  assert.doesNotMatch(JSON.stringify(manager.relay.upstream.sent), /"action":"response.create"/)
  await manager.stop()
  await manager.start(config, { resumeMemory: false })
  const fresh = new WebSocket(`ws://127.0.0.1:${manager.view().port}/?token=${manager.view().token}`)
  t.after(() => fresh.close())
  await new Promise((resolve, reject) => { fresh.once('open', resolve); fresh.once('error', reject) })
  const freshReady = new Promise(resolve => fresh.once('message', resolve))
  fresh.send(JSON.stringify({ action: 'session.update', session: { instructions: '新练习。' } }))
  await freshReady
  assert.doesNotMatch(JSON.stringify(manager.relay.upstream.sent), /只属于口语练习的记忆/)
  await tick()
})
