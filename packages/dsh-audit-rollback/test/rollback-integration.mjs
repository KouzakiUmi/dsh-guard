// Real installed alpha.1 Cordis Loader + Typert Registry/Gateway. No listener/model/profile install.
import './bootstrap.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { installedPath } from './bootstrap.mjs'
import { readAllEntries } from '../lib/ledger.js'
const audit = await import('../lib/index.js')
const [{ Context }, { Loader }, { mountRootInclude }, { TypertRegistry }, { TypertGatewayService }] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/cordis-plugin-loader'), import('@deepseek-ai/dsh-app-boot'),
  import('@deepseek-ai/dsh-typert-registry'), import('@deepseek-ai/dsh-api-gateway'),
])
const root = mkdtempSync(join(tmpdir(), 'dsh-rollback-integration-'))
assert.ok(isAbsolute(root) && root.includes('dsh-rollback-integration-'))
const home = join(root, 'home'), dir = join(home, 'profiles', 'fixture'), stateDir = join(root, 'state')
mkdirSync(dir, { recursive: true })
const patchPath = join(dir, 'cordis.patch.yml'), configPath = join(root, 'base.yml')
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dsh: { profile: { bundles: [] } } }))
writeFileSync(configPath, '[]\n')
const patch = [{ insert: [{ id: 'audit-rollback', name: 'cordis:audit', config: { stateDir, captureTools: ['write'], logCalls: true, captureMaxBytes: 1024, excludeGlobs: [] } }] }]
writeFileSync(patchPath, JSON.stringify(patch))
const ctx = new Context()
// HIGH-3 假 session 服务：inspect 只读不激活；agents.get 回报轮次状态。
// 覆盖四态——存在且空闲可恢复、不存在拒绝、活跃轮拒绝（服务缺失在单测侧覆盖）。
// 'other' 也存在：跨会话取 entry 必须落到 ENTRY_NOT_IN_SESSION 而非会话校验。
const knownSessions = new Set(['integration-session', 'other'])
let agentStatus = 'idle'
const fakeSessionController = {
  inspect: async (sessionId) => {
    if (!knownSessions.has(sessionId)) throw new Error(`session "${sessionId}" not found`)
    return { meta: { id: sessionId }, inheritedEventCount: 0, events: [] }
  },
}
const fakeAgents = { get: (sessionId) => (knownSessions.has(sessionId) ? { status: agentStatus } : undefined) }
try {
  ctx.reflect.provide('profileContext', { name: 'fixture', home, dir, patchPath, overlays: [], installAnchor: installedPath('@deepseek-ai/dsh-app-boot/package.json') })
  ctx.reflect.provide('tools', {})
  ctx.reflect.provide('sessionController', fakeSessionController)
  ctx.reflect.provide('agents', fakeAgents)
  await ctx.plugin(TypertRegistry).await()
  await ctx.plugin(TypertGatewayService).await()
  await ctx.plugin(Loader).await(); ctx.loader.builtins.audit = audit
  await mountRootInclude(ctx, configPath, patch); await ctx.loader.await()
  const entry = ctx.configEditor?.entries?.().find((row) => row.options.id === 'audit-rollback')
  const service = ctx.get('auditRollback'); assert.ok(service)
  for (const method of ['read', 'changedFiles', 'preview', 'restore']) {
    const descriptor = ctx.typert.local.get('auditRollback/' + method)
    assert.ok(descriptor, method); assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.parameters.length, method === 'read' ? 0 : 1)
  }
  const rpc = (method, request) => ctx.typertGateway.invoke({ namespace: 'auditRollback', method, args: method === 'read' ? {} : { request } })
  assert.equal((await rpc('read')).plugin, 'dsh-audit-rollback')
  console.log('PASS real Loader ACTIVE / reflection service / four strict descriptors / Gateway read')
  const file = join(root, 'target.txt'), session = { id: 'integration-session', header: { cwd: root } }
  writeFileSync(file, 'original')
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await ctx.waterfall('tools/pre-execute', { name: 'write', arguments: { file_path: file, content: 'NEVER_PERSIST_SECRET_ARGUMENT', secret: 'fixture-secret' }, callId: 'fixture-call', agent: { session } }, async () => { writeFileSync(file, 'edited'); return { isError: false } })
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })
  const ledger = readAllEntries(stateDir)
  assert.equal(JSON.stringify(ledger).includes('NEVER_PERSIST_SECRET_ARGUMENT'), false); assert.equal(JSON.stringify(ledger).includes('fixture-secret'), false)
  assert.equal(ledger.find((e) => e.phase === 'before').tool, 'write')
  const files = await rpc('changedFiles', { sessionId: session.id }); assert.equal(files.total, 1); assert.equal(files.rows[0].current.status, 'file')
  const preview = await rpc('preview', { sessionId: session.id, entryId: files.rows[0].entryId }); assert.equal(preview.canRestore, true)
  assert.equal(readFileSync(file, 'utf8'), 'edited', 'preview never mutates')
  const request = { sessionId: session.id, entryId: preview.entryId, nonce: preview.nonce, expectedCurrentHash: preview.expectedCurrentHash }
  await assert.rejects(rpc('restore', { ...request, path: file }), (e) => e.code === 'gateway/input-invalid' && /UNEXPECTED/.test(e.cause?.message || ''))
  await assert.rejects(rpc('preview', { sessionId: 'other', entryId: preview.entryId }), /ENTRY_NOT_IN_SESSION/)
  const receipt = await rpc('restore', request); assert.equal(receipt.applied, true); assert.equal(readFileSync(file, 'utf8'), 'original')
  await assert.rejects(rpc('restore', request), /INVALID_OR_EXPIRED/)
  console.log('PASS real Gateway list/preview/restore / strict path refusal / cross session refusal / nonce replay refusal / arguments not persisted')
  // HIGH-3：不存在拒绝（三方法一致 fail-closed）、活跃轮只拒绝 mutation、读路径仍可用
  await assert.rejects(rpc('changedFiles', { sessionId: 'nonexistent-session' }), /SESSION_NOT_FOUND/)
  await assert.rejects(rpc('preview', { sessionId: 'nonexistent-session', entryId: preview.entryId }), /SESSION_NOT_FOUND/)
  await assert.rejects(rpc('restore', { ...request, sessionId: 'nonexistent-session' }), /SESSION_NOT_FOUND/)
  agentStatus = 'running'
  await assert.rejects(rpc('restore', request), /SESSION_TURN_ACTIVE/, 'assertSession 必须先于票据校验拒绝')
  const duringActive = await rpc('preview', { sessionId: session.id, entryId: preview.entryId })
  assert.equal(typeof duringActive.canRestore, 'boolean', '活跃轮下 preview 读路径保持可用')
  agentStatus = 'idle'
  console.log('PASS session verifier wired: unknown session denied everywhere, active turn denies restore only')
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
  await ctx.waterfall('tools/pre-execute', { name: 'write', arguments: { file_path: file, content: 'refused' }, agent: { session } }, async () => ({ isError: false, refused: true }))
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2 } })
  assert.equal(readAllEntries(stateDir).filter((e) => e.kind === 'capture').length, 4)
  // A refused body may still have captures. Only actual filesystem snapshots determine state.
  assert.equal(readFileSync(file, 'utf8'), 'original')
  console.log('PASS refused/no-body tool still captured actual filesystem facts, no ToolResult success assumption')
} finally {
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
console.log('rollback-integration: all passed; no real profile/GUI/model touched')
