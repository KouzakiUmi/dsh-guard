#!/usr/bin/env node
/**
 * 离线自测（纯 node，不依赖 Cordis / DSH）。
 *
 * 覆盖契约第 8.2 条的断言（每条输出里都有可辨认的名字）：
 *   1. CAS 去重（含防回归：不得重写已存在对象，变异 M9 会在此变红）
 *   2. before 只记第一条
 *   3. 恢复已存在文件
 *   4. 新建文件回滚
 *   5. 轮后被改动（默认 skip / --force 成功）
 *   6. 账本 append-only
 *   7. trash 卷标识保留盘符 + 禁止覆盖（契约第 3 节，2026-10-04 修正 F1）
 *   8. 读取失败不记 existed:false（修正 F4：目录被捕获时抛错而非记账）
 *   9. undo 旧轮对「后续轮另有捕获」的路径必须 skip（修正 F2）
 *  10. CLI 级：--apply --force 覆盖被 skip 的文件（防回归变异 M7：拆 --force 接线会在此变红）
 *  11. CLI 级：--state 指向不存在目录退出码 1
 *  12. 同一 trash 目录内目标已存在时第二次备份落到 -1（防 uniqueTrashPath 失效）
 *  13. CLI：当前文件等于后轮 after 时 undo 旧轮必须 exit 2（防参照退回全账本最后一条）
 *
 * 临时数据放在包内 test/.tmp/ 下，结束时清理（契约第 9 节：不写 ~/.dsh）。
 * 退出码 0 = 全部通过。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendEntry,
  capturePath,
  createTurnState,
  executePlan,
  initState,
  objectPath,
  planRollback,
  probeFile,
  putObject,
  readAllEntries,
  recordRollback,
  trashRelativePath,
  uniqueTrashPath,
} from '../lib/ledger.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const tmpRoot = join(testDir, '.tmp')
const stateDir = join(tmpRoot, 'state')
const workDir = join(tmpRoot, 'work')
const cliPath = join(testDir, '..', 'scripts', 'audit-rollback.mjs')

let passed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`通过  ${name}`)
  } catch (error) {
    console.error(`失败  ${name}`)
    console.error(error)
    cleanup()
    process.exit(1)
  }
}

function cleanup() {
  rmSync(tmpRoot, { recursive: true, force: true })
}

/** 列出 CAS 里全部对象文件（objects/<前2位>/<sha1>）。 */
function listObjects() {
  const root = join(stateDir, 'objects')
  if (!existsSync(root)) return []
  const files = []
  for (const sub of readdirSync(root)) {
    for (const name of readdirSync(join(root, sub))) files.push(join(sub, name))
  }
  return files
}

/** 当前全部账本文件的「路径 → 字节」快照（append-only 断言用）。 */
function snapshotLedger() {
  const dir = join(stateDir, 'ledger')
  const snap = new Map()
  if (!existsSync(dir)) return snap
  for (const name of readdirSync(dir)) {
    snap.set(name, readFileSync(join(dir, name), 'utf8'))
  }
  return snap
}

// ---------- 场景搭建 ----------
cleanup()
mkdirSync(workDir, { recursive: true })
initState(stateDir)

const SESSION = 'selftest-session'
const fileA = join(workDir, 'a.txt') // 已存在，将被编辑
const fileB = join(workDir, 'b.txt') // 不存在，将被新建
writeFileSync(fileA, 'v1-原始内容')

// ---------- 1. CAS 去重 ----------
ok('CAS 去重：同一内容两次 putObject 只产生一个对象文件，且绝不重写已存在对象', () => {
  const buf = Buffer.from('dedup-去重探针')
  const h1 = putObject(stateDir, buf)
  const h2 = putObject(stateDir, buf)
  assert.equal(h1, h2)
  assert.equal(listObjects().length, 1)
  const file = objectPath(stateDir, h1)
  assert.ok(existsSync(file))
  // 防回归（变异 M9：去掉 existsSync 守卫仍能全绿）：
  // 把对象文件改写成哨兵内容，再次 putObject 同一内容——守卫在则哨兵保持，
  // 守卫被拆掉则对象会被重写回原内容，本断言变红。
  writeFileSync(file, '哨兵-请勿覆盖')
  const h3 = putObject(stateDir, buf)
  assert.equal(h3, h1)
  assert.equal(readFileSync(file, 'utf8'), '哨兵-请勿覆盖', 'putObject 不得重写已存在对象')
})

