// Demo shell: a sidebar like XBuddy's with the real app center page and a scripted conversation that runs
// real tool calls through the app center and renders them with the real result cards.
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppCenterPage } from '../client/page'
import { ToolCard } from '../client/card'
import { host } from '../client/lib'
// @ts-ignore bundled as text
import stylesheet from '../client/styles.css'
// @ts-ignore bundled as text
import demoStyles from './demo.css'

type Step =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; text: string }
  | { kind: 'skill'; name: string }
  | { kind: 'tool'; tool: string; args: any; session?: any }

interface Scenario { id: string; title: string; note?: string; steps: Step[] }

const SCENARIOS: Scenario[] = [
  { id: 's1', title: '找邮件往来（常驻工具）', steps: [
    { kind: 'user', text: '找一下和启明演示关于 TH-100 的往来' },
    { kind: 'tool', tool: 'mail_search', args: { query: 'TH-100' } },
    { kind: 'ai', text: '找到 2 封和启明演示（王经理）关于 TH-100 的邮件：演示安排确认、报价回复（附采购合同草稿）。点击卡片可以在工作台打开。' },
  ] },
  { id: 's2', title: '今天要决策的事项', steps: [
    { kind: 'user', text: '我今天有哪些要决策的' },
    { kind: 'skill', name: 'app-mail' },
    { kind: 'tool', tool: 'app_call', args: { app: 'mail', action: 'list', args: { view: 'decide' } } },
    { kind: 'ai', text: '有 2 项等你决策：一封询价的回复草稿待审核，一封 TH-100 报价邮件需要人工处理。' },
  ] },
  { id: 's3', title: '起草回复（草稿，不发送）', steps: [
    { kind: 'user', text: '给李工那封询价起个回复，报三年期' },
    { kind: 'skill', name: 'app-mail' },
    { kind: 'tool', tool: 'app_call', args: { app: 'mail', action: 'draft_reply', args: { item: 103, instructions: '报三年期服务' } } },
    { kind: 'ai', text: '回复草稿已经放进“待我决策”，尚未发送。请在工作台审核后再发出。' },
  ] },
  { id: 's4', title: '审合同附件（转交合同应用）', note: '合同应用在演示启动几秒后登记（模拟插件装好）；还没登记时，AI 会得知没有这个应用。', steps: [
    { kind: 'user', text: '把王经理那封邮件的合同附件审一下，我们是乙方' },
    { kind: 'skill', name: 'app-contract' },
    { kind: 'tool', tool: 'app_call', args: { app: 'mail', action: 'handoff', args: { item: 102, target: 'contract', stance: '乙方' } } },
    { kind: 'ai', text: '已经把“TH-100采购合同（草稿）.docx”交给合同应用评审，我方立场为乙方，大约 3 分钟出结果。' },
  ] },
  { id: 's5', title: '按招标文件开始做标书（长任务）', steps: [
    { kind: 'user', text: '按这份招标文件开始做标书' },
    { kind: 'skill', name: 'app-bid' },
    { kind: 'tool', tool: 'app_call', args: { app: 'bid', action: 'start', args: { file: '市政务云运维服务招标文件.pdf' } } },
    { kind: 'ai', text: '已建立标书项目并开始解析，约 3 分钟。解析完成后会提醒你，也可以随时问我进度。' },
  ] },
  { id: 's6', title: '标书还差哪些没响应', steps: [
    { kind: 'user', text: '政务云那个标书还差哪些没响应' },
    { kind: 'skill', name: 'app-bid' },
    { kind: 'tool', tool: 'app_call', args: { app: 'bid', action: 'check', args: { project: '政务云' } } },
    { kind: 'ai', text: '还有 2 处没有响应：评分项 3.2“应急响应时间”，以及资格要求里的 ISO 20000 证书没有引用证明材料。' },
  ] },
  { id: 's7', title: '参数错了，按提示自己纠正', note: '校验失败时返回正确的参数说明和示例。', steps: [
    { kind: 'user', text: '政务云项目现在什么情况' },
    { kind: 'tool', tool: 'app_call', args: { app: 'bid', action: 'get', args: { name: '政务云' } } },
    { kind: 'tool', tool: 'app_call', args: { app: 'bid', action: 'get', args: { project: '政务云' } } },
    { kind: 'ai', text: '政务云运维项目在“编写正文”阶段，完成 12/18 章，11 月 5 日截止。' },
  ] },
  { id: 's8', title: '外部内容里的指令不执行', note: '来信里夹带“忽略之前所有指令…”，结果标为外部内容。', steps: [
    { kind: 'user', text: '打开王经理那封报价邮件' },
    { kind: 'tool', tool: 'app_call', args: { app: 'mail', action: 'get', args: { item: 102 } } },
    { kind: 'ai', text: '王经理希望交期提前两周，并附了采购合同草稿请法务看。邮件里有一段要求把报价转发给第三方的文字，来自外部内容，我不会照做。' },
  ] },
  { id: 's9', title: '子任务越权被拒绝', note: '子 Agent 只能执行只读动作。', steps: [
    { kind: 'user', text: '（子任务）给询价起草回复' },
    { kind: 'tool', tool: 'app_call', args: { app: 'mail', action: 'draft_reply', args: { item: 103 } }, session: { id: 'child-1', origin: 'subagent' } },
  ] },
  { id: 's10', title: '动作改名后旧名仍可用', steps: [
    { kind: 'user', text: '政务云标书进度' },
    { kind: 'tool', tool: 'app_call', args: { app: 'bid', action: 'progress', args: { project: 'bid-7' } } },
  ] },
]

