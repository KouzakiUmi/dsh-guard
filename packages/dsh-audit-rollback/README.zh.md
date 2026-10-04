# dsh-audit-rollback

持久化审计账本 + 可精确回滚的编辑前内容。DSH 0.2.1-alpha.1 自带的 `dsh-workspace-changes` 只把每轮改动留在内存里、重启即失，且全安装树没有 revert/undo 入口；本插件补上持久层：文件工具动手前把目标路径的编辑前字节存进内容寻址对象库（CAS），并按轮次写 JSONL 审计账本。回滚由独立 CLI 离线完成，不占模型上下文。

## 能力

- **编辑前捕获**：`write` / `edit` / `str_replace_editor`（可配）调用前捕获目标文件原始字节进 CAS（SHA-1 寻址，同内容只存一份）。
- **逐轮审计账本**：`turn/start`、`call`（工具名 + 参数哈希 + 截断预览）、`capture/before|after`、`turn/end`、`rollback`、`note` 六类条目，按 UTC 日期分文件，append-only。
- **精确回滚**：独立 CLI 按会话 + 轮次回滚——已存在的文件从 CAS 恢复、新建的文件收进回收站；轮后被改动过的文件默认 skip，`--force` 才覆盖；dry-run 为默认，`--apply` 才真正动手。
- **零依赖**：只用 `node:*` 内建模块，不 import `@deepseek-ai/*`，不引入第三方包；存储层与 Cordis 完全解耦，可离线自测。

## 限制（明确不做）

- **不做**实时 UI 内撤销按钮；回滚只走 CLI。
- **无 GUI**：不提供任何图形界面入口，查询与回滚都只在独立 CLI 中完成。
- **不捕获** shell / 命令行 / 其它插件 / 人工编辑造成的文件改动——只覆盖文件工具（`write` / `edit` / `str_replace_editor`）在 `arguments` 里显式给出的路径；轮后被插件外手段改动的文件，undo 会按「轮后已被改动」skip 保护。
- **不做**影子 git 快照：`gitSnapshot` 只是占位开关，打开只记一条 `note` + warn，行为不变。
- **不保证**目录结构变化的回滚（只跟踪文件路径）；删除整目录等操作不在捕获范围。
- **不捕获**识别不出目标路径的工具调用（`call` 条目照记，`targets` 为空）。
- 超限文件（默认 >2 MiB）只记元数据不存内容，回滚时该路径 skip「对象缺失」。
- 读取失败（权限/被占用/目标是目录等，非「文件不存在」）的路径**不记 capture**，只 warn——不会把读不出来的路径误记成 `existed:false` 而回滚时误收进 trash。
- **excludeGlobs 的已知漏排除**（默认四条仍有效，但匹配不是文件系统语义）：模式区分大小写，且无通配符时是子串。`/.git/`、`/node_modules/` 两侧都有斜杠，所以目录本身 `D:\proj\.git`、`D:\proj\node_modules`（末尾不再跟分隔符）不会被排除；Windows 上 `.GIT`、`Node_Modules` 也不会命中。若自行写成没有斜杠的 `.git`，子串会误伤 `.gitignore`、`.gitattributes`、`.github`。默认四条带了斜杠，不会误伤这些文件。

## 手动安装

**本包作者没有在本机任何 profile 上实际安装过**；以下步骤是按官方 CLI（`@deepseek-ai/dsh 0.2.1-alpha.1` 的 `lib/bin.js` 与 `--help` 文案）与本机既有 native patch 惯例给出的指引，不是实测记录（见「未核实项」第 7 条）。两条路径互斥，按目标 profile 选其一：

### 路径 A：非 desktop profile（如 web / tui）—— 官方 CLI

官方入口是 `dsh plugin --profile <name> <pnpm 参数...>`：`--profile` 必须紧跟 `plugin`，剩余的整串参数原样转发给该 profile 目录下的 pnpm（help 原文示例：`dsh plugin --profile tui add <package>`）。**没有 `install` 子命令**——写 `install` 会被当成 pnpm 参数转发，语义完全不同。

```powershell
# 1. 把本包目录交给该 profile 的 pnpm（写入 profile 依赖）
dsh plugin --profile <name> add D:\dsh-guard\packages\dsh-audit-rollback

# 2. 重启 DSH，让 Loader 合并本包的 cordis.patch.yml（只 insert 一行 audit-rollback）

# 3. 验证：启动日志应出现
#    [audit-rollback] 已加载 stateDir=... captureTools=[write,edit,str_replace_editor] ...
```

