import { readFileSync } from 'node:fs'

export function readPcmWave(input) {
  const data = Buffer.from(input)
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('invalid_wave')
  let offset = 12
  let format = null
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > data.length) throw new Error('invalid_wave')
    if (id === 'fmt ' && size >= 16) format = { audioFormat: data.readUInt16LE(start), channels: data.readUInt16LE(start + 2), rate: data.readUInt32LE(start + 4), bits: data.readUInt16LE(start + 14) }
    if (id === 'data') {
      if (!format || format.audioFormat !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16 || size === 0 || size % 2) throw new Error('invalid_wave')
      return data.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  throw new Error('invalid_wave')
}

export function percentiles(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return { p50: null, p95: null }
  const rank = percentile => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]
  return { p50: rank(0.5), p95: rank(0.95) }
}

if (process.argv[1] && process.argv[1].endsWith('smoke-models.mjs')) {
  const input = process.argv[2]
  if (!input) throw new Error('usage: node smoke-models.mjs <wave>')
  const pcm = readPcmWave(readFileSync(input))
  console.log(JSON.stringify({ bytes: pcm.length }))
}
