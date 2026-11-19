import { createSource } from './sources.js'
import { MossLiveSession, mergeTranscriptEvent, speakMossGreeting } from './moss-live.js'

export function mossLiveErrorMessage(error) {
  const message = String(error?.message ?? error ?? '').trim()
  if (/insufficient_credits|\b402\b/i.test(message)) {
    return 'MOSS 账户可用积分不足或计费校验未通过（HTTP 402），请到 MOSS 控制台检查余额和可用额度。'
  }
  return message || 'MOSS Live 连接失败'
}

// One owner per client plugin instance. The Bot-page lifecycle ends its call;
// mounting or unmounting a view alone does not own the microphone.
export function createMossLiveController({ actions, createSession = options => new MossLiveSession(options), greet = speakMossGreeting } = {}) {
  const source = createSource({ visible: false, active: false, busy: false, sessionState: 'idle', muted: false, level: 0, levelSource: 'mic', transcript: [], screenStream: null, screenBusy: false, screenError: '', startedAt: '', endedAt: '', error: '', memoryError: '', message: '', profileId: '', boundBotId: '', boundProfile: null, recordId: '' })
  const patch = update => source.set(state => ({ ...state, ...update }))
  let session = null, generation = 0, disposed = false, starting = null, stopping = null, greetingAbort = null, greetingActive = false, settingsRequestId = 0
  let recording = null, memoryWrites = Promise.resolve()
  let bindingResolver = async () => null
  const cancelGreeting = () => {
    greetingActive = false
    greetingAbort?.abort()
    try { globalThis.window?.speechSynthesis?.cancel?.() } catch { /* system speech is optional */ }
  }
  const saveMemory = (snapshot, record = recording) => {
    if (!record || !snapshot.profileId || !snapshot.transcript?.length || typeof actions.mossLiveMemorySave !== 'function') return memoryWrites
    const payload = { profileId: snapshot.profileId, recordId: record.id, resume: record.resume, startedAt: snapshot.startedAt, endedAt: snapshot.endedAt, transcript: snapshot.transcript }
    const stamp = JSON.stringify(payload)
    memoryWrites = memoryWrites.then(async () => {
      if (record.saved === stamp) return
      try {
        const saved = await actions.mossLiveMemorySave(payload)
        record.saved = stamp
        const profile = saved?.config?.profiles?.find(item => item.id === payload.profileId)
        if (source.getSnapshot().recordId === record.id) patch({ ...(profile ? { boundProfile: profile } : {}), memoryError: '' })
      } catch {
        if (source.getSnapshot().recordId === record.id) patch({ memoryError: '会话记录保存失败，当前字幕仍保留，请先导出记录后重试。' })
      }
    })
    return memoryWrites
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
      const snapshot = source.getSnapshot()
      // Release live media immediately, even if saving the transcript is slow.
      const results = await Promise.allSettled([current?.stop(), actions.mossLiveStop?.(), saveMemory(snapshot)])
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
  const start = (profileId = '', { resume = true } = {}) => {
    if (disposed) return Promise.resolve(null)
    if (starting) return starting
    if (stopping) return stopping.then(() => start(profileId, { resume }))
    if (source.getSnapshot().active) return Promise.resolve(null)
    const id = ++generation
    patch({ visible: true, active: true, busy: true, sessionState: 'connecting', muted: false, error: '', message: '', screenError: '' })
    starting = (async () => {
      try {
        const previous = session
        session = null
        cancelGreeting()
        await previous?.stop()
        await memoryWrites
        await actions.mossLiveStop?.()
        if (!valid(id)) return null
        const next = await actions.mossLiveStart(profileId ? { profileId, resume } : { resume })
        if (!valid(id)) { await actions.mossLiveStop?.(); return null }
        if (next?.runtime?.error && (!next.runtime.port || !next.runtime.token)) throw new Error(mossLiveErrorMessage(next.runtime.error))
        if (!next?.runtime?.port || !next?.runtime?.token) throw new Error('MOSS Live relay is not ready')
        const activeProfile = next.config?.profiles?.find(profile => profile.id === (profileId || next.config?.selectedProfileId))
        const activeRecording = { id: globalThis.crypto.randomUUID(), resume }
        recording = activeRecording
        patch({ startedAt: new Date().toISOString(), endedAt: '', transcript: [], level: 0, screenStream: null, profileId: activeProfile?.id ?? profileId ?? next.config?.selectedProfileId ?? '', boundBotId: activeProfile?.botId ?? '', boundProfile: activeProfile ?? source.getSnapshot().boundProfile ?? null, recordId: activeRecording.id })
        greetingAbort = new AbortController()
        greetingActive = next.config?.greetingEnabled !== false
        const current = createSession({
          port: next.runtime.port, token: next.runtime.token, config: next.config,
          onState: state => {
            if (session !== current || !valid(id)) return
            const terminal = ['closed', 'error', 'stopped'].includes(state)
            if (terminal) {
              cancelGreeting()
              void saveMemory({ ...source.getSnapshot(), endedAt: new Date().toISOString() }, activeRecording)
            }
            patch({ sessionState: !terminal && greetingActive && source.getSnapshot().sessionState === 'greeting' ? 'greeting' : state, ...(terminal ? { active: false, level: 0, endedAt: new Date().toISOString(), screenStream: null } : {}) })
          },
          onLevel: (level, levelSource = 'mic') => { if (session === current && valid(id)) patch({ level, levelSource }) },
          onTranscript: item => {
            if (session !== current || !valid(id)) return
            source.set(state => ({ ...state, transcript: mergeTranscriptEvent(state.transcript, { ...item, at: new Date().toISOString() }) }))
            if (item.done === true || item.revised === true) void saveMemory(source.getSnapshot(), activeRecording)
          },
          onScreenStream: screenStream => { if (session === current && valid(id)) patch({ screenStream }) },
          onEvent: event => {
            if (session === current && valid(id) && event.type === 'error') patch({ error: event.data?.error?.code === 'invalid_public_request' ? '一条会话指令未被 MOSS 接受。' : mossLiveErrorMessage(event.data?.error?.message ?? 'MOSS Live 返回错误') })
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
        if (valid(id)) patch({ active: false, sessionState: 'error', level: 0, screenStream: null, endedAt: new Date().toISOString(), error: mossLiveErrorMessage(failure) })
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
    requestSettings(botId) {
      if (botId) patch({ settingsRequest: { id: ++settingsRequestId, botId } })
    },
    consumeSettingsRequest(id) {
      if (source.getSnapshot().settingsRequest?.id === id) patch({ settingsRequest: null })
    },
    setBoundProfile(profile) {
      const next = profile && profile.botId ? { ...profile } : null
      const previous = source.getSnapshot()
      const changedBinding = previous.boundBotId !== (next?.botId ?? '')
      patch({
        visible: Boolean(next),
        boundBotId: next?.botId ?? '',
        profileId: next?.id ?? '',
        boundProfile: next,
        ...(changedBinding ? { transcript: [], endedAt: '', error: '', memoryError: '', message: '', startedAt: '', recordId: '' } : {}),
      })
    },
    setBindingResolver(resolver) {
      bindingResolver = typeof resolver === 'function' ? resolver : async () => null
    },
    refreshBinding(force = true) { return bindingResolver(force) },
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

export function bindMossLiveLifecycle(controller, { roster, currentBotId, currentBotSource, resolveBinding, events = globalThis.window }) {
  let released = false
  let token = 0
  let lastCurrent = Symbol('unresolved')
  const currentOf = () => typeof currentBotId === 'function' ? currentBotId() : undefined
  const refreshBinding = async (force = false) => {
    const current = currentOf()
    if (!force && current === lastCurrent) return null
    lastCurrent = current
    const request = ++token
    if (current === undefined || current === null || typeof resolveBinding !== 'function') {
      if (current === undefined || current === null) controller.setBoundProfile?.(null)
      return null
    }
    try {
      const profile = await resolveBinding(current)
      if (released || request !== token || currentOf() !== current) return null
      controller.setBoundProfile?.(profile?.botId === current ? profile : null)
      return profile
    } catch {
      if (!released && request === token && currentOf() === current) controller.setBoundProfile?.(null)
      return null
    }
  }
  controller.setBindingResolver?.(refreshBinding)
  const sync = () => {
    const live = controller.getSnapshot()
    const current = currentOf()
    const leftBoundBot = live.active && live.boundBotId && current !== undefined && current !== live.boundBotId
    if (roster.getSnapshot().pluginsEnabled === false && (live.visible || live.busy)) void controller.stop({ quiet: true, hide: true })
    else if (leftBoundBot) void controller.stop({ quiet: true, hide: true }).then(() => refreshBinding(true))
    else void refreshBinding()
  }
  const off = roster.subscribe(sync)
  const offCurrent = currentBotSource?.subscribe?.(sync)
  const unload = () => { void controller.dispose() }
  events?.addEventListener('pagehide', unload)
  sync()
  return () => { released = true; token++; off(); offCurrent?.(); events?.removeEventListener('pagehide', unload); return controller.dispose() }
}
