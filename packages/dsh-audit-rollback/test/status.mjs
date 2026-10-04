#!/usr/bin/env node
/**
 * 假 ctx 调用 Host 只读状态查询。
 * 覆盖账本统计、objects 统计、capture 明细、配置回显。
 * 数据只写 test/.tmp-status，不写 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, queryAuditStatus, auditStatusRemote } from '../lib/index.js'
import { appendEntry, capturePath, initState, putObject, sha1Hex } from '../lib/ledger.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const tmpRoot = join(testDir, '.tmp-status')
const stateDir = join(tmpRoot, 'state')
const sample = join(tmpRoot, 'sample.txt')
const sampleText = 'hello-audit'

rmSync(tmpRoot, { recursive: true, force: true })
initState(stateDir)
writeFileSync(sample, sampleText)
appendEntry(stateDir, { kind: 'turn/start', session: 's', turn: 1 })
appendEntry(stateDir, { kind: 'call', session: 's', turn: 1, tool: 'write' })
const captured = capturePath(stateDir, {
  session: 's',
  turn: 1,
  path: sample,
  phase: 'before',
  maxBytes: 4096,
})
appendEntry(stateDir, { kind: 'turn/end', session: 's', turn: 1, captured: 1 })
appendEntry(stateDir, { kind: 'rollback', session: 's', turn: 1, applied: false })
appendEntry(stateDir, { kind: 'note', text: 'status-test' })
putObject(stateDir, Buffer.from('object-bytes'))

const fakeCtx = {
  logger: { info() {}, warn() {} },
  config: {
    stateDir,
    captureTools: ['write'],
    captureMaxBytes: 111,
    argsMaxBytes: 222,
    logCalls: false,
    excludeGlobs: ['/custom/'],
    gitSnapshot: true,
  },
}

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

ok('假 ctx 回显账本、objects、capture 与配置', () => {
  const status = queryAuditStatus(fakeCtx)
  assert.equal(status.plugin, 'dsh-audit-rollback')
  assert.equal(status.state.stateDir, stateDir)
  assert.equal(status.state.version, 1)
  assert.equal(typeof status.state.createdAt, 'string')
  assert.equal(status.ledger.fileCount, 1)
  assert.equal(status.ledger.entryCount, 6)
  assert.equal(status.ledger.byKind['turn/start'], 1)
  assert.equal(status.ledger.byKind.call, 1)
  assert.equal(status.ledger.byKind.capture, 1)
  assert.equal(status.ledger.byKind['turn/end'], 1)
  assert.equal(status.ledger.byKind.rollback, 1)
  assert.equal(status.ledger.byKind.note, 1)
  assert.equal(status.ledger.byKind.other, 0)
  assert.equal(status.objects.count, 2)
  assert.ok(status.objects.totalBytes >= Buffer.byteLength(sampleText) + Buffer.byteLength('object-bytes'))
  assert.equal(status.captures.uniquePaths, 1)
  assert.equal(status.captures.recent.length, 1)
  const row = status.captures.recent[0]
  assert.equal(row.phase, 'before')
  assert.equal(row.fileName, 'sample.txt')
  assert.equal(row.bytes, Buffer.byteLength(sampleText))
  assert.equal(row.hashPrefix, sha1Hex(Buffer.from(sampleText)).slice(0, 8))
  assert.equal(row.hashPrefix.length, 8)
  assert.equal(typeof row.ts, 'string')
  assert.equal(captured.hash.slice(0, 8), row.hashPrefix)
  assert.deepEqual(status.config.captureTools, ['write'])
  assert.equal(status.config.captureMaxBytes, 111)
  assert.equal(status.config.argsMaxBytes, 222)
  assert.equal(status.config.logCalls, false)
  assert.deepEqual(status.config.excludeGlobs, ['/custom/'])
  assert.equal(status.config.gitSnapshot, true)
  console.log(JSON.stringify({
    stateDir: status.state.stateDir,
    version: status.state.version,
    ledger: status.ledger,
    objects: status.objects,
    capture: row,
    config: status.config,
  }))
})

ok('apply 后的假 ctx 读到本次生效配置，且不要求 reflect/inject', () => {
  const live = {
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(fn) { const dispose = fn(); return dispose },
    get() { return undefined },
    config: { captureTools: ['stale'] },
  }
  apply(live, { stateDir, captureTools: ['edit'], gitSnapshot: false })
  const status = queryAuditStatus(live)
  assert.deepEqual(status.config.captureTools, ['edit'])
  assert.equal(status.config.gitSnapshot, false)
  assert.equal(status.state.stateReady, true)
  assert.equal(status.ledger.entryCount, 6)
})

ok('client 描述符与 host 对齐，且两端都没有核心包 import', () => {
  const client = readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8')
  const host = readFileSync(join(testDir, '..', 'lib', 'index.js'), 'utf8')
  assert.equal(auditStatusRemote.descriptors[0].id, 'dsh-audit-rollback#auditRollback/read')
  assert.ok(client.includes(auditStatusRemote.descriptors[0].id))
  assert.ok(client.includes("require('react')"))
  const forbidden = /(?:from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\/|import\(\s*['"]@deepseek-ai\/)/
  assert.equal(forbidden.test(client), false)
  assert.equal(forbidden.test(host), false)
})

rmSync(tmpRoot, { recursive: true, force: true })
if (failed > 0) {
  console.error(`status: ${failed} 项失败`)
  process.exit(1)
}
console.log('status: 全部通过')
