# 设计契约 · dsh-audit-rollback（阶段 A 已实现 · 阶段 B 待实现）

> 本文件是实现的**唯一真源**。凡是本文件写定的字段名、路径布局、语义与退出码，实现必须逐字遵守；
> 未写定的细节可自行决定，但必须在 README 中记录。
> 所有"DSh 事实"一节的内容已在核心 `@deepseek-ai/dsh 0.2.1-alpha.1` 上核实，**不要重新猜测，也不要改写**。

> **修订记录**
>
> - 2026-10-04：阶段 A 契约（§1–§9），交付并发布 `0.3.3`。
> - 2026-10-11：**需求变更**。用户要的是 OpenCode 式能力：发错命令能**停止**、能**回到上一条消息**、
>   文件改动与该边界**一起回滚**，且**文件审计要完整**（含 shell 改动），当前 DSH 只有文件 diff。
>   阶段 A 的"只覆盖文件工具点名的路径、不覆盖 shell、不做影子快照"因此**不再成立**：
>   新增 §10「阶段 B：步级快照与边界回滚」，并同步改写 §1 的目标/非目标。
>   **§2–§9 的字段、路径、账本条目与 CLI 语义对阶段 A 的既有实现继续逐字有效**，
>   阶段 B 只**追加**（新增 kind、新增命令、新增 config 字段），不得改写或删除阶段 A 已写定的任何形状。
>   唯一例外：§2.1 与 §6.7 中把 `gitSnapshot` 描述为"永远未实现的占位开关"的句子，按 §10.4 改为"阶段 B 的实现入口"，
>   字段名与默认值保持不变（`gitSnapshot` 升级为阶段 B 的总开关，默认仍为 `false`）。
> - 本阶段的 DSh 事实在 §10.1 重新核实（源：核心 0.2.1-alpha.2 安装树），与 §5 并列，互不覆盖。

- 仓库根：`D:\dsh-guard`
- 包目录：`D:\dsh-guard\packages\dsh-audit-rollback`
- 目标核心版本：`@deepseek-ai/dsh 0.2.1-alpha.1`（安装根 `C:\Program Files\DSH NEXT`）

---

## 1. 问题与目标

DSH 当前（0.2.1-alpha.1）**没有任何回滚能力**，审计也只是半个：

- `dsh-workspace-changes` 能给出每轮改动文件与 diff，但摘要、快照树与副本**只存活在 Host 进程内存**，重启即失；
- 工作区不是 git 仓库时，它只覆盖「文件工具点名的路径」，shell 命令的改动完全不入账；
- 全安装树没有 revert / undo / restore 入口。

本包要补上：**持久化审计账本** + **可精确回滚的编辑前内容**（阶段 A，已实现），
并在其之上补上**步级快照与边界回滚**（阶段 B，见 §10）：能停下、能退到某条消息、能把该消息之后的文件改动一起退回去。

阶段 B 的完整目标（对应用户 2026-10-11 的需求）：

1. **停止**：轮次被取消/中断时，立即固化"中断点快照"，并让"回滚到本轮的边界"成为一条可用动作；
2. **回到上一条消息**：以轮（`turn`）、步（`step`）为边界的回退入口，粒度对齐 OpenCode 的 model step；
3. **文件与该边界一起回滚**：只回退"该边界之后**被归属**的路径"，边界处不存在的文件移除，无关路径不动；
4. **审计完整**：工作区内的改动**不再依赖"文件工具点名"**——shell、其它插件、人工编辑同样入账；
5. **可撤销回滚**（`redo`）：与 OpenCode 的 `/redo` 对齐。

### 非目标

- 不做模型侧工具注册（只提供 Host 侧捕获/快照 + 独立 CLI + 设置与页签）。
- **会话消息本身的删除/回退不在本包能力内**：DSH 会话是 append-only 事件流，且 projection 缓存、`session/flush`
  落盘屏障、`dsh-session-query-sqlite` 索引、会话格式 v0→v4 迁移链都挂在事件序号的一致性上；
  插件截断事件流会把这套一致性打碎。阶段 B 的文件回滚**不要求**会话回退即可独立生效；
  会话级 `revert(fromSeq)` 作为**上游提案**记录在 §10.11，并提供"被回滚轮次的 prompt 回收"作为降级（见 §10.6）。
- 不逆转工作区之外的效果：进程/服务、网络、数据库、git 元数据（`.git` 目录）与工作区外文件一律不覆盖（§10.9）。
- 不做工作区事务/原子性承诺：快照是**尽力而为**的便利能力，不是备份，也不是事务（§10.9 明写）。

---

## 2. 交付物

```
packages/dsh-audit-rollback/
  package.json          # ESM；dsh.bundle.patch 指向 cordis.patch.yml；bin 指向 CLI
  cordis.patch.yml      # 只 insert 本插件一行，含保守默认 config
  README.zh.md          # 中文：能力、限制、安装、CLI 用法、数据布局
  lib/ledger.js         # 存储层：账本 + CAS + 回滚计划 + 执行（纯 node，无 Cordis 依赖）
  lib/index.js          # Cordis 插件：订阅事件、调用 ledger
  scripts/audit-rollback.mjs   # CLI（可执行，带 shebang）
  test/selftest.mjs     # 离线自测，纯 node，退出码 0 表示全通过
```

`lib/ledger.js` 必须**不依赖 Cordis**，以便 CLI 与测试独立使用。插件侧只做事件适配。

> 阶段 B（§10）在此之上新增 `lib/snapshot.js`、`lib/boundary.js` 与两个测试文件；阶段 A 的交付物清单与职责不变。

### 2.1 `cordis.patch.yml` 的默认 config（2026-10-04 中控补写）

> 更正记录：本小节此前**在契约正文中缺失**。中控曾据一份早期临时文件声称"契约第 9 节写定了这些默认值"，
> 该引用不成立 —— 第 9 节是「硬约束」六条，全文没有 yaml 块。
> 实现作者如实上报了"出处无法核实"并按其裁定值执行，判定正确。现把裁定值正式补入契约，作为唯一真源。

```yaml
- insert:
    - id: audit-rollback
      name: dsh-audit-rollback
      config:
        captureTools: ['write', 'edit', 'str_replace_editor']
        captureMaxBytes: 2097152          # 2 MiB
        argsMaxBytes: 4096
        logCalls: true
        excludeGlobs: ['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/']
        # ---- 阶段 B（B2b，字段语义见 §10.2.1）。必须写全：Loader 对同一 id 的 config 是整体替换。----
        gitSnapshot: false
        snapshotMode: 'per-step'
        snapshotExcludeGlobs: ['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/', '/audit-rollback/']
        snapshotIgnorePolicy: 'git'
        snapshotMaxFiles: 50000
        snapshotMaxBytes: 536870912       # 512 MiB
        snapshotScanMs: 5000
        snapshotTimeoutMs: 10000
        snapshotAutoExcludeOversized: false
        rollbackOnAbort: 'prompt'
        snapshotRetentionDays: 14
```

配套要求：

1. `stateDir` **不写**在 patch 里（回落 `$DSH_HOME/audit-rollback` → `~/.dsh/audit-rollback`）。
2. **代码内部默认值必须与上表逐字段一致**：因为 Loader 对同一 id 的 config 是整体替换，profile 里漏写字段会回落到代码默认值；两处不一致会产生"配了 A 得到 B"的隐蔽偏差。实现必须两处同值，并在报告中列出对照表。
3. `excludeGlobs` 的匹配语义（实现作者发现并修正的关键点）：**不含通配符的模式按路径片段（子串）匹配**，含通配符的模式才走 glob 语义（`*` 不跨分隔符、`**` 跨分隔符、`?` 单字符）。若一律按全串 glob 解释，`'/node_modules/'` 这类写法永远命不中，默认排除会形同虚设。此语义必须同时写进 patch 注释与 README 配置表。
4. `gitSnapshot` 是**阶段 B 的总开关**（2026-10-11 修订，原"永远未实现的占位开关"作废）：默认 `false`。
   `false` 时行为与阶段 A 完全一致（不建快照库、不调 git）；`true` 时按 §10 实现步级快照与边界回滚。
   阶段 A 交付的 `0.3.3` 里该字段仍为占位（为 `true` 只记一条 `note` + `warn`），这一历史口径**保留不删**，
   但新的实现必须以 §10 为准。字段名与默认值不变。

---

## 3. 数据目录布局

`stateDir` 解析顺序：config.`stateDir`（展开 `~`）→ `$DSH_HOME/audit-rollback` → `~/.dsh/audit-rollback`。

```
<stateDir>/
  state.json                    # {"version":1,"createdAt":"<ISO>"}（首次写入时创建，不覆盖已有）
  ledger/YYYY-MM-DD.jsonl       # 审计账本，按 UTC 日期分文件，append-only
  objects/<sha1[0:2]>/<sha1>    # 内容寻址对象库，内容 = 原始字节，写入幂等（同 hash 只存一份）
  trash/<ISO 时间戳去冒号>/<卷标识>/...  # 回滚时被覆盖或移除的原文件（卷标识规则见下）
```

- `objects` 里的对象**永不删除**（去重的代价可接受；README 要写明清理方式）。
- `trash` 是回收站，回滚不直接删除文件。

**trash 路径规则（2026-10-04 修正 F1 阻断；原「按绝对路径去掉盘符后展开」的规则作废）**

1. **卷标识必须保留盘符信息**：Windows 用盘符字母目录（`C/Users/...`、`D/Users/...`），其它平台用其卷根的可读转写。**一律不得去掉盘符**——去掉后 `C:\...\same\file.txt` 与 `D:\...\same\file.txt` 会映射到同一个 trash 路径，后一次备份覆盖前一次，先备份的字节**不可恢复**（独立核验已实证，且当时 CLI 仍报 trash 成功）。
2. **trash 目标已存在时禁止覆盖**：追加 `-1`、`-2` … 序号直到取到未占用的名字。任何情况下都不得让一次备份覆盖另一次备份。
3. **先备份、确认成功、再改动**：备份不得与移除/覆盖交错；备份失败则该条降级为 `skip`，不得继续动原文件。

