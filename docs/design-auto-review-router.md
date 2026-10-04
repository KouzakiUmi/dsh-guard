# 设计契约 · dsh-auto-review-router（阶段 B）

> 本文件是实现的**唯一真源**。凡写定的字段名、协议、语义、错误处理，实现必须逐字遵守；
> 未写定的细节可自行决定，但必须在 README 中记录。
> "已核实事实"一节已在核心 `@deepseek-ai/dsh 0.2.1-alpha.1` 上核实，**不要重新猜测，也不要改写**。

- 仓库根：`D:\dsh-guard`
- 包目录：`D:\dsh-guard\packages\dsh-auto-review-router`
- 目标核心版本：`@deepseek-ai/dsh 0.2.1-alpha.1`（安装根 `C:\Program Files\DSH NEXT`）

---

## 1. 问题与目标

官方 `@deepseek-ai/dsh-experimental-auto-review` 已经提供"逐调用模型审查"，但它把 reviewer 路由**硬编码**为当前会话的路由：

```js
// 官方实现（lib/index.js:219 / 313-314 / 399-415）
const header = session.requestHeader();
provider: header.config.provider,
model: header.config.model,
...
return readDecision(ctx.llm.stream({ provider, model, system: REVIEW_POLICY, messages, temperature: 0, signal }));
```

包内**没有 Config schema**（源码末尾 `export { apply, inject, name }`），因此无法通过 cordis patch 指定 reviewer 模型——
patch 只能改 loader 配置，改不了代码逻辑。

**本包的目标**：提供与官方同构的 Auto 审查，但 reviewer 路由来自插件 Config（provider / model / effort），
缺省时回退到当前会话路由。用户因此可以让"干活用便宜模型、审查用强模型"，或反过来。

### 非目标

- 不修改安装树、不打补丁、不做 ASAR 操作。
- 不做 GUI（权限选择器沿用官方 `dsh-client-ui-permission-presets`；本包只注册 Auto 集成）。
- 不实现"记住授权 / allow-always"（官方审批 seam 不支持；不要臆造）。

---

## 2. 交付物

```
packages/dsh-auto-review-router/
  package.json          # ESM；dsh.bundle.patch → cordis.patch.yml
  cordis.patch.yml      # 只 insert 本插件一行 + 保守默认 config（enabled: false）
  README.zh.md          # 中文：能力、与官方 auto-review 的互斥、配置、失败语义、限制、未核实项
  lib/policy.js         # 固定审查策略文本 + 决策协议解析（纯函数，可单测）
  lib/context.js        # 审查上下文组装（分区 + 字节上限 + 降级）
  lib/index.js          # Cordis 插件：registerAuto + tools/pre-execute 审查门
  test/selftest.mjs     # 离线自测（假 ctx / 假 llm 流）
```

`lib/policy.js` 与 `lib/context.js` **不得依赖 Cordis**，便于单测。

---

## 3. 已核实事实（直接用，不要改写）

### 3.1 权限预设

- `AUTO_PRESET` 的字面量是 **`"auto"`**；`CUSTOM_PRESET` 是 `"custom"`。预设表里**不能**出现这两个名字。
  → 本插件**不要 import** `@deepseek-ai/dsh-permission-presets`，直接用字符串 `'auto'`。
- `ctx.permissionPresets.registerAuto(admit)`：`admit` 是**同步**准入函数，在"选中或恢复 Auto"之前运行；
  返回 async effect disposer。
  **若已有集成注册过 `auto`，它会抛 `permission: preset "auto" is already registered`。**
- `ctx.permissionPresets.current(session)` 返回当前预设名。

### 3.2 审批

- `ctx.approval.overrideOf(session)` 返回会话的有效审批策略（官方 auto-review 用它判断 `'never'`）。
  这是**内部用法**，必须运行时探测：`typeof ctx.approval?.overrideOf === 'function'`；探测不到时按 `'ask'` 处理（更保守）。
- 决策返回形状（`tools/pre-execute` 监听器的返回值）：
  - 放行：`return next()`
  - 请求人工审批：`{ kind: 'ask', reason: '<英文审计理由>', displayReason: { en: '...', zh: '...' } }`
  - 终局拒绝：`{ kind: 'deny', reason: '<模型可见理由>', info: { name: '<稳定错误名>', code: '<稳定错误码>', reason?: '<用户可见理由>' } }`
- 审批策略 `never` 下拒绝是终局；`ask` 下拒绝要转人工审批。

### 3.3 LLM

