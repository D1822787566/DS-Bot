import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const primitives = fileURLToPath(new URL('./ui/src/primitives.js', import.meta.url))

// The plugin's Bot views take DSH's interface primitives from one module; the window does
// not load DSH's interface, so its own module stands in for that one.
const ownPrimitives = {
  name: 'ds-bot-primitives',
  enforce: 'pre',
  resolveId(source, importer) {
    return source === './dsh-primitives.js' && importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/') ? primitives : null
  },
}

// The window loads the build from the app's own scheme, so asset paths stay relative.
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  base: './',
  plugins: [ownPrimitives],
  // Shared views live outside app/, so resolve their UI peers from this app's dependencies.
  resolve: { dedupe: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] },
  // One bundle: the window loads it from disk, not over a network.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2048 },
})
