#!/usr/bin/env node
/**
 * test/boundary.mjs —— 边界与归属层自测（阶段 B / B2）
 *
 * 覆盖契约 §10.5、§10.6 的判定语义：
 *   - blob oid 的纯 node 计算与 git 自身逐字一致（否则一致性参照全错）；
 *   - ref 名转写与边界三档退化（step → 最小 step → 轮级）；
 *   - 归属路径集合 P 的"边界之后"口径与 lastTo 参照；
 *   - 计划动作 restore / trash / skip 的判定顺序，以及 force 的效果；
 *   - 越界路径与"读不出来"一律 skip（fail-closed）；
 *   - 生成计划**只读**：账本字节不变。
 *
 * 全部使用系统临时目录；退出码 0 全通过，1 有失败。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEntry, readAllEntries } from '../lib/ledger.js'
import {
  BOUNDARY_KIND,
  BOUNDARY_PHASE,
  BOUNDARY_REASON,
  PLAN_ACTION,
  TURN_LEVEL_STEP,
  boundaryRefName,
  captureBoundary,
  collectAttributionPaths,
  gitBlobOid,
  planBoundaryRollback,
  recordAttribution,
  renderBoundaryPlan,
  resolveBoundary,
  sessionKeyOf,
} from '../lib/boundary.js'
import { cleanGitEnv, shadowGitDir } from '../lib/snapshot.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-boundary-test-'))
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
const SESSION = 'session-boundary/测试:1'

function write(relPath, content) {
  const full = join(ROOT, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

const hasGit = spawnSync('git', ['--version'], { env: cleanGitEnv(), encoding: 'utf8' }).status === 0
if (!hasGit) console.log('[WARN] 本机 git 不可用，跳过需要快照的用例')

// ------------------------------------------------------- 纯函数

await test('gitBlobOid 与 git hash-object 逐字一致', async () => {
  assert(hasGit, '需要 git')
  const samples = [Buffer.from('v1\n'), Buffer.from('A\r\nB\r\n'), Buffer.from('')]
  for (const sample of samples) {
    const mine = gitBlobOid(sample)
    const theirs = spawnSync('git', ['hash-object', '--stdin'], { input: sample, env: cleanGitEnv(), encoding: 'utf8' }).stdout.trim()
    assert(mine === theirs, `blob oid 不一致：mine=${mine} git=${theirs}`)
  }
})

await test('ref 名转写安全且形状固定', async () => {
  const key = sessionKeyOf(SESSION)
  assert(!/[^A-Za-z0-9._-]/.test(key), `sessionKey 含非法字符：${key}`)
  assert(boundaryRefName(SESSION, 3, 2, BOUNDARY_PHASE.START) === `refs/dsh/${key}/t3s2-start`,
    `ref 名不符：${boundaryRefName(SESSION, 3, 2, BOUNDARY_PHASE.START)}`)
  assert(boundaryRefName(SESSION, 3, -1, 'end').endsWith('t3s-1-end'), '轮级 end ref 名不符')
})

await test('三档退化：精确 step → 最小 step → 轮级', async () => {
  const entries = [
    { kind: BOUNDARY_KIND.SNAPSHOT, session: SESSION, turn: 7, step: 2, phase: 'start', tree: 'a'.repeat(40) },
    { kind: BOUNDARY_KIND.SNAPSHOT, session: SESSION, turn: 7, step: 4, phase: 'start', tree: 'b'.repeat(40) },
  ]
  const exact = resolveBoundary(entries, { session: SESSION, turn: 7, step: 4 })
  assert(exact.tree === 'b'.repeat(40) && exact.source === 'step-start', '精确 step 应命中')
  const smallest = resolveBoundary(entries, { session: SESSION, turn: 7 })
  assert(smallest.tree === 'a'.repeat(40), '未给 step 时应取最小 step')
  const fallback = resolveBoundary(entries, { session: SESSION, turn: 7, step: 99 })
  assert(fallback.tree === 'a'.repeat(40), 'step 不存在时应退化到最小 step')
  const turnLevel = resolveBoundary([
    { kind: BOUNDARY_KIND.SNAPSHOT, session: SESSION, turn: 8, step: TURN_LEVEL_STEP, phase: 'start', tree: 'c'.repeat(40) },
  ], { session: SESSION, turn: 8 })
  assert(turnLevel.source === 'turn-start', '只有轮级快照时应退化到轮级')
  assert(resolveBoundary(entries, { session: SESSION, turn: 999 }) === null, '没有快照时应返回 null')
})

await test('归属集合的"边界之后"口径与 lastTo 参照', async () => {
  const entries = [
    { kind: BOUNDARY_KIND.ATTRIBUTION, session: SESSION, turn: 1, step: 0, from: 'f'.repeat(40), to: '1'.repeat(40), paths: ['/w/a.txt'] },
    { kind: BOUNDARY_KIND.ATTRIBUTION, session: SESSION, turn: 1, step: 1, from: '1'.repeat(40), to: '2'.repeat(40), paths: ['/w/a.txt', '/w/b.txt'] },
    { kind: BOUNDARY_KIND.ATTRIBUTION, session: SESSION, turn: 2, step: 0, from: '2'.repeat(40), to: '3'.repeat(40), paths: ['/w/c.txt'] },
  ]
  const after = collectAttributionPaths(entries, { session: SESSION, turn: 1, step: 0 })
  assert(after.paths.size === 3, `边界后应归并 3 个路径，实际 ${after.paths.size}`)
  assert(after.lastTo.get('/w/a.txt') === '2'.repeat(40), 'a.txt 的参照应是最后一次归属的 to')
  const later = collectAttributionPaths(entries, { session: SESSION, turn: 1, step: 1 })
  assert(later.paths.has('/w/a.txt'), 'a.txt 仍在边界之后')
  assert(later.paths.size === 3, '从 step 1 起仍应包含 a/b/c')
  const onlyLater = collectAttributionPaths(entries, { session: SESSION, turn: 2, step: 0 })
  assert(onlyLater.paths.size === 1 && onlyLater.paths.has('/w/c.txt'), '从 turn 2 起只应剩 c.txt')
})

// ------------------------------------------------------- 集成：真快照 + 计划

let tree0 = null
let tree1 = null

await test('captureBoundary 写账本与 ref', async () => {
  assert(hasGit, '需要 git')
  write('src/keep.txt', 'v1\n')
  write('src/del.txt', 'gone\n')
  const first = await captureBoundary({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, phase: 'start' })
  assert(first.ok, `start 快照应成功：${first.reason}`)
  assert(first.ledgerOk === true, `start 边界必须写进账本：${first.ledgerError}`)
  tree0 = first.tree

  write('src/keep.txt', 'v2\n')
  write('src/new.txt', 'created\n')
  rmSync(join(ROOT, 'src', 'del.txt'), { force: true })

  const second = await captureBoundary({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, phase: 'end' })
  assert(second.ok, `end 快照应成功：${second.reason}`)
  tree1 = second.tree
  assert(tree0 !== tree1, 'start 与 end 的 tree 应不同')

  const attributed = await recordAttribution({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, from: tree0, to: tree1 })
  assert(attributed.ok, `归属应成功：${attributed.reason}`)
  assert(attributed.paths.length === 3, `应归属 3 个路径，实际 ${JSON.stringify(attributed.paths)}`)
  for (const p of attributed.paths) assert(p.startsWith(ROOT), `归属路径应为绝对路径：${p}`)

  const entries = readAllEntries(STATE)
  assert(entries.some((e) => e.kind === BOUNDARY_KIND.SNAPSHOT), '账本应含 snapshot 条目')
  assert(entries.some((e) => e.kind === BOUNDARY_KIND.ATTRIBUTION), '账本应含 attribution 条目')
  const treeExists = spawnSync('git', ['--git-dir=' + shadowGitDir(STATE, ROOT), 'cat-file', '-t', tree1], { env: cleanGitEnv(), encoding: 'utf8' })
  assert(treeExists.status === 0 && treeExists.stdout.trim() === 'tree', 'tree 对象应存在于影子库')
})

await test('计划：修改→restore、新建→trash、删除→restore', async () => {
  assert(hasGit, '需要 git')
  const plan = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0 })
  assert(plan.ok, `计划应成功：${plan.reason}`)
  assert(plan.counted.restore === 2, `应有 2 个 restore，实际 ${plan.counted.restore}：${JSON.stringify(plan.actions)}`)
  assert(plan.counted.trash === 1, `应有 1 个 trash，实际 ${plan.counted.trash}`)
  assert(plan.counted.skip === 0, `不应有 skip，实际 ${JSON.stringify(plan.actions.filter((a) => a.action === 'skip'))}`)

  const keep = plan.actions.find((a) => a.path.endsWith('keep.txt'))
  assert(keep.action === PLAN_ACTION.RESTORE, 'keep.txt 应恢复')
  assert(keep.from === gitBlobOid(Buffer.from('v1\n')), 'keep.txt 的 from 应是边界处版本 v1')
  const created = plan.actions.find((a) => a.path.endsWith('new.txt'))
  assert(created.action === PLAN_ACTION.TRASH, 'new.txt 应被移除')
  const deleted = plan.actions.find((a) => a.path.endsWith('del.txt'))
  assert(deleted.action === PLAN_ACTION.RESTORE, 'del.txt 应被恢复')
})

await test('边界后被改动 → 默认 skip，force 才继续', async () => {
  assert(hasGit, '需要 git')
  write('src/keep.txt', 'v3-manual\n')
  const normal = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0 })
  const skipped = normal.actions.find((a) => a.path.endsWith('keep.txt'))
  assert(skipped.action === PLAN_ACTION.SKIP, `默认应 skip，实际 ${skipped.action}`)
  assert(/边界后被改动/.test(skipped.reason), `原因应写明"边界后被改动"，实际 ${skipped.reason}`)

  const forced = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, force: true })
  const restored = forced.actions.find((a) => a.path.endsWith('keep.txt'))
  assert(restored.action === PLAN_ACTION.RESTORE && restored.from === gitBlobOid(Buffer.from('v1\n')),
    'force 后应恢复为边界版本')
})

await test('越出被审计根的归属路径一律 skip', async () => {
  assert(hasGit, '需要 git')
  const outside = join(TMP, 'outside.txt')
  writeFileSync(outside, 'outside\n')
  appendEntry(STATE, {
    kind: BOUNDARY_KIND.ATTRIBUTION, session: SESSION, turn: 1, step: 0,
    from: tree1, to: tree1, paths: [outside], degraded: false, reason: null,
  })
  const plan = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, force: true })
  const entry = plan.actions.find((a) => a.path === outside)
  assert(entry !== undefined && entry.action === PLAN_ACTION.SKIP, '越界路径应出现在计划里且为 skip')
  assert(/越出被审计根/.test(entry.reason), `原因应为越界，实际 ${entry.reason}`)
})

await test('边界缺失时明确失败而不是给空计划', async () => {
  const plan = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 99 })
  assert(plan.ok === false && plan.reason === BOUNDARY_REASON.BOUNDARY_MISSING,
    `应报 BOUNDARY_MISSING，实际 ${plan.reason}`)
  assert(plan.actions.length === 0, '失败计划不应含动作')
})

await test('生成计划是只读的：账本字节不变', async () => {
  assert(hasGit, '需要 git')
  const ledgerFile = join(STATE, 'ledger', new Date().toISOString().slice(0, 10) + '.jsonl')
  const before = readFileSync(ledgerFile)
  await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0 })
  const after = readFileSync(ledgerFile)
  assert(Buffer.compare(before, after) === 0, '生成计划不得写账本')
})

await test('渲染计划为中文且含计数', async () => {
  assert(hasGit, '需要 git')
  const plan = await planBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0 })
  const text = renderBoundaryPlan(plan)
  assert(/边界：turn 1/.test(text), `渲染应含边界行：${text}`)
  assert(/归属路径：\d+ 个/.test(text), '渲染应含归属计数')
  assert(/\[restore\]|\[trash\]|\[skip\]/.test(text), '渲染应列出动作')
  assert(renderBoundaryPlan({ ok: false, reason: 'X' }).includes('无法生成回滚计划'), '失败计划应有中文说明')
})

await test('旧读取口径能跳过新 kind（向后兼容）', async () => {
  const entries = readAllEntries(STATE)
  const kinds = new Set(entries.map((e) => e.kind))
  assert(kinds.has(BOUNDARY_KIND.SNAPSHOT) && kinds.has(BOUNDARY_KIND.ATTRIBUTION), '新 kind 应可读')
  assert(entries.every((e) => typeof e.v === 'number' && typeof e.ts === 'string'), '所有条目都应带 v/ts')
})

// ------------------------------------------------------- 汇总

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
