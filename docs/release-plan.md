# 设计契约 · dsh-guard 的 CI 与发包流程

> 2026-10-05 修订：可编辑设置新增 `lib/config.js` 发布文件；Node 24 CI 安装锁定的官方测试 devDependencies（`npm install --ignore-scripts`），根 verify 运行全部 `test/*.mjs` 测试、排除 bootstrap/runtime 辅助模块。官方 API 导入须为 peer，不再以“零 import”为门禁。下文原有清单和 Node 22 说明仅为历史设计，发布脚本当前实现及可编辑设置测试是新的验收依据。
>
> 本文件记录 CI/发布设计。参考实现是 `D:\dsh-subusage`（单包仓库），
> 但本仓库是 **monorepo、一次发布两个包**，所以凡标"裁定"的地方不得照抄，必须按本文件执行。
> 凡是本文件写定的字段名、job 名、顺序、权限与保护逻辑，实现必须逐字遵守。

- 仓库根：`D:\dsh-guard`
- 参考实现（只读）：`D:\dsh-subusage\.github\workflows\{ci.yml,release.yml}`、`D:\dsh-subusage\scripts\{check-manifest.mjs,prepare-release.mjs}`
- 用户硬要求：**提交之前必须先有完整的 CI 构建与发包流程**；**新的 release 必须标 `latest`**。

---

## 1. 交付物

```
D:\dsh-guard\
  .github\workflows\ci.yml        # 测试 + 打包 + main 推送时发布（带 latest）
  .github\workflows\release.yml   # v* tag 触发的版本化发布（不得抢 latest）
  scripts\check-manifest.mjs      # 逐包机械校验
  scripts\prepare-release.mjs     # 校验 npm pack 产物 → dist/<pkg>.tgz
  docs\release.md                 # 人读：本地复现、tag 规则、latest 语义、故障处置
  .gitignore                      # 追加 dist/、pack.json、*.tgz
  package.json                    # 根：补 ci / pack:all 脚本
  packages\dsh-audit-rollback\package.json       # 补发布元数据（见 §4）
  packages\dsh-auto-review-router\package.json   # 同上
```

---

## 2. 裁定：monorepo 与单包参考实现的差异

| 项 | subusage（单包） | dsh-guard（本仓库，裁定） |
|---|---|---|
| 发布产物 | 一个 `dist/dsh-subusage.tgz` | **两个**：`dist/dsh-audit-rollback.tgz`、`dist/dsh-auto-review-router.tgz` |
| Release 数量 | 一个 release 一个资产 | **一个 release 挂两个资产**，不拆成两个 release |
| 版本来源 | 根 `package.json` | **两个包各自的 `version`，且必须相同**（CI 强制校验，不一致即失败） |
| 测试命令 | `node tests/run-all.mjs` | 逐包跑 `test/selftest.mjs` + `test/plugin-smoke.mjs`，再跑根 `tools/verify.mjs` |
| 语法检查 | 硬编码三个文件名 | **遍历两个包下的全部 `.js/.mjs`**，逐个 `node --check`（硬编码会漏掉新文件） |
| `repository` | 指向仓库根 | **必须带 `directory` 字段**指向包目录（monorepo 必需） |

---

## 3. `.github/workflows/ci.yml`

触发：`push` 到 `main`/`master`，以及 `pull_request`。顶层 `permissions: contents: read`。

### job `test`

1. `actions/checkout@v4`，`persist-credentials: false`
2. `actions/setup-node@v4`，`node-version: 22`
3. **版本一致性校验**：读两个包的 `package.json`，`version` 必须相等且符合 semver；不等则 `exit 1` 并打印两者。
4. **语法检查**：遍历 `packages/*/` 下所有 `.js`/`.mjs`（排除 `node_modules`、`test/.tmp*`），逐个 `node --check`。
5. **测试**：逐包 `node test/selftest.mjs` 与 `node test/plugin-smoke.mjs`（存在才跑；不存在即失败）。
6. **中控验收脚本**：`node tools/verify.mjs`（必须退出码 0）。
7. **打包与校验**：
   ```sh
   for pkg in dsh-audit-rollback dsh-auto-review-router; do
     ( cd "packages/$pkg" && npm pack --ignore-scripts --json > ../../pack-$pkg.json )
   done
   node scripts/prepare-release.mjs
   ```
