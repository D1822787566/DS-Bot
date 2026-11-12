const text = value => typeof value === 'string' ? value.trim() : ''

async function* segmentsOf(value) {
  const resolved = await value
  if (typeof resolved === 'string') {
    if (text(resolved)) yield { text: text(resolved) }
    return
  }
  if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') {
    for await (const segment of resolved) yield segment
    return
  }
  if (resolved && typeof resolved[Symbol.iterator] === 'function') {
    for (const segment of resolved) yield segment
    return
  }
  if (resolved && typeof resolved.text === 'string') yield resolved
}

export class LocalVoiceLoop {
  constructor({ runtime, ask, play = async stream => { for await (const _chunk of stream) {} } } = {}) {
    if (!runtime || typeof runtime.synthesize !== 'function') throw new Error('Local Voice runtime is required')
    if (typeof ask !== 'function') throw new Error('Local Voice LLM handler is required')
    this.runtime = runtime
    this.ask = ask
    this.play = play
    this.state = 'listening'
    this.generation = 0
    this.active = null
    this.pendingStreams = new Set()
    this.lastTranscript = ''
    this.lastAssistantText = ''
    this.error = ''
  }

  view() {
    return {
      state: this.state,
      generation: this.generation,
      lastTranscript: this.lastTranscript,
      lastAssistantText: this.lastAssistantText,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async submitTranscript(transcript, options = {}) {
    const value = text(transcript)
    if (!value) return this.view()
    const generation = ++this.generation
    const voice = text(options.voice)
    this.lastTranscript = value
    this.lastAssistantText = ''
    this.error = ''
    this.state = 'thinking'
    let playbackTail = Promise.resolve()
    try {
      for await (const segment of segmentsOf(this.ask(value, options, { generation }))) {
        if (generation !== this.generation) return this.view()
        const segmentText = text(typeof segment === 'string' ? segment : segment?.text)
        if (!segmentText) continue
        this.lastAssistantText += `${this.lastAssistantText ? ' ' : ''}${segmentText}`
        const stream = this.runtime.synthesize(segmentText, { voice })
        this.pendingStreams.add(stream)
        const playOne = async () => {
          if (generation !== this.generation) return
          this.active = { generation, stream }
          this.state = 'speaking'
          await this.play(stream, { generation, text: segmentText, voice })
          this.pendingStreams.delete(stream)
          if (this.active?.stream === stream) this.active = null
        }
        playbackTail = playbackTail.then(playOne)
      }
      await playbackTail
      if (generation !== this.generation) return this.view()
      if (generation === this.generation) this.state = 'listening'
      return this.view()
    } catch (error) {
      if (generation !== this.generation) return this.view()
      this.active = null
      this.state = 'error'
      this.error = error?.message || 'local_voice_loop_failed'
      throw error
    } finally {
      if (generation === this.generation) this.active = null
    }
  }

  interrupt() {
    this.generation += 1
    this.active = null
    for (const stream of this.pendingStreams) {
      try { stream.cancel?.() } catch { /* runtime cleanup is best effort */ }
    }
    this.pendingStreams.clear()
    this.state = 'listening'
    this.error = ''
    return this.view()
  }
}
