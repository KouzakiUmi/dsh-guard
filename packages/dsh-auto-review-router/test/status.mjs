#!/usr/bin/env node
/**
 * 假 ctx 调用 Host 只读状态查询。
 * 覆盖启用状态、Auto 注册/冲突、路由判定、预算回显。
 * 不写 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, queryRouterStatus, routerStatusRemote } from '../lib/index.js'

const testDir = dirname(fileURLToPath(import.meta.url))
let failed = 0

function ok(label, fn) {
  try {
    fn()
    console.log(`通过  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`失败  ${label}`)
    console.error(error)
  }
}

function fakeCtx(registerAuto) {
  return {
    logger: { info() {}, warn() {} },
    permissionPresets: { registerAuto },
    on() { return () => {} },
  }
}

ok('未启用：不注册，配置回显默认预算', () => {
  const ctx = fakeCtx(() => {
    throw new Error('disabled 路径不应调用 registerAuto')
  })
  apply(ctx, { enabled: false, maxContextBytes: 9, historyLimit: 3, timeoutMs: 4, temperature: 0.2, logDecisions: false })
  const status = queryRouterStatus(ctx)
  assert.equal(status.plugin, 'dsh-auto-review-router')
  assert.equal(status.enabled, false)
  assert.equal(status.registration.observed, true)
  assert.equal(status.registration.attempted, false)
  assert.equal(status.registration.registered, false)
  assert.equal(status.registration.conflict, false)
  assert.equal(status.budget.maxContextBytes, 9)
  assert.equal(status.budget.historyLimit, 3)
  assert.equal(status.budget.timeoutMs, 4)
  assert.equal(status.budget.temperature, 0.2)
  assert.equal(status.budget.logDecisions, false)
  assert.equal(status.route.source, 'session-fallback')
  console.log(JSON.stringify({ enabled: status.enabled, registration: status.registration, route: status.route, budget: status.budget }))
})

ok('配置路由：registered，回显 provider/model/effort', () => {
  const ctx = fakeCtx(() => () => {})
  apply(ctx, {
    enabled: true,
    reviewerProvider: 'demo-provider',
    reviewerModel: 'demo-model',
    reviewerEffort: 'high',
    fallbackToSessionRoute: false,
    maxContextBytes: 128,
    historyLimit: 2,
    timeoutMs: 30,
    temperature: 0,
    logDecisions: true,
  })
  const status = queryRouterStatus(ctx)
  assert.equal(status.enabled, true)
  assert.equal(status.registration.registered, true)
  assert.equal(status.registration.conflict, false)
  assert.equal(status.route.source, 'config')
  assert.equal(status.route.provider, 'demo-provider')
  assert.equal(status.route.model, 'demo-model')
  assert.equal(status.route.effort, 'high')
  assert.equal(status.route.rejection, null)
  assert.equal(status.budget.maxContextBytes, 128)
  console.log(JSON.stringify({ registration: status.registration, route: status.route, budget: status.budget }))
})

ok('配置不全且关闭回退：rejection 非空', () => {
  const ctx = fakeCtx(() => () => {})
  apply(ctx, { enabled: true, fallbackToSessionRoute: false })
  const status = queryRouterStatus(ctx)
  assert.equal(status.route.source, 'rejected')
  assert.equal(typeof status.route.rejection, 'string')
  assert.ok(status.route.rejection.length > 0)
  console.log(JSON.stringify({ route: status.route }))
})

ok('官方 Auto 已注册：conflict 与警告文案', () => {
  const ctx = fakeCtx(() => {
    throw new Error('preset "auto" is already registered')
  })
  apply(ctx, { enabled: true, reviewerProvider: 'p', reviewerModel: 'm' })
  const status = queryRouterStatus(ctx)
  assert.equal(status.registration.attempted, true)
  assert.equal(status.registration.registered, false)
  assert.equal(status.registration.conflict, true)
  assert.match(status.registration.conflictWarning, /禁用其一/)
  console.log(JSON.stringify({ registration: status.registration }))
})

ok('未 apply 的假 ctx 仍能按 config 回显，且不抛错', () => {
  const status = queryRouterStatus({
    config: { enabled: true, reviewerProvider: 'only-config', reviewerModel: 'm2', maxContextBytes: 7 },
  })
  assert.equal(status.registration.observed, false)
  assert.equal(status.route.source, 'config')
  assert.equal(status.route.provider, 'only-config')
  assert.equal(status.budget.maxContextBytes, 7)
})

ok('缺少 registerAuto 仍然抛错，不改既有失败语义', () => {
  assert.throws(
    () => apply({ logger: { info() {}, warn() {} }, permissionPresets: {} }, { enabled: true }),
    /registerAuto/,
  )
})

ok('client 描述符与 host 对齐，且两端都没有核心包 import', () => {
  const client = readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8')
  const host = readFileSync(join(testDir, '..', 'lib', 'index.js'), 'utf8')
  assert.equal(routerStatusRemote.descriptors[0].id, 'dsh-auto-review-router#autoReviewRouter/read')
  assert.ok(client.includes(routerStatusRemote.descriptors[0].id))
  const forbidden = /(?:from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\/|import\(\s*['"]@deepseek-ai\/)/
  assert.equal(forbidden.test(client), false)
  assert.equal(forbidden.test(host), false)
})

if (failed > 0) {
  console.error(`status: ${failed} 项失败`)
  process.exit(1)
}
console.log('status: 全部通过')