---

## 4. 账本条目（JSONL，每行一个 JSON 对象）

**字段名逐字固定**。所有条目都有 `v`（恒为 `1`）与 `ts`（ISO 8601 字符串）与 `kind`。

| kind | 额外字段 | 含义 |
|---|---|---|
| `turn/start` | `session`, `turn`, `cwd` | 顶层轮次开始 |
| `call` | `session`, `turn`, `tool`, `callId`, `argsSha1`, `argsPreview`, `targets` | 一次工具调用（`logCalls: true` 时） |
| `capture` | `session`, `turn`, `path`, `phase`(`before`\|`after`), `hash`(\|null), `bytes`, `existed`(bool) | 某路径在某相位的内容快照 |
| `turn/end` | `session`, `turn`, `captured` | 轮次结束，`captured` 为本轮捕获过的路径数 |
| `rollback` | `session`, `turn`, `applied`(bool), `actions`(数组) | 一次回滚（计划或已执行） |
| `note` | `text` | 自由记录（如"gitSnapshot 未实现"） |

约定：

- `hash` 是文件**原始字节**的 SHA-1 十六进制小写；`existed: false` 时 `hash` 为 `null` 且 `bytes: 0`。
- `path` 一律写**绝对路径**（Windows 用原生反斜杠）。
- `targets` 是本次调用识别出的目标路径数组（识别不出则为 `[]`）。
- `argsPreview` 是参数 JSON 的截断预览（截断长度取 config `argsMaxBytes`，默认 4096，UTF-8 字节）。
- `actions` 元素：`{"path": "...", "action": "restore"|"trash"|"skip", "from": "<sha1|null>", "reason": "<可选>"}`。
- **同一轮同一路径的 `before` 只写第一条**（第一次编辑前的状态），后续编辑不再覆盖它。
- 账本只追加，任何操作**不得改写或删除已有行**。

---

## 5. DSh 事实（已核实，直接用）

### 5.1 Cordis 插件形态

```js
export const name = 'audit-rollback'
export const inject = ['tools']
export function apply(ctx, rawConfig) { /* ... */ }
```

- 只用 **`node:*` 内建模块**，**不得 import 任何 `@deepseek-ai/*`**（工作区外插件解析不到核心包）。
- 日志：`ctx.logger.info/warn`。
- 可选服务探测用 `ctx.get('name')`，取不到不得抛错。
- 清理用 `ctx.effect(() => () => { ... })`。

### 5.2 事件签名（逐字核实）

```js
ctx.on('session/event', (session, event) => {
  // event.type === 'turn/start' → event.data.turn
  // event.type === 'tool/result' | 'turn/end' → event.data.turn
  // session.id、session.header.cwd
})
ctx.on('session/disposed', (session) => {})
ctx.on('agent/turn-stopping', async ({ agent, turn }) => {})
ctx.on('tools/pre-execute', async (exec, next) => { /* 必须返回 next() 的结果或决策对象 */ }, { prepend: false })
```

- `tools/pre-execute` 的 `exec` 字段：`name`、`arguments`、`callId`、`rootCallId`、`parent`、`schema`、`signal`、`agent`。
- `exec.agent.session` 即当前会话；`session.header.cwd` 是会话工作目录。
- `ctx.on(...)` 返回 disposer（在 `ctx.effect` 里 yield 可随 fiber 回收）。
- **本插件在 `tools/pre-execute` 里绝不能改变调用结果**：内部异常只 `ctx.logger.warn`，然后 `return next()`。
- `exec` 里**没有轮号**。轮号从 `session/event` 的 `turn/start` 维护（`Map<sessionId, turn>`）；未知时用 `-1`。

### 5.3 参考实现（只读参考，不要复制大段代码）

- 官方同源实现：`C:\Program Files\DSH NEXT\resources\app\node_modules\@deepseek-ai\dsh-workspace-changes\lib\index.js`（39 KB，压缩后）。
  它的 `TurnRecorder`、`tools/pre-execute` 捕获时机、`agent/turn-stopping` 处理与 `session/event` 分发可直接对照。
- 本机插件惯例（中文注释、config 规范化、容错）：
  `C:\Users\Fractal\.dsh\local-plugins\dsh-preset-tool-guard\lib\index.js`
- 工具 schema 事实来源（用于确认参数键名）：
  `C:\Program Files\DSH NEXT\resources\app\node_modules\@deepseek-ai\dsh-tool-fs\lib\index.js`（`write`、`edit`）
  `...\@deepseek-ai\dsh-tool-str-replace-editor\lib\index.js`（`str_replace_editor`）

### 5.4 目标路径识别

`captureTools` 默认 `['write', 'edit', 'str_replace_editor']`。
从 `exec.arguments` 中按顺序探测这些键：`path`、`file_path`、`filePath`、`filename`；取第一个字符串值。
相对路径用 `session.header.cwd` 解析为绝对路径（`node:path` 的 `resolve`）。
识别不出路径时：写 `call` 条目（`targets: []`），不写 `capture`，不报错。

---

## 6. 插件行为

1. **加载**：`state.json` 不存在则创建；建 `ledger/` 与 `objects/` 目录；打一行 banner（含 stateDir、captureTools、captureMaxBytes、gitSnapshot 状态）。
2. `turn/start`：记条目，初始化该会话该轮的 `capturedPaths = Set()`、`beforeSeen = Set()`。
3. `tools/pre-execute`：
   - `logCalls` 为真时记 `call`；
   - 工具名在 `captureTools` 内且路径被识别出，且该路径本轮**尚未捕获 before**，且路径不命中 `excludeGlobs`：
     读文件当前字节 → 若大小 ≤ `captureMaxBytes` 则 `putObject` 并记 `capture/before`；超限则记 `capture/before` 但 `hash: null`、`bytes: <实际大小>`、`existed: true`，并写一条 `note` 说明超限；
   - 文件不存在 → 记 `capture/before` 且 `existed: false`、`hash: null`；
   - 全部动作包在 try/catch 内，失败只 warn。
4. `agent/turn-stopping`：对本轮所有已捕获路径做一次 `capture/after`（整轮只做一次，用标志位）。
5. `turn/end`：若尚未做 after 捕获则补做，然后记 `turn/end`，清理该轮内存态。
6. `session/disposed`：清理该会话的轮号与轮状态。
7. `gitSnapshot: true` 时（阶段 A 口径，保留为历史事实）：**不实现快照**，加载时 `ctx.logger.warn` 一行、
   并写一条 `note` 条目说明"gitSnapshot 未实现"，其余行为不变。阶段 B 把这一条替换为 §10.4 的快照引擎；
   `gitSnapshot: false` 时阶段 A 与阶段 B 的行为必须逐字一致（这是阶段 B 的回归红线）。

**性能红线**：`tools/pre-execute` 里只允许"读一个文件 + 写一个对象"，不得遍历目录；同一路径同一轮只读一次。

---

## 7. CLI 规格

`scripts/audit-rollback.mjs`，纯 `node:*`，带 `#!/usr/bin/env node`，可被 `node <path>` 直接运行。

```
audit-rollback list     [--state <dir>] [--session <sid>] [--turn <n>] [--limit N] [--json]
audit-rollback sessions [--state <dir>] [--json]
audit-rollback show     <sessionId> <turn> [--state <dir>] [--json]
audit-rollback undo     <sessionId> <turn> [--state <dir>] [--apply] [--force]
audit-rollback last     [--state <dir>] [--apply] [--force] [--json]
```

语义：

- **默认 dry-run**：只打印将执行的动作，不碰文件系统；`--apply` 才真正执行。
- `list`：按时间正序列出条目（默认 `--limit 50`）。
- `sessions`：列出出现过的 sessionId 及其轮次范围与捕获文件数。
- `show`：打印该轮的全部 `capture` 条目与当前文件状态（存在/哈希是否与账本一致）。
- `undo` / `last`：
  - 收集该轮所有 `before` 捕获（同路径取最早一条）；
  - **一致性参照 = 该轮该路径的 `after` 捕获**（该轮没有 `after` 时才用该轮 `before`）。**不得**用「全账本最后一条 capture」——那会把后轮已捕获的改动误判为"一致"，从而默认覆盖后轮成果（独立核验已实证 F2：`undo` 旧轮 exit 0 直接 restore，工作副本被覆盖）：
    - 当前文件哈希与参照一致 → 计划 `restore`（`existed: true`）或 `trash`（`existed: false`）；
    - 不一致（含该路径在后续轮次另有 `capture`、或当前内容与参照不匹配）→ 计划 `skip`，`reason` 写明"轮后已被改动"；只有 `--force` 才改为正常执行；
  - `show` 必须使用与 `undo` **完全相同**的参照口径，两处结论不得互相矛盾；
  - 执行顺序必须是**先备份、后改动**：先把当前内容写入 `trash/<时间戳>/<卷标识>/…`（按 §3 的规则，不得覆盖已有备份），确认成功后再恢复或移除；
  - `restore` 的内容来自 CAS；**CAS 对象缺失必须在任何移动发生之前判定**（例如计划阶段就校验对象存在性）→ 该条降级为 `skip`，`reason: "对象缺失"`。若因竞态在文件已被搬走之后才发现缺失，`reason` 必须写明"原路径已移入 trash"，并尽力把文件搬回原位——**不得在文件已离开原路径的情况下谎报 skip**。
  - 写一条 `rollback` 条目（`applied` 反映是否真的执行）；
- **退出码**：`0` 全部完成；`1` 参数错误或状态不可读；`2` 有文件被 `skip`（部分完成）；`3` 该轮没有可回滚的捕获。

输出用中文，`--json` 时输出机器可读 JSON（字段名与账本一致）。

---

## 8. 验收标准（中控会逐条机械复核）

