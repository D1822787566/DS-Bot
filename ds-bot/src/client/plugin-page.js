import { createElement as h, useEffect, useRef, useState } from 'react'
import { hostText, t } from './i18n.js'

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

export function PhoneAgentSettings({ actions }) {
  const [value, setValue] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
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
    h('section', { className: 'bt-phone-card' }, h('h3', null, t('Runtime diagnostics')),
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
    h('section', { className: 'bt-phone-card', 'aria-label': '语音测试面板' },
      h('div', { className: 'bt-phone-panel-heading' },
        h('div', null, h('h3', null, '语音测试面板'),
          h('p', { className: 'bt-note' }, '先清零数据，然后连续说几次唤醒词和简短指令。这里仅保存计数和安全分数，不保存音频或完整转写。')),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentDiagnosticsReset, '测试数据已清零') }, '清零测试数据')),
      h('p', { className: 'bt-phone-summary', role: 'status' }, voiceTestSummary(metrics)),
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
            `${({ 'windows.wake.published': '唤醒词命中', 'runtime.wake': '唤醒已确认', 'audio.segment.started': '开始接收语音', 'audio.segment.ended': '语音段完成', 'audio.segment.dropped': '语音段丢弃', 'asr.completed': '语音转写完成', 'asr.failed': '语音转写失败', 'identity.verified': '主人声纹通过', 'identity.rejected': '主人声纹拒绝', 'owner.failed': '主人声纹失败', 'input.submit': '提交给 Bot', 'input.accepted': 'Bot 接收成功', 'input.rejected': 'Bot 拒绝接收' }[event.type] ?? event.type)}${event.segmentId === undefined ? '' : ` · 第 ${event.segmentId} 段`}${event.reason ? ` · ${event.reason}` : ''}${typeof event.score === 'number' ? ` · 分数 ${event.score.toFixed(3)}` : ''}`))))
        : null),
    error ? h('div', { className: 'bt-error', role: 'alert' }, hostText(error)) : null,
    message ? h('p', { role: 'status' }, message) : null,
    h('section', { className: 'bt-phone-card' }, h('h3', null, t('Windows audio and LiveKit')),
      configField('deviceId', 'Device ID'), configField('inputDeviceName', 'Microphone'), configField('outputDeviceName', 'Speaker'),
      configField('livekitUrl', 'LiveKit local URL'), configField('livekitRoom', 'LiveKit room'),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ config: draft.config }), 'Settings saved') }, t('Save settings'))),
    h('section', { className: 'bt-phone-card' }, h('h3', null, t('ASR and TTS')),
      configField('asrModel', 'ASR model'), configField('asrModelDir', 'ASR model directory'), configField('speakerModelDir', 'Speaker model directory'), configField('speakerProfileDir', 'Speaker profile directory'),
      configField('ttsModel', 'TTS model'), configField('ttsConfigPath', 'TTS configuration path'),
      h('p', { className: 'bt-note' }, t('Speaker verification is enabled by default. Record or replace the owner profile before starting voice input.')),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ config: draft.config }), 'Settings saved') }, t('Save ASR/TTS'))),
    h('section', { className: 'bt-phone-card' }, h('h3', null, t('Advanced continuation')),
      h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', checked: draft.config.continuationEnabled !== false, onChange: event => setDraft(current => ({ ...current, config: { ...current.config, continuationEnabled: event.target.checked } })) }), t('Enable semantic continuation')),
      configField('continuationModel', 'Continuation model'), configField('continuationUrl', 'Continuation local URL'),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ config: draft.config }), 'Settings saved') }, t('Save advanced settings'))),
    h('section', { className: 'bt-phone-card' }, h('h3', null, t('Bots, wake words and voices')),
      (value?.bots ?? []).map(bot => {
        const profile = draft.bots[bot.id] ?? { wakeName: '', ttsVoice: '' }
        return h('div', { className: 'bt-phone-bot', key: bot.id }, h('strong', null, bot.name),
          h('label', { className: 'bt-phone-field' }, h('span', null, t('Wake word')), h('input', { className: 'bt-input', 'data-phone-agent-field': `${bot.id}:wakeName`, value: profile.wakeName, onInput: event => setDraft(current => ({ ...current, bots: { ...current.bots, [bot.id]: { ...current.bots[bot.id], wakeName: event.target.value } } })) })),
          h('label', { className: 'bt-phone-field' }, h('span', null, t('TTS voice')), h('input', { className: 'bt-input', 'data-phone-agent-field': `${bot.id}:ttsVoice`, value: profile.ttsVoice, onInput: event => setDraft(current => ({ ...current, bots: { ...current.bots, [bot.id]: { ...current.bots[bot.id], ttsVoice: event.target.value } } })) })),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(() => actions.phoneAgentUpdate({ botId: bot.id, profile }), 'Bot voice settings saved') }, t('Save')))
      }))
  )
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
.bt-phone-agent{max-width:860px;color:var(--bt-ink);font:14px var(--bt-font);padding:8px 0 32px}.bt-phone-agent h2{font-size:18px;margin:0 0 6px}.bt-phone-agent h3{font-size:14px;margin:0 0 12px}.bt-phone-agent p{line-height:1.6}.bt-phone-card{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:16px;padding:16px;margin-top:16px}.bt-phone-panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.bt-phone-panel-heading h3{margin-bottom:6px}.bt-phone-summary{margin:14px 0 0;padding:10px 12px;background:var(--bt-tag-bg);border-left:3px solid var(--bt-line);border-radius:8px}.bt-phone-field{display:flex;flex-direction:column;gap:6px;margin:10px 0}.bt-phone-field>span{font-size:12px;color:var(--bt-ink-2)}.bt-phone-check{display:flex;gap:8px;align-items:center;margin:10px 0}.bt-phone-bot{border-top:1px solid var(--bt-line);padding:14px 0}.bt-phone-bot:first-of-type{border-top:0}.bt-phone-bot>.bt-phone-field{max-width:520px}.bt-phone-diagnostic-grid{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;margin-top:14px;align-items:start}.bt-phone-diagnostic-grid>span{color:var(--bt-ink-2)}.bt-phone-diagnostic{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,monospace;margin:8px 0 0;padding:8px;background:var(--bt-tag-bg);border-radius:8px}.bt-phone-recent{margin-top:14px}.bt-phone-recent ul{margin:8px 0 0;padding-left:22px}.bt-phone-recent li{font:12px ui-monospace,monospace;line-height:1.6;overflow-wrap:anywhere}
`
