import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'

const EMPTY_CONTROLLER = {
  getSnapshot: () => ({ active: false, busy: false, sessionState: 'idle', profileId: '', boundBotId: '', endedAt: '', error: '' }),
  subscribe: () => () => {},
  start: () => Promise.resolve(null),
  stop: () => Promise.resolve(null),
}

const profileIdFor = (botId, profiles = []) => {
  const base = `moss-${botId}`.slice(0, 128)
  let id = base
  let suffix = 2
  while (profiles.some(profile => profile.id === id)) id = `${base.slice(0, 127 - String(suffix).length)}-${suffix++}`
  return id
}

function profileDraft(bot, config = {}) {
  const profile = (config.profiles ?? []).find(item => item.botId === bot.id)
  return {
    id: profile?.id ?? profileIdFor(bot.id, config.profiles ?? []),
    botId: bot.id,
    name: profile?.name ?? bot.name,
    voiceName: profile?.voiceName ?? String(config.voiceName ?? '').trim(),
    readHistory: profile?.readHistory === true,
    submitTasks: profile?.submitTasks === true,
    ...(profile?.memory === undefined ? {} : { memory: profile.memory }),
  }
}

function voiceOptions(draft, voices) {
  const current = String(draft?.voiceName ?? '').trim()
  return [
    { id: '', name: '默认音色' },
    ...(current && !voices.some(item => item.id === current) ? [{ id: current, name: `当前音色（${current}）` }] : []),
    ...voices,
  ]
}

function DetailsModal({ bot, draft, setDraft, voices, voicesBusy, voicesError, apiKey, setApiKey, saving, onClose, onSave, onPreview, previewState }) {
  const options = voiceOptions(draft, voices)
  return h('div', { className: 'bt-moss-details-modal-backdrop', 'data-moss-details-modal-backdrop': true },
    h('section', { className: 'bt-moss-details-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bt-moss-details-title', 'data-moss-details-dialog': true },
      h('header', { className: 'bt-moss-details-modal-head' },
        h('div', null, h('strong', { id: 'bt-moss-details-title' }, '设置 MOSS Live'), h('p', null, `当前 Bot：${bot.name}。音色只对当前 Profile 生效。`)),
        h('button', { type: 'button', className: 'bt-icon-btn', 'data-moss-details-close': true, 'aria-label': '关闭设置', onClick: onClose }, '×')),
      h('div', { className: 'bt-moss-details-modal-body' },
        h('p', { className: 'bt-note bt-moss-details-step' }, '保存后回到当前 Bot 的 MOSS Live 侧栏。拨打需要用户手动点击。'),
        h('label', { className: 'bt-phone-field' }, h('span', null, 'Profile 名称'), h('input', { className: 'bt-input', 'data-moss-details-profile-name': true, value: draft.name, disabled: saving, onChange: event => setDraft(current => ({ ...current, name: event.target.value })) })),
        h('label', { className: 'bt-phone-field' }, h('span', null, 'Profile 音色'), h('select', { className: 'bt-input', 'data-moss-details-profile-voice': true, value: draft.voiceName, disabled: saving || voicesBusy, onChange: event => setDraft(current => ({ ...current, voiceName: event.target.value })) }, options.map(option => h('option', { key: option.id || 'default', value: option.id }, option.name)))),
        h('div', { className: 'bt-moss-details-voice-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-moss-details-preview': true, disabled: !draft.voiceName || voicesBusy || previewState === 'loading', onClick: () => onPreview(draft.voiceName) }, previewState === 'loading' ? '生成试听…' : previewState === 'playing' ? '停止试听' : '试听'),
          voicesBusy ? h('span', { className: 'bt-note' }, '正在刷新音色…') : null),
        voicesError ? h('p', { className: 'bt-error', role: 'alert' }, voicesError) : null,
        h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', 'data-moss-details-read-history': true, checked: draft.readHistory, disabled: saving, onChange: event => setDraft(current => ({ ...current, readHistory: event.target.checked })) }), '允许读取当前 Bot 私聊历史'),
        h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', 'data-moss-details-submit-tasks': true, checked: draft.submitTasks, disabled: saving, onChange: event => setDraft(current => ({ ...current, submitTasks: event.target.checked })) }), '允许向当前 Bot 派发任务'),
        h('label', { className: 'bt-phone-field' }, h('span', null, 'MOSS API Key'), h('input', { className: 'bt-input', type: 'password', autoComplete: 'off', placeholder: '已由 Host Secret Store 保管', value: apiKey, disabled: saving, onChange: event => setApiKey(event.target.value) })),
        h('p', { className: 'bt-note' }, 'API Key 由多个 Profile 共用，音色和权限按 Profile 独立保存。')),
      h('footer', { className: 'bt-moss-details-modal-foot' },
        h('button', { type: 'button', className: 'bt-soft', disabled: saving, onClick: onClose }, '取消'),
        h('button', { type: 'button', className: 'bt-soft bt-moss-details-primary', 'data-moss-details-save': true, disabled: saving, onClick: onSave }, saving ? '保存中…' : '保存并返回侧栏'))))
}