// ---------- 模拟第 1 轮：before → 编辑 → after ----------
const turn1 = createTurnState()
appendEntry(stateDir, { kind: 'turn/start', session: SESSION, turn: 1, cwd: workDir })
const before1 = capturePath(stateDir, {
  session: SESSION, turn: 1, path: fileA, phase: 'before', maxBytes: 1048576, turnState: turn1,
})
const dup = capturePath(stateDir, {
  session: SESSION, turn: 1, path: fileA, phase: 'before', maxBytes: 1048576, turnState: turn1,
})
const beforeB = capturePath(stateDir, {
  session: SESSION, turn: 1, path: fileB, phase: 'before', maxBytes: 1048576, turnState: turn1,
})
// 模拟工具真实落盘：a.txt 被改写，b.txt 被新建
writeFileSync(fileA, 'v2-编辑后内容')
writeFileSync(fileB, '新建文件内容')
capturePath(stateDir, { session: SESSION, turn: 1, path: fileA, phase: 'after', maxBytes: 1048576, turnState: turn1 })
capturePath(stateDir, { session: SESSION, turn: 1, path: fileB, phase: 'after', maxBytes: 1048576, turnState: turn1 })
appendEntry(stateDir, { kind: 'turn/end', session: SESSION, turn: 1, captured: turn1.capturedPaths.size })

// ---------- 2. before 只记第一条 ----------
ok('before 只记第一条：同轮同路径两次捕获，账本里 before 只有一条', () => {
  assert.ok(before1 !== null)
  assert.equal(dup, null)
  assert.equal(beforeB.existed, false)
  assert.equal(beforeB.hash, null)
  const befores = readAllEntries(stateDir).filter(
    (e) => e.kind === 'capture' && e.session === SESSION && e.turn === 1 && e.phase === 'before' && e.path === fileA,
  )
  assert.equal(befores.length, 1)
})

// ---------- 回滚前快照（断言 6 用） ----------
const ledgerBefore = snapshotLedger()

// ---------- 计划 + 执行第 1 轮回滚 ----------
const plan1 = planRollback(stateDir, SESSION, 1)
assert.equal(plan1.actions.length, 2)
executePlan(stateDir, plan1.actions)
recordRollback(stateDir, SESSION, 1, true, plan1.actions)

// ---------- 3. 恢复已存在文件 ----------
ok('恢复已存在文件：undo --apply 后文件字节等于 before 内容', () => {
  const restoreA = plan1.actions.find((a) => a.path === fileA)
  assert.equal(restoreA.action, 'restore')
  assert.equal(readFileSync(fileA, 'utf8'), 'v1-原始内容')
})

// ---------- 4. 新建文件回滚 ----------
ok('新建文件回滚：文件被移入 trash，原路径消失', () => {
  const trashB = plan1.actions.find((a) => a.path === fileB)
  assert.equal(trashB.action, 'trash')
  assert.equal(existsSync(fileB), false)
  const trashRoot = join(stateDir, 'trash')
  assert.ok(existsSync(trashRoot), 'trash/ 目录应存在')
  // trash/<时间戳>/<卷标识>/… 下应能找到 b.txt 的原件
  const stamp = readdirSync(trashRoot)[0]
  let found = false
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name)
      if (name.isDirectory()) walk(full)
      else if (name.name === 'b.txt') {
        found = true
        assert.equal(readFileSync(full, 'utf8'), '新建文件内容')
      }
    }
  }
  walk(join(trashRoot, stamp))
  assert.ok(found, 'trash 里应存在被移走的 b.txt')
})

// ---------- 5. 轮后被改动（默认 skip / --force 成功） ----------
ok('轮后被改动：默认 skip，--force 后恢复成功', () => {
  const fileC = join(workDir, 'c.txt')
  writeFileSync(fileC, 'c1-原始内容')
  const turn2 = createTurnState()
  appendEntry(stateDir, { kind: 'turn/start', session: SESSION, turn: 2, cwd: workDir })
  capturePath(stateDir, { session: SESSION, turn: 2, path: fileC, phase: 'before', maxBytes: 1048576, turnState: turn2 })
  writeFileSync(fileC, 'c2-轮内编辑')
  capturePath(stateDir, { session: SESSION, turn: 2, path: fileC, phase: 'after', maxBytes: 1048576, turnState: turn2 })
  appendEntry(stateDir, { kind: 'turn/end', session: SESSION, turn: 2, captured: turn2.capturedPaths.size })
  // 轮后又被（例如 shell 或人工）改成 c3
  writeFileSync(fileC, 'c3-轮后改动')

  // 默认：当前内容与会话第 2 轮的 after（c2）不一致 → skip
  const planSkip = planRollback(stateDir, SESSION, 2)
  assert.equal(planSkip.actions[0].action, 'skip')
  assert.equal(planSkip.actions[0].reason, '轮后已被改动')
  assert.equal(readFileSync(fileC, 'utf8'), 'c3-轮后改动', 'dry-run/skip 不得触碰文件')

  // --force：照常恢复成 before（c1）
  const planForce = planRollback(stateDir, SESSION, 2, { force: true })
  assert.equal(planForce.actions[0].action, 'restore')
  executePlan(stateDir, planForce.actions)
  recordRollback(stateDir, SESSION, 2, true, planForce.actions)
  assert.equal(readFileSync(fileC, 'utf8'), 'c1-原始内容')
})

