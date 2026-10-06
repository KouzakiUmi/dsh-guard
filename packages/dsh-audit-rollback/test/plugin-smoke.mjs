#!/usr/bin/env node
/**
 * 插件可加载性冒烟测试（契约第 8.3 条）。
 *
 * 用最小假 ctx 桩调用 apply(ctx, {})：
 *   - 不抛错；
 *   - 注册了 3 个事件名：session/event、session/disposed、tools/pre-execute
 *     （MEDIUM-5：权威 after 只在 turn/end 采集，不再注册 agent/turn-stopping）；
 *   - 顺带验证：模拟一轮完整事件流（turn/start → pre-execute 捕获 → turn/end）
 *     后账本里出现 before/after 捕获，
 *     且 pre-execute 永远返回 next() 的结果（不改变调用结果的红线）。
 *
 * 为避免写 ~/.dsh（契约第 9 节），测试期间把 DSH_HOME 指到 test/.tmp/
 * 下的临时目录，结束时清理。
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './bootstrap.mjs'
const { apply, inject, name } = await import('../lib/index.js')
import { createRollbackApi } from '../lib/rollback-preview.js'
import { readAllEntries, sha1Hex, appendEntry, capturePath, createTurnState } from '../lib/ledger.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const tmpRoot = join(testDir, '.tmp-smoke')
const fakeHome = join(tmpRoot, 'dsh-home')
const workDir = join(tmpRoot, 'work')

rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(fakeHome, { recursive: true })
mkdirSync(workDir, { recursive: true })
process.env.DSH_HOME = fakeHome

// ---- 最小假 ctx 桩（契约第 8.3 条要求的形态）----
const registered = []
const cleanups = []
const fakeCtx = {
  logger: { info: () => {}, warn: () => {} },
  on: (eventName) => {
    registered.push(eventName)
    return () => {}
  },
  get: () => undefined,
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push(dispose)
  },
}

let failed = false
async function ok(label, fn) {
  try {
    await fn()
    console.log(`通过  ${label}`)
  } catch (error) {
    failed = true
    console.error(`失败  ${label}`)
    console.error(error)
  }
}

// ---- apply(ctx, {}) 不抛错；导出形态符合契约第 5.1 节 ----
let handlers = new Map()
await ok('apply(ctx, {}) 不抛错，且导出 name/inject 符合契约', () => {
  assert.equal(name, 'audit-rollback')
  assert.deepEqual(inject, ['tools'])
  // 换成能回拨 handler 的 on，便于后面驱动事件流
  fakeCtx.on = (eventName, handler) => {
    registered.push(eventName)
    handlers.set(eventName, handler)
    return () => handlers.delete(eventName)
  }
  apply(fakeCtx, {})
})

// ---- 注册了契约要求的 3 个事件名（且不再有 agent/turn-stopping）----
await ok('注册了 session/event、session/disposed、tools/pre-execute 三个事件，无 agent/turn-stopping', () => {
  for (const eventName of ['session/event', 'session/disposed', 'tools/pre-execute']) {
    assert.ok(registered.includes(eventName), `缺少事件注册：${eventName}`)
  }
  assert.ok(!registered.includes('agent/turn-stopping'), 'MEDIUM-5：不得再注册 agent/turn-stopping')
})

// ---- 驱动一轮完整事件流：before/after 落账，pre-execute 不改变调用结果 ----
const target = join(workDir, 'hello.txt')
const preEditBytes = Buffer.from('编辑前内容')
writeFileSync(target, preEditBytes)
const session = { id: 'smoke-session', header: { cwd: workDir } }

await ok('模拟一轮事件流后账本出现 before/after 捕获，且 pre-execute 原样返回 next() 结果', async () => {
  handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 7 } })
  const preExecute = handlers.get('tools/pre-execute')
  const exec = {
    name: 'write',
    arguments: { path: 'hello.txt', content: '编辑后内容' }, // 相对路径：用 session cwd 解析
    callId: 'call-1',
    agent: { session },
  }
  const sentinel = { 工具结果: '原样返回' }
  // next() 必须真实修改文件（模拟工具真实落盘）：否则无法证明 before 捕获发生在编辑之前
  const result = await preExecute(exec, async () => {
    writeFileSync(target, '编辑后内容')
    return sentinel
  })
  assert.equal(result, sentinel, 'pre-execute 必须返回 next() 的结果')
  handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 7 } })

  const entries = readAllEntries(join(fakeHome, 'audit-rollback'))
  const kinds = entries.map((e) => `${e.kind}${e.kind === 'capture' ? '/' + e.phase : ''}`)
  for (const expected of ['turn/start', 'call', 'capture/before', 'capture/after', 'turn/end']) {
    assert.ok(kinds.includes(expected), `账本缺少 ${expected}，实际：${kinds.join(',')}`)
  }
  const before = entries.find((e) => e.kind === 'capture' && e.phase === 'before')
  assert.equal(before.path, target, '相对路径应解析为 cwd 下的绝对路径')
  assert.equal(before.existed, true)
  // 防回归（变异 M1b：把捕获挪到编辑之后仍能全绿）：
  // before 必须是编辑前字节的哈希，after 必须是编辑后字节的哈希
  assert.equal(before.hash, sha1Hex(preEditBytes), 'before 捕获必须发生在编辑之前')
  const after = entries.find((e) => e.kind === 'capture' && e.phase === 'after')
  assert.equal(after.hash, sha1Hex(Buffer.from('编辑后内容')), 'after 捕获必须反映编辑后内容')
})

// ---- 重载场景：内存态丢失后，迟到的 turn/end 必须回扫账本补采 ----
// sessions 是 apply 实例内存态。插件热重载或轮次中途加载后 Map 为空，该轮的
// turn/end 到达时 slot.state === null，旧口径整段跳过 → after 与 turn/end 永久
// 缺失，文件永远停在 preimage-only。现场 154 个有 before 的轮次里有 4 个这样丢的。
await ok('插件重载后收到迟到的 turn/end 时，补写后像与 turn/end 条目', async () => {
  const stateDir = join(fakeHome, 'audit-rollback')
  const victim = join(workDir, 'reloaded.txt')
  const reloadedSession = { id: 'reload-session', header: { cwd: workDir } }
  writeFileSync(victim, '重载前内容')

  // 旧实例：写 turn/start 与 before，然后内存态随重载一起消失。
  appendEntry(stateDir, { kind: 'turn/start', session: 'reload-session', turn: 1, cwd: workDir })
  const legacyTurn = createTurnState()
  capturePath(stateDir, {
    session: 'reload-session', turn: 1, path: victim, phase: 'before',
    maxBytes: 2097152, turnState: legacyTurn, tool: 'write', callId: 'old',
  })
  writeFileSync(victim, '重载后内容') // 工具已落盘，turn/end 尚未到达

  // 新实例：sessions Map 为空，收到的第一条事件就是 turn/end。
  // effect 必须**收集** disposer 而非立即调用——apply 末尾的清理 effect 一旦
  // 立刻执行，就会把刚注册的 session/event handler 注销掉。
  const reloadHandlers = new Map()
  const reloadDisposers = []
  const reloadCtx = {
    logger: { info: () => {}, warn: () => {} },
    on: (eventName, handler) => { reloadHandlers.set(eventName, handler); return () => reloadHandlers.delete(eventName) },
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') reloadDisposers.push(dispose) },
  }
  apply(reloadCtx, {})
  reloadHandlers.get('session/event')(reloadedSession, { type: 'turn/end', data: { turn: 1 } })

  const entries = readAllEntries(stateDir).filter((e) => e.session === 'reload-session')
  const after = entries.find((e) => e.kind === 'capture' && e.phase === 'after')
  assert.ok(after, '重载后必须补写 after，否则该文件永久停在 preimage-only')
  assert.equal(after.hash, sha1Hex(Buffer.from('重载后内容')), '补采的 after 必须反映工具落盘后的真实内容')
  const end = entries.find((e) => e.kind === 'turn/end')
  assert.ok(end, '重载后必须补写 turn/end，否则 TURN_NOT_ENDED 会继续拒绝恢复')
  assert.equal(end.recovered, true, '补写的 turn/end 必须标记 recovered 以便审计区分')
  assert.equal(end.captured, 1)

  // 补采的最终目的：这条历史真的能恢复。走一遍 GUI 判定。
  const api = createRollbackApi(stateDir, { assertSession: async () => {} })
  const row = (await api.changedFiles({ sessionId: 'reload-session' })).rows[0]
  assert.equal(row.captureStatus, 'before-and-after')
  assert.equal(row.canRestore, true, `补采后应当可恢复，实际 reason=${row.reason}`)
  const view = await api.preview({ sessionId: 'reload-session', entryId: row.entryId })
  assert.ok(typeof view.nonce === 'string' && view.nonce.length > 0, '补采后必须签发预览票据')

  // 幂等：账本里已有 turn/end 时不得重复补采。
  reloadHandlers.get('session/event')(reloadedSession, { type: 'turn/end', data: { turn: 1 } })
  const afterSecond = readAllEntries(stateDir).filter((e) => e.session === 'reload-session')
  assert.equal(afterSecond.filter((e) => e.kind === 'turn/end').length, 1, '重复的 turn/end 不得补写第二条')
  assert.equal(afterSecond.filter((e) => e.kind === 'capture' && e.phase === 'after').length, 1, '不得重复补采 after')
  for (const dispose of reloadDisposers) dispose()
})

// ---- 清理：effect 返回的 disposer 可调用、不抛错 ----
await ok('ctx.effect 注册的清理函数可执行', () => {
  for (const dispose of cleanups) dispose()
})

rmSync(tmpRoot, { recursive: true, force: true })
if (failed) {
  process.exit(1)
}
console.log('\n冒烟测试全部通过，临时目录已清理。')
process.exit(0)
