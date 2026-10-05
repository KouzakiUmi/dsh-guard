# dsh-guard

DeepSeek Harness 的文件审计、回滚和自动审批工具集。两个插件可独立使用，通过宿主 Settings / ConfigEditor 保存配置，不另建设置文件或捆绑另一套核心。

## 插件

| 插件 | 功能 | 包版本 |
| --- | --- | --- |
| [dsh-audit-rollback](packages/dsh-audit-rollback/README.zh.md) | 文件前后像捕获、持久审计、会话内恢复、离线 CLI 回滚 | 0.3.2 |
| [dsh-auto-review-router](packages/dsh-auto-review-router/README.zh.md) | 可配置审查模型、人工审批回退、目录授权记忆、审批历史 | 0.3.2 |

验证基线为 DSH `0.2.1-alpha.1`，Node.js 要求为 `^22.19.0 || >=24.0.0`。依赖兼容范围以各包 manifest 为准，声明兼容范围不代表所有版本均经过运行验证。

## 安装

从 npm 安装对应插件包，再通过目标 profile 的官方插件管理入口添加该包。也可从 [GitHub Releases](https://github.com/KouzakiUmi/dsh-guard/releases) 获取 tarball 离线安装。

```sh
npm pack dsh-audit-rollback@0.3.2
npm pack dsh-auto-review-router@0.3.2
```

`npm pack` 会下载包到当前目录，随后把 tarball 路径传给 DSH 插件管理命令。桌面与非桌面 profile 的安装边界见下文。

非桌面 profile 可使用：

```sh
dsh plugin --profile <profile-name> add <tarball-path>
```

桌面 profile 使用 GUI 插件管理器或目标版本明确支持的官方桌面 CLI。不要在真实 profile 中直接运行包管理器或手工修改依赖清单。建议使用单包 tarball；monorepo Git 子目录依赖可能连带解析其他 workspace 包及核心依赖。

源码、发布包、磁盘安装副本和运行中的 Host/Client 是不同状态。安装更新后，按宿主加载机制确认新版本生效。

## 使用

### 文件审计与回滚

在「设置 → 内置插件 → 审计与回滚」配置捕获工具、大小上限和排除规则。会话「已修改文件」页签提供差异预览和二次确认恢复。CLI 按会话与轮次回滚，默认生成计划，指定 `--apply` 才修改目标文件。

捕获仅覆盖文件工具显式目标路径，不覆盖 shell、其他插件和人工编辑，不能作为完整工作区备份。GUI 与 CLI 的恢复条件不同，详见包文档。

### 自动审批

在「设置 → 内置插件 → Auto 审查路由」启用插件并选择模型，再在所需会话中选择 Auto。启用不会自动切换会话权限或审批策略。

每次模型审查会额外消耗一次请求。明确拒绝可在下游与审批策略允许时转人工；模型错误、超时及非法结果直接拒绝。中风险文件操作经人工放行后可记住目录与操作类别，高危操作每次询问。设置页可查看及撤销目录授权。

本插件不能与官方 `dsh-experimental-auto-review` 同时注册 Auto，也应避免与 `dsh-codex-connect.enableAutoReview` 同时启用。

## 数据与限制

- 文件审计默认存放于 `$DSH_HOME/audit-rollback`，未设置时使用 `~/.dsh/audit-rollback`，可配置独立状态目录。
- 审批历史存放于当前 profile 的 `dsh-auto-review-router/approval-history`；目录授权仅保存在当前插件实例内存。
- 捕获及框架报告结果不证明工具体执行或实际副作用成功。
- CLI 的 `--force` 可覆盖轮后修改，不能绕过快照完整性校验。
- 对象库与账本没有自动清理或轮转；删除快照会失去关联历史的恢复能力。
- 离线和 SDK 集成测试不能替代目标安装版本的 GUI 验收。

## 开发与验证

在仓库根目录执行：

```sh
npm install --ignore-scripts
node tools/verify.mjs --quiet
node scripts/check-manifest.mjs
```

`verify` 检查语法、自动发现并运行测试、核查依赖声明和包清单。测试使用临时数据及合成模型响应。缺少 workspace peer 时，可将 `DSH_APP_ROOT` 指向官方 DSH 安装目录作为只读依赖回退。

发布流程见 [release.md](docs/release.md)。验证命令不执行发布或安装。

## 文档

- [审计与回滚说明](packages/dsh-audit-rollback/README.zh.md)
- [自动审批说明](packages/dsh-auto-review-router/README.zh.md)
- [审计设计](docs/design-audit-rollback.md)
- [自动审批设计](docs/design-auto-review-router.md)
- [审批可观测性设计](docs/approval-observability-design.md)

设计文档保留设计阶段约定；实际字段、行为和限制以当前源码及包说明为准。

## 许可证

MIT
