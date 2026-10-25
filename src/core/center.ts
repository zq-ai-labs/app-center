import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppRegistry } from './registry.js'
import { decideRisk, fillTemplate, type RiskDecision } from './risk.js'
import { describeParams, exampleArgs, validate } from './schema.js'
import { skillName } from './skills.js'
import { ActivityLog, summarizeArgs, TaskIndex } from './store.js'
import type { ActionHandler, ActionResult, AppManifest, AppView, ExecContext, TaskRecord, UserRef } from './types.js'

export type CallOutcome =
  | { ok: true; app: string; appName: string; action: string; result: ActionResult; renamedFrom?: string; page?: string }
  | { ok: false; app: string; action: string; code: 'unknown_app' | 'unknown_action' | 'invalid_args' | 'denied' | 'failed'; error: string; usage?: string[]; example?: unknown }

export interface AppCenterOptions {
  dataDir: string
  confirmDrafts?: () => boolean
  log?: (level: 'info' | 'warn', message: string) => void
}

/** The public `appCenter` service other plugins inject. */
export interface AppCenterService {
  readonly version: 1
  register(manifest: AppManifest, handlers: Record<string, ActionHandler>): () => void
  list(): { id: string; name: string; summary: string }[]
  call(appId: string, action: string, args: unknown, exec: ExecContext): Promise<CallOutcome>
  tasks: { report(task: TaskRecord): TaskRecord; get(user: UserRef, id: string): TaskRecord | undefined }
}

/**
 * The app center is a frame: it lists the apps that registered with it, gives them to the conversation, and keeps
 * tasks and the activity log. It knows nothing about installing: an app appears when its plugin is installed and
 * registers, and disappears when the plugin goes away. No apps means an empty app center.
 */
export class AppCenter {
  readonly registry = new AppRegistry()
  readonly tasks: TaskIndex
  readonly activity: ActivityLog
  private readonly listeners = new Set<() => void>()
  private usage: Record<string, number>
  private readonly usageFile: string

  constructor(private readonly options: AppCenterOptions) {
    mkdirSync(options.dataDir, { recursive: true })
    this.tasks = new TaskIndex(join(options.dataDir, 'users'))
    this.activity = new ActivityLog(join(options.dataDir, 'users'))
    this.usageFile = join(options.dataDir, 'usage.json')
    try { this.usage = JSON.parse(readFileSync(this.usageFile, 'utf8')) } catch { this.usage = {} }
    this.registry.onChange(() => this.emit())
  }

