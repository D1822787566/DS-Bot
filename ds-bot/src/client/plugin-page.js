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
  useEffect(() => { load().catch(failure => setError(failure.message)) }, [])
  const run = async (task, done = 'Saved') => {
    setBusy(true); setError(''); setMessage('')
    try { const next = await task(); if (next?.config) { setValue(next); setDraft({ config: { ...next.config }, bots: Object.fromEntries((next.bots ?? []).map(bot => [bot.id, { wakeName: bot.wakeName ?? '', ttsVoice: bot.ttsVoice ?? '' }])) }) }; setMessage(done) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  if (draft === null) return h('section', { className: 'bt-phone-agent', 'aria-label': t('Phone Agent') }, h('p', { role: 'status' }, t('Loading…')))
  const configField = (key, label, type = 'text') => h('label', { className: 'bt-phone-field' }, h('span', null, t(label)), h('input', { className: 'bt-input', type, value: draft.config[key] ?? '', onChange: event => setDraft(current => ({ ...current, config: { ...current.config, [key]: type === 'checkbox' ? event.target.checked : event.target.value } })) }))
  const runtime = value?.runtime ?? { state: 'stopped' }
  return h('section', { className: 'bt-phone-agent', 'aria-label': t('Phone Agent'), 'aria-busy': busy },
    h('div', { className: 'bt-preset-heading' }, h('div', null, h('h2', null, t('Phone Agent')), h('p', null, t('Windows voice runtime for Bot wake words and speech.'))),
      runtime.state === 'stopped' || runtime.state === 'error'
        ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentStart, 'Phone Agent started') }, t('Start'))
        : h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(actions.phoneAgentStop, 'Phone Agent stopped') }, t('Stop'))),
    h('div', { className: 'bt-plugin-report', role: 'status' }, h('strong', null, t('Runtime: {state}', { state: runtime.state })), runtime.error ? h('p', null, runtime.error) : null),
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
      configField('continuationModel', 'Continuation model'), configField('continuationUrl', 'Continuation local URL'), configField('runtimeRoot', 'Phone Agent runtime folder'), configField('configPath', 'Phone Agent runtime config'),
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
.bt-phone-agent{max-width:860px;color:var(--bt-ink);font:14px var(--bt-font);padding:8px 0 32px}.bt-phone-agent h2{font-size:18px;margin:0 0 6px}.bt-phone-agent h3{font-size:14px;margin:0 0 12px}.bt-phone-agent p{line-height:1.6}.bt-phone-card{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:16px;padding:16px;margin-top:16px}.bt-phone-field{display:flex;flex-direction:column;gap:6px;margin:10px 0}.bt-phone-field>span{font-size:12px;color:var(--bt-ink-2)}.bt-phone-check{display:flex;gap:8px;align-items:center;margin:10px 0}.bt-phone-bot{border-top:1px solid var(--bt-line);padding:14px 0}.bt-phone-bot:first-of-type{border-top:0}.bt-phone-bot>.bt-phone-field{max-width:520px}
`
