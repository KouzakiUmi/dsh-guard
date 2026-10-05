# 检查点 · approval-audit-stall-fix（K3 high）· 2026-10-05

任务 `approval-audit-stall-fix` **已完成实现与离线回归**（2026-10-05 二轮）。无 commit/stash/push/install/restart/真实模型/再委派。独立复核由父代理另派。

## 变更文件清单（packages/dsh-auto-review-router/）

- `lib/approval-history.js`（P1-A 主修）：record/manualOutcome 改同步有界 enqueue（返回 boolean，落盘结果只看 health）；writer 增加 epoch/quarantined；每个写 work 带 stall 看门狗（默认 stallTimeoutMs 5000，unref）；超时 quarantine 共享 writer（epoch++、gap AUDIT_IO_STALL），quarantine 后入队显式丢弃（AUDIT_WRITER_QUARANTINED）；已 quarantine 的 writer 即使 refs=0 也留在 writersByDir，绝不开第二 writer；晚完成在每次 await 后检查 epoch，只丢元数据不写盘；close/drain 走 boundedDrain（drainTimeoutMs 15000，超时 quarantine + AUDIT_DRAIN_TIMEOUT）；history 查询跳过已 quarantine 的 tail、tail 等待与 load 均有界（queryTimeoutMs 15000，超时 AUDIT_READ_TIMEOUT → history-unavailable）；load 增加 alive 闸门防止晚完成的 gap 误记账。16MiB/512 队列/32 LRU/datasync/同 profile 进程内串行全部保留。
- `lib/index.js`（P1-A/P1-B/P2）：gate 9 处 `await history.record/manualOutcome` 全部去 await（record 同步）；`apply(ctx, rawConfig, historyOptions)` 增加测试专用注入缝（Loader 只传两参）；stop(final=false|true) 分流——热关闭失败保留 guard/注册与原文案（lifecycle.mjs 契约不变），卸载失败置 `closeFailed`、registered=false、错误文案改为「宿主强制卸载可能已移除守卫与 Auto 注册……请人工收紧」；shutdown 捕获 stop 错误后继续 pending 取消+有界 drain 再 rethrow（Cordis 记录 effect 失败并继续强制排空）；queryRouterStatus 增加 registration.closeFailed；parseRouterStatus 与 client 统一为完整严格形状（observed/attempted/registered/conflict/closeFailed 布尔 + conflictWarning/error string|null + budget 五字段 + route.source）。
- `lib/client.js`（仅 P2 parser 段）：parseStatus 与 Host parseRouterStatus 逻辑逐句一致。
- `test/approval-history.mjs`：适配同步 record 契约（ENOSPC/文件上限/队列上限/撕裂尾部断言改为入队 true + drain 后查 health）。
- `test/status.mjs`：新增 P2 互反回归——vm 加载真实 client factory，host/client 两 parser 对 2 个接受样例同接受、9 个拒绝样例（缺 conflict/closeFailed/timeoutMs/logDecisions、非布尔 observed、非 string conflictWarning/error、route.source 非字符串、plugin 名不符）同拒绝。
- 新增 `test/audit-stall.mjs`：fs.stat/open/write/datasync 四阶段永 pending 矩阵（同步入队、quarantine 无第二 writer、drain/close/query 有界）；datasync 悬挂-释放场景（已提交行保留、后续丢弃、无乱序无空洞、gap 真实）；门类场景（reviewer allow 后 caller 取消、热禁用、卸载均有界；allow/never/下游 deny/迟到人工授权语义不变）。
- 新增 `test/failed-unload.mjs`：真实 Cordis + SessionStore + ApprovalService + ToolRuntime + 官方 `PermissionPresetService.prototype.registerAuto/specOf/derive`；注入 session.append 抛 SESSION_WRITE_FAILED 后 fiber.dispose() 有界完成，实证宿主移除守卫监听与 Auto 注册、会话保持 danger-full-access，状态报 registered=false + closeFailed=true + 人工收紧指引且不含「仍保留」。
- 未改：config/policy/package/docs/README/其它包；history 三个 DTO parser 逐字未动；manual-fallback.mjs 未改（直接通过）。

## 回归命令与结果

```powershell
$env:DSH_APP_ROOT='C:\Program Files\DSH NEXT\resources\app'   # 核心 0.2.1-alpha.1
cd D:\dsh-guard
node tools/verify.mjs --pkg dsh-auto-review-router --quiet    # 47/47 全绿（基线 43 + 2 新测试各 2 项）
git diff --check                                              # 干净（仅 package.json CRLF 警告，前序遗留）
# 单项反例回归：
node packages/dsh-auto-review-router/test/audit-stall.mjs     # 4 段 PASS
node packages/dsh-auto-review-router/test/failed-unload.mjs   # PASS
node packages/dsh-auto-review-router/test/status.mjs          # 含 P2 互反样例
```

## 关键取证（alpha.1 安装树）

- 官方 `PermissionPresetService.registerAuto` 用 `this.ctx.effect(...)`，经 Cordis 服务代理绑定**调用方** fiber——故插件 fiber 强析构时 Auto 注册必然被宿主移除，与 P1-B 实证一致。
- Cordis `Fiber._unload` 对每个 disposable 逐个 try/catch（logger.error）后继续——无公开 API 可阻止强析构，故 P1-B 只能做到状态诚实。
- 测试踩坑：stall 场景下 `timed()` 定时器若 unref 会让事件循环排空、进程以 unsettled TLA 退出——`timed` 用 ref'd（自身 ms 内必清除），看门狗用 unref。

## 仍未保障边界（交付口径）

1. fs.write 一旦提交内核不可撤销：stall quarantine 只保证不再有新写入/乱序，已提交行保留并以 gap 如实上报。
2. quarantine 是进程内终态：该 profile 目录的审计写在本进程内不再恢复（防第二 writer 乱序的刻意取舍）；恢复需进程重启。
3. 卸载期收紧失败时，宿主强析构继续移除守卫与 Auto：会话保持原权限模式，需人工收紧——状态文案已如实告知，插件无法承诺 fail-closed 守卫存续。
4. ledgerSeq 在写者串行链内按序分配（=入队顺序由单写者 FIFO 保证），未按字面「入队时分配」：入队时预分配会在写失败丢弃时留下序号空洞，破坏账本连续性校验。ordering 保证等价。
5. 实现者自测不等于独立安全审查；f933 复核点待独立复核复验。