export function MossLiveDetailsPanel({ bot, actions, controller }) {
  const owner = controller ?? EMPTY_CONTROLLER
  const [live, setLive] = useState(() => owner.getSnapshot())
  const [value, setValue] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [modal, setModal] = useState(false)
  const [draft, setDraft] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [voices, setVoices] = useState([])
  const [voicesBusy, setVoicesBusy] = useState(false)
  const [voicesError, setVoicesError] = useState('')
  const [saving, setSaving] = useState(false)
  const [previewState, setPreviewState] = useState('idle')
  const previewAudio = useRef(null)
  const alive = useRef(true)

  useEffect(() => {
    setLive(owner.getSnapshot())
    return owner.subscribe(() => setLive(owner.getSnapshot()))
  }, [owner])

  const load = async () => {
    try {
      const next = await actions.mossLive()
      if (alive.current) { setValue(next); setError('') }
      return next
    } catch (failure) {
      if (alive.current) setError(failure.message)
      return null
    }
  }
  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false; previewAudio.current?.pause?.() }
  }, [bot.id])

  const config = value?.config ?? { profiles: [], selectedProfileId: '', dsBot: { enabled: false, bots: [] } }
  const profile = (config.profiles ?? []).find(item => item.botId === bot.id) ?? null
  const bound = profile !== null
  const activeHere = live.boundBotId === bot.id && (live.active || live.busy)
  const openSettings = async () => {
    const latest = value ?? await load()
    setDraft(profileDraft(bot, latest?.config ?? config))
    setApiKey('')
    setMessage('')
    setError('')
    setVoicesError('')
    setModal(true)
  }
  useEffect(() => {
    const request = live.settingsRequest
    if (!request || request.botId !== bot.id) return undefined
    let current = true
    void openSettings().finally(() => { if (current) owner.consumeSettingsRequest?.(request.id) })
    return () => { current = false }
  }, [live.settingsRequest?.id, bot.id])
  useEffect(() => {
    if (!modal || value?.apiKeyConfigured !== true || typeof actions.mossLiveVoices !== 'function') return undefined
    let current = true
    setVoicesBusy(true)
    actions.mossLiveVoices().then(result => { if (current) setVoices(Array.isArray(result?.voices) ? result.voices : []) }, failure => { if (current) setVoicesError(failure.message) }).finally(() => { if (current) setVoicesBusy(false) })
    return () => { current = false }
  }, [modal, value?.apiKeyConfigured])
  const closeSettings = () => { previewAudio.current?.pause?.(); setPreviewState('idle'); setModal(false) }
  const preview = async id => {
    if (!id || typeof actions.mossLiveVoicePreview !== 'function') return
    if (previewState === 'playing') { previewAudio.current?.pause?.(); setPreviewState('idle'); return }
    setPreviewState('loading'); setVoicesError('')
    try {
      const result = await actions.mossLiveVoicePreview({ voiceId: id })
      if (!result?.url) throw new Error('试听音频没有返回')
      const audio = previewAudio.current ?? new Audio()
      previewAudio.current = audio
      audio.src = result.url
      audio.onended = () => alive.current && setPreviewState('idle')
      await audio.play()
      if (alive.current) setPreviewState('playing')
    } catch (failure) {
      if (alive.current) { setVoicesError(failure.message); setPreviewState('idle') }
    }
  }
  const save = async () => {
    if (!draft) return
    setSaving(true); setError(''); setMessage('')
    try {
      const profiles = config.profiles ?? []
      const nextProfiles = profiles.some(item => item.id === draft.id)
        ? profiles.map(item => item.id === draft.id ? draft : item)
        : [...profiles, draft]
      await actions.mossLiveUpdate({ config: { ...config, profiles: nextProfiles, selectedProfileId: draft.id } })
      if (apiKey.trim()) await actions.mossLiveSetKey({ value: apiKey.trim() })
      const next = await actions.mossLive()
      await owner.refreshBinding?.(true)
      if (alive.current) { setValue(next); setMessage('设置已保存'); setModal(false) }
    } catch (failure) {
      if (alive.current) setError(failure.message)
    } finally { if (alive.current) setSaving(false) }
  }
  const start = () => { setError(''); Promise.resolve(owner.start(profile?.id)).catch(failure => alive.current && setError(failure.message)) }
  const status = activeHere ? (live.active ? '通话中' : '正在连接') : live.endedAt && live.boundBotId === bot.id ? '已挂断' : bound ? '已绑定 · 未开始' : '未绑定 MOSS Profile'
  const voiceLabel = profile?.voiceName || '默认音色'
  return h(Fragment, null,
    h('section', { className: 'bt-moss-details', 'data-moss-details-panel': true, 'aria-label': 'MOSS Live' },
      h('header', { className: 'bt-moss-details-head' }, h('div', null, h('strong', null, 'MOSS Live'), h('small', null, bound ? `${profile.name} · 当前 Bot` : '当前 Bot 的语音设置与 Profile')), h('button', { type: 'button', className: 'bt-round', 'data-moss-details-settings': true, 'aria-label': '设置 MOSS Live', onClick: openSettings }, '⚙')),
      h('div', { className: `bt-moss-details-status${activeHere ? ' is-active' : ''}`, 'data-moss-details-status': status }, h('span', { className: 'bt-moss-details-orb', 'aria-hidden': true }), h('strong', null, status), h('small', null, activeHere ? '实时字幕和语音控制显示在右侧 MOSS 面板。' : bound ? '点击“拨打”后才会申请麦克风并建立通话。' : '先完成绑定和设置，再手动拨打。')),
      !bound
        ? h('div', { className: 'bt-moss-details-card' }, h('strong', null, '绑定当前 Bot'), h('p', null, '一个 Bot 只能绑定一个 MOSS Profile。保存后，MOSS Live 会固定服务当前 Bot。'), h('div', { className: 'bt-moss-details-actions' }, h('button', { type: 'button', className: 'bt-soft bt-moss-details-primary', 'data-moss-details-bind': true, onClick: openSettings }, '绑定并设置'), h('button', { type: 'button', className: 'bt-soft', 'data-moss-details-settings-secondary': true, onClick: openSettings }, '打开设置')))
        : h('div', { className: 'bt-moss-details-card' }, h('div', { className: 'bt-moss-details-kv' }, h('span', null, 'Profile'), h('strong', null, profile.name)), h('div', { className: 'bt-moss-details-kv' }, h('span', null, '音色'), h('strong', null, voiceLabel)), h('div', { className: 'bt-moss-details-kv' }, h('span', null, '读取历史 / 派发任务'), h('strong', null, `${profile.readHistory ? '开' : '关'} / ${profile.submitTasks ? '开' : '关'}`)), h('div', { className: 'bt-moss-details-actions' }, activeHere ? h('button', { type: 'button', className: 'bt-soft bt-moss-details-danger', 'data-moss-details-hangup': true, onClick: () => owner.stop() }, '挂断') : h('button', { type: 'button', className: 'bt-soft bt-moss-details-primary', 'data-moss-details-dial': true, disabled: value?.apiKeyConfigured !== true || live.busy, onClick: start }, '拨打'))),
      h('div', { className: 'bt-moss-details-note' }, value?.apiKeyConfigured === true ? 'API Key：已配置' : 'API Key：未配置。请在设置中保存。'),
      error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null,
      message ? h('p', { className: 'bt-success', role: 'status' }, message) : null),
    modal && draft ? h(DetailsModal, { bot, draft, setDraft, voices, voicesBusy, voicesError, apiKey, setApiKey, saving, onClose: closeSettings, onSave: save, onPreview: preview, previewState }) : null)
}
