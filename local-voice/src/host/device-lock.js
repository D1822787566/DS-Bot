export class DeviceLease {
  constructor() {
    this.current = null
  }

  owner() {
    return this.current
  }

  acquire(owner) {
    if (typeof owner !== 'string' || !owner.trim()) throw new Error('device owner is required')
    const value = owner.trim()
    if (this.current !== null && this.current !== value) throw new Error('audio device is busy')
    this.current = value
    return true
  }

  release(owner) {
    if (this.current !== owner) return false
    this.current = null
    return true
  }
}
