# dsh-audit-rollback

持久化审计账本 + 可精确回滚的编辑前内容。DSH 0.2.1-alpha.1 自带的 `dsh-workspace-changes` 只把每轮改动留在内存里、重启即失，且全安装树没有 revert/undo 入口；本插件补上持久层：文件工具动手前把目标路径的编辑前字节存进内容寻址对象库（CAS），并按轮次写 JSONL 审计账本。回滚由独立 CLI 离线完成，不占模型上下文。

## 能力

- **编辑前捕获**：`write` / `edit` / `str_replace_editor`（可配）调用前捕获目标文件原始字节进 CAS（SHA-1 寻址，同内容只存一份）。
- **逐轮审计账本**：`turn/start`、`call`（工具名 + 参数哈希 + 截断预览）、`capture/before|after`、`turn/end`、`rollback`、`note` 六类条目，按 UTC 日期分文件，append-only。
- **精确回滚**：独立 CLI 按会话 + 轮次回滚——已存在的文件从 CAS 恢复、新建的文件收进回收站；轮后被改动过的文件默认 skip，`--force` 才覆盖；dry-run 为默认，`--apply` 才真正动手。
- **可编辑设置页**：零构建手写 client，主入口 `settings.section`；支持编辑、保存、取消并重新读取、字段校验、保存结果与 revision 冲突提示。配置持久化只使用官方 Settings/ConfigEditor；存储层和 CLI 仍只用 Node 内建模块。
- **官方 Config schema**：Host 依赖 peer `@deepseek-ai/schemastery ~3.18.5-alpha.1`，五个可编辑字段声明 `.volatile()`，运行时读取 `.get()`。

## 限制（明确不做）

- **不做**实时 UI 内撤销按钮；回滚只走 CLI。
- **GUI 无回滚按钮**：设置页可以查看与设置捕获策略；实际回滚仍走独立 CLI。
- **不捕获** shell / 命令行 / 其它插件 / 人工编辑造成的文件改动——只覆盖文件工具（`write` / `edit` / `str_replace_editor`）在 `arguments` 里显式给出的路径；轮后被插件外手段改动的文件，undo 会按「轮后已被改动」skip 保护。
- **不做**影子 git 快照：`gitSnapshot` 不进入可编辑表单，不提供样子开关；旧 profile 的 `true` 保留告警和 note 兼容行为，不代表实现了 git 快照。
- **不保证**目录结构变化的回滚（只跟踪文件路径）；删除整目录等操作不在捕获范围。
- **不捕获**识别不出目标路径的工具调用（`call` 条目照记，`targets` 为空）。
- 超限文件（默认 >2 MiB）只记元数据不存内容，回滚时该路径 skip「对象缺失」。
- 读取失败（权限/被占用/目标是目录等，非「文件不存在」）的路径**不记 capture**，只 warn——不会把读不出来的路径误记成 `existed:false` 而回滚时误收进 trash。
- **excludeGlobs 的已知漏排除**（默认四条仍有效，但匹配不是文件系统语义）：模式区分大小写，且无通配符时是子串。`/.git/`、`/node_modules/` 两侧都有斜杠，所以目录本身 `D:\proj\.git`、`D:\proj\node_modules`（末尾不再跟分隔符）不会被排除；Windows 上 `.GIT`、`Node_Modules` 也不会命中。若自行写成没有斜杠的 `.git`，子串会误伤 `.gitignore`、`.gitattributes`、`.github`。默认四条带了斜杠，不会误伤这些文件。

## 安装与生效边界

本次只在开发仓库实现与离线测试，**未安装、未修改真实 profile/核心/安装树、未重启**。需要部署时另行获得授权，通过目标 profile 的官方插件管理入口操作；desktop 使用 GUI 插件管理器，其他 profile 先核验目标 CLI 的 `plugin --help`。不要手工链接包进 profile、不对真实 profile 运行包管理器、不修改 profile manifest 来绕过官方检查。

