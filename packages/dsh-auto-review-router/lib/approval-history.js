import { createHash, randomUUID } from 'node:crypto'
import * as fileSystem from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

// This store is independent of Session.append: alpha.1 cannot mark downstream
// plugin events ignorable through its public append API. Never edit session files.
const PHASES = {
  reviewer: ['allow', 'deny', 'failure', 'cancel'],
  downstream: ['allow', 'deny', 'ask', 'cancel', 'failure'],
  manual: ['requested', 'allowed-once', 'rejected', 'cancelled', 'unavailable'],
  'reported-result': ['reported-ok', 'reported-error', 'unknown'],
}
const OPTIONAL_TEXT = { parentDispatchId: 80, parentCallId: 200, subCallId: 200,
  approvalRequestId: 80, cause: 80, errorName: 80, errorCode: 80, route: 160, reasonSummary: 240 }
const OPTIONAL_NUMBERS = ['callEventSeq', 'durationMs', 'deadlineAt', 'sourceSeq']
const MAX_FILE_BYTES = 16 * 1024 * 1024
const writersByDir = new Map()
const CODE_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const int = value => Number.isSafeInteger(value) && value >= 0
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const warn = (ctx, code) => { try { ctx.logger?.warn?.(`auto-review-router: approval history gap (${code})`) } catch {} }

