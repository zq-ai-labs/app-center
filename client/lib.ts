export type Risk = 'read' | 'draft' | 'write'
export type AppState = 'installed' | 'installable' | 'update' | 'installing' | 'pending'
export interface InstallProgress { phase: string; received?: number; total?: number; message?: string; effect?: 'none' | 'reload' | 'restart' }
export interface AppView {
  id: string; name: string; category: string; summary: string; description?: string; icon?: string
  state: AppState; version?: string; latestVersion?: string; size?: number; permissions: string[]; restart?: string
  changelog?: string; usage?: number; page?: string; packageName?: string
  actions: { name: string; description: string; risk: Risk; long: boolean }[]
  progress?: InstallProgress
}
export interface AppsResponse { apps: AppView[]; canInstall: boolean; catalogError: string; user: { tenantId: string; name: string } }
export interface AppLink { app: string; page?: string; route?: string; label?: string }
export interface TaskRecord { id: string; app: string; action: string; status: string; title: string; summary?: string; link?: AppLink; createdAt: number; updatedAt: number }
export interface ActivityEntry { at: string; kind: string; origin: string; app: string; action: string; args?: string; result: string; ok: boolean; confirmed: boolean }

/** Native hosts may own the authenticated HTTP carrier; keep the route relative to the host's base. */
function hostFetch(input: string, init: RequestInit): Promise<Response> {
  const transport = (globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }).__DSH_TRANSPORT__?.fetch
  return (transport || globalThis.fetch)(input, init)
}

export async function api<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await hostFetch('api/bkms-app-center', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-bkms-app-center': '1' },
    body: JSON.stringify({ ...payload, action }),
  })
  let body: any
  try { body = await response.json() } catch { throw new Error(`应用中心服务暂时不可用（${response.status}）`) }
  if (!response.ok || body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : `操作失败（${response.status}）`)
  return body.value as T
}

export function formatSize(bytes?: number): string {
  if (!bytes) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export const RISK_LABEL: Record<Risk, string> = { read: '只读', draft: '草稿', write: '需确认' }
export const STATE_LABEL: Record<AppState, string> = { installed: '已安装', installable: '可安装', update: '有更新', installing: '安装中', pending: '待生效' }
export const TASK_LABEL: Record<string, string> = { queued: '排队中', running: '进行中', 'needs-review': '待审核', done: '已完成', failed: '失败' }
export const PHASE_LABEL: Record<string, string> = { queued: '排队中', downloading: '下载中', installing: '安装中', applying: '启用中', waiting: '等待加载', done: '已完成', failed: '失败' }

/** Host navigation, bound when the client plugin starts. */
export const host: { openPanel?: (id: string) => void; startChat?: (text: string) => boolean } = {}
// startChat returns whether a new conversation was opened.

export function openApp(link: AppLink | { page?: string } | null | undefined): boolean {
  if (!link?.page || !host.openPanel) return false
  host.openPanel(link.page)
  return true
}
