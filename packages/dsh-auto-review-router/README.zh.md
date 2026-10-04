# dsh-auto-review-router 0.2.3

可指定 reviewer provider、model、effort 的 Auto 审查门。目标核心为 `@deepseek-ai/dsh 0.2.1-alpha.1`；使用同版本官方 Settings / ConfigEditor 与 Schemastery volatile Config，不自建配置存储、不手写用户 profile。

## 工具 schema 来源（0.2.3 修复）

native 工具执行对象通常不携带 `exec.schema`；工具描述和参数 schema 从同一次 `session.requestHeader().tools` 中按精确工具名唯一匹配。PTC 内层则只读取其 `exec.schema` 绑定，且必须与执行名一致。缺失、重名、不完整或绑定不一致仍 fail-closed，不查询全局 registry 兜底，不用空参数 schema 掩盖缺失。该修复解决旧版 native 调用普遍报 `pending tool schema is incomplete` 的取值错误，不绕过模型审查或审批策略。

`test/pending-schema.mjs` 使用当前官方 ToolRuntime 的实际 `createExecution` 生成无 schema 的 native 执行对象，再进入交付插件 gate；覆盖 write/read/pwsh/memory_status、请求头唯一性、PTC 绑定、缺失和真实 reviewer deny 的不执行边界。无需付费模型或真实工具执行。

## 可编辑设置

设置页统一位于 **设置 → 内置插件 → Auto 审查路由**，只注册 `settings.plugins.tab`，不再在设置侧栏贡献独立页面。需启用官方内置插件设置容器；容器晚声明时等待，不注册另一处回退入口。客户端使用官方 `remote.settings.describe()` 获取 `auto-review-router` 条目的表单、实际值和 revision，用 `update(ns, patch, revision)` 保存。

- 审查模型从 DSH 官方已配置目录选择，不手填 provider/model。使用与官方模型菜单相同的无 sessionId `remote.session.modelCatalog()`，仅读取目录元信息，不探测端点或发起模型审查。
- provider/model 联动选择，effort 仅提供该模型支持项与「适配器默认」；切换模型清除不兼容 effort。保留「会话回退」与明确清空专用路由的选项。
- 目录加载、失败、空列表和刷新都有反馈。旧保存的路由失效时明确显示并保留草稿，不悄悄替换；目录异常不应锁死安全关闭。
- 其他启用、回退、预算、超时、温度、项目指令与日志开关保持。
- **保存**经官方 Config 校验、ConfigEditor 原子持久化及 Loader reconciliation；**取消**仅丢弃草稿，不写入配置。
- 过期 revision 明确报冲突，保留草稿，不盲目重试；**重新读取**明确丢弃草稿并读取最新值。
- 不可写、缺少唯一活动条目、写入失败或依赖缺失会显示错误。配置条目 id 必须为 bundle 默认的 `auto-review-router`；重命名或非 profile 所属嵌套 Include 不支持本页编辑。
- 中英词典随现有 locale 切换；状态查询 `autoReviewRouter.read` 与 `queryRouterStatus` 继续只读兼容。

必须组合官方 `dsh-settings`、`dsh-config-editor`、`dsh-api-settings-controller` 与客户端 remotes。插件自定义页通过 `settings.configure({ auto: false }, ownerFiber)` 声明展示策略，但不移除官方读写能力。

## 配置与校验

本包导出 `Config`。整个配置对象使用一个 `.volatile()` 引用，确保每次审查入口只调用 `.get()` 获取同一份不可变快照。热改不重载插件；正在进行的审查使用原快照，下一次审查使用新值。`enabled` 变更例外：它立即停止准入并中止本代审查。

