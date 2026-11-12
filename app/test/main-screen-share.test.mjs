import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { answerCard, handOff, startApp, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()
after(() => { app.quit() })
before(async () => {
  await startApp()
  await waitFor(() => window() !== undefined, 'create the team window')
  hostState.release()
  await handOff()
})

const request = (changes = {}) => ({
  frame: window().webContents.mainFrame,
  securityOrigin: new URL(window().url).origin,
  videoRequested: true, audioRequested: false, userGesture: true,
  ...changes,
})

function share(input = request()) {
  const handler = window().webContents.session.displayMediaRequestHandler
  assert.equal(typeof handler, 'function', 'the Desktop must handle getDisplayMedia requests')
  return new Promise(resolve => { handler(input, resolve) })
}

test('Desktop lets the user choose a screen and grants only that video source', async () => {
  const first = { id: 'screen:1:0', name: 'Screen 1' }
  const second = { id: 'screen:2:0', name: 'Screen 2' }
  state.displaySources = [first, second]
  const before = windowCards().length
  let granted = false
  const result = share().then(value => { granted = true; return value })
  await waitFor(() => windowCards().length > before, 'show the screen chooser')
  const card = windowCards().at(-1)
  assert.match(card.message, /screen|屏幕/i)
  assert.ok(card.buttons.some(button => button.label.includes('Screen 1')))
  assert.ok(card.buttons.some(button => button.label.includes('Screen 2')))
  assert.equal(granted, false, 'no screen is granted before the user chooses')
  answerCard(2)
  assert.deepEqual(await result, { video: second })
  assert.deepEqual(state.displaySourceOptions.at(-1), { types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
})

test('cancelling the screen chooser grants no media', async () => {
  const before = windowCards().length
  const result = share()
  await waitFor(() => windowCards().length > before, 'show the screen chooser again')
  answerCard(0)
  assert.deepEqual(await result, {})
})

test('Electron origins with a trailing slash can open the screen chooser', async () => {
  const before = windowCards().length
  const result = share(request({ securityOrigin: `${new URL(window().url).origin}/` }))
  await new Promise(resolve => { setImmediate(resolve) })
  assert.ok(windowCards().length > before, 'Electron serializes securityOrigin as a URL with a trailing slash')
  answerCard(0)
  assert.deepEqual(await result, {})
})

test('older Electron requests without an audioRequested flag can still choose a screen', async () => {
  const { audioRequested, ...withoutAudio } = request()
  const before = windowCards().length
  const result = share(withoutAudio)
  await waitFor(() => windowCards().length > before, 'show the screen chooser without the audio flag')
  answerCard(0)
  assert.deepEqual(await result, {})
})

test('subframes, foreign pages, background requests and system audio never get a screen', async () => {
  const before = state.displaySourceOptions?.length ?? 0
  for (const changes of [
    { frame: { url: window().url } }, { frame: null },
    { securityOrigin: 'https://example.com' }, { userGesture: false },
    { videoRequested: false }, { audioRequested: true },
  ]) assert.deepEqual(await share(request(changes)), {})
  assert.equal(state.displaySourceOptions?.length ?? 0, before)
})

test('a screen picker whose page navigates away grants no media', async () => {
  const before = windowCards().length
  const result = share()
  await waitFor(() => windowCards().length > before, 'show a screen chooser before navigation')
  window().webContents.emit('did-start-loading')
  assert.deepEqual(await result, {})
})

test('a failed or empty screen enumeration grants no media', async () => {
  state.displaySources = []
  assert.deepEqual(await share(), {})
  state.displaySources = () => { throw new Error('capture is unavailable') }
  assert.deepEqual(await share(), {})
})
