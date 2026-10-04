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
| [`packages/dsh-audit-rollback`](packages/dsh-audit-rollback) | 编辑前内容捕获（SHA-1 内容寻址）+ 逐轮 JSONL 审计账本 + 离线 CLI 精确回滚；带只读状态设置页 | 0.1.0 |
| [`packages/dsh-auto-review-router`](packages/dsh-auto-review-router) | 把 Auto 审查的 reviewer 路由解耦为可配置 `provider`/`model`/`effort`；带只读状态设置页 | 0.1.0 |

两者都是**零运行时依赖**（只用 `node:*` 内建模块），且都**不 import `@deepseek-ai/*`**——核心包只通过 Cordis 服务注入使用。

## 安装

### 桌面（desktop）profile

桌面 profile 的插件命令会被 `rejectElectronProfile()` 拒绝，因此走 GUI 或 native patch：

1. `git clone https://github.com/KouzakiUmi/dsh-guard.git ~/.dsh/repos/dsh-guard`
2. 在 `~/.dsh/profiles/node_modules/` 下为每个包建 junction，指向 clone 内的包目录
3. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 追加包名 —— 这一步控制**是否加载**
4. 同一 `package.json` 的 `dependencies` 追加 `link:` 条目 —— 这一步控制**GUI 的已安装列表是否显示**（`dshmarket` 的 `readInstalled()` 只读 `dependencies`）
5. 重启 DSH

> 两个字段的分工最容易踩坑：**`bundles` 决定加载，`dependencies` 决定显示**。只写前者时功能已经生效（日志与数据都在），但 GUI 插件列表里看不到它。

### 非桌面 profile

```sh
dsh plugin --profile <name> add <包绝对路径或 tarball URL>
```

> ⚠️ 不建议用 pnpm 的 git 依赖直接安装 monorepo 子包。`github:<owner>/<repo>#path:/packages/<pkg>` 语法可以解析到子包，但会连带解析并安装整个 workspace 的成员与其 peer——实测一次装了 **530 个包**，其中包括整套 `@deepseek-ai/dsh*`，会往 profile 里塞进另一套核心版本。

### 发布产物

每次 `main` 推送都会自动构建并发布一个 release，附带两个 tarball：`dsh-audit-rollback.tgz` 与 `dsh-auto-review-router.tgz`。
**资产名不带版本号**，因此 `https://github.com/KouzakiUmi/dsh-guard/releases/latest/download/<资产名>.tgz` 永久有效，不会随发版 404。

## 设置

两个包各带一个**只读状态页**（设置 → 插件）：

- **dsh-audit-rollback**：stateDir、账本条目统计（按 kind）、objects 数量与字节数、最近捕获明细、当前生效配置。
- **dsh-auto-review-router**：`enabled` 状态、解析出的 reviewer 路由（配置路由或会话回退）、与官方 auto-review 的注册冲突提示、上下文与超时预算。

第一版刻意**不做配置写入**：这两处配置是 cordis Config（loader 层，运行时不可变）。要改配置，写进 profile 的 `cordis.patch.yml`：

```yaml
- id: auto-review-router
  config:
    enabled: true
    reviewerProvider: xai-oauth
    reviewerModel: grok-4.7
    reviewerEffort: high
```

> 注意 Loader 对同一 `id` 的 config 是**整体替换**：写了 `config:` 就要把要用的字段写全，漏写的会回落到代码默认值。

## 文档

- [`docs/design-audit-rollback.md`](docs/design-audit-rollback.md) — 阶段 A 契约（数据布局、账本字段、CLI 退出码、跨平台要求）
- [`docs/design-auto-review-router.md`](docs/design-auto-review-router.md) — 阶段 B 契约（Config、策略文本、决策协议、上下文分区）
- [`docs/design-plugin-ui-and-listing.md`](docs/design-plugin-ui-and-listing.md) — 设置 UI 与商店收录
- [`docs/release-plan.md`](docs/release-plan.md)、[`docs/release.md`](docs/release.md) — CI 与发包流程

## 开发

```sh
node tools/verify.mjs            # 机械验收：语法、自测、硬约束、清单一致性
node scripts/check-manifest.mjs  # 逐包清单校验（含 exports["./client"] 门禁）
node scripts/pack-all.mjs        # 本地一键打包到 dist/
npm run release:local            # verify + check-manifest + pack-all
```

CI（`.github/workflows/ci.yml`）在 `main` 推送时跑同一套序列；`v*` tag 触发版本化发布（`make_latest: false`，不会抢 latest）。

## 已知限制

- 审计只覆盖**文件工具点名**的路径（`write` / `edit` / `str_replace_editor`）；**shell（pwsh/bash）对文件的改动不入账**，`gitSnapshot` 是未实现的占位开关。
- `dsh-auto-review-router` 与官方 `dsh-experimental-auto-review` **互斥**（两者都注册保留名 `auto`，后注册者会失败），也不要与 `dsh-codex-connect` 的 `enableAutoReview` 同时启用。
- 两者的 Host 侧都未在真实 DSH 进程里跑过完整链路（见各包 README 的「未核实项」）；`dsh-auto-review-router` 的 13 项内部 API 用法是探测式实现。

## 许可证

MIT
