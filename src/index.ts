import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { API_PATH, createApi } from './api.js'
import { AppCenter } from './core/center.js'
import { appSkill, type AppSkill } from './core/skills.js'
import type { PluginCenterService, UserRef } from './core/types.js'
import { APP_CALL, appCallTool, callerOf, residentSpecs, residentTool, taskStatusTool, type ToolHost } from './tools.js'

export type { AppCenterService, CallOutcome } from './core/center.js'
export type * from './core/types.js'
export { AppCenter } from './core/center.js'
export { validateManifest, ManifestError } from './core/registry.js'
export { appSkill } from './core/skills.js'

export const name = 'bkms-app-center'

/** Plugin settings, edited on the XBuddy plugin page (labels in locale/*.json). */
export const Config = z.object({
  confirmDrafts: z.boolean().default(false).description('草稿类动作也先请用户确认（默认不确认：草稿发送前会在工作台人工审核）'),
  resident: z.array(z.string()).default(['mail.search']).description('同时注册为独立工具的只读动作，写成“应用.动作”，最多 5 个'),
  dataDir: z.string().default('').description('数据目录；留空使用 Profile 目录下的 .bkms-app-center'),
  // Trial mode: register the sample apps from demo/ (labelled 示例, sample data only) and, when no plugin center is
  // installed, a sample plugin center that installs the rest automatically. demo/ is not in the published package.
  sampleApps: z.boolean().default(false).description('试用模式：加载示例应用（只有示例数据，发布包中不可用）'),
})

export interface AppCenterConfig {
  confirmDrafts?: boolean
  resident?: string[]
  dataDir?: string
  sampleApps?: boolean
}

const LOCAL_USER: UserRef = { tenantId: 'local', userId: 'local', name: '本机用户' }

export function apply(ctx: any, config: AppCenterConfig = {}): void {
  // Cordis throws on reading an undeclared service property, so optional services are only read through `get`.
  const optional = (name: string): any => { try { return ctx.get?.(name) } catch { return undefined } }
  const profile = optional('profileContext')
  const base = profile?.dir || profile?.home || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  let pluginCenter: PluginCenterService | undefined
  let auth: any
  const log = (level: 'info' | 'warn', message: string) => {
    try { const logger = typeof ctx.logger === 'function' ? ctx.logger('bkms-app-center') : ctx.logger; logger?.[level]?.(message) } catch { /* no logger in this host */ }
  }
  const center = new AppCenter({
    dataDir: config.dataDir || join(base, '.bkms-app-center'),
    pluginCenter: () => pluginCenter,
    confirmDrafts: () => config.confirmDrafts === true,
    log,
  })
  // The enterprise login of @bkms/base; without it everything is kept under one local user.
  const user = (): UserRef => {
    const state = auth?.auth
    if (state?.phase === 'authenticated' && state.user?.tenantCode && state.user?.userId) return { tenantId: String(state.user.tenantCode), userId: String(state.user.userId), name: state.user.nickName || state.user.userName }
    return LOCAL_USER
  }
  const host: ToolHost = { center, user, resident: config.resident ?? ['mail.search'] }

  if (typeof ctx.provide === 'function') ctx.provide('appCenter', center.service())
  ctx.inject(['bkmsApi'], (child: any) => {
    auth = child.bkmsApi
    child.effect(() => () => { if (auth === child.bkmsApi) auth = undefined }, 'bkms-app-center: login binding')
  })
  ctx.inject(['bkmsPluginCenter'], (child: any) => {
    const service = child.bkmsPluginCenter as PluginCenterService
    pluginCenter = service
    void center.catalog(true)
    child.effect(() => () => { if (pluginCenter === service) pluginCenter = undefined }, 'bkms-app-center: plugin center binding')
  })

  // Conversation tools: app_call and task_status always, resident tools while their app is registered.
  ctx.inject(['tools'], (child: any) => {
    child.effect(() => child.tools.register(appCallTool(host)), 'bkms-app-center: app_call')
    child.effect(() => child.tools.register(taskStatusTool(host)), 'bkms-app-center: task_status')
    const resident = new Map<string, () => void>()
    const syncResident = () => {
      const wanted = new Map(residentSpecs(host).map(item => [`${item.manifest.id}.${item.spec.name}:${JSON.stringify(item.spec)}`, item]))
      for (const [key, dispose] of resident) if (!wanted.has(key)) { dispose(); resident.delete(key) }
      for (const [key, item] of wanted) if (!resident.has(key)) {
        try { resident.set(key, child.tools.register(residentTool(host, item.manifest, item.spec))) }
        catch (error) { log('warn', `app-center: resident tool ${key} not registered: ${error instanceof Error ? error.message : error}`) }
      }
    }
    child.effect(() => { syncResident(); const stop = center.registry.onChange(syncResident); return () => { stop(); for (const dispose of resident.values()) dispose(); resident.clear() } }, 'bkms-app-center: resident tools')
    // The risk gate: read runs, draft runs (or asks when configured), write asks, delegated agents only read.
    child.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      if (exec?.name !== APP_CALL) return next()
      const args = exec.arguments ?? {}
      const caller = callerOf(exec)
      const decision = await center.gate(args.app, args.action, args.args, caller.subagent)
      if (decision.kind === 'deny') { center.recordDenied(user(), caller.sessionId, args.app, args.action, args.args, decision.reason); return { kind: 'deny', reason: decision.reason } }
      if (decision.kind === 'ask') return { kind: 'ask', reason: decision.reason, displayReason: { en: decision.reason, zh: decision.reason } }
      return next()
    })
  })

  // Layers 0 and 1: one skill per registered app. The host keeps the catalog in every conversation and loads the body on
  // demand. Apps the plugin center is still installing get their skill when they register.
  ctx.inject(['skills'], (child: any) => {
    const registered = new Map<string, { key: string; dispose: () => void }>()
    const sync = () => {
      const skills = new Map<string, AppSkill>()
      for (const manifest of center.registry.list()) skills.set(manifest.id, appSkill(manifest))
      for (const [id, item] of registered) if (!skills.has(id)) { item.dispose(); registered.delete(id) }
      for (const [id, skill] of skills) {
        const key = JSON.stringify(skill)
        const current = registered.get(id)
        if (current?.key === key) continue
        current?.dispose()
        try { registered.set(id, { key, dispose: child.skills.register({ ...skill, source: 'runtime', invocation: { modelInvocable: true, userInvocable: true } }) }) }
        catch (error) { registered.delete(id); log('warn', `app-center: skill ${skill.name} not registered: ${error instanceof Error ? error.message : error}`) }
      }
    }
    child.effect(() => { sync(); const stop = center.onChange(sync); return () => { stop(); for (const item of registered.values()) item.dispose(); registered.clear() } }, 'bkms-app-center: app skills')
  })

  if (config.sampleApps) void loadSamples(center, () => pluginCenter, service => { pluginCenter ??= service; void center.catalog(true) }, log)

  ctx.inject(['connection'], (child: any) => {
    const handle = createApi({ center, user, hasPluginCenter: () => pluginCenter !== undefined })
    child.effect(() => child.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: handle }), 'bkms-app-center: page api')
  })
}

