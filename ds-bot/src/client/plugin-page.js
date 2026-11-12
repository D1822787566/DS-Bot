import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { hostText, t } from './i18n.js'
import { transcriptMarkdown } from './moss-live.js'
import { createMossLiveController } from './moss-live-controller.js'
export { MossLiveCallBar, MOSS_CALL_CSS } from './moss-live-bar.js'

const LABELS = { unchecked: 'Not checked', checking: 'Checking compatibility', ready: 'Ready for Bot', partial: 'Partially compatible', single: 'Single chat only', unverified: 'Needs verification', incompatible: 'Not compatible', failed: 'Check failed', outdated: 'Check outdated' }

export function PresetReport({ report }) {
  if (!report) return null
  return h('div', { className: 'bt-plugin-report', role: 'status' },
    h('strong', null, t(LABELS[report.status] ?? 'Needs verification')),
    report.reason ? h('p', null, hostText(report.reason)) : null,
    h('small', null, t('This checks loading and known tool constraints, not teaching quality or plugin safety.')))
}

export function PresetPicker({ actions, onChange }) {
  const [presets, setPresets] = useState([])
  const [id, setId] = useState('')
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState(false)
  useEffect(() => {
    let current = true
    actions.plugins().then(result => { if (current) setPresets(result.presets ?? []) }, failure => { if (current) setError(failure.message) })
    return () => { current = false }
  }, [])
  useEffect(() => {
    let current = true
    setReport(null); setAccepted(false); setError('')
    onChange({ id, ready: !id })
    if (id) actions.checkPreset(id).then(value => { if (current) { setReport(value); onChange({ id, ready: value.bindable, fingerprint: value.fingerprint }) } }, failure => { if (current) setError(failure.message) })
    return () => { current = false }
  }, [id])
  return h('div', { className: 'bt-field' },
    h('label', { className: 'bt-field-label', htmlFor: 'bot-work-preset' }, t('Work preset')),
    h('select', { id: 'bot-work-preset', className: 'bt-input', value: id, onChange: event => setId(event.target.value) },
      h('option', { value: '' }, 'standard'), presets.filter(preset => preset.id !== 'standard').map(preset => h('option', { key: preset.id, value: preset.id }, preset.name ?? preset.id))),
    id && !report && !error ? h('span', { role: 'status' }, t('Checking compatibility')) : null,
    h(PresetReport, { report }),
    report?.status === 'unverified' ? h('label', { className: 'bt-note' },
      h('input', { type: 'checkbox', checked: accepted, onChange: event => { const checked = event.target.checked; setAccepted(checked); onChange({ id, ready: checked, fingerprint: checked ? report.fingerprint : undefined }) } }),
      t('I accept the unverified workflow and interface behavior.')) : null,
    error ? h('div', { role: 'alert' }, hostText(error)) : null,
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openPlugins() }, t('Browse plugins')))
}

// Navigate through DSH's public service so its own page owns discovery and installation.
export async function openPluginManager({ actions, ui, navigation }) {
  if (!navigation?.openList) throw new Error(t('Plugin management is unavailable.'))
  // Provision the default source before Discover first reads its indexes.
  await actions.plugins()
  ui.set(state => ({ ...state, newChat: null, settings: null, details: null, menu: null, memory: null, voice: null, palette: null, exchange: null }))
  navigation.openList()
}

export async function openMossLiveSettings({ actions, ui, navigation, slots }) {
  await openPluginManager({ actions, ui, navigation })
  // This root registration returns its existing navigation-store instance.
  const entry = slots.entries('main').find(item => item.options?.key === 'plugins')
  const owner = entry?.store?.create?.()
  if (typeof owner?.actions?.setTab !== 'function') throw new Error('无法打开 MOSS Live 设置页。')
  owner.actions.setTab('ds-bot-moss-live')
}

// This is an additive tab in DSH's Plugins page. The native tabs keep their own UI.
export function BotPresets({ actions }) {
  const [catalog, setCatalog] = useState(null)
  const [report, setReport] = useState(null)
  const [reviewBot, setReviewBot] = useState(null)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  const lock = useRef(false)
  const load = async () => {
    const value = await actions.plugins()
    if (alive.current) setCatalog(value)
  }
  useEffect(() => {
    alive.current = true
    load().catch(failure => { if (alive.current) setError(failure.message) })
    return () => { alive.current = false }
  }, [])
  const run = async task => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try { await task() } catch (failure) { if (alive.current) setError(failure.message) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const check = (id, bot = null) => run(async () => {
    setReport(null); setReviewBot(null); setAccepted(false)
    const value = await actions.checkPreset(id)
    if (alive.current) { setReport(value); setReviewBot(bot) }
  })
  return h('section', { className: 'bt-preset-tools', 'aria-label': t('Bot presets'), 'aria-busy': busy },
    h('div', { className: 'bt-preset-heading' },
      h('div', null, h('h2', null, t('Bot presets')),
        h('p', null, t('Check a preset here, then choose it when creating a Bot.'))),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(load) }, t('Refresh'))),
    h('p', { className: 'bt-note' }, t('Installing a plugin does not verify its Bot compatibility.')),
    error ? h('div', { className: 'bt-error', role: 'alert' }, hostText(error)) : null,
    message ? h('p', { role: 'status' }, message) : null,
    catalog === null && !error ? h('p', { role: 'status' }, t('Loading…')) : null,
    h('h3', null, t('Available presets in this profile')),
    h('p', { className: 'bt-note' }, t('These presets are registered in this profile. Their names do not prove which plugin provides them.')),
    h('div', { className: 'bt-preset-list' }, (catalog?.presets ?? []).map(preset =>
      h('button', { key: preset.id, type: 'button', className: 'bt-preset-row', disabled: busy, onClick: () => check(preset.id) },
        h('span', null, h('strong', null, preset.name ?? preset.id), preset.name && preset.name !== preset.id ? h('small', null, preset.id) : null),
        h('span', null, t('Check compatibility'))))),
    catalog && !catalog.presets?.length ? h('p', null, t('No presets available.')) : null,
    catalog?.affected?.length ? h('section', { className: 'bt-preset-bots' },
      h('h3', null, t('Bots using custom presets')),
      h('p', { className: 'bt-note' }, t('Removing or updating a plugin may affect these Bots. Their configuration and chat history are kept.')),
      catalog.affected.map(bot => h('div', { key: bot.id, className: 'bt-preset-bot' },
        h('span', null, h('strong', null, bot.name), h('small', null, bot.agentPreset)),
        h('div', { className: 'bt-preset-actions' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => check(bot.agentPreset, bot) }, t('Review preset')),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(async () => {
            await actions.recoverPreset(bot.id); await load()
            if (alive.current) { setReport(null); setReviewBot(null); setMessage(t('Standard restored. Earlier chat history is kept.')) }
          }) }, t('Use standard')))))) : null,
    report ? h('section', { className: 'bt-preset-result' },
      h('h3', null, reviewBot?.name ?? report.name ?? report.id), h(PresetReport, { report }),
      reviewBot && report.status === 'unverified' ? h('div', null,
        h('label', { className: 'bt-note' },
          h('input', { type: 'checkbox', checked: accepted, onChange: event => setAccepted(event.target.checked) }),
          t('I accept the unverified workflow and interface behavior.')),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || !accepted, onClick: () => run(async () => {
          await actions.confirmPreset(reviewBot.id, report.fingerprint)
          if (alive.current) { setReviewBot(null); setReport(null); setMessage(t('Preset reviewed.')) }
        }) }, t('Confirm'))) : null) : null)
}

