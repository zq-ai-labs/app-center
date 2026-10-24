# BKMS 应用中心技术方案

Oct 24, 2026 · @sub.maureen

> 修订（2026-10-24）：对照 xbuddy（DSH）、bkms-workbench、xbuddy-bid-writer、bkms-plugin-center 源码和桌面 Profile 调整。主要变化：第 0、1 层改用 DSH 技能机制，去掉 `app_guide` 和自拼 `systemPrompt.section`；风险拦截改用 `tools/pre-execute` 的 `ask`；身份和角色复用 `@bkms/base`；版本兼容交给 DSH 的 peer 检查；回滚改为发修复版；补充工具可见范围、数据位置、依赖打包和首批应用的实际改动量。与现有代码的冲突和待验证项见文末两节。

## 结论与总体架构

新建一个独立插件 `@bkms/app-center`（应用中心），负责面向用户的应用目录、应用登记和 AI 对话集成；安装和升级全部复用现有的 `@bkms/plugin-center`，不重做。

- **不合并的原因**：plugin-center 是分发底座，管所有插件、要稳定，升级自己总要重启；应用中心跟着业务频繁改动，而且会被 AI 调用。分开后 AI 只能通过一个窄接口请求安装。DSH 自带的 `plugin_manager` 工具在桌面版主对话中已禁用，需保持禁用。
- **对话侧**：每个应用登记为一个 DSH 技能（第 0、1 层），只注册 2 个通用工具 `app_call`、`task_status`（第 2 层）。应用再多也不增加常驻工具。
- **应用侧**：合同、标书、业务邮件各自是 DSH 插件，有自己的页面和后台任务，运行时向应用中心登记动作。
- **身份**：用户和角色来自已预装的 `@bkms/base`（企业登录），不另建身份体系。
- **改动量**：plugin-center 加一个对外服务（约几十行）；中心服务目录增加可选的 `app` 块，并用 BKMS 令牌鉴权、按角色过滤；业务邮件和标书各需补若干服务方法（见“首批应用”）。

### 总体架构

```mermaid
flowchart TB
  subgraph Client["DSH 客户端（桌面版）"]
    User(["用户"])
    AI(["AI 对话（企业模式）"])
    subgraph AC["@bkms/app-center 应用中心"]
      ACPage["应用中心页面"]
      ACSkills["应用技能 app-&lt;id&gt;<br/>（第 0、1 层）"]
      ACTools["app_call / task_status<br/>（第 2 层）+ 风险拦截"]
      ACReg["登记服务 appCenter<br/>任务索引 · 审计"]
    end
    subgraph Apps["业务应用插件"]
      Mail["业务邮件<br/>bkms-workbench"]
      Contract["合同<br/>@bkms/app-contract"]
      Bid["标书<br/>xbuddy-bid-writer"]
    end
    PC["@bkms/plugin-center<br/>下载 · 校验 · 安装 · 升级"]
    Base["@bkms/base<br/>企业登录 · 用户 · 角色"]
    KE["enterprise_invoke_function<br/>（接口查询，并存）"]
    Host["DSH 宿主<br/>pluginManager · 工具 · 技能 · 审批 · Agent"]
  end
  Center["dsh-plugin-center 中心服务<br/>目录（含 app 块）· 分发规则 · 发布包"]
  BKMS["BKMS 后端<br/>身份 · 角色 · 知识"]

  User --> ACPage
  User --> AI
  AI -- 加载技能 --> ACSkills
  AI -- 调用 --> ACTools
  AI -. 一问一答查询 .-> KE
  ACTools --> ACReg
  Mail -- register --> ACReg
  Contract -- register --> ACReg
  Bid -- register --> ACReg
  ACReg -- 调动作 handler --> Apps
  Mail -- 服务调用 --> Contract
  Mail -- 服务调用 --> Bid
  ACPage -- 安装 / 更新 --> PC
  ACTools -- install --> PC
  PC -- 带令牌取目录和包 --> Center
  PC -- installBundle --> Host
  AC -- 用户与角色 --> Base
  PC -- 登录令牌 --> Base
  Center -- 校验令牌、取角色 --> BKMS
  Base --> BKMS
  KE --> BKMS
```

不支持 Mermaid 的查看器可参考下面的分层示意：

```
用户 ──► 应用中心页面 ─────────────┐
用户 ──► AI 对话（企业模式）        │
          │ 加载技能 app-<id>       │ 安装 / 更新
          │ 调 app_call / task_status
          ▼                         ▼
   @bkms/app-center ──install──► @bkms/plugin-center ──installBundle──► DSH 宿主
   （登记 · 技能 · 拦截 · 任务索引 · 审计）      │
          ▲ register        调 handler          │ 带 BKMS 令牌取目录和包
          │                     │               ▼
   业务应用：业务邮件 / 合同 / 标书        dsh-plugin-center 中心服务
   （应用之间直接调服务）                          │ 校验令牌、取角色
                                                   ▼
   @bkms/base（企业登录、用户、角色）──────────► BKMS 后端
   enterprise_invoke_function（接口查询，与应用中心并存）──► BKMS 后端
```