// ---------- 6. 账本 append-only ----------
ok('账本 append-only：回滚前后已有行字节不变（只追加）', () => {
  const after = snapshotLedger()
  for (const [name, beforeText] of ledgerBefore) {
    const afterText = after.get(name)
    assert.ok(afterText !== undefined, `账本文件 ${name} 不应消失`)
    assert.ok(afterText.startsWith(beforeText), `账本文件 ${name} 的已有内容被改写`)
    assert.ok(afterText.length > beforeText.length, `账本文件 ${name} 应有追加（rollback 条目）`)
  }
})

// ---------- 7. trash 卷标识保留盘符 + 禁止覆盖（契约第 3 节修正 F1） ----------
ok('trash 卷标识：Windows 保留盘符字母目录，目标已存在时追加序号绝不覆盖', () => {
  const relC = trashRelativePath('C:\\proj\\same\\file.txt')
  const relD = trashRelativePath('D:\\proj\\same\\file.txt')
  assert.equal(relC.split(sep)[0], 'C', 'C 盘路径的第一段必须是盘符字母 C')
  assert.equal(relD.split(sep)[0], 'D', 'D 盘路径的第一段必须是盘符字母 D')
  assert.notEqual(relC, relD, '跨盘同后缀路径在 trash 内必须映射到不同位置')

  // 同一路径两次进 trash：第二次必须拿 -1 序号，第一次的备份不得被覆盖
  const victim = join(workDir, 'collision.txt')
  writeFileSync(victim, '第一次备份的内容')
  const actions = [{ path: victim, action: 'trash', from: null }]
  executePlan(stateDir, actions)
  writeFileSync(victim, '第二次备份的内容')
  const actions2 = [{ path: victim, action: 'trash', from: null }]
  executePlan(stateDir, actions2)
  const trashRoot = join(stateDir, 'trash')
  const found = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isDirectory()) walk(full)
      else if (item.name === 'collision.txt' || item.name.startsWith('collision.txt-')) found.push(full)
    }
  }
  walk(trashRoot)
  assert.ok(found.length >= 2, `trash 里应有该文件的两份独立备份，实际找到 ${found.length} 份`)
  const contents = new Set(found.map((f) => readFileSync(f, 'utf8')))
  assert.ok(contents.has('第一次备份的内容'), '第一份备份的字节必须还在（不得被第二次覆盖）')
  assert.ok(contents.has('第二次备份的内容'), '第二份备份的字节必须完整')
})