工作区代码更新不等于已安装副本更新。部署后需核验 Host Config schema、官方 settings namespace、client ModuleLoader 与 `settings.section` 入口；首次引入 schema/client 需要消费实例加载新版本。后续 volatile 表单保存不用重启，且仅对新轮次生效；普通 stateDir 迁移不能用此表单热改。

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
| `stateDir` | （回落见上） | 普通配置，设置页只读；状态目录支持 `~` 展开 |
| `captureTools` | `['write','edit','str_replace_editor']` | 要捕获编辑前内容的工具名 |
| `captureMaxBytes` | `2097152`（2 MiB） | 单文件捕获上限；超限记 `hash:null` + `note` |
| `argsMaxBytes` | `4096` | `call` 条目 `argsPreview` 截断上限（UTF-8 字节） |
| `logCalls` | `true` | 是否记录 `call` 条目 |
| `excludeGlobs` | `['/node_modules/','/.git/','/.dsh-memory/','/.graphflow-cache/']` | 命中即不捕获：含通配符按 glob（`*` / `**` / `?`）对绝对路径全串匹配；不含通配符按路径片段（子串）匹配，默认排除依赖目录、版本库、记忆目录与缓存目录 |
| `gitSnapshot` | `false` | 未实现，不可设置；仅兼容旧 profile 字段 |

兼容范围：`peerDependencies["@deepseek-ai/dsh"]` 为 `>=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0`。前半覆盖 `0.2.0` 的 rc 预发布；后半用带预发布标签的 `0.2.1-0` 放行 `0.2.1` 起、`0.3.0` 前的预发布（含本机 `0.2.1-alpha.1`）。只写前半段时，node-semver 匹配不到 `0.2.1-alpha.1`。

设置页统一位于「设置 → 内置插件 → 审计与回滚」（唯一 `settings.plugins.tab` 入口），不再贡献设置侧栏的独立页面。需启用官方内置插件设置容器；容器晚声明时等待，不注册另一处回退入口。保留 Host 只读状态、账本、对象库、最近捕获和最新配置回显；编辑使用官方 `remote.settings.describe()` 读取 `audit-rollback` namespace 和 revision，`update(ns, patch, revision)` 保存五个 volatile 字段。

保存成功表示官方 ConfigEditor 已验证、持久化并通过 Loader reconciliation；**新轮次**使用最新配置，**进行中轮次**保持 turn/start 时的完整快照，before/after 使用相同 stateDir 与捕获上限。仅参数预览/call 且没有活动轮次时读取当前配置。`stateDir` 属普通配置，在设置页明确只读：不支持安全热迁移，需停轮、备份数据并通过官方配置维护流程重加载。`gitSnapshot` 未实现且不可设置。

字段校验：两个上限为正安全整数；captureTools 至少一项；列表每行一项、空行忽略；excludeGlobs 可清空。保存失败保留草稿并显示错误；过期 revision 不覆盖并发修改，提示取消并重新读取，重新编辑后保存。官方 settings 服务缺失或配置不可写时明确报错，原状态查看仍可使用；不创建独立设置文件，不自行编辑真实 profile。

`excludeGlobs` 子串语义的边界（契约 §2.1 第 3 条）：不含通配符的模式是**区分大小写**的子串匹配——默认四项都带斜杠（`/.git/`），因此只命中路径中间的目录片段，**不会**命中目录本身不带尾斜杠的写法（如 `D:/proj/.git` 本身），也不会命中 `.GIT`（大小写不同）；反过来，若手写一个不带斜杠的模式（如 `.git`），会误伤 `.gitignore` 这类文件名——自定义时建议沿用带斜杠的写法。

## 未核实项

以下用法在本阶段未逐项对 DSH 内核做实证核实，按契约实现并在此声明：

