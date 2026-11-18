import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { annotatedMessage, annotationKey, insertAnnotation, quoteMarkdown } from './src/client/text-annotation.js'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout,
  window: { matchMedia: () => ({ matches: true }) },
  require: name => name === 'react' ? { createElement() {}, useEffect() {}, useRef: current => ({ current }), useState: value => [value, () => {}] } : {},
})
const { annotationKey, annotatedMessage, insertAnnotation, quoteMarkdown } = module.exports

test('annotation formatting keeps multiline quotes and optional notes', () => {
  assert.equal(quoteMarkdown('First\r\nSecond\rThird'), '> First\n> Second\n> Third')
  assert.equal(annotatedMessage('First\nSecond', '  Explain this.\nWith two lines.  '), '> First\n> Second\n> \n> Explain this.\n> With two lines.')
  assert.equal(annotatedMessage('A quote', ' \n '), '> A quote')
})

test('annotation keyboard and composer insertion actions are explicit', () => {
  assert.equal(annotationKey({ key: 'Enter' }), 'add')
  assert.equal(annotationKey({ key: 'Enter', ctrlKey: true }), 'send')
  assert.equal(annotationKey({ key: 'Enter', shiftKey: true }), null)
  assert.equal(annotationKey({ key: 'Enter', isComposing: true }), null)
  const inserted = []
  const input = { insertQuote: text => { inserted.push(text); return true } }
  assert.equal(insertAnnotation(input, 'A quote', ' Note'), true)
  assert.deepEqual(inserted, ['A quote\n\nNote'])
})