  service(): AppCenterService {
    return {
      version: 1,
      register: (manifest, handlers) => this.registry.register(manifest, handlers),
      list: () => this.registry.list().map(({ id, name, summary }) => ({ id, name, summary })),
      call: (appId, action, args, exec) => this.call(appId, action, args, exec),
      tasks: { report: task => { const saved = this.tasks.report(task); this.emit(); return saved }, get: (user, id) => this.tasks.get(user, id) },
    }
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of [...this.listeners]) { try { listener() } catch { /* contained */ } } }

  /** The registered apps, in a fixed order (category, then name). */
  views(): AppView[] {
    return this.registry.list().map(manifest => ({
      id: manifest.id, name: manifest.name, category: manifest.category, summary: manifest.summary, description: manifest.description, icon: manifest.icon,
      version: manifest.version, page: manifest.page, usage: this.usage[manifest.id] ?? 0,
      actions: manifest.actions.map(action => ({ name: action.name, description: action.description, risk: action.risk, long: !!action.long })),
    })).sort((a, b) => a.category.localeCompare(b.category, 'zh') || a.name.localeCompare(b.name, 'zh'))
  }

  /** The gate for one conversation call, before it runs. */
  async gate(appId: string, action: string, args: unknown, subagent: boolean): Promise<RiskDecision> {
    const confirmDrafts = this.options.confirmDrafts?.() ?? false
    const resolved = this.registry.resolve(appId, action)
    if (!resolved) return { kind: 'allow' }
    const record = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    const prompt = resolved.spec.confirmText ? fillTemplate(resolved.spec.confirmText, record) : `${resolved.manifest.name}：${resolved.spec.description}`
    return decideRisk({ risk: resolved.spec.risk, subagent, confirmDrafts, prompt })
  }

  /** Run one action. Never throws: problems come back as guidance the model can act on. */
  async call(appId: string, action: string, rawArgs: unknown, exec: ExecContext): Promise<CallOutcome> {
    const args = rawArgs ?? {}
    const startedAt = new Date().toISOString()
    const outcome = await this.run(appId, action, args, exec)
    try {
      this.activity.append(exec.user, {
        at: startedAt, kind: outcome.ok ? 'call' : outcome.code === 'denied' ? 'denied' : outcome.code === 'invalid_args' ? 'invalid' : 'call',
        origin: exec.origin, sessionId: exec.sessionId, app: appId, action: outcome.ok ? outcome.action : action, args: summarizeArgs(args),
        result: outcome.ok ? outcome.result.summary.slice(0, 200) : outcome.error, ok: outcome.ok, confirmed: exec.confirmed,
      })
    } catch (error) { this.options.log?.('warn', `app-center: activity not recorded: ${error instanceof Error ? error.message : error}`) }
    if (outcome.ok) { this.usage[appId] = (this.usage[appId] ?? 0) + 1; try { writeFileSync(this.usageFile, JSON.stringify(this.usage)) } catch { /* counts are best effort */ } }
    return outcome
  }

  private async run(appId: string, action: string, args: unknown, exec: ExecContext): Promise<CallOutcome> {
    if (typeof appId !== 'string' || !appId) return { ok: false, app: String(appId), action, code: 'unknown_app', error: '需要指定应用 id（技能目录里 app-<id> 的 <id> 部分）。' }
    const manifest = this.registry.get(appId)
    if (!manifest) {
      const known = this.registry.list().map(item => item.id).join('、')
      return { ok: false, app: appId, action, code: 'unknown_app', error: `没有 id 为 ${appId} 的应用（可能还没有安装），或当前用户没有权限。已安装的应用：${known || '无'}。` }
    }
    const resolved = this.registry.resolve(appId, action)
    if (!resolved) return { ok: false, app: appId, action, code: 'unknown_action', error: `应用“${manifest.name}”没有动作 ${action}。可用动作：${manifest.actions.map(item => item.name).join('、')}。先加载技能 ${skillName(appId)} 查看用法。` }
    const { spec, handler } = resolved
    const decision = await this.gate(appId, spec.name, args, exec.subagent)
    if (decision.kind === 'deny') return { ok: false, app: appId, action: spec.name, code: 'denied', error: decision.reason }
    if (decision.kind === 'ask' && !exec.confirmed) return { ok: false, app: appId, action: spec.name, code: 'denied', error: '这个动作需要用户确认后才能执行。' }
    const problems = validate(spec.params, args)
    if (problems.length) return { ok: false, app: appId, action: spec.name, code: 'invalid_args', error: `参数不正确：${problems.join('；')}。`, usage: describeParams(spec.params), example: exampleArgs(spec.params) }
    try {
      const result = await handler(args, exec)
      if (!result || typeof result.summary !== 'string') throw new Error('应用没有返回结论')
      return { ok: true, app: appId, appName: manifest.name, action: spec.name, result, page: manifest.page, ...(resolved.renamedFrom ? { renamedFrom: resolved.renamedFrom } : {}) }
    } catch (error) {
      return { ok: false, app: appId, action: spec.name, code: 'failed', error: `“${manifest.name}”执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Record a call the gate refused before it reached `call` (it still belongs in the activity log). */
  recordDenied(user: UserRef, sessionId: string | undefined, appId: string, action: string, args: unknown, reason: string): void {
    try { this.activity.append(user, { at: new Date().toISOString(), kind: 'denied', origin: 'chat', sessionId, app: String(appId), action: String(action), args: summarizeArgs(args), result: reason, ok: false, confirmed: false }) }
    catch (error) { this.options.log?.('warn', `app-center: activity not recorded: ${error instanceof Error ? error.message : error}`) }
  }

}
