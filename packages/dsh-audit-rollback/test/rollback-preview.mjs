import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync, symlinkSync, unlinkSync, linkSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { initState, appendEntry, capturePath, createTurnState, readAllEntries, objectPath } from '../lib/ledger.js'
import { createRollbackApi, UI_MAX_BYTES, compactDiff } from '../lib/rollback-preview.js'
import { parseRollbackRequest } from '../lib/rollback-remote.js'
const root = mkdtempSync(join(tmpdir(), 'dsh-rollback-preview-'))
assert.ok(isAbsolute(root) && root.includes('dsh-rollback-preview-'))
let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name) }
let scenarioId = 0
function scenario({ before = 'old\nline\n', after = 'new\nline\n', post = true, ended = true, maxBytes = UI_MAX_BYTES, apiOptions } = {}) {
  const dir = join(root, String(++scenarioId)); mkdirSync(dir)
  const stateDir = join(dir, 'state'); initState(stateDir)
  const file = join(dir, 'file.txt'); const sessionId = 'session-' + scenarioId
  const turnState = createTurnState()
  appendEntry(stateDir, { kind: 'turn/start', session: sessionId, turn: 1, cwd: dir })
  if (before !== null) writeFileSync(file, before)
  const pre = capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'before', maxBytes, turnState, tool: 'write', callId: 'call' })
  if (after === null) { if (existsSync(file)) unlinkSync(file) } else writeFileSync(file, after)
  const afterEntry = post ? capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'after', maxBytes, turnState }) : null
  if (ended) appendEntry(stateDir, { kind: 'turn/end', session: sessionId, turn: 1 })
  // Unit-level default: existence/turn checks are wired in lib/index.js (HIGH-3);
  // here a permissive fake keeps the focus on preview/restore semantics.
  const api = createRollbackApi(stateDir, { assertSession: async () => {}, ...apiOptions })
  const row = async () => (await api.changedFiles({ sessionId })).rows[0]
  const preview = async () => api.preview({ sessionId, entryId: (await row()).entryId })
  const bind = (p) => ({ sessionId, entryId: p.entryId, nonce: p.nonce, expectedCurrentHash: p.expectedCurrentHash })
  return { dir, stateDir, file, sessionId, pre, afterEntry, api, row, preview, bind }
}
try {
  await test('text diff, explicit preview, single restore, backup and append-only actual receipt', async () => {
    const s = scenario(); const p = await s.preview()
    assert.equal(p.canRestore, true); assert.equal(p.diff.kind, 'text'); assert.match(p.diff.text, /-old/); assert.match(p.diff.text, /\+new/)
    const receipt = await s.api.restore(s.bind(p)); assert.equal(receipt.applied, true); assert.equal(receipt.recorded, true)
    assert.equal(readFileSync(s.file, 'utf8'), 'old\nline\n'); assert.equal(readFileSync(receipt.backup, 'utf8'), 'new\nline\n')
    assert.ok(readAllEntries(s.stateDir).some((e) => e.phase === 'receipt' && e.applied))
    await assert.rejects(s.api.restore(s.bind(p)), /INVALID_OR_EXPIRED/)
  })
  await test('manual hash conflict after preview never writes and consumes nonce', async () => {
    const s = scenario(); const p = await s.preview(); writeFileSync(s.file, 'manual')
    await assert.rejects(s.api.restore(s.bind(p)), /CONFLICT/); assert.equal(readFileSync(s.file, 'utf8'), 'manual')
    await assert.rejects(s.api.restore(s.bind(p)), /INVALID_OR_EXPIRED/)
  })
  await test('repeated preview invalidates old nonce; supplied hash cannot be forged', async () => {
    const s = scenario(); const p = await s.preview(); const fresh = await s.preview()
    assert.notEqual(p.nonce, fresh.nonce); await assert.rejects(s.api.restore(s.bind(p)), /INVALID_OR_EXPIRED/)
    await assert.rejects(s.api.restore({ ...s.bind(fresh), expectedCurrentHash: 'a'.repeat(40) }), /INVALID_OR_EXPIRED/)
    assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
  })
  await test('cross session / forged entry / traversal / browser pathname / force fail closed', async () => {
    const s = scenario(), p = await s.preview()
    assert.deepEqual((await s.api.changedFiles({ sessionId: 'other' })).rows, [])
    await assert.rejects(s.api.preview({ sessionId: 'other', entryId: p.entryId }), /ENTRY_NOT_IN_SESSION/)
    await assert.rejects(s.api.preview({ sessionId: s.sessionId, entryId: 'entry-' + 'a'.repeat(64) }), /ENTRY_NOT_IN_SESSION/)
    await assert.rejects(s.api.preview({ sessionId: s.sessionId, entryId: '../../file' }), /INVALID_ENTRY/)
    await assert.rejects(s.api.restore({ ...s.bind(p), path: s.file }), /UNEXPECTED/)
    await assert.rejects(s.api.restore({ ...s.bind(p), force: true }), /UNEXPECTED/)
    assert.throws(() => parseRollbackRequest('changedFiles', { sessionId: '' }), /INVALID_SESSION/)
    assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
  })
  await test('empty new file is created, withdraw creation preserves existence metadata', async () => {
    const s = scenario({ before: null, after: '' }), p = await s.preview()
    assert.equal(p.changeType, 'created'); assert.equal(p.canRestore, true)
    const r = await s.api.restore(s.bind(p)); assert.equal(r.applied, true); assert.equal(existsSync(s.file), false)
    assert.equal(readFileSync(r.backup).length, 0)
  })
  await test('deleted empty original recreated with wx and original existence restored', async () => {
    const s = scenario({ before: '', after: null }), p = await s.preview()
    assert.equal(p.changeType, 'deleted'); assert.equal(p.expectedCurrentHash, 'absent')
    const r = await s.api.restore(s.bind(p)); assert.equal(r.applied, true); assert.equal(readFileSync(s.file).length, 0)
  })
  await test('binary is explicit with no text diff, still safely restores captured bytes', async () => {
    const s = scenario({ before: Buffer.from([0, 1, 2]), after: Buffer.from([0, 3, 4]) }), p = await s.preview()
    assert.equal(p.diff.kind, 'binary'); assert.equal(p.diff.text, '')
    assert.equal((await s.api.restore(s.bind(p))).applied, true); assert.deepEqual(readFileSync(s.file), Buffer.from([0, 1, 2]))
  })
  await test('preimage only and denied/no actual change never pretend complete netdiff or restore', async () => {
    const s = scenario({ post: false }), p = await s.preview()
    assert.equal(p.canRestore, false); assert.equal(p.nonce, null); assert.equal(p.captureStatus, 'preimage-only'); assert.match(p.diffBasis, /不保证/)
    const unchanged = await scenario({ before: 'same', after: 'same' }).preview()
    assert.equal(unchanged.canRestore, false); assert.equal(unchanged.changeType, 'unchanged')
  })
  await test('unfinished turn / newly active turn prevent restore', async () => {
    const s = scenario({ ended: false }); assert.equal((await s.preview()).canRestore, false)
    const t = scenario(), p = await t.preview()
    appendEntry(t.stateDir, { kind: 'turn/start', session: t.sessionId, turn: 2 })
    await assert.rejects(t.api.restore(t.bind(p)), /ACTIVE_SESSION_TURN/)
  })
  await test('oversized capture and growing current file never allocate/restore blindly', async () => {
    const s = scenario({ before: '1234', after: '5678', maxBytes: 2 }); assert.equal((await s.preview()).canRestore, false)
    const t = scenario(), p = await t.preview(); writeFileSync(t.file, Buffer.alloc(UI_MAX_BYTES + 1))
    assert.equal((await t.preview()).current.status, 'oversized'); await assert.rejects(t.api.restore(t.bind(p)), /INVALID_OR_EXPIRED/)
    assert.equal(readFileSync(t.file).length, UI_MAX_BYTES + 1)
  })
  await test('CAS corrupted, removed or traversal hash rejects before writes', async () => {
    const s = scenario(), p = await s.preview(); writeFileSync(objectPath(s.stateDir, s.pre.hash), 'tampered')
    await assert.rejects(s.api.restore(s.bind(p)), /CAS_MISSING_OR_CORRUPT/); assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
    const t = scenario(); unlinkSync(objectPath(t.stateDir, t.pre.hash)); assert.equal((await t.preview()).preImage.available, false)
  })
  await test('later same-session / foreign-session capture prevents old preview restore', async () => {
    for (const foreign of [false, true]) {
      const s = scenario(), p = await s.preview()
      capturePath(s.stateDir, { session: foreign ? 'foreign' : s.sessionId, turn: 2, path: s.file, phase: 'before', maxBytes: UI_MAX_BYTES })
      await assert.rejects(s.api.restore(s.bind(p)), /CONFLICT/)
      assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
    }
  })
  await test('directory and leaf path exchange blocked even when replacement bytes match', async () => {
    const s = scenario(), p = await s.preview(); renameSync(s.file, s.file + '.original'); writeFileSync(s.file, 'new\nline\n')
    await assert.rejects(s.api.restore(s.bind(p)), /CONFLICT/)
    const t = scenario(), q = await t.preview(); unlinkSync(t.file); mkdirSync(t.file)
    await assert.rejects(t.api.restore(t.bind(q)), /CONFLICT/)
  })
  await test('symlink and junction ancestor redirection do not touch victim', async () => {
    const s = scenario(), p = await s.preview(), victim = join(s.dir, 'victim.txt'); writeFileSync(victim, 'victim'); unlinkSync(s.file)
    try { symlinkSync(victim, s.file, 'file') } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) { console.log('SKIP file symlink creation privilege; junction scenario below still required') }
      else throw e
    }
    if (existsSync(s.file)) await assert.rejects(s.api.restore(s.bind(p)), /CONFLICT/)
    assert.equal(readFileSync(victim, 'utf8'), 'victim')
    const t = scenario(); const sub = join(t.dir, 'sub'); mkdirSync(sub)
    const nested = join(sub, 'target'); writeFileSync(nested, 'A')
    const state = createTurnState(); capturePath(t.stateDir, { session: 'ancestor', turn: 3, path: nested, phase: 'before', maxBytes: 99, turnState: state })
    writeFileSync(nested, 'B'); capturePath(t.stateDir, { session: 'ancestor', turn: 3, path: nested, phase: 'after', maxBytes: 99, turnState: state }); appendEntry(t.stateDir, { kind: 'turn/end', session: 'ancestor', turn: 3 })
    const row = (await t.api.changedFiles({ sessionId: 'ancestor' })).rows[0]; const prev = await t.api.preview({ sessionId: 'ancestor', entryId: row.entryId })
    renameSync(sub, sub + '-old'); const redirected = join(t.dir, 'redirect'); mkdirSync(redirected); writeFileSync(join(redirected, 'target'), 'B')
    symlinkSync(redirected, sub, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(t.api.restore({ sessionId: 'ancestor', entryId: prev.entryId, nonce: prev.nonce, expectedCurrentHash: prev.expectedCurrentHash }), /CONFLICT/)
    assert.equal(readFileSync(join(redirected, 'target'), 'utf8'), 'B')
  })
  await test('hardlink appearing after preview blocks both paths; existing file permissions preserved', async () => {
    const s = scenario(), p = await s.preview(), linked = join(s.dir, 'linked.txt')
    linkSync(s.file, linked)
    await assert.rejects(s.api.restore(s.bind(p)), /CONFLICT/)
    assert.equal((await s.preview()).canRestore, false)
    assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n'); assert.equal(readFileSync(linked, 'utf8'), 'new\nline\n')
    await assert.rejects(s.api.restore(s.bind(p)), /INVALID_OR_EXPIRED/)
    const t = scenario(), mode = statSync(t.file).mode
    assert.equal((await t.api.restore(t.bind(await t.preview()))).applied, true)
    assert.equal(statSync(t.file).mode, mode)
  })
  await test('partial write failure repairs original opened inode and reports false', async () => {
    let writes = 0
    const s = scenario({ apiOptions: { io: { writeSync(fd, buf, offset, length, position) { writes++; if (writes === 1) return writeSync(fd, buf, offset, 2, position); throw new Error('EIO fixture') } } } }), p = await s.preview()
    const r = await s.api.restore(s.bind(p)); assert.equal(writes, 2); assert.equal(r.applied, false); assert.match(r.error, /EIO/)
    assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
  })
  await test('withdraw creation unlink failure restores pathname without overwriting replacement', async () => {
    const s = scenario({ before: null, after: 'created', apiOptions: { io: { unlinkSync() { throw new Error('unlink EIO fixture') } } } }), p = await s.preview()
    const r = await s.api.restore(s.bind(p)); assert.equal(r.applied, false); assert.match(r.error, /unlink EIO/)
    assert.equal(readFileSync(s.file, 'utf8'), 'created'); assert.equal(statSync(s.file).nlink, 1); assert.equal(r.quarantine, null)
  })
  await test('intent ledger failure prevents writes; receipt failure reports actual applied audit gap', async () => {
    const s = scenario({ apiOptions: { io: { appendEntry() { throw new Error('intent EIO') } } } }), p = await s.preview()
    await assert.rejects(s.api.restore(s.bind(p)), /intent EIO/); assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
    const t = scenario({ apiOptions: { io: { appendEntry(dir, e) { if (e.phase === 'receipt') throw new Error('receipt EIO'); return appendEntry(dir, e) } } } }), q = await t.preview()
    const r = await t.api.restore(t.bind(q)); assert.equal(r.applied, true); assert.equal(r.recorded, false); assert.match(r.auditError, /receipt EIO/)
    assert.equal(readFileSync(t.file, 'utf8'), 'old\nline\n'); await assert.rejects(t.api.restore(t.bind(q)), /INVALID_OR_EXPIRED/)
  })
  await test('nonce TTL and disposal; list pagination and turn filter', async () => {
    let time = 0; const s = scenario({ apiOptions: { now: () => time } }), p = await s.preview(); time = 120001
    await assert.rejects(s.api.restore(s.bind(p)), /INVALID_OR_EXPIRED/)
    const q = await s.preview(); s.api.dispose(); await assert.rejects(s.api.restore(s.bind(q)), /INVALID_OR_EXPIRED/)
    // 2026-10-06：分页样本改成真正带快照的文件。旧口径往账本塞 30 条零 capture 的
    // shell 目标并断言它们进列表；那正是「已修改文件」被噪音淹没的来源。
    for (let i = 0; i < 30; i++) {
      const file = join(s.dir, 'page-' + i)
      writeFileSync(file, 'old-' + i)
      capturePath(s.stateDir, { session: s.sessionId, turn: 9, path: file, phase: 'before', maxBytes: UI_MAX_BYTES, tool: 'write' })
      writeFileSync(file, 'new-' + i)
      capturePath(s.stateDir, { session: s.sessionId, turn: 9, path: file, phase: 'after', maxBytes: UI_MAX_BYTES })
    }
    appendEntry(s.stateDir, { kind: 'turn/end', session: s.sessionId, turn: 9 })
    const first = await s.api.changedFiles({ sessionId: s.sessionId, limit: 25 }); assert.equal(first.rows.length, 25); assert.equal(first.total, 31); assert.equal(first.nextCursor, 25)
    const second = await s.api.changedFiles({ sessionId: s.sessionId, cursor: 25, limit: 25 }); assert.equal(second.rows.length, 6); assert.equal(second.nextCursor, null)
    assert.equal((await s.api.changedFiles({ sessionId: s.sessionId, turn: 1 })).total, 1)
    await assert.rejects(s.api.changedFiles({ sessionId: s.sessionId, cursor: -1 }), /INVALID_PAGE/)
    assert.equal(compactDiff(Buffer.from('a\n'.repeat(300)), Buffer.from('b\n'.repeat(300))).truncated, true)
  })
  await test('preview ticket map is bounded to 256; oldest ticket evicted without writing', async () => {
    const s = scenario(), firstPreview = await s.preview()
    for (let i = 0; i < 256; i++) {
      const file = join(s.dir, 'bounded-' + i)
      writeFileSync(file, 'before')
      capturePath(s.stateDir, { session: s.sessionId, turn: 3, path: file, phase: 'before', maxBytes: 99 })
      writeFileSync(file, 'after')
      capturePath(s.stateDir, { session: s.sessionId, turn: 3, path: file, phase: 'after', maxBytes: 99 })
    }
    appendEntry(s.stateDir, { kind: 'turn/end', session: s.sessionId, turn: 3 })
    const rows = []
    for (let cursor = 0; cursor < 257; cursor += 100) rows.push(...(await s.api.changedFiles({ sessionId: s.sessionId, cursor, limit: 100 })).rows)
    for (const row of rows.slice(1)) assert.equal((await s.api.preview({ sessionId: s.sessionId, entryId: row.entryId })).canRestore, true)
    await assert.rejects(s.api.restore(s.bind(firstPreview)), /INVALID_OR_EXPIRED/)
    assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
  })
  await test('read-only tool targets never become "changed files"; only snapshots are listed', async () => {
    const s = scenario()
    // read/grep/glob 都会带 path 参数。旧口径把它们并进文件组，这些组永远没有
    // capture，只能显示成 not-captured——「已修改文件」因此被只读路径淹没。
    for (const tool of ['read', 'grep', 'glob']) {
      for (let i = 0; i < 5; i++) appendEntry(s.stateDir, { kind: 'call', session: s.sessionId, turn: 7, tool, callId: tool + i, targets: [join(s.dir, tool + '-' + i + '.txt')] })
    }
    appendEntry(s.stateDir, { kind: 'turn/start', session: s.sessionId, turn: 7, cwd: s.dir })
    appendEntry(s.stateDir, { kind: 'turn/end', session: s.sessionId, turn: 7, captured: 0 })
    const listed = await s.api.changedFiles({ sessionId: s.sessionId })
    assert.deepEqual(listed.rows.map((r) => r.path), [s.file], '只列真正有快照的文件')
    assert.equal(listed.total, 1)
    assert.notEqual(listed.rows[0].captureStatus, 'not-captured', '列表内不应再出现 not-captured')
    assert.equal(listed.rows[0].canRestore, true, '混合只读调用不得污染本文件的可恢复判定')
    // 覆盖文案必须说明只读文件不计入，否则 UI 仍会误导。
    assert.match(listed.coverage, /只列有前后像快照/)
    // captureTools 是活的配置，不是硬编码名单：把 read 也算作写工具后，
    // 「本轮声明要改这个路径却没有快照」必须重新触发拒绝。
    appendEntry(s.stateDir, { kind: 'call', session: s.sessionId, turn: 7, tool: 'read', callId: 'r1', targets: [s.file] })
    const counted = createRollbackApi(s.stateDir, { assertSession: async () => {}, captureTools: ['read'] })
    const countedRow = (await counted.changedFiles({ sessionId: s.sessionId })).rows[0]
    assert.equal(countedRow.canRestore, false, 'captureTools 含 read 时该轮应计入改动意图')
    assert.equal(countedRow.reason, 'UNCAPTURED_TOOL_TARGET')

    const liveTools = ['write']
    const liveApi = createRollbackApi(s.stateDir, { assertSession: async () => {}, captureTools: () => liveTools })
    assert.equal((await liveApi.changedFiles({ sessionId: s.sessionId })).rows[0].canRestore, true)
    liveTools.push('read')
    const liveRow = (await liveApi.changedFiles({ sessionId: s.sessionId })).rows[0]
    assert.equal(liveRow.canRestore, false, '长驻 remote API 必须读取最新的 volatile captureTools')
    assert.equal(liveRow.reason, 'UNCAPTURED_TOOL_TARGET')
  })
  await test('missing session verifier fails closed on every method (HIGH-3 default)', async () => {
    const s = scenario(), p = await s.preview()
    const unverified = createRollbackApi(s.stateDir)
    await assert.rejects(unverified.changedFiles({ sessionId: s.sessionId }), /SESSION_VERIFIER_UNAVAILABLE/)
    await assert.rejects(unverified.preview({ sessionId: s.sessionId, entryId: p.entryId }), /SESSION_VERIFIER_UNAVAILABLE/)
    await assert.rejects(unverified.restore(s.bind(p)), /SESSION_VERIFIER_UNAVAILABLE/)
    assert.equal(readFileSync(s.file, 'utf8'), 'new\nline\n')
  })
  await test('active turn denies mutation before consuming ticket; read paths stay open (HIGH-3)', async () => {
    let active = true
    const seen = []
    const s = scenario({
      apiOptions: {
        assertSession: async (sessionId, mutation) => {
          seen.push([sessionId, mutation])
          if (mutation && active) throw new Error('SESSION_TURN_ACTIVE: fixture')
        },
      },
    })
    const p = await s.preview() // mutation=false：进行中轮次仍允许浏览/预览
    assert.equal(p.canRestore, true)
    await assert.rejects(s.api.restore(s.bind(p)), /SESSION_TURN_ACTIVE/)
    active = false
    const r = await s.api.restore(s.bind(p)) // 票据未被上一次拒绝消费
    assert.equal(r.applied, true)
    assert.deepEqual([...new Set(seen.map(([, m]) => m))].sort(), [false, true])
    assert.ok(seen.every(([id]) => id === s.sessionId))
  })
  console.log(`rollback-preview: ${count} scenarios passed; temporary fixtures only`)
} finally { rmSync(root, { recursive: true, force: true }) }
