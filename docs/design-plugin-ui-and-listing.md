# 设计契约 · 插件设置 UI 与商店收录（2026-10-04）

> 本文件是本次工作的唯一真源。凡标「已核实」的 API 事实直接采信，不要重新猜。
> 参考仓库：`D:\dsh-subusage`（手写 client.js、已被精选列表收录的同类插件）。

- 仓库：`D:\dsh-guard`（remote `origin` = https://github.com/KouzakiUmi/dsh-guard）
- 目标包：`packages/dsh-audit-rollback`、`packages/dsh-auto-review-router`

---

## 1. 用户诉求

1. **两个插件在 GUI 的「已安装插件」列表里看不到** → 要在列表里可见。
   **已解决（2026-10-04）**：该列表由 `dshmarket/lib/profile.js` 的 `readInstalled(profile, explicitDir)` 提供，
   它**只读 profile `package.json` 的 `dependencies`**（过滤掉 `INBOX_BUNDLES` 三个内置 bundle）。
   已在 `~/.dsh/profiles/desktop/package.json` 补两条 `dependencies`：
   `"dsh-audit-rollback": "link:<clone>/packages/dsh-audit-rollback"` 与同名规则的另一条（`bundles` 声明保留）。
   实测 `readInstalled('desktop', <dir>)` 返回 17 条并含二者。
   **注意区分**：`dsh.profile.bundles` 决定「是否加载」，`dependencies` 决定「是否在 GUI 列表显示」。
2. 插件**没有 UI**，用户无法在 GUI 里验证它们是否在工作 → 要补设置界面（本契约 §3）。
3. （可选、长期）进入社区精选列表，以获得市场内的正常安装/更新体验 → 材料见 §5，**不是本次的前置条件**。

---

## 2. 已核实的 API 事实（直接用）

### 2.1 client 侧插件形态

`lib/client.js` 是**手写**的普通文本文件（`dsh-subusage` 也是手写、`scripts: null`、零构建链），形态：

```js
window.__ModuleLoader__.load({
  id: 'dsh-audit-rollback',                 // 必须等于包名
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const react = require('react');          // 只 require 平台提供/已 inject 的模块
    // ... 组件 ...
    exports.apply = apply; exports.inject = inject; exports.name = name;
    return module.exports;
  },
});
```

- 模块主体保持惰性，副作用（含注入 CSS）写在 factory 闭包内。
- 只能用 `require(...)` 拿依赖；**不得 import `@deepseek-ai/*`**（与 host 侧一致）。

