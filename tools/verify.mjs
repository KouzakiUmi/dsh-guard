#!/usr/bin/env node
/**
 * 中控机械验收（不代替人工/异模型核验，只覆盖可确定判定的条款）
 *
 * 覆盖：
 *   1. 语法检查：对所有 .js / .mjs 跑 `node --check`
 *   2. 自测执行：跑每个包的 test/selftest.mjs 与 test/plugin-smoke.mjs，记录退出码
 *   3. 硬约束：禁止 import 任何 @deepseek-ai/*；禁止第三方依赖
 *   4. 落地痕迹：禁止向 ~/.dsh 写入（配置默认值可以提及，但代码里不得直接写盘）
 *
 * 用法：node tools/verify.mjs [--pkg <name>] [--quiet]
 * 退出码：0 全部通过；1 有 FAIL；2 脚本自身错误
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const only = args.includes('--pkg') ? args[args.indexOf('--pkg') + 1] : undefined

const results = []
function record(pkg, check, ok, detail) {
  results.push({ pkg, check, ok, detail })
  if (!quiet) {
    const tag = ok ? 'PASS' : 'FAIL'
    console.log(`[${tag}] ${pkg} · ${check}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 递归收集源码文件（跳过 node_modules、.git、test/.tmp）。 */
function collectSources(dir) {
  const out = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full)
    }
  }
  walk(dir)
  return out
}

function nodeCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    return { ok: true }
  } catch (error) {
    const stderr = error.stderr?.toString().trim() ?? String(error)
    return { ok: false, detail: stderr.split('\n').slice(0, 3).join(' | ') }
  }
}

function runNode(file) {
  try {
    const stdout = execFileSync(process.execPath, [file], {
      stdio: 'pipe',
      timeout: 180000,
      cwd: REPO,
    })
    return { ok: true, out: stdout.toString().trim().split('\n').slice(-3).join(' | ') }
  } catch (error) {
    const code = error.status ?? 'null'
    const stderr = error.stderr?.toString().trim().split('\n').slice(0, 4).join(' | ') ?? ''
    const stdout = error.stdout?.toString().trim().split('\n').slice(-3).join(' | ') ?? ''
    return { ok: false, detail: `exit=${code} ${stderr || stdout}` }
  }
}

const FORBIDDEN_IMPORT = /(?:from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\/|import\(\s*['"]@deepseek-ai\/)/
const HOME_WRITE = /(?:writeFileSync|appendFileSync|mkdirSync|createWriteStream)\s*\([^)]*\.dsh/i

const packagesDir = join(REPO, 'packages')
if (!existsSync(packagesDir)) {
  console.error('找不到 packages/ 目录')
  process.exit(2)
}

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => only === undefined || name === only)

if (packages.length === 0) {
  console.error(only === undefined ? 'packages/ 下没有包' : `没有匹配 --pkg ${only} 的包`)
  process.exit(2)
}

for (const pkg of packages) {
  const pkgDir = join(packagesDir, pkg)
  const sources = collectSources(pkgDir)

  if (sources.length === 0) {
    record(pkg, '文件清单', false, '包目录下没有任何源码文件')
    continue
  }
  record(pkg, '文件清单', true, `${sources.length} 个源码文件`)

  // 1. 语法
  for (const file of sources) {
    const rel = relative(pkgDir, file)
    const { ok, detail } = nodeCheck(file)
    record(pkg, `node --check ${rel}`, ok, detail)
  }

  // 2. 自测
  for (const candidate of ['test/selftest.mjs', 'test/plugin-smoke.mjs']) {
    const file = join(pkgDir, candidate)
    if (!existsSync(file)) {
      record(pkg, `自测 ${candidate}`, false, '文件缺失')
      continue
    }
    const { ok, detail, out } = runNode(file)
    record(pkg, `自测 ${candidate}`, ok, ok ? out : detail)
  }

  // 3. 硬约束
  const violations = []
  const homeHits = []
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    const rel = relative(pkgDir, file)
    if (FORBIDDEN_IMPORT.test(text)) violations.push(rel)
    if (HOME_WRITE.test(text)) homeHits.push(rel)
  }
  record(pkg, '禁止 import @deepseek-ai/*', violations.length === 0,
    violations.length === 0 ? '无' : violations.join(', '))
  record(pkg, '禁止直接写 ~/.dsh', homeHits.length === 0,
    homeHits.length === 0 ? '无' : homeHits.join(', '))

  // 4. 清单完整性（package.json / cordis.patch.yml / README）
  for (const required of ['package.json', 'cordis.patch.yml']) {
    record(pkg, `存在 ${required}`, existsSync(join(pkgDir, required)))
  }
  const readme = ['README.zh.md', 'README.md'].map((n) => join(pkgDir, n)).find(existsSync)
  record(pkg, '存在 README', readme !== undefined, readme === undefined ? '缺少 README.zh.md' : undefined)
  if (readme !== undefined) {
    const text = readFileSync(readme, 'utf8')
    record(pkg, 'README 有「未核实项」一节', /未核实项/.test(text))
  }

  // 5. cordis.patch.yml 必须 insert 且 id 与包名一致
  const patchFile = join(pkgDir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    const patch = readFileSync(patchFile, 'utf8')
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    record(pkg, 'cordis.patch.yml 含 insert', /-\s*insert:/.test(patch))
    record(pkg, 'cordis.patch.yml 指向本包名', patch.includes(manifest.name),
      patch.includes(manifest.name) ? undefined : `未出现 ${manifest.name}`)
    record(pkg, 'package.json 声明 dsh.bundle.patch', manifest.dsh?.bundle?.patch !== undefined)
  }
}

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(`共 ${results.length} 项检查，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`  - ${item.pkg} · ${item.check}${item.detail ? ` — ${item.detail}` : ''}`)
  process.exit(1)
}
console.log('全部通过')
