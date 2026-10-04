# dsh-guard

面向 DeepSeek Harness（核心 `@deepseek-ai/dsh 0.2.1-alpha.1`）的**沙箱侧加固工具集**。
补的是官方当前没有的两块能力：**可回滚的持久审计**，以及**可指定模型的自动审批**。

## 背景

核查结论（2026-10-04，只读核查 0.2.1-alpha.1）：

| 能力 | 官方现状 |
|---|---|
| 权限三档 | `read-only` / `workspace-write` / `danger-full-access`，各自捆绑沙箱与审批策略 |
| 审批策略 | 只有 `ask` / `never`；无 allow-always、无记住授权、无撤销 |
| 审计 | `dsh-workspace-changes` 给每轮 diff，但**只存活在 Host 进程内存**，重启即失；非 git 工作区不覆盖 shell 改动 |
| 回滚 | **完全没有**任何 revert / undo / restore 入口 |
| 自动审批 | `dsh-experimental-auto-review` 逐调用审查，但 reviewer 路由**硬编码**为当前会话的 provider/model，无 Config |

## 包

| 包 | 阶段 | 内容 | 状态 |
|---|---|---|---|
| [`packages/dsh-audit-rollback`](packages/dsh-audit-rollback) | A | 持久审计账本 + 内容寻址对象库 + `/undo` 式回滚 CLI | 实现中 |
| [`packages/dsh-auto-review-router`](packages/dsh-auto-review-router) | B | 把 auto-review 的 reviewer 解耦为可配置 provider / model / effort | 未开始 |

## 设计契约

- [`docs/design-audit-rollback.md`](docs/design-audit-rollback.md)（阶段 A）
- `docs/design-auto-review-router.md`（阶段 B，待写）

契约是实现的唯一真源：字段名、路径布局、语义、退出码逐字遵守。

## 安装（人工，不在本仓库自动执行）

本仓库**不安装任何东西**，也不写 `~/.dsh`。安装步骤见各包 README。
桌面 profile 的插件安装由 Electron GUI 管理，CLI 会拒绝对该 profile 执行安装。

## 许可证

MIT