/** Trial mode (see `Config.sampleApps`): sample apps with sample data, every name and result marked as such. */
async function loadSamples(center: AppCenter, current: () => PluginCenterService | undefined, useCenter: (service: PluginCenterService) => void, log: (level: 'info' | 'warn', message: string) => void): Promise<void> {
  try {
    const apps: any = await import(new URL('../demo/apps.mjs', import.meta.url).href)
    const fake: any = await import(new URL('../demo/fake-host.mjs', import.meta.url).href)
    const service = center.service()
    const sample = {
      ...service,
      register(manifest: any, handlers: Record<string, any>) {
        const marked = { ...manifest, name: `${manifest.name}（示例）`, summary: `${manifest.summary}（示例）`, description: `示例应用，只有示例数据。${manifest.description ?? ''}` }
        const wrapped = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args: unknown, exec: unknown) => {
          const result = await handler(args, exec)
          return { ...result, summary: `【示例数据】${result.summary}` }
        }]))
        return service.register(marked, wrapped)
      },
    }
    let contract: any
    apps.registerMail(sample, { contract: () => contract })
    apps.registerBid(sample)
    if (!current()) {
      const catalog = apps.demoCatalog.map((entry: any) => ({ ...entry, name: `${entry.name}（示例）`, app: { ...entry.app, summary: `${entry.app.summary}（示例）` } }))
      // Like the real plugin center: apps not yet installed install by themselves shortly after start.
      useCenter(fake.createFakePluginCenter({ entries: catalog, autoInstall: ['contract', 'expense'], startDelayMs: 3000, stepMs: 700, onInstalled: (entry: any) => { if (entry.app.id === 'contract') contract = apps.registerContract(sample) } }))
    }
    log('info', 'app-center: sample apps registered (trial mode)')
  } catch (error) {
    log('warn', `app-center: sample apps unavailable: ${error instanceof Error ? error.message : error}`)
  }
}
