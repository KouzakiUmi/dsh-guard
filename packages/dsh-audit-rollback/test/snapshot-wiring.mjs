#!/usr/bin/env node
/**
 * test/snapshot-wiring.mjs —— 阶段 B 接线回归（B2b）
 *
 * 覆盖：
 *   1. **红线**：`gitSnapshot` 为 false（默认）时，step/turn 事件**不产生**任何 `snapshot`/`attribution`
 *      条目，也不建影子库——即接线对阶段 A 行为零影响；
 *   2. `per-step` 模式：`step/start` + 改动 + `step/end` 之后账本出现成对边界与归属；
 *   3. `per-turn` 模式：只在轮边界落快照（`step === -1`）；
 *   4. 串行队列：连续两次 step 的快照条目顺序必须是 start0 → end0 → start1 → end1；
 *   5. 快照失败只 warn，不影响事件处理本身。
 *
 * 全部使用系统临时目录；退出码 0 全通过，1 有失败。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, queryAuditStatus } from '../lib/index.js'
import { readAllEntries } from '../lib/ledger.js'
import { cleanGitEnv, shadowGitDir } from '../lib/snapshot.js'
import { spawnSync } from 'node:child_process'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-wiring-test-'))
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

const hasGit = spawnSync('git', ['--version'], { env: cleanGitEnv(), encoding: 'utf8' }).status === 0

/** 最小 Cordis 桩：只实现 apply 用到的 on / effect / inject / logger / get。 */
function makeCtx() {
  const handlers = []
  const cleanups = []
  const warns = []
  const ctx = {
    logger: { info() {}, warn: (message) => warns.push(String(message)) },
    on: (event, handler) => {
      handlers.push({ event, handler })
      return () => {}
    },
    effect: (fn) => { cleanups.push(fn()) },
    inject: () => {},
    get: () => undefined,
    config: {},
  }
  return {
    ctx,
    warns,
    fire(event, session, data) {
      for (const entry of handlers) if (entry.event === 'session/event') entry.handler(session, { type: event, data })
    },
    async cleanup() {
      await Promise.all(cleanups.map((fn) => fn()))
    },
  }
}