| 组件 | 在架构中的位置 |
| --- | --- |
| 应用中心 | 用户和 AI 的唯一入口；业务应用向它登记，它把安装请求转给 plugin-center |
| plugin-center | 唯一负责下载、校验和调用 DSH 安装的组件 |
| 中心服务 | 按用户角色下发目录、分发规则和发布包 |
| `@bkms/base` | 身份来源：客户端组件用它取用户和角色，中心服务凭它的令牌向 BKMS 后端验证 |
| 业务应用 | 运行时登记动作；能力以服务形式提供，应用之间直接调用 |
| `enterprise_invoke_function` | 现有的接口查询通道，与应用中心并存、分工不同 |

AI 和用户都只和应用中心打交道；业务应用向它登记动作，需要安装时它把请求交给 plugin-center，由 plugin-center 从中心服务取包并调 DSH 安装。

## 组件与职责

| 组件 | 新建 / 改造 | 做什么 | 不做什么 |
| --- | --- | --- | --- |
| `@bkms/app-center` 应用中心插件 | 新建 | 应用登记服务；应用技能生成；2 个对话工具；风险拦截；任务索引；应用中心页面；结果卡片渲染；审计记录 | 下载、校验、安装插件；分发规则 |
| `@bkms/plugin-center` 插件中心 | 小改（0.3.0） | 下载、SHA256 校验、串行安装、自动升级、刷新 / 重启提示；新增 `ctx.provide` 服务；请求目录时带 BKMS 令牌 | 业务分类、AI 相关功能 |
| `dsh-plugin-center` 中心服务 | 改造（0.6.0） | 发布包和目录；目录增加 `app` 块；校验 BKMS 令牌并按角色返回目录和分发规则 | 客户端运行时逻辑 |
| `@bkms/base` | 不改 | 企业登录；`bkmsApi.auth.user`（tenantCode、userId）、`getAccessToken()`；客户端 `bkmsAuthUi.getRoleIds()` | — |
| 业务应用插件（业务邮件 / 合同 / 标书） | 邮件、标书已有，合同新建 | 自己的页面、服务、后台任务和技能；启动时向应用中心登记清单 | 直接注册对话工具（常驻白名单除外）；自己对外发送 |
| DSH 宿主 | 不改 | 插件热插拔、`pluginManager`、工具、技能、Agent、审批、页面 | — |

依赖方向：业务应用 → app-center → plugin-center → 中心服务；app-center 和中心服务都依赖 `@bkms/base` 提供身份。业务应用对 app-center 是**可选依赖**：没装应用中心时，应用页面照常可用，只是不进对话。app-center 对 plugin-center 也是可选依赖：缺少时只显示已安装应用，不提供安装。

与企业知识调用的分工：`@bkms/knowledge-execute` 的 `enterprise_invoke_function` 由知识检索命中、后端鉴权后签发绑定会话和轮次的临时引用，适合一问一答的接口查询（目前是智能问数），本期保持不动；有页面、有任务的应用走应用中心。应用数量明显增多后，评估把应用登记为接口知识、由检索选择第 0 层。

## 应用中心插件设计

### 登记服务 `appCenter`

业务应用用 `ctx.inject(['appCenter'], …)` 拿到服务并登记自己；插件停用或卸载时，登记随 `ctx.effect` 自动撤销。

```ts
interface AppCenter {
  version: 1
  register(manifest: AppManifest, handlers: Record<string, ActionHandler>): Disposable
  list(): AppSummary[]                 // 已登记应用
  call(appId, action, args, exec): Promise<ActionResult>
  tasks: { report(task: TaskRecord): void; get(id): TaskRecord }
}

type ActionHandler = (args: unknown, exec: ExecContext) => Promise<ActionResult>
interface ExecContext {
  sessionId: string                    // exec.agent.session.header.id
  subagent: boolean                    // header.origin === 'subagent' 或有调用深度
  user: { tenantId: string; userId: string }   // ctx.bkmsApi.auth.user
  signal: AbortSignal
}
interface ActionResult {
  summary: string          // 一两句结论
  items?: { title: string; link?: AppLink }[]
  task?: { id: string; etaMinutes?: number }
  external?: string        // 外部内容（来信、附件文字），单独标注
  draft?: boolean          // 为真时结果必须写明“尚未发送”
}
```

### 第 0、1 层：应用技能

不再使用 `systemPrompt.section` 和 `app_guide` 工具，改为每个应用注册一个内存技能（`ctx.skills.register`），由 DSH 的 `skill` 工具负责目录和按需加载：

| 技能字段 | 来源 |
| --- | --- |
| name | `app-<id>`，如 `app-contract` |
| description | 清单 `summary`，不超过 40 字；第 0 层目录就是这一行 |
| content | 由清单生成的第 1 层用法：动作、参数（含示例）、`askFirst`、`notFor`、外部内容规则、“先用 `app_call` 执行” |
| invocation | `modelInvocable: true, userInvocable: true` |