1. `node --check` 对 `lib/ledger.js`、`lib/index.js`、`scripts/audit-rollback.mjs`、`test/selftest.mjs` 全部通过。
2. `node test/selftest.mjs` 退出码 `0`，且**至少**覆盖下列断言（每条要在输出里有可辨认的名字）：
   - CAS 去重：同一内容两次 `putObject` 只产生一个对象文件；
   - `before` 只记第一条：同轮同路径两次捕获，账本里 `before` 只有一条；
   - 恢复已存在文件：`undo --apply` 后文件字节等于 before 内容；
   - 新建文件回滚：文件被移入 `trash`，原路径消失；
   - 轮后被改动：默认 `skip`，`--force` 后恢复成功；
   - 账本 append-only：回滚前后已有行字节不变（只追加）。
3. **插件可加载性**：`test/` 里另加一个 `plugin-smoke.mjs`（或并入 selftest），用最小假 ctx 桩（`{ logger:{info,warn}, on:()=>()=>{}, get:()=>undefined, effect:(fn)=>{...} }`）调用 `apply(ctx, {})`，断言不抛错且注册了 4 个事件名（`session/event`、`session/disposed`、`agent/turn-stopping`、`tools/pre-execute`）。
4. **端到端**：在临时目录跑通 `list` → `undo`(dry-run) → `undo --apply` → 用 `show` 复核状态，并把完整命令与输出贴进交付报告。
5. 说明书：`README.zh.md` 写清能力、**明确写出限制**（只覆盖文件工具点名的路径、shell 改动不入账、objects 永不自动清理；现已提供配置/状态 GUI，回滚仍为离线 CLI），并给出安装前的人工步骤（不改 `~/.dsh`，不自动安装）。

---

## 9. 硬约束

