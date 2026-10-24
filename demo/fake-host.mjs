// A small stand-in for the DSH host services app-center uses: Cordis-style provide/inject/effect/on,
// the tool registry with its pre-execute gate, the skill registry and connection fetch routes.
// Used by the tests and the demo server; it is not a DSH implementation.

export function createFakeHost({ approve = async () => true, services = {} } = {}) {
  const provided = new Map(Object.entries(services))
  const waiters = []
  const listeners = new Map()
  const disposers = []
  const tools = new Map()
  const skills = new Map()
  const routes = new Map()
  const logs = []

  const base = {
    logger: { info: m => logs.push(['info', m]), warn: m => logs.push(['warn', m]) },
    get: name => provided.get(name),
    provide(name, value) { provided.set(name, value); for (const waiter of [...waiters]) tryInject(waiter) },
    inject(names, callback) { const waiter = { names, callback, done: false }; waiters.push(waiter); tryInject(waiter) },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(listener); return () => {} },
  }
  // Like Cordis, reading a service property that was not declared through inject throws.
  const ctx = new Proxy(base, { get(target, prop, receiver) { if (prop in target || typeof prop === 'symbol') return Reflect.get(target, prop, receiver); throw new Error(`cannot get property "${String(prop)}" without inject`) } })
  function tryInject(waiter) {
    if (waiter.done || !waiter.names.every(name => provided.has(name))) return
    waiter.done = true
    const child = Object.create(ctx)
    for (const name of waiter.names) child[name] = provided.get(name)
    waiter.callback(child)
  }

  provided.set('tools', {
    register(definition) {
      if (!definition.output || typeof definition.output.render !== 'function') throw new TypeError(`tool "${definition.name}" must declare output`)
      tools.set(definition.name, definition)
      return () => { if (tools.get(definition.name) === definition) tools.delete(definition.name) }
    },
    schemas: () => [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
  })
  provided.set('skills', {
    register(skill) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
      skills.set(skill.name, skill)
      return () => { if (skills.get(skill.name) === skill) skills.delete(skill.name) }
    },
  })
  provided.set('connection', { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } })
  provided.set('profileContext', { dir: services.dataRoot ?? undefined })

  /** Run one tool call the way the agent loop does: pre-execute gate, approval, execute, render. */
  async function callTool(name, args, { session = { id: 'session-1' } } = {}) {
    const definition = tools.get(name)
    if (!definition) return { decision: 'unknown', text: `Unknown tool ${name}` }
    const exec = { name, arguments: args, agent: { session: { header: session } }, signal: new AbortController().signal }
    let decision = { kind: 'allow' }
    const chain = listeners.get('tools/pre-execute') ?? []
    const run = async index => index >= chain.length ? { kind: 'allow' } : chain[index](exec, () => run(index + 1))
    decision = await run(0)
    if (decision.kind === 'deny') return { decision: 'deny', text: `Denied: ${decision.reason}` }
    if (decision.kind === 'ask') {
      const ok = await approve(decision.reason, name, args)
      if (!ok) return { decision: 'rejected', reason: decision.reason, text: 'The user rejected this call.' }
    }
    const value = await definition.execute(args, exec)
    const blocks = definition.output.render(args, value)
    return { decision: decision.kind === 'ask' ? 'approved' : 'allow', reason: decision.reason, value, text: blocks.map(block => block.text).join('\n'), card: definition.output.presentationMeta?.(args, value) }
  }

  /** The skill catalog message the host shows the model (names and descriptions only). */
  function skillCatalog() { return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)).map(skill => `- ${skill.name}: ${skill.description}`).join('\n') }

  async function fetchRoute(path, body) {
    const route = routes.get(path)
    if (!route) throw new Error(`no route ${path}`)
    const response = await route.fetch(new Request(`http://local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bkms-app-center': '1' }, body: JSON.stringify(body) }))
    return response.json()
  }

  return { ctx, provided, tools, skills, routes, logs, callTool, skillCatalog, fetchRoute, dispose: () => { while (disposers.length) disposers.pop()() } }
}

/**
 * A plugin center that installs apps by itself, like the real sync engine: shortly after start it installs the listed
 * apps one at a time (download, install, apply), reports progress through status(), and retries on request.
 * Nobody else can install: there is no install() on the service.
 */
export function createFakePluginCenter({ entries, autoInstall = [], failOnce = [], onInstalled, stepMs = 300, startDelayMs = 0 }) {
  const progress = {}
  const notices = []
  const rows = {}
  const failedOnce = new Set()
  let queue = Promise.resolve()
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const row = entry => (rows[entry.packageName] ??= { packageName: entry.packageName, name: entry.name, failures: 0, lastError: '' })
  async function install(entry) {
    const total = entry.artifact?.size ?? 1
    progress[entry.packageName] = { phase: 'queued', received: 0, total }
    await wait(stepMs)
    for (let i = 1; i <= 4; i++) { await wait(stepMs); progress[entry.packageName] = { phase: 'downloading', received: Math.round(total * i / 4), total } }
    if (failOnce.includes(entry.app.id) && !failedOnce.has(entry.app.id)) {
      failedOnce.add(entry.app.id)
      progress[entry.packageName] = { phase: 'failed', received: total, total, error: '下载中断（模拟网络错误）' }
      Object.assign(row(entry), { failures: row(entry).failures + 1, lastError: '下载中断（模拟网络错误）' })
      return
    }
    progress[entry.packageName] = { phase: 'installing', received: total, total }
    await wait(stepMs)
    progress[entry.packageName] = { phase: 'applying', received: total, total }
    await wait(stepMs)
    progress[entry.packageName] = { phase: 'done', received: total, total }
    Object.assign(row(entry), { failures: 0, lastError: '' })
    const mode = entry.artifact?.restart?.mode
    if (mode === 'reload' || mode === 'restart') notices.push({ kind: mode, at: Date.now(), items: [{ packageName: entry.packageName }] })
    else onInstalled?.(entry)
  }
  const enqueue = entry => { queue = queue.then(() => install(entry)).catch(() => {}); return queue }
  for (const entry of entries) if (autoInstall.includes(entry.app.id)) row(entry)
  setTimeout(() => { for (const entry of entries) if (autoInstall.includes(entry.app.id)) void enqueue(entry) }, startDelayMs)
  return {
    version: 1,
    async catalog() { return { center: 'demo://plugin-center/plugins.json', plugins: entries } },
    status() { return { available: true, progress, notices, plugins: Object.values(rows) } },
    retry(packageName) {
      const entry = entries.find(item => item.packageName === packageName)
      if (!entry) throw new Error('没有这个插件')
      Object.assign(row(entry), { failures: 0, lastError: '' })
      delete progress[packageName]
      void enqueue(entry)
      return { available: true }
    },
  }
}
