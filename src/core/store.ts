import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRecord, TaskStatus, UserRef } from './types.js'

const TASK_LIMIT = 500
const ACTIVITY_DAYS = 90
const SAFE = /[^A-Za-z0-9_.-]/g
const folder = (root: string, user: UserRef) => join(root, user.tenantId.replace(SAFE, '_') || '_', user.userId.replace(SAFE, '_') || '_')

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2))
  try { renameSync(temp, file) } catch { writeFileSync(file, JSON.stringify(value, null, 2)) } // Windows may refuse a rename over an open file.
}
function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}

/** Index of long tasks across apps, kept per enterprise user. The task data itself stays with each app. */
export class TaskIndex {
  constructor(private readonly root: string) {}
  private file(user: UserRef): string { const dir = folder(this.root, user); mkdirSync(dir, { recursive: true }); return join(dir, 'tasks.json') }

  report(task: TaskRecord): TaskRecord {
    if (!task?.id || !task.app || !task.tenantId || !task.userId) throw new Error('任务记录缺少 id、app 或发起者')
    const file = this.file(task)
    const all = readJson<TaskRecord[]>(file, [])
    const previous = all.find(item => item.id === task.id)
    const list = all.filter(item => item.id !== task.id)
    const merged: TaskRecord = { ...previous, ...task, createdAt: previous?.createdAt ?? task.createdAt ?? Date.now(), updatedAt: Date.now() }
    list.unshift(merged)
    writeJson(file, list.slice(0, TASK_LIMIT))
    return merged
  }
  get(user: UserRef, id: string): TaskRecord | undefined { return readJson<TaskRecord[]>(this.file(user), []).find(item => item.id === id) }
  list(user: UserRef, filter: { app?: string; status?: TaskStatus } = {}): TaskRecord[] {
    return readJson<TaskRecord[]>(this.file(user), []).filter(item => (!filter.app || item.app === filter.app) && (!filter.status || item.status === filter.status))
  }
}

export interface ActivityEntry {
  at: string
  kind: 'call' | 'install' | 'denied' | 'invalid'
  origin: 'chat' | 'page'
  sessionId?: string
  app: string
  action: string
  args?: string
  result: string
  ok: boolean
  confirmed: boolean
}

// Message bodies and contact details never go into the activity log.
const HIDDEN_KEYS = /^(body|text|content|html|password|token|secret|attachment|file)$/i
export function summarizeArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {}, (key, value) => HIDDEN_KEYS.test(key) ? '[已省略]' : typeof value === 'string' ? value.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱]').replace(/1\d{10}/g, '[手机号]') : value)
  return text.length > 300 ? text.slice(0, 300) + '…' : text
}

/** Append-only record of every conversation call, per enterprise user, kept for 90 days. */
export class ActivityLog {
  constructor(private readonly root: string) {}
  private file(user: UserRef): string { const dir = folder(this.root, user); mkdirSync(dir, { recursive: true }); return join(dir, 'activity.jsonl') }
  append(user: UserRef, entry: ActivityEntry): void { appendFileSync(this.file(user), JSON.stringify(entry) + '\n') }
  list(user: UserRef, limit = 200): ActivityEntry[] {
    const file = this.file(user)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const entries: ActivityEntry[] = []
    for (const line of lines) { try { entries.push(JSON.parse(line)) } catch { /* a torn last line is skipped */ } }
    return entries.reverse().slice(0, limit)
  }
  /** Drop entries older than the retention period. */
  prune(user: UserRef, now = Date.now()): void {
    const file = this.file(user)
    if (!existsSync(file)) return
    const cutoff = now - ACTIVITY_DAYS * 864e5
    const kept = readFileSync(file, 'utf8').split('\n').filter(line => { try { return Date.parse(JSON.parse(line).at) >= cutoff } catch { return false } })
    writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '')
  }
}