export function PhoneAgentTestCenter({ actions, value, runtime, metrics, busy, run }) {
  const [ttsText, setTtsText] = useState('这是语音测试。')
  const [ttsVoice, setTtsVoice] = useState(value?.bots?.[0]?.ttsVoice ?? '')
  const metric = (key, fallback = 0) => metrics[key] ?? fallback
  const ownerScore = typeof metrics.ownerLastScore === 'number' ? metrics.ownerLastScore.toFixed(3) : '—'
  const voiceprintCandidateReady = metrics.voiceprintCandidateReady === true && Number.isInteger(metrics.voiceprintCandidateSegmentId)
  const voiceprintPendingSamples = Number(metrics.voiceprintPendingSamples ?? 0)
  const voiceprintApprovedSamples = Number(metrics.voiceprintApprovedSamples ?? 0)
  const asrState = metrics.asrTestState ?? 'idle'
  const asrStateLabel = { idle: '未开始', requested: '等待下一段语音', ready: '请直接说话', recognizing: '识别中', completed: '识别完成', failed: '识别失败', timeout: '测试超时' }[asrState] ?? asrState
  const asrTranscript = metrics.asrTestTranscript || (asrState === 'ready' || asrState === 'requested' ? '请直接说一句话。测试不会提交给 Bot。' : '暂无识别结果。')
  const voiceprintStart = actions.phoneAgentVoiceprintStart ?? actions.phoneAgentVoiceprintTest
  const voiceprintActive = metrics.voiceprintTestActive === true
    || metrics.voiceprintTestState === 'listening' || metrics.voiceprintTestState === 'recognizing'
  const voiceprintStateLabel = { idle: '未启动', listening: '持续监听中', recognizing: '正在识别', stopped: '已停止', error: '发生错误' }[metrics.voiceprintTestState ?? 'idle'] ?? '未启动'
  const voiceprintReviewText = metrics.voiceprintTestResult === 'owner_rejected'
    ? '这段语音的主人声纹没有通过。请确认这是不是你的声音。'
    : '这段语音已经通过主人声纹。确认后可以把它加入主人声纹样本。'
  return h('section', { className: 'bt-phone-test-center', 'aria-label': '语音测试中心' },
    h('div', { className: 'bt-phone-card' },
      h('div', { className: 'bt-phone-panel-heading' },
        h('div', null, h('h3', null, '语音测试中心'), h('p', { className: 'bt-note' }, '每个测试独立运行。ASR、唤醒词、声纹和 TTS 测试都不会提交 Bot 任务。')),
        h('div', { className: 'bt-phone-panel-actions' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy || !actions.phoneAgentAsrTest, onClick: () => run(actions.phoneAgentAsrTest, 'ASR 测试已准备，请直接说话') }, '测试 ASR（下一段语音）'),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentDiagnosticsReset, '测试数据已清零') }, '清空本轮结果'))),
      h('p', { className: 'bt-phone-summary', role: 'status' }, `当前运行状态：${runtime.state} · ASR 测试：${asrStateLabel} · 声纹测试：${voiceprintStateLabel}`)),
    h('section', { className: 'bt-phone-card' }, h('h3', null, '测试控制'),
      h('div', { className: 'bt-phone-diagnostic-grid', role: 'status' },
        h('span', null, '当前测试'), h('strong', null, asrState !== 'idle' ? `ASR：${asrStateLabel}` : metrics.voiceprintTestStarted > metrics.voiceprintTestCompleted ? '主人声纹：等待语音' : '没有主动测试'),
        h('span', null, '测试安全边界'), h('strong', null, '不保存 PCM · 不提交 Bot'))),
    h('section', { className: 'bt-phone-card' }, h('h3', null, '麦克风与音频输入'),
      h('div', { className: 'bt-phone-diagnostic-grid', role: 'status' },
        h('span', null, '麦克风帧数'), h('strong', null, String(metric('microphoneFrames'))),
        h('span', null, '输入丢帧'), h('strong', null, String(metric('microphoneDrops'))),
        h('span', null, '峰值 / 平均音量'), h('strong', null, `${metric('microphonePeak')} / ${Number(metric('microphoneRms')).toFixed(3)}`),
        h('span', null, '语音段'), h('strong', null, `${metric('segmentEnded')} 段完成 / ${metric('segmentDropped')} 段丢弃`))),
    h('section', { className: 'bt-phone-card' }, h('h3', null, '唤醒词测试'),
      h('p', { className: 'bt-note' }, '说出已配置的唤醒词，只观察识别结果，不会进入 Bot 对话。'),
      h('div', { className: 'bt-phone-diagnostic-grid', role: 'status' },
        h('span', null, '唤醒词结果'), h('strong', null, `${metric('wakeKeywordResults')} 次`),
        h('span', null, '唤醒确认'), h('strong', null, `${metric('wakeAccepted')} 次`),
        h('span', null, '未知词 / 冷却丢弃'), h('strong', null, `${metric('wakeUnknownKeywords')} / ${metric('wakeCooldownDrops')}`))),
    h('section', { className: 'bt-phone-card' }, h('h3', null, 'ASR 测试'),
      h('p', { className: 'bt-note' }, '当前版本在一段语音结束后显示最终识别文本。它不会做声纹验证，也不会提交给 Bot。'),
      h('div', { className: 'bt-phone-panel-actions' }, h('button', { type: 'button', className: 'bt-soft', disabled: busy || !actions.phoneAgentAsrTest, onClick: () => run(actions.phoneAgentAsrTest, 'ASR 测试已准备，请直接说话') }, '识别下一段语音')),
      h('p', { className: 'bt-phone-test-state', role: 'status' }, `状态：${asrStateLabel}`),
      h('pre', { className: 'bt-phone-asr-result', 'data-phone-agent-asr-result': true }, asrTranscript),
      h('div', { className: 'bt-phone-diagnostic-grid', role: 'status' },
        h('span', null, '语音段编号'), h('strong', null, metrics.asrTestSegmentId ?? '—'),
        h('span', null, '识别耗时'), h('strong', null, metrics.asrTestDurationMs === null ? '—' : `${metrics.asrTestDurationMs} ms`),
        h('span', null, '字符数'), h('strong', null, String(metrics.asrTestCharacters ?? 0)),
        h('span', null, '错误'), h('strong', null, metrics.asrTestError || '无'))),
    h('section', { className: 'bt-phone-card' },
      h('div', { className: 'bt-phone-panel-heading' },
        h('div', null, h('h3', null, '主人声纹测试'),
          h('p', { className: 'bt-note' }, '启动后会持续监听。每段语音结束都会进行一次 ASR 和主人声纹验证，直到点击停止；测试内容不会提交给 Bot。')),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || (voiceprintActive ? !actions.phoneAgentVoiceprintStop : !voiceprintStart), onClick: () => run(voiceprintActive ? actions.phoneAgentVoiceprintStop : voiceprintStart, voiceprintActive ? '声纹测试已停止' : '声纹测试已启动') }, voiceprintActive ? '停止声纹测试' : '启动声纹测试')),
      h('p', { className: 'bt-phone-test-state', role: 'status' }, `状态：${voiceprintStateLabel} · 已测试 ${metrics.voiceprintTestCompleted ?? 0} 段`),
      h('div', { className: 'bt-phone-diagnostic-grid', role: 'status' },
        h('span', null, '通过 / 拒绝 / 失败'), h('strong', null, `${metric('ownerVerified')} / ${metric('ownerRejected')} / ${metric('ownerFailed')}`),
        h('span', null, '分数'), h('strong', null, `${ownerScore}（${metrics.ownerMinScore ?? '—'}–${metrics.ownerMaxScore ?? '—'}）`),
        h('span', null, '最近语音段'), h('strong', null, metrics.voiceprintTestLastSegmentId ?? '—'),
        h('span', null, '最近耗时'), h('strong', null, metrics.voiceprintTestLastDurationMs === null || metrics.voiceprintTestLastDurationMs === undefined ? '—' : `${metrics.voiceprintTestLastDurationMs} ms`)),
      voiceprintCandidateReady ? h('div', { className: 'bt-phone-voiceprint-review', role: 'status' },
        h('p', null, voiceprintReviewText),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentVoiceprintLabel(metrics.voiceprintCandidateSegmentId), '已加入待应用声纹样本') }, '确认这是我，加入主人声纹')) : null,
      h('p', { className: 'bt-note' }, `待应用样本：${voiceprintPendingSamples} 段 · 已应用样本：${voiceprintApprovedSamples} 段`),
      voiceprintPendingSamples > 0 ? h('div', { className: 'bt-phone-panel-actions' },
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentVoiceprintApply, '主人声纹样本已应用') }, '应用待应用样本'),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentVoiceprintDiscard, '待应用样本已删除') }, '删除待应用样本')) : null),
    h('section', { className: 'bt-phone-card' }, h('h3', null, 'TTS 与扬声器测试'),
      h('label', { className: 'bt-phone-field' }, h('span', null, '测试文字'), h('textarea', { className: 'bt-input bt-phone-textarea', value: ttsText, onChange: event => setTtsText(event.target.value) })),
      h('label', { className: 'bt-phone-field' }, h('span', null, 'TTS 音色'), h('input', { className: 'bt-input', value: ttsVoice, onChange: event => setTtsVoice(event.target.value) })),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || !actions.phoneAgentTtsTest || !ttsText.trim(), onClick: () => run(() => actions.phoneAgentTtsTest({ text: ttsText, voice: ttsVoice }), 'TTS 测试已完成') }, '播放测试语音'),
      h('p', { className: 'bt-note', role: 'status' }, `最近结果：${metrics.ttsTestResult || '尚未测试'}`)),
    h('section', { className: 'bt-phone-card' }, h('h3', null, '完整链路测试'),
      h('p', { className: 'bt-note' }, '先点击测试，再说唤醒词和一句话。测试会执行唤醒、VAD、ASR、声纹和测试播放，但不会提交真实 Bot 任务。'),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || !actions.phoneAgentFullChainTest, onClick: () => run(actions.phoneAgentFullChainTest, '完整链路测试已准备，请说唤醒词') }, '开始完整链路测试'),
      h('p', { className: 'bt-phone-test-state', role: 'status' }, `最近结果：${metrics.fullChainTestResult || '尚未测试'}`))
  )
}