async function waitFor(predicate, { timeoutMs = 10000, stepMs = 25 } = {}) {
  const started = Date.now()
  for (;;) {
    if (predicate() === true) return true
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

function kinds(stateDir) {
  return readAllEntries(stateDir).map((entry) => entry.kind)
}

function workRoot(name, files = {}) {
  const root = join(TMP, name)
  mkdirSync(root, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

// ------------------------------------------------------------------ 用例

await test('红线：gitSnapshot=false 时不产生任何阶段 B 条目，也不建影子库', async () => {
  const root = workRoot('off-work', { 'a.txt': 'v1\n' })
  const stateDir = join(TMP, 'off-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir })

  const session = { id: 'session-off', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  writeFileSync(join(root, 'a.txt'), 'v2\n')
  harness.fire('step/end', session, { turn: 1, step: 0 })
  harness.fire('turn/end', session, { turn: 1 })

  await waitFor(() => kinds(stateDir).includes('turn/end'))
  const seen = kinds(stateDir)
  assert(seen.includes('turn/start') && seen.includes('turn/end'), `阶段 A 条目应照常写入：${JSON.stringify(seen)}`)
  assert(!seen.includes('snapshot'), `gitSnapshot=false 时不得写 snapshot 条目：${JSON.stringify(seen)}`)
  assert(!seen.includes('attribution'), `gitSnapshot=false 时不得写 attribution 条目：${JSON.stringify(seen)}`)
  assert(!existsSync(shadowGitDir(stateDir, root)), 'gitSnapshot=false 时不得创建影子库')
  await harness.cleanup()
})

await test('per-step：step 边界落成对快照并写归属', async () => {
  assert(hasGit, '需要 git')
  const root = workRoot('step-work', { 'src/a.txt': 'v1\n' })
  const stateDir = join(TMP, 'step-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-step', snapshotExcludeGlobs: [] })

  const session = { id: 'session-step', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'snapshot' && e.phase === 'start'))
  writeFileSync(join(root, 'src', 'a.txt'), 'v2\n')
  writeFileSync(join(root, 'src', 'new.txt'), 'created\n')
  harness.fire('step/end', session, { turn: 1, step: 0 })

  const ok = await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'attribution'))
  assert(ok, '应在 step/end 后写入 attribution 条目')

  const entries = readAllEntries(stateDir)
  const snapshots = entries.filter((e) => e.kind === 'snapshot')
  assert(snapshots.length >= 2, `应有 start/end 两条快照：${JSON.stringify(snapshots.map((s) => s.phase))}`)
  assert(snapshots.every((s) => s.step === 0), 'per-step 模式的快照 step 应为事件里的 step')
  const attribution = entries.find((e) => e.kind === 'attribution')
  const names = (attribution.paths ?? []).map((p) => p.split(/[/\\]/).pop()).sort()
  assert(names.includes('a.txt') && names.includes('new.txt'), `归属应含改动文件：${JSON.stringify(names)}`)
  await harness.cleanup()
})

await test('per-turn：只在轮边界落快照（step === -1）', async () => {
  assert(hasGit, '需要 git')
  const root = workRoot('turn-work', { 'src/b.txt': 'v1\n' })
  const stateDir = join(TMP, 'turn-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-turn', snapshotExcludeGlobs: [] })

  const session = { id: 'session-turn', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 2 })
  assert(await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'snapshot' && e.phase === 'start')),
    '必须先完成轮开始快照，再模拟工具改动与 turn/end')
  harness.fire('step/start', session, { turn: 2, step: 0 }) // per-turn 下必须被忽略
  writeFileSync(join(root, 'src', 'b.txt'), 'v2\n')
  harness.fire('step/end', session, { turn: 2, step: 0 })   // per-turn 下必须被忽略
  harness.fire('turn/end', session, { turn: 2 })

  const ok = await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'attribution'))
  assert(ok, '应在 turn/end 后写入 attribution')
  const entries = readAllEntries(stateDir)
  const snapshots = entries.filter((e) => e.kind === 'snapshot')
  assert(snapshots.length >= 2, `应有 start/end 两条快照：${snapshots.length}`)
  assert(snapshots.every((s) => s.step === -1), `per-turn 的 step 必须为 -1：${JSON.stringify(snapshots.map((s) => s.step))}`)
  assert(!snapshots.some((s) => s.step === 0), 'per-turn 模式不得跟着 step 事件落快照')
  await harness.cleanup()
})

await test('串行队列：连续两步的快照顺序为 start0 → end0 → start1 → end1', async () => {
  assert(hasGit, '需要 git')
  const root = workRoot('queue-work', { 'q.txt': 'v1\n' })
  const stateDir = join(TMP, 'queue-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-step', snapshotExcludeGlobs: [] })

  const session = { id: 'session-queue', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  writeFileSync(join(root, 'q.txt'), 'v2\n')
  harness.fire('step/end', session, { turn: 1, step: 0 })
  harness.fire('step/start', session, { turn: 1, step: 1 })
  writeFileSync(join(root, 'q.txt'), 'v3\n')
  harness.fire('step/end', session, { turn: 1, step: 1 })

  const ok = await waitFor(() => readAllEntries(stateDir).filter((e) => e.kind === 'snapshot').length >= 4)
  assert(ok, '应有 4 条快照条目')
  const order = readAllEntries(stateDir)
    .filter((e) => e.kind === 'snapshot')
    .map((e) => `${e.phase}${e.step}`)
  assert(order.slice(0, 4).join(',') === 'start0,end0,start1,end1',
    `快照顺序错误：${JSON.stringify(order)}`)
  await harness.cleanup()
})

await test('快照失败只 warn：事件处理本身不抛', async () => {
  assert(hasGit, '需要 git')
  // 用一个不存在的 cwd？cwd 存在但预算极小 → 快照必然降级，而事件仍应被处理
  const root = workRoot('fail-work', { 'f.txt': 'x\n' })
  const stateDir = join(TMP, 'fail-state')
  const harness = makeCtx()
  apply(harness.ctx, {
    stateDir,
    gitSnapshot: true,
    snapshotMode: 'per-step',
    snapshotExcludeGlobs: [],
    snapshotMaxFiles: 1,
    snapshotMaxBytes: 1,
  })

  const session = { id: 'session-fail', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  harness.fire('step/end', session, { turn: 1, step: 0 })

  const ok = await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'snapshot' && e.degraded === true))
  assert(ok, '降级时应写入 degraded=true 的 snapshot 条目')
  const attribution = readAllEntries(stateDir).filter((e) => e.kind === 'attribution')
  assert(attribution.length === 0, 'start 降级时不得写归属（否则会把整棵树当成新增）')
  assert(harness.warns.some((line) => line.includes('边界快照')), `应有 warn 记录：${JSON.stringify(harness.warns)}`)
  await harness.cleanup()
})

