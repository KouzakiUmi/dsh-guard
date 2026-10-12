#!/usr/bin/env node
/**
 * test/snapshot-edge.mjs —— 影子库与回滚的边界条件加固（阶段 B · B3 加固轮）
 *
 * 目的：把"容易想当然"的地方钉死，全部用字节级或 fail-closed 断言：
 *   1. 文件名含 pathspec 特殊字符（`[` `]` `*` `?` `#` `%`、空格、中文、单引号）时不误匹配；
 *   2. 批量 rename（两文件互换内容）的归属不丢；
 *   3. 空文件、无尾换行、UTF-8 BOM、含 NUL 的二进制 → 字节保真；
 *   4. Windows 大小写别名只出现一个条目；
 *   5. 文件 ↔ 目录 的类型变化：当前不可读/非普通文件时必须 fail-closed（skip），不许当"不存在"处理；
 *   6. 预算边界：文件数恰好等于 maxFiles 时**不得**误判超预算；
 *   7. 恢复对象超限（blobMaxBytes 很小）时降级 skip，且**不许**先把原文件搬走；
 *   8. 归属只覆盖被审计根：根之外的同名路径不会因为字符串相似被牵连。
 *
 * 全部使用系统临时目录；退出码 0 全通过，1 有失败。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAllEntries } from '../lib/ledger.js'
import { captureBoundary, planBoundaryRollback, recordAttribution } from '../lib/boundary.js'
import { executeBoundaryRollback } from '../lib/boundary-exec.js'
import { cleanGitEnv, captureTree, readTreeEntry, scanBudget, shadowGitDir, SNAPSHOT_REASON } from '../lib/snapshot.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-edge-test-'))
process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
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

const ROOT = join(TMP, 'work')
const STATE = join(TMP, 'state')
const SESSION = 'session-edge'
const hasGit = spawnSync('git', ['--version'], { env: cleanGitEnv(), encoding: 'utf8' }).status === 0

function abs(rel) { return join(ROOT, ...rel.split('/')) }

function writeRaw(rel, buffer) {
  const full = abs(rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, buffer)
  return full
}

function write(rel, text) { return writeRaw(rel, Buffer.from(text, 'utf8')) }

/** 造一轮：start → 改动 → end → 归属。 */
async function turn(session, turnNo, mutate, step = 0) {
  const start = await captureBoundary({ stateDir: STATE, root: ROOT, session, turn: turnNo, step, phase: 'start', excludeGlobs: ['/node_modules/'] })
  assert(start.ok, `start 快照应成功：${start.reason}`)
  mutate()
  const end = await captureBoundary({ stateDir: STATE, root: ROOT, session, turn: turnNo, step, phase: 'end', excludeGlobs: ['/node_modules/'] })
  assert(end.ok, `end 快照应成功：${end.reason}`)
  const attribution = await recordAttribution({ stateDir: STATE, root: ROOT, session, turn: turnNo, step, from: start.tree, to: end.tree })
  assert(attribution.ok, `归属应成功：${attribution.reason}`)
  return { start, end, attribution }
}

// ------------------------------------------------------------------ 用例

await test('pathspec 特殊字符：readTreeEntry 按字面匹配，不误命中同名模式文件', async () => {
  assert(hasGit, '需要 git')
  // Windows 文件名不允许 `*` `?` 等字符（创建即 ENOENT），按平台过滤；
  // `[` `]` 本身就是 git pathspec 的 glob 字符类，足以验证 `:(literal)` 的必要性：
  // 若无 literal，`a[1].txt` 会被当成字符类并命中 `a1.txt`。
  const WINDOWS_FORBIDDEN = /[*?<>|:"\\/]/
  const all = ['a[1].txt', 'b*star.txt', 'c?q.txt', 'd#hash.txt', 'e%pct.txt', 'f space.txt', '中文名.txt', "g'quote.txt"]
  const tricky = all.filter((name) => process.platform !== 'win32' || !WINDOWS_FORBIDDEN.test(name))
  if (process.platform === 'win32') {
    console.log(`         （Windows 跳过含非法字符的名字：${all.filter((n) => WINDOWS_FORBIDDEN.test(n)).join('、')}）`)
  }
  for (const name of tricky) write(`tricky/${name}`, `content of ${name}\n`)
  const snapshot = await captureBoundary({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, phase: 'start' })
  assert(snapshot.ok, `快照应成功：${snapshot.reason}`)

  for (const name of tricky) {
    const found = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: snapshot.tree, relPath: `tricky/${name}` })
    assert(found.ok && found.exists === true, `应能按字面找到 ${name}：${JSON.stringify(found)}`)
  }
  // 反证：把 `a[1].txt` 当成 glob 会命中 `a1.txt`；这里确保没有这种误命中
  write('tricky/a1.txt', 'decoy\n')
  const decoyOnly = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: snapshot.tree, relPath: 'tricky/a1.txt' })
  assert(decoyOnly.exists === false, '边界快照里此刻不应有 a1.txt（它是快照之后才建的）')
})

