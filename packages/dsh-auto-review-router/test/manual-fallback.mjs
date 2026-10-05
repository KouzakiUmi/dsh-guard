// Installed SDK ToolRuntime + ApprovalService + SessionStore + real Cordis.
// Deterministic in-process reviewer/answerer fixtures only; no model/network/profile.
import './runtime.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, open, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { Context } = await import('@deepseek-ai/cordis')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { ApprovalService } = await import('@deepseek-ai/dsh-user-approval')
const { SessionStore } = await import('@deepseek-ai/dsh-session')
const router = await import('../lib/index.js')
const testDir = dirname(fileURLToPath(import.meta.url))
const temp = await mkdtemp(join(testDir, '.tmp-manual-'))
const fixtures = []
async function fixture({ policy = 'ask', verdict = 'deny', fallback = true, reviewerFailure = false, risk = 'high', auditFailure = false } = {}) {
  const ctx = new Context(), state = { admitted: false, bodyCalls: 0, prompts: [], asks: 0, release: null }
  const profile = join(temp, `profile-${fixtures.length}`)
  if (auditFailure) await writeFile(profile, 'fixture blocks ledger directory')
  const capabilities = ctx.plugin(scope => {
    scope.reflect.provide('profileContext', { dir: profile })
    scope.reflect.provide('systemPrompt', { tools() {}, context() {}, section() {} })
    scope.reflect.provide('permissionPresets', {
      registerAuto() { state.admitted = true; return () => { state.admitted = false } },
      current(session) { return state.admitted && !session.snapshotEvents().some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only') ? 'auto' : 'custom' },
    })
    scope.reflect.provide('llm', { stream(request) {
      state.prompts.push(request)
      if (reviewerFailure) throw new Error('fake reviewer failure SECRET=never-persist-me')
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ risk: verdict === 'deny' ? risk : 'low', decision: verdict,
          ...(verdict === 'deny' ? { reason: 'High risk irreversible external effect' } : {}) }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } })
  })
  await capabilities.await()
  const sessionFiber = ctx.plugin(SessionStore); await sessionFiber.await()
  const approvalFiber = ctx.plugin(ApprovalService, { policy }); await approvalFiber.await()
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: 'native' }); await toolsFiber.await()
  const session = ctx.get('sessions').create(`manual-${fixtures.length}`, { meta: { cwd: temp } })
  const schema = { name: 'audit_fixture', description: 'offline fixture', parameters: { type: 'object', properties: {} } }
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  const agent = { id: session.id, session, ctx }
  const tools = ctx.get('tools')
  tools.register({ ...schema, output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, render: () => [{ type: 'text', text: 'safe fixture' }] },
    async execute() { state.bodyCalls++; return { ok: true } } })
  const writeSchema = { name: 'write', description: 'offline write fixture', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
  tools.register({ ...writeSchema, output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, render: () => [{ type: 'text', text: 'safe write fixture' }] },
    async execute() { state.bodyCalls++; return { ok: true } } })
  // 请求头必须同时声明两个工具，否则路由的 pendingActionOf 看不到 write 的 schema。
  const requestHeader = () => ({ config: { provider: 'offline', model: 'fixture' }, tools: [schema, writeSchema] })
  session.requestHeader = requestHeader
  const fiber = ctx.plugin(router, { enabled: true, reviewerProvider: 'offline', reviewerModel: 'fixture',
    manualFallback: fallback, manualApprovalTimeoutMs: 1000, logDecisions: false })
  await fiber.await()
  let counter = 0
  const f = { ctx, state, session, agent, tools, fiber,
    async run(extra = {}) {
      const callId = extra.callId ?? `call-${++counter}`
      const args = extra.arguments ?? {}
      session.append('tool/call', { turn: 1, step: 1, callId, name: schema.name, arguments: args })
      return tools.execute({ callId, name: schema.name, arguments: args, agent, signal: new AbortController().signal, ...extra })
    },
    answer(callback) { return ctx.on('approval/request', async (request, next) => { state.asks++; return callback(request, next) }, { prepend: true }) },
    history: () => router.queryApprovalHistory(fiber.ctx, { sessionId: session.id, limit: 100 }),
  }
  fixtures.push(f)
  return f
}
try {
  {
    const f = await fixture({ verdict: 'allow' })
    f.tools.guard(() => 'DOWNSTREAM_MONOTONIC_DENY')
    const result = await f.run()
    assert.equal(result.isError, true); assert.equal(f.state.bodyCalls, 0); assert.equal(f.state.asks, 0)
    const { value } = await f.history()
    assert.ok(value.records.some(row => row.phase === 'reviewer' && row.outcome === 'allow'))
    assert.ok(value.records.some(row => row.phase === 'reported-result' && row.outcome === 'reported-error'))
    assert.ok(!value.records.some(row => row.outcome === 'reported-ok' || Object.hasOwn(row, 'bodyRan')))
    console.log('PASS actual SDK reviewer allow + later monotonic guard deny: no success/body claim')
  }
  {
    const f = await fixture()
    f.answer(request => { assert.match(request.displayReason.zh, /自动审批判断工具「.*」为高危操作，需要你决定是否放行。1秒未响应自动拒绝/); return 'allowed-once' })
    f.tools.guard(() => 'GUARD_AFTER_MANUAL_ALLOW')
    const result = await f.run()
    assert.equal(result.isError, true); assert.equal(f.state.bodyCalls, 0); assert.equal(f.state.asks, 1)
    const { value } = await f.history()
    const asked = f.session.snapshotEvents().find(e => e.type === 'approval/asked')
    const decided = f.session.snapshotEvents().find(e => e.type === 'approval/decided')
    assert.equal(decided.data.outcome, 'allowed-once')
    assert.ok(value.records.some(row => row.phase === 'manual' && row.outcome === 'allowed-once' && row.approvalRequestId === asked.data.id))
    assert.ok(value.records.some(row => row.phase === 'reported-result' && row.outcome === 'reported-error'))
    console.log('PASS official manual allow + later guard deny; asked UUID linked without replacing Core')
  }
  // 2026-10-05 缺陷 2：人工审批提示必须带具体命令/路径，否则用户无法判断该不该批。
  {
    const f = await fixture({ risk: 'medium' })
    let seen = null
    f.answer(request => { seen = request; return 'allowed-once' })
    await f.run({ name: 'write', arguments: { file_path: temp + '\\out.txt', content: 'x' } })
    assert.ok(seen !== null, `人工审批请求已发出（asks=${f.state.asks} bodyCalls=${f.state.bodyCalls} prompts=${f.state.prompts.length}）`)
    assert.ok(/file_path=/.test(seen.displayReason.zh), `displayReason 需含具体目标：${seen.displayReason.zh}`)
    assert.ok(seen.reason.includes('file_path='), 'reason 也带具体目标')
    console.log('PASS manual approval prompt carries the concrete command/path (缺陷 2)')
  }
  for (const options of [{ policy: 'never' }, { fallback: false }, { reviewerFailure: true }]) {
    const f = await fixture(options)
    f.answer(() => { throw new Error('never/failure/fallback=false must not prompt') })
    const result = await f.run()
    assert.equal(result.isError, true); assert.equal(f.state.bodyCalls, 0); assert.equal(f.state.asks, 0)
  }
  console.log('PASS configured default never, disabled fallback and reviewer failure: no artificial manual UI')
  {
    const f = await fixture()
    const off = f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'EXISTING_PRE_DENY' }))
    f.answer(() => 'allowed-once')
    assert.equal((await f.run()).isError, true); assert.equal(f.state.asks, 0)
    off()
    f.ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'existing ask', displayReason: { zh: '下游原有审批', en: 'existing gate' } }))
    f.answer(request => { assert.equal(request.displayReason.zh, '下游原有审批'); return 'rejected' })
    assert.equal((await f.run()).isError, true); assert.equal(f.state.asks, 1)
    const { value } = await f.history()
    assert.ok(value.records.some(row => row.phase === 'downstream' && row.outcome === 'ask' && row.cause === 'handed-to-core-approval'))
    console.log('PASS existing downstream deny/ask remains authoritative; ask handed back to Core')
  }
  {
    const f = await fixture()
    let lateResolve, requestSignal
    f.answer(request => { requestSignal = request.signal; return new Promise(resolve => { lateResolve = resolve }) })
    const result = await f.run()
    assert.equal(result.isError, true); assert.equal(requestSignal.aborted, true); assert.equal(f.state.bodyCalls, 0)
    lateResolve('allowed-once'); await new Promise(resolve => setTimeout(resolve, 5))
    const decided = f.session.snapshotEvents().filter(e => e.type === 'approval/decided')
    assert.equal(decided.length, 1); assert.equal(decided[0].data.outcome, 'cancelled')
    const { value } = await f.history()
    assert.ok(value.records.some(row => row.phase === 'manual' && row.outcome === 'cancelled' && row.cause === 'timeout'))
    assert.ok(!value.records.some(row => row.phase === 'manual' && row.outcome === 'allowed-once'))
    console.log('PASS official timeout cancellation + late grant cannot authorize the body')
  }
  {
    const f = await fixture()
    f.answer(() => {
      const until = performance.now() + 1100
      while (performance.now() < until) {} // Timer cannot run until this late response finishes.
      return 'allowed-once'
    })
    const result = await f.run()
    assert.equal(result.isError, true); assert.equal(f.state.bodyCalls, 0)
    const { value } = await f.history()
    assert.ok(value.records.some(row => row.phase === 'manual' && row.outcome === 'cancelled' && row.cause === 'timeout'))
    console.log('PASS monotonic deadline rejects late allowed-once even when event-loop timer is delayed')
  }
  {
    const probe = await open(join(temp, 'datasync-probe'), 'w')
    const prototype = Object.getPrototypeOf(probe), original = prototype.datasync
    await probe.close()
    let delayAudit = false
    prototype.datasync = async function () {
      if (delayAudit) await new Promise(resolve => setTimeout(resolve, 1100))
      return original.call(this)
    }
    try {
      const f = await fixture({ risk: 'medium' })
      f.answer(request => {
        assert.match(request.displayReason.zh, /中风险.*1秒未响应自动拒绝/)
        delayAudit = true
        return 'allowed-once'
      })
      const result = await f.run()
      assert.equal(result.isError, false); assert.equal(f.state.bodyCalls, 1)
      const { value } = await f.history()
      assert.ok(value.records.some(row => row.phase === 'manual' && row.outcome === 'allowed-once' && row.cause === undefined))
      assert.ok(!value.records.some(row => row.phase === 'manual' && row.cause === 'timeout'))
      console.log('PASS timely grant + slow audit I/O preserves allow, no false timeout; actual risk and timeout copy')
    } finally { prototype.datasync = original }
  }
  {
    const f = await fixture({ verdict: 'allow', auditFailure: true })
    const result = await f.run()
    assert.equal(result.isError, false); assert.equal(f.state.bodyCalls, 1)
    const history = await f.history()
    assert.equal(history.ok, true); assert.equal(history.value.health.gap, true)
    assert.ok(history.value.health.writeFailures > 0)
    console.log('PASS audit storage failure remains independent of actual SDK admission/result')
  }
  {
    const f = await fixture()
    const started = Promise.withResolvers()
    f.answer(request => { started.resolve(request.signal); return new Promise(() => {}) })
    const run = f.run(), signal = await started.promise
    await f.fiber.dispose()
    const result = await run
    assert.equal(signal.aborted, true); assert.equal(result.isError, true); assert.equal(f.state.bodyCalls, 0)
    assert.equal(f.state.admitted, false)
    assert.ok(f.session.snapshotEvents().some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only'))
    console.log('PASS real Cordis unload cancels pending official approval, narrows before removing Auto')
  }
  {
    const f = await fixture({ verdict: 'allow' })
    f.ctx.on('tools/execute', async () => ({ value: { ok: true }, content: [{ type: 'text', text: 'wrapper' }], isError: false }))
    const result = await f.run()
    assert.equal(result.isError, false); assert.equal(f.state.bodyCalls, 0)
    const { value } = await f.history()
    assert.ok(value.records.some(row => row.phase === 'reported-result' && row.outcome === 'reported-ok'))
    assert.ok(!value.records.some(row => Object.hasOwn(row, 'bodyRan')))
    console.log('PASS execution wrapper short-circuit: reported-ok does not imply body invocation')
  }
} finally {
  for (const f of fixtures.reverse()) await f.ctx.fiber.dispose()
  assert.equal(dirname(resolve(temp)), resolve(testDir)); assert.ok(temp.includes('.tmp-manual-'))
  await rm(temp, { recursive: true, force: true })
}
console.log('manual-fallback: 全部通过（本机实际SDK；零真实模型请求）')
