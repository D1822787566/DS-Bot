import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readPcmWave, percentiles } from '../scripts/smoke-models.mjs'

test('speech smoke reads the WAVE data chunk after metadata instead of a fixed offset', () => {
  const header = Buffer.alloc(12)
  header.write('RIFF'); header.write('WAVE', 8)
  const fmt = Buffer.alloc(24)
  fmt.write('fmt '); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16)
  fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22)
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 255, 0])
  const data = Buffer.from([100, 97, 116, 97, 4, 0, 0, 0, 1, 0, 2, 0])
  const wav = Buffer.concat([header, fmt, junk, data])
  wav.writeUInt32LE(wav.length - 8, 4)
  assert.deepEqual(readPcmWave(wav), Buffer.from([1, 0, 2, 0]))
  assert.throws(() => readPcmWave(wav.subarray(0, -1)), /invalid_wave/)
})

test('latency reports P50 and P95 using the nearest rank from measured samples', () => {
  assert.deepEqual(percentiles([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), { p50: 5, p95: 10 })
})
