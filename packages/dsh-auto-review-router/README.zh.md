# dsh-auto-review-router

可指定模型的自动审批插件。它提供与官方 `@deepseek-ai/dsh-experimental-auto-review` 同构的 Auto 审查，但 reviewer 的 provider / model / reasoning effort 来自本插件配置；两项路由都留空时，才回退到当前会话路由。因此可以把干活和审查拆到不同模型上。

本包只注册 Auto 集成与 `tools/pre-execute` 审查门，不提供权限选择器界面。选择器仍由官方 `dsh-client-ui-permission-presets` 渲染。

目标核心：`@deepseek-ai/dsh 0.2.1-alpha.1`。本包不 import 任何 `@deepseek-ai/*`。

## 与官方实现互斥

**与官方 `dsh-experimental-auto-review` 互斥。** 两者都会调用 `permissionPresets.registerAuto` 注册保留名 `auto`。先加载者获胜；后加载者会收到 `permission: preset "auto" is already registered`。本插件捕获该错误后只打一条警告并撤回自己的监听，不覆盖先注册的集成：

> 官方 dsh-experimental-auto-review 已注册 Auto，本插件无法同时启用；请先禁用其一。

不要同时启用二者。

**不得与 `dsh-codex-connect` 的 `enableAutoReview` 同时启用。** 该开关会把本需人工确认的审批交给 Codex 云端审查器，和本插件的本地 Auto 门不是同一条链路，同时打开会造成双重审查或审批语义冲突。

## 默认关闭

`enabled` 默认 `false`。未显式设为 `true` 时，插件只打一行说明，不注册 Auto，也不订阅 `tools/pre-execute`。

## 失败即拒绝

模型报错、输出不是合法决策、超时、路由无法解析、上下文无法在不裁剪受保护分区的前提下装进预算，一律 **fail-closed**：返回 `kind: 'deny'`，不转人工审批，不执行工具体。拒绝理由形如：

`Auto review of tool "<name>" failed; its body was not executed: <message>`

这与「审查者明确 deny」不同。明确 deny 在审批策略为 `ask` 时转人工；为 `never` 时终局拒绝。失败不走询问分支。

## 额外消耗

每次真正进入审查的调用都会多打一次模型请求，消耗 reviewer 路由上的 token。外层 `run_code`、非 Auto 预设、缺少 `exec.agent` 的调用不会打这请求。

## 配置

patch 默认值见 `cordis.patch.yml`。本包不导出 Cordis `Config` schema，由 `apply` 规范化 loader 传入的对象。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 为真才注册 Auto 与审查门 |
| `reviewerProvider` | `''` | 空则不单独构成配置路由 |
| `reviewerModel` | `''` | 须与 provider 同时非空才采用配置路由 |
| `reviewerEffort` | `''` | 仅配置路由下非空才作为 `reasoningEffort` 传入 |
| `fallbackToSessionRoute` | `true` | 配置路由不全时是否改用会话路由 |
| `maxContextBytes` | `32768` | 审查上下文 UTF-8 上限 |
| `historyLimit` | `20` | 历史条数上限，保留最新的 |
| `includeProjectInstructions` | `true` | 是否加入 `PROJECT_INSTRUCTIONS` |
| `temperature` | `0` | 审查请求温度 |
| `timeoutMs` | `20000` | 超时即 fail-closed |
| `logDecisions` | `true` | 用 `ctx.logger.info` 记录工具名、路由、风险、决定、耗时 |

路由规则：`reviewerProvider` 与 `reviewerModel` **都非空**时用配置路由；否则在 `fallbackToSessionRoute: true` 时用 `session.requestHeader().config` 的 provider/model；再否则拒绝，理由说明配置不完整。只配了一半、或配了 effort 但没配模型，都算配置不全，不会把残缺配置和会话路由拼在一起。会话回退不附带 `reviewerEffort`。

