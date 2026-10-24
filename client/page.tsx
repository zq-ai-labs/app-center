import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, host, openApp, type AppsResponse, type AppView } from './lib'

// Same layout, proportions and tokens as the enterprise tool marketplace (@bkms/ui-skills ToolsMarketplace):
// fixed title and search, wrapping category tabs, a scrolling grid of cards. A card is the only control: clicking it
// uses the app. The plugin center installs and upgrades every app by itself; an app it is still installing opens as
// soon as it is ready, and a failed install is retried through the plugin center.

const ALL = ''
const CATEGORY_ORDER = ['通用工具', '办公', '财务', '法务', '人力']
const CATEGORY_KEY: Record<string, string> = { 通用工具: 'general', 办公: 'office', 财务: 'finance', 法务: 'legal', 人力: 'hr' }

function usageText(count = 0): string {
  return count >= 10000 ? `${(count / 10000).toFixed(1).replace(/\.0$/, '')} 万人聊过` : `${count} 人聊过`
}

function SparkleIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 1.5l1.3 3.6 3.7 1.3-3.7 1.3L8 11.3 6.7 7.7 3 6.4l3.7-1.3L8 1.5z" /><path d="M12.5 10l.6 1.6 1.6.6-1.6.6-.6 1.7-.6-1.7-1.6-.6 1.6-.6.6-1.6z" opacity=".7" />
  </svg>
}
function SearchIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M13.5 13.5L17 17" strokeLinecap="round" /></svg>
}

/** What a card says under the description while the plugin center is still making the app available. */
function statusLine(app: AppView): string | undefined {
  const p = app.progress
  switch (app.state) {
    case 'preparing': return '等待插件中心安装…'
    case 'installing': {
      const percent = p?.total && p.received ? Math.min(100, Math.round(p.received / p.total * 100)) : undefined
      return p?.phase === 'waiting' ? '正在加载，马上可用…' : `插件中心正在安装${percent !== undefined ? ` ${percent}%` : '…'}`
    }
    case 'pending': return p?.effect === 'restart' ? '已安装，重启 XBuddy 后可用' : '已安装，刷新界面后可用'
    case 'failed': return `安装失败，点击重试：${p?.message ?? ''}`
    default: return undefined
  }
}