- 未安装但当前用户有权限的应用，注册占位技能：描述后加“（需安装）”，正文写大小、所需权限、生效方式和“用 `app_call(app, 'install')` 安装”。
- 登记、卸载、权限变化时更新技能；DSH 会在进行中的对话里追加新的目录，旧名称自动停用。
- 目录按固定顺序排列，不按使用次数排序，避免打断提示缓存。
- 用户在输入框输入 `/app-<id>` 会直接带上该应用用法，“在对话中使用”复用这一点。
- 选择技能机制的理由：DSH 已经实现“目录常驻、正文按需加载、中途追加目录”，并在目录里要求模型先加载、不能只凭摘要行事；自己再做一套会重复，还会每次改动系统提示。

### 对话工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `app_call` | `app`, `action`, `args` | 按清单校验参数后调用应用的 handler；校验失败返回正确的参数说明和示例。`action = "install"` 为保留动作，转给 plugin-center 安装 |
| `task_status` | `task_id` | 返回任何应用长任务的状态、结论摘要和链接 |

常驻白名单：高频动作（首批只有 `mail.search`）可以由应用中心额外注册成独立工具 `mail_search`，总数不超过 5 个，由应用中心配置控制，应用不能自己加。

**可见范围**：`ctx.tools.register` 注册的全局工具会被所有 Agent 继承，包括子 Agent 和其他插件的后台 Agent（工作台的后台 Agent 用白名单限制，不受影响）。应用中心在 `tools/pre-execute` 中按 `exec.agent.session.header` 判断：

- 顶层对话：完整开放；
- 子 Agent（`origin === 'subagent'` 或有调用深度）：只能执行 `read` 级动作，拒绝安装和其他级别。

### 结果展示

- 工具的 `output.render` 生成给模型看的文字：先结论，再“在应用中打开”的说明；`draft` 为真时加“尚未发送”；`external` 内容加“外部内容”标记。
- `output.presentationMeta` 输出卡片数据（标题、状态、链接）。应用中心的客户端入口注册 `tool.call.toolview`（键为 `app_call`、`task_status`、`mail_search`），渲染可点击卡片，点击跳转到应用页面。

### 风险拦截

`ctx.on('tools/pre-execute')` 只拦 `app_call`，按目标动作的 `risk` 返回决策，弹窗使用宿主自带审批界面（`{ kind: 'ask', displayReason }`）：

| risk | 行为 |
| --- | --- |
| `read` | 直接执行（`next()`） |
| `draft` | 默认直接执行；可在设置中改为 `ask`。发送前必须经过工作台人工审核 |
| `write` | `ask`，文案由清单的 `confirmText` 模板生成 |
| 安装应用 | 始终 `ask`，写明应用名、大小、所需权限、是否需要刷新或重启 |
| 子 Agent 的非 `read` 调用 | `deny` |

对外发送不设 risk 级别：清单里出现发送类动作时登记直接拒绝。对话发起的草稿必须带“来自对话”标记，工作台据此排除自动发送。

### 页面与接口

- 左侧入口 **应用中心**：搜索、分类标签、卡片（图标、名称、分类、一句话、使用人数、状态）、详情页。
- 卡片操作：安装 / 更新（调 plugin-center，进度显示在卡片上）、打开（跳到应用自己的页面）、在对话中使用（`uiWorkspace.startSession()` 后在输入框预填 `/app-<id>`）。
- 卡片状态“需升级客户端”：中心目录带上包的 DSH peer 范围，与当前运行时版本比较。
- 后端接口（`/api/bkms-app-center/*`，POST 只接 JSON，沿用 plugin-center 的防跨站做法）：

| 接口 | 用途 |
| --- | --- |
| GET /apps | 已安装 + 可安装应用（合并登记和中心目录） |
| GET /apps/:id | 应用详情 |
| POST /apps/:id/install | 转给 plugin-center 安装 |
| GET /tasks?app=&status= | 任务列表 |
| GET /activity | 对话调用审计记录 |

## 数据格式

应用信息分两处放：中心目录只放**展示和安装前**需要的字段（含权限、角色，以服务端为准）；动作和参数由应用**运行时登记**，跟着插件版本走，升级后自动更新。

### 中心目录条目（plugins.json）

在现有字段（`name` / `packageName` / `url` / `description` / `version` / `artifact`）上增加可选的 `app` 块。没有 `app` 的条目是普通插件，不进应用中心。

```json
{
  "name": "合同",
  "packageName": "@bkms/app-contract",
  "url": "https://plugins.company.example/p/app-contract",
  "description": { "zh": "合同风险评审与按模板起草" },
  "version": "1.2.0",
  "artifact": { "url": "…", "sha256": "…", "size": 1048576, "version": "1.2.0", "manifest": {}, "restart": { "mode": "none" } },
  "app": {
    "id": "contract",
    "category": "法务",
    "summary": "合同风险评审、按模板起草",
    "icon": "审",
    "permissions": ["workbench.mail.read", "files.workspace.read"],
    "roles": ["legal", "sales"],
    "minAppCenter": "1.0.0",
    "changelog": "新增按报价起草"
  }
}
```

- `app.id` 与包名分开：已有应用保留原包名（`bkms-workbench`、`xbuddy-bid-writer`），改名在 pnpm 看来是另一个包，会断开数据和升级路径。
- 客户端兼容范围不单设字段，直接取 `artifact.manifest.peerDependencies` 中的 `@deepseek-ai/dsh*`。
- 后续如需按平台分包，`artifact` 扩展为按 `platform-arch` 区分的列表（见冲突 C6）。

