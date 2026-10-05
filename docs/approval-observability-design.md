# 审批可观测性、人工继承与会话文件恢复 · 开发设计

状态：工作区开发树实施中/待验收；两包版本维持 `0.2.3`。目标核心 `@deepseek-ai/dsh 0.2.1-alpha.1`（已核对安装根 `node_modules/@deepseek-ai/dsh/package.json`）。本文不代表已发布、安装或 GUI 验收完成。

## SDK alpha.1 的 UI 扩展边界

- 审批历史使用官方 `conversation.view` 会话 Tab；最终结果摘要使用 `conversation.composer.dock`。
- 它们**不是**逐工具卡片上的徽标，也不是轨迹表格行内提示。`tool.call.toolview` 会替换整张工具卡片，轨迹当前没有通用附加槽；本实现不替换官方 renderer、不扫描 DOM。
- 文件变更摘要与预览也使用会话视图；任何恢复都需要显式二次确认。以上只说明所用扩展点，不宣称完整复刻 Codex 全部 undo 功能。

## 审批状态不能合并成一个成功标记

历史按 dispatch、session、turn/step、调用标识和 PTC 父子关联记录不同阶段：

1. `reviewer`：allow/deny/failure/cancel。
2. `downstream`：allow/deny/ask/cancel/failure，尚不等于核心最终 guard 通过。
3. `manual`：requested；最终 allowed-once/rejected/cancelled/unavailable。
4. `reported-result`：reported-ok/reported-error/unknown。

`reported-result` 是框架报告值，不证明工具 body 确实执行或产生了副作用；进入工具执行外围观察点也不应被表述为实际执行证明。不同轮/step、重复 callId、并发 PTC 必须使用 dispatch UUID、sessionId、调用坐标及 parent/root 关系关联；缺失坐标保留未知，不补造 0。

## 高危拒绝转官方人工审批

- 默认 `manualFallback=true`，等待超时默认 60 秒（配置范围 1,000–300,000 ms）。仅合法 reviewer 明确 deny 且下游允许后才请求官方人工审批。
- `never` 策略或关闭 manualFallback 时不发人工提示。审查失败、缺 schema、路由/协议错误及超时仍 fail-closed，不以人工确认兜底。
- 请求携带调用 signal 与生命周期取消信号；超时通过传给官方 request 的 AbortSignal 实际取消请求，而非只用 `Promise.race` 结束本地等待。迟到回答不能变成放行；关闭/卸载会中止等待并保留既有权限收紧逻辑。
- 人工 `allowed-once` 后，核心最终 guard/取消检查仍可能拒绝。人工允许、工具报告成功、实际工具 body 执行是不同事实。

## 持久历史与隐私边界

- alpha.1 的公开 `Session.append` 无法标记插件私有事件可忽略，未知非 ignorable 事件会妨碍恢复；因此历史写到由活动 `profileContext.dir` 定位的独立账本，不修改 session 文件。profile 路径不可用时显示审计缺口，不猜测 cwd/home。
- 每个 session 的 JSONL 文件上限 16 MiB；没有自动轮转或删除，触顶即记录缺口/停止追加。队列有限，损坏、断尾、缺 profile、读写失败、超限及卸载均在健康状态中呈现；观测失败不改变审批结果。
- 单进程内共享 writer 串行化同一 Host 的调用，不是跨 Host/进程文件锁，也不保证多进程并发写入原子性。
- 只持久化有界 allowlist 元数据、阶段、路由及有限长度摘要，不存完整工具参数、prompt、模型输出或工具内容。遮罩只是常见敏感值的尽力过滤，不能保证识别所有秘密；不得宣传为通用脱敏。
- 查询需确认 session 存在；仅查询历史，不恢复 agent、不写业务文件、不混入模型 messages。页面支持分页、错误和健康状态，不把失败呈现为空历史。

## 会话文件 diff 与恢复安全

- 覆盖范围仅为现有 `captureTools`（文件工具明确路径）；shell（pwsh/bash）、其他插件及人工改动不受审计/恢复保障。pre-capture 不证明工具实际执行。diff 是首个捕获前像与当前文件的比较，不是完整会话净改动。
- 仅在完整 before/after 内容都存在、相关轮次已结束、确有内容变化、对象校验通过，且没有更新/其他会话捕获时，才可开放恢复。旧记录若只有 before pre-image，绝不提供恢复。
- 恢复不接受浏览器任意 path 或 force；请求只包含 sessionId、受控 entryId、预览 nonce 与 expectedCurrentHash。读取历史时验证会话存在，条目必须属于该会话。
- 预览绑定会话/条目、前后像、当前哈希、文件身份与祖先路径身份；nonce 120 秒有效且单次消费。确认时重新校验当前哈希、身份、路径守卫及是否出现更新捕获；冲突、符号链接/祖先变化、目录、超尺寸/不可读内容均拒绝盲覆盖。操作前预览不写目标文件，取消确认不调用 mutation。
- Node 文件系统路径检查只能缩小风险面，无法彻底消除恶意并发写入者制造路径交换的 TOCTOU。此实现不应被描述为针对恶意同机并发攻击者的绝对安全保证。
- 新建文件撤回与已有文件恢复分别处理；先备份当前版本并记录意图，再执行、校验并尽力写回执。文件操作结果与审计回执是否成功分开报告。

## 验收范围与限制

- `tools/verify.mjs` 递归收集源码并自动枚举每包 `test/` 的 `.mjs`，排除 runtime/bootstrap/helper 加载文件；无需为新增测试手工改 runner。
- 发布产物的运行文件必须显式列入包 `files` 及 `scripts/check-manifest.mjs`、`scripts/prepare-release.mjs` 清单。当前新增运行 helpers：Host `approval-history.js`；Audit `rollback-preview.js`、`rollback-remote.js`。普通测试和其他开发源码不得因清单核对而误加到发布包。
- 验收包括当前 SDK 对象、never 不提示、人工允许/拒绝/超时/迟到/卸载、历史分页/损坏/限额/重复 callId/PTC、多会话、恢复冲突/路径身份/新文件/空文件/二进制/尺寸/写失败及独立安全审查。
- 当前阶段只描述源码与离线验证；完整仓库验证和独立安全审查完成前不得称验收通过。GUI 浏览器、已安装副本、真实模型调用、发布/安装、提交和重启均是不同阶段，须另行授权和实测。