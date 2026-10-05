// Lazy client factory and hooks interaction; does not claim browser deployment.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { rollbackDescriptors } from '../lib/rollback-remote.js'
let client, cursor = 0, tree
let states = [], refs = [], dependencies = [], effects = [], cleanups = []
const react = {
  createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() } },
  useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }] },
  useRef(initial) { const i = cursor++; return refs[i] || (refs[i] = { current: initial }) },
  useEffect(fn, deps) { const i = cursor++; if (!dependencies[i] || deps.some((v, j) => v !== dependencies[i][j])) {
    dependencies[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn() })
  } },
}
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory((id) => { assert.equal(id, 'react'); return react }) } } }, console, Date, Promise, setTimeout,
})
const json = (v) => JSON.parse(JSON.stringify(v))
function shape(v) { return json(v.map((d) => ({ ...d, result: { mode: d.result.mode, typeSymbol: d.result.typeSymbol }, parameters: d.parameters.map((p) => ({ ...p, codec: { mode: p.codec.mode, typeSymbol: p.codec.typeSymbol } })) }))) }
assert.deepEqual(shape(client.rollbackDescriptors), shape(rollbackDescriptors))
for (const d of client.rollbackDescriptors) {
  assert.equal(d.parameters.length, 1); assert.equal(d.parameters[0].name, 'request')
  assert.throws(() => d.parameters[0].codec.create().parse({ sessionId: 's', path: 'C:/arbitrary' }), /UNEXPECTED/)
}
const calls = [], writes = []
let failure, restoreFailure, deferred, sessionId, running = false
const row = (id = 0) => ({ entryId: 'entry-' + id.toString(16).padStart(64, '0'), path: 'fixture<' + id + '>.txt', turns: [1], tools: ['write'], changeType: 'modified', captureStatus: 'before-and-after', preImage: { available: true, existed: true, hash: 'b'.repeat(40) }, current: { status: 'file', bytes: 20, hash: 'a'.repeat(40) }, canRestore: true, reason: '' })
const fakePreview = (request) => ({ ...row(), ...request, nonce: '01234567-0123-4123-8123-012345678901', expectedCurrentHash: 'a'.repeat(40), action: 'restore', diff: { kind: 'text', text: '-<script>fixture</script>\n+new', truncated: false }, diffBasis: '前像与当前，不是完整会话净改动' })
const call = async (method, request) => {
  calls.push({ method, request: json(request) })
  if (failure) throw new Error(failure)
  if (method === 'restore' && restoreFailure) throw new Error(restoreFailure)
  if (method === 'changedFiles') {
    if (deferred) { const pending = deferred; deferred = null; return pending }
    return { sessionId: request.sessionId, rows: request.cursor ? [row(25)] : Array.from({ length: 25 }, (_, i) => row(i)), total: 26, nextCursor: request.cursor ? null : 25, coverage: 'shell未覆盖' }
  }
  if (method === 'preview') return fakePreview(request)
  if (method === 'restore') { writes.push(json(request)); return { sessionId: request.sessionId, entryId: request.entryId, operationId: 'operation', applied: true, recorded: true } }
  throw new Error(method)
}
const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)) }
function render() { cursor = 0; tree = client.ChangedFilesPage({ sessionId, call, running }); while (effects.length) effects.shift()(); return tree }
function nodes(predicate, root = tree) { return root && typeof root === 'object' ? [...(predicate(root) ? [root] : []), ...root.children.flatMap((c) => nodes(predicate, c))] : [] }
function text(root = tree) { return root && typeof root === 'object' ? root.children.map(text).join(' ') : String(root ?? '') }
const button = (label, index = 0) => nodes((n) => n.type === 'button' && text(n) === label)[index]
const click = (label, index) => { const b = button(label, index); assert.ok(b, label); assert.equal(b.props.disabled, false, label); b.props.onClick() }
function reset() { for (const fn of cleanups) fn?.(); states = []; refs = []; dependencies = []; effects = []; cleanups = [] }
render(); await settle(); render(); assert.equal(calls.length, 0); assert.match(text(), /先选择会话/)
console.log('PASS no session performs no RPC')
sessionId = 's1'; render(); await settle(); render(); assert.equal(calls[0].request.sessionId, 's1'); assert.match(text(), /fixture<0>/); assert.equal(writes.length, 0)
click('下一页'); await settle(); render(); assert.equal(calls.at(-1).request.cursor, 25); assert.equal(button('下一页').props.disabled, true); assert.match(text(), /fixture<25>/)
click('上一页'); await settle(); render(); assert.equal(calls.at(-1).request.cursor, 0)
console.log('PASS same-session list / explicit pagination / no mutations on load')
click('查看差异', 0); await settle(); render(); assert.match(text(), /<script>fixture<\/script>/)
assert.equal(nodes((n) => 'dangerouslySetInnerHTML' in n.props || 'innerHTML' in n.props).length, 0)
assert.equal(nodes((n) => n.type === 'pre').length, 1); assert.equal(writes.length, 0)
click('恢复此文件', 0); await settle(); render(); assert.equal(nodes((n) => n.props.role === 'dialog').length, 1); assert.equal(writes.length, 0)
click('取消'); await settle(); render(); assert.equal(nodes((n) => n.props.role === 'dialog').length, 0); assert.equal(writes.length, 0)
console.log('PASS safe text diff / preview only / second confirmation cancel never writes')
click('恢复此文件', 0); await settle(); render(); const previewRequest = calls.at(-1).request
const confirmButton = button('确认恢复'); confirmButton.props.onClick(); confirmButton.props.onClick(); await settle(); render()
assert.equal(writes.length, 1); assert.deepEqual(writes[0], { sessionId: 's1', entryId: previewRequest.entryId, nonce: '01234567-0123-4123-8123-012345678901', expectedCurrentHash: 'a'.repeat(40) })
assert.equal('path' in writes[0], false); assert.equal('force' in writes[0], false); assert.match(text(), /已恢复此文件/)
console.log('PASS mutation only confirm button / exact displayed preview binding / duplicate click once')
failure = 'backend refused'; click('刷新文件'); await settle(); render(); assert.match(text(), /backend refused/); assert.equal(writes.length, 1)
failure = null; click('刷新文件'); await settle(); render()
console.log('PASS failures visible / no mutation on read failures')
restoreFailure = 'PREVIEW_CONFLICT protected later edit'
click('恢复此文件', 0); await settle(); render(); click('确认恢复'); await settle(); render()
assert.equal(writes.length, 1); assert.match(text(), /PREVIEW_CONFLICT/); assert.equal(text().includes('已恢复此文件'), false)
assert.equal(nodes((n) => n.props.role === 'dialog').length, 0)
restoreFailure = null
console.log('PASS restore failure no write / no stale success / consumed confirmation cannot retry automatically')
let resolveOld
const oldPromise = new Promise((resolve) => { resolveOld = resolve })
deferred = oldPromise; click('刷新文件'); await settle()
sessionId = 's2'; render(); assert.equal(text().includes('fixture<'), false); await settle(); render(); assert.match(text(), /会话：s2/)
resolveOld({ sessionId: 's1', rows: [row(999)], total: 1, nextCursor: null, coverage: 'old' }); await settle(); render()
assert.equal(text().includes('fixture<999>'), false); assert.match(text(), /会话：s2/)
console.log('PASS switch immediately clears old view / old delayed request cannot render cross-session data')
click('恢复此文件', 0); await settle(); render(); const oldConfirm = button('确认恢复')
sessionId = 's3'; render(); await settle(); render(); oldConfirm.props.onClick(); await settle(); render(); assert.equal(writes.length, 1)
running = true; render(); await settle(); render(); assert.equal(button('刷新文件').props.disabled, true); assert.equal(nodes((n) => n.props.role === 'dialog').length, 0)
console.log('PASS stale prior-session confirm / running transition never writes')
reset(); sessionId = undefined; cursor = 0; tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, call }); while (effects.length) effects.shift()(); await settle(); assert.equal(tree, null)
reset(); sessionId = 'summary'; cursor = 0; tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, call }); while (effects.length) effects.shift()(); await settle(); cursor = 0; tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, call }); assert.match(text(), /已修改文件：26/); assert.equal(nodes((n) => n.type === 'button').length, 0)
// turnTail 迁移：会话级摘要只在最新收尾轮渲染；无 turn/useChat（旧调用形状）保持原行为。
reset(); sessionId = 'summary'; cursor = 0
const chatOf = (latest) => (selector) => selector({ timeline: { turnOrder: [1, 2, latest] } })
tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, useChat: chatOf(3), turn: 2, call }); while (effects.length) effects.shift()(); await settle()
assert.equal(tree, null, '非最新轮次的单元格不渲染会话级摘要')
tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, useChat: chatOf(3), turn: 3, call }); while (effects.length) effects.shift()(); await settle()
cursor = 0; tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, useChat: chatOf(3), turn: 3, call }); assert.match(text(), /已修改文件：26/, '最新轮次渲染摘要')
reset(); sessionId = 'summary'; failure = 'RPC down'; cursor = 0
tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, call }); while (effects.length) effects.shift()(); await settle()
cursor = 0; tree = client.ChangedFilesSummary({ sessionId, useSession: () => false, call })
assert.equal(tree, null, '读取失败时摘要卡不渲染（错误细节由「已修改文件」Tab 错误态承担）')
assert.equal(text().includes('摘要读取失败'), false)
failure = null; reset()
console.log('PASS completion summary scoped and readonly')
const registrations = [], effects2 = []
const ctx = {
  locale: { register() { return () => {} }, bind() { return (k) => client.dictionaries.zh[k] || k } },
  remote: { $mount() { return Promise.resolve(() => {}) } }, get() {},
  effect(fn) { const value = fn(); effects2.push(value); return value },
  slots: { spec() {}, inject(name, factory) { const dispose = factory(); effects2.push(dispose); return dispose }, register(options, component) { registrations.push({ options, component }); return () => {} } },
}
client.apply(ctx)
assert.deepEqual(registrations.map(({ options }) => [options.name, options.id]), [
  ['settings.plugins.tab', 'audit-rollback-tab'], ['conversation.view', 'dsh-guard.changed-files'], ['conversation.chat.turnTail', 'dsh-guard.changed-files-summary'],
])
for (const value of effects2.reverse()) { const fn = await value; if (typeof fn === 'function') fn() }
console.log('PASS fresh legal session Tab/dock IDs / unchanged single settings entry / descriptor equality')
console.log('rollback-ui: all passed (VM not live browser)')