### 应用清单（运行时登记）

```ts
interface AppManifest {
  id: string                       // 与目录 app.id 一致
  name: string; category: string
  summary: string                  // 技能描述和卡片共用，≤40 字
  askFirst?: string[]              // 发起前要问用户的问题
  notFor?: string[]                // 不适用的情况及该用谁
  page?: string                    // 应用页面路由
  actions: ActionSpec[]
}
interface ActionSpec {
  name: 'start' | 'list' | 'get' | 'status' | string   // 统一动词优先
  description: string
  whenToUse: string[]; notFor?: string[]
  params: JSONSchema               // 能用枚举就用枚举
  examples: string[]               // 用户原话
  risk: 'read' | 'draft' | 'write'
  long?: boolean                   // 长任务：立即返回 task
  confirmText?: string             // write 级弹窗文案模板
  aliases?: string[]               // 改名后保留的旧名
}
```

生效方式不在清单里重复定义：安装前参考发布包的 `artifact.restart.mode`（none / reload / restart），最终以 pluginManager 实际返回的 `application`（`applied` / `restart-required`）为准。

### 任务记录

```ts
interface TaskRecord {
  id: string; app: string; action: string
  status: 'queued' | 'running' | 'needs-review' | 'done' | 'failed'
  title: string; summary?: string; link?: AppLink
  conversationId?: string          // 发起对话
  tenantId: string; userId: string // 发起者
  createdAt: number; updatedAt: number
}
```

任务数据由应用自己保存，应用中心只保存索引（`ctx.profileContext` 下的 `.bkms-app-center/<tenantId>/<userId>/tasks.json`，保留最近 500 条），供 `task_status` 和任务列表使用。

### 数据位置约定

所有应用的数据统一放在 `ctx.profileContext` 提供的目录下，按 `tenantCode/userId` 隔离。现状不一致：工作台用 `DSH_HOME/data`（未设置时为 `~/.dsh`），标书用 `profileContext.home + dataDir`。工作台需改用 `profileContext`，并提供一次性迁移。

## 关键流程

### 对话调用（已安装）

1. 用户：“帮我看下这封邮件里的合同有什么风险”。
2. AI 从技能目录判断是合同，加载技能 `app-contract`，得到用法。
3. 用法里的 `askFirst` 要求先确认立场，AI 问用户“我方是甲方还是乙方”。
4. AI 调 `app_call('mail', 'handoff', { item, target: 'contract', stance })`。
5. 风险拦截：`draft` 级，按设置放行。
6. 业务邮件通过合同应用的服务 `contractReview.submit` 提交附件引用，合同应用建立任务并调 `appCenter.tasks.report`。
7. 对话收到：“已开始评审，约 3 分钟”，并显示在合同应用中打开的卡片。

### 对话中安装（未安装）

1. 用户：“把这份合同审一下，我们是乙方”。目录里 `app-contract` 标为“（需安装）”。
2. AI 加载占位技能，得到“未安装，约 1.2MB，需要权限…，安装后无需重启”。
3. AI 调 `app_call('contract', 'install')`，风险拦截返回 `ask`，用户在审批界面确认。
4. 应用中心调 plugin-center 服务 `install(url)`，轮询 `status().progress` 直到完成或失败（超时 3 分钟）。
5. 完成后按 pluginManager 实际返回的结果分三种情况：
   - 已热加载：等应用登记到 `appCenter`（最多 10 秒），占位技能换成正式技能，返回“已安装”和用法摘要，AI 在同一对话里继续。DSH 每一步都重新组装工具和技能，下一步即可用。
   - 需要刷新：返回“已安装，刷新界面后可用”，plugin-center 的全局提示同时出现。
   - 需要重启：返回“已安装，重启 DSH 后可用”。
6. 失败：返回 plugin-center 的失败原因，建议用户到应用中心重试。

标书含按平台区分的原生依赖、包体几十 MB，归入登录时按角色预装，不走对话中安装（见冲突 C6）。

### 长任务

1. `long: true` 的动作在应用后台执行，`app_call` 立即返回任务 ID。执行方式由应用决定：隔离 Agent（`agents.create` + `tools.restrict`，如工作台）或应用自己的任务队列（如标书）。
2. 应用在状态变化时调 `tasks.report`。
3. 用户问“评审好了吗”，AI 调 `task_status`。
4. 完成或需要人工审核时，应用中心在全局提示区提醒，点击打开应用页面。

### 升级

1. plugin-center 按分发规则在后台升级应用插件（已有能力）。每个应用都必须有一条规则（`installMode: manual`、`autoUpgrade: true`），否则手动安装后不会自动升级。
2. 新版插件启动后重新登记，应用中心更新应用技能；进行中的对话下一步就用新说明。
3. 动作改名时旧名写进 `aliases`，应用中心自动转到新名。
4. 应用有进行中的长任务时，应用在停用钩子里保存任务状态，新版启动后接着跑或标为失败可重试。**不要求 plugin-center 等待空闲**，这样它不用改。