| 字段 | 默认 | 校验 / 含义 |
| --- | --- | --- |
| `enabled` | `false` | 启用后发布 Auto 选项，不自动为当前会话选择 Auto |
| `reviewerProvider` | `''` | 由目录选择维护；底层字段与 model 必须同时完整或空 |
| `reviewerModel` | `''` | 从本机已配置模型目录选择；不发请求测试可达性 |
| `reviewerEffort` | `''` | 从所选模型支持项选择；空为适配器默认，非空须完整路由 |
| `fallbackToSessionRoute` | `true` | 没有配置路由时使用会话 provider/model；不带 reviewerEffort |
| `maxContextBytes` | `32768` | 整数 1–1048576；固定保护分区装不下时拒绝 |
| `historyLimit` | `20` | 整数 0–1000 |
| `includeProjectInstructions` | `true` | 是否加入项目指令 |
| `temperature` | `0` | 有限数字 0–2 |
| `timeoutMs` | `20000` | 整数 1–300000，超时 fail-closed |
| `logDecisions` | `true` | 记录工具名、路由、风险、决定、耗时，不记录请求正文 |

启用并关闭回退时必须选择完整 reviewer 路由。provider/model 留空且允许回退时，每次从 `session.requestHeader().config` 读取会话路由；不可用则拒绝。部分填写不再静默回退，而是在保存前拒绝。

## 启停安全与冲突

- 默认关闭，不发布 Auto，不注册审查门；仍监听官方 Loader 的 `loader/volatile-update`，以支持即时启用。
- Auto 由 `permissionPresets.registerAuto` 注册，不修改当前用户 approval policy，不自动提升或选择权限预设。
- 与官方 `dsh-experimental-auto-review` 互斥；冲突保留先注册者，本包撤回自己的审查监听，状态和页面明确显示冲突。关闭再启用可重新尝试注册。
- 不得与 `dsh-codex-connect.enableAutoReview` 同时启用；该外包没有在此实现运行时探测。
- 关闭或正常卸载时先关闭准入、abort 在途 reviewer，再使用官方 `setSandboxMode(session, 'read-only')` 收紧现有 Auto 会话，**不调用 `permissionPresets.set`**，因其同时会更改 approval policy。
- `sessions` 是必需注入服务。会话枚举或收紧写入失败时，热关闭保留 Auto 注册与不接受审查的守卫，下一工具调用取消；只读状态 `registration.error` 明确报错。后续配置通知可重试收紧。不得把配置 `enabled=false` 误认为注册已安全撤除。
- 正常收紧成功才撤回 Auto；已捕获的旧审查不能在禁用后通过 `next` 放行。再次启用不会把只读会话提升回完全访问，须用户自行选择权限。

**极限边界：** Cordis 强制卸载整棵 fiber、服务撤除或进程异常，且会话日志无法写入时，插件不能阻止核心最终销毁其守卫，也不能保证原会话已完成收紧。状态中的关闭失败需先修复日志/会话服务；不要强制卸载后继续执行。存量日志的 Auto 身份未被伪造为其他预设；官方 `pinInitialPermission` 在没有活动 Auto 集成时会拒绝恢复这类会话。重新启用集成或用户明确选择有效权限预设后才能恢复，不会自动迁到 `danger-full-access`。

## 审查与失败即拒绝

只审查 `permissionPresets.current(session) === 'auto'` 的工具调用。无 agent、非 Auto 跳过；健康启用时外层 `run_code` 跳过模型审查，关闭失败或已中止的 Auto 调用（包括外层 `run_code`）必须先取消；PTC 内层调用审查。外层 `run_code` 内不经工具的 Node 副作用不受本门覆盖。

- `allow` 继续下游审查，并在异步下游返回后再次检查本代是否关闭。
- reviewer 明确 `deny`：approval `never` 时终局拒绝；否则下游允许后才转人工询问。本包从不修改 policy。
- reviewer 流失败、非法 JSON/协议、无终止 finish、超时、路由失效、预算超限：**fail-closed**，返回 `deny`，不执行工具体、不转人工、不重试。
- 关闭、卸载或调用取消：返回 `cancel`。

每次真正进入审查都会多一次模型请求、消耗 reviewer token。此版本开发与测试只使用合成流，未调用付费模型。