export function AppCenterPage() {
  const [data, setData] = useState<AppsResponse | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL)
  // Apps the user clicked while they were not installed: open them as soon as they are ready.
  const pendingOpen = useRef(new Set<string>())
  const mounted = useRef(true)

  const open = useCallback((app: AppView) => {
    if (openApp(app)) return
    const text = `/app-${app.id} `
    void navigator.clipboard?.writeText(text).catch(() => {})
    const started = host.startChat?.(text) ?? false
    setNotice(started ? `已新开对话，输入 ${text.trim()} 即可使用“${app.name}”（已复制）。` : `在对话输入框输入 ${text.trim()} 即可使用“${app.name}”（已复制）。`)
  }, [])

  const load = useCallback(async (refresh = false) => {
    try {
      const value = await api<AppsResponse>('apps', { refresh })
      if (!mounted.current) return
      setData(value); setError('')
      for (const app of value.apps) {
        if (!pendingOpen.current.has(app.id)) continue
        if (app.state === 'installed') { pendingOpen.current.delete(app.id); open(app) }
        else if (app.state === 'pending' || app.state === 'failed') pendingOpen.current.delete(app.id)
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
  }, [open])

  const busy = data?.apps.some(app => app.state === 'installing' || app.state === 'preparing') ?? false
  useEffect(() => {
    mounted.current = true
    void load()
    const timer = setInterval(() => { void load() }, busy ? 700 : 6000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [load, busy])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer) }, [notice])

  const use = async (app: AppView) => {
    if (app.state === 'installed') { open(app); return }
    if (app.state === 'pending') { setNotice(`“${app.name}”已安装，${app.progress?.effect === 'restart' ? '重启 XBuddy' : '刷新界面'}后即可使用。`); return }
    // Installing is the plugin center's job: wait for it and open the app when it is ready.
    pendingOpen.current.add(app.id)
    if (app.state !== 'failed') { setNotice(`“${app.name}”正在由插件中心安装，完成后会自动打开。`); return }
    try { await api('retry', { id: app.id }); setNotice(`已请插件中心重新安装“${app.name}”，完成后会自动打开。`); await load() }
    catch (failure) { pendingOpen.current.delete(app.id); setError(failure instanceof Error ? failure.message : String(failure)) }
  }

  const categories = useMemo(() => {
    const present = [...new Set((data?.apps ?? []).map(app => app.category))]
    return [...CATEGORY_ORDER.filter(name => present.includes(name)), ...present.filter(name => !CATEGORY_ORDER.includes(name))]
  }, [data])
  const words = query.trim().toLocaleLowerCase()
  const apps = useMemo(() => (data?.apps ?? []).filter(app => (category === ALL || app.category === category)
    && (!words || [app.name, app.summary, app.description ?? ''].some(text => text.toLocaleLowerCase().includes(words)))), [data, category, words])

  return <section className="bac bac-market-page" aria-label="企业应用中心" data-testid="bkms-app-center">
    <header className="bac-market-header">
      <h2>企业应用中心<span aria-hidden="true"> · </span><span className="bac-market-accent">管理中心</span></h2>
      <label className="bac-market-search">
        <SearchIcon />
        <span className="bac-sr-only">搜索应用</span>
        <input type="search" value={query} placeholder="请输入应用名称或功能描述" onChange={event => setQuery(event.currentTarget.value)} />
      </label>
    </header>
    <div className="bac-market-tabs" role="toolbar" aria-label="应用分类">
      {[ALL, ...categories].map(name => <button type="button" key={name || 'all'} aria-pressed={category === name} onClick={() => setCategory(name)}>{name || '全部'}</button>)}
    </div>
    {(error || notice || data?.catalogError) && <div className="bac-market-notice" role="status">
      {error || notice || `应用目录暂时读取失败，只显示已安装的应用：${data?.catalogError}`}
    </div>}
    <div className="bac-market-body">
      {!data && !error && <div className="bac-market-state">正在加载应用…</div>}
      {data && apps.length === 0 && <div className="bac-market-state">暂无匹配应用</div>}
      {apps.length > 0 && <div className="bac-market-grid">
        {apps.map(app => {
          const status = statusLine(app)
          return <button type="button" key={app.id} className="bac-market-card" data-state={app.state} aria-busy={app.state === 'installing'}
            aria-label={`${app.name}。${app.state === 'installed' ? '使用' : statusLine(app) ?? ''}`} onClick={() => void use(app)}>
            <span className="bac-market-icon" data-category={CATEGORY_KEY[app.category] ?? 'general'} aria-hidden="true">{app.icon || app.name.slice(0, 1)}</span>
            <span className="bac-market-content">
              <span className="bac-market-title">
                <strong className="bac-ellipsis" title={app.name}>{app.name}</strong>
                <span className="bac-market-category bac-ellipsis">{app.category}</span>
              </span>
              <span className="bac-market-description bac-ellipsis" title={app.summary}>{app.summary}</span>
              {status
                ? <span className={`bac-market-status${app.state === 'failed' ? ' failed' : ''}`}>{(app.state === 'installing' || app.state === 'preparing') && <i className="bac-market-spinner" aria-hidden="true" />}<span className="bac-ellipsis" title={status}>{status}</span></span>
                : <span className="bac-market-usage"><SparkleIcon /><span className="bac-ellipsis">{usageText(app.usage)}</span></span>}
            </span>
            {app.state === 'installing' && app.progress?.total && app.progress.received
              ? <span className="bac-market-progress" style={{ width: `${Math.min(100, Math.round(app.progress.received / app.progress.total * 100))}%` }} aria-hidden="true" />
              : null}
          </button>
        })}
      </div>}
    </div>
  </section>
}
