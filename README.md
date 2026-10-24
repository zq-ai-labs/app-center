# @bkms/app-center 应用中心

XBuddy（DSH）插件：应用目录、应用登记，以及把合同、标书、业务邮件等应用接进 AI 对话。需求和设计见 [docs/](docs/)。

## 它做什么

| 能力 | 实现 |
| --- | --- |
| 应用登记 | `ctx.provide('appCenter')`：业务插件 `register(manifest, handlers)`，清单按接入规范校验（统一动作、专有动作 ≤3、summary ≤40 字、禁止发送类动作） |
| 第 0、1 层 | 每个应用一个 DSH 技能 `app-<id>`：描述常驻目录，正文按需加载；未安装但可装的应用有“（需安装）”占位技能 |
| 第 2 层 | 对话工具 `app_call`、`task_status`，加最多 5 个常驻只读工具（默认 `mail_search`） |
| 风险拦截 | `tools/pre-execute`：读直接执行，草稿默认直接执行（可配置为询问），写和安装询问用户，子 Agent 只能读 |
| 结果 | 先结论后入口；草稿写明“尚未发送”；外部内容加标记；对话里显示可点击卡片（`tool.call.toolview`） |
| 安装 | 通过 plugin-center 的 `bkmsPluginCenter` 服务安装目录里的应用，等应用登记后在同一对话继续 |
| 任务与审计 | 任务索引和对话调用记录按企业用户（`@bkms/base` 登录）存放在 Profile 目录 `.bkms-app-center/` |
| 页面 | 左侧栏“应用中心”：搜索、分类、卡片、详情（含“AI 看到的用法”）、我的任务、对话记录 |

宿主服务（tools、skills、connection、bkmsApi、bkmsPluginCenter）都是可选的，缺哪个就少哪部分功能。

## 开发

```bash
pnpm install
npm run build        # tsc + 客户端打包到 lib/
npm test             # 构建并运行 test/*.test.mjs
```

## 演示

```bash
npm run demo         # http://127.0.0.1:4317/
```

演示用一个模拟宿主（`demo/fake-host.mjs`，行为与 Cordis 一致：读未声明的服务会报错）挂载真实的应用中心代码，内置三个示例应用和一个示例插件中心。“对话”页的典型场景会走真实的工具调用、风险拦截、安装和结果卡片；AI 的文字回复是脚本，不是真实模型。

## 在真实 DSH 中检查

```bash
ELECTRON_RUN_AS_NODE=1 "<XBuddy 安装目录>/XBuddy.exe" scripts/real-dsh-check.mjs "<XBuddy 安装目录>/resources/app.asar/dsh/node_modules"
```

用已安装 XBuddy 里的 Cordis、`dsh-tools`、`dsh-skill`、`dsh-system-prompt` 挂载应用中心，检查服务注入、工具注册与输出校验、技能注册和加载、风险拦截。

## 在本机 XBuddy 中试用

```bash
node scripts/xbuddy-profile.mjs link --samples
```

把本仓库链接进 `~/.xbuddy/profiles/desktop`（先备份 `package.json` 和 `cordis.patch.yml`），`--samples` 打开示例应用（名称和结果都标“示例”）。重启 XBuddy 后左侧栏出现“应用中心”。撤销：

```bash
node scripts/xbuddy-profile.mjs unlink
```

## 接入一个应用

```ts
ctx.inject(['appCenter'], child => {
  const dispose = child.appCenter.register(manifest, {
    async list(args, exec) { return { summary: '你有 3 个项目。', items: [...], link: { app: 'bid', page: 'bid-writer' } } },
  })
  child.effect(() => dispose)
})
```

清单字段和规则见技术方案的“数据格式”和“业务应用接入规范”。参考实现：`bkms-workbench/src/app-center.ts`、`xbuddy-bid-writer/src/host/app-center.ts`。
