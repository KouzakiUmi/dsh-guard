// Exercise the shipped lazy factory/hooks and its real slot-derived RPC callbacks.
// Deterministic UI contract tests, not a browser or a real model call.
import './runtime.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const { DEFAULT_CONFIG: defaults } = await import('../lib/config.js')
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const catalog = {
  default: { provider: 'provider-two', model: 'shared/id', reasoningEffort: 'fast/v2' },
  routableProviders: ['provider/one', 'provider-two'],
  groups: [
    { id: 'provider/one', name: 'Provider One', models: [
      { id: 'shared/id', name: 'First shared', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
      { id: 'other/id', name: 'Other', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
      { id: 'plain', name: 'No reasoning' },
    ] },
    { id: 'provider-two', name: 'Provider Two', models: [
      { id: 'shared/id', name: 'Second shared', reasoning: { efforts: [{ id: 'fast/v2', name: 'Fast' }], defaultEffort: 'fast/v2' } },
    ] },
  ],
  failures: [],
}
const status = { plugin: 'dsh-auto-review-router', enabled: false, registration: { observed: true, registered: false, conflict: false }, route: { source: 'session-fallback' }, budget: { timeoutMs: 20000 } }
const clone = value => structuredClone(value)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function factory(react) {
  let ui
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) { ui = factory(id => { assert.equal(id, 'react'); return react }) } } },
    console: { info() {}, warn() {}, error(...args) { throw new Error(args.join(' ')) } }, setTimeout, Date, Promise,
  })
  return ui
}
function harness({ language = 'en', value = defaults, loadCatalog = async () => clone(catalog), readStatus = async () => clone(status) } = {}) {
  const hooks = [], effects = []
  let cursor = 0, tree, unmounted = false, lateUpdates = 0
  const same = (left, right) => left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) } },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = initial
      return [hooks[index], value => {
        if (unmounted) { lateUpdates++; return }
        hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
      }]
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index] },
    useCallback(fn, deps) { const index = cursor++; if (!same(hooks[index]?.deps, deps)) hooks[index] = { fn, deps }; return hooks[index].fn },
    useEffect(fn, deps) {
      const index = cursor++
      if (!same(hooks[index]?.deps, deps)) { const cleanup = hooks[index]?.cleanup; hooks[index] = { deps }; effects.push(() => { cleanup?.(); hooks[index].cleanup = fn() }) }
    },
  }
  const ui = factory(react)
  const t = key => ui.dictionaries[language][key] || key
  const current = { ns: 'auto-review-router', revision: 10, value: clone(value) }
  const writes = []
  let refusal, describe = async () => ({ ok: true, value: { writable: true, namespaces: [clone(current)] } })
  let update = async (ns, value, revision) => {
    writes.push([ns, clone(value), revision])
    assert.equal(revision, current.revision)
    if (refusal) return refusal
    current.value = clone(value); current.revision++
    return { ok: true, value: clone(current) }
  }
  const settings = ui.createSettingsIO({ describe: (...args) => describe(...args), update: (...args) => update(...args) }, t)
  const props = { call: readStatus, settings, loadCatalog, t }
  const render = () => { cursor = 0; tree = ui.RouterPage(props); effects.splice(0).forEach(effect => effect()); return tree }
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []
  const text = node => node && typeof node === 'object' ? node.children.map(text).join(' ') : String(node ?? '')
  const control = key => walk(tree).find(node => node.props['aria-label'] === key)
  const button = key => walk(tree).find(node => node.type === 'button' && text(node) === t(key))
  const change = (key, value) => { const node = control(key); assert.ok(node, key); node.props.onChange({ target: { value, checked: value } }); render() }
  const submit = () => walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const options = key => control(key).children.map(node => ({ value: node.props.value, disabled: !!node.props.disabled, text: text(node) }))
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); render() }
  const unmount = () => { unmounted = true; for (const hook of hooks.slice().reverse()) hook?.cleanup?.() }
  return { ui, props, current, writes, render, flush, change, submit, control, button, options, unmount,
    get text() { return text(tree) }, get lateUpdates() { return lateUpdates },
    set refusal(value) { refusal = value }, set describe(value) { describe = value }, set update(value) { update = value },
  }
}

