import * as React from 'react'
import { useEffect, useState } from 'react'
import { api, openApp, TASK_LABEL, type AppLink, type TaskRecord } from './lib'

interface CardMeta {
  kind: 'result' | 'error' | 'task'
  app?: string; appName?: string; action?: string; summary?: string; error?: string
  items?: { title: string; detail: string | null; link: AppLink | null }[]
  task?: { id: string; etaMinutes?: number } | TaskRecord | null
  draft?: boolean
  link?: AppLink | null
}

/** Live status of a long task started in this conversation. */
function TaskLine({ id }: { id: string }) {
  const [task, setTask] = useState<TaskRecord | undefined>()
  useEffect(() => {
    let live = true
    const load = () => api<{ tasks: TaskRecord[] }>('tasks').then(value => { if (live) setTask(value.tasks.find(item => item.id === id)) }, () => {})
    void load(); const timer = setInterval(load, 4000)
    return () => { live = false; clearInterval(timer) }
  }, [id])
  if (!task) return <div className="bac-tc-task">任务 {id}</div>
  return <div className="bac-tc-task"><span className={`bac-task t-${task.status}`}>{TASK_LABEL[task.status] ?? task.status}</span>{task.summary ?? task.title}</div>
}

/** The card shown for `app_call`, `task_status` and resident app tools in the conversation. */
export function ToolCard(props: any) {
  const phase: string = props.phase
  const block = props.block
  if (phase !== 'result') {
    let label = '正在调用应用'
    try { const args = JSON.parse(block?.argsRaw ?? block?.call?.argsRaw ?? '{}'); if (args.app) label = args.action === 'install' ? `正在安装应用 ${args.app}` : `正在调用 ${args.app}.${args.action ?? ''}` } catch { /* partial arguments */ }
    return <div className="bac bac-tc pending"><span className="bac-tc-dot" />{label}…</div>
  }
  const meta = block?.meta as CardMeta | undefined
  if (!meta) {
    const text = (block?.content ?? []).map((item: any) => item.text ?? '').join('\n')
    return <div className="bac bac-tc"><pre className="bac-tc-text">{text}</pre></div>
  }
  if (meta.kind === 'error') return <div className="bac bac-tc error"><div className="bac-tc-head"><span className="bac-tc-app">{meta.app ?? '应用'}</span><span>未执行</span></div><p>{meta.error}</p></div>
  if (meta.kind === 'task') {
    const task = meta.task as TaskRecord
    return <div className="bac bac-tc"><div className="bac-tc-head"><span className="bac-tc-app">{task.app}</span><span className={`bac-task t-${task.status}`}>{TASK_LABEL[task.status] ?? task.status}</span></div>
      <strong>{task.title}</strong>{task.summary && <p>{task.summary}</p>}
      {task.link?.page && <div className="bac-tc-actions"><button type="button" className="bac-btn small primary" onClick={() => openApp(task.link)}>在应用中打开</button></div>}</div>
  }
  const link = meta.link
  return <div className="bac bac-tc">
    <div className="bac-tc-head"><span className="bac-tc-app">{meta.appName ?? meta.app}</span><code>{meta.action}</code>{meta.draft && <span className="bac-tc-draft">草稿 · 尚未发送</span>}</div>
    <p className="bac-tc-summary">{meta.summary}</p>
    {!!meta.items?.length && <ul className="bac-tc-items">{meta.items.map((item, index) => <li key={index}>
      {item.link?.page ? <button type="button" className="bac-link" onClick={() => openApp(item.link)}>{item.title}</button> : <span>{item.title}</span>}
      {item.detail && <small>{item.detail}</small>}
    </li>)}</ul>}
    {meta.task && 'id' in meta.task && <TaskLine id={meta.task.id} />}
    {link?.page && <div className="bac-tc-actions"><button type="button" className="bac-btn small primary" onClick={() => openApp(link)}>{link.label ?? `在${meta.appName ?? '应用'}中打开`}</button></div>}
  </div>
}
