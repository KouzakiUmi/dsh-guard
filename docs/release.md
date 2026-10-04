# dsh-guard 发布流程

本仓库是 monorepo，**一次发布两个包**（`dsh-audit-rollback` 与 `dsh-auto-review-router`），
产物为 `dist/dsh-audit-rollback.tgz` 与 `dist/dsh-auto-review-router.tgz`，
一个 GitHub Release 挂两个资产。实现口径见 `docs/release-plan.md`。

## 本地完整复现 CI（逐条命令）

在仓库根执行，顺序与 `ci.yml` 的 test job 一致：

```sh
# 1. 版本一致性（两包 version 相等且为 semver）
node -e "const a=require('./packages/dsh-audit-rollback/package.json'),b=require('./packages/dsh-auto-review-router/package.json');if(a.version!==b.version)process.exit(1);console.log(a.version)"

# 2. 语法遍历（两包下全部 .js/.mjs，逐个 node --check；tools/verify.mjs 内含同样遍历）
#    本地可直接复用中控脚本完成 2–4 步：
node tools/verify.mjs            # 语法检查 + 逐包 selftest/plugin-smoke + 硬约束

# 3. 逐包测试（verify 已覆盖；单独跑则）
node packages/dsh-audit-rollback/test/selftest.mjs
node packages/dsh-audit-rollback/test/plugin-smoke.mjs
node packages/dsh-auto-review-router/test/selftest.mjs
node packages/dsh-auto-review-router/test/plugin-smoke.mjs

# 4. 发布元数据机械校验
node scripts/check-manifest.mjs

# 5. 打包与校验（等价于 CI 的「Pack and validate release assets」）
( cd packages/dsh-audit-rollback && npm pack --ignore-scripts --json > ../../pack-dsh-audit-rollback.json )
( cd packages/dsh-auto-review-router && npm pack --ignore-scripts --json > ../../pack-dsh-auto-review-router.json )
node scripts/prepare-release.mjs
```

也可一键执行 `npm run release:local`（verify → check-manifest → pack:all）。

## tag 规则

- **自动发布**（`ci.yml`，push 到 main）：tag 为 `build-<sha12>`，标题 `v<version> · <sha12>`；
  version 取自两个包（相等由 CI 强制校验）。
- **版本化发布**（`release.yml`，push tag `v*`）：tag 必须等于 `v<version>`（两包 version 相同），
  否则 workflow 直接失败。

## latest 语义

- **只有 main 的自动发布打 `latest`**（`make_latest: true`），这是用户硬要求。
- `v*` tag 的版本化发布 `make_latest: false` —— 旧 tag 的补发不会让 latest 回退。
- 防旧构建覆盖：publish job 在发布前用 `gh api repos/<repo>/git/ref/heads/main` 比对
  当前构建的 commit；若 main 已有更新提交，则输出 `current=false` 并跳过发布，
  避免排队中的旧构建在新提交到达后覆盖 latest。

## 首次发布前置条件

- GitHub 仓库 `KouzakiUmi/dsh-guard` 必须**已存在**（本仓库不代为建仓、不推送、不打 tag，
  这些动作由维护者确认后执行）。
- 推送 main 后，`ci.yml` 的 publish job 自动发布 `build-<sha12>` 并标 latest。

## 故障处置

- **release 已发但资产错了**：先在 Releases 页面删除该 release 与对应 tag
  （`build-<sha12>` 或 `v*`），修好代码后推送新的 main 提交触发自动发布，
  或重新打 `v*` tag 触发版本化发布。不要复用旧 tag 重发。
- **手动重跑 workflow**：GitHub Actions 页面选中失败的 run → "Re-run failed jobs"。
  publish job 有 `concurrency: automatic-release-main`（不取消进行中的构建），
  重跑前确认没有同一组正在执行的 run。
- **打包校验失败（prepare-release 报错）**：通常是 `files` 白名单与包内文件不一致，
  或 `test/`、`tools/` 被混入 tarball；修正对应包的 `package.json` 的 `files` 后重跑。
- **版本不一致失败**：两个包的 `version` 必须同时 bump，改一处不改另一处会让
  CI 的版本一致性检查与 release.yml 的 tag 检查同时失败。
