#!/usr/bin/env node
/**
 * 假 ctx 调用 Host 只读状态查询。
 * 覆盖启用状态、Auto 注册/冲突、路由判定、预算回显。
 * 不写 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import './runtime.mjs'
const { apply, queryRouterStatus, routerStatusRemote } = await import('../lib/index.js')

const testDir = dirname(fileURLToPath(import.meta.url))
let failed = 0

function ok(label, fn) {
  try {
    fn()
    console.log(`通过  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`失败  ${label}`)
    console.error(error)
  }
}

function fakeCtx(registerAuto) {
  return {
    logger: { info() {}, warn() {} },
    permissionPresets: { registerAuto },
    on() { return () => {} },
  }
}

ok('未启用：不注册，配置回显默认预算', () => {
  const ctx = fakeCtx(() => {
    throw new Error('disabled 路径不应调用 registerAuto')
  })
  apply(ctx, { enabled: false, maxContextBytes: 9, historyLimit: 3, timeoutMs: 4, temperature: 0.2, logDecisions: false })
  const status = queryRouterStatus(ctx)
  assert.equal(status.plugin, 'dsh-auto-review-router')
  assert.equal(status.enabled, false)
  assert.equal(status.registration.observed, true)
  assert.equal(status.registration.attempted, false)
  assert.equal(status.registration.registered, false)
  assert.equal(status.registration.conflict, false)
  assert.equal(status.budget.maxContextBytes, 9)
  assert.equal(status.budget.historyLimit, 3)
  assert.equal(status.budget.timeoutMs, 4)
  assert.equal(status.budget.temperature, 0.2)
  assert.equal(status.budget.logDecisions, false)
  assert.equal(status.route.source, 'session-fallback')
  console.log(JSON.stringify({ enabled: status.enabled, registration: status.registration, route: status.route, budget: status.budget }))
})

ok('配置路由：registered，回显 provider/model/effort', () => {
  const ctx = fakeCtx(() => () => {})
  apply(ctx, {
    enabled: true,
    reviewerProvider: 'demo-provider',
    reviewerModel: 'demo-model',
    reviewerEffort: 'high',
    fallbackToSessionRoute: false,
    maxContextBytes: 128,
    historyLimit: 2,
    timeoutMs: 30,
    temperature: 0,
    logDecisions: true,
  })
  const status = queryRouterStatus(ctx)
  assert.equal(status.enabled, true)
  assert.equal(status.registration.registered, true)
  assert.equal(status.registration.conflict, false)
  assert.equal(status.route.source, 'config')
  assert.equal(status.route.provider, 'demo-provider')
  assert.equal(status.route.model, 'demo-model')
  assert.equal(status.route.effort, 'high')
  assert.equal(status.route.rejection, null)
  assert.equal(status.budget.maxContextBytes, 128)
  console.log(JSON.stringify({ registration: status.registration, route: status.route, budget: status.budget }))
})

ok('配置不全且关闭回退：rejection 非空', () => {
  const ctx = fakeCtx(() => () => {})
  apply(ctx, { enabled: true, fallbackToSessionRoute: false })
  const status = queryRouterStatus(ctx)
  assert.equal(status.route.source, 'rejected')
  assert.equal(typeof status.route.rejection, 'string')
  assert.ok(status.route.rejection.length > 0)
  console.log(JSON.stringify({ route: status.route }))
})

ok('官方 Auto 已注册：conflict 与警告文案', () => {
  const ctx = fakeCtx(() => {
    throw new Error('preset "auto" is already registered')
  })
  apply(ctx, { enabled: true, reviewerProvider: 'p', reviewerModel: 'm' })
  const status = queryRouterStatus(ctx)
  assert.equal(status.registration.attempted, true)
  assert.equal(status.registration.registered, false)
  assert.equal(status.registration.conflict, true)
  assert.match(status.registration.conflictWarning, /禁用其一/)
  console.log(JSON.stringify({ registration: status.registration }))
})

ok('未 apply 的假 ctx 仍能按 config 回显，且不抛错', () => {
  const status = queryRouterStatus({
    config: { enabled: true, reviewerProvider: 'only-config', reviewerModel: 'm2', maxContextBytes: 7 },
  })
  assert.equal(status.registration.observed, false)
  assert.equal(status.route.source, 'config')
  assert.equal(status.route.provider, 'only-config')
  assert.equal(status.budget.maxContextBytes, 7)
})

ok('缺少 registerAuto 仍然抛错，不改既有失败语义', () => {
  assert.throws(
    () => apply({ logger: { info() {}, warn() {} }, permissionPresets: {} }, { enabled: true }),
    /registerAuto/,
  )
})

ok('只读 client 描述符与 host 逐字段全等，schema 与官方 sandbox setter 是声明的依赖', () => {
  const client = readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8')
  const host = readFileSync(join(testDir, '..', 'lib', 'index.js'), 'utf8')
  const descriptor = routerStatusRemote.descriptors[0]
  assert.equal(descriptor.id, 'dsh-auto-review-router#autoReviewRouter/read')
  // 客户端是 ModuleLoader factory 无法 import，从源码文本提取描述符字段与 host 逐字段严格相等。
  // （此前用 includes 子串断言，read→readX 这类变异会幸存。）
  const grab = (pattern, field) => {
    const match = client.match(pattern)
    assert.ok(match, `client.js 未找到描述符字段 ${field}`)
    return match[1]
  }
  const extracted = {
    id: grab(/\bid:\s*'([^']*#[^']*)'/, 'id'),
    service: grab(/\bservice:\s*'([^']+)'/, 'service'),
    namespace: grab(/\bnamespace:\s*'([^']+)'/, 'namespace'),
    method: grab(/\bmethod:\s*'([^']+)'/, 'method'),
    typeSymbol: grab(/\btypeSymbol:\s*'([^']+)'/, 'typeSymbol'),
  }
  assert.equal(extracted.id, descriptor.id)
  assert.equal(extracted.service, descriptor.service)
  assert.equal(extracted.namespace, descriptor.namespace)
  assert.equal(extracted.method, descriptor.method)
  assert.equal(extracted.typeSymbol, descriptor.result.typeSymbol)
  // 客户端实际调用点 call('<method>') 必须与描述符 method 一致，否则运行时 Host 缺方法。
  const invokedMethods = [...client.matchAll(/\bcall\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.ok(invokedMethods.length > 0, 'client.js 未找到 call(...) 调用点')
  for (const invoked of invokedMethods) {
    assert.equal(invoked, descriptor.method)
  }
  assert.ok(client.includes("require('react')"))
  const forbidden = /(?:from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\/|import\(\s*['"]@deepseek-ai\/)/
  assert.equal(forbidden.test(client), false)
  const manifest = JSON.parse(readFileSync(join(testDir, '..', 'package.json'), 'utf8'))
  for (const match of host.matchAll(/from\s*['"](@deepseek-ai\/[^'"]+)['"]/g)) assert.ok(manifest.peerDependencies[match[1]], `undeclared peer: ${match[1]}`)
})

ok('client 设置页注册契约：仅内置插件页签，无独立侧栏入口', () => {
  const client = readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8')
  const grab = (pattern, field) => {
    const match = client.match(pattern)
    assert.ok(match, `client.js 未找到设置页注册字段 ${field}`)
    return match[1]
  }
  // 系统级插件只贡献一个内置插件页签；槽晚声明也不得另建侧栏回退入口。
  const registrations = [...client.matchAll(/registerInto\('([^']+)', entry\.(\w+)\)/g)]
    .map((match) => ({ slot: match[1], idField: match[2] }))
  assert.deepEqual(registrations, [{ slot: 'settings.plugins.tab', idField: 'tabId' }])
  assert.equal(client.includes("'settings.section'"), false)
  assert.equal(grab(/\btabId:\s*'([^']+)'/, 'entry.tabId'), 'auto-review-router-tab')
  // 注册字段对齐官方范本：label 走 t('nav')，且 locale 命名空间随注册提交（entry 与 register 各一处代码行）。
  assert.equal(grab(/\blabel:\s*\(\) => t\('([^']+)'\)/, 'label key'), 'nav')
  assert.equal([...client.matchAll(/^\s*locale:\s*NS,$/gm)].length, 2)
  // 探针用 ctx.slots.spec()（Slots 服务公开方法，未声明返回 undefined），不靠 try/catch 兜底。
  assert.equal(grab(/ctx\.slots\.spec\('([^']+)'\)/, 'probe slot'), 'settings.plugins.tab')
  assert.equal(client.includes('退回 settings.section'), false, '旧的 try/catch 回退路径必须删除')
  // apply 入口必须有加载日志，否则「没出现且无报错」无法定位。
  assert.ok(client.includes("console.info('[dsh-auto-review-router] client 已加载')"), '缺 apply 入口日志')
})

ok('status codec Host/Client 互反一致：接受值双方同接受，拒绝值双方同拒绝', () => {
  let clientExports
  vm.runInNewContext(readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { clientExports = factory(() => ({ createElement() {} })) } } },
    console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout, AbortController, Date, Promise,
  })
  const clientParse = clientExports.statusRemote.descriptors[0].result.schema.parse
  const hostParse = routerStatusRemote.descriptors[0].result.schema.parse
  const observedCtx = fakeCtx(() => () => {})
  apply(observedCtx, { enabled: false })
  const accepts = [
    queryRouterStatus(observedCtx), // 已观察：observed/attempted/registered/conflict/closeFailed 全 false
    queryRouterStatus({ config: { enabled: true } }), // 未观察：registration 仍为完整布尔形状
  ]
  const valid = accepts[0]
  const reject = (label, mutate) => {
    const value = JSON.parse(JSON.stringify(valid))
    mutate(value)
    return [label, value]
  }
  const rejects = [
    reject('缺 registration.conflict（旧 client 曾不查）', value => { delete value.registration.conflict }),
    reject('缺 registration.closeFailed', value => { delete value.registration.closeFailed }),
    reject('缺 budget.timeoutMs（旧 host 曾不查）', value => { delete value.budget.timeoutMs }),
    reject('registration.observed 非布尔', value => { value.registration.observed = 'yes' }),
    reject('registration.conflictWarning 非 string|null', value => { value.registration.conflictWarning = 42 }),
    reject('registration.error 非 string|null', value => { value.registration.error = 42 }),
    reject('缺 budget.logDecisions', value => { delete value.budget.logDecisions }),
    reject('route.source 非字符串', value => { value.route.source = 1 }),
    reject('plugin 名不符', value => { value.plugin = 'other' }),
  ]
  for (const value of accepts) {
    assert.deepEqual(JSON.parse(JSON.stringify(hostParse(JSON.parse(JSON.stringify(value))))), JSON.parse(JSON.stringify(value)), 'host 必须接受合法 status')
    assert.deepEqual(JSON.parse(JSON.stringify(clientParse(JSON.parse(JSON.stringify(value))))), JSON.parse(JSON.stringify(value)), 'client 必须接受合法 status')
  }
  for (const [label, value] of rejects) {
    assert.throws(() => hostParse(value), undefined, `host 必须拒绝：${label}`)
    assert.throws(() => clientParse(value), undefined, `client 必须拒绝：${label}`)
  }
})

// 2026-10-05：新增 grants 方法时漏了 descriptors 条目 —— service 上有绑定函数、
// markDirectRemote 也打了标记，但没有 typert 描述符，传输层根本不路由，
// 客户端调用永远失败。这类「接了 Host 没接 transport」的错必须有测试兜住。
{
  let clientExports
  vm.runInNewContext(readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { clientExports = factory(() => ({ createElement() {} })) } } },
    console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout, AbortController, Date, Promise,
  })
  const hostMethods = routerStatusRemote.descriptors.map(d => d.method).sort()
  const clientMethods = clientExports.statusRemote.descriptors.map(d => d.method).sort()
  assert.deepEqual([...hostMethods], ['grants', 'history', 'read'], 'host 描述符必须覆盖全部方法')
  // 跨 VM 比较：数组原型不同，deepEqual 不可用，逐项比字符串。
  assert.equal(clientMethods.join(','), hostMethods.join(','), 'client 与 host 的 remote 方法集必须一致')

  // 每个描述符都要有真正的 parse 校验器（无校验的描述符等于没 fail-closed）
  for (const descriptor of routerStatusRemote.descriptors) {
    assert.equal(typeof descriptor.result?.schema?.parse, 'function', `${descriptor.method} 缺出参校验`)
    for (const param of descriptor.parameters ?? []) {
      assert.equal(typeof param.codec?.schema?.parse, 'function', `${descriptor.method}.${param.name} 缺入参校验`)
    }
  }
  const grantsParse = routerStatusRemote.descriptors.find(d => d.method === 'grants').result.schema.parse
  const grantsReqParse = routerStatusRemote.descriptors.find(d => d.method === 'grants').parameters[0].codec.schema.parse
  assert.equal(grantsReqParse(undefined).revoke, false, '缺省请求等价于只读')
  assert.equal(grantsReqParse({ revoke: true }).revoke, true)
  const validGrants = { available: true, reason: null, revoked: false,
    grants: [{ dir: 'd:\\p', opClass: 'edit', tool: 'edit', at: 1, useCount: 2 }] }
  assert.doesNotThrow(() => grantsParse(validGrants), '合法 grants 必须被接受')
  const badGrants = [
    ['缺 available', { revoked: false, grants: [] }],
    ['缺 revoked', { available: true, grants: [] }],
    ['grants 非数组', { available: true, revoked: false, grants: {} }],
    ['条目 opClass 非法', { available: true, revoked: false, grants: [{ dir: 'd:\\p', opClass: 'delete', tool: 'edit', at: 1, useCount: 0 }] }],
    ['useCount 非整数', { available: true, revoked: false, grants: [{ dir: 'd:\\p', opClass: 'edit', tool: 'edit', at: 1, useCount: -1 }] }],
    ['dir 为空', { available: true, revoked: false, grants: [{ dir: '', opClass: 'edit', tool: 'edit', at: 1, useCount: 0 }] }],
  ]
  for (const [label, value] of badGrants) {
    assert.throws(() => grantsParse(value), undefined, `grants 必须拒绝：${label}`)
  }
  assert.throws(() => grantsReqParse({ revoke: 'yes' }), undefined, 'grants 请求必须拒绝非布尔 revoke')

  // 客户端必须有自己的等价校验器（浏览器侧不能 import Node 模块），
  // 且与 Host 同口径：同样的坏输入，两端都必须拒。
  const clientGrants = clientExports.statusRemote.descriptors.find(d => d.method === 'grants')
  const clientParseGrants = clientGrants.result.schema.parse
  const clientParseReq = clientGrants.parameters[0].codec.schema.parse
  assert.doesNotThrow(() => clientParseGrants(validGrants), 'client 必须接受合法 grants')
  for (const [label, value] of badGrants) {
    assert.throws(() => clientParseGrants(value), undefined, `client 必须拒绝 grants：${label}`)
  }
  assert.throws(() => clientParseReq({ revoke: 1 }), undefined, 'client 必须拒绝非布尔 revoke')
  console.log('PASS grants remote 描述符两端齐备、方法集一致、出入参均 fail-closed')
}

if (failed > 0) {
  console.error(`status: ${failed} 项失败`)
  process.exit(1)
}
console.log('status: 全部通过')
