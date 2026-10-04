# 设计契约 · dsh-audit-rollback（阶段 A）

> 本文件是实现的**唯一真源**。凡是本文件写定的字段名、路径布局、语义与退出码，实现必须逐字遵守；
> 未写定的细节可自行决定，但必须在 README 中记录。
> 所有"DSh 事实"一节的内容已在核心 `@deepseek-ai/dsh 0.2.1-alpha.1` 上核实，**不要重新猜测，也不要改写**。

- 仓库根：`D:\dsh-guard`
- 包目录：`D:\dsh-guard\packages\dsh-audit-rollback`
- 目标核心版本：`@deepseek-ai/dsh 0.2.1-alpha.1`（安装根 `C:\Program Files\DSH NEXT`）

---

## 1. 问题与目标

DSH 当前（0.2.1-alpha.1）**没有任何回滚能力**，审计也只是半个：

- `dsh-workspace-changes` 能给出每轮改动文件与 diff，但摘要、快照树与副本**只存活在 Host 进程内存**，重启即失；
- 工作区不是 git 仓库时，它只覆盖「文件工具点名的路径」，shell 命令的改动完全不入账；
- 全安装树没有 revert / undo / restore 入口。

本包要补上：**持久化审计账本** + **可精确回滚的编辑前内容**。
不追求覆盖 shell 改动（那是可选影子 git 模式，默认关闭），先把"文件工具改了什么、怎么退回去"做扎实。

### 非目标

- 不做 GUI 卡片（本阶段无 client 侧代码）。
- 不做模型侧工具注册（只提供 Host 侧捕获 + 独立 CLI）。
- 不做影子 git 快照的实现（config 里保留开关与排除项，`gitSnapshot: true` 时**只需记录一条 `note` 说明未实现**，不得静默无效）。

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
        gitSnapshot: false
```

配套要求：

1. `stateDir` **不写**在 patch 里（回落 `$DSH_HOME/audit-rollback` → `~/.dsh/audit-rollback`）。
2. **代码内部默认值必须与上表逐字段一致**：因为 Loader 对同一 id 的 config 是整体替换，profile 里漏写字段会回落到代码默认值；两处不一致会产生"配了 A 得到 B"的隐蔽偏差。实现必须两处同值，并在报告中列出对照表。
3. `excludeGlobs` 的匹配语义（实现作者发现并修正的关键点）：**不含通配符的模式按路径片段（子串）匹配**，含通配符的模式才走 glob 语义（`*` 不跨分隔符、`**` 跨分隔符、`?` 单字符）。若一律按全串 glob 解释，`'/node_modules/'` 这类写法永远命不中，默认排除会形同虚设。此语义必须同时写进 patch 注释与 README 配置表。
4. `gitSnapshot` 为未实现的占位开关：为 `true` 时只记一条 `note` + `warn`，行为不变（见 §1 非目标）。

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
7. `gitSnapshot: true` 时：**不实现快照**，加载时 `ctx.logger.warn` 一行、并写一条 `note` 条目说明"gitSnapshot 未实现"，其余行为不变。

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
5. 说明书：`README.zh.md` 写清能力、**明确写出限制**（只覆盖文件工具点名的路径、shell 改动不入账、objects 永不自动清理、无 GUI），并给出安装前的人工步骤（不改 `~/.dsh`，不自动安装）。

---

## 9. 硬约束

- 不修改 `C:\Program Files\DSH NEXT` 下任何文件。
- 不写 `~/.dsh`（测试一律用 `test/` 下的临时目录，或系统临时目录，并在结束时清理）。
- 不 import `@deepseek-ai/*`；不引入任何第三方依赖。
- 不 `git commit`、不 `git push`（由中控决定提交）。
- 代码注释用中文，风格对照 `dsh-preset-tool-guard`。
- 任何"猜"出来的 API 用法，必须在 README 的"未核实项"一节列出。
