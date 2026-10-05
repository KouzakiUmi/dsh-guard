import './runtime.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const { Config, DEFAULT_CONFIG } = await import('../lib/config.js')

const defaults = Config({}).get()
assert.deepEqual(defaults, DEFAULT_CONFIG)
for (const patch of [{ maxContextBytes: 0 }, { historyLimit: -1 }, { timeoutMs: Infinity }, { temperature: 3 }, { reviewerProvider: 'p' }, { reviewerEffort: 'high' }, { enabled: true, fallbackToSessionRoute: false }]) assert.throws(() => Config(patch))
assert.equal(Config({ reviewerProvider: ' p ', reviewerModel: ' m ' }).get().reviewerProvider, 'p')
console.log('PASS schema: defaults, range/type and cross-field validation')

let client
vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory(name => { assert.equal(name, 'react'); return { createElement() {} } }) } } }, console,
})
const calls = []
let refusal
const form = { ns: 'auto-review-router', revision: 4, value: defaults }
const service = {
  async describe() { return { ok: true, value: { writable: true, namespaces: [form] } } },
  async update(...args) { calls.push(args); return refusal ?? { ok: true, value: { ...form, revision: 5, value: args[1] } } },
}
const io = client.createSettingsIO(service)
assert.equal((await io.read()).revision, 4)
const saved = await io.save(form, { ...defaults, enabled: true, maxContextBytes: '5000' })
assert.equal(saved.revision, 5)
assert.equal(calls[0][0], 'auto-review-router')
assert.equal(calls[0][1].maxContextBytes, 5000)
assert.equal(calls[0][2], 4)
assert.equal(calls[0][1].manualFallback, true)
assert.equal(calls[0][1].manualApprovalTimeoutMs, 60000)
for (const timeout of [1000, 300000]) assert.equal(client.validateDraft({ ...defaults, manualApprovalTimeoutMs: String(timeout) }).manualApprovalTimeoutMs, timeout)
for (const timeout of [999, 300001, 1000.5, Infinity, '']) assert.throws(() => client.validateDraft({ ...defaults, manualApprovalTimeoutMs: timeout }))
assert.equal(client.validateDraft({ ...defaults, manualFallback: false }).manualFallback, false)
assert.throws(() => client.validateDraft({ ...defaults, manualFallback: 'true' }))
await assert.rejects(io.save(form, { ...defaults, historyLimit: '' }), /必填/)
assert.equal(calls.length, 1)
refusal = { ok: false, error: { code: 'settings/conflict', message: 'stale revision' } }
await assert.rejects(io.save(form, defaults), error => error.code === 'settings/conflict')
refusal = { ok: false, error: { code: 'settings/rejected', message: 'disk refused' } }
await assert.rejects(io.save(form, defaults), /disk refused/)
await assert.rejects(io.save({ ...form, revision: undefined }, defaults), /修订号/)
assert.equal(form.revision, 4)
console.log('PASS client official settings IO: save, validation, rejected/stale errors and revision retention')