for (const language of ['zh', 'en']) {
  const initial = deferred()
  let reads = 0
  const ui = harness({ language, loadCatalog: async () => { reads++; return initial.promise } })
  ui.render(); await ui.flush()
  assert.ok(ui.text.includes(ui.ui.dictionaries[language].catalogLoading))
  assert.equal(ui.control('reviewerProvider').type, 'select')
  assert.equal(ui.control('reviewerProvider').props.disabled, true)
  assert.equal(ui.control('reviewerProvider').props.value, '', 'deployment default must not silently replace an empty route')
  initial.resolve(clone(catalog)); await ui.flush()
  assert.equal(reads, 1)
  assert.deepEqual(ui.options('reviewerProvider').map(row => row.value), ['', 'provider/one', 'provider-two'])
  ui.change('enabled', true)
  ui.change('reviewerProvider', 'provider/one')
  ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 0)
  assert.ok(ui.text.includes(ui.ui.dictionaries[language].pair), 'partial pair must still fail Config validation')
  ui.change('reviewerModel', 'shared/id')
  assert.deepEqual(ui.options('reviewerEffort').map(row => row.value), ['', 'low', 'high'])
  assert.ok(ui.options('reviewerEffort')[0].text.includes('High (high)'), 'empty effort displays the exact model default')
  assert.equal(ui.control('reviewerEffort').props.value, '', 'do not materialize a default into the saved draft')
  ui.change('reviewerEffort', 'high')
  ui.change('reviewerModel', 'other/id')
  assert.equal(ui.control('reviewerEffort').props.value, '', 'switching model clears incompatible effort')
  assert.deepEqual(ui.options('reviewerEffort').map(row => row.value), ['', 'low'])
  ui.change('reviewerEffort', 'low')
  ui.change('reviewerModel', 'shared/id')
  assert.equal(ui.control('reviewerEffort').props.value, 'low', 'a compatible effort may survive a model switch')
  ui.change('reviewerModel', 'plain')
  assert.equal(ui.control('reviewerEffort').props.value, '')
  assert.deepEqual(ui.options('reviewerEffort').map(row => row.value), [''])
  assert.equal(ui.control('reviewerEffort').props.disabled, true)
  ui.change('reviewerModel', 'shared/id')
  ui.change('reviewerEffort', 'high')
  ui.change('reviewerProvider', 'provider-two')
  assert.equal(ui.control('reviewerModel').props.value, '', 'same model id across providers must not carry a selection')
  assert.equal(ui.control('reviewerEffort').props.value, '')
  ui.change('reviewerModel', 'shared/id')
  assert.deepEqual(ui.options('reviewerEffort').map(row => row.value), ['', 'fast/v2'])
  assert.ok(ui.options('reviewerModel')[1].text.includes('Second shared'))
  ui.change('reviewerEffort', 'fast/v2')
  ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 1)
  assert.equal(ui.writes[0][1].reviewerProvider, 'provider-two')
  assert.equal(ui.writes[0][1].reviewerModel, 'shared/id', 'slash-bearing model ids are kept verbatim')
  assert.equal(ui.writes[0][1].reviewerEffort, 'fast/v2')
  ui.button('clearRoute').props.onClick(); ui.render()
  for (const key of ['reviewerProvider', 'reviewerModel', 'reviewerEffort']) assert.equal(ui.control(key).props.value, '')
  assert.equal(ui.control('fallbackToSessionRoute').props.checked, true)
  ui.button('cancel').props.onClick(); ui.render()
  assert.equal(ui.control('reviewerProvider').props.value, 'provider-two')
  assert.equal(ui.writes.length, 1, 'cancel is local only')
  ui.button('clearRoute').props.onClick(); ui.render(); ui.submit(); await ui.flush()
  assert.equal(ui.writes[1][1].reviewerProvider, '')
  assert.equal(ui.writes[1][1].reviewerModel, '')
  assert.equal(ui.writes[1][1].reviewerEffort, '')
  assert.equal(ui.writes[1][1].fallbackToSessionRoute, true, 'clearing preserves session fallback semantics')
  ui.change('fallbackToSessionRoute', false); ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 2)
  assert.ok(ui.text.includes(ui.ui.dictionaries[language].noFallbackRoute))
  ui.unmount()
}
console.log('PASS configured picker zh/en: linked provider/model, slash/duplicate ids, exact efforts/default, compatible switches, clear/cancel/fallback/pair validation')

