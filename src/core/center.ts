import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppRegistry } from './registry.js'
import { decideRisk, fillTemplate, type RiskDecision } from './risk.js'
import { describeParams, exampleArgs, validate } from './schema.js'
import { formatSize, skillName } from './skills.js'
import { ActivityLog, summarizeArgs, TaskIndex } from './store.js'
import type { ActionHandler, ActionResult, AppManifest, AppView, CatalogEntry, ExecContext, InstallProgress, PluginCenterService, TaskRecord, UserRef } from './types.js'

export type CallOutcome =
  | { ok: true; app: string; appName: string; action: string; result: ActionResult; renamedFrom?: string; page?: string }
  | { ok: false; app: string; action: string; code: 'unknown_app' | 'not_installed' | 'unknown_action' | 'invalid_args' | 'denied' | 'failed' | 'install_failed'; error: string; usage?: string[]; example?: unknown }

export interface AppCenterOptions {
  dataDir: string
  pluginCenter: () => PluginCenterService | undefined
  confirmDrafts?: () => boolean
  log?: (level: 'info' | 'warn', message: string) => void
  installTimeoutMs?: number
  registrationTimeoutMs?: number
  pollMs?: number
  catalogTtlMs?: number
}

/** The public `appCenter` service other plugins inject. */
export interface AppCenterService {
  readonly version: 1
  register(manifest: AppManifest, handlers: Record<string, ActionHandler>): () => void
  list(): { id: string; name: string; summary: string }[]
  call(appId: string, action: string, args: unknown, exec: ExecContext): Promise<CallOutcome>
  tasks: { report(task: TaskRecord): TaskRecord; get(user: UserRef, id: string): TaskRecord | undefined }
}

const compareVersions = (a = '', b = ''): number => {
  const parse = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1, 4).map(Number)
  const x = parse(a), y = parse(b)
  if (x.length < 3 || y.length < 3) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}
const describe = (entry: CatalogEntry): string | undefined => typeof entry.description === 'string' ? entry.description : entry.description?.zh ?? entry.description?.en

/** The app center: registry, catalog merge, conversation calls, installs, tasks and the activity log. */
export class AppCenter {
  readonly registry = new AppRegistry()
  readonly tasks: TaskIndex
  readonly activity: ActivityLog
  private catalogEntries: CatalogEntry[] = []
  private catalogAt = 0
  private catalogLoading: Promise<CatalogEntry[]> | undefined
  catalogError = ''
  private readonly progress = new Map<string, InstallProgress>()
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

  /** App entries of the central catalog (already filtered by role on the server). */
  async catalog(force = false): Promise<CatalogEntry[]> {
    const center = this.options.pluginCenter()
    if (!center) return this.catalogEntries = []
    if (!force && Date.now() - this.catalogAt < (this.options.catalogTtlMs ?? 300_000)) return this.catalogEntries
    this.catalogLoading ??= center.catalog().then(result => {
      const before = JSON.stringify(this.catalogEntries)
      this.catalogEntries = result.plugins.filter(entry => entry?.app?.id && entry.packageName && entry.url)
      this.catalogAt = Date.now(); this.catalogError = ''
      if (JSON.stringify(this.catalogEntries) !== before) this.emit()
      return this.catalogEntries
    }, error => {
      this.catalogError = error instanceof Error ? error.message : String(error)
      this.options.log?.('warn', `app-center: catalog unavailable: ${this.catalogError}`)
      return this.catalogEntries
    }).finally(() => { this.catalogLoading = undefined })
    return this.catalogLoading
  }
  /** The last catalog read, without waiting (for synchronous consumers such as the skill sync). */
  cachedCatalog(): CatalogEntry[] { return this.catalogEntries }

