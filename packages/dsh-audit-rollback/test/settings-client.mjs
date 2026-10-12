#!/usr/bin/env node
// Zero-build client VM interaction test. Hook/element harness, not a browser rendering claim.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const state = []
const effects = []
const dependencies = []
let cursor = 0
const react = {
  createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() } },
  useState(initial) {
    const index = cursor++
    if (!(index in state)) state[index] = initial
    return [state[index], (value) => { state[index] = value }]
  },
  useEffect(fn, deps) {
    const index = cursor++
    if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) {
      dependencies[index] = deps
      effects.push(fn)
    }
  },
  useCallback(fn) { return fn },
}
let client
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory((id) => { assert.equal(id, 'react'); return react }) } } },
  console, setTimeout, Date, Promise,
})
// 阶段 B 契约：全部 16 个可编辑字段（stateDir 只读，永不在此）。
const defaultValue = {
  captureTools: ['write'], captureMaxBytes: 2097152, argsMaxBytes: 4096, logCalls: true, excludeGlobs: [],
  gitSnapshot: false, snapshotMode: 'per-step', snapshotExcludeGlobs: [], snapshotIgnorePolicy: 'git',
  snapshotMaxFiles: 50000, snapshotMaxBytes: 536870912, snapshotScanMs: 5000, snapshotTimeoutMs: 10000,
  snapshotAutoExcludeOversized: false, rollbackOnAbort: 'prompt', snapshotRetentionDays: 14,
}
const validDraft = {
  captureTools: 'write', captureMaxBytes: '1', argsMaxBytes: '1', logCalls: true, excludeGlobs: '',
  gitSnapshot: false, snapshotMode: 'per-step', snapshotExcludeGlobs: '', snapshotIgnorePolicy: 'git',
  snapshotMaxFiles: '1', snapshotMaxBytes: '1', snapshotScanMs: '1', snapshotTimeoutMs: '1',
  snapshotAutoExcludeOversized: false, rollbackOnAbort: 'prompt', snapshotRetentionDays: '0',
}
const parsed = client.validateDraft({
  captureTools: 'write\nedit', captureMaxBytes: '10', argsMaxBytes: '20', logCalls: false, excludeGlobs: '',
  gitSnapshot: true, snapshotMode: 'per-turn', snapshotExcludeGlobs: '\n/a/\n\n/b/', snapshotIgnorePolicy: 'force',
  snapshotMaxFiles: '7', snapshotMaxBytes: '8', snapshotScanMs: '9', snapshotTimeoutMs: '10',
  snapshotAutoExcludeOversized: true, rollbackOnAbort: 'auto', snapshotRetentionDays: '0',
})
assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
  captureTools: ['write', 'edit'], captureMaxBytes: 10, argsMaxBytes: 20, logCalls: false, excludeGlobs: [],
  gitSnapshot: true, snapshotMode: 'per-turn', snapshotExcludeGlobs: ['/a/', '/b/'], snapshotIgnorePolicy: 'force',
  snapshotMaxFiles: 7, snapshotMaxBytes: 8, snapshotScanMs: 9, snapshotTimeoutMs: 10,
  snapshotAutoExcludeOversized: true, rollbackOnAbort: 'auto', snapshotRetentionDays: 0,
})
for (const n of ['0', '-2', '1.5', 'NaN', '9007199254740992']) {
  assert.throws(() => client.validateDraft({ ...validDraft, captureMaxBytes: n }), /positive safe integer/)
  assert.throws(() => client.validateDraft({ ...validDraft, snapshotMaxFiles: n }), /positive safe integer/)
}
for (const n of ['-1', '1.5', 'NaN', '9007199254740992']) {
  assert.throws(() => client.validateDraft({ ...validDraft, snapshotRetentionDays: n }), /non-negative safe integer/)
}
// 枚举非法值（含缺失）必须抛错；取值集合逐字固定。
assert.throws(() => client.validateDraft({ ...validDraft, snapshotMode: 'per-hour' }), /allowed choice/)
assert.throws(() => client.validateDraft({ ...validDraft, snapshotIgnorePolicy: 'never' }), /allowed choice/)
assert.throws(() => client.validateDraft({ ...validDraft, rollbackOnAbort: 'sometimes' }), /allowed choice/)
assert.throws(() => client.validateDraft({ ...validDraft, rollbackOnAbort: undefined }), /allowed choice/)
assert.throws(() => client.validateDraft({ ...validDraft, captureTools: '' }), /at least one/)
assert.throws(() => client.unwrapSettings({ ok: false, error: { code: 'settings/conflict', message: 'stale' } }), (e) => e.code === 'settings/conflict')
console.log('通过 client list parsing / enum & numeric validation (incl. new phase-B fields) / conflict code preservation')
let revision = 3
let value = structuredClone(defaultValue)
let refusal
const writes = []
const settingsCall = async (method, ns, patch, expected) => {
  if (method === 'describe') return { writable: true, namespaces: [{ ns: 'audit-rollback', revision, value: structuredClone(value) }] }
  assert.equal(method, 'update'); assert.equal(ns, 'audit-rollback')
  writes.push({ patch, expected })
  if (refusal) { const error = new Error(refusal.message); error.code = refusal.code; throw error }
  value = JSON.parse(JSON.stringify(patch)); revision++
  return { ns, revision, value: structuredClone(value) }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
let tree
let refreshed = 0
let language = 'en'
const t = (key) => client.dictionaries[language][key] || key
const onSaved = () => { refreshed++; throw new Error('diagnostics refresh failed') }
function render() {
  cursor = 0
  tree = client.SettingsEditor({ settingsCall, t, onSaved })
  while (effects.length) effects.shift()()
  return tree
}
function nodes(predicate, root = tree) {
  if (!root || typeof root !== 'object') return []
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => nodes(predicate, child))]
}
function input(key) { return nodes((n) => n.props['aria-label'] === key)[0] }
function text(root = tree) { return root && typeof root === 'object' ? root.children.map(text).join(' ') : String(root || '') }
function submit() { nodes((n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }) }
render(); await settle(); render()
assert.equal(input('captureMaxBytes').props.value, '2097152')
assert.equal(input('snapshotMaxBytes').props.value, '536870912')
assert.equal(input('snapshotRetentionDays').props.value, '14')
assert.equal(input('snapshotScanMs').props.value, '5000')
assert.equal(input('snapshotTimeoutMs').props.value, '10000')
assert.equal(input('snapshotMaxFiles').props.value, '50000')
assert.equal(input('snapshotMode').props.value, 'per-step')
assert.equal(input('snapshotIgnorePolicy').props.value, 'git')
assert.equal(input('rollbackOnAbort').props.value, 'prompt')
assert.equal(input('gitSnapshot').props.checked, false)
assert.equal(input('snapshotAutoExcludeOversized').props.checked, false)
assert.equal(input('snapshotExcludeGlobs').props.value, '')
assert.ok(text().includes('gitSnapshot'))
assert.equal(nodes((n) => n.props['aria-label'] === 'stateDir').length, 0)
input('captureMaxBytes').props.onChange({ target: { value: '16' } })
render(); submit(); await settle(); render()
assert.equal(writes.length, 1)
assert.equal(writes[0].expected, 3)
// 写回 patch 必须是全部 16 个可编辑字段，且值精确；stateDir 不入 patch。
assert.deepEqual(Object.keys(writes[0].patch).sort(), [
  'argsMaxBytes', 'captureMaxBytes', 'captureTools', 'excludeGlobs', 'gitSnapshot', 'logCalls',
  'rollbackOnAbort', 'snapshotAutoExcludeOversized', 'snapshotExcludeGlobs', 'snapshotIgnorePolicy',
  'snapshotMaxBytes', 'snapshotMaxFiles', 'snapshotMode', 'snapshotRetentionDays', 'snapshotScanMs', 'snapshotTimeoutMs',
].sort())
assert.deepEqual(JSON.parse(JSON.stringify(writes[0].patch)), { ...defaultValue, captureMaxBytes: 16 })
assert.equal('stateDir' in writes[0].patch, false)
assert.equal(writes[0].patch.gitSnapshot, false)
assert.ok(nodes((n) => n.props.role === 'status').length)
assert.equal(refreshed, 1)
assert.equal(nodes((n) => n.props.role === 'alert').length, 0, 'status refresh failure must not be reported as save failure')
console.log('通过 edit / official update / draft revision / save feedback / full 16-field patch without stateDir')
// 新控件：复选框与下拉枚举可编辑并写回（每次变更后重渲染，模拟受控组件刷新）。
input('gitSnapshot').props.onChange({ target: { checked: true } }); render()
input('snapshotMode').props.onChange({ target: { value: 'per-turn' } }); render()
input('snapshotAutoExcludeOversized').props.onChange({ target: { checked: true } }); render()
input('rollbackOnAbort').props.onChange({ target: { value: 'auto' } }); render()
input('snapshotExcludeGlobs').props.onChange({ target: { value: '/big/\n\n/tmp/' } }); render()
submit(); await settle(); render()
assert.equal(writes.length, 2)
assert.equal(writes[1].expected, 4)
assert.deepEqual(JSON.parse(JSON.stringify(writes[1].patch)), {
  ...defaultValue, captureMaxBytes: 16, gitSnapshot: true, snapshotMode: 'per-turn',
  snapshotAutoExcludeOversized: true, rollbackOnAbort: 'auto', snapshotExcludeGlobs: ['/big/', '/tmp/'],
})
assert.equal(input('gitSnapshot').props.checked, true)
assert.equal(input('snapshotMode').props.value, 'per-turn')
console.log('通过 checkbox / select / multiline phase-B controls write back through the official update')