### 回滚

不做降级安装。工作台数据库在库版本比插件新时拒绝打开，DSH 会话格式也不支持降级。出问题时：

1. 中心服务暂停该应用的分发（规则停止下发新版）。
2. 快速发布修复版（可以是旧代码加新版本号）。
3. 接入规范要求迁移只加不删，保证上一版代码能读新数据。

## plugin-center 改动（0.2.0 → 0.3.0）

只加接口，不改现有安装和同步逻辑。

1. **新增服务 `bkmsPluginCenter`**：在 `src/index.ts` 的 `pluginManager` 注入块里，把现有 `createSync` 实例的方法用 `ctx.provide` 暴露出去。

```ts
interface BkmsPluginCenter {
  version: 1
  catalog(): Promise<{ center: string; plugins: CatalogEntry[] }>   // readCatalog
  install(url: string): Promise<SyncStatus>                          // sync.install，参数为目录条目的 url
  status(since?: number): SyncStatus                                 // sync.status
}
```

2. **目录透传 `app` 块**：`readCatalog` 已经原样返回条目，只需确认不过滤未知字段；BKMS 插件页可以忽略它。
3. **按用户请求目录**：请求 `plugins.json` 和 `distribution-v2.json` 时带上 `@bkms/base` 的登录令牌（`bkmsApi.getAccessToken()`），让服务端按角色过滤。plugin-center 需增加对 `bkmsApi` 的可选注入。
4. **入口分工**：普通用户的 Profile 预置里关闭“在侧栏显示入口”（已有设置），只留管理员可见。企业用户的 Profile 同时去掉 `dshmarket`。用户只看“应用中心”一个入口。
5. **测试**：在 `test/service.test.mjs` 里加服务方法、`app` 字段透传和带令牌请求的用例。

现有能力直接复用，应用中心不再实现：

| 能力 | plugin-center 中的实现 |
| --- | --- |
| 下载、校验大小 / SHA256 / 包名 / 版本 / 清单 | `prepareArtifact` |
| 串行安装、进度（排队 → 下载 → 安装 → 启用） | `createSync().install` + `progress` |
| 按规则自动安装和升级、不降级 | `planRule` |
| 失败重试和退避 | `retry` 配置、`sync-state.json` |
| 刷新 / 重启提示 | `effectOf` + `shell.overlay` 提示 |
| 残留链接保护 | `staleLinkProblem` |

已知限制：需要批准安装脚本的插件仍要在官方“插件”页手工安装一次。业务应用插件**不应有安装脚本**，写进接入规范。

## 中心服务改动（dsh-plugin-center 0.5.0 → 0.6.0）

1. **目录增加 `app` 块**：管理后台上架插件时可填分类、一句话、图标、所需权限、适用角色、更新说明。字段可选，旧客户端不受影响。
2. **用户身份**：客户端请求时带 `@bkms/base` 的登录令牌，中心服务向 BKMS 后端验证令牌并取得 tenantCode、userId 和角色。不再考虑设备令牌。
3. **按角色过滤**：服务端按用户角色返回 `plugins.json` 和 `distribution-v2.json`，没权限的条目和规则不下发。客户端不做权限判断，只用 `bkmsAuthUi.getRoleIds()` 做展示。
4. **分批上线与暂停**：分发规则增加可选的 `rollout`（角色或用户名单），只对名单内用户下发新版本；增加 `paused`，出问题时停止下发新版。不做降级。
5. **按平台分包**（为标书预留）：`artifact` 可选按 `platform-arch` 提供多份；plugin-center 按本机平台选择。
6. **使用统计**（可选）：接收应用中心上报的使用次数，用于卡片上的“N 人用过”。

## 业务应用接入规范

每个业务应用上线前过一遍这份清单：

- [ ] 新应用包名用 `@bkms/app-<id>`；已有应用保留原包名，由目录 `app.id` 对应。对话动作通过 `appCenter.register` 登记，不自己注册对话工具。
- [ ] 能力先做成服务（`ctx.provide('<id>.xxx')`，带 `version`），动作 handler 只是薄壳；应用之间调服务，不绕道对话。服务按能力拆分，只读和写分开提供。
- [ ] 服务接口不依赖 HTTP 请求对象（如 `IncomingMessage`），文件用附件引用或会话工作区路径传入。
- [ ] 优先使用 start / list / get / status 四个统一动作，专有动作不超过 3 个。
- [ ] 每个动作都写：做什么、什么时候用（用户原话示例）、什么时候不用和该用谁、参数（能枚举就枚举）、风险级别。
- [ ] 参数名在各应用间一致（`since`、`query`、`file`、`item`）。
- [ ] 不提供任何对外发送动作；要发的内容交给业务邮件的“待我决策”，并带“来自对话”标记。
- [ ] 长任务在应用后台执行（隔离 Agent 或任务队列）；技能只注册在应用自己的后台 Agent 里，不进主对话。
- [ ] 任务状态变化时调 `tasks.report`；停用时保存进行中的任务。
- [ ] 新版能读旧数据，迁移只加不删，上一版也能读新数据；动作改名时保留 `aliases`。
- [ ] `peerDependencies` 中的 `@deepseek-ai/dsh*` 写版本范围（如 `>=0.2.0-rc.2 <0.3.0`），不写精确版本；不依赖 `engines.dsh`（DSH 不检查它）。`@bkms/base` peer 范围覆盖当前预装版本。
- [ ] 依赖用 `bundleDependencies` 打进发布包（参考 bkms-workbench `scripts/pack-plugin.mjs`），没有安装脚本。
- [ ] 发布包尽量在几 MB 以内，大资源（模板库、资质库）首次用到时再下载；含原生模块的应用按平台分包并归入预装类。
- [ ] 数据放在 `ctx.profileContext` 下，按 tenantCode/userId 隔离。
- [ ] 只通过 `ctx.get(name)` 或 `ctx.inject([...])` 读取宿主服务，不直接读 `ctx.<服务名>`：Cordis 4 对未声明的服务属性会抛错，插件启动失败（实现时在真实 DSH 中发现）。
- [ ] 中心服务为应用配置一条分发规则（`installMode: manual`、`autoUpgrade: true`）。
- [ ] 发布前用测试集跑一遍，没有和已有动作混淆，也没有和 `enterprise_invoke_function` 混淆。
- [ ] 不装应用中心时，应用页面仍可独立使用。

