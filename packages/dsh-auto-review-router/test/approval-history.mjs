import './runtime.mjs'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { createApprovalHistory, parseHistoryRequest, parseHistoryResult, parseHistoryRecord, reasonSummary } = await import('../lib/approval-history.js')
const { routerStatusRemote } = await import('../lib/index.js')
const testDir = dirname(fileURLToPath(import.meta.url))
const temp = await fs.mkdtemp(join(testDir, '.tmp-history-'))
const stores = []
function session(id) {
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 9 } }, { type: 'step/start', seq: 1, data: { turn: 9, step: 2 } }]
  return { id, snapshotEvents: () => events.slice(), events }
}
const a = session('session-A'), b = session('session-B'), live = new Map([[a.id, a], [b.id, b]])
function execution(owner, callId, name = 'edit', extra = {}) {
  const runtime = { get() { return {} }, collapses() { return false }, concludingExecutions: new Set(),
    deferredContexts: new WeakMap(), contentFinalizers: new WeakMap(), contentProjectors: new WeakMap(), cancellationStates: new WeakMap() }
  const created = ToolRuntime.prototype.createExecution.call(runtime, { callId, name, arguments: { password: 'RAW_ARGS_SECRET' },
    agent: { session: owner }, signal: new AbortController().signal, ...extra })
  assert.equal(created.kind, 'ready')
  return created.exec
}
function store(name, options, extra = {}) {
  const profile = join(temp, name)
  const warnings = []
  const ctx = { profileContext: { dir: profile }, sessions: { get: id => live.get(id) },
    sessionQuery: { async observeSession() { throw Object.assign(new Error('absent fixture'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }) } },
    logger: { warn: message => warnings.push(message) }, ...extra }
  const result = createApprovalHistory(ctx, options)
  stores.push(result)
  return { result, profile, ctx, warnings }
}
const pathFor = (profile, id) => join(profile, 'dsh-auto-review-router', 'approval-history', `${createHash('sha256').update(id).digest('hex')}.jsonl`)
try {
  const f = store('identities'), s = f.result
  const firstRoot = execution(a, 'same-root', 'run_code')
  a.events.push({ type: 'tool/call', seq: 2, data: { turn: 9, step: 2, callId: firstRoot.callId, name: 'run_code' } })
  const r1 = s.begin(firstRoot)
  const secondRoot = execution(a, 'same-root', 'run_code')
  a.events.push({ type: 'tool/call', seq: 3, data: { turn: 9, step: 2, callId: secondRoot.callId, name: 'run_code' } })
  const r2 = s.begin(secondRoot)
  assert.notEqual(r1.base.dispatchId, r2.base.dispatchId)
  assert.equal(r1.base.callEventSeq, 2); assert.equal(r2.base.callEventSeq, 3)
  const c1exec = execution(a, 'duplicate-subcall', 'edit', { parent: firstRoot.token, rootCallId: firstRoot.rootCallId })
  const c2exec = execution(a, 'duplicate-subcall', 'edit', { parent: secondRoot.token, rootCallId: secondRoot.rootCallId })
  const c1 = s.begin(c1exec), c2 = s.begin(c2exec)
  const nestedExec = execution(a, 'nested-transport', 'run_code', { parent: c1exec.token, rootCallId: firstRoot.rootCallId })
  const nested = s.begin(nestedExec)
  const innerExec = execution(a, 'duplicate-subcall', 'edit', { parent: nestedExec.token, rootCallId: firstRoot.rootCallId })
  const inner = s.begin(innerExec)
  await Promise.all([
    s.record(r1, 'downstream', 'allow', { cause: 'ptc-transport' }), s.record(r2, 'downstream', 'allow', { cause: 'ptc-transport' }),
    s.record(c1, 'reviewer', 'allow', { route: 'fixture/model', reasonSummary: '{"api_key":"json secret with spaces"}', rawArguments: { never: 'stored' } }),
    s.record(c2, 'reviewer', 'deny', { reasonSummary: '--password "cli secret with spaces"' }),
    s.record(nested, 'downstream', 'allow', { cause: 'ptc-transport' }), s.record(inner, 'reviewer', 'allow'),
  ])
  s.result(c2exec, { isError: true, error: { message: 'FULL_ERROR_SECRET', info: { name: 'Error BAD_SECRET with spaces', code: 'AUTO_REVIEW_DENIED' } } })
  s.result(c1exec, { isError: false, content: [{ text: 'RAW_CONTENT_SECRET' }] })
  s.result(innerExec, { isError: false }); s.result(nestedExec, { isError: false })
  s.result(secondRoot, { isError: false }); s.result(firstRoot, { isError: false })
  await s.drain()
  const p1 = parseHistoryResult(await s.history({ sessionId: a.id, limit: 3 }))
  assert.equal(p1.ok, true); assert.equal(p1.value.records.length, 3); assert.ok(p1.value.nextCursor)
  const p2 = await s.history({ sessionId: a.id, cursor: p1.value.nextCursor, limit: 100 })
  const rows = [...p1.value.records, ...p2.value.records]
  assert.equal(new Set(rows.map(row => row.eventId)).size, rows.length)
  assert.ok(rows.every(row => row.turn === 9 && row.step === 2 && row.sessionId === a.id))
  assert.equal(rows.find(row => row.dispatchId === c1.base.dispatchId).parentDispatchId, r1.base.dispatchId)
  assert.equal(rows.find(row => row.dispatchId === c2.base.dispatchId).parentDispatchId, r2.base.dispatchId)
  assert.equal(rows.find(row => row.dispatchId === inner.base.dispatchId).parentDispatchId, nested.base.dispatchId)
  assert.ok(!rows.some(row => row.dispatchId === r1.base.dispatchId && row.phase === 'reviewer'))
  const serialized = await fs.readFile(pathFor(f.profile, a.id), 'utf8')
  for (const needle of ['RAW_ARGS_SECRET', 'RAW_CONTENT_SECRET', 'FULL_ERROR_SECRET', 'BAD_SECRET', 'json secret', 'cli secret', 'rawArguments', 'bodyRan']) assert.ok(!serialized.includes(needle), needle)
  assert.ok(rows.some(row => row.errorCode === 'AUTO_REVIEW_DENIED'))
  assert.equal((await s.history({ sessionId: b.id, cursor: p1.value.nextCursor })).error.code, 'invalid-request')
  assert.deepEqual((await s.history({ sessionId: b.id })).value.records, [])
  assert.equal((await s.history({ sessionId: 'absent' })).error.code, 'session-not-found')
  for (const bad of [{ sessionId: a.id, limit: 101 }, { sessionId: a.id, limit: 0 }, { sessionId: a.id, cursor: 'x' }, { sessionId: a.id, raw: true }]) {
    assert.equal((await s.history(bad)).error.code, 'invalid-request')
  }
  console.log('PASS actual SDK tokens: duplicate root/call IDs, two concurrent PTC roots, nested parents, session-bound readonly pagination')

  for (const value of ['{"token":"json multi word secret"}', 'Authorization: Bearer multi word value', '--api-key "cli secret"', 'PASSWORD="env multi word"']) {
    assert.equal(reasonSummary(value), '[redacted sensitive detail]')
  }
  const historyDescriptor = routerStatusRemote.descriptors.find(row => row.method === 'history')
  assert.equal(historyDescriptor.parameters[0].source, 'json'); assert.equal(historyDescriptor.invocation.kind, 'direct')
  assert.equal(historyDescriptor.parameters[0].codec.typeSymbol, 'dsh-auto-review-router#ApprovalHistoryRequest')
  assert.deepEqual(historyDescriptor.parameters[0].codec.schema.parse({ sessionId: a.id }), parseHistoryRequest({ sessionId: a.id }))
  assert.throws(() => parseHistoryRecord({ ...rows[0], prompt: 'not allowed' }))
  assert.throws(() => parseHistoryRecord({ ...rows[0], errorCode: 'free text forbidden' }))
  console.log('PASS history SRC business DTO codecs and secret/free-text minimization')

  {
    const failFs = { ...fs, open: async () => { throw Object.assign(new Error('disk secret full'), { code: 'ENOSPC' }) } }
    const broken = store('enospc', { fs: failFs }), entry = broken.result.begin(execution(a, 'fail-call'))
    // record 是同步有界 enqueue：入队即返回 true，写失败由 drain 后的 health 呈现。
    assert.equal(broken.result.record(entry, 'reviewer', 'allow'), true)
    await broken.result.drain()
    const page = await broken.result.history({ sessionId: a.id })
    assert.equal(page.ok, true); assert.equal(page.value.health.gap, true); assert.equal(page.value.health.lastErrorCode, 'ENOSPC')
    assert.equal(page.value.health.writeFailures, 1); assert.ok(!broken.warnings.join('').includes('disk secret'))
  }
  {
    const limited = store('bounded', { maxFileBytes: 1200, cacheLimit: 1 })
    const entry = limited.result.begin(execution(a, 'bounded-call'))
    let queued = 0
    for (let i = 0; i < 10; i++) if (limited.result.record(entry, 'reviewer', 'allow')) queued++
    assert.ok(queued > 0)
    await limited.result.drain()
    assert.ok((await fs.stat(pathFor(limited.profile, a.id))).size <= 1200)
    const page = await limited.result.history({ sessionId: a.id })
    assert.equal(page.value.health.lastErrorCode, 'AUDIT_FILE_LIMIT'); assert.ok(page.value.health.droppedRecords > 0)
    assert.ok(page.value.records.length < queued, '超限记录必须被丢弃而不是截断写入')
  }
  {
    const limitedQueue = store('queue-limit', { queueLimit: 1 }), entry = limitedQueue.result.begin(execution(a, 'queue-call'))
    assert.equal(limitedQueue.result.record(entry, 'reviewer', 'allow'), true)
    assert.equal(limitedQueue.result.record(entry, 'downstream', 'allow'), false)
    await limitedQueue.result.drain()
    assert.equal(limitedQueue.result.health().lastErrorCode, 'AUDIT_QUEUE_LIMIT')
  }
  {
    // ENOTDIR（Linux 对「路径中间段是文件」的错误码；Windows 同场景报 ENOENT）平台无关注入回归：
    // 归类为「账本目录被非目录占位」——查询降级 ok=true + 空页 + 真实 gap，写入保持可见失败，
    // 不得伪装成 healthy 全新空账本，也不得升级成 history-unavailable。
    const notdirFs = { ...fs, stat: async () => { throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }) } }
    const blocked = store('notdir', { fs: notdirFs })
    const entry = blocked.result.begin(execution(a, 'notdir-call'))
    assert.equal(blocked.result.record(entry, 'reviewer', 'allow'), true)
    await blocked.result.drain()
    assert.equal(blocked.result.health().writeFailures, 1, '写入路径必须保持失败可见')
    assert.equal(blocked.result.health().lastErrorCode, 'AUDIT_LEDGER_NOTDIR')
    const page = await blocked.result.history({ sessionId: a.id })
    assert.equal(page.ok, true, 'ENOTDIR 查询必须降级而非 history-unavailable')
    assert.deepEqual(page.value.records, [])
    assert.equal(page.value.health.gap, true, '必须记 gap，不得伪装成健康空账本')
    assert.equal(page.value.health.readFailures, 1)
    assert.equal(page.value.health.lastErrorCode, 'AUDIT_LEDGER_NOTDIR')
    assert.equal(page.value.health.missingProfile, false, 'profile 存在，不是 missingProfile')
    assert.equal(page.value.nextCursor, null)
  }
  console.log('PASS ENOSPC contained; runtime file-size cap and queue bounds visibly report gaps without admission decisions; ENOTDIR classified as blocked ledger (degraded read, visible write failure)')

  {
    const other = store('identities'), e = other.result.begin(execution(a, 'overlap-call'))
    await Promise.all([s.record(s.begin(execution(a, 'reentrant-1')), 'reviewer', 'allow'), other.result.record(e, 'reviewer', 'allow')])
    const page = await s.history({ sessionId: a.id, limit: 100 })
    assert.equal(new Set(page.value.records.map(row => row.ledgerSeq)).size, page.value.records.length)
    assert.equal(page.value.health.corruptRecords, 0)
    const entry = s.begin(execution(a, 'external-append'))
    await fs.appendFile(pathFor(f.profile, a.id), '{torn secret')
    // 同步入队成功；撕裂尾部在写者串行排空时检出并拒绝扩展。
    assert.equal(s.record(entry, 'reviewer', 'allow'), true)
    await s.drain()
    const corruptPage = await s.history({ sessionId: a.id, limit: 100 })
    assert.equal(corruptPage.ok, true); assert.equal(corruptPage.value.health.gap, true)
    assert.ok(corruptPage.value.health.corruptRecords > 0)
    assert.ok(!JSON.stringify(corruptPage).includes('torn secret'))
  }
  console.log('PASS overlapping/reentrant per-profile writers serialize; externally modified torn tail never masked or extended')

  {
    const original = store('crash'), entry = original.result.begin(execution(b, 'crash-pending'))
    await original.result.record(entry, 'reviewer', 'allow'); await original.result.drain()
    const resumed = store('crash') // Simulated crash: original observers never reported a terminal result.
    const page = await resumed.result.history({ sessionId: b.id })
    assert.equal(page.ok, true)
    assert.ok(page.value.records.some(row => row.phase === 'reviewer' && row.outcome === 'allow'))
    assert.ok(!page.value.records.some(row => row.phase === 'reported-result'))
    const before = await fs.readFile(pathFor(original.profile, b.id), 'utf8')
    await resumed.result.history({ sessionId: b.id })
    assert.equal(await fs.readFile(pathFor(original.profile, b.id), 'utf8'), before, 'readonly history must not repair/write unknown tails')
  }
  {
    let observations = 0, disposed = 0
    const cold = store('cold', {}, { sessions: { get() {} }, sessionQuery: { async observeSession(id, options) {
      observations++; assert.equal(options.projectionMode, 'none')
      if (id === 'missing') throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      return { header: { id }, [Symbol.dispose]() { disposed++ } }
    } } })
    assert.equal((await cold.result.history({ sessionId: 'cold-session' })).ok, true)
    assert.equal((await cold.result.history({ sessionId: 'missing' })).error.code, 'session-not-found')
    assert.equal(observations, 2); assert.equal(disposed, 1)
  }
  const noProfile = createApprovalHistory({ sessions: { get: () => a }, logger: { warn() {} } })
  stores.push(noProfile)
  assert.equal((await noProfile.history({ sessionId: a.id })).error.code, 'history-unavailable')
  assert.equal(noProfile.health().missingProfile, true)
  console.log('PASS crash pending remains unknown; readonly cold existence via observation+dispose, no Agent resume or guessed profile')
} finally {
  for (const store of stores.reverse()) await store.close()
  assert.equal(dirname(resolve(temp)), resolve(testDir)); assert.ok(temp.includes('.tmp-history-'))
  await fs.rm(temp, { recursive: true, force: true })
}
console.log('approval-history: 全部通过（测试自有目录；不写用户profile）')
