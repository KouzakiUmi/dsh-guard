#!/usr/bin/env node
/**
 * 版本化 npm 发布（由 release.yml 的 `v*` tag 触发）。
 *
 * 只用 node:* 内建模块；真正的上传交给 npm CLI，认证读 NODE_AUTH_TOKEN
 * （由 actions/setup-node 的 registry-url 写入 .npmrc）。
 *
 * 为什么要有这个脚本，而不是一行 `npm publish`：
 *   1. **幂等**——release.yml 可能重跑，npm 对已发布版本会 E403 直接失败。
 *      这里先查 registry，同版本已存在就跳过。
 *   2. **防 latest 回退**——npm 的 dist-tag 与 GitHub 的 `make_latest` 是两套机制。
 *      补发一个较低的版本号会把 npm 的 `latest` 指向旧版，与
 *      docs/release.md 里「latest 只前进不回退」的口径相反。这里检测到
 *      registry 已有更高版本就整体跳过。
 *   3. **monorepo 部分失败可补齐**——两包版本必须相同，但上一次发布可能只
 *      成功了一个。这种情况只补发缺的那个，而不是整组跳过。
 *
 * 发布的是 dist/<name>.tgz，即 prepare-release.mjs 已校验过、且与 GitHub
 * Release 资产完全相同的那份字节——不从目录重新打包，避免校验对象与发布对象不一致。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKGS = ['dsh-audit-rollback', 'dsh-auto-review-router']

const log = (msg) => console.log(msg)
const fail = (msg) => {
  console.error(`发布中止：${msg}`)
  process.exit(1)
}

/** 解析版本号。与 check-manifest.mjs 用同一条正则，口径不允许漂移。 */
function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value))
  if (!m) throw new Error(`无法解析版本号: ${value}`)
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null }
}

/** semver 比较：返回 -1 / 0 / 1。版本形态受 check-manifest 约束，比较逻辑保持最小。 */
function compare(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  }
  if (x.pre === null && y.pre === null) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** 查 registry 上已发布的版本列表。包不存在（首次发布）返回空数组。 */
function publishedVersions(pkg) {
  try {
    const out = execFileSync('npm', ['view', pkg, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    const detail = [error?.stderr, error?.message].filter(Boolean).join('\n')
    // npm CLI 对缺包返回退出码 1；只有明确的 registry 404 才能视作首次发布。
    // 网络、鉴权、限流等也会退出 1，不能误判成「包不存在」。
    if (error?.code === 'E404' || /(?:npm error code E404|E404 Not Found|404 Not Found)/i.test(detail)) return []
    throw new Error(`查询 ${pkg} 已发布版本失败: ${error && error.message ? error.message : error}`)
  }
}

// ---- 读版本：两包必须相同（CI 的版本一致性检查已把关，这里再兜一层）----
let current
const decisions = []
try {
  const versions = new Map()
  for (const pkg of PKGS) {
    const manifest = join(root, 'packages', pkg, 'package.json')
    if (!existsSync(manifest)) fail(`缺少 ${manifest}`)
    versions.set(pkg, JSON.parse(readFileSync(manifest, 'utf8')).version)
  }
  current = versions.get(PKGS[0])
  for (const pkg of PKGS) {
    if (versions.get(pkg) !== current) fail(`两包版本不一致：${PKGS[0]}=${current} vs ${pkg}=${versions.get(pkg)}`)
  }
  log(`目标版本：${current}（两包一致）`)

  // ---- 决策：逐包判断是否需要发布 ----
  for (const pkg of PKGS) {
    const published = publishedVersions(pkg)
    if (published.includes(current)) decisions.push({ pkg, publish: false, why: `版本 ${current} 已在 registry，跳过` })
    else {
      const higher = published.filter((v) => compare(v, current) > 0)
      if (higher.length > 0) {
        const top = higher.sort(compare).at(-1)
        decisions.push({ pkg, publish: false, why: `registry 已有更高版本 ${top}，拒绝回退 latest` })
      } else {
        decisions.push({ pkg, publish: true, why: published.length === 0 ? 'registry 尚无此包，首次发布' : `未找到 ${current}，将发布` })
      }
    }
  }
} catch (error) {
  fail(error && error.message ? error.message : String(error))
}
for (const d of decisions) log(`  ${d.pkg}：${d.why}`)

// Monorepo 的两个包必须同步前进。仅一个包存在更高版本时，也不能继续发布
// 另一个包的旧版本，否则会让两个 latest 指向不同的发布代际。
if (decisions.some((d) => d.why.includes('registry 已有更高版本'))) {
  log('至少一个包已有更高版本，本次两个包整体跳过，避免 latest 回退或版本失配。')
  process.exit(0)
}

const todo = decisions.filter((d) => d.publish)
if (todo.length === 0) {
  log('两个包都无需发布，本次 npm 发布跳过（重跑安全）。')
  process.exit(0)
}
if (todo.length !== decisions.length) {
  // 一次只成功了一个：补齐缺的那个即可，不整组跳过，否则永远补不齐。
  log('检测到上一次发布只完成了一部分，本次只补发缺失的包。')
}

// ---- 认证前置检查：给出可执行的指引，而不是让 npm 抛晦涩错误 ----
const token = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN
if (!token) {
  fail(
    '未配置 npm 认证令牌。请在 GitHub 仓库 Settings → Secrets and variables → Actions 新增 ' +
    'secret NPM_TOKEN（npmjs.com → Access Tokens → Generate automation token，勾选 ' +
    '"Read and write permissions"；只读 token 无法发布），然后重新触发本 workflow。',
  )
}

for (const pkg of PKGS) {
  const asset = join(root, 'dist', `${pkg}.tgz`)
  if (!existsSync(asset)) fail(`缺少已校验的发布产物 ${asset}——它应由 prepare-release.mjs 生成`)
}

// ---- 执行发布 ----
for (const { pkg } of todo) {
  const asset = join(root, 'dist', `${pkg}.tgz`)
  log(`发布 ${pkg}@${current}（${asset}）`)
  try {
    const out = execFileSync('npm', ['publish', asset, '--tag', 'latest'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_AUTH_TOKEN: token },
    })
    if (out.trim()) log(out.trim())
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n')
    fail(`npm publish ${pkg} 失败：\n${detail}`)
  }
}
log(`npm 发布完成：${todo.map((d) => `${d.pkg}@${current}`).join(', ')}`)