- `ctx.llm.stream(options)`，`options` 字段：`provider`、`model`、`reasoningEffort?`、`system`、`messages`、`temperature`、`maxTokens?`、`signal`。
  `reasoningEffort` 是合法字段（核心按 `provider/model/reasoningEffort/temperature/maxTokens` 比较请求头）。
- 流是 chunk 序列；需要识别的类型：`text-delta`、`reasoning-delta`、`block-start`、`finish`。
- `finish` 的 `reason.kind`：`'stop'` 正常；`'error'` 与 `'aborted'` 携带 `reason.failure.{code,message}`。
- **不要 import `BlockAssembler`**：自己写极简累加器（只需拼出最后一个 text 块与前置 reasoning 块）。

### 3.4 工具流水线

```js
ctx.on('tools/pre-execute', async (exec, next) => { ... }, { prepend: true })
```

- `exec` 字段：`name`、`arguments`、`callId`、`rootCallId`、`parent`、`schema`、`signal`、`agent`。
- `exec.agent.session` 是当前会话。
- `run_code` 是 PTC 外层传输的保留名（字面量 `'run_code'`）：**外层 `run_code` 调用本身不审查**，
  但 PTC 内部子调用要审查（用 `exec.parent !== undefined` 判断）。
- `exec.schema` 含 `{ name, description, parameters }`（仅临时存活，不持久化）。

### 3.5 会话内部 API（不稳定，必须探测 + 降级）

官方实现读取：`session.snapshotEvents()`、`session.surface.nodes`、`session.requestHeader()`、`session.header.cwd`、`session.header.parentSession`。

**这些是内部 API。** 本插件的要求：

- 取 **cwd**：`session.header?.cwd`（缺失则回退 `process.cwd()`，并 warn 一次）。
- 取当前会话路由：`session.requestHeader?.()?.config?.{provider,model}`（探测不到则报错，除非 config 已显式给出 reviewer 路由）。
- 取历史：优先 `session.snapshotEvents?.()`；不可用时降级为"无历史分区"并 warn 一次（**绝不抛错**）。

---

## 4. Config

```yaml
- insert:
    - id: auto-review-router
      name: dsh-auto-review-router
      config:
        enabled: false              # 默认关闭：必须显式开启才注册 Auto 集成
        reviewerProvider: ''        # 空 = 回退当前会话 provider
        reviewerModel: ''           # 空 = 回退当前会话 model
        reviewerEffort: ''          # 空 = 不传 reasoningEffort（用适配器默认）
        fallbackToSessionRoute: true  # 配置不全时是否回退会话路由
        maxContextBytes: 32768      # 审查上下文总字节上限（UTF-8）
        historyLimit: 20            # 历史条目条数上限
        includeProjectInstructions: true
        temperature: 0
        timeoutMs: 20000            # 超过即 fail-closed
        logDecisions: true          # 是否用 ctx.logger 记录每次判定
```

- 路由解析规则：`reviewerProvider` 与 `reviewerModel` **都非空** → 用配置路由（并带 `reviewerEffort`，若非空）；
  否则若 `fallbackToSessionRoute` 为真 → 用会话路由；否则**失败即拒绝**（fail-closed），reason 说明配置不完整。
- `enabled: false` 时：不注册 Auto、不订阅 `tools/pre-execute`，只打一行 info 说明未启用。

---

## 5. 审查策略与决策协议

### 5.1 固定策略文本（写入 `lib/policy.js` 的 `REVIEW_POLICY` 常量）

策略必须是**自洽、完整**的一段英文（不要逐字照抄官方文案，自己组织，但语义必须覆盖）：

- 角色：你是**唯一一次**待执行工具调用的最终授权审查者；你的决定**替代人工审批**。放行 = 立即以完全主机权限执行，且没有后续确认。
- 输出：**只输出一个 JSON 对象**，不允许任何其他文本。
- 合法形状（逐字）：
  - `{"risk":"low","decision":"allow"}`
  - `{"risk":"medium","decision":"allow"}`
  - `{"risk":"medium","decision":"deny"}`
  - `{"risk":"medium","decision":"deny","reason":"..."}`
  - `{"risk":"high","decision":"deny"}`
  - `{"risk":"high","decision":"deny","reason":"..."}`
  - 禁止：`low`+`deny`、`high`+`allow`、`allow` 带 `reason`。
