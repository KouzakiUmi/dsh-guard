import './runtime.mjs'
import assert from 'node:assert/strict'
const { Config, DEFAULT_CONFIG, normalizeConfig } = await import('../lib/config.js')
assert.equal(Config({}).get().manualFallback, true)
assert.equal(Config({}).get().manualApprovalTimeoutMs, 60000)
assert.deepEqual(Config({}).get(), DEFAULT_CONFIG)
// Schemastery .default treats null as absent; retain the SDK's default semantics.
assert.equal(Config({ manualApprovalTimeoutMs: null }).get().manualApprovalTimeoutMs, 60000)
for (const value of [999, 300001, 1.5, Infinity, NaN, '60000']) {
  assert.throws(() => Config({ manualApprovalTimeoutMs: value }), `invalid manual timeout ${String(value)}`)
  assert.equal(normalizeConfig({ manualApprovalTimeoutMs: value }).manualApprovalTimeoutMs, 60000)
}
for (const value of [1000, 60000, 300000]) {
  assert.equal(Config({ manualApprovalTimeoutMs: value }).get().manualApprovalTimeoutMs, value)
  assert.equal(normalizeConfig({ manualApprovalTimeoutMs: value }).manualApprovalTimeoutMs, value)
}
assert.equal(Config({ manualFallback: false }).get().manualFallback, false)
assert.throws(() => Config({ manualFallback: 'yes' }))
const snapshot = normalizeConfig({ manualFallback: false, manualApprovalTimeoutMs: 2000 })
assert.ok(Object.isFrozen(snapshot))
assert.equal(snapshot.manualFallback, false)
assert.equal(snapshot.manualApprovalTimeoutMs, 2000)
console.log('PASS manual fallback configuration defaults, strict range/types and immutable per-operation snapshot')
