#!/usr/bin/env node
// Real Cordis Loader + SettingsForms + ConfigEditor, isolated temporary profile only.
import './bootstrap.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedPath } from './bootstrap.mjs'
import { readAllEntries, sha1Hex } from '../lib/ledger.js'
const audit = await import('../lib/index.js')
let runtime
try {
  runtime = await Promise.all([
    import('@deepseek-ai/cordis'), import('@deepseek-ai/cordis-plugin-loader'),
    import('@deepseek-ai/dsh-settings'), import('@deepseek-ai/dsh-config-editor'),
    import('@deepseek-ai/dsh-app-boot'),
  ])
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error
  console.log('SKIP real settings integration: official Loader/settings/configEditor dependencies absent; install declared test peers or set DSH_APP_ROOT')
  process.exit(0)
}
const [{ Context }, { Loader }, { SettingsForms }, { ConfigEditor }, { mountRootInclude }] = runtime
const rootDir = mkdtempSync(join(tmpdir(), 'dsh-audit-settings-'))
const home = join(rootDir, 'home')
const dir = join(home, 'profiles', 'isolated-audit')
const stateDir = join(rootDir, 'state')
mkdirSync(dir, { recursive: true })
const patchPath = join(dir, 'cordis.patch.yml')
const profileManifest = join(dir, 'package.json')
writeFileSync(profileManifest, JSON.stringify({ name: 'isolated-audit', private: true, dsh: { profile: { bundles: [] } } }))
writeFileSync(patchPath, JSON.stringify([{ insert: [{ id: 'audit-rollback', name: 'cordis:audit', config: {
  stateDir, captureTools: ['write'], captureMaxBytes: 1024, argsMaxBytes: 40,
  logCalls: true, excludeGlobs: [], gitSnapshot: false,
} }] }]))
const configPath = join(rootDir, 'base.yml')
writeFileSync(configPath, '[]\n')
const ctx = new Context()
try {
  ctx.reflect.provide('profileContext', {
    name: 'isolated-audit', home, dir, patchPath, overlays: [],
    installAnchor: installedPath('@deepseek-ai/dsh-app-boot/package.json'),
  })
  ctx.reflect.provide('tools', {})
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.audit = audit
  await mountRootInclude(ctx, configPath, JSON.parse(readFileSync(patchPath, 'utf8')))
  await ctx.plugin(ConfigEditor).await()
  await ctx.plugin(SettingsForms).await()
  await ctx.loader.await()
  const entry = ctx.configEditor.entries().find((row) => row.options.id === 'audit-rollback')
  assert.ok(entry)
  assert.equal(entry.fiber.state, 2)
  const fiber = entry.fiber
  const form = () => ctx.settings.describe().find((row) => row.ns === 'audit-rollback')
  const first = form()
  assert.ok(first)
  assert.equal(first.applies, 'live')
  assert.equal(first.autoGenerate, false)
  assert.deepEqual(Object.keys(first.schema.refs[first.schema.uid].dict).sort(), ['argsMaxBytes', 'captureMaxBytes', 'captureTools', 'excludeGlobs', 'logCalls'].sort())
  assert.equal(typeof fiber.config.captureMaxBytes.get, 'function')
  console.log('通过 real Loader Config schema / volatile form / stateDir & gitSnapshot read-only')

  const session = { id: 'integration', header: { cwd: rootDir } }
  const file = join(rootDir, 'target.txt')
  writeFileSync(file, 'before')
  const start = (turn) => ctx.emit('session/event', session, { type: 'turn/start', data: { turn } })
  const end = (turn) => ctx.emit('session/event', session, { type: 'turn/end', data: { turn } })
  const edit = async (content) => {
    const exec = { name: 'write', arguments: { file_path: file, content }, callId: 'c', agent: { session } }
    await ctx.waterfall('tools/pre-execute', exec, async () => { writeFileSync(file, content); return 'ok' })
  }
  start(1)
  await edit('during-old-turn')
  const initialBytes = readFileSync(patchPath, 'utf8')
  await ctx.settings.update('audit-rollback', { captureMaxBytes: 1, argsMaxBytes: 2, logCalls: false, captureTools: ['edit'], excludeGlobs: ['/not-this/'] }, first.revision)
  assert.equal(entry.fiber, fiber, 'volatile update must not remount plugin')
  assert.equal(fiber.config.captureMaxBytes.get(), 1)
  assert.equal(fiber.config.captureTools.get()[0], 'edit')
  assert.notEqual(readFileSync(patchPath, 'utf8'), initialBytes)
  assert.equal(audit.queryAuditStatus(fiber.ctx).config.logCalls, false)
  end(1)
  const oldEntries = readAllEntries(stateDir).filter((row) => row.turn === 1)
  assert.equal(oldEntries.find((row) => row.phase === 'after').hash, sha1Hex(Buffer.from('during-old-turn')), 'after must use frozen old capture limit')
  assert.equal(oldEntries.find((row) => row.phase === 'before').hash, sha1Hex(Buffer.from('before')))
  console.log('通过 official update persistence / same fiber / volatile .get / frozen in-flight capture snapshot')

  start(2)
  await edit('new-turn')
  end(2)
  assert.equal(readAllEntries(stateDir).filter((row) => row.turn === 2 && ['call', 'capture'].includes(row.kind)).length, 0)
  console.log('通过 new turn uses live captureTools/logCalls configuration')
  const current = form()
  const stable = readFileSync(patchPath, 'utf8')
  await assert.rejects(ctx.settings.update('audit-rollback', { logCalls: true }, first.revision), (error) => error.code === 'SETTINGS_CONFLICT')
  await assert.rejects(ctx.settings.update('audit-rollback', { captureMaxBytes: 0 }, current.revision))
  await assert.rejects(ctx.settings.update('audit-rollback', { stateDir: join(rootDir, 'other') }, current.revision), /not volatile/)
  await assert.rejects(ctx.settings.update('audit-rollback', { gitSnapshot: true }, current.revision), /not volatile/)
  assert.equal(readFileSync(patchPath, 'utf8'), stable, 'conflict/validation/read-only failure must not persist')
  assert.equal(entry.fiber, fiber)
  console.log('通过 stale revision conflict / backend validation / ordinary fields refusal / no persistence on error')
  await ctx.settings.update('audit-rollback', { captureTools: ['write'], captureMaxBytes: 1, logCalls: true, excludeGlobs: [] }, form().revision)
  start(3)
  await edit('large')
  end(3)
  const third = readAllEntries(stateDir).filter((row) => row.turn === 3)
  assert.equal(third.find((row) => row.phase === 'before').hash, null)
  assert.ok(third.some((row) => row.kind === 'call'))
  console.log('通过 new captureMaxBytes and logCalls affect actual next-turn ledger')
  assert.equal(fiber.config.stateDir, stateDir)
  assert.equal(JSON.parse(readFileSync(profileManifest, 'utf8')).name, 'isolated-audit')
} finally {
  await ctx.fiber.dispose()
  rmSync(rootDir, { recursive: true, force: true })
}
console.log('settings-integration: all passed; temporary profile removed, real profile untouched')
