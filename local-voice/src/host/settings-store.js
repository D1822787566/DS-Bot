import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { localVoiceEnvironmentRoot } from './runtime-client.js'
import { normalizeLocalVoiceConfig } from './config.js'

export function createSettingsStore(path = join(dirname(localVoiceEnvironmentRoot()), 'local-voice', 'settings.json')) {
  let config = {}
  try { config = JSON.parse(readFileSync(path, 'utf8')).config ?? {} } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const state = { prefs: { localVoice: normalizeLocalVoiceConfig(config) } }
  const save = async () => {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ config: normalizeLocalVoiceConfig(state.prefs.localVoice) }, null, 2) + '\n', { flag: 'wx' })
    renameSync(temporary, path)
  }
  return { state, save }
}
