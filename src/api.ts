import type { AppCenter } from './core/center.js'
import { appSkill, installableSkill } from './core/skills.js'
import type { TaskStatus, UserRef } from './core/types.js'

export const API_PATH = '/api/bkms-app-center'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export interface ApiHost {
  center: AppCenter
  user(): UserRef
  /** Whether installs are possible (the plugin center service is present). */
  canInstall(): boolean
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
      return { apps: center.views(entries), canInstall: host.canInstall(), catalogError: center.catalogError, user: { tenantId: user.tenantId, name: user.name ?? user.userId } }
    }
    case 'app': {
      const view = center.views().find(item => item.id === body.id)
      if (!view) throw new Error('应用不存在或没有权限。')
      const manifest = center.registry.get(view.id)
      // The guide the AI loads for this app, so users can see what the conversation knows.
      const skill = manifest ? appSkill(manifest) : installableSkill(view)
      return { app: view, skill }
    }
    case 'install': {
      if (typeof body.id !== 'string') throw new Error('需要应用 id。')
      // The click is the user's confirmation; the install runs on and the page polls `apps` for progress.
      void center.call(body.id, 'install', {}, { user, subagent: false, confirmed: true, origin: 'page', signal: new AbortController().signal })
      return { started: true }
    }
    case 'tasks': return { tasks: center.tasks.list(user, { app: typeof body.app === 'string' ? body.app : undefined, status: typeof body.status === 'string' ? body.status as TaskStatus : undefined }) }
    case 'activity': return { activity: center.activity.list(user, 200) }
    default: throw new Error('不支持的操作。')
  }
}
