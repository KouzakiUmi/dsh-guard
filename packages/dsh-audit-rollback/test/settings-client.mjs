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
}
let client
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory((id) => { assert.equal(id, 'react'); return react }) } } },
  console, setTimeout, Date, Promise,
})
const defaultValue = { captureTools: ['write'], captureMaxBytes: 2097152, argsMaxBytes: 4096, logCalls: true, excludeGlobs: [] }
const parsed = client.validateDraft({ captureTools: 'write\nedit', captureMaxBytes: '10', argsMaxBytes: '20', logCalls: false, excludeGlobs: '' })
assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { captureTools: ['write', 'edit'], captureMaxBytes: 10, argsMaxBytes: 20, logCalls: false, excludeGlobs: [] })
for (const n of ['0', '-2', '1.5', 'NaN', '9007199254740992']) {
  assert.throws(() => client.validateDraft({ captureTools: 'write', captureMaxBytes: n, argsMaxBytes: '1' }), /positive safe integer/)
}
assert.throws(() => client.validateDraft({ captureTools: '', captureMaxBytes: '1', argsMaxBytes: '1' }), /at least one/)
assert.throws(() => client.unwrapSettings({ ok: false, error: { code: 'settings/conflict', message: 'stale' } }), (e) => e.code === 'settings/conflict')
console.log('通过 client list parsing / numeric & empty tools validation / conflict code preservation')
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
assert.ok(text().includes('gitSnapshot'))
assert.equal(nodes((n) => n.props['aria-label'] === 'stateDir').length, 0)
input('captureMaxBytes').props.onChange({ target: { value: '16' } })
render(); submit(); await settle(); render()
assert.equal(writes.length, 1)
assert.equal(writes[0].expected, 3)
assert.equal(writes[0].patch.captureMaxBytes, 16)
assert.equal('stateDir' in writes[0].patch, false)
assert.equal('gitSnapshot' in writes[0].patch, false)
assert.ok(nodes((n) => n.props.role === 'status').length)
assert.equal(refreshed, 1)
assert.equal(nodes((n) => n.props.role === 'alert').length, 0, 'status refresh failure must not be reported as save failure')
console.log('通过 edit / official update / draft revision / save feedback / no dummy git or stateDir input')

input('captureMaxBytes').props.onChange({ target: { value: '0' } }); render(); submit(); await settle(); render()
assert.equal(writes.length, 1)
assert.ok(text().includes('positive safe integer'))
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
assert.equal(writes.at(-1).expected, 4)
const cancel = nodes((n) => n.type === 'button' && text(n).includes('Cancel'))[0]
cancel.props.onClick(); await settle(); render()
assert.equal(input('captureMaxBytes').props.value, '16')
refusal = undefined
input('argsMaxBytes').props.onChange({ target: { value: '30' } }); render(); submit(); await settle(); render()
assert.equal(writes.at(-1).expected, 5)
console.log('通过 conflict refuses stale overwrite / cancel re-reads / retry uses fresh revision')
language = 'zh'; render()
assert.ok(text().includes('捕获策略设置'))
assert.ok(text().includes('单文件捕获上限'))
assert.ok(text().includes('取消并重新读取'))
assert.equal(text().includes('Cancel & reload'), false)
input('captureMaxBytes').props.onChange({ target: { value: '0' } }); render(); submit(); await settle(); render()
assert.ok(text().includes('必须是正安全整数'))
console.log('通过 zh/en dictionaries / Chinese labels and validation / no bilingual concatenation')
console.log('settings-client: all passed (VM interaction, no browser installed/reloaded)')
