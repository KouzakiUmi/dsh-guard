# dsh-guard 0.2.0 设置重构验收（历史）

> 此报告与下列尺寸/哈希仅记录 0.2.0 的历史验收。当前同名 dist 包已被 0.2.1 单入口修订替换，不应拿旧哈希验证新版；最新结果见 [0.2.1 验收](<verification-settings-0.2.1.md>)。

日期：2026-10-05。开发仓库：`D:\dsh-guard`，基线 `4a9aea2`。目标核心由消费安装树的 [核心 manifest](<C:/Program Files/DSH NEXT/resources/app/node_modules/@deepseek-ai/dsh/package.json>) 现场读取为 `0.2.1-alpha.1`；本机 Node `24.13.0`。未修改核心、已安装副本、真实 profile，未重启、提交或推送。

## 改动与真实生效链路

- 原设置页只有状态查询，没有编辑/保存接口。现两包导出官方 Config schema，通过现成 Settings describe/update 与 revision 锁保存，由 ConfigEditor 原子写 profile patch、Loader 更新 volatile 引用，不另建配置存储。
- 两页有编辑、保存、取消、字段校验、错误与冲突提示、中文/英文切换；冲突和持久化失败保留草稿，不能以状态刷新失败否认已经成功的保存。
- 审计五个字段热改，新轮次使用新配置、进行中轮次固定快照；stateDir 只读，gitSnapshot 未实现而不提供可用开关。审查每次请求读取一个 root volatile 快照，启停变化中止本代请求。
- 禁用/正常卸载只读收紧 Auto 会话，审批策略不变；枚举/写入失败保留 Auto 注册与拒绝守卫。每代 shutdown 在 registerAuto effect 之后注册，防止 Cordis 逆序先注销 Auto 导致 derive 退回完全访问。
- 独立核验发现并修复：关闭失败时外层 run_code 不能先于禁用/abort 检查豁免；安全关闭成功后必须移除旧守卫，不能误拦另一合法 Auto 所有者。

## 实跑结果

| 检查 | 结果 |
| --- | --- |
| 全局 verify | 54/54，exit 0 |
| 审计 5 套测试 | selftest、plugin-smoke、status、settings-client、settings-integration 全通过，无 SKIP |
| 审查 6 套测试 | selftest、plugin-smoke、status、settings、lifecycle、loader-settings 全通过，无 SKIP |
| 官方真实隔离组合 | Loader + Settings + ConfigEditor 写测试临时 profile，same fiber 热更新、配置文件持久化、冲突与非法写不改文件、新配置影响实际捕获/合成审查 |
| 安全负向回归 | sessions 缺失/list 抛错/list 返回 null/append 抛错：保留注册，edit 与 run_code 取消，next 零调用、never 不变；允许重试 |
| 官方注册与 derive | 真实 Service tracked context 下正常 fiber.dispose 先只读再注销；新 Auto 所有者接管后下游可达且旧 reviewer 不调用 |
| 页面交互 | 加载实际 lazy client factory，VM/确定性 hooks 验证保存、取消、冲突与 locale；不是浏览器视觉测试 |
| 清单与补丁 | check-manifest、git diff --check 全通过 |
| 打包 | npm pack --ignore-scripts；实际 tarball 每包 8 文件，5 个 JS 语法通过，所有字节与源码一致 |

复现命令（仅开发仓库，不是安装命令）：

```powershell
$env:DSH_APP_ROOT='C:\Program Files\DSH NEXT\resources\app'
node tools/verify.mjs
node scripts/check-manifest.mjs
node scripts/pack-all.mjs
node tools/check-packed.mjs
```

测试依赖优先正常 ESM 解析。仅缺失依赖时使用显式确认安装根的只读回退，仍保留 import 条件；不会将 require 条件选出的 CJS 偷换成 ESM 验证。

## 交付物

- [审计回滚包](<../dist/dsh-audit-rollback.tgz>)：0.2.0，32775 字节，SHA256 `C077B39422E20A08B30FB132749C5028E1D577987A10B16973989D2EAB317839`。
- [自动审查路由包](<../dist/dsh-auto-review-router.tgz>)：0.2.0，24197 字节，SHA256 `4F8C33152CBD64FC6EFBB19D890B2D6DD53E208E3F4F937E46CD672236A1DE68`。

## 尚未部署与保证边界

- 当前实际安装副本在 `C:\Users\Fractal\.dsh\repos\dsh-guard`，不是开发仓库；本轮未替换它。运行中 GUI 不能因源码与离线回归完成就被宣称已更新。需另经用户授权及桌面 GUI 官方插件管理流程更新，再验证当前页面可见与保存。
- 未运行付费/真实模型请求，未验证 reviewer 路由可达性；未执行 GitHub CI 或 Linux 实机回归，peer 范围不代表跨版本行为已验证。
- 强制销毁 fiber 或撤除服务且会话日志写入失败时，宿主最终移除守卫，本包无法保证已有完全访问会话被收紧；热禁用失败应先排障，不应强制卸载后继续执行。
- 禁用后历史 Auto 身份保留。没有活动 Auto 集成时官方恢复会拒绝，需用户明确选择有效权限或重新启用集成；不会自动恢复完全访问。
- 审计不覆盖 shell 的任意文件改动；正常启用下外层 run_code 中不经工具的 Node 副作用不是审查门的覆盖范围。
- 打包命令出现 Node DEP0190 警告：既有 Windows npm.cmd 调用使用 shell，参数为脚本内固定常量，不接受外部输入；不影响本次成功结果。Git 换行警告也非验证失败。