8. `actions/upload-artifact@v4`：`name: release-package`、`path: dist/*.tgz`、`if-no-files-found: error`、`retention-days: 7`。**仅** `github.event_name == 'push' && github.ref == 'refs/heads/main'`。

### job `publish`

- `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`
- `needs: test`；`permissions: contents: write`；`concurrency: { group: automatic-release-main, cancel-in-progress: false }`
- 步骤：
  1. checkout（`persist-credentials: false`）+ `actions/download-artifact@v4`（`name: release-package`、`path: dist`）
  2. **防旧构建覆盖 latest**（必须保留，逐字对齐参考实现的语义）：
     ```sh
     head=$(gh api "repos/$REPOSITORY/git/ref/heads/main" --jq '.object.sha')
     if [ "$head" != "$COMMIT_SHA" ]; then echo 'current=false' >> "$GITHUB_OUTPUT"; exit 0; fi
     echo 'current=true' >> "$GITHUB_OUTPUT"
     ```
     并用 node 写出 `tag=build-<sha12>` 与 `name=v<version> · <sha12>`（`version` 取自两个包，相等已由 test job 保证）。
  3. `softprops/action-gh-release@v2`，仅当 `current == 'true'`：
     ```yaml
     tag_name: ${{ steps.metadata.outputs.tag }}
     name: ${{ steps.metadata.outputs.name }}
     target_commitish: ${{ github.sha }}
     files: dist/*.tgz
     fail_on_unmatched_files: true
     generate_release_notes: true
     make_latest: true      # ← 用户硬要求
     prerelease: false
     ```

> `files: dist/*.tgz` 必须同时匹配到两个包；`fail_on_unmatched_files: true` 会让缺一个时整体失败。

---

## 4. `.github/workflows/release.yml`

触发：`push` tag `v*`。顶层 `permissions: contents: read`。

- job `release`：`permissions: contents: write`、`concurrency: { group: versioned-release-${{ github.ref }}, cancel-in-progress: false }`
- 步骤：
  1. **tag 与版本一致性**：`${{ github.ref_name }}` 必须等于 `v<version>`（两包 version 相同），否则失败。
  2. 重复 `test` job 的第 4–7 步（语法、测试、verify、打包校验）。
  3. `softprops/action-gh-release@v2`：`files: dist/*.tgz`、`fail_on_unmatched_files: true`、`generate_release_notes: true`、**`make_latest: false`**（latest 只由 main 的自动发布维护，旧 tag 不得使它回退）。

---

## 5. `scripts/check-manifest.mjs`

逐包校验，任一失败即 `process.exitCode = 1` 并打印 `FAIL <包名> <原因>`；成功打印 `PASS`。检查点：

1. `name` 为目录名；`version` 符合 semver。
2. `dsh.bundle.patch` 存在且指向的文件真实存在（awesome 收录硬性要求）。
3. **`@deepseek-ai/*` 不得出现在 `dependencies`**；必须出现在 `peerDependencies`（本仓库口径：`"@deepseek-ai/dsh": ">=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0"`，后半段才能匹配 `0.2.1-alpha.1`）。
4. `repository.url` 指向 `KouzakiUmi/dsh-guard`，且 `repository.directory` 等于 `packages/<包名>`。
5. `files` 白名单**恰好**覆盖运行必需文件（见 §6），且**不得**包含 `test`、`tools`、`node_modules`。
6. `exports` 里每个字符串目标在磁盘上存在（`*` 通配只校验其目录）。
7. `cordis.patch.yml` 含 `- insert:`，且其中 `name:` 等于本包名。
8. 两包 `version` 相等（跨包检查，只在根脚本里做一次）。

---

## 6. `scripts/prepare-release.mjs`

输入：两个 `pack-<pkg>.json`（`npm pack --ignore-scripts --json` 的原始输出）；输出：`dist/<pkg>.tgz`。

必须断言（逐包）：

- `pack.json` 恰好包含一个包条目，`name` 与目录名一致，`version` 符合 semver。
- `filename` 必须是裸文件名，且等于 `<name>-<version>.tgz`。
- 包内文件集合**必须恰好包含**下列必需项（多一个 `test/`、`tools/`、`node_modules/` 即失败）：

| 包 | 必需文件 |
|---|---|
| `dsh-audit-rollback` | `package.json`、`README.zh.md`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`、`lib/ledger.js`、`scripts/audit-rollback.mjs` |
| `dsh-auto-review-router` | `package.json`、`README.zh.md`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`、`lib/policy.js`、`lib/context.js` |

