// Real Cordis Loader + official Settings and ConfigEditor. Never loads a user profile.
import './runtime.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { Context, Service } = await import('@deepseek-ai/cordis')
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const { default: Settings } = await import('@deepseek-ai/dsh-settings')
const { default: ConfigEditor } = await import('@deepseek-ai/dsh-config-editor')
const { mountRootInclude, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
const { queryRouterStatus } = await import('../lib/index.js')
const { PermissionPresetService } = await import('@deepseek-ai/dsh-permission-presets')

const temp = await mkdtemp(join(tmpdir(), 'router-settings-'))
const profileDir = join(temp, 'profile')
const bundleDir = join(profileDir, 'node_modules', 'router-fixture-bundle')
await mkdir(bundleDir, { recursive: true })
const routerPath = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../lib/index.js')).href
await writeFile(join(bundleDir, 'package.json'), JSON.stringify({ name: 'router-fixture-bundle', version: '0.0.0', peerDependencies: { '@deepseek-ai/dsh': '0.2.1-alpha.1' }, dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } } }))
await writeFile(join(bundleDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'auto-review-router', name: routerPath, config: {} }] }]))
await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'router-test-profile', dsh: { profile: { bundles: ['router-fixture-bundle'] } } }))
await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
await writeFile(join(temp, 'root.yml'), '[]\n')
const profile = { name: 'router-test', dir: profileDir, home: temp, installAnchor: join(profileDir, 'package.json'), patchPath: join(profileDir, 'cordis.patch.yml'), overlays: [] }
const ctx = new Context()
let admitted, removed = 0, streamCalls = 0, requests = [], release
const session = {
  mode: 'danger-full-access', policy: 'never', events: [], header: { cwd: temp },
  append(type, data) { this.events.push({ type, data }); if (type === 'sandbox/mode') this.mode = data.mode },
  requestHeader() { return { config: { provider: 'session', model: 'session-model' }, tools: [{ name: 'edit', description: 'edit', parameters: { type: 'object' } }] } }, snapshotEvents() { return [] },
}
const services = {
  profileContext: profile, tools: {}, approval: { overrideOf: () => session.policy }, sessions: { list: () => [session] },
  permissionPresets: {
    current: () => session.mode === 'read-only' ? 'custom' : admitted ? 'auto' : 'custom',
    registerAuto(admit) {
      if (admitted) throw new Error('permission: preset "auto" is already registered')
      admitted = admit
      return () => { admitted = undefined; removed++ }
    },
  },
  llm: { stream(request) {
    streamCalls++; requests.push(request)
    return (async function* () {
      if (release) await new Promise(resolve => { release.resolve = resolve })
      yield { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  } },
}
class FixturePermissions extends Service {
  constructor(scope) { super(scope, 'permissionPresets'); this.presets = { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } }
  registerAuto(admit) { return PermissionPresetService.prototype.registerAuto.call(this, admit) }
  emitCatalogChanged() { admitted = this.autoAdmit; if (!admitted) removed++ }
  specOf(name) { return PermissionPresetService.prototype.specOf.call(this, name) }
  current() {
    return PermissionPresetService.prototype.derive.call(this, { preset: 'auto', sandbox: session.mode, approval: session.policy })
  }
}
services.shell = { sandboxMode: 'workspace-write' }
services.approval.config = { policy: 'never' }
delete services.permissionPresets
const serviceFiber = ctx.plugin(scope => {
  for (const [name, value] of Object.entries(services)) scope.reflect.provide(name, value)
  new FixturePermissions(scope)
})
await serviceFiber.await()
const loaderFiber = ctx.plugin(Loader)
await loaderFiber.await()
const editorFiber = ctx.plugin(ConfigEditor)
await editorFiber.await()
const settingsFiber = ctx.plugin(Settings)
await settingsFiber.await()
const exec = { name: 'edit', callId: 'c1', arguments: { path: 'x' }, agent: { session }, signal: new AbortController().signal }
let downstream = 0
const run = () => ctx.waterfall('tools/pre-execute', exec, async () => { downstream++; return { kind: 'allow' } })
try {
  await ctx.fiber.await()
  await mountRootInclude(ctx, join(temp, 'root.yml'), readProfilePatches('dsh', profile))
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'auto-review-router')
  assert.ok(entry, 'router Loader entry')
  await entry.fiber.await()
  assert.equal(entry.fiber.state, 2, 'active router')
  const fiber = entry.fiber
  const reference = fiber.config
  const settings = ctx.get('settings')
  const form = () => settings.describe().find(row => row.ns === 'auto-review-router')
  assert.equal(form().autoGenerate, false)
  assert.equal(form().value.enabled, false)
  let revision = form().revision
  await settings.update('auto-review-router', { enabled: true, reviewerProvider: 'p1', reviewerModel: 'm1', reviewerEffort: 'high' }, revision)
  assert.equal(entry.fiber, fiber, 'volatile enable does not remount')
  assert.equal(fiber.config, reference, 'stable Config reference')
  assert.equal(reference.get().enabled, true)
  assert.ok(admitted)
  assert.equal(session.policy, 'never')
  assert.equal(queryRouterStatus(fiber.ctx).registration.registered, true)
  const persisted = await readFile(profile.patchPath, 'utf8')
  assert.match(persisted, /enabled: true/)
  await assert.rejects(settings.update('auto-review-router', { historyLimit: 1 }, revision), error => error.code === 'SETTINGS_CONFLICT')
  assert.equal(await readFile(profile.patchPath, 'utf8'), persisted)
  revision = form().revision
  await assert.rejects(settings.update('auto-review-router', { timeoutMs: -1 }, revision))
  await assert.rejects(settings.update('auto-review-router', { reviewerModel: '' }, revision))
  assert.equal(await readFile(profile.patchPath, 'utf8'), persisted)
  console.log('PASS real Loader/settings/configEditor: persisted save, validation, revision conflict, stable fiber/reference')

  release = {}
  const pending = run()
  // Wait only for the synthetic stream to reach its controlled boundary.
  while (!release.resolve) await new Promise(resolve => setImmediate(resolve))
  await settings.update('auto-review-router', { reviewerProvider: 'p2', reviewerModel: 'm2', reviewerEffort: 'low', temperature: 0.3 }, form().revision)
  assert.equal(requests[0].provider, 'p1')
  assert.equal(requests[0].model, 'm1')
  assert.equal(requests[0].reasoningEffort, 'high')
  release.resolve(); release = undefined
  assert.equal((await pending).kind, 'allow')
  assert.equal((await run()).kind, 'allow')
  assert.equal(requests[1].provider, 'p2')
  assert.equal(requests[1].model, 'm2')
  assert.equal(requests[1].reasoningEffort, 'low')
  assert.equal(requests[1].temperature, 0.3)
  console.log('PASS per-review immutable snapshot; hot route/model/effort/temperature uses next request')

  release = {}
  const interrupted = run()
  while (!release.resolve) await new Promise(resolve => setImmediate(resolve))
  await settings.update('auto-review-router', { enabled: false }, form().revision)
  assert.equal((await interrupted).kind, 'cancel')
  assert.equal(downstream, 2)
  assert.equal(session.mode, 'read-only')
  assert.equal(session.policy, 'never')
  assert.deepEqual(session.events, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
  assert.equal(removed, 1)
  release.resolve(); release = undefined
  assert.equal(queryRouterStatus(fiber.ctx).registration.registered, false)
  await settings.update('auto-review-router', { enabled: true }, form().revision)
  assert.ok(admitted)
  assert.equal(session.mode, 'read-only', 'enable never raises existing permissions')
  assert.equal(entry.fiber, fiber)
  await settings.update('auto-review-router', { enabled: false }, form().revision)
  assert.equal(removed, 2)
  console.log('PASS hot disable/re-enable: cancel in-flight review, narrow to read-only, preserve never, no permission elevation')
  assert.equal(streamCalls, 3)
  // 成功关闭后，新合法 Auto 所有者不应被旧守卫误拦；使用官方注册与 derive。
  const otherOwner = ctx.plugin({ inject: ['permissionPresets'], apply(scope) { scope.permissionPresets.registerAuto(() => {}) } })
  await otherOwner.await()
  session.mode = 'danger-full-access' // 合成用户明确选择新所有者的 Auto。
  assert.equal(ctx.get('permissionPresets').current(session), 'auto')
  const beforeHandoff = downstream
  assert.equal((await run()).kind, 'allow')
  assert.equal(downstream, beforeHandoff + 1)
  assert.equal(streamCalls, 3, '旧插件不得审查新 Auto 所有者的调用')
  await otherOwner.dispose()
  session.mode = 'read-only' // 合成用户再次明确收紧，不修改真实会话。
  console.log('PASS successful disable releases guard: new official Auto owner reaches downstream')
  const removalsBeforeUnload = removed
  // Exercise official effect ownership + derive during a live-generation unload.
  await settings.update('auto-review-router', { enabled: true }, form().revision)
  session.mode = 'danger-full-access' // Synthetic user selecting Auto; no real session.
  assert.equal(ctx.get('permissionPresets').current(session), 'auto')
  await fiber.dispose()
  assert.equal(session.mode, 'read-only', 'shutdown must narrow BEFORE official Auto effect disappears')
  assert.equal(session.policy, 'never')
  assert.equal(admitted, undefined)
  assert.equal(removed, removalsBeforeUnload + 1)
  console.log('PASS real official registerAuto effect + derive: live unload narrows before unregister, preserves never')
} finally {
  await ctx.fiber.dispose()
  // Verified absolute test-owned path; never a user profile, package tree or installation.
  assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/'))
  assert.ok(temp.includes('router-settings-'))
  await rm(temp, { recursive: true, force: true })
}
console.log('loader-settings: 全部通过（临时 profile；零真实模型请求）')
