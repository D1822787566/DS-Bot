// Current-profile plugin operations. Inspection never imports a downloaded plugin.
import { createHash } from 'node:crypto'

const CORE = new Set(['ds-bot', 'dshmarket', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle', '@deepseek-ai/dsh-experimental-plugin-market-bundle'])
const MARKET_INDEX = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'

export function install(rt) {
  const { ctx, state } = rt
  const desktop = process.env.DS_BOT_APP === '1' || ctx.get?.('profileContext')?.name === 'desktop'
  const manager = () => ctx.get?.('pluginManager')
  const registry = () => ctx.get?.('agentPresets')
  const requireDesktop = () => {
    if (!desktop) throw new Error('Plugin management is available in the DS Bot desktop app only')
    if (!manager()) throw new Error('The DSH plugin manager is unavailable')
    const refusal = rt.readOnly()
    if (refusal) throw new Error(refusal)
  }
  const affected = () => Object.values(state.bots).filter(bot => bot.agentPreset && bot.agentPreset !== 'standard')
    .map(bot => ({ id: bot.id, name: bot.name, agentPreset: bot.agentPreset }))

  async function checkBotPreset(id) {
    const presets = registry()
    const preset = (await presets?.list?.() ?? []).find(item => item.id === id)
    const bundles = await manager()?.listBundles?.() ?? []
    const composition = (await presets?.compositionInventory?.() ?? []).find(item => item.id === id)
    const fingerprint = createHash('sha256').update(JSON.stringify({ preset, composition,
      bundles: bundles.map(bundle => [bundle.name, bundle.version, bundle.enabled, bundle.error?.code]), rules: 1 })).digest('hex')
    const result = { id, name: preset?.name ?? id, fingerprint, checkedAt: Date.now(), bindable: false, group: null,
      status: 'unverified', reason: 'Loading can be checked; third-party workflow and interface behavior require verification.' }
    if (!preset || preset.broken || composition?.broken) return { ...result, status: 'incompatible', reason: preset?.broken ?? composition?.broken ?? 'The preset is unavailable.' }
    // Standard is the verified DS Bot baseline. Its workflow helpers also use the
    // PTC runtime; their presence does not replace standard's direct team tools.
    if (id === 'standard') return { ...result, status: 'ready', bindable: true, group: true, reason: 'DS Bot uses the standard preset for direct team tools.' }
    // PTC hides direct tools behind run_code. Do not claim DS Bot's scoped tools work there.
    if (composition?.rows.some(row => row.enabled !== false && /dsh-workflow-ptc|dsh-ptc-runtime/.test(row.moduleName))) {
      return { ...result, status: 'incompatible', reason: 'This preset uses programmatic tool calling. DS Bot requires direct team tools.' }
    }
    return result
  }

  async function selectBotPreset(id, acceptedFingerprint) {
    if (!desktop) throw new Error('Custom Bot presets require the DS Bot desktop app')
    if (typeof id !== 'string' || !id.trim() || id.length > 160) throw new Error('Invalid Bot preset')
    const report = await checkBotPreset(id)
    if (report.status === 'incompatible') throw new Error(report.reason)
    if (!report.bindable && acceptedFingerprint !== report.fingerprint) throw new Error('Review and confirm the unverified preset before creating this Bot')
    return report
  }

  let provisioning
  async function provisionMarket(market) {
    await rt.load()
    if (state.prefs.marketDefaultsApplied === true) return
    if (market.listIndexes().length === 0) await market.setIndexes([MARKET_INDEX])
    state.prefs.marketDefaultsApplied = true
    await rt.save()
  }

  async function pluginCatalog() {
    if (!desktop) return { available: false, bundles: [], presets: [], indexes: [], affected: [] }
    const bundles = await manager()?.listBundles?.() ?? []
    const presets = await registry()?.list?.() ?? []
    const marketName = 'dshmarket'
    const market = ctx.get?.('pluginMarket')
    const marketEnabled = bundles.some(bundle => bundle.name === marketName && bundle.enabled === true && !bundle.error)
    if (marketEnabled && market && !rt.readOnly()) {
      provisioning ??= provisionMarket(market).finally(() => { provisioning = undefined })
      await provisioning
    }
    return { available: Boolean(manager()), bundles: bundles.map(bundle => ({ ...bundle, builtIn: CORE.has(bundle.name) })),
      market: { name: marketName, enabled: marketEnabled },
      presets, indexes: market?.listIndexes?.() ?? [], affected: affected() }
  }

  async function pluginSearch({ url, text = '', offset = 0, refresh = false }) {
    requireDesktop()
    const market = ctx.get?.('pluginMarket')
    if (!market) throw new Error('No plugin market is available. Add a plugin by package name instead.')
    return market.search(String(url), { text: String(text).slice(0, 200), offset, limit: 30, refresh: refresh === true, sort: { kind: 'relevance' } })
  }

  async function pluginChange({ action, spec, name, enabled, indexes, registry: installRegistry }) {
    requireDesktop()
    const service = manager()
    if ((action === 'remove' || action === 'enable') && CORE.has(name)) throw new Error('This bundle is built in to DS Bot and cannot be changed here')
    const options = installRegistry === undefined ? {} : { registry: installRegistry }
    if (action === 'inspect') return service.inspect(String(spec ?? ''), options)
    if (action === 'install') {
      const inspected = await service.inspect(String(spec ?? ''), options)
      if (inspected.status !== 'accepted') throw new Error(inspected.reason ?? 'The plugin cannot be installed')
      return service.installBundle(String(spec), inspected.registry !== undefined ? { registry: inspected.registry } : {})
    }
    if (action === 'remove') return service.removeBundle(String(name ?? ''))
    if (action === 'enable') return service.setBundleEnabled(String(name ?? ''), enabled === true)
    if (action === 'indexes') {
      if (!Array.isArray(indexes) || indexes.some(url => typeof url !== 'string')) throw new Error('Invalid plugin sources')
      const market = ctx.get?.('pluginMarket')
      if (!market) throw new Error('Plugin market is unavailable')
      await market.setIndexes(indexes)
      state.prefs.marketDefaultsApplied = true
      await rt.save()
      return { application: 'applied' }
    }
    throw new Error('Unknown plugin operation')
  }

  async function ensureBotPreset(bot) {
    if (!desktop || !bot?.agentPreset) return
    const report = await checkBotPreset(bot.agentPreset)
    if (report.status === 'incompatible') throw new Error(`Bot preset unavailable: ${report.reason} Restore the plugin or explicitly use standard in Plugins.`)
    if (bot.presetFingerprint && bot.presetFingerprint !== report.fingerprint && !report.bindable) {
      throw new Error('The Bot preset changed. Review it in Plugins before continuing.')
    }
  }

  async function confirmBotPreset(botId, fingerprint) {
    requireDesktop()
    const bot = rt.botOf(botId)
    if (!bot?.agentPreset) throw new Error('This Bot has no custom preset')
    const report = await selectBotPreset(bot.agentPreset, fingerprint)
    bot.presetFingerprint = report.fingerprint
    await rt.save()
    return report
  }

  const recovering = new Set()
  async function recoverBotPreset(botId) {
    requireDesktop()
    if (recovering.has(botId)) throw new Error('This Bot is already being recovered')
    const bot = rt.botOf(botId)
    if (!bot?.agentPreset || bot.agentPreset === 'standard') throw new Error('This Bot does not need preset recovery')
    recovering.add(botId)
    try {
      const current = rt.chatOf(bot.id)
      const report = await checkBotPreset(bot.agentPreset)
      if (report.status !== 'incompatible') throw new Error('Restore standard only when the selected preset is unavailable or incompatible')
      const ids = [current, ...Object.values(state.rooms).map(room => room.sessions?.[bot.id]).filter(Boolean)]
      const work = rt.workView?.() ?? {}
      if (ids.some(id => rt.live?.get?.(id)?.turn !== undefined) || work[botId] !== undefined
        || [...(rt.switchJobs?.() ?? [])].some(job => job.botId === botId)) throw new Error('Stop this Bot before recovering its preset')
      const fresh = await rt.createSession(bot.name, { dir: bot.workDir, agentPreset: 'standard' })
      if (rt.botOf(botId) !== bot) throw new Error('The Bot was removed during recovery')
      const endedAt = Date.now()
      ;(bot.segments ??= []).push({ sessionId: current, endedAt, note: 'The previous preset became unavailable. The user explicitly restored standard. Read earlier chat with read_own_chat when needed.' })
      bot.sessionId = fresh
      bot.previousPreset = bot.agentPreset
      bot.agentPreset = 'standard'
      delete bot.presetFingerprint
      for (const field of ['questions', 'views']) {
        if (state[field]?.[current] === undefined) continue
        const { callId: _callId, ...pending } = state[field][current]
        state[field][fresh] = pending
        delete state[field][current]
      }
      for (const room of Object.values(state.rooms)) {
        const id = room.sessions?.[bot.id]
        if (!id) continue
        room.segments ??= {}
        ;(room.segments[bot.id] ??= []).push({ sessionId: id, endedAt })
        delete room.sessions[bot.id]
      }
      await rt.save()
      await rt.applyPermission?.(bot, fresh)
      return bot
    } finally { recovering.delete(botId) }
  }

  Object.assign(rt, { pluginsEnabled: desktop, pluginCatalog, pluginSearch, pluginChange, checkBotPreset, selectBotPreset, ensureBotPreset, confirmBotPreset, recoverBotPreset })
  // Check retained sessions too: unloading a declaration can leave its old revision alive.
  if (desktop) ctx.on('system-prompt/assemble', async function checkSelectedBotPreset(_assembly, context, next) {
    await ensureBotPreset(rt.botOf(rt.selfOf(context.agent?.id)))
    return next()
  })
}
