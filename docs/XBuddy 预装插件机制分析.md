# XBuddy 预装插件机制分析

Oct 24, 2026

背景：应用改为“随客户端预装 + plugin-center 自动升级，不做按需下载”。本文分析 DSH 上游和 XBuddy 对预装的处理，找出与 plugin-center 自动升级的冲突，并给出修改建议。本文只做分析，代码尚未修改。

## 结论

- 上游 DSH 从 0.2.0-rc.1 到 0.2.1-rc.3（含 master）都**没有**“预装进用户 Profile”的机制。
- 现在的预装逻辑是 XBuddy 自己加的（`apps/desktop/src/preinstalled-plugins.ts`）。当前版本每次启动都同步，只按依赖路径判断归属，会把 plugin-center 升级过的应用**装回旧版**，与数据库不支持降级冲突，必须修改。
- 另有三个现存问题：预装包没有打包依赖，启动时依赖外网；bid-writer 的 `engines.dsh` 在 DSH 0.2.1 起会被强制检查；预装清单仍包含会在对话中注册 `email_send` 的 dsh-email。

## 版本关系

| 版本 | 提交 | 日期 | 说明 |
| --- | --- | --- | --- |
| 上游 0.2.0-rc.1 | `4878cdabd8` | 2026-09-28 | — |
| 上游 0.2.0-rc.2 | `c1b47e41fc` | 2026-09-29 | XBuddy 的基线（合并于 `639ed01539`） |
| XBuddy | rc.2 + 23 个自有提交 | 10-09 起 | 主要作者 qinkc、钱进烽；预装逻辑在其中两次提交 |
| 上游 0.2.1-rc.3 | `d02ea370ee` | 2026-10-23 | 上游最新发布 |

xbuddy 仓库保留了上游完整历史。上游仓库 `deepseek-ai/deepseek-harness` 公开，已在 xbuddy 仓库添加只读的 `upstream` remote 用于对比。

## 上游 0.2.0-rc.1 / rc.2 的插件分层

`apps/desktop/src/project-manager.ts` 的 `applyRelease()` 在 rc.1 中只校验运行时、迁移设置、`createPluginProfile()`（`initProfile` 建空 Profile）、清理链接投影，注释写明“不安装任何包”。

| 层 | 内容 | 升级方式 |
| --- | --- | --- |
| 签名核心包 | `desktop-packages/*.tgz`：dsh 与 desktop-host 的完整依赖闭包，装在运行时目录（`core-package-set.ts`） | 只随客户端大版本 |
| 安装提供的组合包 / `OPTIONAL_BUNDLES` | 随安装提供；可选组合包默认关闭、不可卸载（`app-boot/src/profile.ts`）。plugin-center 的 `planRule` 把这类包视为“内置”，不修改 | 只随客户端大版本 |
| 用户 Profile | 初始为空，只放用户安装的第三方插件 | 插件页说明“暂不支持自动更新，需先卸载再安装” |

rc.1 → rc.2 在 desktop 中只增加了命令安装（`command-*.ts`）和登录 Shell 环境读取，插件部分没有变化。

## XBuddy 的预装实现

清单来源：`apps/desktop/brands/<品牌>/brand.yaml` 的 `preinstalledPlugins` → 打包脚本 `scripts/brand-overlay.mjs` 写出 `resources/preinstalled-plugins/*.tgz` 与 `plugins.json` → 安装后位于 `resources/runtime/preinstalled-plugins/`。触发点：`main.ts` 的 `reconcileBackend()` 在**每次后台启动**时调用 `manager.applyRelease({ directory, … })`，再调用 `installPreinstalledPlugins()`。

