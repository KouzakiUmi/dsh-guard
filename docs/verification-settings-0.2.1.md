# dsh-guard 0.2.1 · 设置单入口修订

用户指定：两包属于系统级插件，设置仅放在「设置 → 内置插件」，不得在设置侧栏重复显示。

## 实现与依据

- 核心现场版本仍为 0.2.1-alpha.1。官方 [内置插件容器](<C:/Program Files/DSH NEXT/resources/app/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js#L201-L212>) 注册侧栏 `plugins` 并声明 `settings.plugins.tab` 子槽，中文标题为「内置插件」。
- 两个实际 lazy client factory 只向 `settings.plugins.tab` 注册一次，移除 `settings.section` 贡献；不创建侧栏回退。
- 内置容器未就绪时保留诊断、等待声明。晚声明后只产生一个页签；卸载清除页签与等待订阅。manifest 增加官方容器的信息性 client inject 边，仍需消费 profile 启用容器。
- Host 自动配置页仍由官方 settings.configure({auto:false}, ctx.fiber) 关闭。保存、revision 冲突、配置热更新、安全启停逻辑均未改变。

## 验证

- 全局 verify：58/58，exit 0；两包共 13 套测试全部通过，无 SKIP。
- 新增每包 navigation 测试：执行实际 client factory，同时存在两个槽时只贡献内置页签；容器晚声明时不回退到侧栏，声明后仍只一个入口；locale props 与卸载清理通过。为 VM 契约验证，不是浏览器视觉验收。
- check-manifest、git diff --check 通过。npm pack --ignore-scripts 后 check-packed 通过：每包 8 文件、5 JS 语法正确、实际发布字节与源码一致。

## 本地交付

- [审计与回滚 0.2.1](<../dist/dsh-audit-rollback.tgz>)：32759 bytes，SHA256 `44BF8ED691A2F785320E3EB1ED9C26B98E07CFCE05BFFF34BE4CD5BE68C316DA`。
- [Auto 审查路由 0.2.1](<../dist/dsh-auto-review-router.tgz>)：24170 bytes，SHA256 `073D3B759E64FE80F6B287D313FC23AE4AB204C63B5A26C5C56053E011EE2E25`。

本轮仅修改 D:\dsh-guard 开发仓库，未安装、重启或修改真实 profile/核心。当前 GUI 是否已加载此副本未实机验证；需通过桌面 GUI 官方管理流程更新消费副本，不能直接声称运行中的页面已去重。原强制卸载且日志不可写的权限收紧极限及未运行真实模型/跨版本/CI等边界保持不变，见 [历史验收与能力边界](<verification-settings-0.2.0.md>)。
