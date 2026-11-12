import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as moss from '../src/host/moss-live.js'

function setup(options = {}) {
  assert.equal(typeof moss.MossDsBotBridge, 'function', 'MOSS must provide its scoped DS Bot bridge')
  const config = moss.normalizeMossLiveConfig({ dsBot: { enabled: true, bots: [
    { botId: 'chief', readHistory: true, submitTasks: true },
    { botId: 'writer', readHistory: false, submitTasks: true },
  ] } })
  const bots = {
    chief: { id: 'chief', name: 'Chief', instructions: 'hidden system prompt' },
    writer: { id: 'writer', name: 'Writer', private: true },
    closed: { id: 'closed', name: 'Closed' },
  }
  const sent = [], prompts = [], reads = []
  const rt = {
    state: { bots, prefs: { mossLive: config } },
    botOf: id => bots[id], chatOf: id => `${id}-chat`,
    load: async () => {}, ensureCapabilities: async () => {},
    ctx: { sessionController: { prompt: async request => { prompts.push(request); await options.prompt?.(request) } } },
    readBotChatContext: async (botId, filters) => {
      reads.push({ botId, filters })
      return options.read ? options.read(botId, filters) : { rows: [
        { session: 'chief-chat', seq: 7, part: 2, time: 100, who: 'user', text: '发布计划😀'.repeat(200) },
      ], truncated: false }
    },
  }
  const bridge = new moss.MossDsBotBridge(rt)
  bridge.open(value => {
    sent.push(value)
    if (value.action === 'session.thinking.append' && options.ackThinking !== false) void bridge.receive({ action: 'session.thinking.appended', data: { client_event_id: value.event_id } })
  })
  bridge.sessionUpdate({ instructions: '简洁回答' })
  const ready = () => bridge.receive({ action: 'session.updated', data: { error: '' } })
  const call = (name, args = {}, id = 'call-1', extra = {}) => bridge.receive({
    action: 'response.function_call_arguments.done',
    data: { call_id: id, name, arguments: JSON.stringify(args), ...extra },
  })
  const output = id => sent.find(value => value.action === 'conversation.item.create' && value.item.call_id === id)?.item.output
  const result = id => JSON.parse(output(id))
  const ack = id => bridge.receive({ action: 'conversation.item.created', data: { item: { type: 'function_call_output', call_id: id } } })
  return { rt, bots, config, bridge, sent, prompts, reads, ready, call, result, ack }
}

test('MOSS DS Bot access persists independent grants and remains disabled by default', () => {
  assert.deepEqual(moss.defaultMossLiveConfig().dsBot, { enabled: false, bots: [] })
  const config = moss.normalizeMossLiveConfig({ dsBot: { enabled: true, bots: [
    { botId: 'a', readHistory: true, submitTasks: false },
    { botId: 'b', readHistory: false, submitTasks: true },
  ] } })
  assert.deepEqual(config.dsBot.bots, [
    { botId: 'a', readHistory: true, submitTasks: false },
    { botId: 'b', readHistory: false, submitTasks: true },
  ])
})

test('MOSS tool configuration comes from Host and executes only after configuration succeeds', async () => {
  const s = setup()
  const session = s.bridge.sessionUpdate({ instructions: '简洁回答', tools: [{ name: 'delete_everything' }] })
  assert.deepEqual(session.tools.map(tool => tool.name), ['dsbot_list_bots', 'dsbot_read_context', 'dsbot_submit_task', 'dsbot_task_status'])
  assert.match(session.instructions, /明确/)
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' })
  assert.equal(s.prompts.length, 0)
  await s.bridge.receive({ action: 'session.updated', data: { error: 'rejected' } })
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' }, 'failed-config')
  assert.equal(s.prompts.length, 0)
  await s.ready()
  await s.call('dsbot_list_bots', {}, 'roster')
  assert.deepEqual(s.result('roster').bots.map(bot => bot.id), ['chief', 'writer'])
  assert.doesNotMatch(JSON.stringify(s.result('roster')), /hidden system prompt|Closed/)
})