  /** Everything the page and the skill catalog show, in a fixed order. */
  views(entries = this.catalogEntries): AppView[] {
    const byId = new Map<string, AppView>()
    for (const manifest of this.registry.list()) {
      byId.set(manifest.id, {
        id: manifest.id, name: manifest.name, category: manifest.category, summary: manifest.summary, description: manifest.description, icon: manifest.icon,
        state: 'installed', version: manifest.version, permissions: [], page: manifest.page, usage: this.usage[manifest.id] ?? 0,
        actions: manifest.actions.map(action => ({ name: action.name, description: action.description, risk: action.risk, long: !!action.long })),
      })
    }
    for (const entry of entries) {
      const app = entry.app!
      const latest = entry.artifact?.version ?? entry.version
      const existing = byId.get(app.id)
      const shared = { latestVersion: latest, size: entry.artifact?.size, permissions: app.permissions ?? [], restart: entry.artifact?.restart?.mode, changelog: app.changelog, packageName: entry.packageName, usage: entry.usage ?? existing?.usage ?? 0 }
      if (existing) {
        Object.assign(existing, shared, { icon: existing.icon ?? app.icon, state: compareVersions(latest, existing.version) > 0 ? 'update' : 'installed' })
      } else {
        byId.set(app.id, { id: app.id, name: entry.name, category: app.category, summary: app.summary, description: describe(entry), icon: app.icon, state: 'installable', actions: [], ...shared })
      }
    }
    for (const view of byId.values()) {
      const progress = this.progress.get(view.id)
      if (progress) {
        view.progress = progress
        if (!['done', 'failed'].includes(progress.phase)) view.state = 'installing'
        // Installed but only usable after a refresh or restart: not installable again, not usable yet.
        else if (progress.phase === 'done' && progress.effect && progress.effect !== 'none' && view.state === 'installable') view.state = 'pending'
      }
    }
    return [...byId.values()].sort((a, b) => a.category.localeCompare(b.category, 'zh') || a.name.localeCompare(b.name, 'zh'))
  }

  /** The gate for one conversation call, before it runs. */
  async gate(appId: string, action: string, args: unknown, subagent: boolean): Promise<RiskDecision> {
    const confirmDrafts = this.options.confirmDrafts?.() ?? false
    if (action === 'install') {
      if (this.registry.has(appId)) return { kind: 'allow' }
      const entry = (await this.catalog()).find(item => item.app?.id === appId)
      if (!entry) return { kind: 'allow' } // The call itself explains that the app is unavailable.
      const effect = entry.artifact?.restart?.mode === 'restart' ? '安装后需要重启 XBuddy' : entry.artifact?.restart?.mode === 'reload' ? '安装后需要刷新界面' : '安装后无需重启'
      const size = entry.artifact?.size ? `，约 ${formatSize(entry.artifact.size)}` : ''
      const permissions = entry.app?.permissions?.length ? `；需要权限：${entry.app.permissions.join('、')}` : ''
      return decideRisk({ risk: 'install', subagent, confirmDrafts, prompt: `安装应用“${entry.name}”${size}${permissions}；${effect}。` })
    }
    const resolved = this.registry.resolve(appId, action)
    if (!resolved) return { kind: 'allow' }
    const record = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    const prompt = resolved.spec.confirmText ? fillTemplate(resolved.spec.confirmText, record) : `${resolved.manifest.name}：${resolved.spec.description}`
    return decideRisk({ risk: resolved.spec.risk, subagent, confirmDrafts, prompt })
  }

  /** Run one action (or the reserved install). Never throws: problems come back as guidance the model can act on. */
  async call(appId: string, action: string, rawArgs: unknown, exec: ExecContext): Promise<CallOutcome> {
    const args = rawArgs ?? {}
    const startedAt = new Date().toISOString()
    const outcome = await this.run(appId, action, args, exec)
    try {
      this.activity.append(exec.user, {
        at: startedAt, kind: action === 'install' ? 'install' : outcome.ok ? 'call' : outcome.code === 'denied' ? 'denied' : outcome.code === 'invalid_args' ? 'invalid' : 'call',
        origin: exec.origin, sessionId: exec.sessionId, app: appId, action: outcome.ok ? outcome.action : action, args: summarizeArgs(args),
        result: outcome.ok ? outcome.result.summary.slice(0, 200) : outcome.error, ok: outcome.ok, confirmed: exec.confirmed,
      })
    } catch (error) { this.options.log?.('warn', `app-center: activity not recorded: ${error instanceof Error ? error.message : error}`) }
    if (outcome.ok && action !== 'install') { this.usage[appId] = (this.usage[appId] ?? 0) + 1; try { writeFileSync(this.usageFile, JSON.stringify(this.usage)) } catch { /* counts are best effort */ } }
    return outcome
  }

