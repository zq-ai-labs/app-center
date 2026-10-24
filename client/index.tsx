import * as React from 'react'
import { AppCenterPage } from './page'
import { ToolCard } from './card'
import { host } from './lib'
// @ts-ignore CSS is bundled as a text module by scripts/build-client.mjs.
import stylesheet from './styles.css'

export { AppCenterPage, ToolCard }
export const PANEL_ID = 'bkms-app-center'
export const inject = ['slots']

function GridIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><path d="M17 13.5v7M13.5 17h7" />
  </svg>
}

/**
 * Presence of the app center in the browser. Apps inject it to know they are hosted here: while it exists they drop
 * their own left-menu entry (the app center lists them and opens their page); when it goes away the entry returns.
 */
export interface AppCenterPresence { readonly version: 1; readonly panel: string }

export function apply(ctx: any): void {
  if (typeof ctx.provide === 'function') ctx.provide('bkmsAppCenter', { version: 1, panel: PANEL_ID } satisfies AppCenterPresence)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'bkms-app-center'
    style.textContent = stylesheet
    document.head.appendChild(style)
    return () => style.remove()
  }, 'bkms-app-center: styles')
  // Opening an app's page and starting a conversation go through the host's layout and workspace services when present.
  ctx.effect(() => {
    host.openPanel = (id: string) => { const layout = ctx.get?.('layout'); layout?.selectPanel?.(id) }
    // The composer prefill is not exposed to plugins yet (待验证 V3); the page tells the user what to type.
    host.startChat = () => {
      const workspace = ctx.get?.('uiWorkspace')
      if (typeof workspace?.startSession !== 'function') return false
      workspace.startSession()
      return true
    }
    return () => { host.openPanel = undefined; host.startChat = undefined }
  }, 'bkms-app-center: host navigation')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, AppCenterPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: -20, label: () => '应用中心' }, GridIcon))
  // Result cards for the conversation tools.
  ctx.slots.inject('tool.call.toolview', () => {
    const disposers = ['app_call', 'task_status', 'mail_search'].map(key => ctx.slots.register({ name: 'tool.call.toolview', key }, ToolCard))
    return () => { for (const dispose of disposers) dispose?.() }
  })
}