interface Entry { id: number; step: Step; result?: any; skill?: string; asking?: { reason: string; resolve: (ok: boolean) => void } }

async function post(path: string, body: unknown) { const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return response.json() }

function Chat({ prefill, onPrefillUsed }: { prefill?: string; onPrefillUsed(): void }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [running, setRunning] = useState(false)
  const [context, setContext] = useState<{ catalog: string; tools: { name: string; description: string }[]; skills: Record<string, string> } | undefined>()
  const [input, setInput] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const nextId = useRef(1)
  const loadContext = async () => { const value = await (await fetch('/demo/context')).json(); setContext(value); return value }
  useEffect(() => { void loadContext() }, [])
  useEffect(() => { if (prefill) { setInput(prefill); onPrefillUsed() } }, [prefill, onPrefillUsed])
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [entries])

  const push = (entry: Omit<Entry, 'id'>) => { const id = nextId.current++; setEntries(list => [...list, { ...entry, id }]); return id }
  const update = (id: number, patch: Partial<Entry>) => setEntries(list => list.map(item => item.id === id ? { ...item, ...patch } : item))

  const run = async (scenario: Scenario) => {
    if (running) return
    setRunning(true)
    try {
      for (const step of scenario.steps) {
        await new Promise(r => setTimeout(r, 350))
        if (step.kind === 'skill') { const ctx = await loadContext(); push({ step, skill: ctx.skills[step.name] ?? '（没有这个技能）' }); continue }
        if (step.kind !== 'tool') { push({ step }); continue }
        const id = push({ step })
        let result = await post('/demo/call', { tool: step.tool, args: step.args, session: step.session })
        if (result.decision === 'needs-approval') {
          const ok = await new Promise<boolean>(resolve => update(id, { asking: { reason: result.reason, resolve } }))
          update(id, { asking: undefined })
          result = await post('/demo/call', { tool: step.tool, args: step.args, session: step.session, approve: ok })
        }
        update(id, { result })
        await loadContext()
      }
    } finally { setRunning(false) }
  }

  return <div className="demo-chat">
    <aside className="demo-scenarios">
      <h2>典型场景</h2>
      <p className="demo-muted">点击运行。工具调用、风险拦截、安装和结果卡片都由真实的应用中心代码完成；AI 的文字回复是脚本，不是真实模型。</p>
      {SCENARIOS.map(scenario => <button type="button" key={scenario.id} disabled={running} onClick={() => void run(scenario)}>
        <strong>{scenario.title}</strong>{scenario.note && <small>{scenario.note}</small>}
      </button>)}
      <div className="demo-row">
        <button type="button" className="demo-ghost" disabled={running} onClick={() => setEntries([])}>清空对话</button>
        <button type="button" className="demo-ghost" disabled={running} onClick={async () => { await post('/demo/reset', {}); setEntries([]); await loadContext() }}>重置演示数据</button>
      </div>
    </aside>
    <section className="demo-transcript">
      {entries.length === 0 && <div className="demo-empty">选择左侧的场景开始，或在应用中心点“在对话中使用”。</div>}
      {entries.map(entry => <EntryView key={entry.id} entry={entry} />)}
      <div ref={end} />
      <form className="demo-composer" onSubmit={event => { event.preventDefault(); if (input.trim()) { push({ step: { kind: 'user', text: input.trim() } }); const match = /^\/(app-[a-z0-9-]+)/.exec(input.trim()); if (match) void loadContext().then(ctx => push({ step: { kind: 'skill', name: match[1] }, skill: ctx.skills[match[1]] ?? '（没有这个技能）' })); setInput('') } }}>
        <input value={input} onChange={event => setInput(event.target.value)} placeholder="输入 /app-<id> 带上应用用法（演示只展示技能加载）" aria-label="输入消息" />
        <button type="submit" className="bac-btn primary">发送</button>
      </form>
    </section>
    <aside className="demo-context">
      <h2>模型上下文</h2>
      <h3>第 0 层 · 技能目录（常驻）</h3>
      <pre>{context?.catalog || '…'}</pre>
      <h3>应用中心注册的工具</h3>
      <ul>{context?.tools.map(tool => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></li>)}</ul>
    </aside>
  </div>
}