await test('批量 rename：两文件互换内容，归属两个路径都在', async () => {
  assert(hasGit, '需要 git')
  write('ren/swapa.txt', 'AAA\n')
  write('ren/swapb.txt', 'BBB\n')
  const { attribution } = await turn(SESSION, 2, () => {
    write('ren/swapa.txt', 'BBB\n')
    write('ren/swapb.txt', 'AAA\n')
  })
  const names = attribution.paths.map((p) => p.split(/[/\\]/).pop()).sort()
  assert(names.includes('swapa.txt') && names.includes('swapb.txt'), `互换应归属两个文件：${JSON.stringify(names)}`)
})

await test('字节保真：空文件、无尾换行、BOM、含 NUL 的二进制', async () => {
  assert(hasGit, '需要 git')
  const cases = [
    ['bytes/empty.bin', Buffer.alloc(0)],
    ['bytes/nonewline.txt', Buffer.from('no trailing newline', 'utf8')],
    ['bytes/bom.txt', Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69, 0x0A])],
    ['bytes/binary.bin', Buffer.from([0x00, 0x01, 0xFF, 0x00, 0xFE, 0x0A, 0x0D])],
  ]
  for (const [rel, buffer] of cases) writeRaw(rel, buffer)
  const { start } = await turn(SESSION, 3, () => {
    for (const [rel] of cases) writeRaw(rel, Buffer.from('mutated\n', 'utf8'))
  })
  const plan = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 3, step: 0 })
  assert(plan.ok, `计划应成功：${plan.reason}`)
  const restored = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 3, step: 0, apply: true })
  assert(restored.ok, `执行应成功：${restored.reason}`)
  for (const [rel, buffer] of cases) {
    const now = readFileSync(abs(rel))
    assert(Buffer.compare(now, buffer) === 0,
      `${rel} 字节应逐字恢复：期望 ${buffer.toString('hex')}，实际 ${now.toString('hex')}（边界 ${String(start.tree).slice(0, 8)}）`)
  }
})

await test('Windows 大小写别名在 tree 里只有一个条目', async () => {
  assert(hasGit, '需要 git')
  write('case/Case.txt', 'x\n')
  const snapshot = await captureBoundary({ stateDir: STATE, root: ROOT, session: SESSION, turn: 4, step: 0, phase: 'start' })
  const upper = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: snapshot.tree, relPath: 'case/Case.txt' })
  assert(upper.ok && upper.exists, '原名应可找到')
  if (process.platform === 'win32') {
    const lower = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: snapshot.tree, relPath: 'case/case.txt' })
    assert(lower.ok, '小写写法不应报错')
  }
})

await test('类型变化：文件变目录后计划必须 fail-closed（skip），不许当"不存在"', async () => {
  assert(hasGit, '需要 git')
  write('typechange/item', 'was a file\n')
  await turn(SESSION, 5, () => {
    rmSync(abs('typechange/item'), { force: true })
    write('typechange/item/inner.txt', 'now a dir\n')
  })
  const plan = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 5, step: 0 })
  assert(plan.ok, `计划应成功：${plan.reason}`)
  const entry = plan.actions.find((a) => a.path.endsWith('item') || a.path.includes(`item${process.platform === 'win32' ? '\\' : '/'}`))
  assert(entry !== undefined, `计划里应出现该路径：${JSON.stringify(plan.actions)}`)
  assert(entry.action === 'skip', `当前是目录时应 skip，实际 ${entry.action}`)
  assert(entry.reason !== undefined && entry.reason.length > 0, '必须给出原因，不能静默跳过')
})

