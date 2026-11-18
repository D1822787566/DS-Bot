import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><body></body>')
const { document } = dom.window
const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/reading.js'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document, window: dom.window,
  getComputedStyle: node => dom.window.getComputedStyle(node),
  require: name => name === 'react'
    ? { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }), useState: init => [init, () => {}] }
    : { createPortal: node => node },
})
const { fillsBand, headingsIn, outlineOf, pillPlace, readingBand, sectionAt } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
const reply = html => { const root = document.createElement('div'); root.innerHTML = html; return root }

test('reading helpers identify reply sections and scrolling boundaries', () => {
  const root = reply('<h2>Plan</h2><blockquote><h3>Quoted</h3></blockquote><h3>Step one</h3><table><tr><td><h4>Cell</h4></td></tr></table><h3>Step two</h3>')
  assert.deepEqual(plain(headingsIn(root).map(node => node.textContent.trim())), ['Plan', 'Step one', 'Step two'])
  assert.deepEqual(plain(outlineOf(headingsIn(root))), [{ text: 'Plan', depth: 0 }, { text: 'Step one', depth: 1 }, { text: 'Step two', depth: 1 }])
  assert.equal(sectionAt([100, 400], 100), 0)
  assert.equal(sectionAt([100, 400], 99), -1)
  const band = { top: 66, bottom: 700, left: 200, right: 1160 }
  assert.equal(pillPlace({ top: 60, bottom: 2060, height: 2000, left: 240 }, band), null)
  assert.deepEqual(plain(pillPlace({ top: -500, bottom: 1500, height: 2000, left: 240 }, band)), { top: 66, left: 240 })
  assert.equal(fillsBand(414, { top: 68, bottom: 620 }), false)
  assert.equal(fillsBand(420, { top: 68, bottom: 620 }), true)
})

test('reading band accounts for the DS Bot header and DSH composer', () => {
  const scroller = document.createElement('div')
  scroller.style.setProperty('--dsh-composer-height', '140px')
  const head = document.createElement('div')
  head.className = 'bt-head'
  document.body.append(scroller, head)
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 300, right: 1200, height: 800 })
  head.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 300, right: 1200, height: 40 })
  assert.deepEqual(plain(readingBand(scroller)), { top: 58, bottom: 660, left: 300, right: 1200 })
  scroller.remove(); head.remove()
})