// ---------- 8. 读取失败不记 existed:false（修正 F4） ----------
ok('读取失败：目录路径被捕获时抛错且不写 capture 条目（不得记成 existed:false）', () => {
  const dirPath = join(workDir, 'a-dir')
  mkdirSync(dirPath, { recursive: true })
  const probe = probeFile(dirPath)
  assert.equal(probe.existed, null, '目录读取失败必须返回 existed:null，不得返回 false')
  assert.ok(probe.error && probe.error.code, '应携带错误码')
  const turn8 = createTurnState()
  let thrown = null
  try {
    capturePath(stateDir, {
      session: SESSION, turn: 8, path: dirPath, phase: 'before', maxBytes: 1048576, turnState: turn8,
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== null, 'capturePath 对读取失败必须抛出（由插件上层 warn），不得静默记账')
  const entries = readAllEntries(stateDir).filter(
    (e) => e.kind === 'capture' && e.path === dirPath,
  )
  assert.equal(entries.length, 0, '读取失败的路径不得产生 capture 条目')
})

// ---------- 9. undo 旧轮对「后续轮另有捕获」的路径必须 skip（修正 F2） ----------
ok('undo 旧轮：该路径在后续轮次另有捕获时必须 skip，即使当前内容与该轮 after 一致', () => {
  const fileE = join(workDir, 'e.txt')
  writeFileSync(fileE, 'e1-第10轮before')
  const turn10 = createTurnState()
  appendEntry(stateDir, { kind: 'turn/start', session: SESSION, turn: 10, cwd: workDir })
  capturePath(stateDir, { session: SESSION, turn: 10, path: fileE, phase: 'before', maxBytes: 1048576, turnState: turn10 })
  writeFileSync(fileE, 'e2-第10轮after')
  capturePath(stateDir, { session: SESSION, turn: 10, path: fileE, phase: 'after', maxBytes: 1048576, turnState: turn10 })
  appendEntry(stateDir, { kind: 'turn/end', session: SESSION, turn: 10, captured: turn10.capturedPaths.size })

  // 第 11 轮又捕获并修改了同一文件（之后有人手工把内容改回与第 10 轮 after 相同）
  const turn11 = createTurnState()
  appendEntry(stateDir, { kind: 'turn/start', session: SESSION, turn: 11, cwd: workDir })
  capturePath(stateDir, { session: SESSION, turn: 11, path: fileE, phase: 'before', maxBytes: 1048576, turnState: turn11 })
  writeFileSync(fileE, 'e3-第11轮成果')
  capturePath(stateDir, { session: SESSION, turn: 11, path: fileE, phase: 'after', maxBytes: 1048576, turnState: turn11 })
  appendEntry(stateDir, { kind: 'turn/end', session: SESSION, turn: 11, captured: turn11.capturedPaths.size })
  writeFileSync(fileE, 'e2-第10轮after') // 内容恰好与第 10 轮 after 一致

  const planOld = planRollback(stateDir, SESSION, 10)
  assert.equal(planOld.actions[0].action, 'skip', '后续轮另有捕获的路径必须 skip')
  assert.ok(planOld.actions[0].reason.includes('轮后已被改动'), '原因必须点明轮后改动')
  assert.equal(readFileSync(fileE, 'utf8'), 'e2-第10轮after', 'skip 不得触碰文件')
})

// ---------- 10. CLI 级：--apply --force 覆盖被 skip 的文件（防回归变异 M7） ----------
ok('CLI 级：undo --apply 遇轮后改动退出码 2 且不动文件，--force 后退出码 0 且恢复', () => {
  const fileD = join(workDir, 'd.txt')
  writeFileSync(fileD, 'd1-原始内容')
  const turn3 = createTurnState()
  appendEntry(stateDir, { kind: 'turn/start', session: SESSION, turn: 3, cwd: workDir })
  capturePath(stateDir, { session: SESSION, turn: 3, path: fileD, phase: 'before', maxBytes: 1048576, turnState: turn3 })
  writeFileSync(fileD, 'd2-轮内编辑')
  capturePath(stateDir, { session: SESSION, turn: 3, path: fileD, phase: 'after', maxBytes: 1048576, turnState: turn3 })
  appendEntry(stateDir, { kind: 'turn/end', session: SESSION, turn: 3, captured: turn3.capturedPaths.size })
  writeFileSync(fileD, 'd3-轮后改动')

  const r1 = spawnSync(process.execPath, [cliPath, 'undo', SESSION, '3', '--state', stateDir, '--apply'], { encoding: 'utf8' })
  assert.equal(r1.status, 2, `遇轮后改动应退出码 2，实际 ${r1.status}，输出：${r1.stdout}${r1.stderr}`)
  assert.equal(readFileSync(fileD, 'utf8'), 'd3-轮后改动', 'skip 不得触碰文件')

  const r2 = spawnSync(process.execPath, [cliPath, 'undo', SESSION, '3', '--state', stateDir, '--apply', '--force'], { encoding: 'utf8' })
  assert.equal(r2.status, 0, `--force 应退出码 0，实际 ${r2.status}，输出：${r2.stdout}${r2.stderr}`)
  assert.equal(readFileSync(fileD, 'utf8'), 'd1-原始内容', '--force 必须恢复成 before 内容')
})

// ---------- 11. CLI 级：--state 指向不存在目录退出码 1 ----------
ok('CLI 级：--state 指向不存在目录退出码 1', () => {
  const r = spawnSync(process.execPath, [cliPath, 'list', '--state', join(tmpRoot, 'no-such-dir')], { encoding: 'utf8' })
  assert.equal(r.status, 1, `状态目录不可读应退出码 1，实际 ${r.status}，输出：${r.stdout}${r.stderr}`)
})

// ---------- 12. 同一 trash 目录内禁止覆盖（防 uniqueTrashPath 被拆掉仍全绿） ----------
ok('同一 trash 目录：目标已存在时第二次备份落到 -1 且不覆盖第一份字节', () => {
  const file = join(workDir, 'same-dir.txt')
  writeFileSync(file, 'FIRST-BACKUP')
  const hash = putObject(stateDir, Buffer.from('CAS-RESTORE'))
  // 同一次 executePlan 只用一个时间戳目录。第一次 restore 把 FIRST-BACKUP 备份走并写回 CAS；
  // 第二次 restore 再次备份时，该目录里的 same-dir.txt 已经存在，必须落到 same-dir.txt-1。
  // uniqueTrashPath 若恒返回原路径，第二次 copy 会盖掉 FIRST-BACKUP，本断言变红。
  executePlan(stateDir, [
    { path: file, action: 'restore', from: hash },
    { path: file, action: 'restore', from: hash },
  ])
  const exact = []
  const suffixed = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isDirectory()) walk(full)
      else if (item.name === 'same-dir.txt') exact.push(full)
      else if (item.name === 'same-dir.txt-1') suffixed.push(full)
    }
  }
  walk(join(stateDir, 'trash'))
  assert.equal(exact.length, 1, `应恰好有一份未加序号的 same-dir.txt，实际 ${exact.length}`)
  assert.equal(readFileSync(exact[0], 'utf8'), 'FIRST-BACKUP', '第一份备份不得被第二次覆盖')
  assert.equal(suffixed.length, 1, '第二次备份必须落到 same-dir.txt-1')
  assert.equal(readFileSync(suffixed[0], 'utf8'), 'CAS-RESTORE')
  assert.equal(dirname(exact[0]), dirname(suffixed[0]), '两次备份必须在同一个 trash 时间戳目录')
})

