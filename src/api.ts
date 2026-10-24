import type { AppCenter } from './core/center.js'
import { appSkill } from './core/skills.js'
import type { TaskStatus, UserRef } from './core/types.js'

export const API_PATH = '/api/bkms-app-center'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export interface ApiHost {
  center: AppCenter
  user(): UserRef
  /** Whether the plugin center service is present (it installs and upgrades every app). */
  hasPluginCenter(): boolean
}

/** The page's single JSON endpoint: `{ action, ... }` in, `{ ok, value | error }` out. */
export function createApi(host: ApiHost) {
  return async function handle(request: Request): Promise<Response> {
    // A JSON body with our own header cannot be sent cross-site without a preflight.
    if (request.method !== 'POST' || request.headers.get('x-bkms-app-center') !== '1' || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      return json(403, { ok: false, error: '请从应用中心页面发起操作。' })
    }
    let body: any
    try { body = await request.json() } catch { return json(400, { ok: false, error: '请求内容不是有效的 JSON。' }) }
    try { return json(200, { ok: true, value: await dispatch(host, body ?? {}) }) }
    catch (error) { return json(400, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }
}

async function dispatch(host: ApiHost, body: any): Promise<unknown> {
  const { center } = host
  const user = host.user()
  switch (body.action) {
    case 'apps': {
      const entries = await center.catalog(body.refresh === true)
      return { apps: center.views(entries), pluginCenter: host.hasPluginCenter(), catalogError: center.catalogError, user: { tenantId: user.tenantId, name: user.name ?? user.userId } }
    }
    case 'app': {
      const view = center.views().find(item => item.id === body.id)
      if (!view) throw new Error('应用不存在或没有权限。')
      const manifest = center.registry.get(view.id)
      // The guide the AI loads for this app; apps not installed yet have none.
      return { app: view, skill: manifest ? appSkill(manifest) : null }
    }
    case 'retry': {
      // Installs are the plugin center's; the page can only ask it to try a failed one again.
      if (typeof body.id !== 'string') throw new Error('需要应用 id。')
      await center.retry(body.id)
      return { retried: true }
    }
    case 'tasks': return { tasks: center.tasks.list(user, { app: typeof body.app === 'string' ? body.app : undefined, status: typeof body.status === 'string' ? body.status as TaskStatus : undefined }) }
    case 'activity': return { activity: center.activity.list(user, 200) }
    default: throw new Error('不支持的操作。')
  }
}
