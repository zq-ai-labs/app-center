// Load @bkms/app-center into a real Cordis context with the real DSH tool and skill registries taken from an
// installed XBuddy (Electron as Node). Checks registration, the pre-execute gate and output validation.
//   ELECTRON_RUN_AS_NODE=1 XBuddy.exe scripts/real-dsh-check.mjs <path-to>/app.asar/dsh/node_modules [extracted package dir]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const report = (label, value) => console.log(`${label}:`, typeof value === 'string' ? value : JSON.stringify(value))
const base = process.argv[2]
const load = name => import(pathToFileURL(join(base, name, 'lib', 'index.js')).href)
const { Context } = await load('@deepseek-ai/cordis')
const tools = await load('@deepseek-ai/dsh-tools')
const skills = await load('@deepseek-ai/dsh-skill')
const systemPrompt = await load('@deepseek-ai/dsh-system-prompt')
const packageDir = process.argv[3]
const appCenter = await import(packageDir ? pathToFileURL(join(packageDir, 'lib', 'index.js')).href : new URL('../lib/index.js', import.meta.url).href)
report('loaded from', packageDir ?? 'checkout')
report('Config schema', typeof appCenter.Config === 'function' ? JSON.stringify(appCenter.Config({})) : 'missing')
const apps = await import(new URL('../demo/apps.mjs', import.meta.url).href)

const ctx = new Context()
ctx.plugin(systemPrompt.default ?? systemPrompt)
const toolsFiber = ctx.plugin(tools.default ?? tools)
const skillsFiber = ctx.plugin(skills.default ?? skills)
const toolsPlugin = tools.default ?? tools, skillsPlugin = skills.default ?? skills
report('dsh-tools inject', JSON.stringify(toolsPlugin.inject ?? null))
report('dsh-skill inject', JSON.stringify(skillsPlugin.inject ?? null))
const fiber = ctx.plugin(appCenter, { dataDir: mkdtempSync(join(tmpdir(), 'ac-real-')) })
await new Promise(r => setTimeout(r, 300))
report('app-center fiber state', String(fiber?.state))
report('tools/skills fiber state', toolsFiber?.state + '/' + skillsFiber?.state)
for (const f of [toolsFiber, skillsFiber]) if (f?.state === 3) { try { await f } catch (e) { report('failed', e?.message) } }
if (fiber?.state !== 2) { try { await fiber } catch (error) { report('app-center failed', error?.stack ?? String(error)) } }
report('appCenter (non-strict)', !!ctx.get('appCenter', false))

const service = ctx.get('appCenter')
report('appCenter provided', !!service)
apps.registerMail(service, {})
apps.registerBid(service)
await new Promise(r => setTimeout(r, 100))

report('tool schemas', ctx.get('tools').schemas().map(s => s.name).filter(n => /app_call|task_status|mail_search/.test(n)))
const listed = await ctx.get('skills').list()
report('skills', listed.filter(s => s.name.startsWith('app-')).map(s => `${s.name}: ${s.description}`))
const guide = await ctx.get('skills').get('app-bid')
report('skill app-bid body starts', guide?.content?.split('\n')[0])

const run = async (name, args, header = { id: 's1' }) => {
  const result = await ctx.get('tools').execute({ callId: `c-${Math.random().toString(36).slice(2)}`, name, arguments: args, agent: { session: { header } }, signal: new AbortController().signal })
  return { isError: result.isError, text: (result.content ?? []).map(b => b.text).join('\n').split('\n')[0], meta: result.meta?.kind ?? null }
}
report('mail_search', await run('mail_search', { query: 'TH-100' }))
report('app_call bid.check', await run('app_call', { app: 'bid', action: 'check', args: { project: '政务云' } }))
report('app_call invalid args', await run('app_call', { app: 'bid', action: 'get', args: {} }))
report('subagent draft (expect denied)', await run('app_call', { app: 'mail', action: 'draft_reply', args: { item: 103 } }, { id: 's2', origin: 'subagent' }))
report('install from chat (expect refused: installs belong to the plugin center)', await run('app_call', { app: 'contract', action: 'install' }))
process.exit(0)