1. **`exec.arguments` 的真实键集合**：目标路径按 `path` / `file_path` / `filePath` / `filename` 顺序探测，取自契约第 5.4 节；`write`/`edit` 在本机内核中的真实参数键尚未逐工具实证，识别不出时只记 `call`（`targets:[]`）不捕获——属于显式降级，不会误捕。
2. **dry-run 仍追加 `rollback` 计划条目**：契约第 7 节既要求「写一条 rollback 条目（applied 反映是否真的执行）」又要求 dry-run「不碰文件系统」。实现取「不触碰**目标文件**，但账本追加 `applied:false` 的计划条目」这一解释，保留审计痕迹。
3. **（已裁决，不再属于未核实项）`captureMaxBytes` 默认值与默认排除目录**：默认值见契约 §2.1（`captureMaxBytes: 2097152` 即 2 MiB、`excludeGlobs` 四项）；`cordis.patch.yml` 与插件代码内部默认值已按契约 §2.1 第 2 条要求逐字段对齐。
4. **`excludeGlobs` 匹配语义**（契约 §2.1 第 3 条写定）：手写实现，含通配符时支持 `*`（不跨分隔符）/ `**`（跨分隔符）/ `?`，对统一为正斜杠的绝对路径全串匹配；**不含通配符的模式按路径片段（子串）匹配**（`/node_modules/` 这类默认排除项依赖此语义生效）；brace 扩展等复杂语义不支持。
5. **一致性判定的参照**（契约第 7 节，2026-10-04 修正）：参照 = 该轮的 `after`（该轮没有 `after` 才退到该轮 `before`）；该路径在后续轮次另有捕获也视为不一致（skip「轮后已被改动」），只有 `--force` 才执行；`show` 与 `undo` 共用同一判定函数，两处结论一致。参照条目无哈希（超限捕获）时退化为比字节数。
6. **CLI 扩展**：`undo` 子命令额外接受 `--json`（契约只给 `last` 列了 `--json`），属超集扩展，不改变既定退出码语义。
7. **部署未执行**：本次仅工作区开发与隔离测试；真实 GUI 的渲染、点击和已安装副本更新未验证，不从离线通过推断当前页面已更新。

## 自测

```powershell
node test/selftest.mjs       # 离线存储层 + CLI 断言（CAS 去重 / before 去重 / 回滚 / append-only / trash 防覆盖 / CLI --force 等 11 条）
node test/plugin-smoke.mjs   # 假 ctx 桩冒烟：apply 不抛错 + 4 个事件注册 + 一轮事件流落账（含 before 哈希断言）
node test/status.mjs         # 假 ctx 调用只读状态：账本 / objects / capture / 配置回显
node test/settings-client.mjs # 零构建 VM 表单交互：编辑、保存、取消、校验、错误、冲突、翻译、状态刷新
node test/settings-integration.mjs # 真实 Cordis Loader + Settings + ConfigEditor 临时 profile
```

测试数据写在包内测试临时目录或系统 mkdtemp，并在 finally 清理，不写真实 `~/.dsh`。集成测试验证原 fiber 不卸载、官方持久化与失败不写入、实时配置改变下一轮实际捕获，以及旧轮次 before/after 固定快照。client 交互是 VM hook/元素测试，不等同真实浏览器可视验收。

`test/bootstrap.mjs` 只用于测试解析：优先正常 workspace peer，缺依赖时只读 `DSH_APP_ROOT` 指定的安装根；Windows 可回落本次已核验的 DSH NEXT 路径，保留 ESM export conditions。不安装、不写链接、不改安装树。schema/基础测试缺 peer 将报错；只有官方组合依赖缺失时集成测试显式 SKIP，CI 应配置依赖并要求执行，不能把 SKIP 当完整验收。

## API 依据（现场 0.2.1-alpha.1）

- 官方 [Settings 子系统文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/settings.md)：Config volatile 表单、revision 读写与冲突；在线 main 可能前进，实际契约以本次安装代码复核。
- 现场 `@deepseek-ai/dsh-settings/lib/index.js`：`volatileForm` 只投影 volatile 字段；`describe` 提供 revision；`update(ns, patch, expectedRevision)` 在 ConfigEditor 的锁内拒绝 `SETTINGS_CONFLICT`；普通配置路径不可写。
- 现场 `@deepseek-ai/dsh-api-settings-controller/lib/index.js`：`remote.settings.describe/update`、revision 第三参数、错误分类 `settings/conflict` / `settings/rejected`。
- 现场 `@deepseek-ai/dsh-config-editor/lib/index.js`：官方 profile patch 文件锁、schema 验证、原子持久化、Loader reconciliation 与失败恢复；插件不复制这些逻辑、不自行写 profile。
- 现场 `@deepseek-ai/schemastery 3.18.5-alpha.1` / Cordis Loader：`.volatile()` 产出 `.get()` 引用，volatile-only 更新不卸载 fiber。真实组合测试已验证本包使用方式。