input('captureMaxBytes').props.onChange({ target: { value: '0' } }); render(); submit(); await settle(); render()
assert.equal(writes.length, 2)
assert.ok(text().includes('positive safe integer'))
input('snapshotMaxFiles').props.onChange({ target: { value: '-3' } }); render(); submit(); await settle(); render()
assert.equal(writes.length, 2)
assert.ok(text().includes('positive safe integer'))
input('snapshotMaxFiles').props.onChange({ target: { value: '50000' } }); render()
input('captureMaxBytes').props.onChange({ target: { value: '25' } }); render()
refusal = { code: 'settings/rejected', message: 'disk persistence refused' }
submit(); await settle(); render()
assert.ok(text().includes('disk persistence refused'))
assert.equal(input('captureMaxBytes').props.value, '25')
console.log('通过 validation prevents write / persistence error visible / failed save preserves draft')

refusal = { code: 'settings/conflict', message: 'new revision' }; revision++
submit(); await settle(); render()
assert.ok(text().includes('Stale revision'))
assert.equal(input('captureMaxBytes').props.value, '25')
assert.equal(writes.at(-1).expected, 5)
const cancel = nodes((n) => n.type === 'button' && text(n).includes('Cancel'))[0]
cancel.props.onClick(); await settle(); render()
assert.equal(input('captureMaxBytes').props.value, '16')
assert.equal(input('gitSnapshot').props.checked, true)
assert.equal(input('snapshotMode').props.value, 'per-turn')
refusal = undefined
input('argsMaxBytes').props.onChange({ target: { value: '30' } }); render(); submit(); await settle(); render()
assert.equal(writes.at(-1).expected, 6)
console.log('通过 conflict refuses stale overwrite / cancel re-reads / retry uses fresh revision')
language = 'zh'; render()
assert.ok(text().includes('捕获策略设置'))
assert.ok(text().includes('单文件捕获上限'))
assert.ok(text().includes('取消并重新读取'))
assert.equal(text().includes('Cancel & reload'), false)
assert.ok(text().includes('快照粒度'))
assert.ok(text().includes('中断后回滚联动'))
assert.ok(text().includes('阶段 B 总开关'))
input('captureMaxBytes').props.onChange({ target: { value: '0' } }); render(); submit(); await settle(); render()
assert.ok(text().includes('必须是正安全整数'))
input('captureMaxBytes').props.onChange({ target: { value: '16' } }); render()
input('snapshotRetentionDays').props.onChange({ target: { value: '-1' } }); render(); submit(); await settle(); render()
assert.ok(text().includes('必须是非负安全整数'))
console.log('通过 zh/en dictionaries / Chinese labels and validation / no bilingual concatenation')

