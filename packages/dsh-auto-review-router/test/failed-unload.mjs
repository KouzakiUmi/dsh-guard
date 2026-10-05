// P1-B 回归：真实 Cordis fiber.dispose 期间 session.append 抛 SESSION_WRITE_FAILED（收紧失败）时，
// 宿主强制排空仍会继续移除守卫与 Auto 注册（官方 registerAuto 是调用方 fiber 所属 effect，
// Cordis _unload 对失败 effect 逐个 catch 后继续）——插件必须如实上报 closeFailed，
// 不得再声称「Auto 注册与拒绝守卫仍保留」。零真实模型请求；只写测试自有目录。
import './runtime.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { Context, Service } = await import('@deepseek-ai/cordis')
const { SessionStore } = await import('@deepseek-ai/dsh-session')
const { ApprovalService } = await import('@deepseek-ai/dsh-user-approval')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { PermissionPresetService } = await import('@deepseek-ai/dsh-permission-presets')
const router = await import('../lib/index.js')

const testDir = dirname(fileURLToPath(import.meta.url))
const temp = await mkdtemp(join(testDir, '.tmp-failed-unload-'))

// 官方原型方法 + 最小夹具状态（loader-settings.mjs 同款接法）：registerAuto 的 effect
// 所有权与 derive 判定全部来自官方实现，只有会话 knob 折叠由夹具从真实事件流读出。
function knobsOf(session) {
  let preset = null, sandbox = null, approval = null
  for (const event of session.snapshotEvents()) {
    if (event.type === 'permission/preset') preset = event.data.preset
    else if (event.type === 'sandbox/mode') sandbox = event.data.mode
    else if (event.type === 'approval/policy') approval = event.data.policy
  }
  return { preset, sandbox, approval }
}
class FixturePermissions extends Service {
  constructor(scope) {
    super(scope, 'permissionPresets')
    this.presets = { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } }
  }
  registerAuto(admit) { return PermissionPresetService.prototype.registerAuto.call(this, admit) }
  emitCatalogChanged() {} // 官方 registerAuto 的目录广播；夹具无监听者
  specOf(name) { return PermissionPresetService.prototype.specOf.call(this, name) }
  current(session) { return PermissionPresetService.prototype.derive.call(this, knobsOf(session)) }
}

const ctx = new Context()
let permissions
try {
  const capabilities = ctx.plugin(scope => {
    scope.reflect.provide('profileContext', { dir: join(temp, 'profile') })
    scope.reflect.provide('systemPrompt', { tools() {}, context() {}, section() {} })
    scope.reflect.provide('shell', { sandboxMode: 'workspace-write' })
    scope.reflect.provide('llm', { stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() })
    permissions = new FixturePermissions(scope)
  })
  await capabilities.await()
  const sessionFiber = ctx.plugin(SessionStore); await sessionFiber.await()
  const approvalFiber = ctx.plugin(ApprovalService, { policy: 'ask' }); await approvalFiber.await()
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: 'native' }); await toolsFiber.await()
  const session = ctx.get('sessions').create('failed-unload', { meta: { cwd: temp } })
  session.requestHeader = () => ({ config: { provider: 'offline', model: 'fixture' }, tools: [{ name: 'edit', description: 'edit', parameters: { type: 'object' } }] })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })

  const fiber = ctx.plugin(router, { enabled: true, reviewerProvider: 'offline', reviewerModel: 'fixture', logDecisions: false })
  await fiber.await()
  assert.equal(router.queryRouterStatus(fiber.ctx).registration.registered, true)

  // 合成用户选中 Auto：真实会话事件，official derive 判定为 auto。
  session.append('permission/preset', { preset: 'auto' })
  session.append('sandbox/mode', { mode: 'danger-full-access' })
  session.append('approval/policy', { policy: 'ask' })
  assert.equal(ctx.get('permissionPresets').current(session), 'auto')

  // 卸载前守卫是活的：gate 会审查 Auto 调用（reviewer allow → 透传下游）。
  const exec = { name: 'edit', callId: 'c1', arguments: {}, agent: { session }, signal: new AbortController().signal }
  let downstream = 0
  const run = () => ctx.waterfall('tools/pre-execute', exec, async () => { downstream++; return { kind: 'allow' } })
  const first = await run()
  assert.equal(first.kind, 'allow', JSON.stringify(first))
  assert.equal(downstream, 1)

  // 注入故障：真实 Session 实例的 append 抛 SESSION_WRITE_FAILED（setSandboxMode 的收紧写失败）。
  session.append = () => { throw new Error('SESSION_WRITE_FAILED') }
  const started = Date.now()
  await fiber.dispose() // Cordis 强制排空：effect 失败被记录但不中断其余排空
  assert.ok(Date.now() - started < 10000, '失败卸载必须有界结束')

  // 宿主行为实证：尽管收紧失败，守卫监听与 Auto 注册都被宿主移除（平台强析构极限）。
  assert.equal((await run()).kind, 'allow', '守卫已被宿主移除，下游直达')
  assert.equal(downstream, 2)
  assert.notEqual(ctx.get('permissionPresets').current(session), 'auto', 'Auto 注册已被宿主移除')
  assert.ok(!session.snapshotEvents().some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only'),
    '收紧写失败：会话未被收窄为只读')

  // 状态诚实：registered=false + closeFailed + 明确的人工收紧指引；不得再声称守卫仍保留。
  const status = router.queryRouterStatus(fiber.ctx)
  assert.equal(status.registration.registered, false, '失败后不得再报 registered=true')
  assert.equal(status.registration.closeFailed, true)
  assert.match(status.registration.error, /人工收紧/)
  assert.ok(!status.registration.error.includes('仍保留'), '不得复用「仍保留」假保留文案')
  // 状态必须通过 Host/Client 双方统一 parser（P2 形状）。
  routerStatusParse(status)
  console.log('PASS 真实 Cordis failed-unload：宿主强制移除守卫/Auto，状态如实报 closeFailed + 人工收紧指引')
} finally {
  await ctx.fiber.dispose()
  const resolvedTemp = resolve(temp)
  assert.ok(resolvedTemp.startsWith(resolve(testDir)) && temp.includes('.tmp-failed-unload-'))
  await rm(temp, { recursive: true, force: true })
}
console.log('failed-unload: 全部通过（真实 Cordis/SessionStore/官方 registerAuto；零真实模型请求）')

function routerStatusParse(status) {
  const { routerStatusRemote } = router
  return routerStatusRemote.descriptors[0].result.schema.parse(JSON.parse(JSON.stringify(status)))
}