  private async run(appId: string, action: string, args: unknown, exec: ExecContext): Promise<CallOutcome> {
    if (typeof appId !== 'string' || !appId) return { ok: false, app: String(appId), action, code: 'unknown_app', error: '需要指定应用 id（技能目录里 app-<id> 的 <id> 部分）。' }
    if (action === 'install') return this.install(appId, exec)
    const manifest = this.registry.get(appId)
    if (!manifest) {
      const entry = (await this.catalog()).find(item => item.app?.id === appId)
      if (entry) return { ok: false, app: appId, action, code: 'not_installed', error: `应用“${entry.name}”尚未安装${entry.artifact?.size ? `（约 ${formatSize(entry.artifact.size)}）` : ''}。请先征得用户同意，再调用 app_call({ app: "${appId}", action: "install" })。` }
      const known = this.registry.list().map(item => item.id).join('、')
      return { ok: false, app: appId, action, code: 'unknown_app', error: `没有 id 为 ${appId} 的应用，或当前用户没有权限。已安装的应用：${known || '无'}。` }
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

  installProgress(appId: string): InstallProgress | undefined { return this.progress.get(appId) }
  private setProgress(appId: string, progress: InstallProgress): void { this.progress.set(appId, progress); this.emit() }

  /** Install an app through the plugin center and wait until it registers (or say what else is needed). */
  async install(appId: string, exec: ExecContext): Promise<CallOutcome> {
    const fail = (code: 'denied' | 'install_failed' | 'unknown_app', error: string): CallOutcome => ({ ok: false, app: appId, action: 'install', code, error })
    if (this.registry.has(appId)) {
      const manifest = this.registry.get(appId)!
      return { ok: true, app: appId, appName: manifest.name, action: 'install', page: manifest.page, result: { summary: `“${manifest.name}”已经安装，可以直接使用。用法见技能 ${skillName(appId)}。` } }
    }
    if (exec.subagent) return fail('denied', '子任务不能安装应用。')
    const entry = (await this.catalog()).find(item => item.app?.id === appId)
    if (!entry) return fail('unknown_app', `应用目录里没有 ${appId}，或当前用户没有权限安装。`)
    if (!exec.confirmed) return fail('denied', '安装应用需要用户确认。')
    const center = this.options.pluginCenter()
    if (!center) return fail('install_failed', '当前客户端没有插件中心服务，无法安装应用。请联系管理员。')
    const active = this.progress.get(appId)
    if (active && !['done', 'failed'].includes(active.phase)) return fail('install_failed', `“${entry.name}”正在安装中，请稍候。`)
    this.setProgress(appId, { phase: 'queued', total: entry.artifact?.size })
    try {
      await center.install(entry.url)
      const deadline = Date.now() + (this.options.installTimeoutMs ?? 180_000)
      let since = 0
      for (;;) {
        if (exec.signal.aborted) throw new Error('已取消')
        const status = center.status(since) ?? {}
        const row = status.progress?.[entry.packageName]
        if (row) this.setProgress(appId, { phase: row.phase === 'done' ? 'waiting' : row.phase, received: row.received, total: row.total ?? entry.artifact?.size, message: row.error || row.detail })
        if (row?.phase === 'failed') throw new Error(row.error || '安装失败')
        if (row?.phase === 'done') {
          const notice = (status.notices ?? []).find((item: any) => item.items?.some((it: any) => it.packageName === entry.packageName))
          const effect: 'none' | 'reload' | 'restart' = notice?.kind === 'restart' ? 'restart' : notice?.kind === 'reload' ? 'reload' : 'none'
          if (effect !== 'none') {
            this.setProgress(appId, { phase: 'done', effect })
            return { ok: true, app: appId, appName: entry.name, action: 'install', result: { summary: effect === 'restart' ? `“${entry.name}”已安装，重启 XBuddy 后可用。` : `“${entry.name}”已安装，刷新界面后可用。` } }
          }
          const ready = await this.registry.waitFor(appId, this.options.registrationTimeoutMs ?? 10_000)
          this.setProgress(appId, { phase: 'done', effect: 'none' })
          if (!ready) return { ok: true, app: appId, appName: entry.name, action: 'install', result: { summary: `“${entry.name}”已安装，但还没有完成加载。请稍后再试，或刷新界面。` } }
          const manifest = this.registry.get(appId)!
          return { ok: true, app: appId, appName: manifest.name, action: 'install', page: manifest.page, result: { summary: `“${manifest.name}”已安装，可以在当前对话继续使用。先加载技能 ${skillName(appId)} 查看用法。` } }
        }
        if (Date.now() > deadline) throw new Error('安装超时（3 分钟）')
        since = Date.now()
        await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 1000))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setProgress(appId, { phase: 'failed', message })
      return fail('install_failed', `“${entry.name}”安装失败：${message}。可以到应用中心页面重试。`)
    }
  }
}
