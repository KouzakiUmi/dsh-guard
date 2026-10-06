// Narrow GUI API. The legacy CLI is deliberately not a mutation gateway.
import { createHash, randomUUID } from 'node:crypto'
import { parseRollbackRequest } from './rollback-remote.js'
import { constants, openSync, closeSync, fstatSync, ftruncateSync, fsyncSync, writeSync,
  lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { appendEntry, readAllEntries, objectPath, probeFile, existingPathGuards, fileIdentity, sha1Hex, safeMkdir, safeStateWrite, canonicalPathKey } from './ledger.js'

export const UI_MAX_BYTES = 2 * 1024 * 1024
const TTL = 120000
const MAX_PREVIEWS = 256
const digest = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const publicVersion = (p) => ({ existed: p.existed, bytes: p.bytes, hash: p.existed === false ? 'absent' : p.buffer ? sha1Hex(p.buffer) : null,
  status: p.existed === null ? 'unsafe-or-unreadable' : p.oversized ? 'oversized' : p.existed ? 'file' : 'absent' })
const image = (e) => e ? { available: e.existed === false || /^[a-f0-9]{40}$/.test(e.hash || ''), existed: e.existed, hash: e.hash, bytes: e.bytes } : null

/**
 * 默认写工具名单。lib/index.js 从这里 import，避免两处默认值漂移。
 * 必须是冻结的：调用方若就地修改会污染后续所有 API 实例的默认行为。
 */
export const DEFAULT_CAPTURE_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor'])

function session(value) {
  if (typeof value !== 'string' || !value || value === 'unknown' || value.length > 512) throw new Error('INVALID_SESSION')
  return value
}
function writerSet(captureTools) {
  const names = Array.isArray(captureTools) ? captureTools : DEFAULT_CAPTURE_TOOLS
  const set = new Set(names.filter((n) => typeof n === 'string' && n.length > 0))
  return set.size > 0 ? set : new Set(DEFAULT_CAPTURE_TOOLS)
}
/**
 * 聚合会话内按物理文件归并的条目。
 *
 * 2026-10-06 修正：只读工具的 call 目标**不**再建立文件组。read/grep/glob
 * 都会带 path 参数，旧口径把它们全量并进「已修改文件」，于是三个只读工具贡献了
 * 2911 条路径、1193 个文件组——占列表 73%——它们从未被写工具碰过，自然也
 * 没有任何 capture，UI 只能显示成 captureStatus='not-captured'（没有前像），
 * 看上去像快照功能整体失效。写工具的 call 仍保留，用于 UNCAPTURED_TOOL_TARGET
 * （某轮声明要改这个路径却没有快照）与工具名展示。
 */
function groups(entries, sessionId, turn, writers) {
  const map = new Map()
  entries.forEach((e, index) => {
    if (e.session !== sessionId || !Number.isSafeInteger(e.turn) || (turn !== undefined && e.turn !== turn)) return
    const paths = e.kind === 'capture' ? [e.path]
      : e.kind === 'call' && Array.isArray(e.targets) && writers.has(e.tool) ? e.targets : []
    for (const path of paths) {
      if (typeof path !== 'string' || !path) continue
      // Aggregate by canonical key so case aliases of one physical file share a
      // group; the display path keeps the first-seen (owner) original spelling.
      const key = canonicalPathKey(path)
      let g = map.get(key)
      if (!g) { g = { key, path, captures: [], calls: [], index }; map.set(key, g) }
      if (e.kind === 'capture') g.captures.push({ e, index })
      else g.calls.push(e)
    }
  })
  return [...map.values()].map((g) => {
    const first = g.captures.find(({ e }) => e.phase === 'before')
    const last = g.captures.at(-1)
    return { ...g, first, last, entryId: 'entry-' + digest(JSON.stringify([sessionId, turn ?? null, g.key, first?.index ?? g.index, first?.e.id ?? null])) }
  })
}
function checkedObject(stateDir, e) {
  if (e.existed === false) return Buffer.alloc(0)
  if (!/^[a-f0-9]{40}$/.test(e.hash || '') || !Number.isSafeInteger(e.bytes) || e.bytes > UI_MAX_BYTES || e.bytes < 0) throw new Error('IMAGE_UNAVAILABLE_OR_OVERSIZED')
  const p = probeFile(objectPath(stateDir, e.hash), UI_MAX_BYTES)
  if (p.existed !== true || !p.buffer || p.bytes !== e.bytes || sha1Hex(p.buffer) !== e.hash) throw new Error('CAS_MISSING_OR_CORRUPT')
  return p.buffer
}
function inspect(stateDir, entries, g) {
  const before = g.first?.e
  const after = g.last?.e.phase === 'after' ? g.last.e : null
  const current = probeFile(g.path, UI_MAX_BYTES)
  let reason = ''
  const latestStart = entries.findLastIndex((e) => e.kind === 'turn/start' && e.session === (before?.session || g.calls[0]?.session))
  if (latestStart >= 0 && !entries.slice(latestStart + 1).some((e) => e.kind === 'turn/end' && e.session === entries[latestStart].session && e.turn === entries[latestStart].turn)) reason = 'ACTIVE_SESSION_TURN'
  let beforeBytes = null
  let afterBytes = null
  try { if (before) beforeBytes = checkedObject(stateDir, before) } catch (error) { reason = error.message }
  try { if (after) afterBytes = checkedObject(stateDir, after) } catch (error) { reason ||= error.message }
  if (!before) reason ||= 'NO_PREIMAGE'
  if (!after) reason ||= 'PREIMAGE_ONLY_NO_POSTIMAGE'
  if (g.captures.some(({ e, index }) => !entries.slice(index + 1).some((end) => end.kind === 'turn/end' && end.session === e.session && end.turn === e.turn))) reason ||= 'TURN_NOT_ENDED'
  if (before && !Array.isArray(before.guards)) reason ||= 'LEGACY_CAPTURE_NO_PATH_IDENTITY'
  // 2026-10-05 修正（HIGH-5）：before 若因「祖先目录当时尚不存在」而 guards 为空
  // （pathGuards 的 missing 分支，existed=false），这是正常的新建目录场景，
  // 不是祖先被换。旧口径直接 same() 比对，[] 对不上完整链，
  // 导致新建目录下的文件永远 canRestore=false —— 正是 MEDIUM-6 声称修复却没修到的点。
  // 判据：before.existed === false 且 before.guards 为空 → 跳过基线比对。
  const beforeBaselineEmpty = before?.existed === false && Array.isArray(before.guards) && before.guards.length === 0
  if (before && after && !beforeBaselineEmpty && !same(before.guards, after.guards)) reason ||= 'BASELINE_ANCESTOR_CHANGED'
  // 2026-10-05 修正（N9 / 第三轮 HIGH-1）：HIGH-5 跳过基线比对后暴露一个新错误——
  // g.first 是**首个** before，g.last 是**末个** after，跨轮时二者不同轮。
  // turn1 建文件、turn2 编辑它 → changeType 报 created、action 说「撤回创建」，
  // restore 真把含最新内容的文件删掉（第三轮实测三轮编辑，文件被删）。
  //
  // 判据必须只看 `before.existed === false`，**不能**挂在 beforeBaselineEmpty 上：
  // 那个条件要求 guards 为空，只覆盖「新建目录」；而在**已存在目录里新建文件**
  // （最常见的情况）probeFile 返回的是完整非空 guards，判据根本不触发。
  // guards 是否为空是 HIGH-5 用来区分「新建目录」与「祖先被换」的信号，
  // 与「文件是否被创建过」是两件事，不该复用。
  const createdEarlier = before?.existed === false && after !== null && after !== undefined
    && after.turn !== before.turn
  if (createdEarlier) reason ||= 'CREATED_IN_EARLIER_TURN'
  if (g.captures.some(({ e }) => e.phase === 'before' && !g.captures.some(({ e: post }) => post.phase === 'after' && post.turn === e.turn))) reason ||= 'INCOMPLETE_TURN_CAPTURE'
  // Full-only applies to EVERY captured image, not just the displayed endpoints.
  let historyComplete = true
  const pairs = new Map()
  try {
    for (const { e, index } of g.captures) {
      if (!['before', 'after'].includes(e.phase) || ![true, false].includes(e.existed)) throw new Error('INVALID_CAPTURE_FACT')
      checkedObject(stateDir, e)
      if (!Array.isArray(e.guards) || (e.existed && (!e.identity || e.identity.nlink !== 1))) throw new Error('INCOMPLETE_CAPTURE_IDENTITY')
      let pair = pairs.get(e.turn)
      if (!pair) { pair = {}; pairs.set(e.turn, pair) }
      if (pair[e.phase]) throw new Error('AMBIGUOUS_TURN_CAPTURE')
      pair[e.phase] = { e, index }
    }
    let previous
    for (const pair of pairs.values()) {
      if (!pair.before || !pair.after || pair.before.index >= pair.after.index) throw new Error('INCOMPLETE_TURN_CAPTURE')
      if (!entries.slice(pair.after.index + 1).some((e) => e.kind === 'turn/end' && e.session === pair.after.e.session && e.turn === pair.after.e.turn)) throw new Error('TURN_NOT_ENDED')
      if (previous && (previous.existed !== pair.before.e.existed || previous.hash !== pair.before.e.hash
        || !same(previous.guards, pair.before.e.guards))) throw new Error('DISCONTINUOUS_CAPTURE_HISTORY')
      previous = pair.after.e
    }
    if (g.calls.some((call) => !pairs.has(call.turn))) throw new Error('UNCAPTURED_TOOL_TARGET')
  } catch (error) { historyComplete = false; reason ||= error.message }
  if (after && (!same(after.guards, current.guards) || (after.existed && (!current.identity || String(after.identity?.dev) !== current.identity.dev || String(after.identity?.ino) !== current.identity.ino)))) reason ||= 'PATH_IDENTITY_CHANGED'
  if (current.existed === null) reason ||= 'UNSAFE_OR_UNREADABLE_PATH'
  if (current.oversized) reason ||= 'CURRENT_OVERSIZED'
  if (after && (current.existed !== after.existed || (current.existed && (!current.buffer || sha1Hex(current.buffer) !== after.hash)))) reason ||= 'CURRENT_HASH_CONFLICT'
  if (g.first && entries.some((e, index) => e.kind === 'capture' && typeof e.path === 'string' && canonicalPathKey(e.path) === g.key && index > g.first.index && (e.session !== before.session || index > g.last.index))) reason ||= 'NEWER_OR_OTHER_SESSION_CAPTURE'
  if (before && after && before.existed === after.existed && before.hash === after.hash) reason ||= 'NO_CAPTURED_CHANGE'
  // 跨轮创建后又被编辑：实际是「修改」，不是「创建」。报 created 会让 UI 显示
  // 「撤回创建」，掩盖了「这里有一份后续工作会被删掉」的真实含义。
  // 判据与 CREATED_IN_EARLIER_TURN 同源（只看 before.existed，不看 guards）。
  const changeType = !before || !after ? 'unknown' : createdEarlier ? 'modified'
    : before.existed === false && after.existed ? 'created'
      : before.existed && after.existed === false ? 'deleted'
        : before.hash === after.hash ? 'unchanged' : 'modified'
  const tools = [...new Set([...g.calls.map((e) => e.tool), ...g.captures.map(({ e }) => e.tool)].filter((s) => typeof s === 'string'))]
  const row = { entryId: g.entryId, path: g.path, turns: [...new Set(g.captures.map(({ e }) => e.turn).concat(g.calls.map((e) => e.turn)))], tools,
    changeType, captureComplete: historyComplete, captureStatus: !before ? 'not-captured' : !after ? 'preimage-only' : !historyComplete ? 'incomplete-history' : 'before-and-after',
    preImage: image(before), postImage: image(after), current: publicVersion(current), canRestore: !reason, reason }
  if (row.preImage) row.preImage.available = beforeBytes !== null
  if (row.postImage) row.postImage.available = afterBytes !== null
  return { row, before, after, beforeBytes, afterBytes, current }
}
function text(buffer) {
  if (buffer === null) return null
  if (buffer.includes(0)) return null
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return null
    return value
  } catch { return null }
}
export function compactDiff(a, b) {
  const left = text(a), right = text(b)
  if (left === null || right === null) return { kind: a === null || b === null ? 'unavailable' : 'binary', text: '', truncated: false }
  const x = left.split('\n'), y = right.split('\n')
  let start = 0, end = 0
  while (start < x.length && start < y.length && x[start] === y[start]) start++
  while (end < x.length - start && end < y.length - start && x[x.length - end - 1] === y[y.length - end - 1]) end++
  if (start === x.length && start === y.length) return { kind: 'text', text: '(内容相同)', truncated: false }
  const lines = [`@@ 原始 ${start + 1} / 当前 ${start + 1} @@`, ...x.slice(start, x.length - end).map((s) => '-' + s), ...y.slice(start, y.length - end).map((s) => '+' + s)]
  const output = lines.slice(0, 160).join('\n')
  return { kind: 'text', text: output.slice(0, 24000), truncated: lines.length > 160 || output.length > 24000 }
}