| 版本 | 提交 | 行为 |
| --- | --- | --- |
| v1 | `5f75e3384e`（2026-10-12）“预装 BKMS 插件” | 每个客户端版本执行一次（完成记录 `.preinstalled-plugins-version`）；按文件名复制 tgz，`pnpm add` 全部，不删除 |
| v2（当前） | `d780c9d9b2`（2026-10-13）“启动时同步品牌预装插件” | 每次启动同步，不受版本限制；tgz 以 `<sha256>-<文件名>` 存放，内容变化即更新（同名同版本也会更新）；补回缺失的包；删除依赖仍指向 `.preinstalled-plugins/`、但已不在清单中的包；保留手动安装的包、停用状态和用户配置；安装失败会中止启动，下次启动重试 |

v2 的归属判断：Profile 中依赖规格以 `file:` 开头、且路径位于 `.preinstalled-plugins/` 的包，视为“预装所有”。清单中的包只要在这个集合里找不到对应路径，就当作缺失并重新 `pnpm add`。

## 与 plugin-center 自动升级的冲突

1. 客户端预装标书 0.1.0，依赖为 `file:./.preinstalled-plugins/<sha>-bid-0.1.0.tgz`。
2. plugin-center 按分发规则把标书升级到 0.2.0，依赖改为 plugin-center 缓存中的 `file:` 路径。
3. 下次启动，v2 认为标书“缺失”，执行 `pnpm add` 安装 0.1.0，即**降级**。
4. 约 10 秒后 plugin-center 再升级到 0.2.0，之后每次启动重复。

后果：工作台数据库在库版本比插件新时拒绝打开（`bkms-workbench` 存储约定），标书 SQLite 也有版本表；新版迁移过的数据会让旧版报错。v1 也有同样问题，只是频率是“每次客户端升级一次”。

## 现存的其他问题

### 预装包未打包依赖，启动依赖外网

已安装 XBuddy 中 14 个预装包全部没有 `bundleDependencies`，包内也没有 `node_modules`：

| 包 | 运行时依赖 |
| --- | --- |
| bkms-base、knowledge-execute、knowledge-search、knowledge-smartbi、knowledge-ui、ui-skills | zod |
| bkms-llm | eventsource-parser、zod |
| dsh-im | @matrix-org/olm、qqbot、wecom、dingtalk-stream、imapflow、mailparser、nodemailer、qrcode、undici |
| dsh-email | schemastery、imapflow、mailparser、nodemailer、proper-lockfile、yaml |
| dshmarket | js-yaml、undici |
| llm-trace、tool-enterprise-core、tool-web-search、ui-jump-admin | 无 |

首次安装或重装时 pnpm 需要访问 npm 源。内网环境会失败，而预装失败会中止启动。2026-10-23 的崩溃日志即为预装阶段“pnpm printed nothing for 600000ms and was terminated”。

### 安装包与仓库清单不一致

已安装 XBuddy 带 14 个预装插件（bkms-base 0.3.0、knowledge-execute 0.1.0、knowledge-smartbi 0.1.0、llm-trace 0.2.0 等）；仓库 HEAD 的 `brands/xbuddy/brand.yaml` 只列 11 个，版本更旧（bkms-base 0.2.8 等）。安装包不是从当前仓库状态打出来的，发布流程需要核对。

### dsh-email 仍在预装清单

dsh-email 在对话中注册 11 个邮件工具，包括 `email_send`、`email_reply`，与“对话中没有对外发送动作”冲突（需求文档冲突 C1）。

## 上游 rc.2 之后的变化（到 0.2.1-rc.3 与 master）

