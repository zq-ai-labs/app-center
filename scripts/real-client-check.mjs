// Load the real client bundles of the apps and the app center into a real Cordis context (from an installed XBuddy,
// Electron as Node) and check the left-menu rule: an app keeps its own entry only while no app center hosts it.
//   ELECTRON_RUN_AS_NODE=1 XBuddy.exe scripts/real-client-check.mjs <app.asar>/dsh/node_modules <bundle>...
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const [base, ...bundles] = process.argv.slice(2)
const { Context } = await import(pathToFileURL(join(base, '@deepseek-ai/cordis', 'lib', 'index.js')).href)
const requireLocal = createRequire(new URL('../package.json', import.meta.url))

// Browser globals the bundles touch while registering (no rendering happens here).
const factories = new Map()
globalThis.window = globalThis
globalThis.__ModuleLoader__ = { load: ({ id, factory }) => { factories.set(id, factory) } }
globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} }
const anything = new Proxy(function () {}, { get: (_, key) => key === Symbol.toPrimitive ? () => '' : anything, apply: () => anything, construct: () => anything })
const hostRequire = name => name === 'react' || name.startsWith('react/') ? requireLocal(name) : anything
for (const file of bundles) vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
const plugin = id => factories.get(id)(hostRequire)

function host() {
  const ctx = new Context()
  const entries = new Map() // slot name -> Set of keys
  const add = (name, key) => { if (!entries.has(name)) entries.set(name, new Set()); entries.get(name).add(key); return () => entries.get(name)?.delete(key) }
  ctx.provide('slots', {
    inject: (name, callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    register: (options) => add(options.name, options.key ?? options.id),
  })
  ctx.provide('locale', { register: () => () => {}, bind: () => key => String(key), subscribe: () => () => {}, getSnapshot: () => 'zh-CN', current: 'zh-CN' })
  ctx.provide('layout', { selectPanel: () => {} })
  const sidebar = () => [...(entries.get('sidebar.panellist') ?? [])].sort()
  const main = () => [...(entries.get('main') ?? [])].sort()
  return { ctx, sidebar, main }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50))
const report = (label, value) => console.log(`${label}:`, JSON.stringify(value))
const apps = ['bkms-workbench', 'xbuddy-bid-writer'].filter(id => factories.has(id))
report('bundles', [...factories.keys()])

// 1. Apps without the app center: each keeps its own entry.
let h = host()
const fibers = apps.map(id => [id, h.ctx.plugin(plugin(id))])
await settle()
for (const [id, f] of fibers) if (f.state !== 2) { try { await f } catch (error) { report(id + ' failed to start', String(error?.stack ?? error).split('\n').slice(0, 4).join(' | ')) } }
report('without app center: sidebar', h.sidebar())
// 2. The app center arrives: app entries leave, the app center entry appears, the app pages stay.
const fiber = h.ctx.plugin(plugin('@bkms/app-center'))
await settle()
report('app center loaded: sidebar', h.sidebar())
report('app center loaded: main pages', h.main())
// 3. The app center goes away: app entries come back.
await fiber.dispose()
await settle()
report('app center unloaded: sidebar', h.sidebar())
// (The stand-in slots service does not tie registrations to plugin lifetime, so the app center's own entry lingers
// after step 3 here; the real slots service removes it with the plugin.)
// 4. App center first, apps afterwards: app entries never appear.
h = host()
h.ctx.plugin(plugin('@bkms/app-center'))
await settle()
for (const id of apps) h.ctx.plugin(plugin(id))
await settle()
report('app center first: sidebar', h.sidebar())
process.exit(0)
