// The lightweight entry DSH loads for the Bot bundle. Importing the host lazily
// keeps the browser half available when a host-only dependency is unavailable.
export { name, inject } from './src/host/entry.js'

export async function apply(ctx, config = {}) {
  const host = await import('./index.js')
  host.apply(ctx, config)
}
