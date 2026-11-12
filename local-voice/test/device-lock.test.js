import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DeviceLease } from '../src/host/device-lock.js'

test('device lease allows one owner and releases it explicitly', () => {
  const lease = new DeviceLease()
  assert.equal(lease.acquire('local-voice'), true)
  assert.equal(lease.owner(), 'local-voice')
  assert.throws(() => lease.acquire('phone-agent'), /device is busy/)
  assert.equal(lease.release('phone-agent'), false)
  assert.equal(lease.release('local-voice'), true)
  assert.equal(lease.acquire('phone-agent'), true)
})

test('device lease is idempotent for the current owner', () => {
  const lease = new DeviceLease()
  assert.equal(lease.acquire('local-voice'), true)
  assert.equal(lease.acquire('local-voice'), true)
  assert.equal(lease.release('local-voice'), true)
  assert.equal(lease.owner(), null)
})
