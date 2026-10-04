# 0.2.3 · pending tool schema 取值修复

## 根因
0.2.2 router 的 pendingActionOf 无条件读取 exec.schema。当前核心 0.2.1-alpha.1 的 native 工具执行一般没有该字段，仅 PTC 内层由 binding 传入。因此 native 调用在发审查请求前被误报不完整并拒绝执行。旧测试人为给 native exec 附加 schema，掩盖了该协议差异。

## 同版本官方证据
消费根 C:\Program Files\DSH NEXT\resources\app，核心 manifest version=0.2.1-alpha.1。
- dsh-tools/lib/types/index.js:768–849 的实际 createExecution 仅透传调用方提供的 schema，不为 native 生成 schema。
- dsh-tools/lib/types/ptc.js:425–442 由 SDK binding 提供 schema/name/parent/token。
- dsh-experimental-auto-review/lib/index.js:179–206 的 nativeAction 从 headerTools 按 name 唯一匹配；ptcAction 从 exec.schema 读取并核对绑定名。
- 同文件:214–218 从 session.requestHeader 读取请求头，:76–83 验证 description 为 string、parameters 为对象记录。

## 修复
- classify 只读一次 requestHeader，以同一快照配对 session fallback route 与 native schema。
- native 只采用 requestHeader.tools 唯一同名项；PTC 只采用 exec.schema 且绑定名一致。
- 缺失/歧义/不完整仍拒绝，取消旧 parameters ?? {} 默认；未以执行对象虚构 schema、全局 registry 或人工放行兜底。
- 不改 approval preset、sandbox mode、模型选择器或其他审查判定；audit 仅按发版契约联动版本。
- 旧 selftest/Loader fixture 改为真实 native 形状；新增 pending-schema.mjs 用实际 SDK createExecution 配合交付 gate，而非假造 exec.schema。dsh-tools 加入显式同版本测试依赖，不进入插件运行时依赖。

## 验证
Windows 实际安装 SDK 下 62/62 验收检查、15 套回归、既有真实 Loader/Settings/ConfigEditor、热关闭/卸载/never 策略通过；没有付费模型或真实工具主体执行。
新测试覆盖四种 native 名称、请求头只读一次、native 不信任伪造 exec.schema、缺失/重复/错名/不可读/不完整请求头、PTC 绑定/错名/缺失、合法 reviewer deny。静态导入早于 bootstrap resolver 导致测试 SDK 无法解析的问题已改为动态导入，复验通过。

## 部署边界
用户明确确认发布0.2.3、推CI并由官方桌面CLI更新两包；不升级核心、不自动重启。冻结提交的离线结果不能代表未来 CI/安装或当前 GUI/Host 已加载；固定发布网络字节、官方 CLI 四验与重载后的真实 Auto 调用另行记录。