### 2.2 `package.json` 的 `dsh.client` 声明

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 已有，保留
  "manifestVersion": 1,
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-api-remotes"
    ]
  }
}
```

`dsh.client.inject` 是**信息性包名边**（不控制 apply 顺序）；真正拿服务用 client `inject` 数组（见 2.3）。

### 2.3 client 的 apply / inject 与槽注册

参照 `D:\dsh-subusage\lib\client.js`：

- `const inject = ['slots', 'locale', 'remote']`（client 侧的服务名，不带 `@deepseek-ai/` 前缀）
- `exports.apply = (ctx) => { ... }`
- **设置页注册**（subusage 第 1060 行附近）：
  ```js
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: '<页面 id>', order: 22, label: () => t('nav'), inject: [...], /* component */
  }))
  ```
- 官方 `dsh-client-ui-settings` 的槽约定（README 第 40–53 行）：设置界面由该包声明的 slot 类型承载 —— 功能页面注册 **`settings.section`**；「插件」分区承载 **`settings.plugins.tab`** 页面。**本次两个插件页面用 `settings.plugins.tab`**（它们是插件自身页面，更贴合语义）；若实现时发现该槽不可用，退回 `settings.section` 并在报告里说明。

### 2.4 Host ↔ Client 通信（Remote）

参照 subusage：Host 侧暴露 remote 方法，client 侧：

```js
ctx.remote.$mount({ methodName: async (payload) => {...}, ... })   // 挂载
await call('methodName', payload)                                   // 调用（client 侧封装）
```

`ctx.remote` 由 client 的 `inject: ['remote']` 提供；具体挂载/调用签名以 `D:\dsh-subusage\lib\client.js` 的 remote 段（第 288–560 行）与它 host 侧 `lib/index.js` 的注册方式为准，**实现前先读那两处**。

---

## 3. UI 规格（第一版：状态与诊断，**只读**）

> 裁定：第一版**不提供配置写入**。原因：两个插件的配置是 cordis **Config**（loader 层，运行时不可变），
> 要做「UI 内改配置」必须把可变项迁移到 `ctx.settings` 命名空间，属于设计变更，留作第二版。
> 第一版的目标是**让用户能在 GUI 里验证插件确实在工作**——这正是不做它的代价。

### 3.1 `dsh-audit-rollback` 的设置页

必须展示（全部来自 Host 实时读取，非静态文案）：

| 区块 | 内容 |
|---|---|
| 状态 | `stateDir` 绝对路径；`state.json` 的 version 与 createdAt |
| 账本统计 | 账本文件数、总条目数、按 `kind` 分布（turn/start、call、capture、turn/end、rollback、note） |
| 对象库 | `objects/` 对象数与总字节 |
| 捕获概况 | 唯一被捕获路径数；最近 N 条 `capture`（时间、phase、文件名、hash 前 8 位、字节） |
| 生效配置 | 只读列出 `captureTools` / `captureMaxBytes` / `argsMaxBytes` / `logCalls` / `excludeGlobs` / `gitSnapshot` |
| 修改指引 | 一句话说明：改配置写在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `- id: audit-rollback` 下，并注明「同 id 的 config 是整体替换，字段要写全」 |
| 动作 | 「刷新」按钮（重新拉取上述状态） |

### 3.2 `dsh-auto-review-router` 的设置页

| 区块 | 内容 |
|---|---|
| 状态 | `enabled` 当前值；是否已注册 `auto` 集成（即 registerAuto 是否成功） |
| 路由 | 解析后的 reviewer 路由：配置路由（provider/model/effort）还是会话回退；配置不全且 fallback 关时的拒绝说明 |
| 冲突 | 若官方 `dsh-experimental-auto-review` 已注册 `auto`（本插件注册失败），显示**明确警告**与处置建议（禁用其一） |
| 预算 | `maxContextBytes` / `historyLimit` / `timeoutMs` / `temperature` / `logDecisions` 当前值 |
| 修改指引 | 同 3.1；并说明启用后侧栏权限选择器会出现 `Auto`，且**不得与官方 auto-review 或 `dsh-codex-connect` 的 `enableAutoReview` 同时启用** |
| 动作 | 「刷新」按钮 |

### 3.3 语言

两个页面都要中英双语（参照 subusage 的 `zh` / `en` 词典与 `locale` 服务用法）；中文为主要文案。

---

## 4. 一并修掉的真实缺陷（必须做）

### 4.1 `peerDependencies` 的预发布范围写法

精选列表的 contributing 文档明确警告：`">=0.2.0-rc.1 <0.3.0-0"` 这类范围**匹配不到 `0.2.1-alpha.1`**——node-semver 只有当范围里某个比较符与目标版本 `major.minor.patch` 元组一致、且自身带预发布标签时才放行预发布版本。我们两包当前正是这个写法，用户 `npm install` 会撞 `ERESOLVE`。

改为显式预发布分支（覆盖 `0.2.0-rc.*` 与 `0.2.1+` 的预发布）：

```jsonc
"peerDependencies": { "@deepseek-ai/dsh": ">=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0" }
```

改完要在两包 README 的「未核实项」或配置说明里补一句这个范围的覆盖含义。

### 4.2 `files` 白名单要包含 client 入口

新增 `lib/client.js` 后，两包的 `files` 必须补上它，否则打包不含 UI，装完看不到页面。
`scripts/check-manifest.mjs` 与 `scripts/prepare-release.mjs` 里针对每个包的**必需文件清单也要同步更新**（否则 CI 会拦或漏拦）。

---

## 5. 商店收录材料（**可选、长期**，准备但不提交）

精选列表要求（已核实，来自它的 contributing 文档）：

- 提交方式：向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，**新增一个文件** `data/plugins/<owner>__<repo>.yml`（monorepo 子包见下）
- **monorepo 子包格式**（正是我们的情况）：
  ```yaml
  url: https://github.com/KouzakiUmi/dsh-guard/tree/main/packages/dsh-audit-rollback
  name: KouzakiUmi/dsh-guard#dsh-audit-rollback
  category: security            # 见文档的分类表
  description:
    en: 'One-line description ending with a period.'
    zh: '一句话描述，以句号结尾。'
  tarball: https://github.com/KouzakiUmi/dsh-guard/releases/latest/download/dsh-audit-rollback.tgz
  ```
  - 文件名形如 `KouzakiUmi__dsh-guard--packages-dsh-audit-rollback.yml`
  - 描述**必须与代码一致**（评审会核对），不得有营销词
  - `tarball:` 必须指向 GitHub Release 的 https `.tgz`；我们的资产名**不带版本号**，所以可以用 `releases/latest/download/<资产名>.tgz` 而不会随发版 404（**这是刻意的，不要改成带版本的文件名**）
- 其他门槛：仓库创建满 **1 天**（本仓库今晚才建，**提交前需确认已满 1 天**）；仓库需加 `dsh-plugin` **topic**；一个 PR 最多 3 条。

**本次交付**：把两条待提交的 yml 写到仓库内 `docs/awesome-submission/` 下（含 `data/plugins/` 的目标文件名与说明），**不要**去 fork/提 PR（外部写操作需用户另行授权）。

---

## 6. 验收标准（中控机械复核）

1. 两包全部 `node --check` 通过（含新增 `lib/client.js`）。
2. 两包 `test/selftest.mjs` + `test/plugin-smoke.mjs` 退出码 0；根 `node tools/verify.mjs` 与 `node scripts/check-manifest.mjs` 退出码 0。
3. **打包含 client**：重新 `npm pack --ignore-scripts` + `node scripts/prepare-release.mjs`，解包证明 `lib/client.js` 与更新后的 `cordis.patch.yml` 都在包内，且包内 `.js` 全过 `node --check`。
4. `dsh.client` 声明存在且 `platform: "web"`；client 入口与 host 入口都不 import `@deepseek-ai/*`。
5. 两个设置页所需的 Host 数据获取路径**有可离线验证的证据**：Host 侧的状态查询逻辑必须能在 `test/` 里用一个假 ctx 调用并断言输出结构（不许只写"UI 会显示"）。
6. `docs/awesome-submission/` 下两条 yml 与说明齐备，字段符合第 5 节。
7. peer 范围已按 4.1 修改；`files` 与两个脚本的必需清单已按 4.2 更新。

---

## 7. 硬约束

- 不改两个包 `lib/index.js` 里**已有的行为语义**（只允许新增对外暴露的只读状态查询与 remote 方法）。
- 不安装、不 `git commit`、不 `git push`、不打 tag、不建 fork、不提 PR。
- 不碰 `C:\Program Files\DSH NEXT`，不写 `~/.dsh`（测试用临时目录）。
- client 侧代码必须是**手写普通 JS**，不得引入构建步骤或第三方依赖。
- 中文注释；任何未能核实的 API 用法写进报告 `unresolved`，不要静默假设。