export function PhoneAgentSettings({ actions }) {
  const [value, setValue] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [activePanel, setActivePanel] = useState('tests')
  const load = async () => {
    const next = await actions.phoneAgent()
    setValue(next)
    setDraft({ config: { ...(next.config ?? {}) }, bots: Object.fromEntries((next.bots ?? []).map(bot => [bot.id, { wakeName: bot.wakeName ?? '', ttsVoice: bot.ttsVoice ?? '' }])) })
  }
  useEffect(() => {
    let active = true
    const refresh = () => actions.phoneAgent().then(next => { if (active) setValue(next) }).catch(failure => { if (active) setError(failure.message) })
    load().catch(failure => { if (active) setError(failure.message) })
    const timer = window.setInterval(refresh, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  const run = async (task, done = 'Saved') => {
    setBusy(true); setError(''); setMessage('')
    try { const next = await task(); if (next?.config) { setValue(next); setDraft({ config: { ...next.config }, bots: Object.fromEntries((next.bots ?? []).map(bot => [bot.id, { wakeName: bot.wakeName ?? '', ttsVoice: bot.ttsVoice ?? '' }])) }) }; setMessage(done) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  if (draft === null) return h('section', { className: 'bt-phone-agent', 'aria-label': t('Phone Agent') }, h('p', { role: error ? 'alert' : 'status' }, error ? hostText(error) : t('Loading…')))
  const configField = (key, label, type = 'text') => h('label', { className: 'bt-phone-field' }, h('span', null, t(label)), h('input', { className: 'bt-input', type, value: draft.config[key] ?? '', onChange: event => setDraft(current => ({ ...current, config: { ...current.config, [key]: type === 'checkbox' ? event.target.checked : event.target.value } })) }))
  const runtime = value?.runtime ?? { state: 'stopped' }
  const diagnostics = value?.diagnostics
  const metrics = runtime.metrics ?? {}
  const metric = (key, fallback = 0) => metrics[key] ?? fallback
  const ownerScore = typeof metrics.ownerLastScore === 'number' ? metrics.ownerLastScore.toFixed(3) : '—'
  const voiceprintCandidateReady = metrics.voiceprintCandidateReady === true && Number.isInteger(metrics.voiceprintCandidateSegmentId)
  const voiceprintPendingSamples = Number(metrics.voiceprintPendingSamples ?? 0)
  const voiceprintApprovedSamples = Number(metrics.voiceprintApprovedSamples ?? 0)
  const voiceprintReviewText = metrics.voiceprintTestResult === 'owner_rejected'
    ? '这段语音的主人声纹没有通过。请确认这是不是你的声音。'
    : '这段语音已经通过主人声纹。确认后可以把它加入主人声纹样本。'
  const stageLabels = {
    environment_checking: 'Checking voice environment', environment_creating: 'Creating voice environment',
    environment_installing: 'Installing voice dependencies', environment_verifying: 'Verifying voice dependencies', environment_ready: 'Voice environment ready',
    environment_setup: 'Preparing voice environment', bridge_connecting: 'Connecting voice service', runtime_starting: 'Starting voice runtime',
    models_loading: 'Loading speech models', asr_loading: 'Loading speech recognition', speaker_loading: 'Loading owner verification',
    vad_loading: 'Loading speech detection', audio_opening: 'Opening Windows audio', listening: 'Waiting for wake word',
    capturing: 'Receiving speech', asr: 'Recognizing speech', owner_verification: 'Verifying owner', continuation: 'Checking continuation',
    synthesizing: 'Generating speech', speaking: 'Playing reply',
  }
  return h('section', { className: 'bt-phone-agent', 'aria-label': t('Phone Agent'), 'aria-busy': busy },
    h('div', { className: 'bt-preset-heading' }, h('div', null, h('h2', null, t('Phone Agent')), h('p', null, t('Windows voice runtime for Bot wake words and speech.'))),
      runtime.state === 'stopped' || runtime.state === 'error'
        ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentStart, 'Phone Agent starting') }, runtime.state === 'error' ? t('Retry') : t('Start'))
        : h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentStop, 'Phone Agent stopped') }, t('Stop'))),
    h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', checked: draft.config.enabled !== false, onChange: event => setDraft(current => ({ ...current, config: { ...current.config, enabled: event.target.checked } })) }), t('Enable voice plugin')),
    h('div', { className: 'bt-plugin-report', role: 'status' }, h('strong', null, t('Runtime: {state}', { state: runtime.state })),
      runtime.stage ? h('p', null, t('Stage: {stage}', { stage: t(stageLabels[runtime.stage] ?? runtime.stage) })) : null,
      runtime.activeBotId ? h('p', null, t('Active Bot: {bot}', { bot: (value?.bots ?? []).find(bot => bot.id === runtime.activeBotId)?.name ?? runtime.activeBotId })) : null,
      runtime.lastResult ? h('p', null, t('Last speech result: {result}', { result: runtime.lastResult })) : null,
      runtime.error ? h('p', null, runtime.error) : null,
      runtime.errorCode ? h('p', null, t('Error code: {code}', { code: runtime.errorCode })) : null,
      runtime.lastError ? h('pre', { className: 'bt-phone-diagnostic' }, runtime.lastError) : null,
      runtime.lastOutput ? h('pre', { className: 'bt-phone-diagnostic' }, runtime.lastOutput) : null),
    h('nav', { className: 'bt-phone-tabs', 'aria-label': 'Phone Agent 页面' },
      h('button', { type: 'button', className: activePanel === 'tests' ? 'bt-soft bt-phone-tab-active' : 'bt-soft', 'aria-selected': activePanel === 'tests', onClick: () => setActivePanel('tests') }, '语音测试中心'),
      h('button', { type: 'button', className: activePanel === 'config' ? 'bt-soft bt-phone-tab-active' : 'bt-soft', 'aria-selected': activePanel === 'config', onClick: () => setActivePanel('config') }, '运行配置')),
    h('div', { hidden: activePanel !== 'tests' }, h(PhoneAgentTestCenter, { actions, value, runtime, metrics, busy, run })),
    h('section', { hidden: activePanel === 'tests', className: 'bt-phone-card' }, h('h3', null, t('Runtime diagnostics')),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentTest, 'Self-test completed') }, t('Run self-test')),
      diagnostics ? h('div', { className: 'bt-phone-diagnostic-grid', role: 'status' },
        h('span', null, t('Self-test')), h('strong', null, diagnostics.status === 'pass' ? t('Pass') : t('Needs attention')),
        h('span', null, t('Bundled runtime')), h('strong', null, diagnostics.bundledRuntime ? t('Found') : t('Missing')),
        h('span', null, t('Python command')), h('code', null, diagnostics.pythonCommand),
        h('span', null, t('Bridge')), h('code', null, diagnostics.bridgePort ? `127.0.0.1:${diagnostics.bridgePort}` : t('Not connected')),
        diagnostics.lastError ? h('span', null, t('Last stderr')) : null,
         diagnostics.lastError ? h('pre', { className: 'bt-phone-diagnostic' }, diagnostics.lastError) : null,
         diagnostics.lastOutput ? h('span', null, t('Last stdout')) : null,
         diagnostics.lastOutput ? h('pre', { className: 'bt-phone-diagnostic' }, diagnostics.lastOutput) : null) : null),
    h('section', { hidden: activePanel === 'tests', className: 'bt-phone-card', 'aria-label': '语音测试面板' },
      h('div', { className: 'bt-phone-panel-heading' },
        h('div', null, h('h3', null, '语音测试面板'),
          h('p', { className: 'bt-note' }, '先清零数据，然后连续说几次唤醒词和简短指令。这里仅保存计数和安全分数，不保存音频或完整转写。')),
        h('div', { className: 'bt-phone-panel-actions' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentDiagnosticsReset, '测试数据已清零') }, '清零测试数据'))),
      h('p', { className: 'bt-phone-summary', role: 'status' }, voiceTestSummary(metrics)),
      voiceprintCandidateReady ? h('div', { className: 'bt-phone-voiceprint-review', role: 'status' },
        h('p', null, voiceprintReviewText),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentVoiceprintLabel(metrics.voiceprintCandidateSegmentId), '已加入待应用声纹样本') }, '确认这是我，加入主人声纹')) : null,
      voiceprintPendingSamples > 0 ? h('div', { className: 'bt-phone-voiceprint-samples', role: 'status' },
        h('span', null, `待应用样本：${voiceprintPendingSamples} 段 · 已应用样本：${voiceprintApprovedSamples} 段`),
        h('div', { className: 'bt-phone-panel-actions' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentVoiceprintApply, '主人声纹样本已应用') }, '应用待应用样本'),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentVoiceprintDiscard, '待应用样本已删除') }, '删除待应用样本'))) : null,
      h('div', { className: 'bt-phone-diagnostic-grid', role: 'status' },
        h('span', null, '麦克风帧数'), h('strong', null, String(metric('microphoneFrames'))),
        h('span', null, '输入丢帧'), h('strong', null, String(metric('microphoneDrops'))),
        h('span', null, '麦克风峰值 / 平均音量'), h('strong', null, `${metric('microphonePeak')} / ${Number(metric('microphoneRms')).toFixed(3)}`),
        h('span', null, '唤醒检测'), h('strong', null, `${metric('wakePublished')} 次 / ${metric('wakeAccepted')} 次确认`),
        h('span', null, '唤醒词识别结果'), h('strong', null, `${metric('wakeKeywordResults')} 次（未知 ${metric('wakeUnknownKeywords')} 次）`),
        h('span', null, '语音段'), h('strong', null, `${metric('segmentEnded')} 段完成 / ${metric('segmentDropped')} 段丢弃`),
        h('span', null, '语音转写完成'), h('strong', null, `${metric('asrCompleted')} / ${metric('asrAttempted')}`),
        h('span', null, '主人声纹'), h('strong', null, `${metric('ownerVerified')} 次通过 / ${metric('ownerRejected')} 次拒绝 / ${metric('ownerFailed')} 次失败`),
        h('span', null, '声纹分数'), h('strong', null, `${ownerScore}（${metrics.ownerMinScore ?? '—'}–${metrics.ownerMaxScore ?? '—'}）`),
        h('span', null, 'Bot 提交'), h('strong', null, `${metric('inputAccepted')} 次通过 / ${metric('inputRejected')} 次拒绝`)),
      Array.isArray(metrics.recent) && metrics.recent.length
        ? h('details', { className: 'bt-phone-recent' }, h('summary', null, '最近诊断事件'),
          h('ul', null, metrics.recent.slice().reverse().map((event, index) => h('li', { key: `${event.type}-${index}` },
            `${({ 'windows.wake.published': '唤醒词命中', 'runtime.wake': '唤醒已确认', 'audio.segment.started': '开始接收语音', 'audio.segment.ended': '语音段完成', 'audio.segment.dropped': '语音段丢弃', 'asr.completed': '语音转写完成', 'asr.failed': '语音转写失败', 'identity.verified': '主人声纹通过', 'identity.rejected': '主人声纹拒绝', 'owner.failed': '主人声纹失败', 'voice.test.ready': '声纹测试已启动', 'voice.test.started': '开始验证声纹样本', 'voice.test.completed': '声纹样本验证完成', 'voice.test.stopped': '声纹测试已停止', 'input.submit': '提交给 Bot', 'input.accepted': 'Bot 接收成功', 'input.rejected': 'Bot 拒绝接收' }[event.type] ?? event.type)}${event.segmentId === undefined ? '' : ` · 第 ${event.segmentId} 段`}${event.reason ? ` · ${event.reason}` : ''}${typeof event.score === 'number' ? ` · 分数 ${event.score.toFixed(3)}` : ''}`))))
        : null),
    error ? h('div', { className: 'bt-error', role: 'alert' }, hostText(error)) : null,
    message ? h('p', { role: 'status' }, message) : null,
    h('section', { hidden: activePanel === 'tests', className: 'bt-phone-card' }, h('h3', null, t('Windows audio and LiveKit')),
      configField('deviceId', 'Device ID'), configField('inputDeviceName', 'Microphone'), configField('outputDeviceName', 'Speaker'),
      configField('livekitUrl', 'LiveKit local URL'), configField('livekitRoom', 'LiveKit room'),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ config: draft.config }), 'Settings saved') }, t('Save settings'))),
    h('section', { hidden: activePanel === 'tests', className: 'bt-phone-card' }, h('h3', null, t('ASR and TTS')),
      configField('asrModel', 'ASR model'), configField('asrModelDir', 'ASR model directory'), configField('speakerModelDir', 'Speaker model directory'), configField('speakerProfileDir', 'Speaker profile directory'),
      configField('ttsModel', 'TTS model'), configField('ttsConfigPath', 'TTS configuration path'),
      h('p', { className: 'bt-note' }, t('Speaker verification is enabled by default. Record or replace the owner profile before starting voice input.')),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ config: draft.config }), 'Settings saved') }, t('Save ASR/TTS'))),
    h('section', { hidden: activePanel === 'tests', className: 'bt-phone-card' }, h('h3', null, t('Advanced continuation')),
      h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', checked: draft.config.continuationEnabled !== false, onChange: event => setDraft(current => ({ ...current, config: { ...current.config, continuationEnabled: event.target.checked } })) }), t('Enable semantic continuation')),
      configField('continuationModel', 'Continuation model'), configField('continuationUrl', 'Continuation local URL'),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ config: draft.config }), 'Settings saved') }, t('Save advanced settings'))),
    h('section', { hidden: activePanel === 'tests', className: 'bt-phone-card' }, h('h3', null, t('Bots, wake words and voices')),
      (value?.bots ?? []).map(bot => {
        const profile = draft.bots[bot.id] ?? { wakeName: '', ttsVoice: '' }
        return h('div', { className: 'bt-phone-bot', key: bot.id }, h('strong', null, bot.name),
          h('label', { className: 'bt-phone-field' }, h('span', null, t('Wake word')), h('input', { className: 'bt-input', 'data-phone-agent-field': `${bot.id}:wakeName`, value: profile.wakeName, onInput: event => setDraft(current => ({ ...current, bots: { ...current.bots, [bot.id]: { ...current.bots[bot.id], wakeName: event.target.value } } })) })),
          h('label', { className: 'bt-phone-field' }, h('span', null, t('TTS voice')), h('input', { className: 'bt-input', 'data-phone-agent-field': `${bot.id}:ttsVoice`, value: profile.ttsVoice, onInput: event => setDraft(current => ({ ...current, bots: { ...current.bots, [bot.id]: { ...current.bots[bot.id], ttsVoice: event.target.value } } })) })),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ botId: bot.id, profile }), 'Bot voice settings saved') }, t('Save')))
      }))
  )
}

