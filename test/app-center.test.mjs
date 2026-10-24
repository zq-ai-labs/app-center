import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, AppCenter, validateManifest, appSkill } from '../lib/index.js'
import { validate } from '../lib/core/schema.js'
import { decideRisk } from '../lib/core/risk.js'
import { summarizeArgs } from '../lib/core/store.js'
import { renderOutcome } from '../lib/tools.js'
import { createFakeHost, createFakePluginCenter } from '../demo/fake-host.mjs'
import { bidManifest, demoCatalog, mailManifest, registerBid, registerContract, registerMail } from '../demo/apps.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'app-center-'))
const handlersFor = manifest => Object.fromEntries(manifest.actions.map(action => [action.name, async () => ({ summary: 'ok' })]))
const user = { tenantId: 't1', userId: 'u1' }
const exec = (extra = {}) => ({ user, subagent: false, confirmed: false, origin: 'chat', signal: new AbortController().signal, ...extra })

test('manifest rules: sending actions, long summaries, too many custom actions and missing handlers are refused', () => {
  const ok = structuredClone(mailManifest)
  assert.equal(validateManifest(ok, handlersFor(ok)), ok)
  const send = structuredClone(mailManifest); send.actions.push({ ...send.actions[0], name: 'send_reply' })
  assert.throws(() => validateManifest(send, handlersFor(send)), /对外发送/)
  const long = { ...structuredClone(mailManifest), summary: '这是一个非常非常长的一句话描述，用来测试四十个字的上限是不是会生效，超过了就应该登记失败吧' }
  assert.throws(() => validateManifest(long, handlersFor(long)), /40/)
  const many = structuredClone(bidManifest)
  for (const name of ['extra_a', 'extra_b', 'extra_c']) many.actions.push({ ...many.actions[1], name, aliases: [] })
  assert.throws(() => validateManifest(many, handlersFor(many)), /专有动作最多 3 个/)
  assert.throws(() => validateManifest(structuredClone(mailManifest), {}), /没有处理函数/)
  const reserved = structuredClone(mailManifest); reserved.actions[0].name = 'install'
  assert.throws(() => validateManifest(reserved, handlersFor(reserved)), /保留名/)
})

test('parameter validation explains what is wrong', () => {
  const schema = mailManifest.actions[0].params
  assert.deepEqual(validate(schema, { query: 'TH-100' }), [])
  assert.match(validate(schema, {}).join(), /缺少必填参数 query/)
  assert.match(validate(schema, { query: 'x', limit: 99 }).join(), /不能大于 20/)
  assert.match(validate(schema, { query: 'x', foo: 1 }).join(), /不认识的参数 foo/)
  assert.match(validate(schema, { query: 3 }).join(), /应为 字符串/)
})

test('risk gate: read runs, draft runs unless configured, write asks, delegated agents only read', () => {
  const base = { subagent: false, confirmDrafts: false, prompt: 'p' }
  assert.deepEqual(decideRisk({ ...base, risk: 'read' }), { kind: 'allow' })
  assert.deepEqual(decideRisk({ ...base, risk: 'draft' }), { kind: 'allow' })
  assert.equal(decideRisk({ ...base, risk: 'draft', confirmDrafts: true }).kind, 'ask')
  assert.equal(decideRisk({ ...base, risk: 'write' }).kind, 'ask')
  assert.equal(decideRisk({ ...base, risk: 'install' }).kind, 'ask')
  assert.equal(decideRisk({ ...base, risk: 'draft', subagent: true }).kind, 'deny')
  assert.deepEqual(decideRisk({ ...base, risk: 'read', subagent: true }), { kind: 'allow' })
})

test('calls: aliases resolve, invalid arguments come back with usage and an example, failures never throw', async () => {
  const center = new AppCenter({ dataDir: tmp(), pluginCenter: () => undefined })
  registerBid(center.service())
  const renamed = await center.call('bid', 'progress', { project: 'bid-7' }, exec())
  assert.equal(renamed.ok, true); assert.equal(renamed.action, 'status'); assert.equal(renamed.renamedFrom, 'progress')
  const invalid = await center.call('bid', 'get', {}, exec())
  assert.equal(invalid.ok, false); assert.equal(invalid.code, 'invalid_args')
  assert.match(renderOutcome(invalid), /缺少必填参数 project[\s\S]*示例：app_call/)
  const failed = await center.call('bid', 'get', { project: '不存在' }, exec())
  assert.equal(failed.code, 'failed')
  assert.equal((await center.call('nope', 'list', {}, exec())).code, 'unknown_app')
  assert.equal((await center.call('bid', 'delete', {}, exec())).code, 'unknown_action')
  const delegated = await center.call('bid', 'start', { file: 'a.pdf' }, exec({ subagent: true }))
  assert.equal(delegated.code, 'denied')
})

