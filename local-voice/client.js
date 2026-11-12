window.__ModuleLoader__.load({
  id: 'local-voice',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const css = `
      .local-voice-page{max-width:860px;color:var(--bt-ink,var(--dsw-alias-label-primary));font:14px/1.6 system-ui,sans-serif;padding:8px 0 32px}
      .local-voice-page h2{font-size:20px;margin:0 0 4px}.local-voice-page h3{font-size:15px;margin:0 0 12px}
      .local-voice-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
      .local-voice-heading p{margin:0}.local-voice-page .bt-phone-card{border:1px solid var(--bt-line,var(--dsw-alias-border-l2));border-radius:14px;padding:18px;margin-top:16px;background:var(--bt-card,transparent)}
      .local-voice-page .bt-phone-summary{border-left:3px solid var(--bt-line,var(--dsw-alias-border-l2));padding:10px 14px;margin:18px 0}
      .local-voice-page .bt-phone-field{display:flex;flex-direction:column;gap:6px;margin:14px 0}.local-voice-page .bt-phone-check{display:flex;align-items:center;gap:8px}
      .local-voice-page input:not([type=checkbox]){font:inherit;color:inherit;background:transparent;border:1px solid var(--bt-line,var(--dsw-alias-border-l2));border-radius:8px;padding:8px 10px;max-width:100%;box-sizing:border-box}
      .local-voice-page button{font:inherit;color:inherit;background:var(--bt-tag-bg,transparent);border:1px solid var(--bt-line,var(--dsw-alias-border-l2));border-radius:8px;padding:8px 14px;cursor:pointer}
      .local-voice-page button:disabled{opacity:.55;cursor:wait}.local-voice-page input:focus-visible,.local-voice-page button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
    `
    const states = { stopped: '未启动', starting: '模型加载中', ready: '模型已就绪', error: '启动失败' }
    const errors = {
      audio_device_busy: '音频设备正在被其他语音插件使用，请先在对应插件中停止语音。',
      runtime_start_timeout: '模型加载超时，请检查本地模型后重试。',
      runtime_not_ready: '本地模型或依赖未准备完成。',
      runtime_process_error: '本地语音运行环境不可用，请检查依赖准备结果。',
    }

    const call = async (action, config) => {
      const response = await fetch('api/local-voice', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(config === undefined ? {} : { config }) }),
      })
      const body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
      return body.value
    }

    function LocalVoiceSettings() {
      const [view, setView] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')

      const refresh = React.useCallback(() => call('view').then(setView), [])
      React.useEffect(() => {
        let live = true
        refresh().catch(reason => { if (live) setError(reason.message) })
        return () => { live = false }
      }, [refresh])

      const run = async action => {
        setBusy(true); setError(''); setMessage('')
        try {
          const next = await call(action)
          setView(next)
          if (next.runtime.state === 'error') setError(errors[next.runtime.error] || `模型启动失败：${next.runtime.error}`)
          else setMessage(action === 'start' ? '本地模型已加载；完整语音对话仍在开发中。' : '本地模型已停止')
        } catch (reason) { setError(reason.message) } finally { setBusy(false) }
      }

      const save = async event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        setBusy(true); setError(''); setMessage('')
        try {
          setView(await call('update', {
            enabled: data.get('enabled') === 'on',
            inputDeviceName: String(data.get('inputDeviceName') ?? ''),
            outputDeviceName: String(data.get('outputDeviceName') ?? ''),
          }))
          setMessage('设置已保存')
        } catch (reason) { setError(reason.message) } finally { setBusy(false) }
      }

      if (!view) return h('section', { className: 'local-voice-page', role: 'status' }, error || '正在加载 Local Voice…')
      const config = view.config
      const runtime = view.runtime
      return h('section', { className: 'local-voice-page bt-phone-agent', 'aria-label': 'Local Voice', 'aria-busy': busy },
        h('style', null, css),
        h('header', { className: 'local-voice-heading bt-phone-panel-heading' },
          h('div', null, h('h2', null, 'Local Voice（本地语音）'), h('p', null, '独立的中文 Windows 本地语音插件')),
          runtime.state === 'ready' || runtime.state === 'starting'
            ? h('button', { className: 'bt-soft', type: 'button', disabled: busy, onClick: () => run('stop') }, '停止模型')
            : h('button', { className: 'bt-soft', type: 'button', disabled: busy, onClick: () => run('start') }, busy ? '正在加载…' : '加载本地模型')),
        h('p', { className: 'bt-phone-summary' }, '开发中：当前可配置并加载本地模型。麦克风、唤醒词、主人声纹和对话播放尚未接入。'),
        h('div', { className: 'local-voice-status bt-phone-card', role: runtime.state === 'error' ? 'alert' : 'status' },
          h('strong', null, `运行状态：${states[runtime.state] || runtime.state}`),
          h('p', null, runtime.modelReady ? '模型已加载' : '模型未加载'),
          runtime.error ? h('p', null, errors[runtime.error] || `错误：${runtime.error}`) : null),
        h('form', { className: 'bt-phone-card', onSubmit: save },
          h('h3', null, '运行配置'),
          h('label', { className: 'bt-phone-check' }, h('input', { type: 'checkbox', name: 'enabled', defaultChecked: config.enabled }), '启用 Local Voice'),
          h('label', { className: 'bt-phone-field' }, '麦克风', h('input', { className: 'bt-input', name: 'inputDeviceName', defaultValue: config.inputDeviceName, placeholder: '使用系统默认设备' })),
          h('label', { className: 'bt-phone-field' }, '扬声器', h('input', { className: 'bt-input', name: 'outputDeviceName', defaultValue: config.outputDeviceName, placeholder: '使用系统默认设备' })),
          h('p', null, `ASR：${config.asrModel} · TTS：${config.ttsModel} · 中文 · 16 kHz`),
          h('button', { className: 'bt-soft', type: 'submit', disabled: busy }, '保存设置')),
        error ? h('p', { role: 'alert' }, error) : null,
        message ? h('p', { role: 'status' }, message) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab', id: 'local-voice', order: 130, label: 'Local Voice（本地语音）',
        }, LocalVoiceSettings)), 'local-voice: settings tab')
      },
    }
  },
})
