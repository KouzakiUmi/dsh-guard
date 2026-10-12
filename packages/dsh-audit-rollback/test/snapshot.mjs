#!/usr/bin/env node
/**
 * test/snapshot.mjs —— 影子 git 快照引擎自测（阶段 B / B1）
 *
 * 覆盖契约 docs/design-audit-rollback.md §10.12 第 2 条的四条硬断言：
 *   1) 影子库建在 <stateDir>/shadow/<workspaceKey>，**工作区不出现新文件**；
 *   2) 两次相同工作树内容 → 相同 tree（幂等）；
 *   3) `add -A` 不动工作区里既有 git 仓库的 index 与工作树；
 *   4) 无 git 可用时只降级（degraded），不抛异常、不重试。
 * 另加 §10.4 / §10.6 需要的断言：排除规则、归属路径、字节保真（CRLF）、
 * 边界 ref、force 策略、oversized blob、路径越界拒绝。
 *
 * 全部使用系统临时目录，绝不写 ~/.dsh；退出码 0 全通过，1 有失败。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanGitEnv,
  captureTree,
  diffTrees,
  ensureShadowRepo,
  listBoundaryRefs,
  listFilesRecursive,
  readBlob,
  readTreeEntry,
  scanBudget,
  shadowGitDir,
  toRelPath,
  workspaceKey,
  writeBoundaryRef,
  SNAPSHOT_REASON,
} from '../lib/snapshot.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-snapshot-test-'))
process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 退出时尽力清理 */ }
})

let passed = 0
const failed = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`[PASS] ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`[FAIL] ${name} — ${error && error.message ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function write(relPath, content) {
  const full = join(TMP, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

/** 在给定目录跑一次 git（清理 GIT_* 环境，避免测试受外部仓库影响）。 */
function gitSync(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function gitAvailable() {
  const probe = spawnSync('git', ['--version'], { env: cleanGitEnv(), encoding: 'utf8' })
  return probe.status === 0
}

/** 列出 tree 内全部路径（供断言排除规则）。 */
function treePaths(stateDir, root, tree) {
  const result = spawnSync('git', [
    '-c', 'core.autocrlf=false',
    `--git-dir=${shadowGitDir(stateDir, root)}`,
    `--work-tree=${root}`,
    'ls-tree', '-r', '--name-only', tree,
  ], { env: cleanGitEnv(), encoding: 'utf8' })
  assert(result.status === 0, `ls-tree 失败: ${result.stderr}`)
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
}

const hasGit = gitAvailable()
if (!hasGit) {
  console.log('[WARN] 本机 git 不可用，跳过需要 git 的用例（降级分支仍会执行）')
}

// ---------------------------------------------------------------- 用例开始

const ROOT = join(TMP, 'work')
const STATE = join(TMP, 'state')

write('work/src/a.txt', 'alpha\n')
write('work/src/b.txt', 'beta\n')
write('work/node_modules/pkg/index.js', 'module.exports = 1\n')
write('work/.hidden', 'hidden\n')

const workspaceBefore = listFilesRecursive(ROOT)

await test('影子库位置正确且工作区不出现新文件', async () => {
  assert(hasGit, '需要 git')
  const result = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })
  assert(result.ok, `capture 应成功，实际 reason=${result.reason}`)
  assert(/^[a-f0-9]{40}$/.test(result.tree), 'tree 应是 40 位十六进制')
  const gitDir = shadowGitDir(STATE, ROOT)
  assert(gitDir.includes(workspaceKey(ROOT)), '影子库目录应含 workspaceKey')
  assert(gitDir.startsWith(join(STATE, 'shadow')), '影子库应在 <stateDir>/shadow 下')
  const after = listFilesRecursive(ROOT)
  assert(JSON.stringify(after) === JSON.stringify(workspaceBefore),
    `工作区不应出现新文件：${JSON.stringify(after.filter((p) => !workspaceBefore.includes(p)))}`)
})

await test('相同内容两次快照得到相同 tree（幂等）', async () => {
  assert(hasGit, '需要 git')
  const first = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })
  const second = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })
  assert(first.ok && second.ok, '两次 capture 都应成功')
  assert(first.tree === second.tree, `tree 应相同：${first.tree} vs ${second.tree}`)
})

await test('排除规则生效：node_modules 不入 tree，普通文件入 tree', async () => {
  assert(hasGit, '需要 git')
  const snapshot = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })
  const paths = treePaths(STATE, ROOT, snapshot.tree)
  assert(paths.includes('src/a.txt'), `src/a.txt 应在 tree 内：${JSON.stringify(paths)}`)
  assert(paths.includes('.hidden'), '.hidden 应在 tree 内')
  assert(!paths.some((p) => p.startsWith('node_modules/')), `node_modules 不应入 tree：${JSON.stringify(paths)}`)
})