// ---------- 13. CLI：当前文件等于后轮 after 时 undo 旧轮必须默认 skip ----------
ok('CLI 级：当前文件等于后轮 after 时 undo 旧轮必须默认 skip（exit 2）', () => {
  const file = join(workDir, 'later-match.txt')
  writeFileSync(file, 'L1-before')
  const turn20 = createTurnState()
  appendEntry(stateDir, { kind: 'turn/start', session: SESSION, turn: 20, cwd: workDir })
  capturePath(stateDir, { session: SESSION, turn: 20, path: file, phase: 'before', maxBytes: 1048576, turnState: turn20 })
  writeFileSync(file, 'L1-after')
  capturePath(stateDir, { session: SESSION, turn: 20, path: file, phase: 'after', maxBytes: 1048576, turnState: turn20 })
  appendEntry(stateDir, { kind: 'turn/end', session: SESSION, turn: 20, captured: turn20.capturedPaths.size })

  const turn21 = createTurnState()
  appendEntry(stateDir, { kind: 'turn/start', session: SESSION, turn: 21, cwd: workDir })
  capturePath(stateDir, { session: SESSION, turn: 21, path: file, phase: 'before', maxBytes: 1048576, turnState: turn21 })
  writeFileSync(file, 'L2-after-后轮成果')
  capturePath(stateDir, { session: SESSION, turn: 21, path: file, phase: 'after', maxBytes: 1048576, turnState: turn21 })
  appendEntry(stateDir, { kind: 'turn/end', session: SESSION, turn: 21, captured: turn21.capturedPaths.size })
  // 当前字节就是后轮 after，也就是全账本该路径的最后一条 capture。
  // 旧口径会判「一致」并 restore（exit 0）；正确实现必须默认 skip（exit 2），文件保持后轮成果。
  assert.equal(readFileSync(file, 'utf8'), 'L2-after-后轮成果')

  const ran = spawnSync(process.execPath, [cliPath, 'undo', SESSION, '20', '--state', stateDir, '--apply'], { encoding: 'utf8' })
  assert.equal(ran.status, 2, `当前等于后轮 after 时 undo 旧轮应 exit 2，实际 ${ran.status}，输出：${ran.stdout}${ran.stderr}`)
  assert.match(ran.stdout, /skip/, '动作必须是 skip')
  assert.match(ran.stdout, /轮后已被改动/, '原因必须写明轮后已被改动')
  assert.equal(readFileSync(file, 'utf8'), 'L2-after-后轮成果', '默认 skip 不得把文件恢复成旧轮 before')
})

cleanup()
console.log(`\n全部 ${passed} 条断言通过，临时目录已清理。`)
process.exit(0)