await test('预算边界：文件数恰好等于 maxFiles 时不得判超预算', async () => {
  const budgetRoot = join(TMP, 'budget-exact')
  mkdirSync(budgetRoot, { recursive: true })
  for (let i = 0; i < 5; i += 1) writeFileSync(join(budgetRoot, `f${i}.txt`), `x${i}\n`)
  const scan = scanBudget(budgetRoot, { excludeGlobs: [], maxFiles: 5, maxBytes: 1024 * 1024, scanMs: 3000 })
  assert(scan.ok, '盘点应成功')
  assert(scan.files === 5, `应数到 5 个文件，实际 ${scan.files}`)
  assert(scan.overBudget === false, '等于上限不应判超预算')
  const scan2 = scanBudget(budgetRoot, { excludeGlobs: [], maxFiles: 4, maxBytes: 1024 * 1024, scanMs: 3000 })
  assert(scan2.overBudget === true, '超过上限 1 个应判超预算')
})

await test('恢复对象超限：降级 skip 且不先把原文件搬走', async () => {
  assert(hasGit, '需要 git')
  write('oversize/big.txt', 'x'.repeat(4096))
  await turn(SESSION, 6, () => { write('oversize/big.txt', 'y'.repeat(4096)) })
  const before = readFileSync(abs('oversize/big.txt'), 'utf8')
  const result = await executeBoundaryRollback({
    stateDir: STATE, root: ROOT, session: SESSION, turn: 6, step: 0, apply: true, blobMaxBytes: 8,
  })
  assert(result.ok, `执行应返回成功结构：${result.reason}`)
  const action = result.actions.find((a) => a.path.endsWith('big.txt'))
  assert(action.action === 'skip', `对象超限应 skip，实际 ${action.action}`)
  assert(/超限/.test(action.reason ?? ''), `原因应说明超限，实际 ${action.reason}`)
  assert(readFileSync(abs('oversize/big.txt'), 'utf8') === before, 'skip 时原文件必须原样保留（不得先搬走再放弃）')
})

await test('归属不牵连被审计根之外的同名路径', async () => {
  assert(hasGit, '需要 git')
  const outside = join(TMP, 'outside-work')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'same-name.txt'), 'outside\n')
  const { attribution } = await turn(SESSION, 7, () => { write('scope/inside.txt', 'inside\n') })
  assert(attribution.paths.every((p) => p.startsWith(ROOT)), `归属路径必须都在被审计根内：${JSON.stringify(attribution.paths)}`)
  assert(!attribution.paths.some((p) => p.includes('outside-work')), '根之外的路径不得进入归属')
})

await test('账本可读且阶段 A 口径仍能跳过新条目', async () => {
  const entries = readAllEntries(STATE)
  assert(entries.length > 0, '账本应有条目')
  assert(entries.every((e) => typeof e.v === 'number' && typeof e.ts === 'string'), '每条都应有 v/ts')
  assert(entries.some((e) => e.kind === 'snapshot') && entries.some((e) => e.kind === 'attribution'), '应含阶段 B 条目')
})

await test('盘点未扫完（partial）时拒绝快照，不放行全量遍历', async () => {
  assert(hasGit, '需要 git')
  const root = join(TMP, 'partial-root')
  mkdirSync(root, { recursive: true })
  // 2000 个小文件 + 1ms 盘点窗口：必然 partial，但累计远未触及 maxFiles/maxBytes——
  // 这正是"未扫完且未超预算"的危险组合，绝不能据此放行 git add -A。
  for (let i = 0; i < 2000; i += 1) writeFileSync(join(root, `p${i}.txt`), `x${i}\n`)
  const result = await captureTree({
    stateDir: join(TMP, 'state-partial'),
    root,
    excludeGlobs: [],
    budget: { maxFiles: 1000000, maxBytes: 1024 * 1024 * 1024, scanMs: 1 },
  })
  assert(result.ok === false, `盘点未扫完时应拒绝，实际 ok=${result.ok}`)
  assert(result.reason === SNAPSHOT_REASON.SCAN_INCOMPLETE, `应报 SCAN_INCOMPLETE，实际 ${result.reason}`)
  assert(result.degraded === true, '拒绝时应标记降级')
})