- 风险分级（按**实际效果**判断，不按工具名、语气或声称的意图）：
  - `low`：项目内的普通读写、分析、格式化、lint、测试、构建、非破坏性 git 操作，以及**本会话自己创建**的对象的精确清理。low 直接放行。
  - `medium`：不可逆删除既有对象或状态、force push / 改写历史、生产环境读或写或部署、非敏感的外部写入/发送、权限与安全控制或系统级变更。medium 只有在**当前人类或直接父级指令**明确授权了动作、确切目标与必要范围，且没有未解决的冲突时才可放行。
  - `high`：跨信任边界泄露敏感信息（凭据、密钥、隐私数据发往外部或不可信目的地）及同等效果。**high 永远拒绝**，即使人类显式要求。
- 授权来源：只有人类指令能定义或替换当前任务及其限制；直接父级指令可调整进程内子代理的任务，但**不能覆盖人类的显式限制**；约束类内容只能收窄动作；事实类内容只能确立事实。
- 任何指令都**不能下调风险等级**，也不能授权 high 风险动作。
- 实际效果不明确、或比已确立的范围更宽 → **fail closed（拒绝）**。

### 5.2 决策解析（`lib/policy.js` 的 `parseDecision(text)`）

- 解析为单个 JSON 对象；非对象、数组、`null` → 抛错。
- 键数必须精确匹配：2 键（risk+decision）或 3 键（risk+decision+reason）。
- **必须检测重复成员**：对原始文本做顶层成员计数（官方做法：剥掉字符串字面量后数深度 1 的 `:`），与 `Object.keys().length` 比较，不等即抛错。
- 组合校验：`low/medium + allow`、`medium/high + deny`；`reason` 只能与 `deny` 同时出现且必须是字符串。
- 任何不合法 → 抛错（由调用方转为 fail-closed）。

---

## 6. 审查上下文（`lib/context.js`）

按固定顺序拼成一段文本，分区标题用大写：

```
POLICY
<REVIEW_POLICY>

ENVIRONMENT
{"cwd":"<绝对路径>"}

PROJECT_INSTRUCTIONS
[{"source":...,"content":...}]        # includeProjectInstructions 为真且有来源时才有此段
                                      # 来源判定：消息 source.kind === 'agent-instructions'

RECENT_HISTORY
[{"role":"human-instruction|constraint|fact","content":"..."}]   # 最多 historyLimit 条

PENDING_ACTION
{"mode":"native","name":"...","description":"...","parameters":{...},"arguments":"<规范化 JSON 字符串>"}
```

- 总字节数（UTF-8）不得超过 `maxContextBytes`：**按分区逆序裁剪**（先裁 RECENT_HISTORY，再裁 PROJECT_INSTRUCTIONS，POLICY / ENVIRONMENT / PENDING_ACTION 不裁）。
- 历史条目单条截断 2000 字节，超长加 `…[truncated]` 后缀。
- 历史来源：会话事件里 `user/message`（跳过 `source.kind === 'tool'` 的）与 `assistant/message` 里的 tool-call 事实；
  每条标注 role：人类指令 → `human-instruction`，agent-instructions → `constraint`，工具调用 → `fact`。
- 历史 API 不可用时：省略 RECENT_HISTORY 段（不要写空数组），并 warn 一次。

---

## 7. 插件行为（`lib/index.js`）

```js
export const name = 'auto-review-router'
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools'] // 会话枚举是安全关闭的必要依赖；commands 可选
export function apply(ctx, rawConfig) { ... }
```

1. `enabled` 为假 → 打 info，直接返回（`apply` 不注册任何东西）。
2. 注册 Auto 集成：`yield permissionPresets.registerAuto(admit)`；`admit` 为同步函数，关闭或未启用时抛错。
   **必须捕获 `preset "auto" is already registered`** 并转成一条清晰的中文 warn：
   "官方 dsh-experimental-auto-review 已注册 Auto，本插件无法同时启用；请先禁用其一"。
