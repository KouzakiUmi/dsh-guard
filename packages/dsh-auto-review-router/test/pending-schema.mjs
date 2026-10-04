// Protocol-shape regression: actual installed SDK createExecution + shipped router gate.
// No live tools, model, profile, or approval policy is changed.
import './runtime.mjs'
import assert from 'node:assert/strict'
// Dynamic imports run after the installed-SDK resolver hooks are registered.
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { apply } = await import('../lib/index.js')
import { pendingActionOf } from '../lib/context.js'

const schemaOf = name => ({ name, description: `HEADER ${name}`, parameters: { type: 'object', properties: { path: { type: 'string' } } } })
function execution(name, session, extra = {}) {
  const runtime = {
    get() { return {} }, collapses() { return false }, concludingExecutions: new Set(),
    deferredContexts: new WeakMap(), contentFinalizers: new WeakMap(),
    contentProjectors: new WeakMap(), cancellationStates: new WeakMap(),
  }
  const created = ToolRuntime.prototype.createExecution.call(runtime, {
    name, callId: 'call-1', arguments: { path: 'a.txt' }, agent: { session }, signal: new AbortController().signal, ...extra,
  })
  assert.equal(created.kind, 'ready', 'actual SDK execution creation must succeed')
  assert.ok(Object.isFrozen(created.exec.arguments))
  return created.exec
}
async function review({ name = 'edit', header, extra = {}, verdict = 'allow', throwsHeader = false } = {}) {
  let headerReads = 0, streams = 0, bodies = 0, request, listener
  const session = {
    header: { cwd: process.cwd() }, snapshotEvents() { return [] },
    requestHeader() { headerReads++; if (throwsHeader) throw new Error('header unavailable'); return header },
  }
  const ctx = {
    logger: { info() {}, warn() {} }, approval: { overrideOf() { return 'never' } },
    permissionPresets: { current() { return 'auto' }, registerAuto() { return () => {} } },
    llm: { stream(value) {
      streams++; request = value
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ risk: verdict === 'deny' ? 'high' : 'low', decision: verdict }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } },
    on(name, fn) { if (name === 'tools/pre-execute') listener = fn; return () => {} },
  }
  apply(ctx, { enabled: true, reviewerProvider: 'test-provider', reviewerModel: 'test-model', logDecisions: false })
  const exec = execution(name, session, extra)
  const outcome = await listener(exec, async () => { bodies++; return { kind: 'allow' } })
  return { exec, outcome, streams, bodies, headerReads, request }
}
const headerOf = (...tools) => ({ config: { provider: 'session-provider', model: 'session-model' }, tools })

// Actual native SDK executions do NOT synthesize a schema; old router rejected this shape.
for (const name of ['write', 'read', 'pwsh', 'memory_status']) {
  const schema = schemaOf(name)
  const result = await review({ name, header: headerOf(schema) })
  assert.equal(Object.hasOwn(result.exec, 'schema'), false)
  assert.equal(result.outcome.kind, 'allow')
  assert.equal(result.streams, 1)
  assert.equal(result.bodies, 1)
  assert.equal(result.headerReads, 1, 'route and schema must use one request-header snapshot')
  assert.ok(result.request.messages[0].content[0].text.includes(`HEADER ${name}`))
  assert.deepEqual(pendingActionOf(result.exec, headerOf(schema)).parameters, schema.parameters)
}
console.log('PASS actual SDK native shape: write/read/pwsh/memory_status, header schema, one snapshot, no invented exec.schema')

// Native headers are authoritative: never consult registry/global/fabricated exec schema.
{
  const forged = { ...schemaOf('edit'), description: 'DO NOT USE EXEC SCHEMA' }
  const result = await review({ header: headerOf(schemaOf('edit')), extra: { schema: forged } })
  assert.equal(result.outcome.kind, 'allow')
  assert.ok(!result.request.messages[0].content[0].text.includes(forged.description))
}
for (const header of [undefined, {}, headerOf(), headerOf(schemaOf('other')), headerOf(schemaOf('edit'), schemaOf('edit'))]) {
  const result = await review({ header, extra: { schema: schemaOf('edit') } })
  assert.equal(result.outcome.kind, 'deny')
  assert.equal(result.streams, 0)
  assert.equal(result.bodies, 0)
  assert.match(result.outcome.reason, /schema is missing or ambiguous/)
}
{
  const result = await review({ throwsHeader: true })
  assert.equal(result.outcome.kind, 'deny')
  assert.equal(result.streams, 0)
  assert.equal(result.bodies, 0)
}
for (const parameters of [undefined, null, [], 'bad']) {
  const result = await review({ header: headerOf({ ...schemaOf('edit'), parameters }) })
  assert.equal(result.outcome.kind, 'deny')
  assert.equal(result.streams, 0)
  assert.equal(result.bodies, 0)
  assert.match(result.outcome.reason, /schema is incomplete/)
}
for (const description of [undefined, null, 42]) {
  const result = await review({ header: headerOf({ ...schemaOf('edit'), description }) })
  assert.equal(result.outcome.kind, 'deny')
  assert.equal(result.streams, 0)
  assert.equal(result.bodies, 0)
}
console.log('PASS native missing/duplicate/wrong-name/unreadable/incomplete schemas fail closed; no empty-parameter fallback')

// PTC inner bindings retain their schema even when header only exposes run_code.
{
  const binding = { ...schemaOf('edit'), description: 'PTC BINDING' }
  const result = await review({ header: headerOf(schemaOf('run_code')), extra: { parent: {}, schema: binding } })
  assert.equal(result.outcome.kind, 'allow')
  assert.equal(result.streams, 1)
  assert.equal(result.bodies, 1)
  assert.equal(pendingActionOf(result.exec).mode, 'ptc-inner')
  assert.ok(result.request.messages[0].content[0].text.includes(binding.description))
}
for (const schema of [undefined, null, [], schemaOf('other'), { ...schemaOf('edit'), parameters: undefined }]) {
  const result = await review({ header: headerOf(schemaOf('edit')), extra: { parent: {}, schema } })
  assert.equal(result.outcome.kind, 'deny')
  assert.equal(result.streams, 0)
  assert.equal(result.bodies, 0, 'PTC must not fall back to a native header schema')
}
{
  const result = await review({ header: headerOf(schemaOf('edit')), verdict: 'deny' })
  assert.equal(result.outcome.kind, 'deny')
  assert.equal(result.streams, 1)
  assert.equal(result.outcome.info?.code, 'AUTO_REVIEW_DENIED', 'a valid reviewer denial must not be confused with parser failure')
  assert.equal(result.bodies, 0, 'fixing schema must not bypass the reviewer decision')
}
console.log('PASS PTC binding identity/completeness and reviewer-deny safety boundaries')