// -------------------------------------------- 2026-10-11 独立复核缺陷回归（4 条）

await test('乱序 step 事件：end 必须配到**自己的** (turn, step)，不得错配', async () => {
  assert(hasGit, '需要 git')
  const root = workRoot('interleave-work', { 'i.txt': 'v1\n' })
  const stateDir = join(TMP, 'interleave-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-step', snapshotExcludeGlobs: [] })

  const session = { id: 'session-interleave', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'snapshot' && e.step === 0))
  writeFileSync(join(root, 'i.txt'), 'v2\n')
  harness.fire('step/start', session, { turn: 1, step: 1 }) // 乱序：第二个 start 先到 end(0)
  await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'snapshot' && e.step === 1))
  writeFileSync(join(root, 'i.txt'), 'v3\n')
  harness.fire('step/end', session, { turn: 1, step: 0 })
  writeFileSync(join(root, 'i.txt'), 'v4\n')
  harness.fire('step/end', session, { turn: 1, step: 1 })

  const ok = await waitFor(() => readAllEntries(stateDir).filter((e) => e.kind === 'attribution').length >= 2)
  assert(ok, '两条边界都应各自产出归属（不得丢条目）')
  const entries = readAllEntries(stateDir)
  const starts = new Map()
  for (const entry of entries) {
    if (entry.kind === 'snapshot' && entry.phase === 'start' && typeof entry.tree === 'string') starts.set(entry.step, entry.tree)
  }
  for (const attribution of entries.filter((e) => e.kind === 'attribution')) {
    const expectedFrom = starts.get(attribution.step)
    assert(expectedFrom !== undefined, `归属 step=${attribution.step} 应有对应的 start 快照`)
    assert(attribution.from === expectedFrom,
      `归属的 from 必须来自**同一 step** 的 start（step=${attribution.step}）：${attribution.from} ≠ ${expectedFrom}`)
  }
  await harness.cleanup()
})

await test('跨轮残留：不匹配的 start 不得被后续 end 复用', async () => {
  assert(hasGit, '需要 git')
  const root = workRoot('residual-work', { 'r.txt': 'v1\n' })
  const stateDir = join(TMP, 'residual-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-step', snapshotExcludeGlobs: [] })

  const session = { id: 'session-residual', header: { cwd: root } }
  // 轮 1：只有 start（模拟中断），不发 turn/end 也不发 step/end
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'snapshot' && e.turn === 1))
  // 轮 2：只有 end（模拟中途加载后收到孤立 end）
  harness.fire('turn/start', session, { turn: 2 })
  harness.fire('step/end', session, { turn: 2, step: 0 })
  harness.fire('turn/end', session, { turn: 2 })

  await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'turn/end' && e.turn === 2))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const attributions = readAllEntries(stateDir).filter((e) => e.kind === 'attribution')
  assert(attributions.length === 0,
    `不匹配的 start 不得被复用：${JSON.stringify(attributions.map((a) => ({ turn: a.turn, step: a.step, from: a.from })))}`)
  await harness.cleanup()
})

