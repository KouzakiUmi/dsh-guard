// 执行真实 lazy client factory，验证注册行为；不是浏览器渲染测试。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

export async function testSingleSettingsEntry(path, expectedId) {
  for (const initiallyAvailable of [true, false]) {
    const declared = new Set(['settings.section'])
    if (initiallyAvailable) declared.add('settings.plugins.tab')
    const entries = new Map(), subscriptions = new Map(), effects = [], requested = [], logs = []
    let client
    vm.runInNewContext(readFileSync(path, 'utf8'), {
      window: { __ModuleLoader__: { load({ factory }) { client = factory(id => {
        assert.equal(id, 'react'); return { createElement() {} }
      }) } } },
      console: { info(...args) { logs.push(args.join(' ')) }, warn(...args) { logs.push(args.join(' ')) }, error(...args) { throw new Error(args.join(' ')) } },
      setTimeout, Date, Promise,
    })
    const settings = { describe() {}, update() {} }
    const ctx = {
      locale: { register() { return () => {} }, bind() { return key => client.dictionaries.zh[key] || key } },
      remote: { $mount() { return Promise.resolve() } },
      get(name) { return name === 'remote.settings' ? settings : undefined },
      effect(factory) { const result = factory(); effects.push(result); return result },
      slots: {
        spec(name) { return declared.has(name) ? { kind: 'list' } : undefined },
        inject(name, factory) {
          requested.push(name)
          assert.equal(subscriptions.has(name), false, '同一槽不得重复订阅')
          const subscription = { factory }
          subscriptions.set(name, subscription)
          if (declared.has(name)) subscription.dispose = factory()
          const off = () => { subscription.dispose?.(); subscriptions.delete(name) }
          effects.push(off)
          return off
        },
        register(options, component) {
          assert.equal(options.name, 'settings.plugins.tab', '禁止重新贡献侧栏 settings.section')
          assert.equal(typeof component, 'function')
          assert.equal(entries.has(options.id), false, '不得重复注册页签')
          entries.set(options.id, options)
          return () => entries.delete(options.id)
        },
      },
    }
    client.apply(ctx)
    assert.deepEqual(requested, ['settings.plugins.tab'])
    assert.equal(entries.size, initiallyAvailable ? 1 : 0)
    assert.equal(subscriptions.has('settings.section'), false)
    if (!initiallyAvailable) {
      assert.ok(logs.some(line => line.includes('未声明')), '容器未就绪时必须有诊断')
      declared.add('settings.plugins.tab')
      const subscription = subscriptions.get('settings.plugins.tab')
      subscription.dispose = subscription.factory()
    }
    assert.deepEqual([...entries.keys()], [expectedId])
    const entry = entries.get(expectedId)
    assert.equal(typeof entry.label(), 'string')
    assert.equal(typeof entry.inject().t, 'function')
    for (const result of effects.reverse()) {
      const dispose = await result
      if (typeof dispose === 'function') await dispose()
    }
    assert.equal(entries.size, 0, '卸载后必须清除页签')
    assert.equal(subscriptions.size, 0, '卸载后必须取消槽等待')
    console.log(`PASS 单入口注册/无侧栏回退/locale/卸载清理（容器${initiallyAvailable ? '已声明' : '晚声明'}）`)
  }
}
