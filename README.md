# dsh-guard

面向 DeepSeek Harness（核心 `@deepseek-ai/dsh 0.2.1-alpha.1`）的**沙箱侧加固工具集**。
补上官方当前没有的两块能力：**可回滚的持久审计**，以及**可指定模型的自动审批**。

## 背景

核查结论（2026-10-04，只读核查 0.2.1-alpha.1）：

| 能力 | 官方现状 |
|---|---|
| 权限三档 | `read-only` / `workspace-write` / `danger-full-access`，各自捆绑沙箱与审批策略 |
| 审批策略 | 只有 `ask` / `never`；无 allow-always、无记住授权、无撤销 |
| 审计 | `dsh-workspace-changes` 给每轮 diff，但**只存活在 Host 进程内存**，重启即失；非 git 工作区不覆盖 shell 改动 |
| 回滚 | **完全没有**任何 revert / undo / restore 入口 |
| 自动审批 | `dsh-experimental-auto-review` 逐调用审查，但 reviewer 路由**硬编码**为当前会话的 provider/model，无 Config（源码只导出 `apply`/`inject`/`name`，patch 层改不了） |

## 包

| 包 | 内容 | 版本 |
|---|---|---|
| [`packages/dsh-audit-rollback`](packages/dsh-audit-rollback) | 编辑前内容捕获（SHA-1 内容寻址）+ 逐轮 JSONL 审计账本 + 离线 CLI 回滚 + 会话内已修改文件预览/二次确认恢复；带可编辑设置页 | 0.3.2 |
| [`packages/dsh-auto-review-router`](packages/dsh-auto-review-router) | 可配置 reviewer 路由、合法高危拒绝转官方单次人工审批、审批阶段历史与结果摘要（工具条目下方）、目录级授权记忆；带可编辑设置页 | 0.3.2 |

以上是工作区开发树的实现描述，不代表这些改动已在 GUI 实机验收。基线版本 `0.3.2`。

业务存储逻辑只使用 `node:*`；配置声明使用宿主提供的官方 schema peer，设置写入走宿主 `settings` / `configEditor`，不捆绑另一套 DSH 核心，不另建配置文件。

## 安装

### 桌面（desktop）profile

桌面 profile 使用官方桌面入口。普通核心 CLI 默认拒绝 `desktop`，但本机 NEXT 的已安装 `lib/desktop-cli.js` 官方自带桌面管理能力，0.2.1 已通过该入口安装；其他版本须先核对现场入口。使用 GUI 管理器或此官方桌面 CLI 更新固定 CI/release tarball，不自行注入管理开关、不手改 profile 依赖、不直接执行 profile 目录里的 `pnpm install`。安装后核验来源、bundles、版本与包完整性；运行态/GUI 单独验收，重启另需授权。

> 历史手工 junction 安装不再作为推荐流程。工作区源码与已安装副本可能不同；修改源码不代表当前 GUI 已加载新版本。

### 非桌面 profile

```sh
dsh plugin --profile <name> add <包绝对路径或 tarball URL>
```

> ⚠️ 不建议用 pnpm 的 git 依赖直接安装 monorepo 子包。`github:<owner>/<repo>#path:/packages/<pkg>` 语法可以解析到子包，但会连带解析并安装整个 workspace 的成员与其 peer——实测一次装了 **530 个包**，其中包括整套 `@deepseek-ai/dsh*`，会往 profile 里塞进另一套核心版本。

### 发布产物

每次 `main` 推送都会自动构建并发布一个 release，附带两个 tarball：`dsh-audit-rollback.tgz` 与 `dsh-auto-review-router.tgz`。
**资产名不带版本号**，因此 `https://github.com/KouzakiUmi/dsh-guard/releases/latest/download/<资产名>.tgz` 永久有效，不会随发版 404。

## 设置

两个包各带**可编辑配置与实时状态页**，系统级设置统一位于 **设置 → 内置插件**，只保留一个入口，不再在设置侧栏另开页面：