兼容范围：`peerDependencies["@deepseek-ai/dsh"]` 为 `>=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0`。前半覆盖 `0.2.0` 的 rc 预发布；后半用带预发布标签的 `0.2.1-0` 放行 `0.2.1` 起、`0.3.0` 前的预发布（含本机 `0.2.1-alpha.1`）。只写前半段时，node-semver 匹配不到 `0.2.1-alpha.1`。

设置页（「插件」分区，只读）显示 `enabled`、Auto 是否注册成功、路由来源、预算和冲突警告。第一版不写配置。改配置写在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `- id: auto-review-router` 下；同 id 的 config 是整体替换，字段要写全。

示例（把审查固定到另一条路由）。provider 与 model 必须来自本机已配置的路由，留空则回退会话路由。下面的 `xai-oauth` / `grok-4.7` 是本机已存在的组合；写成未配置的名字会在审查时 `NO_ADAPTER` 失败。上面的片段只演示路由字段，落盘时仍须写全其余字段，否则未写字段回落默认值。

```yaml
- id: auto-review-router
  name: dsh-auto-review-router
  config:
    enabled: true
    reviewerProvider: xai-oauth
    reviewerModel: grok-4.7
    reviewerEffort: high
    fallbackToSessionRoute: true
```

## 审查行为

- 仅当 `permissionPresets.current(session) === 'auto'` 时审查。
- 外层 `run_code`（`parent === undefined`）不审查。PTC 内层调用（`parent !== undefined`）要审查。
- `allow`：调用 `next()` 并透传下游结果。
- `deny` 且 `approval.overrideOf(session) === 'never'`：终局拒绝，`info.name` 为 `AutoReviewDeniedError`，`info.code` 为 `AUTO_REVIEW_DENIED`。
- `deny` 且策略不是 `never`（含探测不到 `overrideOf`，按更保守的 `ask`）：先 `await next()`；下游不是 `allow` 则采用下游结果，下游是 `allow` 则返回 `kind: 'ask'`。
- 组件关闭或调用已 abort：返回 `kind: 'cancel'`。
- 卸载时关闭准入，把仍选中 Auto 的会话迁到 `danger-full-access`（`set` 存在才调用），中止在途审查并等待结清，再撤回 Auto 注册与监听。

审查期间不遍历目录、不读写文件，只读会话内存并发起一次模型请求。

## 上下文分区

按此顺序拼接，标题大写：

`POLICY`、`ENVIRONMENT`、`PROJECT_INSTRUCTIONS`（有来源且开关打开才出现）、`RECENT_HISTORY`（有历史才出现）、`PENDING_ACTION`。

超出 `maxContextBytes` 时先从最旧的 `RECENT_HISTORY` 条目裁起，再裁 `PROJECT_INSTRUCTIONS`。`POLICY` / `ENVIRONMENT` / `PENDING_ACTION` 不裁。裁完仍超限则拒绝本次调用。单条历史超过 2000 字节时截断并加上 `…[truncated]`。历史 API 不可用时省略 `RECENT_HISTORY`，不写空数组，并警告一次。

## 限制

- 不实现「记住授权 / allow-always」。官方审批 seam 没有这个能力。
- 设置页只读，不在 GUI 里改配置。配置仍是 cordis Config，要改就写 profile 的 `cordis.patch.yml`。
- 不修改安装树，不写 `~/.dsh`。
- 模型可能误放行或误拒绝。本包没有重试、没有工具名白名单。
- 外层 `run_code` 程序内部不经工具调用的 Node 副作用不会被这条门看到。
- `snapshotEvents()` 在官方文档中已标记弃用。这里按契约探测使用，不可用就降级。

## 自行决定的细节