export const MOSS_SCENE_PRESETS = [
  { id: 'free', name: '自由对话', instructions: '用自然、简洁的中文口语回答。先说结论，再补充必要信息。' },
  { id: 'interpreter', name: '同声传译', instructions: '把听到的中文翻译成英文，把听到的英文翻译成中文。只输出翻译结果，不解释。' },
  { id: 'visual', name: '视觉助手', instructions: '当用户提供屏幕内容时，先描述你看到的重点，再回答问题。无法看清时要明确说明。' },
  { id: 'assistant', name: '实时助理', instructions: '回答适合语音播放，避免 Markdown 和长段落。需要执行步骤时，按顺序说出下一步。' },
  { id: 'custom', name: '自定义', instructions: '' },
]

const sceneForInstructions = value => {
  const text = String(value ?? '').trim()
  if (!text) return 'free'
  return MOSS_SCENE_PRESETS.find(item => item.id !== 'custom' && item.instructions === text)?.id ?? 'custom'
}

function downloadMossTranscript(items, config, startedAt, endedAt) {
  const markdown = transcriptMarkdown(items, { personaName: config?.personaName, startedAt, endedAt })
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `moss-live-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function MossDsBotPanel({ config = { enabled: false, bots: [] }, view = {}, busy, interpret, onChange, onSave, onOpenBot }) {
  const [query, setQuery] = useState('')
  const bots = view.bots ?? []
  const grants = config.bots ?? []
  const visible = bots.filter(bot => `${bot.name} ${bot.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  const changeGrant = (botId, key, checked) => {
    const current = grants.find(item => item.botId === botId) ?? { botId, readHistory: false, submitTasks: false }
    const next = { ...current, [key]: checked }
    onChange({ ...config, bots: grants.some(item => item.botId === botId) ? grants.map(item => item.botId === botId ? next : item) : [...grants, next] })
  }
  const status = { submitting: '正在提交', queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', uncertain: '接收状态待核实', needs_input: '需要用户操作', needs_review: '结果待核实' }
  const open = (botId, label = '打开 Bot') => h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !onOpenBot || !bots.some(bot => bot.id === botId && !bot.unavailable), onClick: () => onOpenBot(botId) }, label)
  return h('div', { 'data-moss-dsbot': true },
    h('details', { className: 'bt-phone-card bt-moss-dsbot-settings' },
      h('summary', null, h('strong', null, 'DS Bot 接入'), h('span', { className: 'bt-note' }, config.enabled ? '已启用' : '未启用')),
      h('p', { className: 'bt-note' }, '允许读取的私聊片段及任务结果会发送给 MOSS。读取历史与派发任务分别授权，默认关闭。'),
      h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', 'data-moss-dsbot-enabled': true, checked: config.enabled === true, disabled: busy, onChange: event => onChange({ ...config, enabled: event.target.checked }) }), '允许 MOSS 接入所选 Bot'),
      interpret ? h('p', { className: 'bt-note' }, '同声传译模式不执行 DS Bot 操作；这些设置在对话模式生效。') : null,
      bots.length ? h('label', { className: 'bt-phone-field' }, h('span', null, '查找 Bot'), h('input', { className: 'bt-input', type: 'search', value: query, onInput: event => setQuery(event.target.value) })) : h('p', { className: 'bt-note' }, '还没有 Bot，请先从侧栏创建 Bot。'),
      bots.length ? h('div', { className: 'bt-moss-dsbot-roster', role: 'group', 'aria-label': 'Bot 接入范围' },
        visible.length ? visible.map(bot => {
          const grant = grants.find(item => item.botId === bot.id)
          return h('div', { key: bot.id, className: 'bt-moss-dsbot-row' },
            h('span', null, bot.name, bot.private ? h('small', { className: 'bt-note' }, ' · 私有') : null, bot.unavailable ? h('small', { className: 'bt-note' }, ' · 已失效') : null),
            ...[['readHistory', '读取历史'], ['submitTasks', '派发任务']].map(([key, label]) => h('label', { key, className: 'bt-phone-check' }, h('input', { type: 'checkbox', 'data-moss-dsbot-grant': `${bot.id}:${key}`, checked: grant?.[key] === true, disabled: busy || (bot.unavailable && !grant?.[key]), onChange: event => changeGrant(bot.id, key, event.target.checked) }), label)))
        }) : h('p', { className: 'bt-note' }, '没有匹配的 Bot。')) : null,
      h('p', { className: 'bt-note' }, '历史范围为所选 Bot 的私聊，包含历史分段。私有 Bot 也只有勾选后才会分享内容。'),
      h('p', { className: 'bt-note' }, '明确下令后，任务进入目标 Bot 当前私聊，忙碌时排队。Bot 使用其现有工具、权限及审批设置。'),
      h('p', { className: 'bt-note' }, '保存会停止当前语音会话，重新开始后生效。已派发任务继续在 Bot 中处理。'),
      h('button', { type: 'button', className: 'bt-soft', 'data-moss-dsbot-save': true, disabled: busy, onClick: onSave }, '保存接入设置')),
    (view.tasks?.length || view.reads?.length || view.deliveryError) ? h('section', { className: 'bt-phone-card' },
      h('h3', null, 'DS Bot 任务与查询'),
      view.deliveryError ? h('p', { className: 'bt-error', role: 'alert' }, view.deliveryError) : null,
      h('div', { className: 'bt-moss-dsbot-activity' }, (view.tasks ?? []).map(task => h('article', { key: task.id, className: 'bt-moss-dsbot-task', 'data-moss-dsbot-task': task.id },
        h('div', { className: 'bt-moss-card-heading' }, h('strong', null, `${task.botName} · ${status[task.status] ?? '状态待核实'}`), open(task.botId)),
        h('details', null, h('summary', null, task.text), task.context ? h('p', null, `附带上下文：${task.context}`) : null),
        task.message ? h('p', { role: 'status' }, task.message) : null,
        task.result ? h('p', null, task.result) : null,
        task.truncated ? h('p', { className: 'bt-note' }, '结果已截取，完整内容请打开 Bot 查看。') : null)),
      (view.reads ?? []).map(read => h('details', { key: read.id, className: 'bt-moss-dsbot-task' },
        h('summary', null, `${read.botName} · 查询${read.query ? `：${read.query}` : '最近消息'}`),
        h('p', null, read.message),
        (read.snippets ?? []).map((snippet, index) => h('p', { key: index }, h('small', { className: 'bt-note' }, `分段 ${snippet.part} · #${snippet.seq} · ${new Date(snippet.time).toLocaleString()}`), h('br'), snippet.text)),
        read.truncated || read.partial ? h('p', { className: 'bt-note' }, read.partial ? '部分历史未能读取，仅展示已取得的片段。' : '仅展示相关片段，内容已截取。') : null,
        open(read.botId))))) : null)
}