test('history reads stay bounded, include their source, and never start a Bot model', async () => {
  const s = setup()
  await s.ready()
  await s.call('dsbot_read_context', { bot_id: 'chief', query: '发布', from: '2026-11-01T00:00:00+08:00', to: '2026-11-02T00:00:00+08:00', part: 2 })
  const result = s.result('call-1')
  assert.equal(s.reads[0].botId, 'chief')
  assert.equal(s.reads[0].filters.part, 2)
  assert.equal(result.snippets[0].botId, 'chief')
  assert.equal(result.snippets[0].seq, 7)
  assert.equal(result.snippets[0].part, 2)
  assert.ok([...result.snippets[0].text].length <= 600)
  assert.equal(result.truncated, true)
  assert.equal(s.prompts.length, 0)
  await s.call('dsbot_read_context', { bot_id: 'writer' }, 'no-read')
  assert.equal(s.result('no-read').error.code, 'access_denied')
  assert.equal(s.reads.length, 1)
})

test('revoking access while reading prevents the excerpt from reaching MOSS', async () => {
  let finish
  const s = setup({ read: () => new Promise(resolve => { finish = resolve }) })
  await s.ready()
  const pending = s.call('dsbot_read_context', { bot_id: 'chief' })
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  s.config.dsBot.bots[0].readHistory = false
  finish({ rows: [{ text: 'private excerpt', session: 'chief-chat', seq: 1, time: 1, part: 1 }] })
  await pending
  assert.equal(s.result('call-1').error.code, 'access_denied')
  assert.doesNotMatch(JSON.stringify(s.sent), /private excerpt/)
})

test('task admission queues once and resumes MOSS only after the exact result acknowledgement', async () => {
  const s = setup()
  await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'writer', text: '整理待办', context: '会议约定周五发布' }, 'submit', { task_id: 'remote-task', revision: 1 })
  await s.bridge.receive({ action: 'response.done', data: { response: { output: [{ type: 'function_call', call_id: 'submit', name: 'dsbot_submit_task', arguments: JSON.stringify({ bot_id: 'writer', text: '整理待办', context: '会议约定周五发布' }) }] } } })
  assert.equal(s.prompts.length, 1)
  assert.equal(s.prompts[0].sessionId, 'writer-chat')
  assert.equal(s.prompts[0].mode, 'queue')
  assert.match(s.prompts[0].content[0].text, /整理待办/)
  assert.equal(s.result('submit').status, 'queued')
  assert.ok(s.result('submit').taskId)
  assert.equal(s.sent.filter(value => value.action === 'response.create').length, 0)
  await s.ack('other-call')
  assert.equal(s.sent.filter(value => value.action === 'response.create').length, 0)
  await s.ack('submit'); await s.ack('submit')
  assert.deepEqual(s.sent.filter(value => value.action === 'response.create'), [{ action: 'response.create', response: { call_ids: ['submit'] } }])
  await s.call('dsbot_submit_task', { bot_id: 'writer', text: '不同的新任务' }, 'revision', { task_id: 'remote-task', revision: 2 })
  assert.equal(s.prompts.length, 1)
  assert.equal(s.result('revision').error.code, 'already_submitted')
})

