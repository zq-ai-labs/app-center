import type { ActionHandler, ActionSpec, AppManifest, Risk } from './types.js'

export const SHARED_VERBS = ['start', 'list', 'get', 'status']
export const RESERVED_ACTIONS = ['install']
const MAX_CUSTOM_ACTIONS = 3
export const SUMMARY_MAX = 40
const APP_ID = /^[a-z][a-z0-9-]{1,31}$/
const ACTION_NAME = /^[a-z][a-z0-9_]{0,39}$/
// Sending to the outside world never becomes an action; drafts go to the workbench review instead.
const SENDING = /(?:^|_)(?:send|forward|publish|post|deliver|dispatch|broadcast|email|sms|wechat)(?:_|$)/
const RISKS: Risk[] = ['read', 'draft', 'write']

export class ManifestError extends Error {}

export const textLength = (text: string): number => Array.from(text).length

/** Reject manifests that break the integration rules; returns the manifest unchanged when valid. */
export function validateManifest(manifest: AppManifest, handlers: Record<string, ActionHandler>): AppManifest {
  const fail = (message: string): never => { throw new ManifestError(`应用 ${manifest?.id ?? '?'} 登记失败：${message}`) }
  if (!manifest || typeof manifest !== 'object') fail('清单无效')
  if (typeof manifest.id !== 'string' || !APP_ID.test(manifest.id)) fail('id 只能用小写字母、数字和连字符，2–32 个字符')
  for (const key of ['name', 'category', 'summary'] as const) if (typeof manifest[key] !== 'string' || !manifest[key].trim()) fail(`缺少 ${key}`)
  if (textLength(manifest.summary) > SUMMARY_MAX) fail(`summary 不能超过 ${SUMMARY_MAX} 个字`)
  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0) fail('至少要有一个动作')
  const names = new Set<string>()
  let custom = 0
  for (const action of manifest.actions) {
    if (typeof action?.name !== 'string' || !ACTION_NAME.test(action.name)) fail(`动作名 ${action?.name} 无效`)
    if (RESERVED_ACTIONS.includes(action.name)) fail(`动作名 ${action.name} 为保留名`)
    if (SENDING.test(action.name)) fail(`不允许登记对外发送类动作 ${action.name}，要发送的内容请交给工作台“待我决策”`)
    if (!RISKS.includes(action.risk)) fail(`动作 ${action.name} 的风险级别必须是 read / draft / write`)
    if (!action.description?.trim()) fail(`动作 ${action.name} 缺少说明`)
    if (!Array.isArray(action.whenToUse) || action.whenToUse.length === 0) fail(`动作 ${action.name} 要写什么时候用`)
    if (!Array.isArray(action.examples) || action.examples.length === 0) fail(`动作 ${action.name} 要给出用户原话示例`)
    if (!action.params || action.params.type !== 'object') fail(`动作 ${action.name} 的参数必须是 object schema`)
    if (typeof handlers[action.name] !== 'function') fail(`动作 ${action.name} 没有处理函数`)
    for (const name of [action.name, ...(action.aliases ?? [])]) {
      if (names.has(name)) fail(`动作名或别名 ${name} 重复`)
      names.add(name)
    }
    if (!SHARED_VERBS.includes(action.name)) custom++
  }
  if (custom > MAX_CUSTOM_ACTIONS) fail(`专有动作最多 ${MAX_CUSTOM_ACTIONS} 个，其余请用 start / list / get / status`)
  return manifest
}

interface Entry { manifest: AppManifest; handlers: Record<string, ActionHandler>; registeredAt: number; token: symbol }

/** Apps registered at runtime by their plugins. */
export class AppRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()

  register(manifest: AppManifest, handlers: Record<string, ActionHandler>): () => void {
    validateManifest(manifest, handlers)
    // A newer copy of the same app (an upgrade, a reload) replaces the old one.
    const entry: Entry = { manifest: structuredClone(manifest), handlers: { ...handlers }, registeredAt: Date.now(), token: Symbol(manifest.id) }
    this.entries.set(manifest.id, entry)
    this.emit()
    return () => {
      if (this.entries.get(manifest.id)?.token !== entry.token) return
      this.entries.delete(manifest.id)
      this.emit()
    }
  }

  get(id: string): AppManifest | undefined { return this.entries.get(id)?.manifest }
  list(): AppManifest[] { return [...this.entries.values()].map(entry => entry.manifest).sort((a, b) => a.id.localeCompare(b.id)) }
  has(id: string): boolean { return this.entries.has(id) }

  /** Find an action by its current name or a former one. */
  resolve(appId: string, action: string): { manifest: AppManifest; spec: ActionSpec; handler: ActionHandler; renamedFrom?: string } | undefined {
    const entry = this.entries.get(appId)
    if (!entry) return undefined
    const spec = entry.manifest.actions.find(item => item.name === action) ?? entry.manifest.actions.find(item => item.aliases?.includes(action))
    if (!spec) return undefined
    return { manifest: entry.manifest, spec, handler: entry.handlers[spec.name], ...(spec.name !== action ? { renamedFrom: action } : {}) }
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Resolve once the app is registered, or `false` after the timeout. */
  waitFor(id: string, timeoutMs: number): Promise<boolean> {
    if (this.has(id)) return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimeout(() => { stop(); resolve(false) }, timeoutMs)
      const stop = this.onChange(() => { if (this.has(id)) { clearTimeout(timer); stop(); resolve(true) } })
    })
  }
  private emit(): void { for (const listener of [...this.listeners]) { try { listener() } catch { /* one listener cannot block the others */ } } }
}