export function MossLiveSettings({ actions, controller }) {
  const [owner] = useState(() => controller ?? createMossLiveController({ actions }))
  const live = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  const { sessionState, level, levelSource, transcript, screenStream, screenBusy, screenError, startedAt, endedAt } = live
  const screenSharing = Boolean(screenStream)
  const [value, setValue] = useState(null)
  const [draft, setDraft] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setBusy] = useState(false)
  const [pageError, setError] = useState('')
  const [pageMessage, setMessage] = useState('')
  const busy = saving || live.busy
  const error = pageError || live.error
  const message = pageMessage || live.message
  const [voices, setVoices] = useState([])
  const [voicesBusy, setVoicesBusy] = useState(false)
  const [voicesError, setVoicesError] = useState('')
  const [previewVoice, setPreviewVoice] = useState('')
  const [previewStatus, setPreviewStatus] = useState('idle')
  const [previewSource, setPreviewSource] = useState('')
  const [scene, setScene] = useState('free')
  const alive = useRef(true)
  const screenPreview = useRef(null)
  const voicePreview = useRef(null)
  const previewRequest = useRef(0)
  const dirty = useRef(new Set())
  const initialized = useRef(false)

  const apply = next => {
    if (!next) return
    setValue(next)
    if (next.config) {
      const config = { ...next.config, personaAliases: Array.isArray(next.config.personaAliases) ? [...next.config.personaAliases] : [] }
      if (!initialized.current) {
        initialized.current = true
        setDraft(config)
        setScene(sceneForInstructions(config.instructions))
      } else {
        setDraft(current => {
          if (!current) return config
          const kept = {}
          for (const key of dirty.current) kept[key] = current[key]
          return { ...config, ...kept, personaAliases: dirty.current.has('personaAliases') ? current.personaAliases : config.personaAliases }
        })
      }
    }
    return next
  }
  const load = async () => { const next = await actions.mossLive(); return alive.current ? apply(next) : next }
  const refreshVoices = async () => {
    if (typeof actions.mossLiveVoices !== 'function') return
    setVoicesBusy(true); setVoicesError('')
    try {
      const result = await actions.mossLiveVoices()
      setVoices(Array.isArray(result?.voices) ? result.voices : [])
    } catch (failure) { setVoicesError(failure.message) }
    finally { setVoicesBusy(false) }
  }
  const stopVoicePreview = () => {
    previewRequest.current += 1
    voicePreview.current?.pause?.()
    voicePreview.current?.removeAttribute?.('src')
    setPreviewVoice(''); setPreviewStatus('idle'); setPreviewSource('')
  }
  const previewVoiceSample = async id => {
    if (!id || typeof actions.mossLiveVoicePreview !== 'function') return
    if (previewVoice === id && previewStatus === 'playing') { stopVoicePreview(); return }
    const request = ++previewRequest.current
    setPreviewVoice(id); setPreviewStatus('loading'); setPreviewSource(''); setVoicesError('')
    try {
      voicePreview.current?.pause?.()
      const result = await actions.mossLiveVoicePreview({ voiceId: id })
      if (request !== previewRequest.current) return
      if (!result?.url || !voicePreview.current) throw new Error('音色试听没有返回音频')
      setPreviewSource(result.url)
      voicePreview.current.src = result.url
      await voicePreview.current.play?.()
      if (request === previewRequest.current) setPreviewStatus('playing')
    } catch (failure) {
      if (request !== previewRequest.current) return
      setVoicesError(failure.name === 'NotAllowedError' ? '自动播放未获允许，请点击下方播放器播放。'
        : failure.name === 'NotSupportedError' ? '试听音频加载失败，请重新试听。' : failure.message)
      setPreviewVoice(''); setPreviewStatus('idle')
    }
  }
  useEffect(() => {
    alive.current = true
    load().then(next => { if (alive.current && next?.apiKeyConfigured) void refreshVoices() }).catch(failure => { if (alive.current) setError(failure.message) })
    const timer = window.setInterval(() => { actions.mossLive().then(next => { if (alive.current) apply(next) }).catch(() => {}) }, 1000)
    return () => { alive.current = false; previewRequest.current += 1; window.clearInterval(timer); voicePreview.current?.pause?.(); if (!controller) void owner.dispose() }
  }, [])
  useEffect(() => {
    const video = screenPreview.current
    if (!video) return
    video.srcObject = screenStream
    if (screenStream) void video.play?.()?.catch?.(() => {})
    return () => { video.srcObject = null }
  }, [screenStream, draft !== null])
  const run = async (task, done = '') => {
    setBusy(true); setError(''); setMessage(''); owner.clearFeedback()
    try { const next = await task(); if (alive.current) { apply(next); if (done) setMessage(done) }; return next }
    catch (failure) { if (alive.current) setError(failure.message); return null }
    finally { if (alive.current) setBusy(false) }
  }
  const stopForConfig = async () => {
    if (owner.getSnapshot().visible || owner.getSnapshot().busy) await owner.stop({ quiet: true })
  }
  const saveConfig = () => run(async () => {
    await stopForConfig()
    const next = await actions.mossLiveUpdate({ config: draft })
    dirty.current.clear()
    return next
  }, '配置已保存')
  const saveDsBot = () => run(async () => {
    await stopForConfig()
    const next = await actions.mossLiveUpdate({ config: { dsBot: draft.dsBot ?? { enabled: false, bots: [] } } })
    dirty.current.delete('dsBot')
    return next
  }, 'DS Bot 接入设置已保存，重新开始 MOSS Live 后生效')
  const start = () => run(owner.start)
  const stop = () => run(owner.stop)
  const startScreenShare = owner.startScreenShare
  const stopScreenShare = owner.stopScreenShare
  const saveApiKey = () => run(() => actions.mossLiveSetKey({ value: apiKey }), 'API Key 已保存').then(next => {
    if (next?.apiKeyConfigured) void refreshVoices()
    return next
  })
  if (draft === null) return h('section', { className: 'bt-moss-live', 'aria-label': 'MOSS Live' }, h('p', { role: error ? 'alert' : 'status' }, error || t('Loading…')))
  const runtime = value?.runtime ?? { state: 'stopped' }
  const visualState = sessionState === 'greeting' ? 'greeting' : sessionState === 'speaking' ? 'speaking' : sessionState === 'thinking' ? 'thinking' : sessionState === 'listening' ? 'listening' : runtime.state
  const selectedScene = MOSS_SCENE_PRESETS.find(item => item.id === scene)
  const currentVoice = String(draft.voiceName ?? '').trim()
  const voiceOptions = [
    { id: '', name: '默认音色' },
    ...(currentVoice && !voices.some(item => item.id === currentVoice) ? [{ id: currentVoice, name: `当前音色（${currentVoice}）` }] : []),
    ...voices,
  ]
  const input = (key, label, multiline = false) => h('label', { className: 'bt-phone-field', key }, h('span', null, label), multiline
    ? h('textarea', { className: 'bt-input bt-moss-textarea', 'data-moss-live-field': key, value: draft[key] ?? '', onInput: event => { dirty.current.add(key); setDraft(current => ({ ...current, [key]: event.target.value })) } })
    : h('input', { className: 'bt-input', 'data-moss-live-field': key, value: draft[key] ?? '', onInput: event => { dirty.current.add(key); setDraft(current => ({ ...current, [key]: event.target.value })) } }))
  const select = (key, label, options) => h('label', { className: 'bt-phone-field', key }, h('span', null, label), h('select', {
    className: 'bt-input', 'data-moss-live-field': key, value: draft[key] ?? '', onChange: event => { dirty.current.add(key); setDraft(current => ({ ...current, [key]: event.target.value })) },
  }, options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
  const active = live.active
  return h('section', { className: 'bt-moss-live', 'aria-label': 'MOSS Live', 'aria-busy': busy },
    h('div', { className: 'bt-preset-heading' }, h('div', null, h('h2', null, 'MOSS Live'), h('p', null, '独立全双工实时语音会话，可按接入设置查询或调用 DS Bot。')),
      active ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: stop }, '停止 MOSS Live') : h('button', { type: 'button', className: 'bt-soft', disabled: busy || !value?.apiKeyConfigured, onClick: start }, '开始 MOSS Live')),
    h('section', { className: 'bt-moss-stage', 'data-state': visualState, style: { '--moss-level': String(Math.max(0, Math.min(1, level))) }, role: 'img', 'aria-label': `MOSS Live ${visualState}` },
      h('div', { className: 'bt-moss-orb', 'aria-hidden': true }, h('span', { className: 'bt-moss-orb-halo' }), h('span', { className: 'bt-moss-orb-core' }), h('span', { className: 'bt-moss-orb-ring' }), h('span', { className: 'bt-moss-orb-ring bt-moss-orb-ring-2' })),
      h('div', { className: 'bt-moss-stage-copy' }, h('strong', null, sessionState === 'idle' ? '等待开始' : sessionState === 'greeting' ? '开场问候' : sessionState === 'speaking' ? 'MOSS 正在说话' : sessionState === 'thinking' ? 'MOSS 正在思考' : sessionState === 'listening' ? '正在听你说' : `MOSS Live · ${runtime.state}`), h('span', null, `${levelSource === 'playback' ? '播放' : '输入'}音量 ${Math.round(level * 100)}%`))),
    h('div', { className: 'bt-plugin-report', role: 'status' }, h('strong', null, `运行状态：${runtime.state}`), h('p', null, `会话状态：${sessionState} · 麦克风音量：${Math.round(level * 100)}%`), h('p', null, `屏幕共享：${screenSharing ? '已开启' : '未开启'}`), value?.apiKeyConfigured ? h('p', null, 'API Key：已配置') : h('p', null, 'API Key：未配置')),
    h(MossDsBotPanel, { config: draft.dsBot, view: value?.dsBot, busy, interpret: draft.mode === 'interpret',
      onChange: next => { dirty.current.add('dsBot'); setDraft(current => ({ ...current, dsBot: next })) }, onSave: saveDsBot, onOpenBot: actions.mossLiveOpenBot }),
    h('section', { className: 'bt-phone-card' }, h('h3', null, '模型配置'),
      h('label', { className: 'bt-phone-field' }, h('span', null, '场景预设'), h('select', { className: 'bt-input', 'data-moss-live-scene': true, value: scene, onChange: event => { const nextScene = event.target.value; setScene(nextScene); const preset = MOSS_SCENE_PRESETS.find(item => item.id === nextScene); if (preset?.id !== 'custom') { dirty.current.add('instructions'); setDraft(current => ({ ...current, instructions: preset.instructions })) } } }, MOSS_SCENE_PRESETS.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
      selectedScene?.id !== 'custom' ? h('p', { className: 'bt-note bt-moss-scene-note' }, selectedScene.instructions) : null,
      input('model', '模型 ID'),
      select('mode', '会话模式', [{ value: 'conversation', label: '实时对话' }, { value: 'interpret', label: '同声传译' }]),
      h('div', { className: 'bt-moss-voice-picker' },
        h('label', { className: 'bt-phone-field' }, h('span', null, '音色'), h('select', {
          className: 'bt-input', 'data-moss-live-field': 'voiceName', value: currentVoice, onChange: event => { stopVoicePreview(); dirty.current.add('voiceName'); setDraft(current => ({ ...current, voiceName: event.target.value })) },
        }, voiceOptions.map(voice => h('option', { key: voice.id || 'default', value: voice.id }, voice.name)))),
        h('div', { className: 'bt-moss-voice-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-moss-live-preview': currentVoice, disabled: !currentVoice || voicesBusy || previewStatus === 'loading' || typeof actions.mossLiveVoicePreview !== 'function', onClick: () => previewVoiceSample(currentVoice) }, previewStatus === 'loading' ? '生成试听…' : previewStatus === 'playing' ? '停止试听' : '试听'),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: voicesBusy || busy || typeof actions.mossLiveVoices !== 'function', onClick: refreshVoices }, voicesBusy ? '刷新中…' : '刷新音色')),
        h('audio', { ref: voicePreview, preload: 'none', controls: true, hidden: !previewSource, 'aria-label': '音色试听播放器', onEnded: stopVoicePreview, onError: () => { if (voicePreview.current?.error) { setVoicesError('试听音频加载失败，请重新试听。'); setPreviewVoice(''); setPreviewStatus('idle') } } }),
        h('p', { className: 'bt-note bt-moss-voice-billing' }, '试听会调用 MOSS 语音合成服务，并按其规则计费。'),
        voicesError ? h('p', { className: 'bt-error', role: 'alert' }, voicesError) : null),
      select('mediaProfile', '媒体档位', [{ value: 'standard', label: '标准' }, { value: 'low', label: '低带宽' }]),
      input('sourceLanguage', '源语言（如 en）'), input('targetLanguage', '目标语言（如 zh）'),
      h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', checked: draft.bidirectional === true, onChange: event => { dirty.current.add('bidirectional'); setDraft(current => ({ ...current, bidirectional: event.target.checked })) } }), '启用双向翻译'),
      input('personaName', 'Persona 名称'), input('personaPrompt', 'Persona 提示词', true), input('instructions', '会话指令', true),
      h('label', { className: 'bt-phone-field' }, h('span', null, 'Persona 别名（逗号分隔）'), h('input', { className: 'bt-input', 'data-moss-live-field': 'personaAliases', value: (draft.personaAliases ?? []).join(', '), onInput: event => { dirty.current.add('personaAliases'); setDraft(current => ({ ...current, personaAliases: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })) } })),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: saveConfig }, '保存配置')),
    h('section', { className: 'bt-phone-card' }, h('h3', null, '体验设置'),
      h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', checked: draft.greetingEnabled !== false, onChange: event => { dirty.current.add('greetingEnabled'); setDraft(current => ({ ...current, greetingEnabled: event.target.checked })) } }), '启动时播放开场问候'),
      input('greetingText', '开场问候文本', true),
      h('p', { className: 'bt-note' }, '开场问候使用浏览器系统语音播放。麦克风会在问候期间暂时静音，结束后恢复。')),
    h('section', { className: 'bt-phone-card', 'data-moss-live-screen-share': true },
      h('div', { className: 'bt-moss-card-heading' }, h('h3', null, '屏幕共享'), screenSharing
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: screenBusy, onClick: stopScreenShare }, '停止共享')
        : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || screenBusy || !active, onClick: startScreenShare }, '共享屏幕')),
      h('p', { className: 'bt-note' }, active ? '只会实时发送当前屏幕画面给 MOSS，不会保存到本地。' : '开始 MOSS Live 后可以共享屏幕。摄像头暂未启用。'),
      h('video', { ref: screenPreview, className: 'bt-moss-screen-preview', hidden: !screenSharing, autoPlay: true, muted: true, playsInline: true, 'aria-label': '屏幕共享预览' }),
      screenError ? h('p', { className: 'bt-error', role: 'alert' }, screenError) : null),
    h('section', { className: 'bt-phone-card' }, h('h3', null, 'MOSS API Key'),
      h('p', { className: 'bt-note' }, '密钥只保存到 DS Bot Secret Store，不会显示在状态或会话页面。'),
      h('label', { className: 'bt-phone-field' }, h('span', null, 'API Key'), h('input', { className: 'bt-input', type: 'password', autoComplete: 'off', 'data-moss-live-field': 'apiKey', value: apiKey, onInput: event => setApiKey(event.target.value) })),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || !apiKey.trim(), onClick: saveApiKey }, '保存 API Key')),
    h('section', { className: 'bt-phone-card' }, h('div', { className: 'bt-moss-card-heading' }, h('h3', null, '实时字幕'), h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: transcript.length === 0, onClick: () => downloadMossTranscript(transcript, draft, startedAt, endedAt) }, '导出记录')),
      transcript.length ? h('div', { className: 'bt-moss-transcript', role: 'log' }, transcript.map((item, index) => h('p', { key: `${index}-${item.id ?? item.kind}-${item.text.slice(0, 12)}`, 'data-kind': item.kind }, `${item.kind === 'user' ? '你' : 'MOSS'}：${item.text}`))) : h('p', { className: 'bt-note' }, '开始会话后，实时字幕会显示在这里。'),
      error ? h('p', { className: 'bt-error', role: 'alert' }, hostText(error)) : null,
      message ? h('p', { role: 'status' }, message) : null))
}

