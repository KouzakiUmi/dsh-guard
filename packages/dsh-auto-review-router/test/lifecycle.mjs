import './runtime.mjs'
import assert from 'node:assert/strict'
const { apply, queryRouterStatus } = await import('../lib/index.js')
const { Config } = await import('../lib/config.js')
const { updateVolatile } = await import('@deepseek-ai/cosmokit')

function fixture({ conflict = false, appendFailure = false, missingSessions = false, listFailure = false, nullSessions = false } = {}) {
  const listeners = new Map(), effects = []
  const session = { mode: 'danger-full-access', policy: 'never', append(type, data) {
    if (appendFailure) throw new Error('SESSION_WRITE_FAILED')
    assert.equal(type, 'sandbox/mode'); this.mode = data.mode
  } }
  let auto, removals = 0, modelCalls = 0
  const ctx = {
    logger: { info() {}, warn() {} }, approval: { overrideOf: () => session.policy },
    sessions: missingSessions ? undefined : { list: () => { if (listFailure) throw new Error('SESSION_LIST_FAILED'); return nullSessions ? null : [session] } },
    permissionPresets: {
      current: () => session.mode === 'read-only' ? 'custom' : auto ? 'auto' : 'danger-full-access',
      registerAuto(admit) { if (conflict) throw new Error('permission: preset "auto" is already registered'); auto = admit; return () => { removals++; auto = undefined } },
    },
    llm: { stream() { modelCalls++; throw new Error('must not call model') } },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    effect(factory) { effects.push(factory()); },
  }
  const ref = Config({ enabled: true })
  apply(ctx, ref)
  return { ctx, session, ref, listeners, effects,
    get auto() { return auto }, get removals() { return removals }, get modelCalls() { return modelCalls },
    update(values) { updateVolatile(ref, Config({ ...ref.get(), ...values })); listeners.get('loader/volatile-update')() },
    allowWrites() { appendFailure = false },
  }
}
for (const options of [{ appendFailure: true }, { missingSessions: true }, { listFailure: true }, { nullSessions: true }]) {
  const f = fixture(options)
  f.update({ enabled: false })
  assert.ok(f.auto, 'failed narrowing retains Auto registration')
  assert.equal(f.removals, 0)
  assert.equal(f.session.mode, 'danger-full-access')
  assert.equal(f.session.policy, 'never')
  const status = queryRouterStatus(f.ctx)
  assert.equal(status.enabled, false)
  assert.equal(status.registration.registered, true)
  assert.match(status.registration.error, /安全关闭失败/)
  assert.throws(() => f.auto(), /关闭/)
  let next = 0
  for (const name of ['edit', 'run_code']) {
    const result = await f.listeners.get('tools/pre-execute')({ name, agent: { session: f.session } }, () => { next++; return { kind: 'allow' } })
    assert.equal(result.kind, 'cancel', `${name}: 关闭失败时不得绕过拒绝守卫`)
    assert.equal(next, 0, `${name}: 不得执行下游`)
  }
  assert.equal(f.modelCalls, 0)
  if (options.appendFailure) {
    f.allowWrites(); f.update({ historyLimit: 3 })
    assert.equal(f.session.mode, 'read-only')
    assert.equal(f.removals, 1)
    assert.equal(queryRouterStatus(f.ctx).registration.error, null)
  }
}
console.log('PASS failed narrowing/missing sessions: no unregister, admission blocked, next call cancels, retry succeeds, never unchanged')
const conflict = fixture({ conflict: true })
assert.equal(queryRouterStatus(conflict.ctx).registration.conflict, true)
assert.equal(conflict.listeners.has('tools/pre-execute'), false)
console.log('PASS conflict: explicit status and own listener rollback')
const normal = fixture()
let healthyNext = 0
assert.equal((await normal.listeners.get('tools/pre-execute')({ name: 'run_code', agent: { session: normal.session } }, () => { healthyNext++; return { kind: 'allow' } })).kind, 'allow')
assert.equal(healthyNext, 1, '健康启用时仍豁免外层 PTC 审查')
const aborted = new AbortController()
aborted.abort()
assert.equal((await normal.listeners.get('tools/pre-execute')({ name: 'run_code', signal: aborted.signal, agent: { session: normal.session } }, () => { healthyNext++; return { kind: 'allow' } })).kind, 'cancel')
assert.equal(healthyNext, 1, '已中止的 PTC 不得调用下游')
assert.equal(normal.modelCalls, 0)
await normal.effects[0]()
assert.equal(normal.session.mode, 'read-only')
assert.equal(normal.session.policy, 'never')
assert.equal(normal.auto, undefined)
assert.equal(normal.listeners.has('tools/pre-execute'), false)
console.log('PASS unload: canonical read-only narrowing, no approval change, Auto/listener disposed')