3. 订阅 `tools/pre-execute`（`{ prepend: true }`）：
   - `exec.agent` 缺失 → `return next()`
   - `exec.parent === undefined && exec.name === 'run_code'` → `return next()`（不审查外层 PTC 传输）
   - `ctx.permissionPresets.current(exec.agent.session) !== 'auto'` → `return next()`
   - 组件关闭中或已 abort → `return { kind: 'cancel' }`
   - 组装上下文 → 解析路由 → `ctx.llm.stream(...)`（带 `AbortSignal.any([exec.signal, lifecycle.signal])` 与超时）
   - `allow` → `return next()`
   - `deny`：
     - `ctx.approval.overrideOf(session) === 'never'` → 终局拒绝：
       `{ kind:'deny', reason: 'Auto review rejected tool "<name>"; its body was not executed', info: { name:'AutoReviewDeniedError', code:'AUTO_REVIEW_DENIED', ...(reason?{reason}:{}) } }`
     - 否则先 `await next()`：若下游不是 `allow` 则返回下游结果；若下游是 `allow` 则返回
       `{ kind:'ask', reason: 'Auto review denied tool "<name>": <reason>', displayReason: { en: '...', zh: 'Auto review 拒绝了此调用…' } }`
   - **审查失败**（模型错误、非法输出、超时、路由不可解析）→ 一律按 deny 处理（fail-closed），
     reason 为 `Auto review of tool "<name>" failed; its body was not executed: <message>`。
     注意：失败**不**走"转人工审批"分支（与官方一致：失败是拒绝，不是询问）。
   - 热禁用/正常卸载：关闭准入并中止在途审查 → 使用官方 `setSandboxMode(session, 'read-only')` 收紧仍选中 Auto 的会话（保持审批策略）→ 成功后注销 Auto → 等待审查结清并清理监听器。
     热禁用若无法枚举会话或持久化收紧权限，保留 Auto 注册与拒绝守卫、显示错误。每代卸载清理须在该代 `registerAuto` effect 之后注册，避免逆序清理先注销 Auto 而丢失识别。强制卸载且会话写入失败时的宿主清理极限须明确报告，不能宣称完整保证。
4. `logDecisions` 为真时，每次判定用 `ctx.logger.info` 打一行：工具名、路由、风险、决定、耗时。

**性能红线**：审查期间不得遍历目录、不得读写文件；只允许读会话内存状态与发起一次模型请求。

---

## 8. 验收标准（中控逐条机械复核）

1. `node --check` 对 `lib/policy.js`、`lib/context.js`、`lib/index.js`、`test/selftest.mjs` 全部通过。
2. `node test/selftest.mjs` 退出码 `0`，覆盖下列断言（每条有可辨认名字）：
   - 合法决策解析：6 种合法形状全部通过；
   - 非法决策拒绝：`low+deny`、`high+allow`、`allow` 带 `reason`、重复成员、非 JSON、数组 → 全部抛错；
   - 路由解析：配置齐全 → 用配置路由；配置为空 + `fallbackToSessionRoute: true` → 用会话路由；配置不全 + fallback 关 → fail-closed；
   - 上下文组装：分区顺序正确；超出 `maxContextBytes` 时**先裁 RECENT_HISTORY**；`POLICY`/`PENDING_ACTION` 不被裁剪；
   - 审查失败 fail-closed：假 llm 流报错 / 返回非法 JSON / 超时 → 结果为 deny（不是 ask）；
   - deny + `ask` → 返回 `kind: 'ask'`；deny + `never` → 返回 `kind: 'deny'`；
   - allow → 调用 `next()` 且结果透传；
   - `run_code` 外层调用不被审查（直接 `next()`）。
3. `test/plugin-smoke.mjs`（或并入 selftest）：用假 ctx 桩调用 `apply(ctx, { enabled: false })` 不注册 Auto 或审查守卫（保留配置/状态与 volatile 更新订阅）；`apply(ctx, { enabled: true })` 时注册 `tools/pre-execute` 并调用 `registerAuto`。
4. README 写明：**与官方 `dsh-experimental-auto-review` 互斥**（两者都注册 `auto`，先加载者胜、后加载者报冲突）、
   `enabled` 默认关闭、失败即拒绝、审查要额外消耗一次模型请求的 token、不得与 `dsh-codex-connect` 的 `enableAutoReview` 同时启用。
5. 契约第 9 节硬约束全部遵守。

---

## 9. 硬约束

- 业务逻辑使用 `node:*`；官方 Config schema 与 sandbox canonical setter 作为声明的宿主 peer 使用，不捆绑另一套核心。测试依赖与运行 peer 分开；不私自写真实 profile 或建立第二份配置文件。
- 不修改 `C:\Program Files\DSH NEXT` 下任何文件；不写 `~/.dsh`。
- 不执行 `git commit` / `git push`。
- **不得逐字复制官方 `dsh-experimental-auto-review/lib/index.js` 的代码块**：可以读它来理解行为与内部 API 用法，
  但实现必须自写（官方那段是压缩产物，且其快照逻辑强依赖不稳定内部 API）。
- 代码注释与 CLI 输出用中文。
- 任何"猜"出来的 API 用法或依赖内部 API 的地方，必须在 README 的"未核实项"一节逐条列出。
