// 独立审查实证缺陷的最小反例回归：HIGH-1 full-only 聚合绕过、HIGH-2 state sink 写侧、
// HIGH-4 Windows 大小写别名、MEDIUM-5 after 必须是 turn/end 权威状态。
// 只用系统 Temp fixture，finally 清理；不触真实 profile/GUI/模型。
import './bootstrap.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync, linkSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { initState, appendEntry, capturePath, createTurnState, readAllEntries, ledgerFile, sha1Hex, existingPathGuards } from '../lib/ledger.js'
import { createRollbackApi } from '../lib/rollback-preview.js'
// lib/index.js 经 config.js 依赖 schemastery：必须等 bootstrap 的解析钩子评估后再动态导入。
const { apply } = await import('../lib/index.js')

const root = mkdtempSync(join(tmpdir(), 'dsh-security-regressions-'))
assert.ok(isAbsolute(root) && root.includes('dsh-security-regressions-'))
let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name) }
const permissive = { assertSession: async () => {} }

try {
  // HIGH-1（复验半成品修复）：turn1 pre='A' / post=OVERSIZED（maxBytes=2，hash 记 null）、
  // turn2 pre=OVERSIZED / post='C'，各轮 end 齐全。旧版把连续性校验只施于展示端点，
  // canRestore=true 且 C→A 恢复成功；新版对 EVERY captured image 做全量校验，必须拒绝。
  await test('HIGH-1 full-only aggregation bypass: oversized intermediate image denies restore', async () => {
    const dir = join(root, 'high1'); mkdirSync(dir)
    const stateDir = join(dir, 'state'); initState(stateDir)
    const file = join(dir, 'file.txt'); const sessionId = 'high1-session'; const maxBytes = 2
    const turnState = createTurnState()
    appendEntry(stateDir, { kind: 'turn/start', session: sessionId, turn: 1, cwd: dir })
    writeFileSync(file, 'A')
    capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'before', maxBytes, turnState })
    writeFileSync(file, 'XYZ') // 3 字节 > 2：超限，hash 记 null，不落对象
    capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'after', maxBytes, turnState })
    appendEntry(stateDir, { kind: 'turn/end', session: sessionId, turn: 1 })
    appendEntry(stateDir, { kind: 'turn/start', session: sessionId, turn: 2, cwd: dir })
    capturePath(stateDir, { session: sessionId, turn: 2, path: file, phase: 'before', maxBytes, turnState })
    writeFileSync(file, 'C')
    capturePath(stateDir, { session: sessionId, turn: 2, path: file, phase: 'after', maxBytes, turnState })
    appendEntry(stateDir, { kind: 'turn/end', session: sessionId, turn: 2 })

    const api = createRollbackApi(stateDir, permissive)
    const rows = (await api.changedFiles({ sessionId })).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].canRestore, false, '中间后像超限（hash null）的完整链路必须拒绝恢复')
    assert.equal(rows[0].captureComplete, false)
    const preview = await api.preview({ sessionId, entryId: rows[0].entryId })
    assert.equal(preview.canRestore, false)
    assert.equal(preview.nonce, null, '拒绝恢复时不得签发确认票据')
    assert.equal(readFileSync(file, 'utf8'), 'C', '不得发生 C→A 的静默回滚')
  })

  // HIGH-2①（复验）：合法 fixture 后 rename 当日账本→victim-ledger、linkSync(victim, 账本路径)
  // （nlink=2）。restore 必须先写 intent 入账；safeStateWrite 拒绝 nlink!==1 的旁路文件，
  // restore 整体失败、目标文件不动、victim-ledger 不增长。旧版 appendFileSync 会双写。
  await test('HIGH-2a ledger hardlink bypass: restore intent write refuses nlink>1 sink', async () => {
    const dir = join(root, 'high2a'); mkdirSync(dir)
    const stateDir = join(dir, 'state'); initState(stateDir)
    const file = join(dir, 'file.txt'); const sessionId = 'high2a-session'
    const turnState = createTurnState()
    appendEntry(stateDir, { kind: 'turn/start', session: sessionId, turn: 1, cwd: dir })
    writeFileSync(file, 'before')
    capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'before', maxBytes: 99, turnState })
    writeFileSync(file, 'after')
    capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'after', maxBytes: 99, turnState })
    appendEntry(stateDir, { kind: 'turn/end', session: sessionId, turn: 1 })
    const api = createRollbackApi(stateDir, permissive)
    const rows = (await api.changedFiles({ sessionId })).rows
    const preview = await api.preview({ sessionId, entryId: rows[0].entryId })
    assert.equal(preview.canRestore, true)

    const ledger = ledgerFile(stateDir)
    const victim = join(dir, 'victim-ledger')
    renameSync(ledger, victim)
    linkSync(victim, ledger) // 同一 inode 两个名字：nlink=2
    const victimBytesBefore = readFileSync(victim).length

    await assert.rejects(
      api.restore({ sessionId, entryId: preview.entryId, nonce: preview.nonce, expectedCurrentHash: preview.expectedCurrentHash }),
      /UNSAFE_STATE_FILE/,
      'intent 入账必须拒绝 nlink>1 的账本旁路文件',
    )
    assert.equal(readFileSync(victim).length, victimBytesBefore, 'victim-ledger 不得再被 append')
    assert.equal(readFileSync(file, 'utf8'), 'after', 'restore 失败不得触碰目标文件')
    assert.ok(!readAllEntries(stateDir).some((e) => e.phase === 'intent' || e.phase === 'receipt'), '不得留下半拉子 rollback 账目')
  })

  // HIGH-2②（复验）：state/objects 换成 junction 指向 outside，capturePath 不得在
  // outside 写对象。junction 不需特权（symlink 在本机 EPERM 只能 SKIP，见 README 边界）。
  await test('HIGH-2b objects junction redirection: capturePath never writes outside stateDir', async () => {
    const dir = join(root, 'high2b'); mkdirSync(dir)
    const stateDir = join(dir, 'state'); initState(stateDir)
    const outside = join(dir, 'outside'); mkdirSync(outside)
    rmSync(join(stateDir, 'objects'), { recursive: true })
    symlinkSync(outside, join(stateDir, 'objects'), process.platform === 'win32' ? 'junction' : 'dir')
    const file = join(dir, 'file.txt'); writeFileSync(file, 'payload')
    assert.throws(
      () => capturePath(stateDir, { session: 'high2b-session', turn: 1, path: file, phase: 'before', maxBytes: 99, turnState: createTurnState() }),
      (error) => /UNSAFE|REDIRECTION/.test(error && error.message ? error.message : String(error)),
      'objects 被 junction 重定向时捕获必须失败',
    )
    assert.deepEqual(readdirSync(outside), [], 'outside 不得出现任何 CAS 对象')
  })

  // HIGH-4：Windows 大小写别名。owner 用 target.txt 捕获 A→B 并 end；foreign 用
  // TARGET.TXT 捕获 B→B 并 end（同一物理文件）。旧版按严格字符串比较路径，
  // owner preview canRestore=true；新版 canonicalPathKey 聚合后必须视为
  // NEWER_OR_OTHER_SESSION_CAPTURE 而拒绝。仅在 win32 断言（其它平台两路径是不同文件）。
  await test('HIGH-4 case-alias foreign capture denies owner restore (win32)', async () => {
    if (process.platform !== 'win32') { console.log('SKIP case-alias semantics are win32-specific'); return }
    const dir = join(root, 'high4'); mkdirSync(dir)
    const stateDir = join(dir, 'state'); initState(stateDir)
    const lower = join(dir, 'target.txt')
    const upper = join(dir, 'TARGET.TXT')
    const ownerState = createTurnState()
    appendEntry(stateDir, { kind: 'turn/start', session: 'owner', turn: 1, cwd: dir })
    writeFileSync(lower, 'A')
    capturePath(stateDir, { session: 'owner', turn: 1, path: lower, phase: 'before', maxBytes: 99, turnState: ownerState })
    writeFileSync(lower, 'B')
    capturePath(stateDir, { session: 'owner', turn: 1, path: lower, phase: 'after', maxBytes: 99, turnState: ownerState })
    appendEntry(stateDir, { kind: 'turn/end', session: 'owner', turn: 1 })
    const foreignState = createTurnState()
    appendEntry(stateDir, { kind: 'turn/start', session: 'foreign', turn: 1, cwd: dir })
    capturePath(stateDir, { session: 'foreign', turn: 1, path: upper, phase: 'before', maxBytes: 99, turnState: foreignState })
    writeFileSync(upper, 'B') // 同一物理文件，内容不变
    capturePath(stateDir, { session: 'foreign', turn: 1, path: upper, phase: 'after', maxBytes: 99, turnState: foreignState })
    appendEntry(stateDir, { kind: 'turn/end', session: 'foreign', turn: 1 })

    const api = createRollbackApi(stateDir, permissive)
    const rows = (await api.changedFiles({ sessionId: 'owner' })).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].path, lower, '展示路径保留 owner 原文')
    assert.equal(rows[0].canRestore, false, '大小写别名的外来捕获必须并入判定并拒绝')
    assert.match(rows[0].reason, /NEWER_OR_OTHER_SESSION_CAPTURE/)
    const preview = await api.preview({ sessionId: 'owner', entryId: rows[0].entryId })
    assert.equal(preview.nonce, null)
    assert.equal(readFileSync(lower, 'utf8'), 'B')
  })

  // MEDIUM-5：权威 after 只在 turn/end 采集。事件流：turn/start → 工具写 A→B →
  // turn-stopping（不再写 after）→ 外部写 C → turn/end。旧版在 stopping 即置
  // afterDone，账本 post='B' 而真实结束态='C'；新版账本 after 必须='C'。
  await test('MEDIUM-5 authoritative after is captured at turn/end, never at turn-stopping', async () => {
    const dir = join(root, 'medium5'); mkdirSync(dir)
    const stateDir = join(dir, 'state')
    const file = join(dir, 'file.txt'); writeFileSync(file, 'A')
    const handlers = new Map()
    const warnings = []
    const fakeCtx = {
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
      on: (eventName, handler) => { handlers.set(eventName, handler); return () => handlers.delete(eventName) },
      get: () => undefined,
      effect: () => {},
    }
    apply(fakeCtx, { stateDir, captureTools: ['write'], excludeGlobs: [] })
    const session = { id: 'medium5-session', header: { cwd: dir } }
    handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 1 } })
    await handlers.get('tools/pre-execute')(
      { name: 'write', arguments: { path: file, content: 'B' }, callId: 'call-1', agent: { session } },
      async () => { writeFileSync(file, 'B'); return { isError: false } },
    )
    // 旧版此时已 captureAfterOnce 并置 afterDone；新版没有 turn-stopping 监听，
    // handlers.get('agent/turn-stopping') 必须为 undefined。
    assert.equal(handlers.get('agent/turn-stopping'), undefined, '不得再注册 agent/turn-stopping')
    writeFileSync(file, 'C') // stopping 之后、turn/end 之前的外部落盘
    handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 1 } })

    const entries = readAllEntries(stateDir)
    const afters = entries.filter((e) => e.kind === 'capture' && e.phase === 'after')
    assert.equal(afters.length, 1, '整轮只应有一条权威 after')
    assert.equal(afters[0].hash, sha1Hex(Buffer.from('C')), 'after 必须是 turn/end 时的真实结束态 C，不是中间态 B')
    assert.equal(afters[0].bytes, 1)
    assert.equal(warnings.filter((m) => /capture\/after 失败/.test(m)).length, 0)
  })

  // HIGH-3 接线级：Host 完全无 session 服务时，exposeAuditRemote 暴露的
  // changedFiles/preview/restore 全部 fail-closed（SESSION_VERIFIER_UNAVAILABLE），
  // 不得像旧版一样无校验放行 restore session='nonexistent-session'。
  await test('HIGH-3 wired verifier fails closed when Host session services are absent', async () => {
    const dir = join(root, 'high3'); mkdirSync(dir)
    const stateDir = join(dir, 'state')
    let service = null
    const fakeCtx = {
      logger: { info: () => {}, warn: () => {} },
      on: () => () => {},
      get: () => undefined, // 无任何 Host 服务
      effect: () => {},
      reflect: { provide: (key, value) => { if (key === 'auditRollback') service = value } },
    }
    apply(fakeCtx, { stateDir })
    assert.ok(service, 'auditRollback 服务必须仍然暴露（只读状态可用）')
    await assert.rejects(service.changedFiles({ sessionId: 'nonexistent-session' }), /SESSION_VERIFIER_UNAVAILABLE/)
    await assert.rejects(
      service.preview({ sessionId: 'nonexistent-session', entryId: 'entry-' + 'a'.repeat(64) }),
      /SESSION_VERIFIER_UNAVAILABLE/,
    )
    await assert.rejects(
      service.restore({ sessionId: 'nonexistent-session', entryId: 'entry-' + 'a'.repeat(64), nonce: '01234567-0123-4123-8123-012345678901', expectedCurrentHash: 'absent' }),
      /SESSION_VERIFIER_UNAVAILABLE/,
    )
  })

  // 2026-10-05 新缺陷：祖先目录尚不存在时，probeFile 把 ENOENT 冒泡成读失败，
  // 导致「在新建目录里首次创建文件」完全不落 capture，该文件此后不可回滚。
  // 修复：pathGuards 遇祖先 ENOENT 终止遍历并返回已验证段，probeFile 据此记 existed:false。
  await test('MEDIUM-6 ancestor ENOENT: capture in a not-yet-created directory is recorded', async () => {
    const dir = join(root, 'medium6'); mkdirSync(dir)
    const stateDir = join(dir, 'state'); initState(stateDir)
    const sessionId = 'medium6-session'
    const fresh = join(dir, 'not-created-yet', 'deep', 'new.txt')
    const turnState = createTurnState()
    appendEntry(stateDir, { kind: 'turn/start', session: sessionId, turn: 1, cwd: dir })

    // 父目录不存在：必须记 existed:false 的 capture，而不是抛错。
    const before = capturePath(stateDir, {
      session: sessionId, turn: 1, path: fresh, phase: 'before',
      tool: 'write', callId: 'c1', maxBytes: 65536, turnState,
    })
    assert.ok(before, 'before capture 必须落账')
    assert.equal(before.existed, false, '尚不存在的文件记 existed:false')
    assert.ok(turnState.capturedPaths.has(fresh), '纳入本轮捕获集合，turn/end 会补 after')

    // 建好目录与文件后，after 必须正常捕获到内容。
    mkdirSync(join(dir, 'not-created-yet', 'deep'), { recursive: true })
    writeFileSync(fresh, 'hello')
    const after = capturePath(stateDir, {
      session: sessionId, turn: 1, path: fresh, phase: 'after',
      maxBytes: 65536, turnState,
    })
    assert.ok(after && after.existed === true, '目录建好后 after 正常捕获')
    assert.equal(after.bytes, 5)

    // 祖先是普通文件（ENOTDIR）仍必须 fail-closed，绝不放行。
    const blocker = join(dir, 'blocker'); writeFileSync(blocker, 'x')
    assert.throws(() => capturePath(stateDir, {
      session: sessionId, turn: 2, path: join(blocker, 'child.txt'), phase: 'before',
      tool: 'write', callId: 'c2', maxBytes: 65536, turnState: createTurnState(),
    }), /capture\/before 读取失败/, 'ENOTDIR 仍是读失败，不得当不存在')

    // 状态目录侧的严格路径不受影响：祖先缺失必须抛 ANCESTOR_MISSING。
    assert.throws(() => existingPathGuards(join(stateDir, 'no-such-dir', 'x.json')), /ANCESTOR_MISSING/)
  })

  // 2026-10-05 复核实证（N9）：HIGH-5 跳过基线比对后暴露的新错误 ——
  // g.first 是首个 before、g.last 是末个 after，跨轮时二者不同轮。
  // turn1 在不存在的目录下建文件、turn2 编辑它 → before.existed=false 却拿
  // turn2 的 after 相比，changeType 报 created、action 说「撤回创建」，
  // restore 真把含最新内容的文件删掉。必须拒绝并报 CREATED_IN_EARLIER_TURN。
  await test('MEDIUM-7 cross-turn create must not offer to undo the creation', async () => {
    const dir = join(root, 'medium7'); mkdirSync(dir)
    const stateDir = join(dir, 'state'); initState(stateDir)
    const sessionId = 'medium7-session'
    const file = join(dir, 'later', 'deep', 'a.txt')

    // turn 1：目录尚不存在 → before(existed=false, guards=[])
    appendEntry(stateDir, { kind: 'turn/start', session: sessionId, turn: 1, cwd: dir })
    const ts1 = createTurnState()
    appendEntry(stateDir, { kind: 'call', session: sessionId, turn: 1, tool: 'write', callId: 'c1', targets: [file] })
    capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'before', tool: 'write', callId: 'c1', maxBytes: 65536, turnState: ts1 })
    mkdirSync(join(dir, 'later', 'deep'), { recursive: true })
    writeFileSync(file, 'v1')
    capturePath(stateDir, { session: sessionId, turn: 1, path: file, phase: 'after', maxBytes: 65536, turnState: ts1 })
    appendEntry(stateDir, { kind: 'turn/end', session: sessionId, turn: 1, captured: 1 })

    // turn 2：编辑同一文件
    appendEntry(stateDir, { kind: 'turn/start', session: sessionId, turn: 2, cwd: dir })
    const ts2 = createTurnState()
    appendEntry(stateDir, { kind: 'call', session: sessionId, turn: 2, tool: 'edit', callId: 'c2', targets: [file] })
    capturePath(stateDir, { session: sessionId, turn: 2, path: file, phase: 'before', tool: 'edit', callId: 'c2', maxBytes: 65536, turnState: ts2 })
    writeFileSync(file, 'v2-edited-important')
    capturePath(stateDir, { session: sessionId, turn: 2, path: file, phase: 'after', maxBytes: 65536, turnState: ts2 })
    appendEntry(stateDir, { kind: 'turn/end', session: sessionId, turn: 2, captured: 1 })

    const api = createRollbackApi(stateDir, permissive)
    const { rows } = await api.changedFiles({ sessionId })
    const row = rows.find(r => r.path === file)
    assert.ok(row, '该文件必须出现在列表里')
    assert.equal(row.canRestore, false, `跨轮创建不得可回滚（实际 reason=${row.reason}）`)
    assert.equal(row.reason, 'CREATED_IN_EARLIER_TURN', `应报 CREATED_IN_EARLIER_TURN（实际 ${row.reason}）`)
    assert.equal(row.changeType, 'modified', 'changeType 应为 modified 而非 created')
    // preview 不得签发票据：canRestore=false 的条目只返回只读视图，nonce 必须为 null
    // （restore 凭 nonce 生效，没有票据就动不了文件）。
    const previewView = await api.preview({ sessionId, entryId: row.entryId })
    assert.equal(previewView.nonce, null, '不可回滚的条目不得签发预览票据（nonce 必须为 null）')
    assert.equal(previewView.canRestore, false)
    assert.equal(previewView.action, '恢复首个捕获前像（保留当前文件备份）',
      '跨轮创建不得显示「撤回创建」')
    assert.equal(readFileSync(file, 'utf8'), 'v2-edited-important', '文件内容未被触碰')
  })

  console.log(`security-regressions: ${count} scenarios passed; temporary fixtures only`)
} finally { rmSync(root, { recursive: true, force: true }) }