// Render the shipped component with deterministic hook state; exercise its real event handlers.
for (const language of ['zh', 'en']) {
  const hooks = []
  let cursor = 0, pendingEffects = [], ui, tree
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(Boolean) } },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }] },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index] },
    useCallback(fn, deps) { const index = cursor++; const previous = hooks[index]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) hooks[index] = { fn, deps }; return hooks[index].fn },
    useEffect(fn, deps) { const index = cursor++; const previous = hooks[index]; if (!previous || deps.some((value, i) => value !== previous[i])) { hooks[index] = deps; pendingEffects.push(fn) } },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load({ factory }) { ui = factory(() => react) } } }, console })
  const t = key => ui.dictionaries[language][key] || key
  let writes = 0, uiRefusal
  const current = { ns: form.ns, revision: 10, value: { ...defaults } }
  const settings = ui.createSettingsIO({
    async describe() { return { ok: true, value: { writable: true, namespaces: [current] } } },
    async update(ns, value, revision) {
      writes++; assert.equal(revision, current.revision)
      if (uiRefusal) return uiRefusal
      current.revision++; current.value = value
      return { ok: true, value: { ...current } }
    },
  }, t)
  const call = async () => ({ plugin: 'dsh-auto-review-router', enabled: false, registration: { observed: true, registered: false, conflict: false }, route: { source: 'session-fallback' }, budget: {} })
  const loadCatalog = async () => ({ groups: [], failures: [] })
  // 设置页的「已授权目录」区块需要 grants 注入。此前这里**没传**，
  // loadGrants 因 typeof grants !== 'function' 提前返回，把该区块整段跳过 ——
  // 于是里面的 ReferenceError 一直没被任何测试发现。
  const grantCalls = []
  let grantList = [{ dir: 'D:\\proj', opClass: 'edit', tool: 'edit', at: 1, useCount: 3 }]
  const grants = async (revoke) => {
    grantCalls.push(revoke)
    if (revoke) grantList = []
    return { available: true, reason: null, revoked: revoke === true, grants: grantList.map(g => ({ ...g })) }
  }
  const render = () => { cursor = 0; tree = ui.RouterPage({ call, settings, loadCatalog, grants, t }); for (const effect of pendingEffects.splice(0)) effect(); return tree }
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []
  const text = node => typeof node === 'object' ? node.children.map(text).join(' ') : String(node)
  const button = key => walk(tree).find(node => node.type === 'button' && text(node) === t(key))
  const input = key => walk(tree).find(node => node.type === 'input' && node.props['aria-label'] === key)
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); render() }
  render(); await flush()
  assert.ok(button('save')); assert.ok(button('cancel'))
  assert.equal(input('manualFallback').props.checked, true)
  assert.equal(input('manualApprovalTimeoutMs').props.value, 60000)
  assert.ok(text(tree).includes(t('manualNote')))
  assert.ok(text(tree).includes(t('auditNote')))
  // 已授权目录区块：必须真的加载并渲染出来（此前整段被跳过）。
  await flush()
  assert.deepEqual(grantCalls, [false], '挂载时应只读查询一次，不得自动撤销')
  assert.ok(text(tree).includes(t('grantsTitle')), '必须渲染已授权目录区块')
  assert.ok(text(tree).includes('D:\\proj'), `必须列出已授权目录：${text(tree)}`)
  assert.ok(text(tree).includes(t('grantsEdit')), '必须标明操作类别')
  // 撤销必须二次确认：第一次点击只展开确认，不得直接撤销。
  const revokeButton = button('grantsRevoke')
  assert.ok(revokeButton, '有授权时必须提供撤销按钮')
  revokeButton.props.onClick(); render()
  assert.deepEqual(grantCalls, [false], '首次点击不得直接撤销')
  assert.ok(button('grantsRevokeConfirm'), '必须先出现确认按钮')
  button('grantsRevokeCancel').props.onClick(); render()
  assert.ok(button('grantsRevoke'), '取消后回到初始状态')
  assert.deepEqual(grantCalls, [false], '取消不得撤销')
  button('grantsRevoke').props.onClick(); render()
  button('grantsRevokeConfirm').props.onClick(); await flush()
  assert.deepEqual(grantCalls, [false, true], '确认后才真正撤销')
  assert.ok(text(tree).includes(t('grantsEmpty')), '撤销后显示为空')
  input('enabled').props.onChange({ target: { checked: true } }); render()
  assert.equal(button('save').props.disabled, false)
  button('cancel').props.onClick(); render()
  assert.equal(input('enabled').props.checked, false)
  assert.equal(writes, 0, 'cancel must not save')
  input('enabled').props.onChange({ target: { checked: true } }); render()
  walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush()
  assert.equal(writes, 1)
  assert.ok(text(tree).includes(t('saved')))
  input('historyLimit').props.onChange({ target: { value: '9' } }); render()
  uiRefusal = { ok: false, error: { code: 'settings/conflict', message: 'revision changed' } }
  walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush()
  assert.ok(text(tree).includes(t('stale')))
  assert.equal(input('historyLimit').props.value, '9', 'stale conflict retains draft')
  button('reloadConfig').props.onClick(); await flush()
  assert.equal(input('historyLimit').props.value, defaults.historyLimit)
  assert.ok(!text(tree).includes(t('stale')))
  assert.equal(ui.dictionaries[language].save, language === 'zh' ? '保存' : 'Save')
}
console.log('PASS shipped React form: Chinese/English, save, cancel without write, stale draft retention and reload')
