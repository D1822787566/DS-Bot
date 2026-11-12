import { LocalVoiceManager } from './src/host/manager.js'
import { createLocalVoiceRuntimeFactory } from './src/host/runtime-client.js'
import { createSettingsStore } from './src/host/settings-store.js'

export const name = 'local-voice'
export const inject = ['connection']

export { DeviceLease } from './src/host/device-lock.js'
export {
  LOCAL_VOICE_DISPLAY_NAME,
  LOCAL_VOICE_PLUGIN_ID,
  defaultLocalVoiceConfig,
  localVoiceView,
  normalizeLocalVoiceConfig,
} from './src/host/config.js'
export { LocalVoiceManager } from './src/host/manager.js'
export { LocalVoiceLoop } from './src/host/voice-loop.js'
export {
  LocalVoiceRuntimeClient,
  createLocalVoiceRuntimeFactory,
  localVoiceEnvironmentRoot,
  localVoiceModelRoot,
  localVoicePythonPath,
} from './src/host/runtime-client.js'

const ok = value => ({ ok: true, value })
const fail = (message, code = 'local-voice/invalid') => ({ ok: false, error: { code, message } })

async function handleRequest(manager, request) {
  let body
  try { body = await request.json() } catch { return fail('Invalid JSON body') }
  try {
    switch (body?.action) {
      case 'view': return ok(manager.view())
      case 'update': return ok(await manager.update(body.config ?? {}))
      case 'start': return ok(await manager.start())
      case 'stop': return ok(await manager.stop())
      case 'transcribe': return ok(await manager.transcribe(Buffer.from(String(body.audio_b64 ?? ''), 'base64'), { sampleRate: body.sampleRate }))
      case 'cancel': return ok(manager.cancel(body.requestId))
      default: return fail('Unknown Local Voice action')
    }
  } catch (error) {
    return fail(error?.message ?? String(error), error?.code ?? 'local-voice/error')
  }
}

export function apply(ctx, config = {}) {
  const settings = config.state ? { state: config.state, save: config.save } : createSettingsStore(config.settingsPath)
  const manager = new LocalVoiceManager({
    state: settings.state,
    save: settings.save,
    deviceConflict: config.deviceConflict,
    runtimeFactory: config.runtimeFactory ?? createLocalVoiceRuntimeFactory(config.runtime ?? {}),
  })
  ctx.provide('localVoice', manager)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => manager.stop(), 'local-voice: stop runtime')
    if (ctx.connection?.fetch?.register) {
      ctx.effect(() => ctx.connection.fetch.register({
        path: '/api/local-voice',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => new Response(JSON.stringify(await handleRequest(manager, request)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      }), 'local-voice: api route')
    }
  }
  return manager
}