- 不修改 `C:\Program Files\DSH NEXT` 下任何文件。
- 不写 `~/.dsh`（测试一律用 `test/` 下的临时目录，或系统临时目录，并在结束时清理）。
- 存储/回滚层仅使用 `node:*`；可编辑设置的 Config schema 使用声明的官方宿主 peer，不捆绑核心副本。配置写入由官方 Settings/ConfigEditor 管理，不另建配置文件。
- 不 `git commit`、不 `git push`（由中控决定提交）。
- 代码注释用中文，风格对照 `dsh-preset-tool-guard`。
- 任何"猜"出来的 API 用法，必须在 README 的"未核实项"一节列出。
- **测试必须跨平台**（2026-10-04 补，来源：首次 CI 在 `ubuntu-latest` 上 9 秒失败）：CI 跑 Linux、本地是 Windows，测试与实现都**不得依赖 Windows 专有语义** —— 盘符、`\` 分隔符、`path.resolve` 的平台行为、盘符大小写敏感度。平台相关行为必须**按平台分支断言**（`process.platform === 'win32'`），或改用与平台无关的合成输入（例如显式传入已构造好的绝对路径，而不是让测试去 `resolve` 一个 `C:/...` 字符串）。任何新增测试在提交前必须能**同时在 Windows 与 Linux 上通过**；只在一端跑过的测试不得声称通过。

---

## 10. 阶段 B：步级快照与边界回滚（2026-10-11 新增）

> 目标一句话：让"停下来的那一刻"和"某条消息之前"都成为**可恢复的边界**，且不再依赖"哪个工具碰过哪个文件"。
> 对齐对象是 OpenCode 的 snapshots/`/undo`/`/redo`，但**不依赖工作区本身是 git 仓库**（本机 `~/.dsh` 就不是，
> 而 OpenCode 的 `/undo` 在非仓库里只能回退会话、不能恢复文件——§10.9 明确写出这条差异）。

### 10.1 DSh 事实（2026-10-11 复核，核心 0.2.1-alpha.2 安装树）

- 会话事件里**存在步级锚点**：`step/start` 与 `step/end`，payload 均为 `{ turn, step }`，
  由 agent loop 通过 `session.append(...)` 写入（`@deepseek-ai/dsh-agent-loop`），
  因此 `ctx.on('session/event', (session, event) => ...)` 能收到它们，且 `event.seq` 可用于排序与去重。
- 会话格式的 projection 自身也记录 `lastStepBoundary`（`kind: 'start' | 'end'` + `seq`），
  说明"步边界"是核心既有概念，插件按同样口径对齐即可，**不引入新的边界定义**。
- 轮级锚点：`turn/start { turn }`、`turn/end { turn, reason }`。
- 中断锚点：`agent/turn-stopping ({ agent, turn })`（阶段 A 已在用）。
- 变更意图拦截点：`fs/write-intent`、`fs/edit-intent`（官方 `dsh-workspace-changes` 以 `{ prepend: true }` 包裹并按
  `(target, actor, next)` 使用；**本阶段只把它列为可用点，签名须按目标安装的官方实现逐字复核后再用**，
  复核结果记入 README「未核实项」——不得凭本行推断参数形态）。
- 工具派发点：`tools/pre-execute`（阶段 A 已在用；**本阶段新增硬性约束：此处不得做快照**，见 §10.10）。
- 影子库不得与用户仓库互相影响：所有 git 调用必须**显式传 `--git-dir` 与 `--work-tree`**，
  且从子进程环境里剔除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_COMMON_DIR`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`。
- 插件仍只用 `node:*`（git 走 `node:child_process`），不 import 任何 `@deepseek-ai/*`（§5.1 不变）。

### 10.2 阶段 B 交付物（新增，不改 §2 既有文件职责）

```
packages/dsh-audit-rollback/
  lib/snapshot.js       # 影子库引擎：init / capture(tree) / diffTrees / restore / gc（纯 node:*，不依赖 Cordis）
  lib/boundary.js       # 边界账本：步/轮边界、归属路径集合、恢复计划（纯 node:*）
  test/snapshot.mjs     # 快照引擎自测（可用临时目录 + 本机 git；无 git 时必须走降级分支断言）
  test/boundary.mjs     # 边界回滚自测（恢复/移除/不动/降级/redo）
```

`lib/ledger.js` 的既有导出**一个都不许改签名**；阶段 B 只允许追加导出。`lib/index.js` 只追加监听与远端方法。

#### 10.2.1 阶段 B 的配置字段（B2b 写定）

`gitSnapshot` 从"未实现的占位开关"变为**阶段 B 总开关**（默认 `false`）。新增字段全部 `.volatile()`
（`stateDir` 仍是普通字段、只读）。**`gitSnapshot: false` 时不注册任何新行为**——这是 B2b 的回归红线：
`test/snapshot-wiring.mjs` 用假 ctx 直接断言"不写 `snapshot`/`attribution` 条目、不创建影子库"。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `gitSnapshot` | boolean | `false` | 阶段 B 总开关 |
| `snapshotMode` | `per-step` \| `per-turn` | `per-step` | 步级（对齐 OpenCode 的 model step）或轮级 |
| `snapshotExcludeGlobs` | string[] | `['/node_modules/','/.git/','/.dsh-memory/','/.graphflow-cache/','/audit-rollback/']` | 影子库排除表（匹配语义同 §2.1 第 3 条） |
| `snapshotIgnorePolicy` | `git` \| `force` | `git` | `git` 尊重 `.gitignore`；`force` 用 `add -A -f` 纳入被忽略产物 |
| `snapshotMaxFiles` | 正整数 | `50000` | 预算：文件数上限 |
| `snapshotMaxBytes` | 正整数 | `536870912` | 预算：字节上限（512 MiB） |
| `snapshotScanMs` | 正整数 | `5000` | 盘点时间窗口（逐项检查，到顶即 `partial`） |
| `snapshotTimeoutMs` | 正整数 | `10000` | 单次 git 调用超时 |
| `snapshotAutoExcludeOversized` | boolean | `false` | 超预算时是否只排除 `oversized` 顶层项后重试一次 |
| `rollbackOnAbort` | `off` \| `prompt` \| `auto` | `prompt` | 中断联动档位（**B2b 只落配置与展示；联动实现属 B5**） |
| `snapshotRetentionDays` | 非负整数 | `14` | `gc --keep-days` 的默认保留期（0＝不保留历史边界） |

约束与形状：

- **Loader 对同一 id 的 config 是整体替换**：`cordis.patch.yml` 必须把全部字段写全，且与代码默认值逐字段一致
  （§2.1 第 2 条的老规矩）。
- 只读状态新增 `status.shadow = { enabled, workspaceKey, objects, refs, autoExcluded, fused }` 与
  `status.snapshotStats = { boundaries, lastTurn, lastStep }`；其中 `autoExcluded`（最近一次自动排除的顶层项）
  与 `fused`（熔断原因）**必须可见**——它们意味着审计覆盖面已被缩小或已停止尝试（2026-10-11 复核后补）。
  账本 `byKind` 增加 `snapshot` / `attribution` / `abort` 三个键（旧 CLI 读新 kind 必须跳过而非报错，见 §10.5）。
- 接线侧（`lib/index.js`）另加**串行队列**：所有影子库操作排队执行（§10.4 第 5 条），
  并在 `pendingBoundaries` 里按会话配对 start/end；**start 降级时不写归属**（否则 end 侧会把整棵树当成"新增"）。

### 10.3 影子库布局（追加到 §3 布局之下）

```
<stateDir>/
  shadow/<workspaceKey>/            # 影子 git 库（GIT_DIR），bare，永不进入用户仓库
    HEAD  config  objects/  refs/   # config 写 core.worktree = <被审计根>
    index                           # 影子库自己的 index；绝不复用用户仓库的 index
    WORKTREE                        # 明文写被审计根的绝对路径，供人读与漂移校验
  recovered-prompts/                # 被回滚轮次的用户提示文本（§10.6）
```

- `workspaceKey` = 被审计根**规范化绝对路径**（Windows：盘符转大写、`\` 转 `/`）的 SHA-1 十六进制前 16 位。
  路径口径必须与 `canonicalPathKey` 的既有语义一致，**不得**另造一套规范化。
- 每个边界**必须**写 ref：`refs/dsh/<sessionKey>/t<turn>s<step>-<start|end>`（`sessionKey` = sessionId 的安全转写）。
  理由：没有 ref 的对象会被 `git gc` 当作不可达而清除；写 ref 同时给人工检查留出 `git log --all` 入口。
- `shadow/` 下**不得**出现用户的 `.git` 目录内容；被审计根下的 `.git` 一律按排除路径处理（§10.9）。

### 10.4 快照引擎语义（`lib/snapshot.js`）

1. **初始化**：`gitSnapshot: true` 且会话工作目录存在时，首次需要快照才建库（懒初始化），
   建库失败（git 不可用、目录不可写、超时）→ 写 `note` 条目 + `warn`，本会话**永久降级到阶段 A 能力**，不得反复重试。
   **实现口径（2026-10-11 复核后写定）**：环境性失败即**熔断**——`GIT_UNAVAILABLE`、`INIT_FAILED`、
   `WORKTREE_MISMATCH`、`SCAN_UNREADABLE`、`TIMEOUT`、`OVER_BUDGET`、`SCAN_INCOMPLETE` 之一首次出现时，
   写一条 `note`、告警一次，此后本插件实例对该 stateDir **不再尝试快照**（直到插件重载），
   避免"每个边界都重试 + 重复告警"（复核实证过该反例）。非环境性失败（如锁冲突）仍逐次告警，因为它可能自愈。
2. **捕获**：`capture(root)` = `add -A` → `write-tree` → 返回 `{ tree, files, ms, degraded }`。
   - 排除：`snapshotExcludeGlobs`（默认 `['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/', '/audit-rollback/']`）
     转成 git pathspec `:(exclude)`；语义与 §2.1 第 3 条一致（无通配符按路径片段，含通配符按 glob）。
   - 忽略策略 `snapshotIgnorePolicy`：
     - `'git'`（默认）：尊重 `.gitignore` 与 `core.excludesFile`，即被忽略的产物**不进快照**（与 OpenCode 同）；
     - `'force'`：用 `add -A -f` 强制纳入（用于"构建产物也想回滚"的仓库，代价是体积）。
   - 索引：始终用影子库自己的 `<GIT_DIR>/index`；**不得**写用户的 index。
3. **归属**：`diffTrees(A, B)` = 解析 `git diff-tree -r -M --numstat <A> <B>`，输出
   `{ path, added, deleted, binary }` 数组；路径统一转成绝对路径（相对被审计根解析）。
4. **粒度**：`snapshotMode: 'per-step' | 'per-turn'`（默认 `'per-step'`，对齐 OpenCode）。
   - `per-step`：`step/start` 前捕获 A、`step/end` 后捕获 B，归属 = `diffTrees(A, B)`；
   - `per-turn`：只在 `turn/start` / `turn/end` 各捕获一次，归属 = 整轮 diff（步级命令仍可用，但只在步边界不可用时退化为轮边界）。
5. **串行化**：所有快照走同一条串行队列（一次只跑一个 git 子进程）；`snapshotTimeoutMs`（默认 `10000`）超时即
   `degraded: true` 并放弃该次快照——**不得**让快照拖住轮次推进。
   **配对规则（2026-10-11 复核后写定）**：start/end 必须按 `(session, turn, step)` 三元组配对；
   `end` 找不到**同键**的 `start` 时只写 end 快照、**不写归属**；`turn/end` 与 `session/disposed` 都要清理
   该会话（该轮）未配对的 start。只按 sessionId 配对会让交错事件把 end 配到别人的 start，
   使归属的 `from` 与它声明的 turn/step 脱节——而归属是回滚的唯一依据（复核实证过该反例）。
   **追拍窗口**：快照是异步追拍，"事件时刻 → 真正捕获"的差值记入 `lagMs`；该值超过阈值
   （实现取 250 ms）且归属为空时，必须写 `note` 说明"本步归属可能不完整"，不得静默。
6. **工作区预算（2026-10-11 实测后追加，必须实现）**：`add -A` 之前先跑一次轻量盘点（`scanBudget`），
   按顶层项累计文件数与字节数，任一顶层项自身超预算即停止深入该子树并标 `oversized`。
   默认预算 `maxFiles: 50000`、`maxBytes: 512 MiB`、`scanMs: 5000`（可在 config 覆盖）。
   超预算时**默认拒绝**（`reason: 'OVER_BUDGET'`，结果带 `oversize` 最重顶层项清单）；
   只有调用方显式要求（`autoExcludeOversized`）才把最重目录并入排除表后**重试一次**，仍超预算则仍拒绝。
   **默认不自动排除**：自动排除会静默缩小审计覆盖面，必须由调用方决定并记账（`note` 条目 + 设置页展示）。
   依据见 §10.15 的实测数字。
   **盘点未扫完也要拒绝**（2026-10-11 加固轮补）：若 `scanBudget` 因 `scanMs` 到顶而返回 `partial: true`，
   则"未超预算"**不可信**——此时必须返回 `reason: 'SCAN_INCOMPLETE'` 并拒绝，
   不得据 partial 的结果放行 `add -A`（那正是分钟级挂起的入口）。`autoExcludeOversized` 允许在这两种情形
   （超预算 / 未扫完）各自重试一次，重试后仍不达标一律拒绝。两条补充（2026-10-11 独立复核后写定）：
   - `autoExcludeOversized` 的重试**只允许排除 `oversized === true` 的顶层项**。
     把 `heaviest` 前若干项整体排除，会把正常目录与顶层文件静默踢出快照（复核实证
     `autoExcluded` 变成 `["/big/","/small1/","/small2/","/root.txt/"]`），**禁止**。
   - `scanBudget` 自身失败（`ok: false`，如根本不可读或根本不是目录）同样 **fail-closed**：返回
     `reason: 'SCAN_UNREADABLE'`；不得因为"三个拒绝分支都先判 `scanned.ok`"而落到 `add -A`。
     `captureTree` 还必须在最前面就拒绝"根不是目录"的情形（否则 git 子进程 cwd 非法，报出的是
     误导性的 `GIT_UNAVAILABLE`，预算闸门也走不到）。
   - **时间闸门必须逐项检查**（每若干条目一次），不能只在进入子目录时检查：单层超大目录（数万文件）
     根本不进递归分支，`scanMs` 会被远远超越（复核实证 20000 个扁平文件在 `scanMs: 1` 下返回
     `partial: false`、`ms: 1025`，闸门因此放行）。
7. **`tools/pre-execute` 与 `fs/*-intent` 不在此列**：这两处只做阶段 A 的"读一个文件 + 写一个对象"和归属记录，绝不做 git 调用（§10.10）。

### 10.5 账本新条目（追加到 §4 表末，字段名逐字固定）

| kind | 额外字段 | 含义 |
|---|---|---|
| `snapshot` | `session`, `root`, `turn`, `step`, `phase`(`start`\|`end`), `tree`(\|null), `files`, `ms`, `degraded`(bool), `reason`, `autoExcluded`(可选，自动排除的顶层项), `lagMs`(可选，事件时刻与捕获时刻之差) | 一次边界快照；`reason` ∈ `step/start`、`step/end`、`turn/start`、`turn/end`、`abort`、`manual`。`autoExcluded` 非空即表示**该次快照的覆盖面已缩小**，必须同时有 `note` |
| `attribution` | `session`, `root`, `turn`, `step`, `from`, `to`, `paths`(数组) | 某步/轮的归属路径集合（`from`/`to` 为 tree 或 `null`） |
| `abort` | `session`, `root`, `turn`, `step`, `at`, `tree`(\|null) | 轮次被中断时固化中断点 |
| `rollback`（**扩展既有字段，不新增 kind**） | 追加 `source`(`cas`\|`snapshot`)、`root`、`step`、`boundary`(tree\|null)、`preTree`(tree\|null)、`postTree`(tree\|null)、`redoOf`(可空) | `actions` 元素保留 `path`/`action`/`from`/`reason`，追加 `treeFrom` 说明来源版本 |

> **`root` 是必需的**（2026-10-11 B3 实现时补）：影子库路径由 `workspaceKey(root)` 决定，
> 离线 CLI 必须能从账本还原被审计根，否则拿不到 `--root` 就无法定位影子库。
> 阶段 A 的旧条目没有该字段——此时 CLI **要求显式 `--root`，不得猜测**。
>
> **`postTree` 是 `redo` 的参照**：`preTree` = undo 之前的工作树（redo 的目标），
> `postTree` = undo 之后的工作树（redo 的一致性参照）。两者缺一，`redo` 必须**拒绝执行**而不是猜。
| `note`（复用） | `text` | 降级、超时、ignore 策略告警等 |

约定补充：

- `tree` 一律是 git tree oid（40 位十六进制小写）；不可用时写 `null`（**不得**写空字符串）。
- `boundary` 与 `attribution` 是**回滚的唯一依据**；阶段 A 的 `capture/*` 继续独立有效，
  两者冲突时以"更精确的来源优先"：单路径恢复优先用 `capture` 的 CAS 前像，整边界回滚用 `snapshot`/*`attribution`*。
- 账本 append-only 不变；新增 kind 对旧 CLI 是未知行，旧 CLI 必须**跳过而非报错**（回归红线）。
- **账本写入结果必须回传**（2026-10-11 B2 实现后追加）：`captureBoundary` / `recordAttribution` 必须返回
  `ledgerOk` 与 `ledgerError`。审计写失败**不得被静默吞掉**——快照成功但账本没写成，
  等于"有快照、无审计"，比快照失败更危险；调用方据此在会话里告警并可在设置页看到。
  边界层还必须自足地初始化 stateDir（`initState` 幂等），因为它同时被插件与离线 CLI 调用，
  不能假设"插件已经初始化过"。

### 10.6 恢复语义（与 OpenCode 的 Restore 表对齐）

`undo-to <sessionId> <turn> [--step <n>]` 的语义，逐条固定：

1. **边界** = 该 `(turn, step)` 的 `phase: 'start'` 快照 tree；缺 `step` 时用该轮的步级 start 快照中最靠前的一个，
   该轮无任何步级快照时退化为轮级 `turn/start` 快照。三档都缺 → 退出码 `4`（§10.7）。
2. **归属集合 P** = 边界之后（含该步/该轮及其后所有轮）所有 `attribution` 条目的 `paths` 并集。
3. **逐路径动作**（顺序即执行顺序）：
   - 路径在边界 tree 中存在 → `restore`：内容取该 tree 的 blob；
   - 路径在边界 tree 中不存在（边界后被创建）→ `trash`：先备份到 §3 的 `trash/<ISO>/<卷标识>/...`，确认成功后移除；
   - 路径**不在 P 中 → 一律不动**（这条是硬性不变量）。
4. **一致性参照**：与阶段 A §7 同口径——参照 = "P 中该路径在边界之后**最后一次**快照里的版本"。
   当前内容与参照不一致 → 默认 `skip` + `reason: "边界后被改动"`；`--force` 才执行。
   对象/blob 缺失一律 `skip`（`reason: "对象缺失"`），且必须在任何移动发生**之前**判定。
5. **redo**：执行 `undo-to --apply` 之前，先把"当前工作树"捕获为 `preTree` 写进 `rollback` 条目；
   `redo <sessionId> <turn>` 把同一 P 恢复到 `preTree`（同样先备份、同样受参照校验）。`redoOf` 指向被撤销的 `rollback` 条目。
   - **`preTree` 捕获失败 → 默认拒绝 `--apply`**（`reason: 'PRE_TREE_UNAVAILABLE'`，CLI 退出码 `4`）：
     改了文件却永久不可 redo，违背本包"可回滚"的核心承诺。调用方确实不需要 redo 时必须**显式**
     传 `allowWithoutRedo: true`（CLI `--no-redo`）才继续执行。
   - **`postTree` 在 `apply` 时一律记录**，即使本次全部动作被 `skip`（`changed === 0`）：
     它是"下一次 `redo`"的参照，缺了它链条会断在 `REDO_REFERENCE_MISSING`。
   - `redo` 的目标路径集合取目标条目**全部**动作路径（**含**上次被 `skip` 的），
     否则这些路径会从 redo 链条永久脱落。
   - **`preTree` / `postTree` 必须各自写一条 ref**（`refs/dsh/<sessionKey>/rb-<时间戳>-<pre|post>`）：
     它们原先只是裸 tree oid，可达性依赖 git 的 cruft pack（`gc.cruftPacks`）；仓库一旦关闭它或手工 prune，
     `redo` 就会失效。写 ref 后对象可达，并随 `gc --keep-days` 一起清理。写 ref 失败只降级（不阻断回滚本身），
     结果里以 `preTreeRef` / `postTreeRef` 返回。
6. **运行中拒绝**：会话有在飞轮次时拒绝执行（与 OpenCode 的 "rejects rollback while the session is running" 对齐）；
   CLI 无法查询 Host 状态，故 CLI 的帮助与 README 必须写明"执行前停止相关写入活动"（阶段 A §7 已有此约束，沿用）。
7. **只回滚文件，不动会话**：被回滚边界的用户提示文本写入 `<stateDir>/recovered-prompts/<sessionId>-t<turn>.txt`，
   GUI 提供"复制该提示"按钮（OpenCode 是直接放回输入框；DSH 客户端 composer 是否可写**列为未核实项**，不得假定）。

### 10.7 CLI 追加（在 §7 命令表之后追加，退出码 `0/1/2/3` 语义不变）

```
audit-rollback snapshot list   [--state <dir>] [--session <sid>] [--turn <n>] [--json]
audit-rollback snapshot show   <sessionId> <turn> [--step <n>] [--state <dir>] [--json]
audit-rollback diff            <sessionId> <turn> [--step <n>] [--path <p>] [--state <dir>] [--json]
audit-rollback undo-to         <sessionId> <turn> [--step <n>] [--state <dir>] [--apply] [--force] [--json]
audit-rollback redo            <sessionId> <turn> [--state <dir>] [--apply] [--json]
audit-rollback gc              [--state <dir>] [--keep-days N] [--apply] [--json]
```

- 默认 dry-run（`--apply` 才动文件）与"中文输出 + `--json` 机器可读"沿用 §7。
- **退出码 `2` 的判定澄清（2026-10-11 复核后写定）**：只要有归属路径、且其中**有动作被 `skip`**，就是 `2`
  （**包含"全部动作都被 skip"**）；只有"没有任何可处理动作（归属路径为空）"才是 `3`。
- **新增退出码 `4`**：边界快照不可用（该轮/该步无可用快照，或影子库降级）。
- **新增退出码 `5`**：没有可 `redo` 的回滚记录，或该记录的 `preTree`/`postTree` 参照缺失
  （只认 `applied: true` 且 `source: 'snapshot'` 的条目；缺参照时**拒绝执行**，不猜）。
- `gc` 默认只打印将清理的 ref 与对象数；`--apply` 先删 `--keep-days`（默认 `snapshotRetentionDays`）之外的
  `refs/dsh/*`，再 `git --git-dir=<GIT_DIR> gc --prune=now`；**不得**触碰 `objects/` 里被阶段 A CAS 引用的内容（两者物理隔离，见 §10.3）。

### 10.8 停止联动（"发错命令"的那一半）

1. 轮次被取消 → `agent/turn-stopping` 时：立即固化中断点（`abort` 条 + 一次 `capture`，
   `reason: 'abort'`），然后结束本轮快照。
2. `rollbackOnAbort: 'off' | 'prompt' | 'auto'`（默认 **`prompt`**）：
   - `off`：只记录；
   - `prompt`：在会话里追加一条提示（"本轮已中断；回滚到本轮之前：`audit-rollback undo-to <sid> <turn> --apply`"），**不改文件**；
   - `auto`：中断后自动执行 §10.6 的 `undo-to`（备份到 trash、串行、失败只 `warn` 且保持文件不动）。
     默认不是 `auto`：取消是高频动作，自动改文件必须由用户显式开启。
3. "停止"本身由核心提供（客户端取消在飞轮次、工具终止、后台作业可杀），本包**不重复实现停止**，
   只保证"停止之后可恢复"。README 必须写明这条分工，避免被理解成"本插件能中断命令"。

### 10.9 覆盖范围与不覆盖项（必须逐条写进 README）

| 内容 | 阶段 B 是否覆盖 |
|---|---|
| 被审计根内的 tracked / untracked（非忽略、未排除） | **是**（含 shell、其它插件、人工编辑的改动） |
| 被审计根内的**嵌套 git 仓库**（含自己的 `.git` 的子目录） | **否**（2026-10-11 全面复核实证：git 把它记成 gitlink `160000`，其工作区文件不进影子库）。这一条必须写进 README，且计划侧遇到非 blob 条目一律 `skip` |
| 被审计根内被 `.gitignore` 忽略的产物 | 默认**否**（`snapshotIgnorePolicy: 'git'`）；`'force'` 时为是 |
| `snapshotExcludeGlobs` 命中项（`node_modules`、`.git`、缓存目录…） | 否 |
| 被审计根**之外**的文件 | 否 |
| git 元数据（用户仓库的 `.git`、提交、分支、stash） | 否（影子库只读不改用户仓库） |
| 进程/服务、网络、数据库、被忽略的构建输出 | 否（与 OpenCode 的 Safety 一节同口径） |

**一句话写进 README**：这是便利能力，不是事务、不是备份；回滚会覆盖 P 内路径的当前内容，动手前先看清楚预览。

### 10.10 性能与安全红线

- `tools/pre-execute`、`fs/*-intent` 内**禁止** git 调用与目录遍历（阶段 A 的红线不变，只是范围更明确）。
- 快照串行、有超时、超时即降级；**任何快照失败都不得改变工具调用结果**。
- 影子库路径必须通过 §3 的 `safeStateWrite`/`safeMkdir` 同级的路径守卫写入；`WORKTREE` 记录的根与本次快照的根不一致时**拒绝快照**（防路径漂移）。
- `trash` 的三条规则（§3：保留盘符、不覆盖既有备份、先备份后改动）对边界回滚**逐字适用**。
- 影子库对象包含工作区文件完整内容 → 与 §3 的 `objects/` 同级敏感，README 必须写明。
- **预算红线（2026-10-11 实测后追加）**：任何写路径都不得在**未过预算**的工作区上跑 `add -A`；
  超预算默认拒绝、由调用方决定是否自动排除并必须在账本留 `note`。禁止把"自动排除"设为静默默认值。
- 影子库的体积必须可见：设置页与 CLI 都要能显示对象数/占用（`shadowStats`），否则用户无从判断该不该开这个能力。

### 10.11 上游依赖（插件做不到、必须核心支持的部分）

阶段 B 只能做到"文件回到边界"，**不能把会话消息删掉**。真要做 OpenCode 那种"消息从会话里消失、prompt 回到输入框"，
需要上游提供（本包只记录提案，不实现、不绕过）：

1. `session.revert(fromSeq)`：把某 seq 之后的会话事件移出**活动视图**，同时保持 append-only 存储不丢数据；
2. 与 projection 缓存、`session/flush` 屏障、`session-query-sqlite` 索引、格式迁移链的一致性规则；
3. 客户端"把 prompt 放回输入框"的正式接口（当前未核实是否存在，见 §10.6 第 7 条）。

在上游具备之前，本包给出的是**降级方案**：文件可回到任意步/轮边界 + 被回滚轮次的 prompt 文本可复制重发。

### 10.12 验收标准（中控机械复核，追加到 §8）

1. `node --check` 覆盖新增的 `lib/snapshot.js`、`lib/boundary.js`、`test/snapshot.mjs`、`test/boundary.mjs`。
2. `node test/snapshot.mjs` 退出码 `0`，且至少断言（每条要有可辨认名字）：
   - 影子库建在 `stateDir/shadow/<key>` 下，**用户工作区里不出现新文件**（快照前后对工作区做目录快照比对）；
   - 两次相同工作树内容 → `write-tree` 得到**相同** tree（幂等）；
   - `add -A` 不动用户仓库的 index 与工作树（在工作区内放一个真 git 仓库做对照，断言其 `git status` 不变）；
   - 无 git 可用时的降级：只写 `note` + `warn`，不抛错，且不重试。
3. `node test/boundary.mjs` 退出码 `0`，至少断言：
   - 三步改动 → 三步 `attribution` 的并集 = 实际被改路径集合；
   - `undo-to` 恢复到边界：边界后新建的文件被移入 `trash` 且原路径消失，边界后修改的文件字节等于边界 tree 的内容；
   - **无关路径未被触碰**（同轮内未被归属的文件，字节级不变）；
   - 当前内容与参照不一致 → 默认 `skip`（退出码 `2`），`--force` 后成功；
   - `redo` 把 P 恢复到 `preTree`；
   - 边界缺失 → 退出码 `4`；
   - 旧 CLI 读取含新 kind 的账本不报错（向后兼容红线）。
4. **端到端**：临时目录里造 3 轮改动（其中一轮用 shell 造假改动，证明 shell 改动也入账）→
   `snapshot list` → `undo-to … --step …`（dry-run）→ `--apply` → `diff` 复核 → `redo` 复核，
   完整命令与退出码贴进交付报告。
5. 跨平台：新增测试必须同时在 Windows 与 Linux CI 通过（§9 最后一条不变）；Linux 上 git 通常可用，
   但仍必须用**桩掉 git 的分支**覆盖降级路径，不得因"CI 有 git"而跳过降级断言。
6. **预算用例（2026-10-11 追加，B1 已实现）**：`test/snapshot.mjs` 必须覆盖三条——
   超预算时返回 `OVER_BUDGET` 且带最重顶层项清单（默认不自动排除）；
   `autoExcludeOversized` 时自动排除最重目录后快照成功、且 tree 里不再含被排除目录；
   `scanBudget` 在超预算子树上提前放弃并把该顶层项标 `oversized`。

### 10.13 阶段 B 硬约束（追加到 §9）

- `gitSnapshot: false` 时，阶段 B 的任何代码路径都不得被触碰（回归红线，用测试断言）。
- 影子库是**唯一**允许 git 写操作的对象；不得对用户仓库执行 `add/commit/reset/checkout/stash/gc` 等任何写命令。
  在用户仓库里的只读命令（如 `rev-parse`）也**不必要**，阶段 B 不依赖用户仓库。
- 不实现会话截断，不改核心，不写 `~/.dsh`（测试全用临时目录），不 `git commit`/`git push`（沿用 §9）。

### 10.14 实施顺序（每步单独可验收，不合并提交）

| 步骤 | 内容 | 完成判据 |
|---|---|---|
| B1 | `lib/snapshot.js` 影子库引擎（init/capture/diffTrees，含降级与超时） | `test/snapshot.mjs` 全绿 |
| B2 ✅ | `lib/boundary.js` 归属与边界账本（新 kind）+ `test/boundary.mjs`；**只交付纯逻辑层，不动 `config.js`/`client.js`/`index.js` 的公开面** | 账本含 `snapshot`/`attribution`；三档退化、归属并集、计划判定、越界与 fail-closed 全绿（12 条用例）；旧读取口径可读新 kind |
| B2b ✅ | 插件接线：订阅 `step/start`、`step/end`（+ 现有 `turn/start`/`turn/end`）、新增 config 字段与设置页展示、串行队列 | **零差异红线已实证**（假 ctx 断言 `gitSnapshot: false` 时不写阶段 B 条目、不建影子库）；`verify` **51/51**；见 §10.20 |
| B3 ✅ | CLI `snapshot`/`diff`/`undo-to`/`redo`/`gc`（dry-run 优先）+ `lib/boundary-exec.js` 执行层（先备份后改动、`preTree`/`postTree`、`redo`）+ `test/boundary-exec.mjs` | 执行层 8 条用例全绿；端到端命令与退出码（0/4/5）见 §10.17；`verify` **47/47** |
| B4 | GUI：「已修改文件」页签扩展为「变更与回滚」（边界时间线、预览、二次确认、复制 prompt） | 实机验收记录（不得只凭 VM 测试宣称通过） |
| B5 | 停止联动 `rollbackOnAbort`（默认 `prompt`） | 中断一次真实轮次，核对 `abort` 条与提示 |
| B6 | README/配置表/限制章节更新，`gitSnapshot` 从"未实现"改为正式开关 | 文档与实现一致，`check-manifest` 与 `verify` 通过 |

### 10.15 B1 实测记录（2026-10-11 · 本机 Windows · node v24.13.0 · git 2.53.0）

| 被审计根 | 规模 | 实测结果 |
|---|---|---|
| `D:\dsh-guard`（真 git 仓库） | 112 文件 / 1.8 MB | `ok=true`，**499 ms**，tree `04f75e1…`；用户仓库 `git status` 与 index **逐字不变** |
| `C:\Users\Fractal\.dsh`（**非 git 工作目录**） | 26702 文件 / 2.2 GB | 无预算时 `add -A` **超过 4 分钟仍未结束**，已向影子库写入 **1.3 GB** 对象，人工终止 |

大块头排序（决定排除策略）：`python-engine` 822 MB、`storages` 312 MB、`dsh-runtimes` 282 MB、
`dsh-codex-connect` 194 MB、`sessions` 157 MB、`attachments` 150 MB、`models` 129 MB、`audit-rollback` 71 MB。

由此确立四条（已并入 §10.4 第 6 条、§10.10、§10.12 第 6 条）：

1. **影子快照在普通代码仓库上完全可行**（亚秒级），且**非 git 工作目录同样可行**——不要求用户仓库，
   这正是 OpenCode 的 `/undo` 做不到的那一半（它在非仓库里只能回退会话）；
2. **但必须有预算**：否则在大目录上不只是慢，而是持续写对象，磁盘与时间双失控；
3. 因此 `scanBudget` 先判预算 → 超预算**默认拒绝** → 只有显式 `autoExcludeOversized` 才自动排除并重试一次，
   自动排除必须记账（`note`）并在设置页可见；
4. 对 DSH home 这类目录，正确做法是给它一份专属排除表
   （`python-engine/`、`storages/`、`dsh-runtimes/`、`attachments/`、`models/`、`electron-user-data/`、
   `cache/`、`recovery/`、`logs/`、`tmp/`、`audit-rollback/`），**而不是把预算调大**。

B1 交付与验收（全部已跑通）：

- `lib/snapshot.js`（§10.2）+ `test/snapshot.mjs`：**13 条用例全通过**——影子库位置与工作区无新增文件、
  幂等、排除规则、归属路径、**CRLF 字节保真**、边界 ref 可写可列、**用户仓库 index/工作树不受影响**、
  force 策略、oversized blob、git 缺失降级、路径越界拒绝、以及三条预算用例；
- 仓库级：`node tools/verify.mjs --pkg dsh-audit-rollback` **41/41 通过**；
  `node scripts/check-manifest.mjs` 通过；`npm pack` + `node scripts/prepare-release.mjs` 通过
  （发布清单已同步加入 `lib/snapshot.js`，见 `scripts/prepare-release.mjs` 与 `docs/release-plan.md` §6）。

### 10.16 B2 交付与验收（2026-10-11 · 边界与归属层）

**交付**：`lib/boundary.js`（纯 node，无 Cordis 依赖）+ `test/boundary.mjs`（12 条用例）。

**实现要点**：

- `gitBlobOid` 用**纯 node** 计算 `sha1("blob <len>\0" + content)`，与 `git hash-object --stdin` 逐字一致
  （测试直接对照），因此一致性参照不需要额外 git 子进程；
- 归属集合 P 与参照 `lastTo` 一次遍历得出，`paths` 写**绝对路径**（符合 §4 的通用约定），
  回滚侧再用 `toRelPath` 转回影子库相对路径；
- 三档退化按 §10.6 第 1 条实现，并固定"轮级伪 step = -1"（`TURN_LEVEL_STEP`）；
- 计划的判定顺序固定为：越界 → 读不出来 → 一致性（默认 skip / `--force` 放行）→ 边界处存在性，
  与阶段 A §7 的"先判定、后移动"口径一致；生成计划**只读**（测试断言账本节字节不变）；
- **实现中发现并修正的真实缺陷**：账本写入原先被 `catch {}` 静默吞掉，stateDir 未初始化时
  会出现"快照成功、账本空白"——现改为返回 `ledgerOk`/`ledgerError` 并自足初始化（见 §10.5 约定）。

**验收**：`node test/boundary.mjs` → **12/12**；`node tools/verify.mjs --pkg dsh-audit-rollback` → **44/44**；
`check-manifest` 通过；`npm pack` + `prepare-release` → `dsh-audit-rollback.tgz` **12 个文件**
（新增 `lib/boundary.js`）。版本号未动，`gitSnapshot` 仍为 `false`，**阶段 A 的运行时行为没有任何变化**。

### 10.17 B3 交付与验收（2026-10-11 · 执行层与 CLI）

**交付**：

- `lib/boundary-exec.js`：执行边界计划——`restore` 内容来自**影子库 tree 的 blob**（不是 CAS），
  trash 三条规则与"已搬走又失败必须搬回原位"的语义照抄阶段 A `lib/ledger.js`；
- `test/boundary-exec.mjs`：8 条用例；
- `scripts/audit-rollback.mjs` 追加 6 个子命令（`snapshot list|show`、`diff`、`undo-to`、`redo`、`gc`），
  既有 `list`/`sessions`/`show`/`undo`/`last` 的语义与输出**逐字未改**。

**关键语义**：

- `undo-to`：默认 dry-run（仍写 `applied:false` 审计条目）；`--apply` 前先捕获 `preTree`、
  执行后捕获 `postTree`，两者随 `rollback` 条目落账——`redo` 完全依赖它们；
- `redo`：只认 `applied: true` 且 `source: 'snapshot'` 的最近一条；缺 `preTree`/`postTree` 时
  **拒绝执行**（退出码 `5`），宁可不动也不猜；
- **不在归属集合 P 中的路径不可能被触碰**——执行层只按计划里的 actions 行动；
- 边界后被手改：默认 `skip`，`--force` 才覆盖。

**验收（全部实跑）**：

| 项 | 结果 |
|---|---|
| `test/boundary-exec.mjs` | 8/8（含"shell 改的文件也入账并回滚"、dry-run 不触碰文件、trash 里有副本、无关文件字节不变、redo 回到 undo 前） |
| `test/boundary.mjs` / `test/snapshot.mjs` | 12/12 / 13/13 |
| 阶段 A `test/selftest.mjs` | 13 条断言全通过（既有 CLI 未被破坏） |
| `tools/verify.mjs --pkg dsh-audit-rollback` | **47/47** |
| `check-manifest` / `npm pack` + `prepare-release` | 通过 / `dsh-audit-rollback.tgz` **13 个文件** |
| CLI 端到端（真实命令 + 退出码） | `snapshot list`(0) → `snapshot show`(0) → `diff`(0；`+1 -1`、`+1 -0`) → `undo-to`(0，dry-run 未改文件) → `undo-to --apply`(0；恢复为 v1、shell 建的文件进 trash) → `redo --apply`(0；回到 v2、shell 文件回来) → 无关文件 `keep.txt` 字节不变 → `gc`(0) → 无边界轮次 `undo-to`(**4**) → 无记录 `redo`(**5**) |

**实现中修掉的一处不一致**：`snapshot show` 原先显示路径归并键（Windows 下是小写），
与 `undo-to` 显示的账本原始写法不一致；现统一取账本原样
（`collectAttributionPaths` 新增 `originalPath`，`resolveDisplayPath` 的线性回扫删除）。

**边界**：这些命令只消费账本里**已存在**的 `snapshot`/`attribution` 条目；
插件侧自动写这些条目的接线（B2b）尚未交付，`gitSnapshot` 仍为 `false`。

### 10.18 独立复核与其发现（2026-10-11）

由异厂商子代理（ARK Agent Plan 的 GLM-5.3）对 `lib/snapshot.js`、`lib/boundary.js`、`lib/boundary-exec.js`
与 CLI 子命令做**窄范围实证复核**（A 执行层副作用与安全顺序 / B redo 参照语义 / C 预算拒绝语义）。
结论 **FAIL：4 处缺陷（中×3、低×1）**，全部已修复并加回归用例；修复前的结论**先由本机复现确认**再动代码。

| 严重度 | 条款 | 现象 | 修复 |
|---|---|---|---|
| 中 | §10.4 第 6 条 | `autoExcludeOversized` 把 `heaviest` 前 8 项**整体**排除，正常目录与顶层文件被静默踢出快照 | 只排除 `oversized === true` 的顶层项 |
| 中 | §10.6 第 5 条 | `preTree` 捕获失败时仍照常 `--apply`，该次回滚**永久不可 redo** | 默认拒绝（`PRE_TREE_UNAVAILABLE` / 退出码 `4`）；需 `--no-redo` 显式放行 |
| 中 | §10.6 第 5 条 | `redo` 的 paths 只含非 `skip` 动作，被 `skip` 的路径永久脱落；且 CLI `redo` 未注册 `--force`（实测报"未知选项"） | paths 取**全部**动作；CLI 注册 `--force` |
| 低 | §10.4 第 6 条 | `scanBudget` 返回 `ok: false` 时绕过预算检查直接落到 `add -A` | 新增 `SCAN_UNREADABLE`，fail-closed |

复核同时**证伪**了两个怀疑（属通过项）：`restore` 的 blob 预检确实先于任何移动（200 KB 文件 + `blobMaxBytes: 100`
实证 skip 且原文件未动、`trash` 为空）；`SCAN_INCOMPLETE` / `OVER_BUDGET` 的拒绝语义确实生效
（30000 文件 + `scanMs: 1` 实证 0 对象写入）。`dry-run` 的字节级零改动、`trash` 三条规则、
`undo → redo → undo-to` 往返自洽也都实证通过。

**本次回归测试又追加暴露 1 处**（复核未覆盖）：`changed === 0`（全部动作被 `skip`）时 `postTree` 未记录，
使"下一次 redo"的参照缺失、链条断在 `REDO_REFERENCE_MISSING`。
现改为 `apply` 时**一律**记录 `postTree`，并加了针对性用例（`undo → 手改 → redo(skip) → 再 redo`）。

验收（修复后）：`test/snapshot.mjs` **13/13**、`test/boundary.mjs` **12/12**、
`test/boundary-exec.mjs` **11/11**、`test/snapshot-edge.mjs` **12/12**；
仓库级 `verify` 与打包数字以最后一次运行为准。

### 10.19 第二次独立复核（全面）与其发现（2026-10-11）

由另一条异厂商子代理（Command Code 的 GLM-5.3 Flash）做**全面**复核（影子库安全、预算、CLI 退出码矩阵、
dry-run 字节级、账本兼容、泄漏路径），结论 **FAIL：7 处缺陷（1 高 / 4 中 / 2 低）**，全部已处理：

| 严重度 | 现象 | 修复 |
|---|---|---|
| 高 | 边界后 **rename**（`a.txt→b.txt`）归属丢失旧路径：`diffTrees` 已解析出 `renamedFrom`，`recordAttribution` 只收 `entry.path`；`undo-to --apply` 后旧文件名永久消失（内容只留在 trash），CLI 仍报成功 | 归属同时纳入 `renamedFrom` 与 `path` |
| 中 | `gc` 不带 `--root` 永远失败（`cmdGc` 传 `null`，而 `resolveRootFromLedger` 只豁免 `undefined`） | 判定改为 `filter.session != null`；CLI 传 `undefined` |
| 中 | 全部动作被 `skip` 时 `undo-to` 退出 `3`（契约要求 `2`） | 改为"有归属路径且存在 skip → 2；完全无动作 → 3" |
| 中 | 嵌套 git 仓库被记为 gitlink，其文件不入快照（与 §10.9 覆盖声明冲突） | 修正 §10.9 与 README 的覆盖声明（明确"不覆盖"），计划侧对非 blob 一律 `skip` |
| 中 | `walkBudget` 在单层超大目录内无逐项时间检查（20000 文件 + `scanMs: 1` → 1025 ms、`partial: false`） | 每 64 条检查一次时间，超时即置 `oversized` |
| 低 | 影子库损坏时 `gc` 掩盖失败（不检查 `listBoundaryRefs` / `gcShadow` 的 `ok`）仍退出 0 | 两处 `ok !== true` 均输出原因并返回 `1` |
| 低 | 预算闸门在 `scanBudget` 失败时 fail-open（落到 `add -A`） | `captureTree` 增加"根必须是目录"前置检查 + §10.4 第 6 条的 `SCAN_UNREADABLE` |

**被证伪的怀疑（属通过项）**：`gc` 会销毁 `preTree`（实测两次 `gc --prune=now` 后 redo 仍工作，
但该安全性依赖 git 的 cruft pack，见下）；`GIT_*` 环境投毒无法把影子库改道；dry-run 字节级零改动；
trash 三规则（含 ACL 拒写目录下的失败分支）；旧账本无 `root` 时明确要求 `--root` 而不猜。

**已知风险与处置（同日晚些时候已处理前两条）**：

1. ~~`preTree`/`postTree` 没有自己的 ref~~ → **已修**：两者现在各自写 ref，对象可达性不再依赖 git 的 cruft pack；
   回归用例在 `gc.cruftPacks=false` + `reflog expire --expire=now` + `gc --prune=now` 的最坏配置下断言参照树仍可读。
2. ~~`index.lock` 残留时失败原因不可读~~ → **已修**：`runGit` 现在附带 `detail`（`describeGitFailure`），
   把锁冲突翻译成"另一个 git 操作正在进行，或上次快照异常中断留下了锁文件；确认没有其它快照在写同一个影子库后
   可删除该锁文件再重试"，并**明确不自动删锁**（删别人的锁有风险）。
3. 历史缺陷：`undo-to` 的"计划 → 执行"之间只在计划期校验，之后的并发写可能被覆盖；
   若写入发生在 `preTree` 捕获之后，`redo` 也不能找回，只能手工查 trash，不能笼统称为"数据不丢"。
   **2026-10-13 已加固**：动作携带预期存在性/oid，移动前重新验证，不一致即 `skip`（`--force` 不豁免）；
   恢复使用排他创建、失败搬回不覆盖新文件，备份路径落入账本与输出。仍不是操作系统级目录锁，执行前须停止相关写入。
4. `redo` 的 `redo` 会来回翻转（每次撤销最近一条 `applied` 回滚）——行为可解释，契约未禁止。
5. **并发串行队列尚未在代码里实现**：§10.4 第 5 条要求快照串行，但当前实现的串行性**依赖调用方**；
   B2b 接线时必须补一个真正的队列（参考 Roo Code 的做法："prevents duplicate checkpointing within
   a single streaming operation"）。
6. 未验证：符号链接（本机无权创建）、真实并发 `index.lock` 竞态、跨卷 `trash`、Linux 行为。

**参考其它 Harness 的取舍（2026-10-11 外部核对，用于校准本包方向）**：

| 实现 | 关键做法 | 对本包的取舍影响 |
|---|---|---|
| **Roo Code** | checkpoint **就是 shadow 仓库里的 git commit**（官方文档写 "stored as Git commits"），恢复时 hard reset 到该 commit；检测到**嵌套仓库即禁用 checkpoint 并明确通知**；排除表写进 shadow 的 `.git/info/exclude`；有 checkpoint 初始化超时（默认 30 s） | 印证"commit + ref"方向；排除表与超时思路本包早已一致；嵌套仓库本包选"声明不覆盖 + 计划侧 `skip`"（比直接禁用温和） |
| **Cline** | 独立 shadow 仓库 + **每次工具调用后 commit**；但社区有人遇到 **262 GB 的 `.git/objects/pack`** | 支持"写 ref + 按 `--keep-days` gc"；同时说明**体积必须可见**（本包 `shadowStats` 与设置页展示即为此） |
| **OpenCode** | 裸 tree 对象 + 后台 `git gc --prune=7.days`；其 issue #36093 自述"**这是基于年龄的清理，不是从持久会话状态可达性出发**" | **反面教材**：本包用 ref 保证可达性，不用"时间"赌对象存活 |
| **Claude Code `/rewind`** | 明确**不追踪 bash 命令、手工编辑与外部工具**的改动；上限 100 个 checkpoint/会话；不支持跨会话恢复 | 本包影子库是**全工作区快照**，天然覆盖 shell 改动——这是相对它的优势 |

### 10.20 B2b 交付与验收（2026-10-11 · 配置面 + 插件接线）

**交付**（host 接线与字段面分包完成，各自独立验收）：

| 部分 | 内容 |
|---|---|
| host 接线（`lib/index.js`） | `normalizeConfig` 规范化 11 个新字段；**串行队列** `enqueueSnapshot`；`pendingBoundaries` 按会话配对 start/end；`step/start`/`step/end` 与轮事件经 `scheduleShadowBoundary` 统一按 `snapshotMode` 过滤；`status.config` 回传新字段 + 新增 `status.shadow` / `status.snapshotStats`；`byKind` 增 `snapshot`/`attribution`/`abort`；`gitSnapshot: true` 才启用 |
| 字段面（`lib/config.js`、`lib/client.js`、`cordis.patch.yml`） | 11 个字段进 Schema（枚举用 `union`，整数带 `min`/`max`）；设置页 16 字段编辑器（复选框 / 下拉 / 文本域 / 数字）+ 只读状态区（host 未同步时显示"未知/未启用"且不抛错）；patch 写全 16 字段且与代码默认逐字段一致，`stateDir` 仍不入 patch |
| 测试 | 新增 `test/snapshot-wiring.mjs`（5 条，含零差异红线）；`test/status.mjs` 补阶段 B 断言；`test/settings-client.mjs`、`test/settings-integration.mjs` 更新到 16 字段——**既有断言全部保留**（`stateDir` 只读、冲突/草稿、双语校验文案等），未放宽强度 |

**关键语义**：

- 默认 `gitSnapshot: false` 时**不注册任何新行为**（假 ctx 断言：不写 `snapshot`/`attribution`、不创建影子库）；
- start 快照降级时**不写归属**（否则 end 侧会把整棵树当成"新增"，产出垃圾归属集合）；
- 所有影子库操作排队执行，顺序断言 `start0 → end0 → start1 → end1`；
- `rollbackOnAbort` 只落配置与展示，**联动实现属 B5**（README 已注明）。

**验收**：`node tools/verify.mjs --pkg dsh-audit-rollback` → **51/51**；`check-manifest` 通过；
`npm pack` + `prepare-release` → 13 个文件；六个测试全绿（13 / 12 / 16 / 14 / **5** 条用例 + status 全通过）；
patch 与代码默认值逐字段比对通过。

**未做（后续步骤）**：GUI 时间线预览与复制提示（B4）；`rollbackOnAbort` 的三档联动（B5）；
真实浏览器加载验证（本任务验收口径为 VM / Loader 测试）。

### 10.21 第三次独立复核（B2b 接线）与其发现（2026-10-11）

由第三方子代理（MiMo V2.6 Pro）对 B2b 做窄范围实证复核（A 零差异 / B 队列与配对 / C 降级与记账 /
D status 形状 / E patch 一致性）。结论 **FAIL：4 处缺陷（中 3、低 1）**，全部已修复并加回归用例。

它的取证方式值得记录：用 `--import` 子进程拦截器统计 spawn —— `gitSnapshot: false` 时 **git spawn 0 次**、
工作区零新增、0 告警；对照 `gitSnapshot: true` 同环境拦到 **12 次** git spawn，证明拦截器有效。

| 严重度 | 现象 | 修复 |
|---|---|---|
| 中 | `pendingBoundaries` 只按 sessionId 为键、end 不校验 `(turn, step)`：乱序或跨轮残留时 end 配到别人的 start，另一条归属丢失，归属的 `from` 与其声明的 turn/step 脱节 | 键改 `(session, turn, step)`；end 不匹配则**只写 end 快照、不写归属**；`turn/end` 清该轮残留、`session/disposed` 清该会话残留 |
| 低 | 快照异步追拍：同一事件循环内连发边界事件时 start/end 树相同、归属为空 → 真实改动**漏出集合 P**（回滚时"不在 P 中一律不动"→ 漏改不回滚） | 快照条目记 `lagMs`（事件时刻→捕获时刻）；`lagMs > 250ms` 且归属为空时写 `note` 说明"本步归属可能不完整" |
| 中 | git 不可用（init 失败）时**不写 note、也不永久降级**：每个边界都重试并重复告警 | 环境性失败**熔断**：首次写 `note` + 告警一次，此后本实例不再尝试；`status.shadow.fused` 暴露原因 |
| 中 | `autoExcludeOversized` 的自动排除**不记账、设置页不可见** → 静默缩小审计覆盖面 | `captureBoundary` 回传 `autoExcluded` → 写 `note`（仅在集合变化时）+ `status.shadow.autoExcluded` + 设置页展示 |

**通过项**：零差异红线（0 次 git spawn）；快照顺序与双会话配对；降级时 `degraded: true` + 无 attribution + 轮次照常；
status 形状与设置页一致（含旧账本 `workspaceKey = null` 不猜、影子库损坏时 `objects`/`refs` = 0 且不抛错）；
patch ≡ Schema 默认 ≡ `normalizeConfig` ≡ 设置页可编辑面（四组逐字段一致，`stateDir` 不入 patch）。

**未验证（记录在案）**：真实 agent-loop 是否会发出乱序或缺失 start 的 step 事件（B 类缺陷的可达性前提——
本包按 fail-closed 处理："不匹配就不写归属"）；per-turn 的跨轮交错变体；真实 Host 的 Loader / settings / remote 链路；
两个会话共用同一 root 的真并发。

**加固轮（同日，B3 之后）**：新增 `test/snapshot-edge.mjs`（**9 条**），覆盖——
pathspec 特殊字符（`[` `]` `#` `%`、空格、中文、单引号）、批量 rename（两文件互换内容）、
空文件 / 无尾换行 / UTF-8 BOM / 含 NUL 二进制的**字节保真**、Windows 大小写别名、
文件 ↔ 目录 类型变化（必须 fail-closed 为 `skip` 并给出原因）、
预算边界（文件数**恰好等于** `maxFiles` 不得误判超预算）、
恢复对象超限（`blobMaxBytes` 很小时降级 `skip`，且**不许先把原文件搬走**）、归属不牵连被审计根之外的路径。

结论：**未发现产品缺陷**（8 项行为全部符合契约，1 项失败为测试自身问题——Windows 文件名不允许 `*`/`?`，
按平台过滤后通过；`[`/`]` 作为真正触发 pathspec glob 的字符被有意保留，用于验证 `:(literal)` 的必要性）。

### 10.22 接手复核与必要修复（2026-10-13）

本轮保留既有未提交实现，重点复核 B1/B2/B2b/B3 与 npm OIDC 发布链路；未提交、推送、安装或部署。

- **配对与卸载**：`turn/end` / `session/disposed` 的残留清理也进入串行队列，避免清掉已完成 start 仍待 end 使用的配对；已排队任务执行前复查熔断与卸载状态，dispose 等待队列收尾；快照/归属落账失败不再静默。
- **排除与字节保真**：每次捕获只重建影子库自己的 index；显式排除走独立 pathspec，`force` 不绕过；自身 stateDir 与 `.git` 强制排除；影子库 `info/attributes` 禁用 text/eol/filter/ident/working-tree-encoding 入库转换。盘点遇不可读项不视作完整。
- **路径与环境**：复用账本安全目录/写入守卫，拒绝影子目录 junction/symlink 改道及关键元数据链接；剔除全部继承的 `GIT_*` 注入；根盘符保留分隔符，拒绝跨卷路径，并允许合法的 `..notes.txt` 文件名。
- **执行层**：undo/redo 在移动前复核规划时存在性与 oid，`--force` 不绕过不可读状态或规划之后的新写入；mode120000 不按普通 blob 恢复；保留可执行属性且不放宽现有私有权限；恢复排他创建，失败搬回不覆盖并发新文件；备份位置进入输出和账本；redo 对已经等于目标的文件不作无意义改写。
- **发布链路**：npm Trusted Publishing 最低版本门禁；公共 registry 显式指定；只把明确 E404 视为首次发布；幂等补齐前先检查整组更高版本；跨版本 tag 串行避免 latest 交错回退；Windows 用 Node 执行 npm-cli.js，避免 shell 拼接与 DEP0190。
- **测试入口**：包内 `npm test` 补齐所有阶段 B 测试；CI 增 Windows/Linux matrix 与 bash；发布决策测试在 CI/release 都运行。新增 CLI list/show/diff JSON 与退出码 3/4/5 断言，Git 最坏配置测试统一清环境并验证每条命令退出码。

**本轮实测证据**：Windows 与 WSL ArchLinux（Node 22.22.2 / Git 2.53.0）各自运行 `node tools/verify.mjs --quiet`，均 **107/107 检查通过**；两平台发布隔离/静态门禁均 **8/8 通过**；CLI 边界执行 **23/23 通过**（含降级边界的 JSON 退出码 4）；快照安全新增 **7/7 通过**；执行安全新增 Windows **5 通过、1 条 POSIX 模式测试按平台跳过**，Linux **6/6 通过、无跳过**。离线 `npm pack --ignore-scripts --offline`、`prepare-release` 与 `check-packed` 验证两包共 23 个产物文件与源码逐字节一致，17 个 JS 语法通过；manifest 与 `git diff --check` 通过。

**明确未验收/未完成**：GitHub runner 与真实 OIDC 权限尚未实际运行（本机 WSL Linux 已实跑）；真实 Host/浏览器未部署验收；B4 时间线/预览/提示重发与 B5 停止联动仍是后续步骤。`snapshotRetentionDays` 尚未被 CLI gc 消费；影子库字节体积仍未知、对象概览不计 packed objects，不能据此认为库已清空。CLI 回滚仍要求先停止相关写入，不能承诺恶意并发路径交换下的完整原子性。

复核时两包 npm 公共 registry 的 latest 实查为 0.3.3，不覆盖已发布的不可变版本。随后用户批准两包同步升级 0.4.0，并单次授权对应提交、v0.4.0 tag 与推送；发布结果以 GitHub Actions/Release 与 npm registry 的实际状态为准。远端新增的 `environment: npm` 已在快进对齐后保留，并加入工作流静态门禁。