- `apply` 是普通函数，便于假 ctx 同步观察注册结果。卸载回调在 `ctx.effect`（或 `ctx.fiber.effect`）可用时挂上；不可用时审查门仍然注册，但不会自动迁移会话。
- 审查请求的 `system` 是 `REVIEW_POLICY`，user 消息是含 `POLICY` 分区的完整上下文。策略因此出现两次，换取 system 通道与契约分区同时成立。
- `arguments` 用键排序后的 `JSON.stringify` 作为规范化字符串。
- PTC 内层 `PENDING_ACTION.mode` 为 `ptc-inner`；契约示例只写了 `native`。
- 当前 `exec.callId` 对应的 tool-call 不写入历史，避免把尚未执行的调用当成既成事实。
- `includeProjectInstructions: true` 时，`agent-instructions` 只进入 `PROJECT_INSTRUCTIONS`，不在历史里再占一条 `constraint`。开关关闭时，它们以 `constraint` 进入历史。
- 固定分区单独超限时抛错并 fail-closed，而不是悄悄裁掉策略或待审动作。

## 未核实项

以下用法依赖不稳定内部 API，或契约没有写死、本包按保守解释实现。均未在真实 Host fiber / 真实模型请求上跑过。

1. 人类指令判定把 `user/message` 且 `source.kind === 'user'` 标成 `human-instruction`。官方实现还要求 `source.rpcId` 为字符串。本包没有在真实会话里核对没有 `rpcId` 的 user 消息是否仍应算人类指令。
2. 其它非 `tool`、非 `agent-instructions`、非 `user` 的 `user/message` 标成 `fact`。契约的历史角色只有 `human-instruction | constraint | fact`，没有单列 direct-parent 或 checkpoint。把它们当成事实是保守映射，不是官方角色表的复刻。
3. `assistant/message` 的工具调用优先读 `event.data.message.content`，缺失时再试 `event.data.content`。第二种形状没有在本机事件样本里核对。
4. 不使用 `session.surface.nodes` 过滤可见节点，只扫描 `snapshotEvents()`。可见集合与官方快照是否一致，未核实。
5. `session.requestHeader()` 的返回形状按 `config.provider` / `config.model` 读取。探测抛错或字段缺失时，只有配置路由完整才能继续，否则拒绝。
6. `session.header.cwd` 缺失时回退 `process.cwd()` 并警告一次。非绝对路径会 `path.resolve`。没有核对真实 header 是否总是绝对路径。
7. 卸载迁移依赖可选的 `ctx.sessions.list()` 与 `permissionPresets.set(session, 'danger-full-access')`。`inject` 没有声明 `sessions`。探测不到就跳过，不抛错。这条路径没有在真实卸载里执行过。
8. `approval.overrideOf` 按契约探测；函数缺失或抛错时按 `ask`。函数存在但返回 `undefined` 时也走询问分支，与「只有 `never` 才终局拒绝」一致。没有对真实会话日志里的 `approval/policy` 事件做回归。
9. `registerAuto` 的冲突只按错误文案 `preset "auto" is already registered` 识别。没有和已加载的官方 auto-review 做同进程互斥实测。
10. 没有导出 Cordis Config schema，也没有用真实 loader 验证 patch 配置会被原样传入 `apply`。字段默认值与契约第 4 节一致，但是运行时规范化，不是 schema 校验。
11. 流累加器只拼接 `text-delta` / `reasoning-delta`，识别 `block-start` 与 `finish`。`finish.reason.kind` 仅把 `stop` 当成功，`error` / `aborted` 读取 `reason.failure.code` 与 `message`。其它分片类型忽略。没有对照每个适配器的分片变体。
12. `AbortSignal.any` 与 `AbortSignal.timeout` 用来合并调用信号、卸载信号和超时。超时后即使流不尊重 abort，外层 `bounded` 也会拒绝并 fail-closed。没有在真实 `ctx.llm.stream` 上验证 abort 传播。
13. 未与 `dsh-codex-connect` 的 `enableAutoReview` 做运行时互斥检测。README 要求操作者不要同时打开，代码不会去读那个插件的配置。