// Existing routes/efforts never disappear on refresh, failure, empty or missing catalog.
for (const language of ['zh', 'en']) {
  const stored = { ...defaults, enabled: true, reviewerProvider: 'retired/provider', reviewerModel: 'retired/model', reviewerEffort: 'retired/effort' }
  let next = { ...clone(catalog), failures: [{ id: 'broken/provider', name: 'Broken', message: 'catalog unavailable' }] }
  const ui = harness({ language, value: stored, loadCatalog: async () => clone(next) })
  ui.render(); await ui.flush()
  assert.ok(ui.text.includes('Broken (broken/provider): catalog unavailable'))
  assert.ok(ui.text.includes(ui.ui.dictionaries[language].unavailableRoute))
  for (const [key, id] of [['reviewerProvider', stored.reviewerProvider], ['reviewerModel', stored.reviewerModel], ['reviewerEffort', stored.reviewerEffort]]) {
    assert.equal(ui.control(key).props.value, id)
    assert.ok(ui.options(key).find(row => row.value === id)?.disabled)
  }
  ui.change('historyLimit', '9')
  assert.equal(ui.button('save').props.disabled, true)
  ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 0)
  ui.change('enabled', false)
  assert.equal(ui.button('save').props.disabled, false, 'unavailable models must never block closing Auto')
  ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 1)
  assert.equal(ui.writes[0][1].reviewerModel, stored.reviewerModel)
  ui.change('enabled', true); ui.render()
  assert.equal(ui.button('save').props.disabled, true, 'do not enable an unavailable dedicated route')
  next = { groups: [], failures: [], default: catalog.default, routableProviders: [] }
  ui.button('catalogRefresh').props.onClick(); await ui.flush()
  assert.ok(ui.text.includes(ui.ui.dictionaries[language].catalogEmpty))
  assert.equal(ui.control('reviewerModel').props.value, stored.reviewerModel)
  ui.change('enabled', false)
  ui.change('historyLimit', '11'); ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 2, 'empty catalog permits closing with original route retained')
  ui.unmount()

  const failed = harness({ language, value: stored, loadCatalog: async () => { throw new Error('offline') } })
  failed.render(); await failed.flush()
  assert.ok(failed.text.includes(ui.ui.dictionaries[language].catalogFailed))
  assert.equal(failed.control('reviewerModel').props.value, stored.reviewerModel)
  failed.change('enabled', false); failed.submit(); await failed.flush()
  assert.equal(failed.writes.length, 1, 'failed catalog permits closing without silently clearing old route')
  failed.change('enabled', true); failed.submit(); await failed.flush()
  assert.equal(failed.writes.length, 1)
  assert.ok(failed.text.includes(ui.ui.dictionaries[language].catalogRequired))
  failed.props.loadCatalog = async () => clone(catalog)
  failed.render(); await failed.flush()
  assert.equal(failed.control('reviewerModel').props.value, stored.reviewerModel, 'retry never replaces the draft')
  failed.change('reviewerProvider', 'provider/one'); failed.change('reviewerModel', 'plain')
  failed.submit(); await failed.flush()
  assert.equal(failed.writes.length, 2)
  failed.unmount()

  const effort = harness({ language, value: { ...defaults, enabled: true, reviewerProvider: 'provider/one', reviewerModel: 'shared/id', reviewerEffort: 'obsolete' } })
  effort.render(); await effort.flush()
  assert.equal(effort.control('reviewerEffort').props.value, 'obsolete')
  assert.ok(effort.text.includes(ui.ui.dictionaries[language].unavailableEffort))
  effort.change('historyLimit', '17'); effort.submit(); await effort.flush()
  assert.equal(effort.writes.length, 0)
  effort.change('reviewerModel', 'other/id')
  assert.equal(effort.control('reviewerEffort').props.value, '', 'only an explicit model switch clears unsupported stored effort')
  effort.refusal = { ok: false, error: { code: 'settings/conflict', message: 'stale' } }
  effort.submit(); await effort.flush()
  assert.equal(effort.current.revision, 10)
  assert.equal(effort.control('reviewerModel').props.value, 'other/id')
  assert.ok(effort.text.includes(ui.ui.dictionaries[language].stale))
  effort.refusal = { ok: false, error: { code: 'settings/rejected', message: 'disk refused' } }
  effort.submit(); await effort.flush()
  assert.equal(effort.current.revision, 10)
  assert.ok(effort.text.includes('disk refused'))
  effort.button('cancel').props.onClick(); effort.render()
  assert.equal(effort.control('reviewerEffort').props.value, 'obsolete')
  effort.unmount()
}
console.log('PASS unavailable/empty/failed/partial catalogs zh/en: retain stored drafts, allow safe disable, retry, unsupported effort, conflict/rejected revision retention')

