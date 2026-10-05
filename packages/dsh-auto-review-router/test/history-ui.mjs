// Real browser factory + deterministic source/React harness. No model or profile writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseHistoryRequest as hostRequest, parseHistoryRecord as hostRecord, parseHistoryResult as hostResult } from '../lib/approval-history.js'
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function factory(react = { createElement() {} }) {
  let ui
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) { ui = factory(id => { assert.equal(id, 'react'); return react }) } } },
    console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout, AbortController, Date, Promise,
  })
  return ui
}
const ui = factory()
const normalizeFunction = fn => String(fn).replace(/\s+/g, ' ').trim()
assert.equal(normalizeFunction(ui.parseHistoryRequest), normalizeFunction(hostRequest), 'request parser must mirror Host exactly')
assert.equal(normalizeFunction(ui.parseHistoryRecord), normalizeFunction(hostRecord), 'record parser must mirror Host exactly')
assert.equal(normalizeFunction(ui.parseHistoryResult), normalizeFunction(hostResult), 'result parser must mirror Host exactly')
const serial = value => JSON.parse(JSON.stringify(value))
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const uuid = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const health = patch => ({ ready: true, gap: false, writeFailures: 0, readFailures: 0, droppedRecords: 0, corruptRecords: 0, missingProfile: false, closing: false, lastErrorCode: null, ...patch })
const record = (seq, patch = {}) => ({ schemaVersion: 1, eventId: uuid(seq), time: 1700000000000 + seq, ledgerSeq: seq, dispatchId: uuid(100), sessionId: 'A', turn: 1, step: 2, callId: 'call', rootCallId: 'call', toolName: 'write', phase: 'reviewer', outcome: 'allow', ...patch })
const page = (records = [], nextCursor = null, gap) => ({ records, nextCursor, health: health(gap) })
function timers() {
  let next = 0; const pending = new Map()
  return { pending, setTimeout(fn, ms) { assert.equal(ms, 2500); pending.set(++next, fn); return next }, clearTimeout(id) { pending.delete(id) }, async tick() { const [id, fn] = pending.entries().next().value; pending.delete(id); fn(); await flush() } }
}
// Parsers agree with Host for successful and rejected wire values, including unknown/raw fields.
for (const value of [{ sessionId: 'A' }, { sessionId: 'A', limit: 100, cursor: 'abc_12-' }, {}, { sessionId: '' }, { sessionId: 'A', limit: 0 }, { sessionId: 'A', limit: 101 }, { sessionId: 'A', cursor: '@' }, { sessionId: 'A', args: 'secret' }]) {
  for (const parse of [hostRequest, ui.parseHistoryRequest]) {
    try { const result = parse(value); assert.deepEqual(serial(result), serial(hostRequest(value))) }
    catch { assert.throws(() => hostRequest(value)); assert.throws(() => ui.parseHistoryRequest(value)) }
  }
}
for (const value of [record(1), record(2, { phase: 'manual', outcome: 'requested', approvalRequestId: uuid(300), deadlineAt: 1700000060000 }), record(3, { phase: 'manual', outcome: 'cancelled', cause: 'timeout' }), record(4, { turn: null, step: null, callId: '', rootCallId: '' }), record(5, { args: 'never publish' }), record(6, { eventId: 'bad' }), record(7, { reasonSummary: 'x'.repeat(241) }), record(8, { phase: 'manual', outcome: 'allowed' })]) {
  let valid = true; try { hostRecord(value) } catch { valid = false }
  if (valid) assert.deepEqual(serial(ui.parseHistoryRecord(value)), serial(hostRecord(value)))
  else assert.throws(() => ui.parseHistoryRecord(value))
}
for (const value of [{ ok: true, value: page([record(1)]) }, { ok: false, error: { code: 'history-unavailable', message: 'unavailable' } }, { ok: true, value: page([], null, { gap: true, missingProfile: true }) }, { ok: true, value: { ...page(), prompt: 'secret' } }, { ok: true, value: page([record(2, { rawArgs: 'secret' })]) }, { ok: false, error: { code: 'other', message: 'fail' } }]) {
  let valid = true; try { hostResult(value) } catch { valid = false }
  if (valid) assert.deepEqual(serial(ui.parseHistoryResult(value)), serial(hostResult(value)))
  else assert.throws(() => ui.parseHistoryResult(value))
}
assert.equal(/require\(['"](?:node:|\.\/)|dangerouslySetInnerHTML|tool\.call\.toolview|querySelector/.test(source), false)
console.log('PASS history strict Host/client codecs, no Node dependency/raw payload/renderer/DOM scanning')

// Tab+dock share one RPC and one poller. Re-read loaded page depth on polls to avoid skipped records.
{
  const clock = timers(), calls = [], first = deferred()
  let phase = 0
  const store = ui.createHistoryStore(async (query, signal) => {
    calls.push({ query: serial(query), signal })
    if (!phase) return first.promise
    return query.cursor ? page([record(1)], null) : page([record(3), record(2)], 'older')
  }, clock)
  const a = store.source('A'), b = store.source('A'); assert.equal(a, b)
  assert.equal(a.getSnapshot().status, 'idle'); assert.equal(a.getSnapshot().health, null)
  const stopTab = a.subscribe(() => {}), stopDock = b.subscribe(() => {})
  assert.equal(calls.length, 1); assert.equal(clock.pending.size, 0)
  first.resolve(page([record(2)], 'older')); await flush()
  assert.equal(a.getSnapshot().status, 'ready'); assert.equal(clock.pending.size, 1)
  phase = 1; await a.older()
  assert.deepEqual(serial(a.getSnapshot().records.map(row => row.ledgerSeq)), [2, 1]); assert.equal(a.getSnapshot().nextCursor, null)
  await clock.tick()
  assert.deepEqual(serial(a.getSnapshot().records.map(row => row.ledgerSeq)), [3, 2, 1]); assert.equal(clock.pending.size, 1)
  assert.deepEqual(calls.slice(-2).map(row => row.query.cursor), [undefined, 'older'])
  await a.refresh(); assert.deepEqual(serial(a.getSnapshot().records.map(row => row.ledgerSeq)), [3, 2]); assert.equal(a.getSnapshot().nextCursor, 'older')
  stopTab(); assert.equal(clock.pending.size, 1)
  stopDock(); assert.equal(clock.pending.size, 0); assert.equal(a.getSnapshot().status, 'idle')
  store.dispose(); const count = calls.length; await a.refresh(); await a.older(); assert.equal(calls.length, count)
}
console.log('PASS single shared source/poller, real pagination/refresh, poll depth continuity, last-subscriber cleanup')

// Switching session/unmount invalidates pending reads; none may paint a new session or restart polling.
{
  const clock = timers(), pendingA = deferred(), pendingB = deferred(), calls = []
  const store = ui.createHistoryStore((query, signal) => { calls.push({ query, signal }); return query.sessionId === 'A' ? pendingA.promise : pendingB.promise }, clock)
  const a = store.source('A'), stopA = a.subscribe(() => {})
  stopA(); assert.equal(calls[0].signal.aborted, true)
  const b = store.source('B'), stopB = b.subscribe(() => {})
  pendingB.resolve(page([record(4, { sessionId: 'B' })])); await flush()
  pendingA.resolve(page([record(1)])); await flush()
  assert.equal(a.getSnapshot().records.length, 0); assert.equal(b.getSnapshot().records[0].sessionId, 'B')
  assert.equal(clock.pending.size, 1)
  store.dispose(); assert.equal(clock.pending.size, 0); assert.equal(b.getSnapshot().status, 'disposed')
  stopB(); const c = store.source('C'); c.subscribe(() => {}); assert.equal(c.getSnapshot().status, 'disposed'); assert.equal(calls.length, 2)
}
{
  const clock = timers(); let fail = false, pending, calls = 0
  const store = ui.createHistoryStore(async () => { calls++; if (pending) return pending.promise; if (fail) throw Object.assign(new Error('never show raw server detail'), { code: 'session-unavailable' }); return page([record(1)]) }, clock)
  const a = store.source('A'); const stop = a.subscribe(() => {}); await flush()
  fail = true; await a.refresh(); assert.equal(a.getSnapshot().error, 'session-unavailable'); assert.equal(a.getSnapshot().records.length, 1)
  fail = false; pending = deferred(); const obsolete = a.refresh(); const replacement = a.refresh()
  pending.resolve(page([record(5)])); await Promise.all([obsolete, replacement]); assert.equal(a.getSnapshot().records[0].ledgerSeq, 5)
  stop(); assert.equal(clock.pending.size, 0); store.dispose()
}
{
  const store = ui.createHistoryStore(async () => page([record(1, { sessionId: 'B' })]), timers())
  const a = store.source('A'); const stop = a.subscribe(() => {}); await flush()
  assert.equal(a.getSnapshot().status, 'error'); assert.equal(a.getSnapshot().health, null); assert.equal(a.getSnapshot().records.length, 0)
  stop(); store.dispose()
}
console.log('PASS session isolation, request abortion/generations, retained error records, cross-session refusal, unload callbacks')

// Real registered components, safe React text, unknown execution and no ambiguous inspect/allow buttons.
function renderer(language = 'zh') {
  let subscribed
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) } },
    useSyncExternalStore(subscribe, snapshot) { subscribed = subscribe; return snapshot() },
  }
  const client = factory(react), t = key => client.dictionaries[language][key] || key
  const walk = node => typeof node === 'object' && node ? [node, ...node.children.flatMap(walk)] : []
  const text = node => typeof node === 'object' && node ? node.children.map(text).join(' ') : String(node)
  function render(state, session = { blank: false }, sessionId = 'A', component = 'HistoryView') {
    const history = { source(id) { return { subscribe() {}, getSnapshot: () => id ? state : { sessionId: null, status: 'sessionless', records: [], nextCursor: null, health: null, error: '' }, refresh() {}, older() {} } } }
    const tree = client[component]({ sessionId, useSession: fn => fn(session), history, t, inspectCall() { throw new Error('DTO has no global uniqueness proof') } })
    return { tree, nodes: walk(tree), text: text(tree), subscribed }
  }
  return { client, render }
}
for (const language of ['zh', 'en']) {
  const r = renderer(language)
  const records = [record(5, { phase: 'manual', outcome: 'cancelled', cause: 'timeout', risk: 'high' }), record(4, { phase: 'manual', outcome: 'requested' }), record(3, { phase: 'downstream', outcome: 'ask' }), record(2, { phase: 'reviewer', outcome: 'deny', reasonSummary: '<img src=x onerror=alert(1)>', route: 'provider/model/high' })]
  const state = { sessionId: 'A', status: 'ready', records, nextCursor: 'older', health: health(), error: '' }
  const view = r.render(state)
  assert.equal(view.nodes.filter(row => row.type === 'article').length, 1, 'same dispatch aggregates phase rows')
  assert.ok(view.text.includes('<img src=x onerror=alert(1)>')); assert.equal(view.nodes.some(row => row.type === 'img'), false)
  assert.ok(view.text.includes(r.client.dictionaries[language].historyTimeout))
  assert.ok(view.text.includes(r.client.dictionaries[language].history_manual_requested))
  assert.ok(view.text.includes('provider/model/high')); assert.ok(view.text.includes(r.client.dictionaries[language].historyExecutionNote))
  assert.equal(view.nodes.some(row => /inspect|allow/i.test(row.props['aria-label'] || '')), false)
  assert.equal(view.nodes.filter(row => row.type === 'button').length, 2, 'only refresh and pagination; never manual allow/inspect')
  assert.ok(r.render(state, { blank: true }).text.includes(r.client.dictionaries[language].historyBlank))
  assert.ok(r.render(state, null, null).text.includes(r.client.dictionaries[language].historyNoSession))
  const pending = r.render({ ...state, status: 'loading', records: [], health: null }); assert.equal(pending.text.includes(r.client.dictionaries[language].historyEmpty), false)
  const error = r.render({ ...state, status: 'error', records: [], health: null, error: 'history-unavailable' }); assert.equal(error.text.includes(r.client.dictionaries[language].historyEmpty), false)
  assert.ok(r.render({ ...state, records: [], nextCursor: null }).text.includes(r.client.dictionaries[language].historyEmpty))
  const gap = r.render({ ...state, records: [], nextCursor: null, health: health({ gap: true, corruptRecords: 1 }) }); assert.ok(gap.text.includes(r.client.dictionaries[language].historyGap)); assert.equal(gap.text.includes(r.client.dictionaries[language].historyEmpty), false)
  assert.ok(r.render(state, { blank: false }, 'A', 'HistoryDock').text.includes(r.client.dictionaries[language].historyTimeout))
  assert.ok(r.render({ ...state, records: [record(1)] }, { blank: false }, 'A', 'HistoryDock').text.includes(r.client.dictionaries[language].historyExecutionNote))
  assert.equal(r.render(state, { blank: true }, 'A', 'HistoryDock').tree, null)
}
console.log('PASS actual history/dock: safe text, dispatch stages/manual timeout, unknown execution, no-session/blank/loading/error/empty/gap')

