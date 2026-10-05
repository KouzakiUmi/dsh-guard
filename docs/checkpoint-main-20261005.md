# dsh-guard 审批可观测性扩展 · 主检查点（主代理接管后整理）

时间：2026-10-05 08:20（Asia/Hong_Kong）。基线提交：73cf50ca830fa2dfe2e8958d2a1b6da729f1ba3d（两包 0.2.3，未发布新功能）。本文件是当前唯一权威进度快照；此前子代理 checkpoint 因子代理失败多数未落盘。

## 已完成（工作树内，未提交/未发布/未安装）

### Router 包（dsh-auto-review-router）
- Host 审批历史：独立 profileContext.dir JSONL（不写 session 事件），symbol token + dispatchUUID + PTC 父链关联，只读分页 SRC history（描述符与 client 逐字一致）。
- 官方人工 fallback：合法 reviewer deny 且有效 policy 非 never 时，downstream allow 后转官方 approval.request；默认 manualFallback=true、manualApprovalTimeoutMs=60000（1–300s），超时 cancelled+cause=timeout，及时清 timer 再 await 账本；never 不询问。
- UI：conversation.view `dsh-guard.approval-history` + composer.dock `dsh-guard.approval-result`，唯一 settings.plugins.tab；同 session 共享数据源、分页、本地 abort；无逐卡片徽章（alpha.1 无附加槽）。
- Config 与 manual-config/manual-fallback/approval-history/history-ui 等测试通过（实现者自测 43/43）。

### Audit 包（dsh-audit-rollback）半成品
- 已落地：ledger safeMkdir/safeLeaf/safeStateWrite（nlink===1、realpath、fd 验证、fsync）；preview 全量 capture 完整性/连续性校验；restore hardlink 拒绝、quarantine 搬移验证、intent/receipt 分离、nonce TTL120s/max256/单用。
- **当前模块坏**：rollback-preview.js import 的 canonicalPathKey 在 ledger.js 未导出（ESM 链接错误）；index.js createRollbackApi 未接 assertSession（默认全抛 SESSION_VERIFIER_UNAVAILABLE）。

## 待修缺陷（独立审查实证，审查者 Sol 已失败，结论有效）

### Router（修复者：K3 子代理 a1843e9d，进行中）
- P1-A：gate await history.record，fs.stat 永 pending 时 abort 后仍 activeTickets=1 未 settle → 改同步有界 enqueue、writer stall quarantine、有界 drain。
- P1-B（收窄）：真实 Cordis 强制卸载遇 session.append 失败 → 宿主仍移除守卫但 status 虚报「仍保留」→ 状态诚实化 + 真实 failed-unload 回归（强制卸载是 README 已声明的平台极限，不造永久守卫）。
- P2：status codec Host 要 conflict/不要 timeoutMs、Client 相反 → 统一两侧 parser + 互反拒绝样例。

### Audit（修复者 K3 a55de6fb 已交付；独立复核 K3 796fa010 已 **pass**，含同源误差标注）
- HIGH-1/2 半成品修复复验闭环；HIGH-3 会话校验接线（inspect 只读/活跃轮拒 mutation/缺失 fail-closed）；HIGH-4 canonicalPathKey 大小写归并；MEDIUM-5 权威 after 只在 turn/end（stopping 监听已删）。
- 复核者自写反例 7/7 通过；verify 38/38；scripts.test 已登记 security-regressions（README 同步 10 项）。
- 未验证：真实 Host/GUI、quarantine/recovery 故障注入、POSIX 分支仅代码审读。

## 已确认的 SDK 边界（写入 README/设计文档）
- alpha.1 无工具卡片/轨迹附加槽；toolview 是整卡替换；conversation.view/composer.dock 是合法入口。
- Session.append 不能公开标 ignorable，未知事件重载被拒 → 用独立账本。
- 审查 allow ≠ body 执行；reported-result 只有 reported-ok/error/unknown。
- ApprovalService.request 只有 signal；60s 由插件 deadline controller 实现。
- Windows Node24.13 无 O_NOFOLLOW；纯 JS 不能消除恶意并发 TOCTOU；shell 等未捕获改动不可回滚。

## 下一步（顺序）
1. 收两个修复者交付 → 全仓 node tools/verify.mjs --quiet + check-manifest + git diff --check。
2. 派两名 K3 high 独立复核（Router/Audit 各一，注明同源误差；Sol 线路额度耗尽不可用）。
3. 复核发现返工或收口 → 更新白板/账本/日志。
4. 提交/发布/安装/重启一律另等用户授权。

## 关键路径
- 设计文档：docs/approval-observability-design.md
- 修复任务提示已发给子代理，缺陷最小反例见对话记录（本检查点不复制）。