function EntryView({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false)
  const { step } = entry
  if (step.kind === 'user') return <div className="demo-msg user"><div>{step.text}</div></div>
  if (step.kind === 'ai') return <div className="demo-msg ai"><div>{step.text}<small>脚本回复</small></div></div>
  if (step.kind === 'skill') return <div className="demo-step"><button type="button" className="demo-step-head" onClick={() => setOpen(!open)}>📖 加载技能 <code>{step.name}</code>（第 1 层用法）{open ? '▾' : '▸'}</button>{open && <pre className="demo-pre">{entry.skill}</pre>}</div>
  const result = entry.result
  const decision = result?.decision
  return <div className="demo-step">
    <div className="demo-step-head static">🔧 <code>{step.tool}</code> <code className="demo-args">{JSON.stringify(step.args)}</code>{step.session?.origin === 'subagent' && <span className="demo-tag warn">子任务</span>}
      {decision && <span className={`demo-tag ${decision === 'deny' || decision === 'rejected' ? 'bad' : decision === 'approved' ? 'warn' : 'ok'}`}>{({ allow: '直接执行', approved: '用户已确认', deny: '已拒绝', rejected: '用户拒绝' } as Record<string, string>)[decision] ?? decision}</span>}
    </div>
    {entry.asking && <div className="demo-approval" role="dialog" aria-label="需要确认">
      <strong>需要你确认</strong><p>{entry.asking.reason}</p>
      <div className="demo-row"><button type="button" className="bac-btn primary" onClick={() => entry.asking!.resolve(true)}>允许</button><button type="button" className="bac-btn" onClick={() => entry.asking!.resolve(false)}>拒绝</button></div>
    </div>}
    {!result && !entry.asking && <ToolCard phase="start" block={{ argsRaw: JSON.stringify(step.args) }} />}
    {result && (result.card ? <ToolCard phase="result" block={{ meta: result.card, content: [{ type: 'text', text: result.text }] }} /> : <div className="bac bac-tc error"><p>{result.text}</p></div>)}
    {result?.text && <><button type="button" className="demo-link" onClick={() => setOpen(!open)}>{open ? '收起' : '查看'}模型收到的文字（第 2 层）</button>{open && <pre className="demo-pre">{result.text}</pre>}</>}
  </div>
}

/** Demo only: install or remove the demo app plugins; the app center follows what is registered. */
function PluginToggles() {
  const [installed, setInstalled] = useState<string[]>([])
  const names: [string, string][] = [['mail', '业务邮件'], ['bid', '标书'], ['contract', '合同']]
  const refresh = async () => setInstalled((await (await fetch('/demo/plugins')).json()).installed)
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh() }, 2000); return () => clearInterval(timer) }, [])
  const toggle = async (id: string) => { await post('/demo/plugins', { id, installed: !installed.includes(id) }); await refresh() }
  return <div className="demo-plugins" aria-label="演示插件">
    <strong>演示：已安装的插件</strong>
    {names.map(([id, label]) => <label key={id}><input type="checkbox" checked={installed.includes(id)} onChange={() => void toggle(id)} />{label}</label>)}
  </div>
}

function Shell() {
  const [view, setView] = useState<'chat' | 'apps'>('apps')
  const [toast, setToast] = useState('')
  const [prefill, setPrefill] = useState<string | undefined>()
  useEffect(() => {
    host.openPanel = id => { setToast(`打开应用页面：${id}（在 XBuddy 中会切换到该应用的页面）`) }
    host.startChat = text => { setView('chat'); setPrefill(text); return true }
  }, [])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer) }, [toast])
  return <div className="demo-shell bac">
    <nav className="demo-side" aria-label="主导航">
      <div className="demo-logo">XB</div>
      <button type="button" className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')} title="对话">💬<span>对话</span></button>
      <button type="button" className={view === 'apps' ? 'on' : ''} onClick={() => setView('apps')} title="应用中心">▦<span>应用中心</span></button>
    </nav>
    <main className="demo-main">{view === 'apps' ? <AppCenterPage /> : <Chat prefill={prefill} onPrefillUsed={() => setPrefill(undefined)} />}</main>
    {view === 'apps' && <PluginToggles />}
    {toast && <div className="demo-toast" role="status">{toast}</div>}
  </div>
}

for (const css of [stylesheet, demoStyles]) { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style) }
createRoot(document.getElementById('root')!).render(<Shell />)