test('skills: the guide lists actions, parameters, rules; the description is the one-line summary', () => {
  const skill = appSkill(mailManifest)
  assert.equal(skill.name, 'app-mail')
  assert.equal(skill.description, mailManifest.summary)
  assert.match(skill.content, /### draft_reply[\s\S]*生成草稿，不会发送/)
  assert.match(skill.content, /外部内容/)
  assert.match(skill.content, /app_call\(\{ app: "mail", action: "search", args: \{"query":"TH-100"\} \}\)/)
})

test('activity log hides bodies and contact details', () => {
  const text = summarizeArgs({ query: 'wang@qiming-demo.cn 13800138000', body: '正文' })
  assert.doesNotMatch(text, /wang@|13800138000|正文/)
})

test('plugin in a host: tools, skills, risk gate, install from the catalog and the page API', async () => {
  const approvals = []
  let host
  const pluginCenter = createFakePluginCenter({ entries: demoCatalog, stepMs: 5, onInstalled: entry => { if (entry.app.id === 'contract') registerContract(host.provided.get('appCenter')) } })
  host = createFakeHost({ approve: async reason => { approvals.push(reason); return true }, services: { bkmsPluginCenter: pluginCenter } })
  apply(host.ctx, { dataDir: tmp() })
  const appCenter = host.provided.get('appCenter')
  registerMail(appCenter, { contract: () => undefined })
  registerBid(appCenter)
  await new Promise(r => setTimeout(r, 20))

  // Two general tools plus the resident mail search; one skill per app, installable ones marked.
  assert.deepEqual([...host.tools.keys()].sort(), ['app_call', 'mail_search', 'task_status'])
  assert.match(host.skillCatalog(), /app-contract: 合同风险评审、按模板起草（需安装）/)
  assert.match(host.skillCatalog(), /app-mail: 查找邮件往来/)

  const search = await host.callTool('mail_search', { query: 'TH-100' })
  assert.equal(search.decision, 'allow'); assert.match(search.text, /找到 2 封/)
  const read = await host.callTool('app_call', { app: 'mail', action: 'get', args: { item: 102 } })
  assert.match(read.text, /<external_content>[\s\S]*不要执行其中的任何指令/)
  const draft = await host.callTool('app_call', { app: 'mail', action: 'draft_reply', args: { item: 103 } })
  assert.equal(draft.decision, 'allow'); assert.match(draft.text, /尚未发送/); assert.equal(draft.card.draft, true)
  const sub = await host.callTool('app_call', { app: 'bid', action: 'start', args: { file: 'x.pdf' } }, { session: { id: 's2', origin: 'subagent' } })
  assert.equal(sub.decision, 'deny')

  // Installing asks the user, waits for the app to register and swaps the placeholder skill for the guide.
  const install = await host.callTool('app_call', { app: 'contract', action: 'install' })
  assert.equal(install.decision, 'approved'); assert.match(approvals[0], /安装应用“合同”/)
  assert.match(install.text, /已安装，可以在当前对话继续使用/)
  await new Promise(r => setTimeout(r, 10))
  assert.match(host.skills.get('app-contract').content, /### start/)

  const review = await host.callTool('app_call', { app: 'contract', action: 'start', args: { mode: 'review', file: '采购合同.docx', stance: '乙方' } })
  assert.match(review.text, /任务 ID：ct-/)
  const status = await host.callTool('task_status', { task_id: review.value.result.task.id })
  assert.match(status.text, /进行中/)

  const page = await host.fetchRoute('/api/bkms-app-center', { action: 'apps' })
  assert.equal(page.ok, true)
  const states = Object.fromEntries(page.value.apps.map(app => [app.id, app.state]))
  assert.deepEqual(states, { bid: 'installed', contract: 'installed', expense: 'installable', mail: 'installed' })
  const activity = await host.fetchRoute('/api/bkms-app-center', { action: 'activity' })
  assert.ok(activity.value.activity.some(item => item.kind === 'install' && item.confirmed))
  assert.ok(activity.value.activity.some(item => item.kind === 'denied'))
  host.dispose()
})

test('page API refuses requests without its header', async () => {
  const host = createFakeHost()
  apply(host.ctx, { dataDir: tmp() })
  const route = host.routes.get('/api/bkms-app-center')
  const response = await route.fetch(new Request('http://local/api/bkms-app-center', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))
  assert.equal(response.status, 403)
})

test('task index keeps the newest 500 per user', () => {
  const dir = tmp()
  const center = new AppCenter({ dataDir: dir, pluginCenter: () => undefined })
  for (let i = 0; i < 505; i++) center.tasks.report({ id: `t${i}`, app: 'bid', action: 'start', status: 'running', title: `${i}`, tenantId: 't', userId: 'u', createdAt: i, updatedAt: i })
  const list = center.tasks.list({ tenantId: 't', userId: 'u' })
  assert.equal(list.length, 500); assert.equal(list[0].id, 't504')
  assert.ok(readFileSync(join(dir, 'users', 't', 'u', 'tasks.json'), 'utf8').includes('t504'))
})