await test('归属路径与字节保真（CRLF 不被规范化）', async () => {
  assert(hasGit, '需要 git')
  const crlf = write('work/src/crlf.txt', 'A\r\nB\r\n')
  const before = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })
  writeFileSync(crlf, 'C\r\n')
  const after = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })

  const diff = await diffTrees({ stateDir: STATE, root: ROOT, from: before.tree, to: after.tree })
  assert(diff.ok, `diffTrees 应成功，reason=${diff.reason}`)
  const entry = diff.entries.find((item) => item.path === 'src/crlf.txt')
  assert(entry !== undefined, `diff 应含 src/crlf.txt：${JSON.stringify(diff.entries)}`)

  const lookup = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: before.tree, relPath: 'src/crlf.txt' })
  assert(lookup.ok && lookup.exists, '边界处的 src/crlf.txt 应存在')
  const blob = await readBlob({ stateDir: STATE, root: ROOT, oid: lookup.oid })
  assert(blob.ok && blob.buffer !== null, 'blob 应可读')
  assert(Buffer.compare(blob.buffer, Buffer.from('A\r\nB\r\n', 'utf8')) === 0,
    `恢复字节必须与写入一致（含 CRLF），实际 ${JSON.stringify(blob.buffer.toString('utf8'))}`)

  const missing = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: before.tree, relPath: 'src/created-later.txt' })
  assert(missing.ok && missing.exists === false, '边界处不存在的路径应报告 exists=false')
})

await test('边界 ref 可写可列（对象不会因不可达被剪掉）', async () => {
  assert(hasGit, '需要 git')
  const snapshot = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })
  const written = await writeBoundaryRef({
    stateDir: STATE, root: ROOT, ref: 'refs/dsh/test-session/t1s1-start', tree: snapshot.tree,
    message: 'test boundary',
  })
  assert(written.ok, `写 ref 应成功：${written.reason}`)
  assert(written.kind === 'commit' || written.kind === 'tree', `ref 目标类型应已知，实际 ${written.kind}`)
  const listed = await listBoundaryRefs({ stateDir: STATE, root: ROOT })
  assert(listed.ok, '列 ref 应成功')
  const found = listed.refs.find((item) => item.ref === 'refs/dsh/test-session/t1s1-start')
  assert(found !== undefined, `应能列出刚写的 ref：${JSON.stringify(listed.refs)}`)
  assert(found.tree === snapshot.tree, `ref 的 tree 应等于快照 tree：${found.tree} vs ${snapshot.tree}`)
})

await test('工作区里既有 git 仓库的 index 与工作树不被改动', async () => {
  assert(hasGit, '需要 git')
  const repo = join(TMP, 'userrepo')
  write('userrepo/keep.txt', 'keep\n')
  assert(gitSync(repo, ['init', '--quiet']).code === 0, 'git init 应成功')
  assert(gitSync(repo, ['add', '-A']).code === 0, 'git add 应成功')
  assert(gitSync(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init', '--quiet']).code === 0, 'git commit 应成功')
  write('userrepo/dirty.txt', 'uncommitted\n')
  const statusBefore = gitSync(repo, ['status', '--porcelain']).stdout
  const indexBefore = gitSync(repo, ['write-tree']).stdout

  const snapshot = await captureTree({ stateDir: join(TMP, 'state2'), root: repo, excludeGlobs: ['/node_modules/'] })
  assert(snapshot.ok, `capture 应成功：${snapshot.reason}`)

  const statusAfter = gitSync(repo, ['status', '--porcelain']).stdout
  const indexAfter = gitSync(repo, ['write-tree']).stdout
  assert(statusBefore === statusAfter, `用户仓库 status 不应变化：${statusBefore} -> ${statusAfter}`)
  assert(indexBefore === indexAfter, '用户仓库 index（write-tree 结果）不应变化')
  assert(!treePaths(join(TMP, 'state2'), repo, snapshot.tree).some((p) => p.startsWith('.git/')),
    '用户仓库 .git 不得进入影子快照')
})

await test('force 策略把被 gitignore 的文件纳入快照', async () => {
  assert(hasGit, '需要 git')
  const root = join(TMP, 'forceroot')
  write('forceroot/.gitignore', 'build/\n')
  write('forceroot/src/x.txt', 'x\n')
  write('forceroot/build/out.bin', 'artifact\n')

  const normal = await captureTree({ stateDir: join(TMP, 'state3'), root, excludeGlobs: [], ignorePolicy: 'git' })
  assert(normal.ok, `常规策略应成功：${normal.reason}`)
  assert(!treePaths(join(TMP, 'state3'), root, normal.tree).some((p) => p.startsWith('build/')),
    'git 策略下 build/ 不应入 tree')

  const forced = await captureTree({ stateDir: join(TMP, 'state4'), root, excludeGlobs: [], ignorePolicy: 'force' })
  assert(forced.ok, `force 策略应成功：${forced.reason}`)
  assert(treePaths(join(TMP, 'state4'), root, forced.tree).includes('build/out.bin'),
    'force 策略下 build/out.bin 应入 tree')
})

await test('oversized blob 只报大小、不读内容', async () => {
  assert(hasGit, '需要 git')
  const snapshot = await captureTree({ stateDir: STATE, root: ROOT, excludeGlobs: ['/node_modules/'] })
  const lookup = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: snapshot.tree, relPath: 'src/a.txt' })
  assert(lookup.exists, 'src/a.txt 应存在')
  const blob = await readBlob({ stateDir: STATE, root: ROOT, oid: lookup.oid, maxBytes: 1 })
  assert(blob.ok && blob.oversized === true && blob.buffer === null, '超限时应 oversized 且不返回内容')
})