await test('环境性失败熔断：不重复重试、不重复告警，且写一条 note', async () => {
  assert(hasGit, '需要 git')
  const notADir = join(TMP, 'cwd-is-a-file.txt')
  writeFileSync(notADir, 'x\n')
  const stateDir = join(TMP, 'fuse-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-step', snapshotExcludeGlobs: [] })

  // cwd 指向一个文件 → 快照必然 SCAN_UNREADABLE（环境性）
  const session = { id: 'session-fuse', header: { cwd: notADir } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'snapshot'))
  harness.fire('step/start', session, { turn: 1, step: 1 })
  harness.fire('step/start', session, { turn: 1, step: 2 })
  harness.fire('turn/end', session, { turn: 1 })

  await new Promise((resolve) => setTimeout(resolve, 300))
  const entries = readAllEntries(stateDir)
  const snapshots = entries.filter((e) => e.kind === 'snapshot')
  assert(snapshots.length === 1, `熔断后不应继续尝试快照，实际 ${snapshots.length} 条`)
  assert(snapshots[0].degraded === true && snapshots[0].reason === 'SCAN_UNREADABLE',
    `失败原因应为 SCAN_UNREADABLE：${JSON.stringify(snapshots[0])}`)
  assert(entries.some((e) => e.kind === 'note' && /熔断/.test(e.text ?? '')),
    `应写一条熔断 note：${JSON.stringify(entries.filter((e) => e.kind === 'note'))}`)
  const status = queryAuditStatus(harness.ctx)
  assert.equal(status.shadow.fused, 'SCAN_UNREADABLE', `status.shadow.fused 应反映熔断原因：${status.shadow.fused}`)
  await harness.cleanup()
})

await test('自动排除必须记账并在 status 可见', async () => {
  assert(hasGit, '需要 git')
  const root = workRoot('autoexclude-work', { 'keep.txt': 'small\n' })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'big.bin'), Buffer.alloc(4096, 7))
  const stateDir = join(TMP, 'autoexclude-state')
  const harness = makeCtx()
  apply(harness.ctx, {
    stateDir,
    gitSnapshot: true,
    snapshotMode: 'per-step',
    snapshotExcludeGlobs: [],
    snapshotMaxFiles: 2,
    snapshotMaxBytes: 100,
    snapshotAutoExcludeOversized: true,
  })

  const session = { id: 'session-autoexclude', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })

  const ok = await waitFor(() => readAllEntries(stateDir).some((e) => e.kind === 'note' && /自动排除/.test(e.text ?? '')))
  assert(ok, `自动排除必须写 note：${JSON.stringify(readAllEntries(stateDir).filter((e) => e.kind === 'note'))}`)
  const snapshot = readAllEntries(stateDir).find((e) => e.kind === 'snapshot')
  assert(Array.isArray(snapshot.autoExcluded) && snapshot.autoExcluded.includes('/src/'),
    `snapshot 条目应记录被排除的顶层项：${JSON.stringify(snapshot.autoExcluded)}`)
  const status = queryAuditStatus(harness.ctx)
  assert(Array.isArray(status.shadow.autoExcluded) && status.shadow.autoExcluded.includes('/src/'),
    `status.shadow.autoExcluded 应可见：${JSON.stringify(status.shadow.autoExcluded)}`)
  await harness.cleanup()
})

await test('插件卸载：尚未启动的快照队列不得在 dispose 后建库或落账', async () => {
  const root = workRoot('dispose-work', { 'a.txt': 'v1\n' })
  const stateDir = join(TMP, 'dispose-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-step' })
  const session = { id: 'session-dispose', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  harness.fire('step/start', session, { turn: 1, step: 0 })
  harness.fire('step/end', session, { turn: 1, step: 0 })
  await harness.cleanup()
  assert(!existsSync(shadowGitDir(stateDir, root)), '卸载后不得再启动 Git 建库')
  assert(!kinds(stateDir).includes('snapshot'), '卸载后排队任务不得写入快照')
})

await test('环境失败：失败前已经排队的边界也必须遵守熔断', async () => {
  const parent = workRoot('fuse-queued-work', { 'file.txt': 'not a directory' })
  const root = join(parent, 'file.txt')
  const stateDir = join(TMP, 'fuse-queued-state')
  const harness = makeCtx()
  apply(harness.ctx, { stateDir, gitSnapshot: true, snapshotMode: 'per-step' })
  const session = { id: 'session-fuse-queued', header: { cwd: root } }
  harness.fire('turn/start', session, { turn: 1 })
  for (let step = 0; step < 3; step += 1) {
    harness.fire('step/start', session, { turn: 1, step })
    harness.fire('step/end', session, { turn: 1, step })
  }
  assert(await waitFor(() => queryAuditStatus(harness.ctx).shadow.fused === 'SCAN_UNREADABLE'))
  await harness.cleanup()
  assert.equal(readAllEntries(stateDir).filter((e) => e.kind === 'snapshot').length, 1,
    '只尝试首次失败边界，不重试已排队的后续任务')
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