// Actual plugin mount and registered injection share a live RPC source. No fabricated empty success.
{
  const client = factory(), registrations = [], effects = [], mounts = [], requests = []
  let response = { ok: true, value: page([record(1)]) }
  const service = { async history(request) { requests.push(serial(request)); return response } }
  const ctx = {
    locale: { register() { return () => {} }, bind() { return key => client.dictionaries.zh[key] || key } },
    remote: { $mount(descriptor) { mounts.push(descriptor); return Promise.resolve(() => {}) } },
    effect(fn) { const value = fn(); effects.push(value); return value },
    get(key) { if (key === 'remote.autoReviewRouter') return service; return undefined },
    slots: { spec() { return undefined }, inject(slot, fn) { const off = fn(); effects.push(off) }, register(options, component) { const row = { options, component }; registrations.push(row); return () => registrations.splice(registrations.indexOf(row), 1) } },
  }
  client.apply(ctx)
  assert.deepEqual(registrations.map(row => row.options.name), ['settings.plugins.tab', 'conversation.view', 'conversation.composer.dock'])
  assert.equal(registrations.filter(row => row.options.name === 'settings.plugins.tab').length, 1)
  const tab = registrations[1].options.inject(), dock = registrations[2].options.inject()
  assert.equal(tab.history, dock.history); assert.equal(requests.length, 0)
  const history = tab.history.source('A'), offTab = history.subscribe(() => {}), offDock = history.subscribe(() => {}); await flush()
  assert.equal(requests.length, 1); assert.deepEqual(requests[0], { sessionId: 'A', limit: 50 })
  assert.equal(history.getSnapshot().records.length, 1)
  response = { ok: false, error: { code: 'session-unavailable', message: 'unavailable' } }; await history.refresh()
  assert.equal(history.getSnapshot().status, 'error'); assert.equal(history.getSnapshot().error, 'session-unavailable')
  const descriptor = mounts[0].descriptors.find(row => row.method === 'history')
  assert.equal(descriptor.id, 'dsh-auto-review-router#autoReviewRouter/history')
  assert.deepEqual(serial(descriptor.parameters.map(({ name, wire, source, codec }) => ({ name, wire, source, mode: codec.mode, typeSymbol: codec.typeSymbol }))), [{ name: 'request', wire: 'request', source: 'json', mode: 'strict', typeSymbol: 'dsh-auto-review-router#ApprovalHistoryRequest' }])
  assert.equal(descriptor.result.typeSymbol, 'dsh-auto-review-router#ApprovalHistoryResult')
  assert.equal(descriptor.result.create().parse, client.parseHistoryResult)
  for (const value of effects.reverse()) { const off = await value; if (typeof off === 'function') await off() }
  assert.equal(registrations.length, 0); assert.equal(history.getSnapshot().status, 'disposed')
  const count = requests.length; await history.refresh(); assert.equal(requests.length, count); offTab(); offDock()
}
console.log('PASS real apply/descriptor/RPC, unique settings + legal fallback, shared sources and uninstall lifecycle')