/** Instances are fiber-owned; previews never survive restart/unload. */
export function createRollbackApi(stateDir, { now = Date.now, io = {}, assertSession = () => { throw new Error('SESSION_VERIFIER_UNAVAILABLE') }, captureTools } = {}) {
  const tickets = new Map()
  // captureTools is volatile config. Accept a getter so a long-lived remote API
  // observes settings edits made after startup, just like the capture listener.
  const writers = () => writerSet(typeof captureTools === 'function' ? captureTools() : captureTools)
  const write = io.writeSync || writeSync
  const record = io.appendEntry || appendEntry
  const lookup = (sessionId, entryId) => {
    session(sessionId)
    if (typeof entryId !== 'string' || !/^entry-[a-f0-9]{64}$/.test(entryId)) throw new Error('INVALID_ENTRY_ID')
    const entries = readAllEntries(stateDir)
    const activeWriters = writers()
    let g = groups(entries, sessionId, undefined, activeWriters).find((g) => g.entryId === entryId)
    if (!g) {
      const turns = new Set(entries.filter((e) => e.session === sessionId && Number.isSafeInteger(e.turn)).map((e) => e.turn))
      for (const turn of turns) {
        g = groups(entries, sessionId, turn, activeWriters).find((g) => g.entryId === entryId)
        if (g) break
      }
    }
    if (!g) throw new Error('ENTRY_NOT_IN_SESSION')
    return { entries, g, view: inspect(stateDir, entries, g) }
  }
  const prune = () => { for (const [nonce, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(nonce) }
  return {
    async changedFiles(request) {
      parseRollbackRequest('changedFiles', request)
      // assertSession may perform an async Host read; failure always denies (fail-closed).
      await assertSession(request.sessionId, false)
      const { sessionId, cursor = 0, limit = 25, turn } = request
      session(sessionId)
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (turn !== undefined && !Number.isSafeInteger(turn))) throw new Error('INVALID_PAGE')
      const entries = readAllEntries(stateDir)
      // 2026-10-06：列表只列**有 capture 的文件组**。「已修改文件」的语义是
      // 「文件工具确实改过、并且改前改后都有快照」，只有 call 没有 capture 的路径
      // 没有可恢复内容（旧口径会把只读调用也列进来，见 groups() 注释）。
      const all = groups(entries, sessionId, turn, writers()).filter((g) => g.captures.length > 0)
      const rows = all.slice(cursor, cursor + limit).map((g) => inspect(stateDir, entries, g).row)
      return { sessionId, rows, total: all.length, nextCursor: cursor + limit < all.length ? cursor + limit : null,
        coverage: '只列有前后像快照的文件；shell、其他插件、人工改动未覆盖，仅被读取的文件不计入。捕获不代表工具已执行或成功。diff 是首个前像与当前文件对比，不是完整会话 netdiff。' }
    },
    async preview(request) {
      parseRollbackRequest('preview', request)
      await assertSession(request.sessionId, false)
      const { sessionId, entryId } = request
      const { view } = lookup(sessionId, entryId)
      const diff = compactDiff(view.beforeBytes, view.current.existed === false ? Buffer.alloc(0) : view.current.buffer)
      prune()
      for (const [key, ticket] of tickets) if (ticket.sessionId === sessionId && ticket.entryId === entryId) tickets.delete(key)
      let nonce = null
      const expectedCurrentHash = view.row.current.hash
      if (view.row.canRestore) {
        while (tickets.size >= MAX_PREVIEWS) tickets.delete(tickets.keys().next().value)
        nonce = randomUUID()
        tickets.set(nonce, { sessionId, entryId, expectedCurrentHash, identity: view.current.identity, guards: view.current.guards,
          beforeHash: view.before.hash, afterHash: view.after.hash, expiresAt: now() + TTL })
      }
      return { sessionId, entryId, ...view.row, nonce, expectedCurrentHash, expiresAt: nonce ? now() + TTL : null,
        diff, diffBasis: '首个捕获前像 → 当前文件（不保证是完整会话净改动）',
        // N9：只在「首个 before 声称原本不存在」且**同轮**有 after 时才是「撤回创建」。
        // 跨轮（创建之后又编辑过）说「撤回创建」会诱导用户丢掉后续工作。
        action: view.before?.existed === false && view.row.changeType === 'created'
          ? '撤回创建（备份后移除文件）'
          : '恢复首个捕获前像（保留当前文件备份）' }
    },
    async restore(request) {
      parseRollbackRequest('restore', request)
      // Mutation additionally requires the session to have no in-progress turn.
      await assertSession(request.sessionId, true)
      const { sessionId, entryId, nonce, expectedCurrentHash } = request
      prune()
      const ticket = tickets.get(nonce)
      tickets.delete(nonce) // Every attempt consumes the ticket, including conflicts.
      if (!ticket || ticket.sessionId !== sessionId || ticket.entryId !== entryId || ticket.expectedCurrentHash !== expectedCurrentHash) throw new Error('INVALID_OR_EXPIRED_PREVIEW')
      const { view } = lookup(sessionId, entryId)
      if (!view.row.canRestore || view.row.current.hash !== expectedCurrentHash || !same(view.current.identity, ticket.identity) || !same(view.current.guards, ticket.guards) || view.before.hash !== ticket.beforeHash || view.after.hash !== ticket.afterHash) throw new Error('PREVIEW_CONFLICT: ' + (view.row.reason || 'version changed'))
      const operationId = randomUUID()
      const backupDir = join(stateDir, 'trash', operationId)
      // Prove the audit intent can be persisted before touching any target.
      record(stateDir, { kind: 'rollback', session: sessionId, turn: view.before.turn, entryId, operationId, phase: 'intent', applied: false, expectedCurrentHash })
      let applied = false, failure = null, fd, backup = null, createdIdentity = null, touched = false, quarantine = null, quarantined = false
      try {
        safeMkdir(backupDir)
        safeStateWrite(join(backupDir, 'existence.json'), JSON.stringify({ path: view.row.path, existed: view.current.existed, expectedCurrentHash }), { exclusive: true })
        if (view.current.existed) {
          backup = join(backupDir, 'current.bin')
          writeFileSync(backup, view.current.buffer, { flag: 'wx' })
          const verified = probeFile(backup, UI_MAX_BYTES)
          if (!verified.buffer || sha1Hex(verified.buffer) !== expectedCurrentHash) throw new Error('BACKUP_VERIFICATION_FAILED')
        }
        const fresh = probeFile(view.row.path, UI_MAX_BYTES)
        if (!same(fresh.guards, ticket.guards) || !same(fresh.identity, ticket.identity) || publicVersion(fresh).hash !== expectedCurrentHash) throw new Error('WRITE_TIME_CONFLICT')
        if (view.before.existed === false) {
          // Rename to same-directory quarantine first; verify the exact moved inode before deleting it.
          quarantine = view.row.path + '.dsh-rollback-' + operationId
          if (probeFile(quarantine, UI_MAX_BYTES).existed !== false) throw new Error('QUARANTINE_EXISTS')
          renameSync(view.row.path, quarantine)
          quarantined = true
          const moved = probeFile(quarantine, UI_MAX_BYTES)
          if (moved.existed !== true || moved.identity.dev !== ticket.identity.dev || moved.identity.ino !== ticket.identity.ino || publicVersion(moved).hash !== expectedCurrentHash) {
            throw new Error('QUARANTINE_IDENTITY_CONFLICT')
          }
          (io.unlinkSync || unlinkSync)(quarantine)
          quarantined = false
          applied = true
        } else {
          fd = openSync(view.row.path, view.current.existed ? constants.O_RDWR | (constants.O_NOFOLLOW || 0) : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
          const info = fstatSync(fd)
          if (!info.isFile() || info.nlink !== 1) throw new Error('UNSAFE_OPEN_FILE_TYPE_OR_HARDLINK')
          if (view.current.existed && !same(fileIdentity(info), ticket.identity)) throw new Error('OPEN_IDENTITY_CONFLICT')
          if (!view.current.existed) createdIdentity = fileIdentity(info)
          if (!same(existingPathGuards(view.row.path), ticket.guards)) throw new Error('ANCESTOR_EXCHANGED')
          if (view.current.existed) {
            const immediate = probeFile(view.row.path, UI_MAX_BYTES)
            if (!same(immediate.identity, ticket.identity) || publicVersion(immediate).hash !== expectedCurrentHash) throw new Error('OPEN_HASH_CONFLICT')
          }
          touched = true
          let offset = 0
          while (offset < view.beforeBytes.length) {
            const n = write(fd, view.beforeBytes, offset, view.beforeBytes.length - offset, offset)
            if (!n) throw new Error('SHORT_WRITE')
            offset += n
          }
          ftruncateSync(fd, view.beforeBytes.length)
          fsyncSync(fd)
          const verified = probeFile(view.row.path, UI_MAX_BYTES)
          if (verified.existed !== true || (verified.identity.ino !== String(info.ino) || verified.identity.dev !== String(info.dev)) || !verified.buffer || sha1Hex(verified.buffer) !== view.before.hash) throw new Error('RESTORE_VERIFICATION_FAILED')
          applied = true
        }
      } catch (error) {
        failure = error.message || String(error)
        if (quarantined) {
          try {
            const moved = probeFile(quarantine, UI_MAX_BYTES)
            if (!same(existingPathGuards(view.row.path), ticket.guards) || moved.existed !== true || moved.identity.dev !== ticket.identity.dev || moved.identity.ino !== ticket.identity.ino || publicVersion(moved).hash !== expectedCurrentHash) throw new Error('QUARANTINE_RECOVERY_UNSAFE')
            // link is exclusive: never overwrite a concurrently created replacement pathname.
            linkSync(quarantine, view.row.path)
            unlinkSync(quarantine)
            quarantined = false
          } catch (repair) { failure += '; quarantine retained at ' + quarantine + ': ' + repair.message }
        }
        // Repair only the inode actually opened, never overwrite a replacement pathname.
        if (fd !== undefined && (touched || createdIdentity)) {
          try {
            if (view.current.existed && touched) {
              let offset = 0
              while (offset < view.current.buffer.length) {
                const n = writeSync(fd, view.current.buffer, offset, view.current.buffer.length - offset, offset)
                if (!n) throw new Error('SHORT_RECOVERY_WRITE')
                offset += n
              }
              ftruncateSync(fd, view.current.buffer.length); fsyncSync(fd)
            } else if (createdIdentity) {
              const leaf = lstatSync(view.row.path)
              closeSync(fd); fd = undefined
              if (String(leaf.ino) === createdIdentity.ino && String(leaf.dev) === createdIdentity.dev && same(existingPathGuards(view.row.path), ticket.guards)) unlinkSync(view.row.path)
            }
          } catch (repair) { failure += '; recovery failed: ' + repair.message }
        }
      } finally { if (fd !== undefined) closeSync(fd) }
      const receipt = { sessionId, entryId, operationId, applied, recorded: true, backup, quarantine: quarantined ? quarantine : null, error: failure }
      try { record(stateDir, { kind: 'rollback', session: sessionId, turn: view.before.turn, entryId, operationId, phase: 'receipt', ...receipt }) }
      catch (error) { receipt.recorded = false; receipt.auditError = error.message || String(error) }
      return receipt
    },
    dispose() { tickets.clear() },
  }
}
