import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, host, openApp, type AppsResponse, type AppView } from './lib'

// Same layout, proportions and tokens as the enterprise tool marketplace (@bkms/ui-skills ToolsMarketplace):
// fixed title and search, wrapping category tabs, a scrolling grid of cards. The app center is a frame: it shows the
// apps whose plugins are installed and registered, and nothing else; with no apps it shows an empty state.
// A card is the only control: clicking it opens the app.

const ALL = ''
const CATEGORY_ORDER = ['通用工具', '办公', '财务', '法务', '人力']
const CATEGORY_KEY: Record<string, string> = { 通用工具: 'general', 办公: 'office', 财务: 'finance', 法务: 'legal', 人力: 'hr' }

const usageText = (count: number): string => count > 0 ? `已使用 ${count} 次` : '尚未使用'

function SparkleIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 1.5l1.3 3.6 3.7 1.3-3.7 1.3L8 11.3 6.7 7.7 3 6.4l3.7-1.3L8 1.5z" /><path d="M12.5 10l.6 1.6 1.6.6-1.6.6-.6 1.7-.6-1.7-1.6-.6 1.6-.6.6-1.6z" opacity=".7" />
  </svg>
}
function SearchIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M13.5 13.5L17 17" strokeLinecap="round" /></svg>
}

export function AppCenterPage() {
  const [data, setData] = useState<AppsResponse | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL)
  const mounted = useRef(true)

  // Apps come and go as their plugins are installed or removed; poll the registered list.
  const load = useCallback(async () => {
    try {
      const value = await api<AppsResponse>('apps')
      if (mounted.current) { setData(value); setError('') }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
  }, [])
  useEffect(() => {
    mounted.current = true
    void load()
    const timer = setInterval(() => { void load() }, 5000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [load])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer) }, [notice])

  const open = (app: AppView) => {
    if (openApp(app)) return
    // An app without its own page is used from the conversation.
    const text = `/app-${app.id} `
    void navigator.clipboard?.writeText(text).catch(() => {})
    const started = host.startChat?.(text) ?? false
    setNotice(started ? `已新开对话，输入 ${text.trim()} 即可使用“${app.name}”（已复制）。` : `在对话输入框输入 ${text.trim()} 即可使用“${app.name}”（已复制）。`)
  }

  const categories = useMemo(() => {
    const present = [...new Set((data?.apps ?? []).map(app => app.category))]
    return [...CATEGORY_ORDER.filter(name => present.includes(name)), ...present.filter(name => !CATEGORY_ORDER.includes(name))]
  }, [data])
  const words = query.trim().toLocaleLowerCase()
  const apps = useMemo(() => (data?.apps ?? []).filter(app => (category === ALL || app.category === category)
    && (!words || [app.name, app.summary, app.description ?? ''].some(text => text.toLocaleLowerCase().includes(words)))), [data, category, words])
  const none = data !== undefined && data.apps.length === 0

  return <section className="bac bac-market-page" aria-label="企业应用中心" data-testid="bkms-app-center">
    <header className="bac-market-header">
      <h2>企业应用中心<span aria-hidden="true"> · </span><span className="bac-market-accent">管理中心</span></h2>
      <label className="bac-market-search">
        <SearchIcon />
        <span className="bac-sr-only">搜索应用</span>
        <input type="search" value={query} placeholder="请输入应用名称或功能描述" disabled={none} onChange={event => setQuery(event.currentTarget.value)} />
      </label>
    </header>
    {!none && <div className="bac-market-tabs" role="toolbar" aria-label="应用分类">
      {[ALL, ...categories].map(name => <button type="button" key={name || 'all'} aria-pressed={category === name} onClick={() => setCategory(name)}>{name || '全部'}</button>)}
    </div>}
    {(error || notice) && <div className="bac-market-notice" role="status">{error || notice}</div>}
    <div className="bac-market-body">
      {!data && !error && <div className="bac-market-state">正在加载应用…</div>}
      {none && <div className="bac-market-state bac-market-empty">
        <strong>还没有可用的应用</strong>
        <span>安装应用插件后，应用会自动出现在这里，并可以在对话中使用。</span>
      </div>}
      {data && !none && apps.length === 0 && <div className="bac-market-state">暂无匹配应用</div>}
      {apps.length > 0 && <div className="bac-market-grid">
        {apps.map(app => <button type="button" key={app.id} className="bac-market-card" aria-label={`${app.name}。打开`} onClick={() => open(app)}>
          <span className="bac-market-icon" data-category={CATEGORY_KEY[app.category] ?? 'general'} aria-hidden="true">{app.icon || app.name.slice(0, 1)}</span>
          <span className="bac-market-content">
            <span className="bac-market-title">
              <strong className="bac-ellipsis" title={app.name}>{app.name}</strong>
              <span className="bac-market-category bac-ellipsis">{app.category}</span>
            </span>
            <span className="bac-market-description bac-ellipsis" title={app.summary}>{app.summary}</span>
            <span className="bac-market-usage"><SparkleIcon /><span className="bac-ellipsis">{usageText(app.usage)}</span></span>
          </span>
        </button>)}
      </div>}
    </div>
  </section>
}