### 首批应用

| 应用 | 包名 | 动作 | 依赖服务 |
| --- | --- | --- | --- |
| 业务邮件 mail | 现有 `bkms-workbench` | search（常驻，只查邮件）、get、list、draft\_reply、handoff | 提供 `workbenchMail` v1 → v2 |
| 合同 contract | `@bkms/app-contract` | start（mode = review / draft）、list、get、status、templates | 可选 `workbenchMail`；提供 `contractReview` |
| 标书 bid | 现有 `xbuddy-bid-writer` | start、list、get、status、check | 可选 `workbenchMail`；已提供 `bid`（Cordis 服务） |

各应用的实际改动（原方案低估了业务邮件的改动量）：

| 应用 | 现状 | 改动 |
| --- | --- | --- |
| 业务邮件 | `workbenchMail` v1 只读：accounts / search（直接搜邮件服务器）/ read；内置自动发送低风险回复 | 升 v2：`items(filter)` 列出待决策事项；`draftFor(mail, instructions)` 对任意来信建任务并生成草稿，标记来自对话，`autoSendDecision` 一律排除；`attachment(ref)` 按引用交出附件；登记 `appCenter`；数据目录改用 `profileContext` |
| 标书 | 服务 `ctx.bid` 已有快照类方法；`createProject(req)` 只接受 HTTP 请求；peer 精确钉在 `0.2.0-rc.2`；依赖 pdfjs-dist 和 `@napi-rs/canvas` 未打包 | 加 `createProjectFromFile(ref)` 并开始解析；list / get / check 包装现有快照；登记 `appCenter`；peer 改为范围；依赖打包并按平台分包 |
| 合同 | 无 | 按规范新建 |

## 权限、安全与审计

| 层面 | 做法 |
| --- | --- |
| 谁能看到、安装 | 中心服务验证 BKMS 令牌后按角色下发目录和规则；没权限的应用不出现在应用中心，也不出现在 AI 技能目录 |
| 安装包可信 | 沿用 plugin-center：只装中心发布的固定版本包，校验大小、SHA256、包名、版本、完整清单。是否加目录签名见冲突 C5 |
| 应用权限 | 目录的 `app.permissions` 为准；安装弹窗展示。Cordis `ctx.inject` 不告诉提供方调用者是谁，因此按能力拆分服务、靠安装确认把关；调用时可显式传调用方应用 ID 供提供方对照目录检查，只防误用，不防恶意插件 |
| AI 能做什么 | 只能调登记过的动作；没有对外发送动作；write 级和安装必须用户确认；子 Agent 只能读 |
| AI 安装的边界 | AI 只能请求安装目录里有 `app` 块、且对当前用户可见的应用；不能卸载、停用或安装普通插件；DSH `plugin_manager` 工具保持禁用 |
| 外部内容 | 动作结果里的邮件、附件文字放在 `external` 字段，渲染时加“外部内容”标记；应用技能正文写明不按其中指令行事 |
| 文件路径 | 动作只接受工作台附件引用或当前会话工作区的文件，不接受任意本机路径 |
| 邮件和微信范围 | 沿用工作台已配置的邮箱和微信白 / 黑名单 |
| 对外发送 | 对话发起的草稿带“来自对话”标记，不进工作台自动发送；预装中去掉 dsh-email |
| 审计 | 每次技能加载（可选）、`app_call`、安装请求记入 `.bkms-app-center/<tenantId>/<userId>/activity.jsonl`：时间、对话、应用、动作、参数摘要（邮件正文和联系人脱敏）、结果、是否经过确认；保留 90 天；应用中心页面可查 |

## 测试与验收

