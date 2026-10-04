#!/usr/bin/env node
/**
 * 插件可加载性冒烟测试（契约第 8.3 条）。
 *
 * 用最小假 ctx 桩调用 apply(ctx, {})：
 *   - 不抛错；
 *   - 注册了 4 个事件名：session/event、session/disposed、
 *     agent/turn-stopping、tools/pre-execute；
 *   - 顺带验证：模拟一轮完整事件流（turn/start → pre-execute 捕获 →
 *     turn-stopping → turn/end）后账本里出现 before/after 捕获，
 *     且 pre-execute 永远返回 next() 的结果（不改变调用结果的红线）。
 *
 * 为避免写 ~/.dsh（契约第 9 节），测试期间把 DSH_HOME 指到 test/.tmp/
 * 下的临时目录，结束时清理。
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name } from '../lib/index.js'
import { readAllEntries, sha1Hex } from '../lib/ledger.js'

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

// ---- 注册了契约要求的 4 个事件名 ----
await ok('注册了 session/event、session/disposed、agent/turn-stopping、tools/pre-execute 四个事件', () => {
  for (const eventName of ['session/event', 'session/disposed', 'agent/turn-stopping', 'tools/pre-execute']) {
    assert.ok(registered.includes(eventName), `缺少事件注册：${eventName}`)
  }
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
  await handlers.get('agent/turn-stopping')({ agent: { session }, turn: 7 })
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