| 变化 | 位置 | 影响 |
| --- | --- | --- |
| desktop 仍无预装；rc.2 → rc.3 只改设置与更新通道 | `apps/desktop/src` | 预装只能继续由 XBuddy 自己维护 |
| 新增官方按需组合包 `ON_DEMAND_BUNDLES`（目前仅 claude-code、codex 两个子 Agent）与离线目录 `OFFICIAL_ON_DEMAND_CATALOG`；按 `包名@当前 DSH 版本` 精确安装；“显式更新”= 先删除再安装 | `app-boot/src/official-bundle-packages.ts`、plugin-manager | 只服务上游官方包，不适合 BKMS 应用；“先删后装”可作为参考 |
| plugin-manager `listBundles` 增加 `official`、`availability`（installation / profile / missing）、`installed`、`installTarget`、`source`（profile 依赖规格，`file:` 解析为绝对路径） | `plugin-manager/src/types.ts` | 可以据此区分“预装的”和“plugin-center 装的” |
| **`engines.dsh` 开始强制检查，并优先于 DSH peer**（rc.2 明确忽略 `engines.dsh`） | `app-boot/src/plugin-compatibility.ts` | bid-writer 的 `engines.dsh: "0.2.0-rc.2"` 在 0.2.1 上会被停用，必须改为范围或删除 |
| 混用注册表后，pnpm 按默认注册表校验锁文件中的 tarball URL，可能报 `ERR_PNPM_TARBALL_URL_MISMATCH` | plugin-manager 已知限制 | 预装、plugin-center、用户安装共用同一 Profile 锁文件时需注意 |
| master（rc.3 之后）`e0e37bfd3d`：组合包清单移到新包 `@deepseek-ai/dsh-official-bundles`，修改了 `project-manager.ts` 的导入 | `apps/desktop/src/project-manager.ts` | XBuddy 合并上游时与预装改动会有小冲突 |

## 修改建议（待实施）

修改集中在 `apps/desktop/src/preinstalled-plugins.ts`，约 30–50 行，另补 `tests/preinstalled-plugins.spec.ts`。

1. **按“包名 + 版本”判断，不只看路径**。对清单中每个 tgz 读出包内 `package.json` 的 name 和 version，再看 Profile 中同名包：

   | Profile 现状 | 处理 |
   | --- | --- |
   | 未安装 | 安装 |
   | 预装所有，内容相同 | 跳过 |
   | 预装所有，内容变化 | 更新（保持现有行为） |
   | 他处安装（plugin-center 或手动），已装版本 ≥ 安装包版本 | 跳过，不降级 |
   | 他处安装，安装包版本更新 | 安装（客户端大版本带来的新版） |

2. **删除规则不变**：只卸载已从清单移除、且依赖仍指向 `.preinstalled-plugins/` 的包；plugin-center 安装的包由其分发规则管理。
3. **预装失败不阻塞启动**：已有插件照常启动，失败写日志并在下次启动重试。
4. **配套要求**：
   - 所有预装包使用 `bundleDependencies`（参考 bkms-workbench `scripts/pack-plugin.mjs`），保证离线安装；
   - bid-writer 的 `engines.dsh` 改为范围（如 `>=0.2.0-rc.2 <0.3.0`）或删除；
   - 预装清单去掉 dsh-email，加入 plugin-center、应用中心、工作台、标书；
   - 每个应用在中心配置分发规则 `installMode: required`、`autoUpgrade: true`，后续升级由 plugin-center 完成；
   - 发布前核对安装包中的预装清单与仓库 `brand.yaml` 一致。
5. **合并上游时**：按上表处理 `project-manager.ts` 导入变化；如合并到 0.2.1，可改用 `listBundles` 的 `source` 判断归属。

## 对需求与设计的影响

- 对话中不再安装应用：去掉 `app_call` 的 install 动作、安装风险级别和“（需安装）”占位技能；验证项 V4 取消。
- 应用中心点击卡片只做“打开”；首次同步中的应用显示“正在准备”和 plugin-center 进度，失败可重试（plugin-center 已有 `retry`）。
- 按角色分发变为前提：不做按需下载时，没有角色过滤就会全员安装全部应用，需要中心服务凭 BKMS 令牌按角色下发规则，或先接受全员全量。
- 冲突 C6（标书原生依赖）基本缓解：安装包本身按平台构建；只有 plugin-center 单独升级标书时需要按平台分包。
- 回滚仍为“暂停分发 + 发布更高版本的修复版”，plugin-center 不降级。

以上影响尚未写回需求文档和技术方案，待方案确认后统一修改。
