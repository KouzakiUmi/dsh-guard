# dsh-audit-rollback

为 DeepSeek Harness 文件工具提供持久审计和文件恢复。包版本 `0.4.0`，验证基线 DSH `0.2.1-alpha.1`。安装方式见 [仓库 README](../../README.md#安装)。

## 功能

- 在文件工具调用前保存本轮首次前像，在 `turn/end` 保存最终后像。
- 插件热重载或轮次中途加载导致内存轮次态丢失时，迟到的 `turn/end` 回扫账本补写该轮遗漏的后像与收尾条目。
- 使用 SHA-1 内容寻址保存原始字节，同内容复用对象。
- 按 UTC 日期追加 JSONL 账本，记录轮次、调用目标、捕获及回滚。
- 会话「已修改文件」页签提供差异预览、二次确认和单文件恢复。
- 独立 CLI 按会话及轮次生成计划或执行回滚。
- 「设置 → 内置插件 → 审计与回滚」提供捕获策略及状态。

Windows 大小写别名按统一键去重，保留本轮首次前像和首次路径写法。调用参数预览只保存参数键名，不保存参数值；文件快照仍包含原始文件内容。

「已修改文件」只列出**有前后像快照**的文件。`read`/`grep`/`glob` 等只读工具虽然也带 path 参数，但不会被列为已修改文件；只被读取过的文件不出现在页签里。`captureTools` 名单决定哪些工具的调用算「改动意图」，该名单可配置。

## 会话内恢复

打开「已修改文件」页签，查看差异并选择恢复。确认页显示路径、当前版本和恢复动作；票据有效期 120 秒，文件变化、冲突或过期后需重新预览。

GUI 恢复要求：

1. Host 能验证会话存在，恢复时没有运行中的轮次。
2. 相关轮次结束，每轮前后像完整，跨轮捕获连续。
3. 快照、当前内容与路径身份校验通过。
4. 没有后续或其他会话捕获使该恢复失效。

恢复已有文件前备份当前内容；撤回创建时备份后移除文件。每次恢复尝试消费一次票据。差异是首个捕获前像与当前文件的对比，不保证等于完整会话净改动。旧账本仅有前像时只能查看。跨轮创建后又编辑的文件，GUI 拒绝会话级撤回创建，以保护后续工作。

## CLI

从本包目录执行，或使用包提供的 `audit-rollback` 可执行入口：

```sh
node scripts/audit-rollback.mjs list [--state <dir>] [--session <sid>] [--turn <n>] [--limit N] [--json]
node scripts/audit-rollback.mjs sessions [--state <dir>] [--json]
node scripts/audit-rollback.mjs show <sessionId> <turn> [--state <dir>] [--json]
node scripts/audit-rollback.mjs undo <sessionId> <turn> [--state <dir>] [--apply] [--force] [--json]
node scripts/audit-rollback.mjs last [--state <dir>] [--apply] [--force] [--json]
```

默认仅生成计划，不修改目标文件，但追加 `applied:false` 的回滚账本条目。`--apply` 执行计划：已有文件恢复该轮首次前像，新建文件移入回收站。

当前版本与该轮后像不一致，或路径存在后续捕获时，默认跳过。无后像时 CLI 使用该轮前像作为参照，与 GUI 的完整前后像要求不同。参照无哈希时仅比较字节数。

`--force` 允许覆盖上述版本冲突，仅应在确认要丢弃轮后修改时使用；不能绕过缺失、损坏或不可读取的快照。CLI 在计划和执行恢复前均校验快照内容哈希，失败则跳过并保留当前文件。

CLI 是离线入口，不查询 Host 当前运行状态；执行前应停止相关文件的写入活动。

| 退出码 | 含义 |
| --- | --- |
| `0` | 所有动作完成；未指定 `--apply` 时表示计划生成完成 |
| `1` | 参数错误、状态不可读或命令失败 |
| `2` | 至少一个文件被跳过 |
| `3` | 没有可回滚捕获 |

## 配置

通过官方 Settings / ConfigEditor 保存到当前 profile。**十六个可编辑字段**仅对新轮次生效，进行中轮次保持开始时的配置快照。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `captureTools` | `write`, `edit`, `str_replace_editor` | 捕获工具名，至少一项 |
| `captureMaxBytes` | `2097152` | 单文件捕获上限，正安全整数，字节 |
| `argsMaxBytes` | `4096` | 参数键名预览上限，正安全整数，字节 |
| `logCalls` | `true` | 是否记录工具调用 |
| `excludeGlobs` | `/node_modules/`, `/.git/`, `/.dsh-memory/`, `/.graphflow-cache/` | 阶段 A 的捕获排除规则，可清空 |
| `gitSnapshot` | `false` | **阶段 B 总开关**：开启后按 `snapshotMode` 在步/轮边界写影子库快照 |
| `snapshotMode` | `per-step` | `per-step`（步级，对齐 model step）或 `per-turn`（轮级） |
| `snapshotExcludeGlobs` | 上表 `excludeGlobs` + `/audit-rollback/` | 影子库排除表，可清空 |
| `snapshotIgnorePolicy` | `git` | `git` 尊重 `.gitignore`；`force` 用 `add -A -f` 纳入被忽略产物（**只绕过忽略规则，不绕过排除表**） |
| `snapshotMaxFiles` | `50000` | 预算：单次快照的文件数上限 |
| `snapshotMaxBytes` | `536870912` | 预算：字节上限（512 MiB） |
| `snapshotScanMs` | `5000` | 盘点时间窗口；到顶即判 `partial` 并拒绝快照 |
| `snapshotTimeoutMs` | `10000` | 单次 git 调用超时 |
| `snapshotAutoExcludeOversized` | `false` | 超预算时只排除 `oversized` 顶层项后重试一次（默认拒绝，不自动缩小覆盖面） |
| `rollbackOnAbort` | `prompt` | 中断联动档位 `off` / `prompt` / `auto`；**目前只落配置与展示，联动尚未实现** |
| `snapshotRetentionDays` | `14` | 影子快照保留天数（`0`＝不保留历史边界）；**当前只落配置与展示**：CLI `gc --keep-days` 仍用内置默认 14 天，尚未读取本字段 |

`stateDir` 是普通配置，设置页只读，不支持热迁移。解析顺序：配置值（支持 `~` 展开）、`$DSH_HOME/audit-rollback`、`~/.dsh/audit-rollback`。迁移前停止轮次、备份数据，再通过宿主配置流程重新加载。

`gitSnapshot` 默认 `false`；**`false` 时行为与阶段 A 完全一致**（不建影子库、不调用 git、不写任何阶段 B 条目）。置 `true` 后插件按 `snapshotMode` 在步/轮边界写边界快照与归属；所有影子库操作走串行队列，单次失败只告警降级、不影响轮次推进。详见下文「阶段 B：步级快照与边界回滚」。

排除规则统一分隔符后区分大小写匹配。含通配符时 `*` 不跨目录、`**` 跨目录、`?` 匹配单字符；无通配符时按子串匹配。不支持 brace 扩展。默认 `/.git/` 等规则不匹配无尾分隔符的目录自身或 `.GIT` 等大小写变体。

过期 revision 写入被拒绝，草稿保留；取消并重新读取后再编辑。Settings 不可用或配置不可写时显示错误。

## 数据存储

```text
<stateDir>/
  state.json
  ledger/YYYY-MM-DD.jsonl
  objects/<sha1前两位>/<sha1>
  trash/
```

账本只追加，对象库只增不减，没有自动清理。CLI 备份按时间与原路径保存，GUI 备份按操作 ID 保存并记录原文件存在性。

删除对象不会移除账本引用，但关联历史无法恢复。清理前备份整个状态目录并确认不再需要相关历史。快照及备份包含原始文件内容，需按其保密要求管理。

## 阶段 B：步级快照与边界回滚

对齐 OpenCode 的 snapshots / `/undo` / `/redo`：**回到某条消息所在的步（轮）边界，并把该边界之后的文件改动一起回滚**，且不再依赖"哪个工具碰过哪个文件"。它**不要求被审计目录自己是 git 仓库**——对象与索引都在影子库里。

写本节时的状态是**库层已具备、插件尚未接线**，两件事必须分开看：

| 部分 | 状态 |
| --- | --- |
| `lib/snapshot.js` 影子库快照引擎（建库、捕获、归属 diff、恢复、`gc`，含预算与降级） | **库层已实现**，`test/snapshot.mjs` 13 条用例全通过 |
| `lib/boundary.js` 边界、归属集合与回滚计划（纯 node 库层） | **已实现**，`test/boundary.mjs` 12 条用例全通过 |
| `lib/boundary-exec.js` 与 CLI `snapshot` / `diff` / `undo-to` / `redo` / `gc` | **已接入 CLI 并实机端到端验收**（2026-10-11）：dry-run 不动文件；`--apply` 后修改被恢复、新建进 `trash/`、删除被恢复；`redo` 退回 `undo` 之前；未归属路径字节不变。经独立复核查出 4 处缺陷并已修复（见「限制与降级」后的加固说明） |
| 插件自动快照（订阅 `step/start`、`step/end`，由 `gitSnapshot` 驱动） | **已接线（B2b）**：`gitSnapshot: true` 时按 `snapshotMode`（`per-step` / `per-turn`）在步/轮边界写边界快照与归属；所有影子库操作走串行队列；**默认 `false` 时零行为差异**（`test/snapshot-wiring.mjs` 用假 ctx 断言"不写快照条目、不建影子库"） |
| GUI「变更与回滚」预览、停止联动 | 未实现（设置页已可编辑阶段 B 字段，并显示影子库对象数/边界数只读概览；`rollbackOnAbort` 目前只落配置与展示，联动属后续步骤） |
| 边界条件加固（`test/snapshot-edge.mjs`） | **12 条用例全通过**：pathspec 特殊字符、批量 rename、空文件/无尾换行/BOM/二进制字节保真、Windows 大小写别名、文件 ↔ 目录类型变化 fail-closed、预算边界、恢复对象超限不搬走原文件、归属不越根、盘点未扫完即拒绝、自动排除只剔超限项、根不可读 fail-closed |

B3 阶段历史验收（2026-10-11）：`node tools/verify.mjs --pkg dsh-audit-rollback` 47/47 通过，`node scripts/check-manifest.mjs` 通过。CLI 端到端已在临时账本上实跑：`snapshot list` / `snapshot show` / `diff` / `undo-to`（dry-run）/ `undo-to --apply` / `redo --apply` / `gc` 均退出码 `0`；无边界轮次退出码 `4`、无 `redo` 记录退出码 `5`。当前 B2b 已接入自动边界捕获；`gitSnapshot` 默认仍为 `false`，关闭时不触碰阶段 B 路径。部署当前插件并显式开启后，才会在新步/轮边界写入 `snapshot`/`attribution`；旧会话账本不会自动补生成边界快照。自动接线已通过隔离测试，真实宿主效果尚待部署验收。

### 影子库机制

- 不要求被审计目录是 git 仓库：影子库是一个独立的 bare git 库，位于 `<stateDir>/shadow/<workspaceKey>`；`workspaceKey` 取被审计根规范化绝对路径 SHA-1 的前 16 位。
- 每个边界写一个 ref：`refs/dsh/<sessionKey>/t<turn>s<step>-<phase>`（`phase` 为 `start`/`end`）。没有 ref 的对象会被 `git gc` 当作不可达剪掉，写 ref 同时留下 `git log --all` 的人工检查入口。
- 影子库用自己的 `index`，并用 `WORKTREE` 文件明文记录被审计根的绝对路径；记录的根与本次快照的根不一致时拒绝快照（防路径漂移）。所有 git 调用显式传 `--git-dir`/`--work-tree`，并从子进程环境剔除 `GIT_DIR`、`GIT_INDEX_FILE` 等变量。
- **绝不触碰用户仓库**：不写用户的 index、refs 与工作树，被审计根下的 `.git` 一律按排除路径处理；阶段 B 不依赖用户仓库，也不对它跑任何写命令。
- 每次捕获都会刷新影子库自己的 `<GIT_DIR>/info/exclude` 与 `info/attributes`：后者按 `* -text -eol -filter -ident -working-tree-encoding` 关掉入库转换与 clean filter（优先于工作区 `.gitattributes`），保证 blob 与磁盘字节一致；排除表另以 `:(top,exclude,glob)` pathspec 作为独立闸门，所以 `force` 只绕过 `.gitignore`、不绕过显式排除。被审计根内的本包 `stateDir` 由引擎强制排除，不受配置清空影响。
- 影子库布局（追加在「数据存储」的 `stateDir` 之下）：

```text
<stateDir>/
  shadow/<workspaceKey>/
    HEAD  config  objects/  refs/   # bare 库；工作树根由 --work-tree 显式传入
    index                           # 影子库自己的 index，绝不复用用户仓库的
    WORKTREE                        # 被审计根的绝对路径
  recovered-prompts/                # 被回滚轮次的提示文本（见「限制与降级」）
```

### 预算与自动排除

`git add -A` 之前先做一次轻量盘点（`scanBudget`），默认预算 `maxFiles: 50000`、`maxBytes: 512 MiB`、`scanMs: 5000`；这三项已分别对应设置页的 `snapshotMaxFiles`、`snapshotMaxBytes`、`snapshotScanMs`，单次 git 调用超时对应 `snapshotTimeoutMs`。

- 超预算**默认拒绝**：结果 `reason: 'OVER_BUDGET'`，并附最重顶层项清单；
- 只有显式开启 `autoExcludeOversized` 才把最重目录并入排除表后**重试一次**，仍超预算仍然拒绝；
- 自动排除会静默缩小审计覆盖面，必须写 `note` 账本条目，因此不做默认值；对 DSH home 这类目录，正确做法是给它一份专属排除表，而不是把预算调大。

实测（2026-10-11 · 本机 Windows · node v24.13.0 · git 2.53.0）：

| 被审计根 | 规模 | 实测结果 |
| --- | --- | --- |
| `D:\dsh-guard`（真 git 仓库） | 112 文件 / 1.8 MB | **499 ms** 完成；用户仓库 `git status` 与 index **逐字不变** |
| `C:\Users\Fractal\.dsh`（非 git 工作目录） | 26702 文件 / 2.2 GB | 无预算时 `add -A` **超过 4 分钟未结束**，已写入 **1.3 GB** 对象，人工终止 |

结论：普通代码仓库上亚秒级可行，**非 git 目录同样可行**（这正是 OpenCode 的 `/undo` 在非仓库里做不到的那一半）；但大目录上必须靠预算拒绝加专属排除表，否则慢的不只是耗时，磁盘与时间会一起失控。

### 恢复语义

`undo-to <sessionId> <turn> [--step <n>]`：

- **边界** = 该 `(turn, step)` 的 `phase: 'start'` 快照；缺 `--step` 时退化到该轮最早的步级 start，再退化到轮级 `turn/start`；三档都缺 → 退出码 `4`。
- **只回退"边界之后被归属的路径"**（该步及其后所有轮 `attribution` 条目 `paths` 的并集）：
  - 路径在边界 tree 中存在 → 恢复为边界内容；
  - 路径在边界处不存在（边界后被创建）→ 先备份进 `trash/` 再移除；
  - **不在归属集合里的路径一律不动**（硬性不变量）。
- **一致性参照** = 该路径在边界之后最后一次快照里的版本：当前内容与参照不一致默认 `skip`（`reason` 写"边界后被改动"），只有 `--force` 才覆盖；对象/blob 缺失一律 `skip`，且必须在任何移动发生**之前**判定。
- 默认 dry-run，`--apply` 才动文件；CLI 是离线入口，查不到 Host 的在飞轮次，执行前请停止相关写入活动。
- `redo <sessionId> <turn>` 把同一路径集合恢复到执行 `undo-to` 前捕获的 `preTree`。被覆盖或移除的当前内容一律先进 `trash/`：保留盘符、不覆盖既有备份、先备份后改动三条规则逐字适用。
- **`preTree` 捕获失败时默认拒绝 `--apply`**（退出码 `4`）：继续回滚会让这次改动永久不可 `redo`；确认不需要 redo 时用 `--no-redo` 显式放行。`redo` 的对照参照是执行后记录的 `postTree`，两者缺一即拒绝执行。

阶段 B 追加的退出码（上文 CLI 表的 `0`/`1`/`2`/`3` 语义不变）：

| 退出码 | 含义 |
| --- | --- |
| `4` | 边界快照不可用（该轮/该步无可用快照、影子库已降级，或执行前 `preTree` 捕获失败被 fail-closed 拒绝） |
| `5` | 没有可 `redo` 的回滚记录，或参照缺失（契约 §10.7 写定） |

### 覆盖范围

| 内容 | 阶段 B 是否覆盖 |
| --- | --- |
| 被审计根内的 tracked / untracked（非忽略、未排除） | **是**（含 shell、其它插件、人工编辑的改动） |
| 被审计根内的**嵌套 git 仓库**（自带 `.git` 的子目录） | 否——git 把它记成 gitlink（`160000`），其文件不进影子库；嵌套仓库内的改动**不在**本包回滚范围内 |
| 被审计根内被 `.gitignore` 忽略的产物 | 默认**否**（`ignorePolicy: 'git'`）；`'force'` 策略才纳入（只绕过忽略规则） |
| 快照排除表命中项（`node_modules`、`.git`、缓存目录…） | 否（`'force'` 策略同样排除：排除表另走 pathspec 闸门生效） |
| 被审计根内的本包 `stateDir`（账本、`shadow/`、`objects/`、`trash/`） | 否——快照强制排除，`stateDir` 恰好等于被审计根时直接拒绝快照 |
| 被审计根**之外**的文件 | 否 |
| git 元数据（用户仓库的 `.git`、提交、分支、stash） | 否（影子库只读不改用户仓库） |
| 进程/服务、网络、数据库、被忽略的构建输出 | 否 |

上表的"是"只在阶段 B 快照真正开启并接线后才成立；默认 `gitSnapshot: false` 时，上文「限制」里的阶段 A 口径原样有效（只覆盖文件工具点名的路径，shell 改动不入账）。

### 停止联动

「停止」由 DSH 核心提供（取消在飞轮次、终止工具、杀后台作业），本包**不重复实现停止**，只保证停止之后可恢复：轮次被中断时固化 `abort` 条与中断点快照；`rollbackOnAbort` 的契约档位为 `off` / `prompt` / `auto`，默认 **`prompt`**——只在会话里提示一条回滚命令，不改文件，`auto` 必须显式开启。该联动**尚未接线**：`rollbackOnAbort` 已是设置页可编辑字段，但目前只落配置与展示，读取它的联动逻辑尚未实现。

### 限制与降级

- **不是事务、不是备份**：快照是尽力而为的便利能力，回滚会覆盖归属集合内路径的当前内容，动手前先看预览。
- **会话消息本身无法回退**：DSH 会话是 append-only 事件流，回退消息需要上游提供 `session.revert(fromSeq)` 之类的一致性接口，本包只记录提案、不绕过。当前的降级方案是"文件回到边界 + 被回滚轮次的提示文本可复制重发"（契约把提示文本放在 `<stateDir>/recovered-prompts/<sessionId>-t<turn>.txt`，尚未落地）。
- 影子库对象包含工作区文件的**完整内容**，与 `objects/` 同级敏感，按同等保密要求管理。
- 对象与 ref 目前**没有自动清理**，需手动 `audit-rollback gc`：默认只打印计划（`--keep-days` 默认 14 天；对应配置字段 `snapshotRetentionDays` 已存在，但 CLI 尚未读取、仍用内置默认 14），`--apply` 才删除到期的 `refs/dsh/*` 并对影子库跑 `gc --prune=now`，不碰阶段 A 的 `objects/`。
- 超预算、git 不可用与超时都只写 `note` 与告警并降级，不改变工具调用结果；`tools/pre-execute` 与 `fs/*-intent` 内不做 git 调用与目录遍历。
- **环境性失败会熔断**：`GIT_UNAVAILABLE`、`INIT_FAILED`、`WORKTREE_MISMATCH`、`SCAN_UNREADABLE`、`TIMEOUT`、`OVER_BUDGET`、`SCAN_INCOMPLETE` 首次出现即写一条 `note` 并停止后续尝试（直到插件重载），避免每个边界都重试与重复告警；熔断原因在设置页「熔断原因」可见。
- **自动排除可见**：预算触发自动排除最重的超限顶层项时，会写 `note` 并在设置页「自动排除的顶层项」显示——这代表该次快照的覆盖面已缩小。
- **快照是异步追拍**：事件发生与真正捕获之间有延迟（记在账本的 `lagMs`）；延迟超过 250 ms 且该步归属为空时，会写 `note` 提示"本步归属可能不完整"。追拍窗口是尽力而为的固有代价，重要操作用 `git diff` 复核。

## 限制

- 仅捕获配置内文件工具的显式目标路径，不覆盖 shell、其他插件、人工编辑和无法识别目标的调用。
- 不恢复完整目录结构，不提供工作区事务或整轮原子回滚。
- 超限文件仅记录元数据，没有快照时无法恢复。GUI 恢复上限固定为 2 MiB。
- 非“文件不存在”的读取错误不被当作创建前像；捕获失败仅告警，不改变工具结果。
- 捕获不证明工具执行或成功。纯 Node 路径检查不能提供针对恶意同机并发写入者的完整安全边界。

## 验证

从仓库根目录执行：

```sh
node tools/verify.mjs --pkg dsh-audit-rollback --quiet
node scripts/check-manifest.mjs
```

测试覆盖存储、捕获、CLI、GUI 数据接口、设置保存、损坏快照和 Windows 别名。使用临时目录；客户端 VM 测试不替代实机验收。

## 未核实项

- 目标安装版本的 GUI 显示、点击与更新后加载效果。
- 非验证基线核心版本、第三方工具参数及真实权限组合。
- 崩溃、断电及恶意并发路径交换下的完整恢复保证。符号链接测试受权限限制时可能跳过，跳过不代表覆盖。
- 阶段 B CLI 子命令在**真实会话账本**上的表现：已在临时账本上验过退出码 `0`/`4`/`5` 以及恢复、`trash`、`redo` 行为，但真实会话数据仍须在部署当前已接线插件并开启自动捕获后验证。
- GUI「变更与回滚」的边界时间线、预览与复制提示按钮的实机效果（当前客户端仍是阶段 A 的「已修改文件」页签）。
- `gitSnapshot: true` 时在真实会话里的自动边界快照效果——插件侧订阅与串行队列已接线，并通过隔离接线测试；尚未部署到真实宿主验证。
- `fs/write-intent`、`fs/edit-intent` 的参数签名，以及客户端 composer 是否可写（把提示放回输入框的接口是否存在）。
- Windows 权限受限时可能跳过的符号链接路径、真实并发下的影子库 `index.lock` 竞态、跨卷 `trash` 与真实 Linux 宿主行为。Windows 与 WSL ArchLinux 的隔离全仓回归均已通过；这不等于真实宿主或 GitHub runner 验收。
- `redo` 的参照对象（`preTree`/`postTree`）现已各自写 ref，**不再依赖** git 的 cruft pack；但 ref 会随回滚次数增长，需用 `audit-rollback gc --keep-days` 定期清理（默认不自动清理）。
- `undo-to` / `redo` 会在执行前重新核对规划时的存在性与内容哈希：计划后的写入默认 `skip`，`--force` 也不豁免这次复核。恢复采用排他创建；失败回退不会覆盖并发创建的新文件，备份位置会进入输出与账本。但这不是操作系统级目录锁，仍不能承诺恶意并发路径交换下的完整原子性——执行前请停止相关写入活动。

## 许可证

MIT
