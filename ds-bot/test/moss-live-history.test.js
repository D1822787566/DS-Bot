import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../src/host/chat-index.js'
import { historyEntry } from '../src/host/parts.js'

test('MOSS history retrieval filters Bot, part, keywords and time before applying its result limit', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-moss-history-'))
  const disposers = []
  const start = Date.parse('2026-11-01T00:00:00Z')
  const records = (prefix, time) => Array.from({ length: 16 }, (_, seq) => ({ event: {
    seq, time: time + seq * 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${prefix} 发布 计划 ${seq}` }] },
  } }))
  const pages = { old: records('old', start), current: records('new', start + 86400_000), other: records('private', start) }
  pages.current[12].event.data.source = { kind: 'bot', role: 'request' }
  pages.current[12].event.data.content = [{ type: 'text', text: '内部资料：另一个 Bot 的消息' }]
  pages.current[13].event = { ...pages.current[13].event, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '内部资料：给另一个 Bot 的答复' }] } } }
  const rt = {
    home,
    ctx: {
      effect(callback) { disposers.push(callback()) },
      sessionController: { page: async ({ address }) => ({ records: pages[address.sessionId], hasMore: false }) },
    },
    warn: () => {}, historyEntry, clock: time => String(time),
    resolveAgent: async () => ({ session: { seq: 16 } }),
    partsOf: id => id === 'chief' ? [{ sessionId: 'old', number: 1, startedAt: start, endedAt: start + 20000 }, { sessionId: 'current', number: 2, startedAt: start + 86400_000 }] : [{ sessionId: 'other', number: 1, startedAt: start }],
  }
  install(rt)
  t.after(async () => { for (const dispose of disposers) await dispose?.(); await rm(home, { recursive: true, force: true }) })
  assert.equal(typeof rt.readBotChatContext, 'function', 'history needs a bounded structured read for the MOSS bridge')
  const result = await rt.readBotChatContext('chief', { query: '发布 计划', part: 1, from: start + 2000, to: start + 12000, limit: 6 }, AbortSignal.timeout(5000))
  assert.equal(result.rows.length, 6)
  assert.equal(result.truncated, true)
  assert.equal(result.partial, false)
  assert.ok(result.rows.every(row => row.session === 'old' && row.part === 1 && row.time >= start + 2000 && row.time < start + 12000))
  assert.doesNotMatch(JSON.stringify(result), /new|private/)
  assert.equal((await rt.readBotChatContext('chief', { query: '不存在', limit: 6 }, AbortSignal.timeout(5000))).rows.length, 0)
  const latest = await rt.readBotChatContext('chief', { query: '', limit: 6 }, AbortSignal.timeout(5000))
  assert.ok(latest.rows.every(row => row.session === 'current'))
  const internal = await rt.readBotChatContext('chief', { query: '内部资料', limit: 6 }, AbortSignal.timeout(5000))
  assert.equal(internal.rows.length, 0, 'MOSS user-chat access must not expose hidden Bot-to-Bot exchanges')
  assert.equal((await rt.searchOwnChat('chief', '内部资料')).lines.length, 2, 'the existing own-chat tool retains its original scope')
})