function consumed(s, turn = 3, index = 0) {
  const request = s.prompts[index]
  s.bridge.sessionEvent({ id: request.sessionId }, { type: 'turn/start', data: { turn } })
  s.bridge.sessionEvent({ id: request.sessionId }, { type: 'user/message', data: { turn, source: { kind: 'user', rpcId: request.requestId } } })
}
function answered(s, text = '待办已整理', turn = 3, index = 0) {
  const session = { id: s.prompts[index].sessionId }
  s.bridge.sessionEvent(session, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
  s.bridge.sessionEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

test('only the matching admitted turn completes a task and reports its bounded result', async () => {
  const s = setup(); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' }); await s.ack('call-1')
  consumed(s)
  answered(s, '别人的普通聊天', 2)
  assert.equal(s.bridge.view().tasks[0].status, 'running')
  assert.equal(s.sent.filter(value => value.action === 'session.commentary.append').length, 0)
  answered(s, '待办😀'.repeat(1000))
  assert.equal(s.bridge.view().tasks[0].status, 'completed')
  const reports = s.sent.filter(value => value.action === 'session.commentary.append')
  assert.equal(reports.length, 1)
  assert.equal(reports[0].status, 'completed')
  assert.ok([...reports[0].content].length <= 2000)
})

test('closing MOSS retains Bot work but prevents late results from entering a new voice session', async () => {
  const s = setup(); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' }); await s.ack('call-1')
  consumed(s); s.bridge.close()
  s.bridge.open(value => s.sent.push(value)); await s.ready()
  answered(s)
  assert.equal(s.bridge.view().tasks[0].status, 'completed')
  assert.equal(s.sent.filter(value => value.action === 'session.commentary.append').length, 0)
})

test('a prompt RPC failure with unknown admission is never automatically retried', async () => {
  const s = setup({ prompt: async () => { throw new Error('RPC timeout with sensitive details') } }); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' })
  assert.equal(s.result('call-1').status, 'uncertain')
  assert.equal(s.bridge.view().tasks[0].status, 'uncertain')
  assert.doesNotMatch(JSON.stringify(s.sent), /sensitive details/)
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' })
  assert.equal(s.prompts.length, 1)
  consumed(s); answered(s)
  assert.equal(s.bridge.view().tasks[0].status, 'completed')
})

test('a task mixed with other input is marked for review instead of attributing an unrelated answer', async () => {
  const s = setup(); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' }); await s.ack('call-1')
  consumed(s)
  s.bridge.sessionEvent({ id: 'chief-chat' }, { type: 'user/message', data: { turn: 3, source: { kind: 'user', rpcId: 'manual-message' } } })
  answered(s, '包含其他请求的答复')
  assert.equal(s.bridge.view().tasks[0].status, 'needs_review')
  assert.doesNotMatch(JSON.stringify(s.sent.filter(value => value.action === 'session.commentary.append')), /包含其他请求的答复/)
})

test('automatic time context does not turn an actual Bot reply into mixed user input', async () => {
  const s = setup(); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '查询天气' }); await s.ack('call-1')
  consumed(s)
  s.bridge.sessionEvent({ id: 'chief-chat' }, { type: 'user/message', data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Current time' }] } })
  answered(s, '晴，二十五摄氏度')
  assert.equal(s.bridge.view().tasks[0].status, 'completed')
  const report = s.sent.find(value => value.action === 'session.commentary.append')
  assert.match(report.content, /二十五/)
  assert.equal(s.bridge.session.reports.size, 1)
  await s.bridge.receive({ action: 'session.commentary.appended', data: { client_event_id: report.event_id, type: 'session.commentary.appended' } })
  assert.equal(s.bridge.session.reports.size, 0)
})

test('task receipts use the status tool field and scoped MOSS task ids resolve to that same task', async () => {
  const s = setup(); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '查询天气' }, 'submit', { task_id: 'moss-task', revision: 1 })
  const receipt = s.result('submit')
  assert.equal(receipt.task_id, receipt.taskId)
  await s.call('dsbot_task_status', { task_id: 'moss-task' }, 'status')
  assert.equal(s.result('status').taskId, receipt.taskId)
  assert.equal(s.result('status').status, 'queued')
  s.bridge.open(value => s.sent.push(value)); await s.ready()
  await s.call('dsbot_task_status', { task_id: 'moss-task' }, 'new-session-status')
  assert.equal(s.result('new-session-status').error.code, 'unknown_task')
})