- **审计与回滚**：编辑捕获工具、捕获字节上限、参数预览上限、调用记账与排除路径；保留账本、对象库和最近捕获诊断。状态目录不是即时字段；未实现的影子 Git 快照不作为有效开关提供。
- **Auto 审查路由**：从 DSH 已配置模型目录选择审查模型，思考深度随模型支持项联动，不手填 provider/model；保留启用、会话回退、上下文/历史/超时预算、日志与注册冲突状态。

保存通过官方 `settings` 服务，按 Config schema 校验，以 revision 拒绝过期写入，持久化至当前 profile 的 Cordis patch。不直接修改依赖清单，也不使用额外的插件设置文件。更高层 overlay 覆盖或 Settings 不可用时显示明确错误，不伪报保存成功。

即时字段使用 `.volatile()` 配置引用；审计轮次和单次模型审查各持有配置快照，避免编辑途中混用新旧配置。启用插件不等于自动替用户选中 Auto，也不改变用户的审批策略。

> 旧版“Config 一律不可变、只能手写 YAML”的说明已撤回。普通字段仍需配置编辑器重载；即时字段可以直接在设置页编辑。源码改动不代表已安装副本已经生效。

## 文档

- [`docs/design-audit-rollback.md`](docs/design-audit-rollback.md) — 阶段 A 契约（数据布局、账本字段、CLI 退出码、跨平台要求）
- [`docs/design-auto-review-router.md`](docs/design-auto-review-router.md) — 阶段 B 契约（Config、策略文本、决策协议、上下文分区）
- [`docs/design-plugin-ui-and-listing.md`](docs/design-plugin-ui-and-listing.md) — 设置 UI 与商店收录
- [`docs/approval-observability-design.md`](docs/approval-observability-design.md) — 审批阶段历史、人工继承与会话文件恢复边界（当前开发设计）
- [`docs/release-plan.md`](docs/release-plan.md)、[`docs/release.md`](docs/release.md) — CI 与发包流程

## 开发

```sh
npm install --ignore-scripts     # 仅仓库开发依赖，不在 DSH profile 目录执行
node tools/verify.mjs --quiet    # 机械验收：源码语法、自动发现 test/*.mjs（排除 runtime/bootstrap/helper）、API peer 与包清单
node scripts/check-manifest.mjs  # 逐包发布清单校验（含运行 helper 与 exports["./client"] 门禁）
# pack-all / release:local 会生成发布产物；须有单独发版授权
```

CI（`.github/workflows/ci.yml`）在 `main` 推送时跑同一套序列；`v*` tag 触发版本化发布（`make_latest: false`，不会抢 latest）。

## 已知限制

- 会话文件视图仅覆盖捕获配置中的文件工具路径；shell（pwsh/bash）、其他插件和人工改动不在覆盖范围。恢复只面向已结束且有完整前后像、路径身份与当前内容均通过复核的记录；历史只有前像的记录不可恢复。旧 CLI 与 GUI 恢复能力边界见包文档。
- 审批历史独立存放于 profile ledger，每文件上限 16 MiB、无自动轮转；写入串行仅在同一 Host 进程内，不构成跨 Host 多进程文件锁。摘要遮罩仅为尽力减少敏感信息，不保证识别任意秘密。
- `reported-result` 是框架报告的结果，不证明工具 body 确实执行；审批允许、工具报告成功与实际副作用是不同阶段。
- `never` 策略不创建人工审批请求；其他符合条件的 reviewer 明确拒绝可默认转官方人工单次审批（60 秒后通过请求级 signal 真正取消）。这不绕过后续核心 guard。
- `dsh-auto-review-router` 与官方 `dsh-experimental-auto-review` **互斥**（两者都注册保留名 `auto`，后注册者会失败），也不要与 `dsh-codex-connect` 的 `enableAutoReview` 同时启用。
- SDK `0.2.1-alpha.1` 的扩展点限于会话 Tab 与 composer 结果摘要，不提供逐工具卡片徽标或轨迹行内提示；不替换官方 renderer，也不声称覆盖 Codex 全部 undo 能力。工作区实施与离线测试不等于发布、安装或 GUI 验收。

## 许可证

MIT