### 路径 B：desktop profile —— CLI 被拒绝，二选一

核心按 profile 名硬编码拒绝 desktop 的插件命令（`rejectElectronProfile()`），`dsh plugin --profile desktop ...` 不可行。只能：

- **GUI 插件管理器**：桌面 profile 的插件安装由 Electron GUI 管理；但本包是本地目录包、不在市场里，通常不可选。
- **native patch 路径**（本机既有惯例）：

```powershell
# 1. 把包目录链接进 profile 共享的 node_modules（本机既有做法放 ~/.dsh/profiles/node_modules/<包名>）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-audit-rollback" `
  -Target "D:\dsh-guard\packages\dsh-audit-rollback"

# 2. 在 profile 自己的 cordis.patch.yml（如 ~/.dsh/profiles/desktop/cordis.patch.yml）
#    的 insert 列表里加一行引用包名（可照抄本包 cordis.patch.yml 的 insert 块）

# 3. 重启 DSH 生效
```

注意：Loader 对同一 id 的 config 是**整体替换**——在 profile 里写 config 时须把全部字段写全，否则未写的字段回落到插件代码默认值（与 `cordis.patch.yml` 默认值一致）；改完必须重启。

`cordis.patch.yml` 默认配置保守：不显式设 `stateDir`（回落 `$DSH_HOME/audit-rollback` → `~/.dsh/audit-rollback`）、`gitSnapshot:false`、默认排除 `node_modules` / `.git` / `.dsh-memory` / `.graphflow-cache` 四类目录。

## CLI 用法

```powershell
node scripts/audit-rollback.mjs list     [--state <dir>] [--session <sid>] [--turn <n>] [--limit N] [--json]
node scripts/audit-rollback.mjs sessions [--state <dir>] [--json]
node scripts/audit-rollback.mjs show     <sessionId> <turn> [--state <dir>] [--json]
node scripts/audit-rollback.mjs undo     <sessionId> <turn> [--state <dir>] [--apply] [--force]
node scripts/audit-rollback.mjs last     [--state <dir>] [--apply] [--force] [--json]
```

- 默认 dry-run：只打印将执行的动作，**不触碰任何目标文件**；按契约仍追加一条 `rollback` 计划条目（`applied:false`），作为审计痕迹。
- 退出码：`0` 全部完成；`1` 参数错误或状态不可读；`2` 有文件被 skip（部分完成）；`3` 该轮没有可回滚的捕获。
- 可把 `scripts/audit-rollback.mjs` 加进 PATH 或用 `npm link` 后直接用 `audit-rollback` 命令。

## 数据布局

```
<stateDir>/                     # 解析：config.stateDir → $DSH_HOME/audit-rollback → ~/.dsh/audit-rollback
  state.json                    # {"version":1,"createdAt":...}，只创建一次
  ledger/YYYY-MM-DD.jsonl       # UTC 日期分文件，append-only
  objects/<sha1前2位>/<sha1>    # CAS，原始字节，写入幂等，永不删除
  trash/<ISO时间戳去冒号>/<卷标识>/...    # 回滚时被移走的当前内容；Windows 卷标识=盘符字母（D:/a/b.txt → D/a/b.txt），UNC 归 UNC/<主机>/<共享>/…，POSIX 去根斜杠；目标重名追加 -1/-2 序号，绝不覆盖已有备份
