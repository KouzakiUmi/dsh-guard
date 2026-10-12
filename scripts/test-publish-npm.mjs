#!/usr/bin/env node
// 发布决策隔离测试：只执行 VM 中的脚本，npm、文件系统和 process.exit 全部使用桩。
// 不联网、不打包、不上传，也不读取真实认证环境变量。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./publish-npm.mjs', import.meta.url), 'utf8')
  .replace(/^#![^\n]*\n/, '')
  .replace(/^import .* from 'node:[^']+'\n/gm, '')
  .replace(/import\.meta\.url/g, 'scriptUrl')
const packages = ['dsh-audit-rollback', 'dsh-auto-review-router']

function run({ version = '0.3.3', published = {}, platform = 'linux', env = {}, error = null, missingAsset = false } = {}) {
  const calls = []
  const logs = []
  let exitCode = 0
  const exit = {}
  try {
    runInNewContext(source, {
      scriptUrl: new URL('./publish-npm.mjs', import.meta.url).href,
      delimiter, dirname, join, fileURLToPath,
      existsSync: (file) => !(missingAsset && file.endsWith('.tgz')),
      readFileSync: () => JSON.stringify({ version }),
      console: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
      process: { platform, env, execPath: process.execPath, exit(code) { exitCode = code; throw exit } },
      execFileSync(command, args, options) {
        const argv = Array.from(args)
        args = command === process.execPath ? args.slice(1) : args
        calls.push({ command, argv, args: Array.from(args), options })
        if (args[0] === 'view') {
          if (error) throw error
          return JSON.stringify(published[args[1]] ?? [])
        }
        if (args[0] === 'publish') return 'published'
        throw new Error(`意外 npm 命令：${args[0]}`)
      },
    })
  } catch (error) {
    if (error !== exit) throw error
  }
  return { exitCode, calls, logs, uploads: calls.filter((call) => call.args[0] === 'publish') }
}

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`PASS ${name}`)
}
const both = (versions) => Object.fromEntries(packages.map((pkg) => [pkg, versions]))
const oidc = { ACTIONS_ID_TOKEN_REQUEST_URL: 'test', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test' }

test('已发布版本重跑：不需要认证，不上传', () => {
  const result = run({ published: both(['0.3.3']) })
  assert.equal(result.exitCode, 0)
  assert.equal(result.uploads.length, 0)
})
test('任一包版本更高：整组拒绝回退', () => {
  for (const versions of [['0.4.0'], ['0.3.3', '0.4.0']]) {
    const result = run({ published: { [packages[0]]: versions }, env: oidc })
    assert.equal(result.exitCode, 0)
    assert.equal(result.uploads.length, 0)
  }
})
test('部分发布：只补齐缺失包，OIDC 不依赖长期 token', () => {
  const result = run({ published: { [packages[0]]: ['0.3.3'] }, env: oidc })
  assert.equal(result.exitCode, 0)
  assert.equal(result.uploads.length, 1)
  assert(result.uploads[0].args[1].endsWith(`${packages[1]}.tgz`))
})
test('无认证或缺少产物：均不得上传', () => {
  for (const options of [{}, { env: oidc, missingAsset: true }]) {
    const result = run(options)
    assert.equal(result.exitCode, 1)
    assert.equal(result.uploads.length, 0)
  }
})
test('仅明确 E404 视作首次发布，网络/鉴权失败中止', () => {
  const absent = run({ env: oidc, error: { stdout: '{"error":{"code":"E404"}}', stderr: 'npm error code E404' } })
  assert.equal(absent.uploads.length, 2)
  for (const code of ['EPERM', 'ENOENT', 'E401', 'E503', 'ETIMEDOUT']) {
    const result = run({ env: oidc, error: { code, message: code } })
    assert.equal(result.exitCode, 1)
    assert.equal(result.uploads.length, 0)
  }
})
test('Windows 通过 Node 执行 npm-cli.js，不使用 shell 或给路径添加字面引号', () => {
  const windows = run({ platform: 'win32', env: oidc })
  assert(windows.calls.every((call) => call.command === process.execPath && call.argv[0].endsWith('npm-cli.js')))
  const posix = run({ env: oidc })
  assert(posix.calls.every((call) => call.command === 'npm'))
  for (const result of [windows, posix]) {
    assert(result.calls.every((call) => call.options.shell !== true))
    assert(result.uploads.every((call) => !call.args[1].startsWith('"')))
  }
})
test('semver 数字预发行标识低于非数字标识', () => {
  const result = run({ version: '0.3.3-10', published: both(['0.3.3-1a']), env: oidc })
  assert.equal(result.uploads.length, 0)
})
test('工作流静态门禁：版本 tag/OIDC/跨 tag 串行与双平台验收', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(release, /tags: \["v\*"\]/)
  assert.match(release, /id-token: write/)
  assert.match(release, /environment: npm/)
  assert.match(release, /group: versioned-release-npm/)
  assert.match(release, /run: node scripts\/publish-npm\.mjs/)
  assert.match(release, /Trusted Publishing 要求 npm >=11\.5\.1/)
  assert.match(ci, /os: \[ubuntu-latest, windows-latest\]/)
  assert.match(ci, /shell: bash/)
  assert.match(ci, /needs: test/)
  assert.match(ci, /matrix\.os == 'ubuntu-latest'/)
  for (const workflow of [release, ci]) {
    assert.match(workflow, /run: node tools\/verify\.mjs/)
    assert.match(workflow, /run: node scripts\/test-publish-npm\.mjs/)
    assert.match(workflow, /persist-credentials: false/)
  }
})
test('Windows CI 短路径临时目录转真实长路径，生产路径守卫不变', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const block = ci.match(/- name: Canonicalize Windows test temporary directory\n\s+if: runner\.os == 'Windows'\n\s+run: \|\n\s+node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)
  assert(block, '必须只对 Windows 执行规范化临时目录步骤')
  const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'
  const canonical = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp'
  const writes = []
  runInNewContext(block[1].replace(/^\s*import .* from 'node:[^']+';\s*$/gm, ''), {
    realpathSync: { native(path) { assert.equal(path, short); return canonical } },
    tmpdir: () => short,
    appendFileSync: (path, data) => writes.push({ path, data }),
    process: { env: { GITHUB_ENV: 'fixture-env' } },
    console: { log() {} },
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, 'fixture-env')
  assert.equal(writes[0].data, `TEMP=${canonical}\nTMP=${canonical}\n`)
  const ledger = readFileSync(new URL('../packages/dsh-audit-rollback/lib/ledger.js', import.meta.url), 'utf8')
  assert.match(ledger, /if \(!equal\) throw new Error\('PATH_REDIRECTION'\)/)
})
console.log(`发布隔离测试：${passed}/${passed} 通过`)