test('completed task facts are acknowledged before asking MOSS to report the result', async () => {
  const s = setup({ ackThinking: false }); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '查询天气' }); await s.ack('call-1')
  consumed(s); answered(s, '珠海晴，二十五摄氏度')
  const facts = s.sent.find(value => value.action === 'session.thinking.append')
  assert.ok(facts, 'the actual result must enter factual context')
  assert.match(facts.content, /二十五/)
  assert.equal(s.sent.some(value => value.action === 'session.commentary.append'), false)
  await s.bridge.receive({ action: 'session.thinking.appended', data: { client_event_id: facts.event_id } })
  assert.equal(s.sent.filter(value => value.action === 'session.commentary.append').length, 1)
  await s.bridge.receive({ action: 'session.thinking.appended', data: { client_event_id: facts.event_id } })
  assert.equal(s.sent.filter(value => value.action === 'session.commentary.append').length, 1)
})

test('permissions are checked after capability setup and interpretation exposes no tools', async () => {
  const s = setup(); await s.ready()
  s.rt.ensureCapabilities = async () => { s.config.dsBot.bots[0].submitTasks = false }
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' })
  assert.equal(s.prompts.length, 0)
  assert.equal(s.result('call-1').error.code, 'access_denied')
  s.config.mode = 'interpret'
  assert.equal(s.bridge.sessionUpdate({ instructions: '翻译' }).tools, undefined)
})

test('cancellation during a read suppresses its late result', async () => {
  let finish
  const s = setup({ read: () => new Promise(resolve => { finish = resolve }) }); await s.ready()
  const pending = s.call('dsbot_read_context', { bot_id: 'chief' }, 'read', { task_id: 'remote-read', revision: 1 })
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  await s.bridge.receive({ action: 'response.function_call.cancel_requested', data: { call_id: 'read', task_id: 'remote-read', revision: 1 } })
  finish({ rows: [{ text: 'late private data' }] }); await pending
  assert.equal(s.sent.filter(value => value.action === 'conversation.item.create').length, 0)
})

test('history excerpts include the matching text even when it is far into a long message', async () => {
  const s = setup({ read: async () => ({ rows: [{ session: 'chief-chat', part: 1, seq: 1, time: 1, text: `${'闲话😀'.repeat(700)}发布计划的关键结论` }] }) })
  await s.ready(); await s.call('dsbot_read_context', { bot_id: 'chief', query: '发布计划' })
  assert.match(s.result('call-1').snippets[0].text, /关键结论/)
  assert.ok([...s.result('call-1').snippets[0].text].length <= 600)
})

test('revocation while admitting a task suppresses its receipt and any later MOSS response', async () => {
  let finish
  const s = setup({ prompt: () => new Promise(resolve => { finish = resolve }) }); await s.ready()
  const pending = s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' })
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.bridge.view().tasks[0].status, 'submitting')
  s.config.dsBot.bots[0].submitTasks = false
  finish(); await pending
  assert.equal(s.result('call-1').error.code, 'access_denied')
  await s.ack('call-1')
  assert.equal(s.sent.filter(value => value.action === 'response.create').length, 0)
})

test('a queued task follows its own rpcId into the same Bot current history part', async () => {
  const s = setup(); await s.ready()
  await s.call('dsbot_submit_task', { bot_id: 'chief', text: '整理待办' }); await s.ack('call-1')
  s.rt.chatOf = id => `${id}-new-part`
  const session = { id: 'chief-new-part' }
  s.bridge.sessionEvent(session, { type: 'turn/start', data: { turn: 0 } })
  s.bridge.sessionEvent(session, { type: 'user/message', data: { source: { kind: 'user', rpcId: s.prompts[0].requestId } } })
  s.bridge.sessionEvent(session, { type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: '来自新分段的实际答复' }] } } })
  s.bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
  assert.equal(s.bridge.view().tasks[0].status, 'completed')
  assert.match(s.sent.find(value => value.action === 'session.commentary.append').content, /实际答复/)
})