export function voiceTestSummary(metrics = {}) {
  const frames = Number(metrics.microphoneFrames ?? 0)
  if (!frames) return '还没有收到麦克风音频。'
  const peak = Number(metrics.microphonePeak ?? 0)
  const rms = Number(metrics.microphoneRms ?? 0)
  const wakeResults = Number(metrics.wakeKeywordResults ?? 0)
  const wakePublished = Number(metrics.wakePublished ?? 0)
  const segments = Number(metrics.segmentEnded ?? 0)
  const asrAttempted = Number(metrics.asrAttempted ?? 0)
  const asrCompleted = Number(metrics.asrCompleted ?? 0)
  const ownerRejected = Number(metrics.ownerRejected ?? 0)
  const ownerFailed = Number(metrics.ownerFailed ?? 0)
  const voiceprintStarted = Number(metrics.voiceprintTestStarted ?? 0)
  const voiceprintCompleted = Number(metrics.voiceprintTestCompleted ?? 0)
  if (metrics.voiceprintTestActive === true || metrics.voiceprintTestState === 'listening' || metrics.voiceprintTestState === 'recognizing') {
    return metrics.voiceprintTestState === 'recognizing' ? '声纹测试正在识别当前语音段。说完后可以继续说下一段。' : `声纹测试持续监听中，已完成 ${voiceprintCompleted} 段。`
  }
  if (voiceprintStarted > voiceprintCompleted) return '声纹测试已启动。请直接说话，不需要先说唤醒词。'
  if (voiceprintCompleted > 0) {
    if (metrics.voiceprintTestResult === 'owner_verified') return '声纹测试完成：主人声纹通过。'
    if (metrics.voiceprintTestResult === 'owner_rejected') return '声纹测试完成：主人声纹没有通过。'
    return '声纹测试完成，但模型没有得到有效结果。'
  }
  if (wakeResults === 0 && segments === 0) {
    if (rms < .01 && peak < 2500) return '已收到麦克风音频，但音量接近静音。没有检测到唤醒词或语音，因此没有进行语音转写和主人声纹验证。'
    return '已收到麦克风音频，但没有检测到唤醒词或语音。因此没有进行语音转写和主人声纹验证。'
  }
  if (wakePublished === 0) return '麦克风收到了声音，但没有检测到已配置的唤醒词。'
  if (segments === 0) return '已检测到唤醒词，但没有形成可处理的语音段。'
  if (asrAttempted > 0 && asrCompleted === 0) return '语音段已送入语音转写，但没有完成转写。'
  if (ownerRejected > 0 || ownerFailed > 0) return '语音转写完成，但主人声纹拒绝了这段声音或无法计算分数。'
  return '唤醒、语音段和主人声纹验证都有结果。'
}