await test('git 不可用时降级而不是抛异常', async () => {
  const broken = join(TMP, 'no-such-git-executable')
  const result = await captureTree({ stateDir: join(TMP, 'state5'), root: ROOT, gitPath: broken })
  assert(result.ok === false, '降级时 ok 应为 false')
  assert(result.degraded === true, '降级时 degraded 应为 true')
  assert(result.reason === SNAPSHOT_REASON.GIT_UNAVAILABLE, `reason 应为 GIT_UNAVAILABLE，实际 ${result.reason}`)
  const ensure = await ensureShadowRepo({ stateDir: join(TMP, 'state5'), root: ROOT, gitPath: broken })
  assert(ensure.ok === false, 'ensureShadowRepo 在坏 git 下也应返回失败而不是抛错')
})

await test('路径越界与非法参数被拒绝', async () => {
  const outside = join(TMP, 'outside.txt')
  write('outside.txt', 'x\n')
  assert(toRelPath(ROOT, outside) === null, '工作区外的路径应返回 null')
  assert(toRelPath(ROOT, join(ROOT, 'src', 'a.txt')) === 'src/a.txt', '工作区内路径应转成正斜杠相对路径')
  const bad = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: 'not-a-tree', relPath: 'src/a.txt' })
  assert(bad.ok === false, '非法 tree oid 应被拒绝')
})

await test('超预算时拒绝快照并给出最重目录（默认不自动排除）', async () => {
  assert(hasGit, '需要 git')
  const root = join(TMP, 'budgetroot')
  for (let i = 0; i < 12; i += 1) write(`budgetroot/src/f${String(i).padStart(2, '0')}.txt`, `content-${i}\n`)
  const result = await captureTree({
    stateDir: join(TMP, 'state6'), root, excludeGlobs: [], budget: { maxFiles: 3, maxBytes: 1, scanMs: 2000 },
  })
  assert(result.ok === false, '超预算应拒绝快照')
  assert(result.reason === SNAPSHOT_REASON.OVER_BUDGET, `reason 应为 OVER_BUDGET，实际 ${result.reason}`)
  assert(Array.isArray(result.oversize) && result.oversize.length > 0, '应给出最重的顶层项清单')
})

await test('autoExcludeOversized 时自动排除最重目录后成功', async () => {
  assert(hasGit, '需要 git')
  const result = await captureTree({
    stateDir: join(TMP, 'state7'),
    root: join(TMP, 'budgetroot'),
    excludeGlobs: [],
    budget: { maxFiles: 3, maxBytes: 1, scanMs: 2000 },
    autoExcludeOversized: true,
  })
  assert(result.ok, `自动排除后应成功：${result.reason}`)
  assert(result.autoExcluded.includes('/src/'), `应自动排除 /src/，实际 ${JSON.stringify(result.autoExcluded)}`)
  assert(result.files === 0, `被排除后 tree 应为空，实际 ${result.files}`)
})

await test('scanBudget 能在超预算子树上提前放弃并标记 oversized', async () => {
  const scan = scanBudget(join(TMP, 'budgetroot'), { excludeGlobs: [], maxFiles: 2, maxBytes: 1, scanMs: 2000 })
  assert(scan.ok, '盘点应成功')
  assert(scan.overBudget === true, '应判定超预算')
  assert(scan.heaviest.some((item) => item.path === 'src' && item.oversized === true),
    `src 应标记 oversized：${JSON.stringify(scan.heaviest)}`)
})

// ---------------------------------------------------------------- 汇总

console.log('')
console.log(`用例：通过 ${passed}，失败 ${failed.length}`)
if (failed.length > 0) {
  for (const item of failed) {
    console.log(`  - ${item.name}: ${item.error && item.error.stack ? item.error.stack.split('\n')[0] : item.error}`)
  }
  process.exitCode = 1
} else {
  process.exitCode = 0
}
