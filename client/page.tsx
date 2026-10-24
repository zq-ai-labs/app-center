import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, formatSize, host, openApp, PHASE_LABEL, RISK_LABEL, STATE_LABEL, TASK_LABEL, type ActivityEntry, type AppsResponse, type AppView, type TaskRecord } from './lib'

type Tab = 'apps' | 'tasks' | 'activity'
const ALL = '全部'

export function AppCenterPage() {
  const [data, setData] = useState<AppsResponse | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<Tab>('apps')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL)
  const [selected, setSelected] = useState<string | undefined>()
  const mounted = useRef(true)

  const load = useCallback(async (refresh = false) => {
    try {
      const value = await api<AppsResponse>('apps', { refresh })
      if (mounted.current) { setData(value); setError('') }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
  }, [])
  // Installs report progress through the app list; poll faster while one runs.
  const installing = data?.apps.some(app => app.state === 'installing') ?? false
  useEffect(() => {
    mounted.current = true
    void load()
    const timer = setInterval(() => { void load() }, installing ? 800 : 6000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [load, installing])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer) }, [notice])

  const categories = useMemo(() => [ALL, ...new Set((data?.apps ?? []).map(app => app.category))], [data])
  const apps = useMemo(() => {
    const words = query.trim().toLowerCase()
    return (data?.apps ?? []).filter(app => (category === ALL || app.category === category) && (!words || [app.name, app.summary, app.category, app.id].some(text => text.toLowerCase().includes(words))))
  }, [data, query, category])
  const current = data?.apps.find(app => app.id === selected)

  const install = async (app: AppView) => {
    try { await api('install', { id: app.id }); setNotice(`开始安装“${app.name}”`); await load() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const useInChat = (app: AppView) => {
    const text = `/app-${app.id} `
    void navigator.clipboard?.writeText(text).catch(() => {})
    const started = host.startChat?.(text) ?? false
    setNotice(started ? `已新开对话。在输入框输入 ${text.trim()} 即可带上“${app.name}”的用法（已复制）。` : `在任意对话的输入框输入 ${text.trim()} 即可带上“${app.name}”的用法（已复制）。`)
  }
  const actions = { install, useInChat, open: (app: AppView) => { if (!openApp(app)) setNotice(`“${app.name}”没有独立页面，请在对话中使用。`) }, details: (app: AppView) => setSelected(app.id) }

  return <div className="bac" data-testid="bkms-app-center">
    <header className="bac-top" data-window-drag="">
      <div>
        <h1>应用中心</h1>
        <p>合同、标书、业务邮件等应用：在这里安装和打开，也可以在对话中一句话使用。</p>
      </div>
      <div className="bac-top-actions">
        {data && <span className="bac-user">{data.user.name}</span>}
        <button type="button" className="bac-btn" onClick={() => void load(true)}>刷新</button>
      </div>
    </header>
    <nav className="bac-tabs" aria-label="应用中心导航">
      {([['apps', '应用'], ['tasks', '我的任务'], ['activity', '对话记录']] as [Tab, string][]).map(([id, label]) =>
        <button type="button" key={id} className={tab === id ? 'on' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {(error || notice || data?.catalogError || (data && !data.canInstall)) && <div className="bac-feedback">
      {error && <div className="bac-alert danger" role="alert">{error}<button type="button" aria-label="关闭" onClick={() => setError('')}>×</button></div>}
      {notice && <div className="bac-alert success" role="status">{notice}</div>}
      {data?.catalogError && <div className="bac-alert">应用目录暂时读取失败，显示的是已安装应用：{data.catalogError}</div>}
      {data && !data.canInstall && !data.catalogError && <div className="bac-alert">当前客户端没有插件中心服务，只显示已安装的应用。</div>}
    </div>}
    <main className="bac-body">
      {tab === 'apps' && <>
        <div className="bac-filters">
          <input type="search" placeholder="搜索应用" aria-label="搜索应用" value={query} onChange={event => setQuery(event.target.value)} />
          <div className="bac-chips" role="tablist" aria-label="分类">
            {categories.map(name => <button type="button" role="tab" aria-selected={category === name} key={name} className={category === name ? 'on' : ''} onClick={() => setCategory(name)}>{name}</button>)}
          </div>
        </div>
        {!data && !error && <div className="bac-empty">正在加载应用…</div>}
        {data && apps.length === 0 && <div className="bac-empty">{query || category !== ALL ? '没有符合条件的应用。' : '还没有可用的应用。'}</div>}
        <div className="bac-grid">{apps.map(app => <AppCard key={app.id} app={app} canInstall={!!data?.canInstall} {...actions} />)}</div>
      </>}
      {tab === 'tasks' && <TasksView />}
      {tab === 'activity' && <ActivityView />}
    </main>
    {current && <AppDetail app={current} canInstall={!!data?.canInstall} onClose={() => setSelected(undefined)} {...actions} />}
  </div>
}

interface CardActions { install(app: AppView): void; useInChat(app: AppView): void; open(app: AppView): void; details(app: AppView): void }

function AppIcon({ app, size = 44 }: { app: AppView; size?: number }) {
  return <span className={`bac-icon c-${hash(app.id) % 6}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">{app.icon || app.name.slice(0, 1)}</span>
}
const hash = (text: string) => Array.from(text).reduce((sum, ch) => sum + ch.charCodeAt(0), 0)

function Progress({ app }: { app: AppView }) {
  const p = app.progress
  if (!p) return null
  const percent = p.total && p.received ? Math.min(100, Math.round(p.received / p.total * 100)) : p.phase === 'done' ? 100 : 8
  if (p.phase === 'failed') return <p className="bac-progress-error">安装失败：{p.message}</p>
  if (p.phase === 'done') return p.effect === 'restart' ? <p className="bac-progress-note">已安装，重启 XBuddy 后可用</p> : p.effect === 'reload' ? <p className="bac-progress-note">已安装，刷新界面后可用</p> : null
  return <div className="bac-progress" aria-label={`安装进度 ${percent}%`}><i style={{ width: `${percent}%` }} /><span>{PHASE_LABEL[p.phase] ?? p.phase} {percent}%</span></div>
}

function Primary({ app, canInstall, install, open, useInChat }: { app: AppView; canInstall: boolean } & CardActions) {
  if (app.state === 'installing') return <button type="button" className="bac-btn primary" disabled>安装中…</button>
  if (app.state === 'pending') return <button type="button" className="bac-btn" disabled>{app.progress?.effect === 'restart' ? '重启后可用' : '刷新后可用'}</button>
  if (app.state === 'installable') return <button type="button" className="bac-btn primary" disabled={!canInstall} title={canInstall ? undefined : '需要插件中心服务'} onClick={() => install(app)}>安装</button>
  return <>
    {app.state === 'update' && <button type="button" className="bac-btn primary" disabled={!canInstall} onClick={() => install(app)}>更新</button>}
    {app.page && <button type="button" className={`bac-btn ${app.state === 'update' ? '' : 'primary'}`} onClick={() => open(app)}>打开</button>}
    <button type="button" className="bac-btn" onClick={() => useInChat(app)}>在对话中使用</button>
  </>
}

function AppCard(props: { app: AppView; canInstall: boolean } & CardActions) {
  const { app, details } = props
  return <article className="bac-card" aria-label={app.name}>
    <button type="button" className="bac-card-head" onClick={() => details(app)}>
      <AppIcon app={app} />
      <span className="bac-card-title">
        <strong>{app.name}</strong>
        <small>{app.category}{app.usage ? ` · ${app.usage} 人用过` : ''}</small>
      </span>
      <span className={`bac-state s-${app.state}`}>{STATE_LABEL[app.state]}</span>
    </button>
    <p className="bac-summary">{app.summary}</p>
    <Progress app={app} />
    <div className="bac-card-actions"><Primary {...props} /><button type="button" className="bac-link" onClick={() => details(app)}>详情</button></div>
  </article>
}

function AppDetail(props: { app: AppView; canInstall: boolean; onClose(): void } & CardActions) {
  const { app, onClose } = props
  const [skill, setSkill] = useState<{ name: string; content: string } | undefined>()
  const [showSkill, setShowSkill] = useState(false)
  useEffect(() => {
    let live = true
    api<{ skill: { name: string; content: string } }>('app', { id: app.id }).then(value => { if (live) setSkill(value.skill) }, () => {})
    return () => { live = false }
  }, [app.id, app.state])
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [onClose])
  return <div className="bac-drawer-backdrop" onClick={onClose}>
    <aside className="bac-drawer" role="dialog" aria-modal="true" aria-label={`${app.name} 详情`} onClick={event => event.stopPropagation()}>
      <header className="bac-drawer-head">
        <AppIcon app={app} size={52} />
        <div><h2>{app.name}</h2><p>{app.category} · {STATE_LABEL[app.state]}</p></div>
        <button type="button" className="bac-close" aria-label="关闭" onClick={onClose}>×</button>
      </header>
      <div className="bac-drawer-body">
        <p>{app.description ?? app.summary}</p>
        <Progress app={app} />
        <div className="bac-card-actions"><Primary {...props} /></div>
        <dl className="bac-facts">
          <dt>版本</dt><dd>{app.version ?? '—'}{app.latestVersion && app.latestVersion !== app.version ? `（最新 ${app.latestVersion}）` : ''}</dd>
          <dt>大小</dt><dd>{formatSize(app.size)}</dd>
          <dt>生效方式</dt><dd>{app.restart === 'restart' ? '安装后需重启' : app.restart === 'reload' ? '安装后需刷新界面' : '安装后立即可用'}</dd>
          <dt>所需权限</dt><dd>{app.permissions.length ? app.permissions.join('、') : '—'}</dd>
          {app.changelog && <><dt>更新说明</dt><dd>{app.changelog}</dd></>}
        </dl>
        {app.actions.length > 0 && <section>
          <h3>在对话中能做什么</h3>
          <ul className="bac-actions">{app.actions.map(action => <li key={action.name}>
            <code>{action.name}</code><span>{action.description}</span><em className={`r-${action.risk}`}>{RISK_LABEL[action.risk]}{action.long ? ' · 长任务' : ''}</em>
          </li>)}</ul>
        </section>}
        {skill && <section>
          <button type="button" className="bac-link" aria-expanded={showSkill} onClick={() => setShowSkill(!showSkill)}>{showSkill ? '收起' : '查看'} AI 看到的用法（技能 {skill.name}）</button>
          {showSkill && <pre className="bac-skill">{skill.content}</pre>}
        </section>}
      </div>
    </aside>
  </div>
}

function TasksView() {
  const [tasks, setTasks] = useState<TaskRecord[] | undefined>()
  useEffect(() => {
    let live = true
    const load = () => api<{ tasks: TaskRecord[] }>('tasks').then(value => { if (live) setTasks(value.tasks) }, () => {})
    void load(); const timer = setInterval(load, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  if (!tasks) return <div className="bac-empty">正在加载任务…</div>
  if (!tasks.length) return <div className="bac-empty">还没有任务。在对话中发起合同评审、标书解析等长任务后会显示在这里。</div>
  return <ul className="bac-list">{tasks.map(task => <li key={task.id}>
    <span className={`bac-task t-${task.status}`}>{TASK_LABEL[task.status] ?? task.status}</span>
    <div><strong>{task.title}</strong>{task.summary && <p>{task.summary}</p>}<small>{task.app} · {new Date(task.updatedAt).toLocaleString()}</small></div>
    {task.link?.page && <button type="button" className="bac-btn" onClick={() => openApp(task.link)}>打开</button>}
  </li>)}</ul>
}

function ActivityView() {
  const [items, setItems] = useState<ActivityEntry[] | undefined>()
  useEffect(() => { api<{ activity: ActivityEntry[] }>('activity').then(value => setItems(value.activity), () => setItems([])) }, [])
  if (!items) return <div className="bac-empty">正在加载…</div>
  if (!items.length) return <div className="bac-empty">还没有对话调用记录。</div>
  return <table className="bac-table"><thead><tr><th>时间</th><th>来源</th><th>应用 · 动作</th><th>结果</th><th>确认</th></tr></thead>
    <tbody>{items.map((item, index) => <tr key={index} className={item.ok ? '' : 'bad'}>
      <td>{new Date(item.at).toLocaleString()}</td><td>{item.origin === 'chat' ? '对话' : '页面'}</td><td><code>{item.app}.{item.action}</code></td><td>{item.result}</td><td>{item.confirmed ? '已确认' : '—'}</td>
    </tr>)}</tbody></table>
}