export const PLUGIN_CSS = `
.bt-preset-tools{max-width:860px;color:var(--bt-ink);font:14px var(--bt-font);padding:8px 0 32px}
.bt-preset-tools h2{font-size:18px;margin:0 0 6px}.bt-preset-tools h3{font-size:14px;margin:24px 0 10px}
.bt-preset-tools p{line-height:1.6}.bt-preset-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
.bt-preset-heading p{margin:0;color:var(--bt-ink-2)}.bt-preset-heading button{flex:none}
.bt-preset-list{border:1px solid var(--bt-line);border-radius:12px;overflow:hidden}
.bt-preset-list:empty{display:none}
.bt-preset-row{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:16px;background:var(--bt-card);color:var(--bt-ink);border:0;text-align:left;cursor:pointer;font:inherit}
.bt-preset-row+.bt-preset-row{border-top:1px solid var(--bt-line)}.bt-preset-row:hover{background:var(--bt-hover)}
.bt-preset-row>span:last-child{font-size:12px;color:var(--bt-ink-2);flex:none}
.bt-preset-tools small{display:block;color:var(--bt-ink-2);margin-top:4px;overflow-wrap:anywhere}
.bt-preset-bot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:14px 0;border-bottom:1px solid var(--bt-line)}
.bt-preset-actions{display:flex;flex-wrap:wrap;gap:8px}.bt-preset-result{margin-top:20px}
.bt-plugin-report{border:1px solid var(--bt-line);border-radius:12px;padding:14px;margin:8px 0;background:var(--bt-tag-bg);line-height:1.6}
.bt-phone-agent{max-width:860px;color:var(--bt-ink);font:14px var(--bt-font);padding:8px 0 32px}.bt-phone-agent h2{font-size:18px;margin:0 0 6px}.bt-phone-agent h3{font-size:14px;margin:0 0 12px}.bt-phone-agent p{line-height:1.6}.bt-phone-card{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:16px;padding:16px;margin-top:16px}.bt-phone-tabs{display:flex;gap:8px;margin:16px 0 4px;padding-bottom:4px;border-bottom:1px solid var(--bt-line)}.bt-phone-tab-active{font-weight:600;border-color:var(--bt-ink-2)}.bt-phone-test-center{display:block}.bt-phone-test-state{margin:10px 0 0;color:var(--bt-ink-2)}.bt-phone-asr-result{min-height:76px;white-space:pre-wrap;overflow-wrap:anywhere;font:15px var(--bt-font);margin:12px 0;padding:12px;background:var(--bt-tag-bg);border:1px solid var(--bt-line);border-radius:8px}.bt-phone-textarea{min-height:72px;resize:vertical}.bt-phone-panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.bt-phone-panel-heading h3{margin-bottom:6px}.bt-phone-panel-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.bt-phone-summary{margin:14px 0 0;padding:10px 12px;background:var(--bt-tag-bg);border-left:3px solid var(--bt-line);border-radius:8px}.bt-phone-voiceprint-review,.bt-phone-voiceprint-samples{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:12px;padding:10px 12px;background:var(--bt-tag-bg);border:1px solid var(--bt-line);border-radius:8px}.bt-phone-voiceprint-review p{margin:0}.bt-phone-field{display:flex;flex-direction:column;gap:6px;margin:10px 0}.bt-phone-field>span{font-size:12px;color:var(--bt-ink-2)}.bt-phone-check{display:flex;gap:8px;align-items:center;margin:10px 0}.bt-phone-bot{border-top:1px solid var(--bt-line);padding:14px 0}.bt-phone-bot:first-of-type{border-top:0}.bt-phone-bot>.bt-phone-field{max-width:520px}.bt-phone-diagnostic-grid{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;margin-top:14px;align-items:start}.bt-phone-diagnostic-grid>span{color:var(--bt-ink-2)}.bt-phone-diagnostic{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,monospace;margin:8px 0 0;padding:8px;background:var(--bt-tag-bg);border-radius:8px}.bt-phone-recent{margin-top:14px}.bt-phone-recent ul{margin:8px 0 0;padding-left:22px}.bt-phone-recent li{font:12px ui-monospace,monospace;line-height:1.6;overflow-wrap:anywhere}
.bt-moss-live{max-width:860px;color:var(--bt-ink);font:14px var(--bt-font);padding:8px 0 32px}.bt-moss-live h2{font-size:18px;margin:0 0 6px}.bt-moss-live h3{font-size:14px;margin:0 0 12px}.bt-moss-live p{line-height:1.6}.bt-moss-live .bt-phone-card{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:16px;padding:16px;margin-top:16px}.bt-moss-textarea{min-height:88px;resize:vertical}.bt-moss-transcript{max-height:280px;overflow:auto;padding:10px 12px;background:var(--bt-tag-bg);border:1px solid var(--bt-line);border-radius:8px}.bt-moss-transcript p{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}.bt-moss-transcript p[data-kind=assistant]{color:var(--bt-ink-2)}
.bt-moss-screen-preview{display:block;width:100%;max-height:360px;object-fit:contain;margin-top:12px;background:var(--bt-ink);border-radius:10px;border:1px solid var(--bt-line)}
.bt-moss-screen-preview[hidden]{display:none}
.bt-moss-dsbot-settings>summary{cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;list-style:none}.bt-moss-dsbot-settings>summary:before{content:'›';font-size:20px;color:var(--bt-ink-2)}.bt-moss-dsbot-settings[open]>summary:before{transform:rotate(90deg)}.bt-moss-dsbot-settings>summary strong{flex:1}.bt-moss-dsbot-settings>summary::-webkit-details-marker{display:none}.bt-moss-dsbot-roster{max-height:240px;overflow:auto;border:1px solid var(--bt-line);border-radius:10px;padding:0 12px}.bt-moss-dsbot-row{display:grid;grid-template-columns:minmax(80px,1fr) auto auto;align-items:center;gap:10px;border-bottom:1px solid var(--bt-line)}.bt-moss-dsbot-row:last-child{border-bottom:0}.bt-moss-dsbot-row>span{overflow-wrap:anywhere;min-width:0}.bt-moss-dsbot-row .bt-phone-check{font-size:12px;white-space:nowrap}.bt-moss-dsbot-activity{max-height:420px;overflow:auto}.bt-moss-dsbot-task{padding:12px 0;border-top:1px solid var(--bt-line);overflow-wrap:anywhere}.bt-moss-dsbot-task:first-child{border-top:0}.bt-moss-dsbot-task p{white-space:pre-wrap;margin:8px 0}.bt-moss-dsbot-task summary{cursor:pointer;line-height:1.6;overflow-wrap:anywhere}.bt-moss-dsbot-task>details>summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.bt-moss-dsbot-task>details[open]>summary{display:block}.bt-moss-dsbot-task .bt-moss-card-heading{margin-bottom:6px}.bt-moss-dsbot-task .bt-moss-card-heading button{flex:none}@media(max-width:480px){.bt-moss-dsbot-row{grid-template-columns:minmax(0,1fr) auto}.bt-moss-dsbot-row>span{grid-column:1/-1;padding-top:8px}.bt-moss-dsbot-row .bt-phone-check{margin:0 0 10px}.bt-moss-dsbot-row .bt-phone-check:last-child{justify-self:end}}
.bt-moss-voice-picker{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.bt-moss-voice-picker>.bt-phone-field{min-width:0;margin:10px 0}.bt-moss-voice-actions{display:flex;gap:8px;padding-bottom:10px;white-space:nowrap}.bt-moss-voice-picker audio{grid-column:1/-1;width:100%;height:36px}.bt-moss-voice-picker audio[hidden]{display:none}.bt-moss-voice-picker>.bt-error,.bt-moss-voice-billing{grid-column:1/-1;margin:0}
.bt-moss-stage{position:relative;display:flex;align-items:center;justify-content:center;gap:24px;min-height:210px;margin:16px 0 8px;padding:20px;border:1px solid var(--bt-line);border-radius:20px;overflow:hidden;background:radial-gradient(circle at 35% 40%,color-mix(in srgb,var(--bt-star) 30%,var(--bt-card)),var(--bt-card) 65%);--moss-level:0}.bt-moss-stage[data-state=ready],.bt-moss-stage[data-state=stopped]{opacity:.82}.bt-moss-stage[data-state=thinking]{background:radial-gradient(circle at 35% 40%,color-mix(in srgb,var(--bt-accent) 24%,var(--bt-card)),var(--bt-card) 65%)}.bt-moss-stage[data-state=speaking]{background:radial-gradient(circle at 35% 40%,color-mix(in srgb,var(--bt-accent) 30%,var(--bt-card)),var(--bt-card) 65%)}.bt-moss-orb{position:relative;width:150px;height:150px;flex:none;transform:scale(calc(1 + var(--moss-level) * .22));transition:transform .12s ease-out}.bt-moss-orb-halo,.bt-moss-orb-core,.bt-moss-orb-ring{position:absolute;inset:0;border-radius:50%}.bt-moss-orb-halo{inset:-18%;background:radial-gradient(circle,color-mix(in srgb,var(--bt-star) 42%,transparent),transparent 68%);filter:blur(10px);opacity:.72;animation:bt-moss-orb-breathe 7.5s ease-in-out infinite}.bt-moss-orb-core{background:radial-gradient(40% 38% at 64% 40%,color-mix(in srgb,var(--bt-star) 70%,transparent),transparent 70%),radial-gradient(46% 42% at 42% 68%,color-mix(in srgb,var(--bt-accent) 60%,transparent),transparent 72%),radial-gradient(120% 120% at 50% 50%,var(--bt-card) 0%,color-mix(in srgb,var(--bt-star) 65%,var(--bt-card)) 58%,color-mix(in srgb,var(--bt-accent) 72%,var(--bt-ink)) 100%);box-shadow:inset -16px -12px 30px color-mix(in srgb,var(--bt-ink) 18%,transparent),0 18px 40px color-mix(in srgb,var(--bt-accent) 20%,transparent);animation:bt-moss-orb-swirl 16s linear infinite}.bt-moss-orb-core:before,.bt-moss-orb-core:after{content:"";position:absolute;inset:12%;border-radius:50%;border:1px solid color-mix(in srgb,var(--bt-card) 18%,transparent);animation:bt-moss-orb-swirl 21s linear infinite reverse}.bt-moss-orb-ring{inset:-6%;border:1px solid color-mix(in srgb,var(--bt-card) 20%,transparent);animation:bt-moss-orb-breathe 5s ease-in-out infinite}.bt-moss-orb-ring-2{inset:-16%;border-color:color-mix(in srgb,var(--bt-card) 8%,transparent);animation:bt-moss-orb-pulse 2.4s ease-out infinite}.bt-moss-stage[data-state=speaking] .bt-moss-orb-core{animation-duration:4.2s}.bt-moss-stage[data-state=speaking] .bt-moss-orb-ring-2{border-color:color-mix(in srgb,var(--bt-card) 24%,transparent)}.bt-moss-stage[data-state=greeting] .bt-moss-orb-core{animation-duration:3.6s}.bt-moss-stage-copy{display:flex;flex-direction:column;gap:6px;min-width:150px}.bt-moss-stage-copy strong{font-size:16px}.bt-moss-stage-copy span{color:var(--bt-ink-2);font-size:12px}.bt-moss-card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.bt-moss-card-heading h3{margin-bottom:0}.bt-moss-scene-note{margin:2px 0 10px;padding:8px 10px;background:var(--bt-tag-bg);border-radius:8px;color:var(--bt-ink-2)}
@keyframes bt-moss-orb-breathe{0%,100%{transform:scale(.96);opacity:.68}50%{transform:scale(1.05);opacity:.92}}@keyframes bt-moss-orb-swirl{to{transform:rotate(360deg)}}@keyframes bt-moss-orb-pulse{0%{transform:scale(.92);opacity:0}30%{opacity:.72}100%{transform:scale(1.15);opacity:0}}
@media (prefers-reduced-motion:reduce){.bt-moss-orb-halo,.bt-moss-orb-core,.bt-moss-orb-core:before,.bt-moss-orb-core:after,.bt-moss-orb-ring{animation:none}.bt-moss-orb{transition:none}}
`
