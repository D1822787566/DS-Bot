import { createSource } from './sources.js'
import { MossLiveSession, mergeTranscriptEvent, speakMossGreeting } from './moss-live.js'

// One owner per client plugin instance. Views only subscribe; leaving a page
// cannot release its microphone, upstream connection, or in-flight Bot results.
export function createMossLiveController({ actions, createSession = options => new MossLiveSession(options), greet = speakMossGreeting } = {}) {
  const source = createSource({ visible: false, active: false, busy: false, sessionState: 'idle', muted: false, level: 0, levelSource: 'mic', transcript: [], screenStream: null, screenBusy: false, screenError: '', startedAt: '', endedAt: '', error: '', message: '' })
  const patch = update => source.set(state => ({ ...state, ...update }))
  let session = null, generation = 0, disposed = false, starting = null, stopping = null, greetingAbort = null, greetingActive = false
  const cancelGreeting = () => {
    greetingActive = false
    greetingAbort?.abort()
    try { globalThis.window?.speechSynthesis?.cancel?.() } catch { /* system speech is optional */ }
  }
  const valid = id => !disposed && id === generation
  const stop = ({ quiet = false, hide = false } = {}) => {
    if (hide) patch({ visible: false })
    if (stopping) return stopping
    const id = ++generation
    const current = session
    session = null
    cancelGreeting()
    patch({ active: false, busy: true, sessionState: 'stopped', muted: false, level: 0, screenStream: null, screenBusy: false, screenError: '', endedAt: new Date().toISOString(), error: '', message: '' })
    const pendingStart = starting
    stopping = (async () => {
      const results = await Promise.allSettled([current?.stop(), actions.mossLiveStop?.()])
      // A late Host start must be closed before another start is allowed.
      await pendingStart
      if (id === generation) {
        const failure = results.find(result => result.status === 'rejected')
        patch({ busy: false, error: failure?.reason?.message ?? '', message: !quiet && !failure ? 'MOSS Live 已停止' : '' })
      }
      return results[1].status === 'fulfilled' ? results[1].value : null
    })().finally(() => { stopping = null })
    return stopping
  }
  const start = () => {
    if (disposed) return Promise.resolve(null)
    if (starting) return starting
    if (stopping) return stopping.then(start)
    if (source.getSnapshot().active) return Promise.resolve(null)
    const id = ++generation
    patch({ visible: true, active: true, busy: true, sessionState: 'connecting', muted: false, error: '', message: '', screenError: '' })
    starting = (async () => {
      try {
        const previous = session
        session = null
        cancelGreeting()
        await previous?.stop()
        await actions.mossLiveStop?.()
        if (!valid(id)) return null
        const next = await actions.mossLiveStart()
        if (!valid(id)) { await actions.mossLiveStop?.(); return null }
        if (!next?.runtime?.port || !next?.runtime?.token) throw new Error('MOSS Live relay is not ready')
        patch({ startedAt: new Date().toISOString(), endedAt: '', transcript: [], level: 0, screenStream: null })
        greetingAbort = new AbortController()
        greetingActive = next.config?.greetingEnabled !== false
        const current = createSession({
          port: next.runtime.port, token: next.runtime.token, config: next.config,
          onState: state => {
            if (session !== current || !valid(id)) return
            const terminal = ['closed', 'error', 'stopped'].includes(state)
            if (terminal) cancelGreeting()
            patch({ sessionState: !terminal && greetingActive && source.getSnapshot().sessionState === 'greeting' ? 'greeting' : state, ...(terminal ? { active: false, level: 0, endedAt: new Date().toISOString(), screenStream: null } : {}) })
          },
          onLevel: (level, levelSource = 'mic') => { if (session === current && valid(id)) patch({ level, levelSource }) },
          onTranscript: item => {
            if (session === current && valid(id)) source.set(state => ({ ...state, transcript: mergeTranscriptEvent(state.transcript, { ...item, at: new Date().toISOString() }) }))
          },
          onScreenStream: screenStream => { if (session === current && valid(id)) patch({ screenStream }) },
          onEvent: event => {
            if (session === current && valid(id) && event.type === 'error') patch({ error: event.data?.error?.code === 'invalid_public_request' ? '一条会话指令未被 MOSS 接受。' : event.data?.error?.message ?? 'MOSS Live 返回错误' })
          },
        })
        session = current
        await current.connect()
        if (!valid(id) || !source.getSnapshot().active) return null
        current.setMicEnabled(!source.getSnapshot().muted && !greetingActive)
        await current.startMic()
        if (!valid(id) || !source.getSnapshot().active) return null
        if (next.config?.greetingEnabled !== false) {
          current.setMicEnabled(false)
          patch({ sessionState: 'greeting' })
          await greet(next.config?.greetingText || `你好，我是 ${next.config?.personaName || 'DS Bot'}，现在可以直接和我说话。`, { signal: greetingAbort.signal })
          if (valid(id) && session === current && current.ws && !greetingAbort.signal.aborted) {
            greetingActive = false
            current.setMicEnabled(!source.getSnapshot().muted)
            patch({ sessionState: current.state })
          }
        }
        if (valid(id) && source.getSnapshot().active) patch({ message: 'MOSS Live 已开始' })
        return next
      } catch (failure) {
        if (!valid(id)) return null
        const failed = session
        session = null
        cancelGreeting()
        await Promise.allSettled([failed?.stop(), actions.mossLiveStop?.()])
        if (valid(id)) patch({ active: false, sessionState: 'error', level: 0, screenStream: null, endedAt: new Date().toISOString(), error: failure.message })
        return null
      } finally { if (id === generation) patch({ busy: false }) }
    })().finally(() => { starting = null })
    return starting
  }
  const screenAction = async enable => {
    const id = generation, current = session
    patch({ screenBusy: true, screenError: '' })
    try {
      if (!current || !source.getSnapshot().active) throw new Error('请先开始 MOSS Live')
      const result = enable ? await current.startScreenShare() : await current.stopScreenShare()
      if (valid(id) && session === current && (!enable || result)) patch({ message: enable ? '屏幕共享已开启' : '屏幕共享已停止' })
    } catch (failure) { if (valid(id)) patch({ screenError: failure.message }) }
    finally { if (id === generation) patch({ screenBusy: false }) }
  }
  return {
    getSnapshot: source.getSnapshot, subscribe: source.subscribe, start, stop,
    clearFeedback: () => patch({ error: '', message: '' }),
    setMuted(muted) {
      if (!source.getSnapshot().active) return
      patch({ muted: Boolean(muted) })
      session?.setMicEnabled(!muted && !greetingActive)
    },
    startScreenShare: () => screenAction(true), stopScreenShare: () => screenAction(false),
    dispose() { disposed = true; return stop({ quiet: true, hide: true }) },
  }
}

export function bindMossLiveLifecycle(controller, { roster, events = globalThis.window }) {
  const sync = () => {
    const live = controller.getSnapshot()
    if (roster.getSnapshot().pluginsEnabled === false && (live.visible || live.busy)) void controller.stop({ quiet: true, hide: true })
  }
  const off = roster.subscribe(sync)
  const unload = () => { void controller.dispose() }
  events?.addEventListener('pagehide', unload)
  sync()
  return () => { off(); events?.removeEventListener('pagehide', unload); return controller.dispose() }
}