/** Persist only a short display summary, never arguments, prompts, content or error text. */
export function reasonSummary(value) {
  if (typeof value !== 'string') return ''
  // Drop the whole detail rather than trying to partially parse quoted JSON,
  // headers, CLI flags or environment assignments with space-containing values.
  // This is best-effort minimization, not a claim of general secret detection.
  if (/\b(?:bearer|authorization|credentials?|api[-_]?key|access[-_]?key|token|password|passwd|secret|private[-_ ]?key)\b/i.test(value)) return '[redacted sensitive detail]'
  return value
    .replace(/\b(?:Bearer\s+|(?:api[-_]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '[redacted]')
    .replace(/(?:https?:\/\/)[^\s]+/gi, '[url]')
    .replace(/(?:[a-z]:[\\/]|\/)[^\s,;]+/gi, '[path]')
    .replace(/[A-Za-z0-9_+\/=.-]{24,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240)
}

export function parseHistoryRequest(value) {
  if (!plain(value) || Object.keys(value).some(key => !['sessionId', 'cursor', 'limit'].includes(key))
    || !text(value.sessionId, 200) || !value.sessionId.trim()
    || value.cursor !== undefined && (!text(value.cursor, 1024) || !/^[A-Za-z0-9_-]+$/.test(value.cursor))
    || value.limit !== undefined && (!int(value.limit) || value.limit < 1 || value.limit > 100)) {
    throw new TypeError('Invalid approval history request')
  }
  return { sessionId: value.sessionId, ...(value.cursor === undefined ? {} : { cursor: value.cursor }), limit: value.limit ?? 50 }
}

export function parseHistoryRecord(value) {
  const required = ['schemaVersion', 'eventId', 'time', 'ledgerSeq', 'dispatchId', 'sessionId', 'turn', 'step', 'callId', 'rootCallId', 'toolName', 'phase', 'outcome']
  if (!plain(value) || Object.keys(value).some(key => ![...required, ...Object.keys(OPTIONAL_TEXT), ...OPTIONAL_NUMBERS, 'risk'].includes(key))
    || required.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1
    || !UUID.test(value.eventId) || !UUID.test(value.dispatchId) || !int(value.time) || !int(value.ledgerSeq)
    || !text(value.sessionId, 200) || !value.sessionId.trim() || !text(value.callId, 200) || !text(value.rootCallId, 200)
    || !text(value.toolName, 160) || !PHASES[value.phase]?.includes(value.outcome)
    || value.turn !== null && !int(value.turn) || value.step !== null && !int(value.step)
    || Object.entries(OPTIONAL_TEXT).some(([key, max]) => value[key] !== undefined && !text(value[key], max))
    || ['errorName', 'errorCode'].some(key => value[key] !== undefined && !CODE_TOKEN.test(value[key]))
    || OPTIONAL_NUMBERS.some(key => value[key] !== undefined && !int(value[key]))
    || value.risk !== undefined && !['low', 'medium', 'high'].includes(value.risk)) {
    throw new TypeError('Invalid approval history record')
  }
  return value
}

export function parseHistoryResult(value) {
  if (!plain(value) || typeof value.ok !== 'boolean') throw new TypeError('Invalid approval history result')
  if (!value.ok) {
    // 传输层把失败包装成 RemoteError 实例：自有可枚举属性是
    // code/details/isDSHRemoteError/name，而 message 来自 Error 构造器、
    // 不可枚举。用 Object.keys 对 error 做严格键集比对会把它判成非法
    // （2026-10-05 实机 Console 实证）。这里改为按属性取值校验；外层 value
    // 的键集仍严格 —— 那是线上原样过来的 JSON，多余键必须拒绝。
    const error = value.error
    if (Object.keys(value).some(key => !['ok', 'error'].includes(key))
      || error === null || typeof error !== 'object'
      || !['invalid-request', 'session-not-found', 'session-unavailable', 'history-unavailable'].includes(error.code)
      || !text(error.message, 200)) throw new TypeError('Invalid approval history error')
    return value
  }
  const page = value.value, health = page?.health
  if (Object.keys(value).some(key => !['ok', 'value'].includes(key)) || !plain(page)
    || Object.keys(page).some(key => !['records', 'nextCursor', 'health'].includes(key))
    || !Array.isArray(page.records) || page.records.length > 100
    || page.nextCursor !== null && !text(page.nextCursor, 1024) || !plain(health)
    || Object.keys(health).some(key => !['ready', 'gap', 'writeFailures', 'readFailures', 'droppedRecords', 'corruptRecords', 'missingProfile', 'closing', 'lastErrorCode'].includes(key))
    || ['ready', 'gap', 'missingProfile', 'closing'].some(key => typeof health[key] !== 'boolean')
    || ['writeFailures', 'readFailures', 'droppedRecords', 'corruptRecords'].some(key => !int(health[key]))
    || health.lastErrorCode !== null && !text(health.lastErrorCode, 80)) throw new TypeError('Invalid approval history page')
  for (const record of page.records) parseHistoryRecord(record)
  return value
}

const failure = code => ({ ok: false, error: { code, message: {
  'invalid-request': '审批历史查询参数无效。', 'session-not-found': '会话不存在。',
  'session-unavailable': '无法验证会话存在性。', 'history-unavailable': '审批历史暂不可用。',
}[code] } })

/**
 * Single bounded, drained writer. Observer failures never enter the approval channel.
 *
 * Stall contract (memory fs / hung disk):
 * - enqueue() is synchronous and bounded: the gate never awaits persistence.
 * - One watchdog per write work item: an fs operation that never settles can never be
 *   cancelled, so on timeout the SHARED writer is quarantined — never replaced. A second
 *   writer could overtake a late uncancellable fs.write and reorder the ledger.
 * - A quarantined writer stays in writersByDir even at refs 0, so no later store on the
 *   same dir can spawn a replacement writer racing the stalled I/O.
 * - Late I/O completions check the writer epoch and must not touch metadata or write
 *   further. If a stalled fs.write had already been committed to the kernel, that row may
 *   exist on disk; the plugin cannot promise to revoke it — subsequent records are dropped
 *   and the gap is reported, so the on-disk order stays truthful (no holes, no reorder).
 * - drain()/close()/history() are all time-bounded; a permanently pending queue can never
 *   block a shutdown or a query.
 */
export function createApprovalHistory(ctx, { fs = fileSystem, queueLimit = 512, maxFileBytes = MAX_FILE_BYTES, cacheLimit = 32,
  stallTimeoutMs = 5000, drainTimeoutMs = 15000, queryTimeoutMs = 15000 } = {}) {
  let profile
  try { profile = ctx.get?.('profileContext') ?? ctx.profileContext } catch {}
  const dir = typeof profile?.dir === 'string' && isAbsolute(profile.dir)
    ? join(profile.dir, 'dsh-auto-review-router', 'approval-history') : null
  const health = { ready: dir !== null, gap: dir === null, writeFailures: 0, readFailures: 0,
    droppedRecords: 0, corruptRecords: 0, missingProfile: dir === null, closing: false,
    lastErrorCode: dir === null ? 'PROFILE_CONTEXT_UNAVAILABLE' : null }
  const executions = new Map(), approvalIds = new Map(), manualLatches = new Map(), claimedCalls = new WeakMap()
  // Per-profile process-local arbitration also covers overlapping consumer fibers.
  const freshWriter = () => ({ tail: Promise.resolve(), queued: 0, refs: 0, epoch: 0, quarantined: false })
  const writer = dir ? writersByDir.get(dir) ?? freshWriter() : freshWriter()
  if (dir) writersByDir.set(dir, writer)
  writer.refs++
  const files = new Map() // Metadata only: bounded LRU, never retained history rows.
  let accepting = true, closed = false
  if (!dir) warn(ctx, health.lastErrorCode)
  const gap = (code, counter) => {
    health.gap = true
    health.lastErrorCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(code ?? '') ? code : 'AUDIT_IO_FAILED'
    if (counter) health[counter]++
    warn(ctx, health.lastErrorCode)
  }
  // Quarantine is terminal for this writer: bump the epoch so every in-flight and
  // late-settling I/O continuation turns stale, then record the gap once.
  const quarantine = (code, counter) => {
    if (writer.quarantined) return
    writer.quarantined = true
    writer.epoch++
    gap(code, counter)
  }
  // Bounded wait on an uncancellable promise: resolves true when it settles in time,
  // false on timeout (onTimeout runs first). Never spawns replacement work. The timer is
  // deliberately ref'd: it is the only guarantee that a drained event loop cannot strand
  // a caller forever; it always clears itself within ms.
  const timed = (promise, ms, onTimeout) => new Promise(resolve => {
    const timer = setTimeout(() => { onTimeout(); resolve(false) }, ms)
    Promise.resolve(promise).then(
      () => { clearTimeout(timer); resolve(true) },
      () => { clearTimeout(timer); resolve(true) })
  })
  const pathFor = sessionId => join(dir, `${createHash('sha256').update(sessionId).digest('hex')}.jsonl`)
  // alive() guards gap accounting from late completions that outlived their caller.
  async function load(sessionId, alive = () => true) {
    let bytes, stat
    try {
      const path = pathFor(sessionId)
      stat = await fs.stat(path)
      if (stat.size > maxFileBytes) throw Object.assign(new Error('ledger limit'), { code: 'AUDIT_FILE_LIMIT' })
      bytes = await fs.readFile(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], nextSeq: 0, writable: true, size: 0, mtimeMs: null, ino: null }
      // ENOTDIR（Linux 对「路径中间段是文件」的错误码；Windows 同样场景报 ENOENT）归类为
      // 「账本目录被非目录占位」：不是全新健康账本，也不是读取失败。blocked 标记让读侧
      // 降级为空页 + 真实 gap，写侧保持可见失败；不得伪装成 healthy 空账本。
      if (error.code === 'ENOTDIR') return { records: [], nextSeq: 0, writable: false, blocked: true, size: 0, mtimeMs: null, ino: null }
      throw error
    }
    const records = [], seenIds = new Set()
    let nextSeq = 0, writable = true
    for (const line of bytes.split('\n')) {
      if (!line) continue
      try {
        const row = parseHistoryRecord(JSON.parse(line))
        if (row.sessionId !== sessionId || row.ledgerSeq !== nextSeq || seenIds.has(row.eventId)) throw new TypeError('ledger identity')
        records.push(row); seenIds.add(row.eventId); nextSeq++
      } catch { if (alive()) { writable = false; gap('AUDIT_CORRUPT_RECORD', 'corruptRecords') } }
    }
    // An uncommitted/torn tail is never extended into a seemingly valid record.
    if (bytes && !bytes.endsWith('\n') && alive()) { writable = false; gap('AUDIT_TORN_TAIL', 'corruptRecords') }
    return { records, nextSeq, writable, size: Buffer.byteLength(bytes), mtimeMs: stat.mtimeMs, ino: stat.ino }
  }
  // Synchronous bounded enqueue: returns true when queued, false when dropped (gap recorded).
  // Write order equals enqueue order because the single serial writer chain is FIFO and a
  // quarantined writer is never replaced; ledgerSeq is assigned inside that serial order.
  function enqueue(record) {
    if (!dir || !accepting || writer.quarantined || writer.queued >= queueLimit) {
      gap(!dir ? 'PROFILE_CONTEXT_UNAVAILABLE' : !accepting ? 'AUDIT_CLOSED' : writer.quarantined ? 'AUDIT_WRITER_QUARANTINED' : 'AUDIT_QUEUE_LIMIT', 'droppedRecords')
      return false
    }
    writer.queued++
    const epoch = writer.epoch
    const stale = () => writer.epoch !== epoch
    const work = writer.tail.then(async () => {
      if (writer.quarantined) { gap('AUDIT_WRITER_QUARANTINED', 'droppedRecords'); return false }
      let settled = false
      const watchdog = setTimeout(() => { if (!settled) quarantine('AUDIT_IO_STALL', 'writeFailures') }, stallTimeoutMs)
      watchdog.unref?.()
      try {
        let file = files.get(record.sessionId)
        const path = pathFor(record.sessionId)
        if (file) {
          let current
          try { current = await fs.stat(path) }
          catch (error) {
            if (error.code !== 'ENOENT' || file.size > 0) throw Object.assign(new Error('ledger changed'), { code: 'AUDIT_FILE_REPLACED' })
          }
          if (stale()) return false
          if (current && (current.size !== file.size || current.mtimeMs !== file.mtimeMs || current.ino !== file.ino)) {
            file = undefined // Revalidate changed files, including corrupt/torn external appends.
          }
        }
        file ??= await load(record.sessionId, () => !stale())
        if (stale()) return false
        if (file.blocked) throw Object.assign(new Error('ledger path blocked by a non-directory'), { code: 'AUDIT_LEDGER_NOTDIR' })
        if (!file.writable) throw Object.assign(new Error('corrupt ledger'), { code: 'AUDIT_CORRUPT_RECORD' })
        const row = parseHistoryRecord({ ...record, ledgerSeq: file.nextSeq })
        const line = `${JSON.stringify(row)}\n`, bytes = Buffer.byteLength(line)
        if (file.size + bytes > maxFileBytes) {
          health.droppedRecords++
          throw Object.assign(new Error('ledger limit'), { code: 'AUDIT_FILE_LIMIT' })
        }
        await fs.mkdir(dir, { recursive: true })
        if (stale()) return false
        const handle = await fs.open(path, 'a', 0o600)
        if (stale()) { await handle.close().catch(() => {}); return false }
        try { await handle.writeFile(line, 'utf8'); await handle.datasync() }
        finally { await handle.close() }
        if (stale()) return false // A committed fs.write cannot be revoked; drop metadata only.
        const after = await fs.stat(path)
        if (stale()) return false
        if (after.size !== file.size + bytes) throw Object.assign(new Error('concurrent external writer'), { code: 'AUDIT_FILE_CHANGED' })
        files.delete(record.sessionId)
        files.set(record.sessionId, { nextSeq: file.nextSeq + 1, writable: true, size: after.size, mtimeMs: after.mtimeMs, ino: after.ino })
        while (files.size > cacheLimit) files.delete(files.keys().next().value)
        return true
      } catch (error) {
        if (stale()) return false // The watchdog already recorded the stall gap.
        files.delete(record.sessionId)
        gap(error.code, 'writeFailures')
        return false
      } finally { settled = true; clearTimeout(watchdog); writer.queued-- }
    })
    writer.tail = work.then(() => undefined, () => undefined)
    return true
  }
  function position(session, exec, parent) {
    if (parent) return { turn: parent.base.turn, step: parent.base.step,
      ...(parent.base.callEventSeq === undefined ? {} : { callEventSeq: parent.base.callEventSeq }) }
    let events = []
    try { events = session.snapshotEvents?.() ?? [] } catch { gap('AUDIT_POSITION_UNAVAILABLE') }
    let turn = null, step = null, boundary = -1
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'turn/end' || event.type === 'step/end') break
      if (event.type === 'step/start') { turn = event.data.turn; step = event.data.step; boundary = i; break }
      if (event.type === 'turn/start') { turn = event.data.turn; break }
    }
    let claimed = claimedCalls.get(session)
    if (!claimed || claimed.turn !== turn || claimed.step !== step) {
      claimed = { turn, step, seqs: new Set() }; claimedCalls.set(session, claimed)
    }
    for (let i = boundary + 1; i < events.length; i++) {
      const event = events[i]
      if (event.type === 'tool/call' && event.data.turn === turn && event.data.step === step
        && event.data.callId === exec.callId && event.data.name === exec.name && !claimed.seqs.has(event.seq)) {
        claimed.seqs.add(event.seq)
        return { turn, step, callEventSeq: event.seq }
      }
    }
    return { turn, step }
  }
  function begin(exec) {
    if (executions.has(exec.token)) return executions.get(exec.token)
    const session = exec.agent?.session
    if (!session || !text(session.id, 200) || !session.id || typeof exec.token !== 'symbol') {
      gap('AUDIT_IDENTITY_UNAVAILABLE', 'droppedRecords')
      return undefined
    }
    if (closed) { gap('AUDIT_CLOSED', 'droppedRecords'); return undefined }
    const parent = executions.get(exec.parent)
    const base = { schemaVersion: 1, dispatchId: randomUUID(), sessionId: session.id,
      ...position(session, exec, parent), callId: String(exec.callId ?? '').slice(0, 200),
      rootCallId: String(exec.rootCallId ?? exec.callId ?? '').slice(0, 200), toolName: String(exec.name ?? '').slice(0, 160),
      ...(parent ? { parentDispatchId: parent.base.dispatchId, parentCallId: parent.base.callId } : {}),
      ...(exec.parent === undefined ? {} : { subCallId: String(exec.callId ?? '').slice(0, 200) }) }
    const entry = { base, exec, manualReported: false, coreAsk: false, abortCause: null, deadlineAt: undefined }
    executions.set(exec.token, entry)
    return entry
  }
  // Synchronous: callers (the approval gate) never await persistence. Returns whether the
  // record was queued; a dropped record is visible via health.gap/droppedRecords.
  function record(entry, phase, outcome, extras = {}) {
    if (!entry) return false
    const fields = {}
    for (const [key, max] of Object.entries(OPTIONAL_TEXT)) {
      if (['errorName', 'errorCode'].includes(key) && !CODE_TOKEN.test(extras[key] ?? '')) continue
      if (typeof extras[key] === 'string') fields[key] = key === 'reasonSummary'
        ? reasonSummary(extras[key]).slice(0, max) : extras[key].replace(/[\x00-\x1f\x7f]/g, '').slice(0, max)
    }
    for (const key of OPTIONAL_NUMBERS) if (int(extras[key])) fields[key] = extras[key]
    if (['low', 'medium', 'high'].includes(extras.risk)) fields.risk = extras.risk
    return enqueue({ ...entry.base, eventId: randomUUID(), time: Date.now(), phase, outcome, ...fields })
  }
  function sessionEvent(session, event) {
    if (!['approval/asked', 'approval/decided'].includes(event.type)) return
    try {
      if (event.type === 'approval/asked') {
        let entry = manualLatches.get(session)
        if (!entry) {
          const candidates = [...executions.values()].filter(item => item.exec.agent?.session === session && item.coreAsk
            && item.base.callId === event.data.callId && item.base.toolName === event.data.toolName)
          if (candidates.length === 1) entry = candidates[0]
          else if (candidates.length > 1) gap('AUDIT_APPROVAL_AMBIGUOUS')
        }
        if (!entry) return
        entry.coreAsk = false
        entry.approvalRequestId = event.data.id
        approvalIds.set(`${session.id}\0${event.data.id}`, entry)
        record(entry, 'manual', 'requested', { approvalRequestId: event.data.id, sourceSeq: event.seq,
          ...(entry.deadlineAt === undefined ? {} : { deadlineAt: entry.deadlineAt }) })
      } else {
        const key = `${session.id}\0${event.data.id}`, entry = approvalIds.get(key)
        if (!entry) return
        // Router-owned requests settle after grant storage and deadline checks.
        // Core-owned requests are still recorded directly from their event.
        if (entry.routerManual) {
          entry.manualSourceSeq = event.seq
          approvalIds.delete(key)
          return
        }
        entry.manualReported = true
        entry.observedManualOutcome = event.data.outcome
        approvalIds.delete(key)
        record(entry, 'manual', event.data.outcome, { approvalRequestId: event.data.id, sourceSeq: event.seq,
          ...(entry.abortCause ? { cause: entry.abortCause } : {}) })
      }
    } catch { gap('AUDIT_OBSERVER_FAILED', 'droppedRecords') }
  }
  function invokeManual(entry, operation) {
    const session = entry?.exec.agent?.session
    if (!session) return operation()
    entry.routerManual = true
    manualLatches.set(session, entry)
    try { return operation() } finally { manualLatches.delete(session) }
  }
  // Synchronous capture: the manual-approval outcome is latched and queued without
  // awaiting persistence, so a stalled ledger can never delay the admission decision.
  function manualOutcome(entry, outcome, extra) {
    if (!entry || entry.manualReported && entry.observedManualOutcome === outcome) return
    entry.manualReported = true
    entry.observedManualOutcome = outcome
    try {
      record(entry, 'manual', outcome, { ...(entry.approvalRequestId ? { approvalRequestId: entry.approvalRequestId } : {}),
        ...(int(entry.manualSourceSeq) ? { sourceSeq: entry.manualSourceSeq } : {}),
        ...(entry.abortCause ? { cause: entry.abortCause } : {}),
        // 2026-10-05：授权记忆的成败必须在这一行落账（这是 manual 唯一的落账点）。
        // 传入优先级高于 abortCause：两者不会同时出现，但显式声明避免歧义。
        ...(extra && extra.cause ? { cause: extra.cause } : {}) })
    } catch { gap('AUDIT_OBSERVER_FAILED', 'droppedRecords') }
  }
  function result(exec, value) {
    const entry = executions.get(exec.token)
    if (!entry) return
    executions.delete(exec.token)
    record(entry, 'reported-result', value.isError ? 'reported-error' : 'reported-ok', {
      ...(value.error?.info?.name ? { errorName: value.error.info.name } : {}),
      ...(value.error?.info?.code ? { errorCode: value.error.info.code } : {}) })
  }
  async function sessionExists(sessionId) {
    if (ctx.sessions?.get?.(sessionId)) return true
    const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery
    if (typeof query?.observeSession !== 'function') return null
    try {
      const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
      try { return observation.header?.id === sessionId } finally { observation[Symbol.dispose]?.() }
    } catch (error) {
      if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
      return null
    }
  }
  async function history(request) {
    let parsed
    try { parsed = parseHistoryRequest(request) } catch { return failure('invalid-request') }
    let before = Number.MAX_SAFE_INTEGER
    if (parsed.cursor !== undefined) {
      try {
        const decoded = Buffer.from(parsed.cursor, 'base64url')
        if (decoded.toString('base64url') !== parsed.cursor) throw new Error('cursor')
        const cursor = JSON.parse(decoded.toString('utf8'))
        if (!plain(cursor) || Object.keys(cursor).sort().join(',') !== 'b,s,v' || cursor.v !== 1 || cursor.s !== parsed.sessionId || !int(cursor.b)) throw new Error('cursor')
        before = cursor.b
      } catch { return failure('invalid-request') }
    }
    const exists = await sessionExists(parsed.sessionId)
    if (exists !== true) return failure(exists === false ? 'session-not-found' : 'session-unavailable')
    if (!dir) return failure('history-unavailable')
    // A query never waits forever for a permanently pending write queue. A quarantined
    // writer's tail may never settle; skip straight to the bounded read.
    if (!writer.quarantined) {
      const flushed = await timed(writer.tail, queryTimeoutMs,
        () => gap('AUDIT_READ_TIMEOUT', 'readFailures'))
      if (!flushed) return failure('history-unavailable')
    }
    let file, loadTimedOut = false
    const settled = await timed(
      load(parsed.sessionId, () => !loadTimedOut).then(value => { file = value }, error => {
        if (!loadTimedOut) { gap(error.code, 'readFailures') }
      }),
      queryTimeoutMs,
      () => { loadTimedOut = true; gap('AUDIT_READ_TIMEOUT', 'readFailures') })
    if (!settled || !file) return failure('history-unavailable')
    // 账本目录被非目录占位（ENOTDIR 归类）：查询降级为空页而不是 history-unavailable，
    // health.gap/readFailures/lastErrorCode 如实反映这次初始化失败类故障。
    if (file.blocked) {
      gap('AUDIT_LEDGER_NOTDIR', 'readFailures')
      return { ok: true, value: { records: [], nextCursor: null, health: { ...health } } }
    }
    const candidates = file.records.filter(row => row.ledgerSeq < before).reverse()
    const records = candidates.slice(0, parsed.limit)
    const nextCursor = candidates.length > records.length
      ? Buffer.from(JSON.stringify({ v: 1, s: parsed.sessionId, b: records.at(-1).ledgerSeq })).toString('base64url') : null
    return { ok: true, value: { records, nextCursor, health: { ...health } } }
  }
  // Bounded drain: on timeout the shared writer is quarantined (epoch bumped, gap
  // recorded) so a late uncancellable fs.write can never race a future writer.
  async function boundedDrain() {
    if (!dir) return true
    return timed(writer.tail, drainTimeoutMs, () => quarantine('AUDIT_DRAIN_TIMEOUT', 'writeFailures'))
  }
  async function close() {
    if (closed) { await boundedDrain(); return }
    closed = true
    health.closing = true
    for (const entry of executions.values()) record(entry, 'reported-result', 'unknown', { cause: 'observer-disposed' })
    executions.clear(); approvalIds.clear(); manualLatches.clear(); files.clear()
    accepting = false
    await boundedDrain()
    writer.refs--
    // A quarantined writer is deliberately left registered: removing it would let a new
    // store spawn a replacement writer that could overtake the stalled, uncancellable I/O.
    if (dir && writer.refs === 0 && !writer.quarantined && writersByDir.get(dir) === writer) writersByDir.delete(dir)
  }
  const safe = (operation, fallback) => (...args) => {
    try { return operation(...args) } catch { gap('AUDIT_OBSERVER_FAILED', 'droppedRecords'); return fallback }
  }
  return { begin: safe(begin, undefined), record: safe(record, false),
    result: safe(result, undefined), sessionEvent, invokeManual, manualOutcome, history, close,
    drain: async () => { await boundedDrain() }, health: () => ({ ...health }) }
}