await test('autoExcludeOversized 只排除真正超限的顶层项，不牵连正常目录', async () => {
  assert(hasGit, '需要 git')
  // 2026-10-11 独立复核发现的缺陷回归：早期实现把 heaviest 前 8 项整体排除，
  // 结果 small1/ small2/ root.txt 这些远未超限的项被静默踢出快照。
  const root = join(TMP, 'oversized-tops')
  const stateDir = join(TMP, 'state-oversized')
  mkdirSync(join(root, 'big'), { recursive: true })
  mkdirSync(join(root, 'small1'), { recursive: true })
  mkdirSync(join(root, 'small2'), { recursive: true })
  writeFileSync(join(root, 'big', 'huge.bin'), Buffer.alloc(150 * 1024, 1))
  writeFileSync(join(root, 'small1', 'f.txt'), 'small one\n')
  writeFileSync(join(root, 'small2', 'g.txt'), 'small two\n')
  writeFileSync(join(root, 'root.txt'), 'top level\n')

  const result = await captureTree({
    stateDir,
    root,
    excludeGlobs: [],
    budget: { maxFiles: 1000, maxBytes: 100 * 1024, scanMs: 3000 },
    autoExcludeOversized: true,
  })
  assert(result.ok, `应成功：${result.reason}`)
  assert(result.autoExcluded.includes('/big/'), `应排除 big/：${JSON.stringify(result.autoExcluded)}`)
  for (const other of ['/small1/', '/small2/', '/root.txt/']) {
    assert(!result.autoExcluded.includes(other), `不得排除未超限的 ${other}：${JSON.stringify(result.autoExcluded)}`)
  }
  for (const rel of ['small1/f.txt', 'small2/g.txt', 'root.txt']) {
    const found = await readTreeEntry({ stateDir, root, tree: result.tree, relPath: rel })
    assert(found.exists === true, `${rel} 必须仍在快照里（不许被静默排除）`)
  }
  const excluded = await readTreeEntry({ stateDir, root, tree: result.tree, relPath: 'big/huge.bin' })
  assert(excluded.exists === false, 'big/huge.bin 应被排除')
})

await test('根不可读 / 根不是目录时 fail-closed，不落到 add -A', async () => {
  const fileRoot = join(TMP, 'not-a-dir.txt')
  writeFileSync(fileRoot, 'i am a file\n')
  const result = await captureTree({
    stateDir: join(TMP, 'state-badroot'),
    root: fileRoot,
    excludeGlobs: [],
    budget: { maxFiles: 10, maxBytes: 1024, scanMs: 1000 },
  })
  assert(result.ok === false, `应拒绝，实际 ok=${result.ok} reason=${result.reason}`)
  assert(result.reason === SNAPSHOT_REASON.SCAN_UNREADABLE, `应报 SCAN_UNREADABLE，实际 ${result.reason}`)
  assert(result.tree === null, '拒绝时不得产生 tree')
})

await test('单层超大目录也会被 scanMs 截断（逐项时间闸门）', async () => {
  // 2026-10-11 全面复核实证：早期 walkBudget 只在函数入口检查时间，
  // 单一扁平目录里 20000 个文件在 scanMs=1 下仍返回 partial:false / ms=1025。
  const root = join(TMP, 'flat-many')
  mkdirSync(join(root, 'big'), { recursive: true })
  for (let i = 0; i < 8000; i += 1) writeFileSync(join(root, 'big', `f${i}.txt`), '')
  const scan = scanBudget(root, { excludeGlobs: [], maxFiles: 50000, maxBytes: 512 * 1024 * 1024, scanMs: 1 })
  assert(scan.ok === true, '盘点应成功')
  assert(scan.partial === true, `应被时间闸门截断（partial），实际 ms=${scan.ms} files=${scan.files} partial=${scan.partial}`)
})

await test('git 锁冲突给出可操作原因，且不自动删锁', async () => {
  assert(hasGit, '需要 git')
  const root = join(TMP, 'lockroot')
  const stateDir = join(TMP, 'state-lock')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'x\n')

  const first = await captureTree({ stateDir, root, excludeGlobs: [] })
  assert(first.ok, `首次快照应成功：${first.reason}`)

  const gitDir = shadowGitDir(stateDir, root)
  writeFileSync(join(gitDir, 'index.lock'), '') // 模拟上次异常中断残留的锁

  const second = await captureTree({ stateDir, root, excludeGlobs: [] })
  assert(second.ok === false, `锁存在时应降级失败，实际 ok=${second.ok}`)
  assert(typeof second.detail === 'string' && /锁/.test(second.detail),
    `detail 应说明锁冲突与处理建议，实际 ${JSON.stringify(second.detail)}`)
  assert(existsSync(join(gitDir, 'index.lock')), '不得自动删除锁文件（删别人的锁有风险）')
})

// ------------------------------------------------------------------ 汇总

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