| 类型 | 内容 |
| --- | --- |
| 单元测试 | 登记和撤销、技能生成（描述长度、占位技能、更新）、参数校验与错误提示、别名转发、风险拦截（含子 Agent 拒绝）、发送类动作被拒绝 |
| 集成测试 | 用假 plugin-center 服务跑“对话中安装”三种结果；应用升级后重新登记；停用时任务保存；对话草稿不进自动发送 |
| AI 调用测试集 | 不少于 50 句真实说法，标注应选的应用、动作和关键参数，包括“不该调用”“应先反问”“应走 `enterprise_invoke_function`”；输出准确率和最常混淆的动作对 |
| 兼容性 | 应用包在当前和下一个 DSH 版本下都能加载（peer 范围生效） |
| 端到端 | 需求文档里的 6 个典型场景在真实桌面版上跑通 |

验收标准（建议值）：

- [ ] AI 调用测试集准确率不低于 90%。
- [ ] 应用中心在主对话常驻的工具不超过 7 个；技能描述不超过 40 字。
- [ ] 热加载的应用在对话中安装后无需刷新即可在同一对话继续使用。
- [ ] 对话中没有对外发送动作（预装中已无 dsh-email）；草稿结果都写明“尚未发送”，且不进自动发送。
- [ ] 没权限的应用在应用中心和 AI 技能目录中都不出现。
- [ ] 应用升级后旧任务可继续查看；旧动作名仍可调用；上一版能读新版数据。
- [ ] 客户端升级到兼容范围内的新版本后，已装应用无需重新发布即可继续使用。
- [ ] 卸载应用中心后，各业务应用页面仍可独立使用。

## 实施计划

4 个阶段，3 个闸口。日期待定。

```
阶段零 原型验证 ──闸口 1──► 阶段一 对话集成 ──闸口 2──► 阶段二 分发与权限 ──闸口 3──► 阶段三 扩展
 （约 1 周）                 （app-center + 邮件）        （plugin-center + 中心服务）    （合同 · 检索选择）
```

| 阶段 | 涉及组件 | 主要工作 | 产出 |
| --- | --- | --- | --- |
| 阶段零 原型验证（约 1 周） | app-center 原型 | 在真实桌面版上验证 V1–V4：企业模式能否看到插件注册的技能、`app_call` 卡片显示和跳转、插件页面新开对话并预填、对话中热安装后继续调用 | 验证记录；第 0、1 层实现方式定稿（技能机制，或退回 `systemPrompt.section` + `app_guide`） |
| 阶段一 对话集成 | app-center、bkms-workbench、xbuddy-bid-writer、桌面 Profile | 新建 app-center：登记服务、应用技能、`app_call` / `task_status`、风险拦截、结果卡片、任务索引、审计；工作台升 `workbenchMail` v2 并登记、对话草稿排除自动发送、数据目录改用 `profileContext`；去掉预装 dsh-email；标书改 peer 范围、依赖打包。不动 plugin-center 和中心服务 | 已安装应用可在对话中使用；建立 AI 调用测试集 |
| 阶段二 分发与权限 | plugin-center、dsh-plugin-center、@bkms/base | plugin-center 提供 `bkmsPluginCenter` 服务、请求带 BKMS 令牌；中心服务校验令牌、按角色过滤、`rollout` 分批和 `paused` 暂停、按平台分包；企业用户 Profile 去掉 dshmarket、plugin-center 入口只给管理员 | 对话中安装；按角色可见和可安装；标书按平台分包预装 |
| 阶段三 扩展 | 合同应用、knowledge-execute | 合同应用按接入规范新建并接入；评估把应用登记为接口知识、由检索选择第 0 层 | 首批三个应用全部接入；第 0 层扩展方案 |

| 闸口 | 位置 | 通过条件 |
| --- | --- | --- |
| 闸口 1 | 阶段零 → 阶段一 | V1–V4 有结论；第 0、1 层实现方式确定 |
| 闸口 2 | 阶段一 → 阶段二 | AI 调用测试集准确率不低于 90%；对话中没有发送动作（预装已无 dsh-email）；对话草稿不进自动发送；标书在下一个 DSH 版本下仍能加载 |
| 闸口 3 | 阶段二 → 阶段三 | 没权限的应用在应用中心和 AI 目录都不出现；对话中安装三种结果都正确；暂停分发和修复版流程演练通过 |

阶段一可以和合同、标书应用的开发同时进行。

## 与现有代码的冲突

