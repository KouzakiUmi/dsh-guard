#!/usr/bin/env node
// 精确注入异步间隙/不可读 tree；恢复操作仍使用真实临时文件，不调用 Git 或生产 profile。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import * as ledger from '../lib/ledger.js'
import * as boundary from '../lib/boundary.js'
import { BOUNDARY_REF_PREFIX, canonicalRoot, toRelPath } from '../lib/snapshot.js'

const TMP = fs.mkdtempSync(join(tmpdir(), 'dsh-boundary-safety-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const tree = 'a'.repeat(40)
const sourceOf = (name) => fs.readFileSync(new URL(`../lib/${name}.js`, import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
  .replace(/^export /gm, '')
function fixture(name) {
  const root = join(TMP, name, 'work')
  const stateDir = join(TMP, name, 'state')
  fs.mkdirSync(root, { recursive: true })
  ledger.initState(stateDir)
  return { root, stateDir, session: name, turn: 1 }
}
function loadExecution(overrides = {}) {
  return runInNewContext(`${sourceOf('boundary-exec')}\n({ executeBoundaryRollback, redoBoundaryRollback })`, {
    Buffer, console, ...fs, dirname, join, ...ledger, ...boundary, BOUNDARY_REF_PREFIX, canonicalRoot, toRelPath,
    captureTree: async () => ({ ok: true, tree }),
    writeBoundaryRef: async () => ({ ok: true }),
    readBlob: async () => ({ ok: true, buffer: Buffer.from('baseline'), bytes: 8 }),
    ...overrides,
  })
}

test('计划后/preTree 期间的写入必须 skip，force 也不能授权未来写入被覆盖', async () => {
  for (const force of [false, true]) {
    const options = fixture(`race-${force}`)
    const file = join(options.root, 'a.txt')
    fs.writeFileSync(file, 'planned-current')
    const expectedCurrent = boundary.readCurrentFile(file)
    let captures = 0
    const api = loadExecution({
      planBoundaryRollback: async () => ({ ok: true, boundary: { tree },
        counted: { restore: 1, trash: 0, skip: 0 },
        actions: [{ path: file, action: 'restore', from: tree,
          expectedCurrent: { existed: true, oid: expectedCurrent.oid } }] }),
      captureTree: async () => {
        if (captures++ === 0) fs.writeFileSync(file, 'new-write-after-plan')
        return { ok: true, tree }
      },
    })
    const result = await api.executeBoundaryRollback({ ...options, force, apply: true })
    assert.equal(result.changed, 0)
    assert.equal(result.actions[0].action, 'skip')
    assert.match(result.actions[0].reason, /CURRENT_STATE_CHANGED_AFTER_PLAN/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'new-write-after-plan')
  }
})

test('restore 写入失败：已移走的原文件必须恢复原位', async () => {
  const options = fixture('write-failure')
  const file = join(options.root, 'a.txt')
  fs.writeFileSync(file, 'current')
  const current = boundary.readCurrentFile(file)
  const api = loadExecution({
    planBoundaryRollback: async () => ({ ok: true, boundary: { tree }, counted: { restore: 1, trash: 0, skip: 0 },
      actions: [{ path: file, action: 'restore', from: tree, expectedCurrent: { existed: true, oid: current.oid } }] }),
    writeFileSync: () => { throw new Error('INJECTED_WRITE_FAILURE') },
  })
  const result = await api.executeBoundaryRollback({ ...options, apply: true })
  assert.equal(result.changed, 0)
  assert.equal(result.actions[0].action, 'skip')
  assert.equal(fs.readFileSync(file, 'utf8'), 'current')
})

test('恢复失败时若目标被并发创建，保留新文件与旧备份，不能搬回覆盖', async () => {
  const options = fixture('concurrent-create')
  const file = join(options.root, 'a.txt')
  fs.writeFileSync(file, 'original')
  const current = boundary.readCurrentFile(file)
  const api = loadExecution({
    planBoundaryRollback: async () => ({ ok: true, boundary: { tree }, counted: { restore: 1, trash: 0, skip: 0 },
      actions: [{ path: file, action: 'restore', from: tree, expectedCurrent: { existed: true, oid: current.oid } }] }),
    writeFileSync: () => { fs.writeFileSync(file, 'concurrent-new-file'); throw new Error('EEXIST') },
  })
  const result = await api.executeBoundaryRollback({ ...options, apply: true })
  assert.equal(result.changed, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent-new-file')
  assert.equal(fs.readFileSync(result.actions[0].backup, 'utf8'), 'original')
  assert.equal(ledger.readAllEntries(options.stateDir).at(-1).actions[0].backup, result.actions[0].backup)
})

test('POSIX 可执行文件恢复保留 100755 模式', { skip: process.platform === 'win32' }, async () => {
  const options = fixture('executable-mode')
  const file = join(options.root, 'script.sh')
  fs.writeFileSync(file, 'current', { mode: 0o755 })
  const current = boundary.readCurrentFile(file)
  const api = loadExecution({
    planBoundaryRollback: async () => ({ ok: true, boundary: { tree }, counted: { restore: 1, trash: 0, skip: 0 },
      actions: [{ path: file, action: 'restore', from: tree, mode: '100755', expectedCurrent: { existed: true, oid: current.oid } }] }),
  })
  const result = await api.executeBoundaryRollback({ ...options, apply: true })
  assert.equal(result.changed, 1)
  assert.equal(fs.statSync(file).mode & 0o777, 0o755)
})

test('redo --force 不能绕过不可读参照，也不能移动文件', async () => {
  const options = fixture('redo-reference')
  const file = join(options.root, 'a.txt')
  fs.writeFileSync(file, 'current')
  const api = loadExecution({ readTreeEntry: async ({ tree: value }) => value === 'b'.repeat(40)
    ? { ok: false, reason: 'MISSING_REFERENCE' }
    : { ok: true, exists: true, type: 'blob', mode: '100644', oid: tree } })
  const result = await api.redoBoundaryRollback({ ...options, apply: true, force: true,
    entries: [{ kind: 'rollback', session: options.session, turn: options.turn, applied: true, source: 'snapshot',
      preTree: tree, postTree: 'b'.repeat(40), actions: [{ path: file, action: 'restore' }] }] })
  assert.equal(result.changed, 0)
  assert.equal(result.actions[0].action, 'skip')
  assert.match(result.actions[0].reason, /参照不可读/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'current')
})

test('边界 tree 中 mode120000 的 blob 是符号链接，不能当普通文件恢复', async () => {
  const options = fixture('symlink-mode')
  const file = join(options.root, 'link.txt')
  const api = runInNewContext(`${sourceOf('boundary')}\n({ planBoundaryRollback })`, {
    Buffer, console, createHash, join, ...ledger, BOUNDARY_REF_PREFIX, canonicalRoot, toRelPath,
    readTreeEntry: async ({ tree: value }) => value === tree
      ? { ok: true, exists: true, type: 'blob', mode: '120000', oid: 'c'.repeat(40) }
      : { ok: true, exists: false, type: null, mode: null, oid: null },
  })
  const result = await api.planBoundaryRollback({ ...options, entries: [
    { kind: 'snapshot', session: options.session, turn: 1, step: 0, phase: 'start', tree },
    { kind: 'attribution', session: options.session, turn: 1, step: 0,
      from: tree, to: 'b'.repeat(40), paths: [file] },
  ] })
  assert.equal(result.actions[0].action, 'skip')
  assert.match(result.actions[0].reason, /120000/)
  assert.equal(fs.existsSync(file), false)
})
