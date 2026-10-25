/** Risk level of one action. Sending to the outside world has no level: such actions are refused at registration. */
export type Risk = 'read' | 'draft' | 'write'

/** The JSON Schema subset action parameters may use (validated by `schema.ts`). */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: (string | number | boolean)[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  maxItems?: number
  default?: unknown
  examples?: unknown[]
}

export interface ActionSpec {
  /** Prefer the shared verbs start / list / get / status; at most three other names per app. */
  name: string
  description: string
  whenToUse: string[]
  notFor?: string[]
  params: JsonSchema
  /** What users actually say. */
  examples: string[]
  risk: Risk
  /** A long task: the handler returns `task` at once and reports progress through `tasks.report`. */
  long?: boolean
  /** Confirmation text for write actions; `{name}` style placeholders are filled from the arguments. */
  confirmText?: string
  /** Former names that still resolve to this action. */
  aliases?: string[]
}

export interface AppManifest {
  /** Same as the catalog's `app.id`; independent of the package name. */
  id: string
  name: string
  category: string
  /** One line shared by the card and the skill catalog, at most 40 characters. */
  summary: string
  description?: string
  icon?: string
  version?: string
  askFirst?: string[]
  notFor?: string[]
  /** Main panel id of the app's own page. */
  page?: string
  actions: ActionSpec[]
}

/** Where a result can be opened: the app's page, optionally with a route inside it. */
export interface AppLink { app: string; page?: string; route?: string; label?: string }

export interface ActionResult {
  /** One or two sentences: the conclusion first. */
  summary: string
  items?: { title: string; detail?: string; link?: AppLink }[]
  task?: { id: string; etaMinutes?: number }
  link?: AppLink
  /** Text from outside (mail bodies, attachments): marked as such and never followed as instructions. */
  external?: string
  /** A draft: the result must say it has not been sent. */
  draft?: boolean
}

export interface UserRef { tenantId: string; userId: string; name?: string }

export interface ExecContext {
  sessionId?: string
  /** The call comes from a delegated agent rather than the user's own conversation. */
  subagent: boolean
  user: UserRef
  signal: AbortSignal
  /** The user approved this call (write actions and installs). */
  confirmed: boolean
  /** Where the call came from: the AI conversation or the app center page. */
  origin: 'chat' | 'page'
}

export type ActionHandler = (args: any, exec: ExecContext) => Promise<ActionResult>

export type TaskStatus = 'queued' | 'running' | 'needs-review' | 'done' | 'failed'

export interface TaskRecord {
  id: string
  app: string
  action: string
  status: TaskStatus
  title: string
  summary?: string
  link?: AppLink
  conversationId?: string
  tenantId: string
  userId: string
  createdAt: number
  updatedAt: number
}

/** What the page shows for one registered app. */
export interface AppView {
  id: string
  name: string
  category: string
  summary: string
  description?: string
  icon?: string
  version?: string
  page?: string
  /** Successful conversation calls on this machine. */
  usage: number
  actions: { name: string; description: string; risk: Risk; long: boolean }[]
}