- 复制为 `dist/<name>.tgz`（固定资产名，不带版本号，与参考实现一致）。
- 打印每个产物的 `name@version`、字节数与文件数。

---

## 7. 两个包 `package.json` 的补齐要求

在两包现有内容基础上补齐（**不得改动现有 `dsh.bundle.patch`、`exports`、`bin`、`engines`、`main`、`type`**）：

```jsonc
{
  "private": true,                       // 保留：只发 GitHub Release，不 npm publish
  "repository": {
    "type": "git",
    "url": "git+https://github.com/KouzakiUmi/dsh-guard.git",
    "directory": "packages/<包名>"        // monorepo 必需
  },
  "keywords": ["dsh", "dsh-plugin", "dsh-bundle", "deepseek-harness", "cordis", "...特性词"],
  "peerDependencies": { "@deepseek-ai/dsh": ">=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0" },
  "dsh": {
    "manifestVersion": 1,                // 补
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

`files` 收紧为运行必需（去掉 `test/`）：

- `dsh-audit-rollback`：`["lib/index.js","lib/client.js","lib/ledger.js","scripts/audit-rollback.mjs","cordis.patch.yml","README.zh.md"]`
- `dsh-auto-review-router`：`["lib/index.js","lib/client.js","lib/policy.js","lib/context.js","cordis.patch.yml","README.zh.md"]`

---

## 8. 根 `.gitignore` 追加

```
dist/
pack.json
pack-*.json
*.tgz
```

## 9. 根 `package.json` 的 scripts

```jsonc
{
  "scripts": {
    "verify": "node tools/verify.mjs",
    "check-manifest": "node scripts/check-manifest.mjs",
    "pack:all": "node scripts/pack-all.mjs",     // 逐包 npm pack + prepare-release，可留作本地一键
    "release:local": "npm run verify && npm run check-manifest && npm run pack:all"
  }
}
```

（`pack-all.mjs` 可选；若实现，必须与 CI 里的命令序列等价。

## 10. `docs/release.md` 必须写清

- 本地如何完整复现 CI（逐条命令）
- tag 规则：自动 `build-<sha12>`、版本化 `v<version>`
- **latest 语义**：只有 main 的自动发布打 `latest`；`v*` tag 的版本化发布 `make_latest: false`，不会让 latest 回退
- 首次发布前置条件：GitHub 仓库 `KouzakiUmi/dsh-guard` 必须已存在（本仓库**不代为建仓、不推送**）
- 故障处置：release 已发但资产错了怎么办；如何手动重跑 workflow

---

## 11. 硬约束

- **不创建 GitHub 仓库、不推送、不 tag、不提交**（这些动作由中控在用户确认后执行）。本地只允许 `git init` 已完成的事实，不得新增任何 git 写操作。
- 不安装任何依赖；CI 里不得出现 `npm install` / `pnpm install`。
- 不改 `C:\Program Files\DSH NEXT`，不写 `~/.dsh`。
- workflow 里不得出现硬编码的 token、密钥或用户路径。
- 所有脚本只用 `node:*` 内建模块。
- 中文注释与中文输出；YAML 里保留必要的中文注释说明"为什么"。

## 12. 验收标准（中控机械复核）

1. `node scripts/check-manifest.mjs` 退出码 0，输出里每个包都有一组 `PASS`。
2. `node scripts/prepare-release.mjs` 退出码 0，`dist/` 下恰好两个 tarball，且打印的必需文件清单与 §6 表一致。
3. **把两个 tarball 解包到临时目录**，逐个 `node --check` 包内全部 `.js`，并确认 `cordis.patch.yml` 与 `README.zh.md` 在包内 —— 证明"发布包自洽可用"。
4. 本地完整复现一次 CI 序列（版本一致性 → 语法 → 两个包的 selftest 与 plugin-smoke → `tools/verify.mjs` → 打包校验），把**每条命令的退出码**贴进报告。
5. 对两个 workflow 做静态断言并以证据说明：`ci.yml` 含 `make_latest: true` 与防旧构建覆盖的 `gh api` 比对；`release.yml` 含 `make_latest: false`；两者 `checkout` 都带 `persist-credentials: false`；只有 publish/release job 有 `contents: write`；PR 不进入写权限 job。
6. 两个包的 `package.json` 通过 §7 的全部要求（`repository.directory`、`peerDependencies`、`dsh.manifestVersion`、`files` 收紧）。