| # | 冲突 | 依据 | 处理 |
| --- | --- | --- | --- |
| C1 | 桌面 Profile 预装 `dsh-email`，在对话注册 11 个工具，含 `email_send`、`email_reply` | `~/.xbuddy/profiles/desktop/package.json`；dsh-email `lib` | 工作台上线时去掉预装；工作台已能检测并提示卸载 |
| C2 | 标书 `@deepseek-ai/dsh-*` peer 精确为 `0.2.0-rc.2`；`@bkms/base` peer `>=0.2.8 <0.3.0`，预装为 0.3.0 | `xbuddy-bid-writer/package.json`；DSH 按 peer 检查（`xbuddy/packages/boot/app-boot/README.zh.md`） | 改为版本范围，写入接入规范 |
| C3 | 原方案“一键回滚、旧版能读数据”；工作台数据库拒绝降级，DSH 会话格式不支持降级 | `bkms-workbench/CLAUDE.md` 存储约定；`xbuddy/AGENTS.md` | 改为暂停分发 + 修复版，迁移只加不删 |
| C4 | 原需求“空闲时切换、旧版跑完任务”；plugin-center 不等待空闲 | `bkms-plugin-center/src/sync.mjs` | 停用前保存、新版续跑或标为可重试 |
| C5 | 需求要求验签名；plugin-center 只校验 SHA256，信任根是中心目录，默认地址为 IP | `bkms-plugin-center/src/service.mjs` | 待决定：补目录签名，或写明本期只校验完整性 |
| C6 | 标书依赖 pdfjs-dist（约 37MB）和按平台区分的 `@napi-rs/canvas`（约 37MB）；plugin-center 单包、上限 64MB、不分平台 | `xbuddy-bid-writer/node_modules`；`prepareArtifact` | 标书归入预装；中心目录支持按平台分包，或宿主提供 PDF 渲染 |
| C7 | `mail.search` 原含微信；`workbenchMail.search` 只搜邮件服务器 | `bkms-workbench/src/mail/service.ts:271` | 本期只查邮件 |
| C8 | 企业模式已有 `enterprise_invoke_function`，原方案未提及 | `@bkms/tool-enterprise-core`、`@bkms/knowledge-execute` README | 明确分工，测试集覆盖 |
| C9 | 预装 `dshmarket`，并存 plugin-center、`@bkms/ui-skills` | 桌面 Profile | 企业用户去掉 dshmarket；plugin-center 只给管理员 |
| C10 | 工作台自动发送低风险回复 | `bkms-workbench/src/engine.ts:42` | 对话草稿一律排除自动发送 |
| C11 | 数据位置不一致：工作台 `DSH_HOME/data`（默认 `~/.dsh`），标书 `profileContext.home` | `bkms-workbench/src/index.ts`；标书 `provider/plugin.ts` | 统一用 `profileContext`，工作台提供迁移 |
| C12 | 原方案假设“业务邮件只需加一段登记”；`workbenchMail` 没有事项列表、对话草稿和附件交出 | `bkms-workbench/src/mail/service.ts` | 升 v2，见“首批应用” |
| C13 | 原方案“提供方检查调用方权限”；Cordis `ctx.inject` 不提供调用方身份 | Cordis 服务机制 | 按能力拆服务 + 安装确认；显式调用方 ID 只防误用 |
| C14 | 原方案用 `ctx.get('approval').request` 弹窗、`systemPrompt.section` 做目录；DSH 已有等价机制 | `xbuddy/packages/core/tools/src/index.ts`（`PreToolDecision`）；`packages/skill/tool-skill` | 改用 `ask` 决策和技能机制 |

## 待验证

已由源码确认、从原待确认中移除：

| 原问题 | 结论 | 依据 |
| --- | --- | --- |
| 热安装后的内容能否在进行中的对话里生效 | 能，每一步重新组装系统提示和工具 | `xbuddy/packages/core/agent-loop/src/agent.ts:272` |
| `ctx.skills` 是否按需加载正文 | 是，目录只含名称和描述，中途变化会追加 | `xbuddy/packages/skill/tool-skill/README.zh.md` |
| 工具结果能否显示链接或卡片 | 能，`presentationMeta` + 客户端 `tool.call.toolview` | `xbuddy/packages/client/ui-skill/src/client/index.ts:81` |
| 工具能否拿到对话 ID 和用户 | 对话 ID 用 `exec.agent.session.header.id`；用户用 `ctx.bkmsApi.auth.user` | `xbuddy/packages/core/session/src/types.ts:94` |
| 用户身份用设备令牌还是统一登录 | 用 `@bkms/base` 企业登录 | `@bkms/base` README |
| 草稿级动作默认是否弹窗 | 不弹窗，靠工作台审核 + 排除自动发送 | 设计决定 |
| 回滚是否加 `allowDowngrade` | 不加，改为暂停分发 + 修复版 | 冲突 C3 |

仍需在真实桌面版上验证：

- [ ] V1 `ctx.skills.register` 注册的技能是否出现在企业模式（`bkms-enterprise`）的技能目录中；`/app-<id>` 能否在输入框调用。不能时退回原方案（`systemPrompt.section` + `app_guide`）。
- [ ] V2 `tool.call.toolview` 卡片在桌面版中的显示和跳转。
- [ ] V3 插件页面调用 `uiWorkspace.startSession()` 后预填输入框是否可行。
- [ ] V4 对话中热安装后同一对话继续调用；占位技能替换为正式技能是否及时。
- [ ] V5 中心服务能否用 `@bkms/base` 令牌向 BKMS 后端验证用户并取得角色；需要后端提供哪个接口。
- [ ] V6 桌面版是否设置 `DSH_HOME`；工作台数据当前实际位置。
- [ ] V7 多客户端或多 Profile 同时运行时，按 Profile 和用户分开的任务索引、审计是否足够。
- [ ] V8 标书按平台分包的大小和安装耗时；宿主是否愿意提供共享 PDF 渲染。
- [ ] V9 应用中心全局注册的工具在企业模式下是否可见（预期可见，因为全局工具会被继承），以及子 Agent 判断条件是否准确。
