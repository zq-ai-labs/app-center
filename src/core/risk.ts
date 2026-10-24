import type { Risk } from './types.js'

export type RiskDecision = { kind: 'allow' } | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string }

export interface RiskInput {
  risk: Risk
  subagent: boolean
  /** Ask before draft actions too (setting; off by default because drafts are reviewed before sending). */
  confirmDrafts: boolean
  /** Ready-made confirmation text. */
  prompt: string
}

/** How one `app_call` is gated before it runs. */
export function decideRisk(input: RiskInput): RiskDecision {
  if (input.subagent && input.risk !== 'read') return { kind: 'deny', reason: '子任务只能执行只读动作；请在主对话中由用户发起。' }
  if (input.risk === 'read') return { kind: 'allow' }
  if (input.risk === 'draft') return input.confirmDrafts ? { kind: 'ask', reason: input.prompt } : { kind: 'allow' }
  return { kind: 'ask', reason: input.prompt }
}

/** Fill `{key}` placeholders of a confirmation template from the call arguments. */
export function fillTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = args[key]
    return value === undefined ? `{${key}}` : String(value).slice(0, 80)
  })
}