// 只读状态区：host 侧新增的 shadow / snapshotStats 缺失时不得抛错，显示「未知/未启用」。
const baseStatus = {
  plugin: 'dsh-audit-rollback',
  state: { stateDir: '/tmp/audit' },
  ledger: { entryCount: 2, byKind: { call: 1 } },
  objects: { count: 3, totalBytes: 100 },
  captures: { recent: [], uniquePaths: 1 },
  config: { captureTools: ['write'], gitSnapshot: false },
}
async function renderStatusPage(statusValue) {
  const call = async (method) => { assert.equal(method, 'read'); return structuredClone(statusValue) }
  const settingsStub = async () => { throw new Error('status test must not call settings') }
  cursor = 0; state.length = 0; effects.length = 0; dependencies.length = 0
  tree = client.AuditPage({ call, settingsCall: settingsStub, t })
  while (effects.length) effects.shift()()
  await settle(); await settle()
  cursor = 0
  const pageTree = client.AuditPage({ call, settingsCall: settingsStub, t })
  while (effects.length) effects.shift()()
  await settle(); await settle()
  return pageTree
}
const bareTree = await renderStatusPage(baseStatus)
assert.equal(nodes((n) => n.props.role === 'alert', bareTree).length, 0, 'missing shadow/snapshotStats must not raise an error')
assert.ok(text(bareTree).includes('未知/未启用'))
assert.equal(text(bareTree).includes('ws-1'), false)
const fullTree = await renderStatusPage({
  ...baseStatus,
  shadow: { enabled: true, workspaceKey: 'ws-1', objects: 12, refs: 4 },
  snapshotStats: { boundaries: 7, lastTurn: 3, lastStep: 2 },
})
assert.equal(nodes((n) => n.props.role === 'alert', fullTree).length, 0)
assert.equal(text(fullTree).includes('未知/未启用'), false)
assert.ok(text(fullTree).includes('ws-1'))
for (const fragment of ['true', '12', '4', '7', '3', '2']) assert.ok(text(fullTree).includes(fragment), `missing ${fragment} in status page`)
console.log('通过 read-only status area tolerates absent shadow/snapshotStats and renders them when present')
console.log('settings-client: all passed (VM interaction, no browser installed/reloaded)')