上下文分区顺序为 `POLICY`、`ENVIRONMENT`、`PROJECT_INSTRUCTIONS`、`RECENT_HISTORY`、`PENDING_ACTION`。先裁最旧历史，再裁项目指令，不裁策略、环境与待审动作。历史 API 不可用时省略历史并警告；固定分区超限则在模型请求前拒绝。

## 离线验证

先审查测试脚本再执行。正常 checkout 依赖优先；本机安装树仅作显式只读回退：

```powershell
$env:DSH_APP_ROOT = 'C:\Program Files\DSH NEXT\resources\app'
node packages/dsh-auto-review-router/test/selftest.mjs
node packages/dsh-auto-review-router/test/plugin-smoke.mjs
node packages/dsh-auto-review-router/test/status.mjs
node packages/dsh-auto-review-router/test/settings.mjs
node packages/dsh-auto-review-router/test/configured-model-picker.mjs
node packages/dsh-auto-review-router/test/lifecycle.mjs
node packages/dsh-auto-review-router/test/loader-settings.mjs
```

`loader-settings` 真实挂载 Cordis Loader、官方 Settings 与 ConfigEditor，在测试创建的临时 home/profile/bundle 中验证持久化、revision、拒绝写入、稳定 fiber/引用、每请求快照、路由/effort热改、在途禁用、启停与审批不变；llm、权限选择与会话为合成服务，不执行真实工具体。`settings` 加载真实 lazy client factory，验证官方保存接口及表单错误；`lifecycle` 补充冲突、失败收紧、重试及卸载回归。不是浏览器实机安装验收。

测试不修改真实 profile、核心、安装树，不安装、重启、commit 或 push。Node 要求见 manifest（22.19+ 或 24+，bootstrap 使用 `registerHooks`）。

## 官方 API 依据与生效限制

现场包 `@deepseek-ai/dsh` 的 manifest 核实为 **0.2.1-alpha.1**。依据同安装的：

- `dsh-settings/README.zh.md` 与 `lib/index.js`：Config volatile 派生表单、revision冲突、presentation、官方 update。
- `dsh-config-editor/lib/index.js`：写前 `resolveConfig`、原子 profile patch 写入与 reconciliation/失败回滚。
- `cordis-plugin-loader/lib/index.js`：提交引用后发出 `loader/volatile-update`，volatile-only 不重载 fiber。
- `dsh-api-settings-controller/lib/index.js`：`describe/update` RemoteResult、`settings/conflict` / `settings/rejected`。
- `dsh-permission-presets/lib/index.js`：Auto 注册与 current/derive；`set` 同时改 sandbox 与 approval；无集成时拒绝恢复 Auto。
- `dsh-sandbox-policy/lib/index.js`：canonical `setSandboxMode` 只追加 `sandbox/mode` 事件，不改 approval。
- `dsh-api-session-controller/lib/types/catalog.js:5–59`：无 Session 的 `buildModelCatalog` 聚合活动 provider、模型和 reasoning，并隔离各 provider 失败；RPC 返回 `groups[].models[].reasoning.efforts[]`（id/name）与可选 defaultEffort。
- `dsh-client-ui-model-selection/lib/client.js:752–762`：官方模型菜单同样调用 `remote.session.modelCatalog()`，本插件不使用会话专用 `selectModel` 来修改用户会话。

## 未核实项

- 实际 provider/model/effort 可达性与付费模型审查未执行；跨核心版本只声明 peer 范围，不代表行为验收。
- 强制销毁 fiber 且日志写入失败时的保证极限见「启停安全与冲突」，不宣称已完整解决。
- VM 交互与临时 profile 测试不等于真实浏览器部署验收；CI 和安装状态以具体发布/安装记录为准。

0.2.2 提供模型目录选择。源码、离线测试、CI 发包、磁盘安装和 GUI 在线生效是不同阶段；更新须经官方管理入口，再按实际 host/client 重载机制验收。不得从测试通过或已更新包版本推断当前页面已经生效；重启另须用户授权。