// Latest refresh and latest dependency generation win, including old rejection/finally.
{
  const old = deferred(), latest = deferred()
  let reads = 0
  const ui = harness({ loadCatalog: () => (++reads === 1 ? old.promise : latest.promise) })
  ui.render(); await ui.flush()
  ui.button('catalogRefreshing').props.onClick(); ui.render()
  latest.resolve(clone(catalog)); await ui.flush()
  assert.equal(ui.control('reviewerProvider').props.disabled, false)
  old.reject(new Error('old request failed')); await ui.flush()
  assert.equal(ui.control('reviewerProvider').props.disabled, false)
  assert.ok(!ui.text.includes('old request failed'))
  const obsolete = deferred(), replacement = deferred()
  ui.props.loadCatalog = () => obsolete.promise; ui.render()
  ui.props.loadCatalog = () => replacement.promise; ui.render()
  replacement.resolve({ groups: [], failures: [] }); await ui.flush()
  obsolete.resolve(clone(catalog)); await ui.flush()
  assert.deepEqual(ui.options('reviewerProvider').map(row => row.value), [''])
  ui.unmount()
}
{
  const pendingCatalog = deferred(), pendingStatus = deferred(), pendingForm = deferred()
  const ui = harness({ loadCatalog: () => pendingCatalog.promise, readStatus: () => pendingStatus.promise })
  ui.describe = () => pendingForm.promise
  ui.render(); ui.unmount()
  pendingCatalog.resolve(clone(catalog)); pendingStatus.resolve(clone(status))
  pendingForm.resolve({ ok: true, value: { writable: true, namespaces: [clone(ui.current)] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ui.lateUpdates, 0, 'catalog, status and settings reads must not update an unmounted component')
}
{
  const ui = harness()
  ui.render(); await ui.flush()
  const pendingSave = deferred()
  ui.update = () => pendingSave.promise
  ui.change('enabled', true); ui.submit(); ui.render(); ui.unmount()
  pendingSave.resolve({ ok: true, value: { ...clone(ui.current), revision: 11 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ui.lateUpdates, 0, 'save completion must not update or refresh an unmounted component')
}
// A read in progress must not lock out the safety-critical disable operation.
{
  const pending = deferred()
  const ui = harness({ value: { ...defaults, enabled: true, reviewerProvider: 'provider/one', reviewerModel: 'shared/id', reviewerEffort: 'high' }, loadCatalog: () => pending.promise })
  ui.render(); await ui.flush()
  ui.change('enabled', false); ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 1)
  assert.equal(ui.writes[0][1].reviewerEffort, 'high')
  pending.resolve(clone(catalog)); await ui.flush()
  const refreshed = clone(catalog)
  refreshed.groups[0].models[0].reasoning = { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }
  ui.props.loadCatalog = async () => refreshed; ui.render(); await ui.flush()
  assert.equal(ui.control('reviewerEffort').props.value, 'high', 'refreshing capability metadata never silently rewrites a draft')
  assert.ok(ui.options('reviewerEffort').find(row => row.value === 'high').disabled)
  assert.ok(ui.options('reviewerEffort')[0].text.includes('Low (low)'))
  ui.change('enabled', true); ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 1)
  ui.change('reviewerEffort', ''); ui.submit(); await ui.flush()
  assert.equal(ui.writes.length, 2, 'the model default is a valid explicit repair')
  ui.unmount()
}
console.log('PASS asynchronous generations: stale refresh success/error, dependency changes, pending reads/save after unmount, safe disable during loading, retained changed capabilities')

// Real plugin apply -> registered slot inject -> catalog RPC, with required service
// edge and Cordis-owned disposers. Navigation regression tests also check late slots.
{
  const ui = factory({ createElement() {} })
  assert.ok(ui.inject.includes('remote.session'))
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'))
  const effects = [], entries = [], calls = []
  let answer = { ok: true, value: clone(catalog) }
  const service = { async modelCatalog(...args) { calls.push(args); return answer } }
  const settings = { async describe() { calls.push('describe'); return { ok: true, value: { writable: true, namespaces: [{ ns: 'auto-review-router', revision: 1, value: defaults }] } } }, async update() { calls.push('update') } }
  const ctx = {
    remote: { $mount() { return Promise.resolve(() => {}) } },
    locale: { register() { return () => {} }, bind() { return key => ui.dictionaries.en[key] || key } },
    get(name) { if (name === 'remote.session') return service; if (name === 'remote.settings') return settings; throw new Error(`Unexpected service: ${name}`) },
    effect(fn) { const value = fn(); effects.push(value); return value },
    slots: { spec() { return {} }, inject(slot, fn) { assert.equal(slot, 'settings.plugins.tab'); const dispose = fn(); effects.push(dispose) }, register(entry) { entries.push(entry); return () => entries.pop() } },
  }
  ui.apply(ctx)
  const props = entries[0].inject()
  assert.equal(typeof props.loadCatalog, 'function')
  assert.deepEqual(await props.loadCatalog(), catalog)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 0, 'modelCatalog requires no session, provider, credential or model input')
  answer = { ok: false, error: { code: 'session/catalog-failed', message: 'catalog refused' } }
  await assert.rejects(props.loadCatalog(), /catalog refused/)
  const pending = deferred()
  service.modelCatalog = () => pending.promise
  const inflight = props.loadCatalog()
  for (const value of effects.reverse()) { const dispose = await value; if (typeof dispose === 'function') await dispose() }
  assert.equal(entries.length, 0)
  pending.resolve({ ok: true, value: catalog })
  await assert.rejects(inflight, /disposed/)
  const count = calls.length
  await assert.rejects(props.loadCatalog(), /disposed/)
  await assert.rejects(props.settings.read(), /disposed/)
  await assert.rejects(props.settings.save({ ns: 'auto-review-router', revision: 1 }, defaults), /disposed/)
  assert.equal(calls.length, count, 'retained callbacks cannot access RPCs after plugin disposal')
}
for (const language of ['zh', 'en']) {
  const ui = factory({ createElement() {} })
  const t = key => ui.dictionaries[language][key] || key
  await assert.rejects(ui.createCatalogIO({ async modelCatalog() { return { ok: false } } }, () => false, t)(), error => error.message === t('remoteFailed'))
}
console.log('PASS real factory/apply/slot injection: official zero-argument modelCatalog RPC, information edge, remote refusal/localization, pending and retained callbacks disposed safely')
