// Demo server: mounts the real @bkms/app-center (lib/) into a stand-in DSH host with demo apps and a demo
// plugin center, serves the real app center page, and exposes the tool pipeline to a scripted conversation.
//   node demo/server.mjs [port]
import { createServer } from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { createFakeHost, createFakePluginCenter } from './fake-host.mjs'
import { demoCatalog, registerBid, registerContract, registerMail } from './apps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] || process.env.PORT || 4317)
const dataDir = join(here, 'data')

let state
async function boot() {
  state?.host.dispose()
  await rm(dataDir, { recursive: true, force: true })
  let contract
  const pending = { approval: undefined }
  const holder = {}
  const pluginCenter = createFakePluginCenter({
    entries: demoCatalog, stepMs: 450,
    onInstalled: entry => { if (entry.app.id === 'contract') contract = registerContract(holder.appCenter) },
  })
  const host = createFakeHost({
    services: { bkmsPluginCenter: pluginCenter },
    // The demo page answers approval requests: a call without a decision stops and reports what it would ask.
    approve: async reason => { if (pending.approval === undefined) { pending.asked = reason; return false } return pending.approval },
  })
  apply(host.ctx, { dataDir })
  holder.appCenter = host.provided.get('appCenter')
  registerMail(holder.appCenter, { contract: () => contract })
  registerBid(holder.appCenter)
  state = { host, pending }
}
await boot()

const send = (res, status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
const readBody = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8') }

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, await readFile(join(here, 'index.html')), 'text/html; charset=utf-8')
    if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, await readFile(join(here, 'public', 'app.js')), 'text/javascript; charset=utf-8')
    if (url.pathname === '/api/bkms-app-center') {
      const route = state.host.routes.get('/api/bkms-app-center')
      const body = await readBody(req)
      const response = await route.fetch(new Request('http://local/api/bkms-app-center', { method: req.method, headers: req.headers, body: req.method === 'POST' ? body : undefined }))
      return send(res, response.status, await response.text())
    }
    if (req.method === 'GET' && url.pathname === '/demo/context') {
      // What the model has in context before any call: the skill catalog and the tool list.
      return send(res, 200, { catalog: state.host.skillCatalog(), tools: [...state.host.tools.values()].map(tool => ({ name: tool.name, description: tool.description })), skills: Object.fromEntries([...state.host.skills.values()].map(skill => [skill.name, skill.content])) })
    }
    if (req.method === 'POST' && url.pathname === '/demo/call') {
      const { tool, args, session, approve } = JSON.parse(await readBody(req) || '{}')
      state.pending.approval = approve; state.pending.asked = undefined
      const result = await state.host.callTool(tool, args, { session: session ?? { id: 'demo-session' } })
      if (result.decision === 'rejected' && approve === undefined) return send(res, 200, { decision: 'needs-approval', reason: state.pending.asked })
      return send(res, 200, result)
    }
    if (req.method === 'POST' && url.pathname === '/demo/reset') { await boot(); return send(res, 200, { ok: true }) }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}).listen(port, '127.0.0.1', () => console.log(`App center demo: http://127.0.0.1:${port}/`))
