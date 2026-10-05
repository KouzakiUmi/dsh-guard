// typert 传输契约回归：宿主方法必须**直接返回业务载荷**。
//
// 2026-10-05 实机 Console 实证的缺陷：service.history 原样返回
// queryApprovalHistory 的 {ok, value}，被传输层二次包裹成
// {ok:true, value:{ok:true, value:page}}，客户端 page 成了信封，
// 抛 "Invalid approval history page"，Tab 恒显「无法调用审批历史服务」。
// read/grants 一直正常，正因为它们返回的是载荷直出。
//
// 这个套件存在的意义：此前没有任何测试断言过 service.* 的返回形状。
import './runtime.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { apply, queryApprovalHistory, queryRouterStatus, queryGrants } = await import('../lib/index.js')

// 平台自适应：Windows 用 D 盘根（避开 %LOCALAPPDATA% 的 AppData 敏感段，
// 否则 profile 会被判不可授权）；其它平台用系统临时目录。硬编码 D:\ 在
// Linux 上不是绝对路径，本套件在 CI 上就是这么红过一次。
const isWin = process.platform === 'win32'
const profileDir = mkdtempSync(join(isWin ? 'D:\\' : tmpdir(), 'dsh-remote-shape-'))
process.on('exit', () => { try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 尽力 */ } })

let service = null
const sessionId = 'session-remote-shape'
const session = {
  id: sessionId,
  snapshotEvents: () => [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ],
  events: [{ type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'edit' } }],
}
const ctx = {
  profileContext: { dir: profileDir },
  sessions: { get: (id) => (id === sessionId ? session : undefined) },
  sessionQuery: { async observeSession() { return true } },
  logger: { warn() {}, info() {} },
  reflect: { provide(name, value) { if (name === 'autoReviewRouter') service = value } },
  inject() { return () => {} },
  on() { return () => {} },
  effect(fn) { return fn() },
  llm: { stream: async () => { throw new Error('unused') } },
  tools: { on: () => () => {} },
  permissionPresets: { current: () => 'ask', registerAuto: () => () => {}, set() {} },
  approval: { overrideOf: () => 'ask', request: async () => 'rejected' },
}
apply(ctx, { enabled: true, reviewerProvider: 'p', reviewerModel: 'm', reviewerEffort: '',
  fallbackToSessionRoute: true, timeoutMs: 20000, logDecisions: false, maxContextBytes: 32768 })

assert.ok(service, 'exposeRouterRemote 应当通过 reflect.provide 暴露 autoReviewRouter 服务')

// —— read / grants：载荷直出（本来就对，钉住防止回退）——
const status = await service.read()
assert.equal(status.ok, undefined, 'read 不得返回 ok 字段（那会被传输层二次包裹）')
assert.equal(status.plugin, 'dsh-auto-review-router')
const granted = await service.grants({})
assert.equal(granted.ok, undefined, 'grants 不得返回 ok 字段')
assert.equal(Array.isArray(granted.grants), true)

// —— history：本次修复点 ——
const page = await service.history({ sessionId, limit: 10 })
assert.equal(page.ok, undefined, 'history 必须返回载荷直出，不能是 {ok,value} 信封')
assert.equal(page.value, undefined, 'history 不得带 value 包装层')
assert.equal(Object.keys(page).sort().join(','), 'health,nextCursor,records',
  `history 载荷的键必须恰为 records/nextCursor/health（实际 ${Object.keys(page).sort().join(',')}）`)
assert.equal(Array.isArray(page.records), true)
assert.equal(typeof page.health, 'object')

// 与 queryApprovalHistory 的对照：内部 API 仍返回信封（selftest 等按此断言）
const enveloped = await queryApprovalHistory(ctx, { sessionId, limit: 10 })
assert.equal(enveloped.ok, true, 'queryApprovalHistory 仍应返回信封（内部 API 契约未变）')
assert.equal(typeof enveloped.value, 'object')
assert.equal(queryRouterStatus(ctx).plugin, 'dsh-auto-review-router')
assert.equal(typeof queryGrants(ctx).grants, 'object')

// —— 业务失败必须 throw（传输层据此合成 {ok:false, error}，错误码才活得下来）——
await assert.rejects(
  () => service.history({ sessionId: 'session-does-not-exist', limit: 10 }),
  (error) => {
    assert.ok(error instanceof Error, '失败必须是 Error')
    assert.equal(error.code, 'session-not-found', `错误码必须保留（实际 ${error.code}）`)
    return true
  },
  '未知会话必须以 throw 传递 session-not-found，而不是返回 {ok:false}')

// —— 失败也绝不能退化成信封 ——
await assert.rejects(() => service.history({ sessionId: '', limit: 10 }),
  (error) => error.code === 'invalid-request', '非法请求必须 throw invalid-request')

console.log('PASS typert 传输契约：service.read/grants/history 一律载荷直出，失败以 throw 传递并保留 code')
