import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { hostText, t } from './i18n.js'
import { transcriptMarkdown } from './moss-live.js'

const LABELS = { unchecked: 'Not checked', checking: 'Checking compatibility', ready: 'Ready for Bot', partial: 'Partially compatible', single: 'Single chat only', unverified: 'Needs verification', incompatible: 'Not compatible', failed: 'Check failed', outdated: 'Check outdated' }
const EMPTY_UI_STATE = Object.freeze({ details: null })
const EMPTY_UI_STORE = Object.freeze({ subscribe: () => () => {}, getSnapshot: () => EMPTY_UI_STATE })

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

export function MossLiveCaptionPanel({ controller, onOpenSettings, ui }) {
  const live = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const uiStore = ui ?? EMPTY_UI_STORE
  const uiState = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot)
  const history = useRef(null)
  const [followLatest, setFollowLatest] = useState(true)
  const [tab, setTab] = useState('captions')
  const [showHistory, setShowHistory] = useState(false)
  const profile = live.boundProfile ?? {}
  const items = Array.isArray(live.transcript) ? live.transcript.filter(item => item?.text) : []
  const current = items.at(-1)
  const savedItems = (profile.memory?.turns ?? []).filter(turn => turn.id !== live.recordId).flatMap(turn => turn.items).filter(item => item?.text)
  const historyItems = [...savedItems, ...(current ? items.slice(0, -1) : items)]
  useEffect(() => {
    if (!followLatest || !history.current) return
    history.current.scrollTop = history.current.scrollHeight
  }, [historyItems.length, current?.text, followLatest, showHistory, live.active])
  const onScroll = event => {
    const node = event.currentTarget
    const atLatest = node.scrollHeight - node.scrollTop - node.clientHeight < 24
    setFollowLatest(atLatest)
  }
  const ended = live.endedAt && !live.active && !live.busy
  const idle = Boolean(live.boundProfile && !live.active && !ended)
  const memoryTurns = profile.memory?.turns?.length ?? 0
  useEffect(() => { setShowHistory(false); setFollowLatest(true); setTab('captions') }, [live.profileId, live.recordId])
  const openSettings = () => { controller.requestSettings?.(live.boundBotId); onOpenSettings?.(live.boundBotId) }
  const dial = () => controller.start?.(live.profileId)
  const newContext = () => controller.start?.(live.profileId, { resume: false })
  const detailsOpen = uiState?.details !== null && uiState?.details !== undefined
  useEffect(() => {
    if (!live.visible || detailsOpen || typeof document === 'undefined') return undefined
    const center = document.querySelector('[class*="_centerCol"]')
    const panel = document.querySelector('[data-moss-caption-panel]')
    if (!center || !panel) return undefined
    const resize = () => {
      const width = panel.getBoundingClientRect().width || 360
      center.style.setProperty('margin-right', `${Math.ceil(width + 32)}px`, 'important')
    }
    resize()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    observer?.observe(panel)
    return () => {
      observer?.disconnect()
      center.style.removeProperty('margin-right')
    }
  }, [live.visible, detailsOpen])
  if (!live.visible || detailsOpen) return null
  return h('aside', { className: 'bt-moss-caption-panel', 'data-moss-caption-panel': true, 'data-moss-caption-tab': tab, 'aria-label': 'MOSS 实时字幕' },
    h('nav', { className: 'bt-moss-caption-tabs', 'aria-label': '当前 Bot 页面' },
      h('button', { type: 'button', className: tab === 'captions' ? 'is-active' : '', 'data-moss-caption-tab-button': 'captions', onClick: () => setTab('captions') }, 'MOSS 字幕'),
      h('button', { type: 'button', className: tab === 'bot' ? 'is-active' : '', 'data-moss-caption-tab-button': 'bot', onClick: () => setTab('bot') }, 'Bot 聊天')),
    h('header', { className: 'bt-moss-caption-head' },
      h('div', null, h('strong', null, idle ? 'MOSS Live' : '实时字幕'), h('small', { role: 'status' }, ended ? '已挂断' : live.active ? '正在听' : idle ? '已绑定 · 未开始' : '等待开始')),
      memoryTurns ? h('button', { type: 'button', 'data-moss-caption-history-toggle': true, 'aria-expanded': showHistory, onClick: () => setShowHistory(value => !value) }, showHistory ? '返回字幕' : '会话记录') : null,
      onOpenSettings ? h('button', { type: 'button', className: 'bt-moss-caption-settings', 'data-moss-caption-settings': true, 'aria-label': '设置 MOSS Live', onClick: openSettings }, '⚙') : null),
    showHistory
      ? h('section', { className: 'bt-moss-caption-saved-history', 'data-moss-caption-saved-history': true, 'aria-label': 'MOSS 会话记录' },
        [...(profile.memory?.turns ?? [])].reverse().map((turn, index) => h('details', { key: turn.id, open: index === 0 },
          h('summary', null, turn.endedAt || turn.startedAt ? new Date(turn.endedAt || turn.startedAt).toLocaleString() : `会话 ${memoryTurns - index}`),
          turn.truncated ? h('small', null, '此记录仅保留最近对话片段。') : null,
          turn.items.map((item, at) => h('p', { key: at, 'data-moss-caption-speaker': item.kind }, h('small', null, item.kind === 'user' ? '你' : 'MOSS'), h('span', null, item.text))))))
      : idle
      ? h('section', { className: 'bt-moss-caption-idle', 'data-moss-caption-idle': true },
        h('div', { className: 'bt-moss-caption-idle-orb', 'aria-hidden': true }),
        h('strong', null, profile.name || '当前 MOSS Profile'),
        h('p', null, `音色：${profile.voiceName || '默认音色'}`),
        memoryTurns ? h('p', { className: 'bt-moss-caption-memory' }, profile.memory?.summary ? `上次对话：${profile.memory.summary}` : `已保存 ${memoryTurns} 次练习记录`) : null,
        h('small', null, '点击“拨打”后才会申请麦克风并建立通话。'),
        h('div', { className: 'bt-moss-caption-idle-actions' },
          h('button', { type: 'button', className: 'bt-moss-caption-dial', 'data-moss-caption-dial': true, disabled: live.busy, onClick: dial }, live.busy ? '准备中…' : memoryTurns ? '继续练习' : '拨打'),
          memoryTurns ? h('button', { type: 'button', className: 'bt-soft bt-moss-caption-new-context', 'data-moss-caption-new-context': true, disabled: live.busy, onClick: newContext }, '开始新会话') : null))
      : [h('section', { key: 'current', className: 'bt-moss-caption-current', 'data-moss-caption-current': true, 'data-moss-caption-speaker': current?.kind ?? '', 'aria-live': 'polite' },
        h('small', null, current?.kind === 'user' ? '你' : 'MOSS'),
        h('strong', null, current?.text || '开始通话后，实时字幕会显示在这里。')),
      h('div', { key: 'history', className: 'bt-moss-caption-history', ref: history, onScroll, 'data-moss-caption-transcript': true, role: 'log' },
        historyItems.map((item, index) => h('p', { key: `${item.id ?? item.kind}-${index}`, 'data-moss-caption-speaker': item.kind },
          h('small', null, item.kind === 'user' ? '你' : 'MOSS'), h('span', null, item.text))),
        !followLatest && items.length ? h('button', { type: 'button', className: 'bt-moss-caption-latest', onClick: () => { setFollowLatest(true); if (history.current) history.current.scrollTop = history.current.scrollHeight } }, '回到最新') : null)],
    live.memoryError ? h('div', { className: 'bt-moss-caption-memory-error', role: 'alert' }, live.memoryError,
      items.length ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => downloadMossTranscript(items, { personaName: profile.name }, live.startedAt, live.endedAt) }, '导出记录') : null) : null,
    h('footer', { className: 'bt-moss-caption-controls' },
      h('span', null, idle ? '当前 Bot 的 MOSS Live' : '语音控制'),
      live.screenStream ? h('button', { type: 'button', 'data-moss-caption-share-stop': true, disabled: live.screenBusy, onClick: controller.stopScreenShare }, '停止共享') : null,
      live.active && !live.screenStream ? h('button', { type: 'button', 'data-moss-caption-share-start': true, disabled: live.screenBusy, onClick: controller.startScreenShare }, '共享屏幕') : null,
      live.active ? h('button', { type: 'button', 'data-moss-caption-mute': true, 'aria-pressed': live.muted === true, onClick: () => controller.setMuted(!live.muted) }, live.muted ? '取消静音' : '静音') : null,
      onOpenSettings ? h('button', { type: 'button', 'data-moss-caption-settings-secondary': true, onClick: openSettings }, '设置') : null,
      tab === 'bot' ? h('button', { type: 'button', onClick: () => setTab('captions') }, '返回 MOSS') : null,
      ended && memoryTurns ? h('button', { type: 'button', 'data-moss-caption-new-context': true, disabled: live.busy, onClick: newContext }, '开始新会话') : null,
      idle ? h('button', { type: 'button', className: 'bt-moss-caption-dial-secondary', onClick: dial, disabled: live.busy }, memoryTurns ? '继续练习' : '拨打') : ended ? h('button', { type: 'button', 'data-moss-caption-redial': true, disabled: live.busy, onClick: dial }, '重新拨打') : live.active ? h('button', { type: 'button', className: 'bt-moss-caption-end', 'data-moss-caption-end': true, onClick: () => controller.stop() }, '挂断') : null))
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
.bt-moss-screen-preview{display:block;width:100%;max-height:360px;object-fit:contain;margin-top:12px;background:var(--bt-ink);border-radius:10px;border:1px solid var(--bt-line)}
.bt-moss-screen-preview[hidden]{display:none}
@keyframes bt-moss-orb-breathe{0%,100%{transform:scale(.96);opacity:.68}50%{transform:scale(1.05);opacity:.92}}@keyframes bt-moss-orb-swirl{to{transform:rotate(360deg)}}@keyframes bt-moss-orb-pulse{0%{transform:scale(.92);opacity:0}30%{opacity:.72}100%{transform:scale(1.15);opacity:0}}
@media (prefers-reduced-motion:reduce){.bt-moss-orb-halo,.bt-moss-orb-core,.bt-moss-orb-core:before,.bt-moss-orb-core:after,.bt-moss-orb-ring{animation:none}.bt-moss-orb{transition:none}}
.bt-moss-caption-settings{display:grid;place-items:center;width:28px;height:28px;padding:0!important;border:1px solid var(--bt-line);border-radius:50%!important;background:var(--bt-card);font-size:14px!important}.bt-moss-caption-idle{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 18px 24px;text-align:center;background:radial-gradient(circle at 50% 15%,color-mix(in srgb,var(--bt-accent) 10%,var(--bt-card)),var(--bt-card) 72%);border-bottom:1px solid var(--bt-line)}.bt-moss-caption-idle-orb{width:62px;height:62px;border-radius:50%;background:radial-gradient(circle at 35% 30%,color-mix(in srgb,var(--bt-star) 70%,var(--bt-card)),color-mix(in srgb,var(--bt-accent) 75%,var(--bt-ink)));box-shadow:inset -7px -7px 15px color-mix(in srgb,var(--bt-ink) 14%,transparent),0 8px 24px color-mix(in srgb,var(--bt-accent) 20%,transparent)}.bt-moss-caption-idle strong{font-size:14px}.bt-moss-caption-idle p{margin:0;color:var(--bt-ink-2);font-size:11px}.bt-moss-caption-idle small{color:var(--bt-ink-3);font-size:10px;line-height:1.5}.bt-moss-caption-dial,.bt-moss-caption-dial-secondary{border:1px solid var(--bt-accent)!important;background:var(--bt-accent)!important;color:var(--bt-accent-ink,var(--bt-card))!important}.bt-moss-caption-dial{min-width:150px;margin-top:6px;padding:9px 16px!important;border-radius:8px!important;font-size:11px!important;font-weight:600}.bt-moss-caption-dial:disabled,.bt-moss-caption-dial-secondary:disabled{opacity:.55;cursor:wait}.bt-moss-caption-panel[data-moss-caption-tab=bot] .bt-moss-caption-idle{display:none}
.bt-moss-caption-panel{position:fixed;z-index:20;top:calc(var(--dsw-header-height,0px) + 12px);right:16px;bottom:16px;display:flex;flex-direction:column;width:min(360px,calc(100vw - 32px));overflow:hidden;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:16px;box-shadow:var(--bt-shadow-3,0 8px 28px color-mix(in srgb,var(--bt-ink) 8%,transparent));color:var(--bt-ink)}.bt-moss-caption-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--bt-line)}.bt-moss-caption-head strong{display:block;font-size:12px}.bt-moss-caption-head small{display:block;margin-top:3px;color:var(--bt-green,var(--bt-ink-2));font-size:10px}.bt-moss-caption-head button{padding:5px 7px;border-radius:8px;color:var(--bt-ink-2);font-size:10px}.bt-moss-caption-current{padding:26px 18px 22px;text-align:center;background:color-mix(in srgb,var(--bt-accent) 5%,var(--bt-card));border-bottom:1px solid var(--bt-line)}.bt-moss-caption-current small{color:var(--bt-accent);font-size:10px}.bt-moss-caption-current strong{display:block;margin-top:10px;font-size:22px;line-height:1.45;font-weight:550}.bt-moss-caption-history{position:relative;min-height:0;flex:1;overflow:auto;padding:13px 14px}.bt-moss-caption-history p{display:flex;flex-direction:column;gap:3px;margin:0 0 13px;color:var(--bt-ink-2);font-size:11px;line-height:1.65}.bt-moss-caption-history p[data-moss-caption-speaker=user]{color:var(--bt-ink)}.bt-moss-caption-history p[data-moss-caption-speaker=assistant]{color:var(--bt-ink-2)}.bt-moss-caption-history p small{color:var(--bt-ink-3);font-size:9px}.bt-moss-caption-latest{position:sticky;bottom:2px;display:block;margin:0 auto;padding:6px 9px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-accent);font-size:10px}.bt-moss-caption-controls{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:9px 12px;border-top:1px solid var(--bt-line)}.bt-moss-caption-controls>span{margin-right:auto;color:var(--bt-ink-2);font-size:9px}.bt-moss-caption-controls button{padding:7px 8px;border:1px solid var(--bt-line);border-radius:8px;color:var(--bt-ink-2);font-size:9px}.bt-moss-caption-controls button[aria-pressed=true]{color:var(--bt-danger,var(--bt-ink));background:color-mix(in srgb,var(--bt-danger,var(--bt-ink)) 7%,var(--bt-card))}.bt-moss-caption-controls .bt-moss-caption-end{color:var(--bt-danger,var(--bt-ink));background:color-mix(in srgb,var(--bt-danger,var(--bt-ink)) 6%,var(--bt-card))}@media(max-width:760px){.bt-moss-caption-panel{top:64px;right:10px;bottom:10px;width:calc(100vw - 20px)}.bt-moss-caption-current strong{font-size:21px}.bt-moss-caption-controls{padding:9px 10px}}
.bt-moss-caption-tabs{display:flex;gap:4px;padding:6px;border-bottom:1px solid var(--bt-line);background:var(--bt-tag-bg)}.bt-moss-caption-tabs button{flex:1;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);font-size:10px}.bt-moss-caption-tabs button.is-active{background:var(--bt-card);color:var(--bt-ink);font-weight:600}.bt-moss-caption-current[data-moss-caption-speaker=user] small,.bt-moss-caption-history p[data-moss-caption-speaker=user] small{color:var(--bt-accent)}.bt-moss-caption-current[data-moss-caption-speaker=assistant] small,.bt-moss-caption-history p[data-moss-caption-speaker=assistant] small{color:var(--bt-star,var(--bt-ink-2))}.bt-moss-caption-panel[data-moss-caption-tab=bot] .bt-moss-caption-head,.bt-moss-caption-panel[data-moss-caption-tab=bot] .bt-moss-caption-current,.bt-moss-caption-panel[data-moss-caption-tab=bot] .bt-moss-caption-history{display:none}
.bt-moss-details{display:flex;flex-direction:column;gap:14px}.bt-moss-details-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.bt-moss-details-head strong{display:block;font-size:15px}.bt-moss-details-head small{display:block;margin-top:4px;color:var(--bt-ink-3);font-size:11px;line-height:16px}.bt-moss-details-head .bt-round{flex:none;width:30px;height:30px;border:0;border-radius:50%;background:var(--bt-hover);color:var(--bt-ink-2);cursor:pointer}.bt-moss-details-status{display:flex;flex-direction:column;align-items:center;gap:5px;padding:18px 12px;text-align:center;border:1px solid var(--bt-line);border-radius:16px;background:color-mix(in srgb,var(--bt-accent) 4%,var(--bt-card))}.bt-moss-details-status.is-active{background:color-mix(in srgb,var(--bt-green) 7%,var(--bt-card))}.bt-moss-details-status strong{font-size:13px}.bt-moss-details-status small{color:var(--bt-ink-2);font-size:11px;line-height:16px}.bt-moss-details-orb{width:46px;height:46px;border-radius:50%;background:radial-gradient(circle at 35% 30%,color-mix(in srgb,var(--bt-star) 55%,var(--bt-card)),color-mix(in srgb,var(--bt-accent) 75%,var(--bt-ink)));box-shadow:0 8px 22px color-mix(in srgb,var(--bt-accent) 18%,transparent)}.bt-moss-details-card{display:flex;flex-direction:column;gap:9px;padding:13px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}.bt-moss-details-card>strong{font-size:12px}.bt-moss-details-card>p{margin:0;color:var(--bt-ink-2);font-size:11px;line-height:16px}.bt-moss-details-actions{display:flex;gap:7px;flex-wrap:wrap}.bt-moss-details-actions button{flex:1;min-width:90px}.bt-moss-details-primary{background:var(--bt-accent);border-color:var(--bt-accent);color:var(--bt-accent-ink,var(--bt-card))}.bt-moss-details-primary:hover{background:color-mix(in srgb,var(--bt-accent) 86%,var(--bt-ink))}.bt-moss-details-danger{color:var(--bt-danger);border-color:color-mix(in srgb,var(--bt-danger) 32%,var(--bt-line))}.bt-moss-details-kv{display:flex;justify-content:space-between;gap:10px;font-size:11px;line-height:16px}.bt-moss-details-kv span{color:var(--bt-ink-2)}.bt-moss-details-kv strong{max-width:60%;overflow-wrap:anywhere;text-align:right}.bt-moss-details-note{font-size:11px;color:var(--bt-ink-3);line-height:16px}.bt-moss-details-modal-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:18px;background:color-mix(in srgb,var(--bt-ink) 22%,transparent)}.bt-moss-details-modal{width:min(500px,calc(100vw - 28px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--bt-line-2);border-radius:16px;background:var(--bt-card);color:var(--bt-ink);box-shadow:0 20px 60px color-mix(in srgb,var(--bt-ink) 20%,transparent)}.bt-moss-details-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--bt-line)}.bt-moss-details-modal-head strong{font-size:15px}.bt-moss-details-modal-head p{margin:5px 0 0;color:var(--bt-ink-2);font-size:11px}.bt-moss-details-modal-body{overflow:auto;padding:16px 18px}.bt-moss-details-step{padding:9px 10px;background:var(--bt-tag-bg);border-radius:8px}.bt-moss-details-voice-actions{display:flex;align-items:center;gap:8px;margin:-3px 0 8px}.bt-moss-details-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--bt-line)}.bt-success{color:var(--bt-green);font-size:12px}.bt-moss-details-modal .bt-phone-field{margin:10px 0}.bt-moss-details-modal .bt-phone-check{font-size:12px}@media(max-width:500px){.bt-moss-details-modal-backdrop{padding:8px}.bt-moss-details-modal{max-height:calc(100vh - 16px)}.bt-moss-details-modal-foot{padding:10px 12px}.bt-moss-details-modal-body{padding:12px}.bt-moss-details-modal-head{padding:12px 14px}}
.bt-moss-caption-memory{max-width:290px;max-height:88px;overflow:auto;margin:0!important;padding:8px 10px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-tag-bg);text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}.bt-moss-caption-idle-actions{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:6px}.bt-moss-caption-new-context{font-size:11px!important}
.bt-moss-caption-saved-history{flex:1;min-height:0;overflow:auto;padding:12px 14px;font-size:12px}.bt-moss-caption-saved-history details{padding:10px 0;border-bottom:1px solid var(--bt-line)}.bt-moss-caption-saved-history summary{cursor:pointer;color:var(--bt-ink-2)}.bt-moss-caption-saved-history p{display:flex;flex-direction:column;gap:4px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.bt-moss-caption-saved-history small{font-size:10px;color:var(--bt-ink-3)}.bt-moss-caption-saved-history [data-moss-caption-speaker=user] small{color:var(--bt-accent)}.bt-moss-caption-saved-history [data-moss-caption-speaker=assistant] small{color:var(--bt-star,var(--bt-ink-2))}.bt-moss-caption-memory-error{padding:10px 14px;color:var(--bt-danger);font-size:12px;line-height:1.5}.bt-moss-caption-memory-error button{margin-top:6px}.bt-moss-caption-panel[data-moss-caption-tab=bot] .bt-moss-caption-saved-history{display:none}
`