```

## objects 清理

`objects/` **只增不减**。插件和 CLI 都不会自动删除里面的对象，也不会在回滚成功后回收它们。磁盘变大时只能人工清理，而且删了就真的回不去：

- 可以删除整个 `<stateDir>/objects/`，或其中某个 `<sha1 前 2 位>/` 子目录。不要只删散落的单个文件却留着半截目录——整段删掉更不容易漏。
- 账本行**不会**跟着改。已记下的 `capture.hash` 还在，但对应字节没了。之后对这些路径执行 `undo`，会在动手前降级为 `skip`，原因是「对象缺失」，**不会**把工作副本恢复成编辑前内容。
- 因此不要把清理理解成「腾出空间、回滚照旧」。还需要回滚的轮次，就不要删它引用的对象。
- 建议只在确认这些历史轮次不再回滚、或磁盘告急且 `stateDir` 已另有完整备份时清理。清理前先把整个 `stateDir` 拷走；拷贝本身不是回滚，只是让你还能把对象放回去。

## 配置字段

默认值见契约 §2.1；下表与其 yaml 逐字段一致，且按契约 §2.1 第 2 条要求，插件代码内部默认值与 `cordis.patch.yml` 默认值也逐字段一致。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `stateDir` | （回落见上） | 状态目录，支持 `~` 展开 |
| `captureTools` | `['write','edit','str_replace_editor']` | 要捕获编辑前内容的工具名 |
| `captureMaxBytes` | `2097152`（2 MiB） | 单文件捕获上限；超限记 `hash:null` + `note` |
| `argsMaxBytes` | `4096` | `call` 条目 `argsPreview` 截断上限（UTF-8 字节） |
| `logCalls` | `true` | 是否记录 `call` 条目 |
| `excludeGlobs` | `['/node_modules/','/.git/','/.dsh-memory/','/.graphflow-cache/']` | 命中即不捕获：含通配符按 glob（`*` / `**` / `?`）对绝对路径全串匹配；不含通配符按路径片段（子串）匹配，默认排除依赖目录、版本库、记忆目录与缓存目录 |
| `gitSnapshot` | `false` | 占位开关，未实现 |

`excludeGlobs` 子串语义的边界（契约 §2.1 第 3 条）：不含通配符的模式是**区分大小写**的子串匹配——默认四项都带斜杠（`/.git/`），因此只命中路径中间的目录片段，**不会**命中目录本身不带尾斜杠的写法（如 `D:/proj/.git` 本身），也不会命中 `.GIT`（大小写不同）；反过来，若手写一个不带斜杠的模式（如 `.git`），会误伤 `.gitignore` 这类文件名——自定义时建议沿用带斜杠的写法。

## 未核实项

以下用法在本阶段未逐项对 DSH 内核做实证核实，按契约实现并在此声明：

1. **`exec.arguments` 的真实键集合**：目标路径按 `path` / `file_path` / `filePath` / `filename` 顺序探测，取自契约第 5.4 节；`write`/`edit` 在本机内核中的真实参数键尚未逐工具实证，识别不出时只记 `call`（`targets:[]`）不捕获——属于显式降级，不会误捕。
2. **dry-run 仍追加 `rollback` 计划条目**：契约第 7 节既要求「写一条 rollback 条目（applied 反映是否真的执行）」又要求 dry-run「不碰文件系统」。实现取「不触碰**目标文件**，但账本追加 `applied:false` 的计划条目」这一解释，保留审计痕迹。
3. **（已裁决，不再属于未核实项）`captureMaxBytes` 默认值与默认排除目录**：默认值见契约 §2.1（`captureMaxBytes: 2097152` 即 2 MiB、`excludeGlobs` 四项）；`cordis.patch.yml` 与插件代码内部默认值已按契约 §2.1 第 2 条要求逐字段对齐。
4. **`excludeGlobs` 匹配语义**（契约 §2.1 第 3 条写定）：手写实现，含通配符时支持 `*`（不跨分隔符）/ `**`（跨分隔符）/ `?`，对统一为正斜杠的绝对路径全串匹配；**不含通配符的模式按路径片段（子串）匹配**（`/node_modules/` 这类默认排除项依赖此语义生效）；brace 扩展等复杂语义不支持。
5. **一致性判定的参照**（契约第 7 节，2026-10-04 修正）：参照 = 该轮的 `after`（该轮没有 `after` 才退到该轮 `before`）；该路径在后续轮次另有捕获也视为不一致（skip「轮后已被改动」），只有 `--force` 才执行；`show` 与 `undo` 共用同一判定函数，两处结论一致。参照条目无哈希（超限捕获）时退化为比字节数。
6. **CLI 扩展**：`undo` 子命令额外接受 `--json`（契约只给 `last` 列了 `--json`），属超集扩展，不改变既定退出码语义。
7. **安装步骤未实测**：本包作者没有在本机任何 profile 上实际安装过，「手动安装」一节是按官方 CLI（`lib/bin.js`、`--help` 文案）与本机既有 native patch 惯例给出的指引，不是实测记录。

## 自测

```powershell
node test/selftest.mjs       # 离线存储层 + CLI 断言（CAS 去重 / before 去重 / 回滚 / append-only / trash 防覆盖 / CLI --force 等 11 条）
node test/plugin-smoke.mjs   # 假 ctx 桩冒烟：apply 不抛错 + 4 个事件注册 + 一轮事件流落账（含 before 哈希断言）
```

两者均把数据写在 `test/.tmp*` 下并在结束时清理，不会写 `~/.dsh`。
