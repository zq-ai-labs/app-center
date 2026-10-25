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
