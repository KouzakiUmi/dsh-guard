/**
 * dsh-audit-rollback · 步/轮边界与归属（阶段 B / B2）
 *
 * 契约：docs/design-audit-rollback.md §10.5（账本新条目）、§10.6（恢复语义）。
 *
 * 本模块是**纯 node:* 的边界层**（与 ledger.js / snapshot.js 同款定位）：不依赖 Cordis，
 * 插件侧只做"事件 → 调用本模块"的适配，CLI 侧直接读账本调用本模块。
 *
 * 它负责四件事：
 *   1. 把一次边界快照写进账本（`snapshot` 条目）并同时落 ref（`captureBoundary`）；
 *   2. 把一个步/轮的归属路径集合写进账本（`attribution` 条目，`recordAttribution`）；
 *   3. 从账本里定位边界并算出"边界之后被归属的路径集合 P"（`resolveBoundary`、
 *      `collectAttributionPaths`）——**P 是回滚唯一允许触碰的范围**；
 *   4. 产出回滚计划（`planBoundaryRollback`）：逐路径判定 `restore` / `trash` / `skip`，
 *      并在任何移动发生之前做完一致性参照校验与对象预检。
 *
 * 本模块**不执行**任何文件改动（执行在 B3 的 CLI 侧）：计划是纯数据，可被 dry-run 直接渲染。
 *
 * 两条不变量（违反即缺陷）：
 *   - 不在 P 中的路径**永不出现**在任何动作里；
 *   - 参照校验用"该路径在边界之后**最后一次**归属快照里的版本"，不得用"全账本最后一条"。
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { appendEntry, canonicalPathKey, initState, probeFile, readAllEntries } from './ledger.js'
import {
  BOUNDARY_REF_PREFIX,
  canonicalRoot,
  captureTree,
  diffTrees,
  readTreeEntry,
  toRelPath,
  writeBoundaryRef,
} from './snapshot.js'

/** 账本 kind（契约 §10.5，字段名逐字固定）。 */
export const BOUNDARY_KIND = {
  SNAPSHOT: 'snapshot',
  ATTRIBUTION: 'attribution',
  ABORT: 'abort',
}

/** 边界相位。 */
export const BOUNDARY_PHASE = { START: 'start', END: 'end' }

/** **轮级**快照使用的伪 step 号（与阶段 A「轮号未知用 -1」的惯例同向）。 */
export const TURN_LEVEL_STEP = -1

/** 计划动作（与阶段 A 的 `rollback.actions[].action` 同名，不新增词表）。 */
export const PLAN_ACTION = { RESTORE: 'restore', TRASH: 'trash', SKIP: 'skip' }

/** 计划级失败原因。 */
export const BOUNDARY_REASON = {
  BOUNDARY_MISSING: 'BOUNDARY_MISSING',
  NO_ATTRIBUTION: 'NO_ATTRIBUTION',
  LEDGER_UNREADABLE: 'LEDGER_UNREADABLE',
}

/**
 * sessionId → ref 路径片段的安全转写。
 * ref 名里不允许出现空格、`~`、`^`、`:`、`?`、`*`、`[`、`\` 等字符；一律替换成 `_`，
 * 并限制长度，避免畸形 sessionId 造出非法 ref。
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionKeyOf(sessionId) {
  const raw = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown'
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return safe.length > 96 ? safe.slice(0, 96) : safe
}

/**
 * 边界 ref 名（契约 §10.3）：`refs/dsh/<sessionKey>/t<turn>s<step>-<phase>`。
 * @returns {string}
 */
export function boundaryRefName(sessionId, turn, step, phase) {
  const t = Number.isFinite(turn) ? turn : -1
  const s = Number.isFinite(step) ? step : TURN_LEVEL_STEP
  const p = phase === BOUNDARY_PHASE.END ? BOUNDARY_PHASE.END : BOUNDARY_PHASE.START
  return `${BOUNDARY_REF_PREFIX}/${sessionKeyOf(sessionId)}/t${t}s${s}-${p}`
}

/**
 * 确保账本可写（幂等）：建 state.json / ledger / objects（与阶段 A 插件加载时的初始化同口径）。
 *
 * 为什么放在这里：`appendEntry` 走 ledger 的祖先链安全校验，stateDir 尚未初始化时会**拒绝写入**；
 * 而边界层既被插件调用也被离线 CLI 调用，不能假设"插件已经初始化过"。
 * @returns {string|null} 失败原因，成功为 null
 */
function ensureLedgerReady(stateDir) {
  try {
    initState(stateDir)
    return null
  } catch (error) {
    return String(error && error.message ? error.message : error)
  }
}

/**
 * 计算 git blob oid（`sha1("blob <len>\0" + content)`）。
 *
 * 用途：把"当前文件内容"与 tree 里的 blob oid 直接比较，无需再起 git 子进程。
 * 之所以成立：影子库固定 `core.autocrlf=false`，tree 里的 blob 就是原始字节
 * （见 snapshot.js 的红线说明），所以这里的纯 node 计算与 git 的结果逐字一致——
 * `test/boundary.mjs` 会拿 `git hash-object --stdin` 对照验证这一点。
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function gitBlobOid(buffer) {
  return createHash('sha1')
    .update(`blob ${buffer.length}\0`, 'utf8')
    .update(buffer)
    .digest('hex')
}

/**
 * 读一个路径的当前状态。**"读不出来"不等于"不存在"**（与 ledger 的 fileIdentity 同口径）：
 * 目录、权限错误等一律返回 `existed: null`，让调用方按 fail-closed 处理。
 * @param {string} absPath
 * @returns {{existed:boolean|null, oid:string|null, bytes:number, error:string|null}}
 */
export function readCurrentFile(absPath) {
  const probe = probeFile(absPath, 64 * 1024 * 1024)
  if (probe.existed === null || probe.oversized === true) {
    return { existed: null, oid: null, bytes: probe.bytes, error: probe.oversized === true
      ? 'CURRENT_FILE_TOO_LARGE' : String(probe.error?.code ?? probe.error) }
  }
  return { existed: probe.existed, oid: probe.existed ? gitBlobOid(probe.buffer) : null, bytes: probe.bytes,
    mode: probe.existed ? ((probe.identity.mode & 0o111) ? '100755' : '100644') : null, error: null }
}

/**
 * 写一次边界快照：captureTree → writeBoundaryRef → 账本 `snapshot` 条目。
 *
 * 任何失败都写一条 `degraded: true` 的账本条目（tree 写 null）并正常返回，
 * **不抛异常**——快照失败绝不能影响轮次推进（契约 §10.10）。
 *
 * @param {object} options 透传 snapshot.js 的参数（excludeGlobs/ignorePolicy/budget/autoExcludeOversized/gitPath/timeoutMs）
 * @param {string} options.stateDir
 * @param {string} options.root 被审计根
 * @param {string} options.session
 * @param {number} options.turn
 * @param {number} options.step
 * @param {'start'|'end'} options.phase
 * @returns {Promise<{ok:boolean, tree:string|null, ref:string, files:number, ms:number, degraded:boolean, reason:string|null}>}
 */
export async function captureBoundary(options) {
  const { stateDir, session, turn, step, phase } = options
  const root = canonicalRoot(options.root)
  const ref = boundaryRefName(session, turn, step, phase)

  const capture = await captureTree(options)
  let refOk = false
  let refReason = null
  if (capture.ok === true && typeof capture.tree === 'string') {
    const written = await writeBoundaryRef({
      stateDir,
      root,
      ref,
      tree: capture.tree,
      message: `dsh boundary ${session} turn ${turn} step ${step} ${phase}`,
      gitPath: options.gitPath,
      timeoutMs: options.timeoutMs,
    })
    refOk = written.ok === true
    refReason = written.reason ?? null
  }

  const ok = capture.ok === true && refOk
  const reason = capture.ok === true ? refReason : (capture.reason ?? null)

  // 账本写入结果**必须回传**：审计静默丢失比快照失败更危险（阶段 A/CLI 都靠它）。
  let ledgerOk = false
  let ledgerError = ensureLedgerReady(stateDir)
  if (ledgerError === null) {
    try {
      appendEntry(stateDir, {
        kind: BOUNDARY_KIND.SNAPSHOT,
        session,
        root,
        turn,
        step,
        phase: phase === BOUNDARY_PHASE.END ? BOUNDARY_PHASE.END : BOUNDARY_PHASE.START,
        tree: ok ? capture.tree : null,
        files: capture.files ?? 0,
        ms: capture.ms ?? 0,
        degraded: !ok,
        reason: ok ? null : reason,
        // 自动排除的顶层项：必须记账，否则"静默缩小审计覆盖面"（契约 §10.4 第 6 条）。
        ...(Array.isArray(capture.autoExcluded) && capture.autoExcluded.length > 0
          ? { autoExcluded: capture.autoExcluded }
          : {}),
        // 事件发生时刻与真正捕获时刻的差：快照是异步追拍，lag 大意味着 start 树可能失真。
        ...(Number.isFinite(options.lagMs) ? { lagMs: options.lagMs } : {}),
      })
      ledgerOk = true
    } catch (error) {
      ledgerError = String(error && error.message ? error.message : error)
    }
  }

  return {
    ok,
    tree: ok ? capture.tree : null,
    ref,
    files: capture.files ?? 0,
    ms: capture.ms ?? 0,
    degraded: !ok,
    reason: ok ? null : reason,
    autoExcluded: Array.isArray(capture.autoExcluded) ? capture.autoExcluded : [],
    ledgerOk,
    ledgerError,
  }
}

/**
 * 计算并记录某步/轮的归属路径集合（契约 §10.5 的 `attribution`）。
 *
 * `paths` 写**绝对路径**（与账本 §4「path 一律绝对路径」的通用约定一致），
 * 回滚侧再通过 `toRelPath` 转回影子库相对路径。
 *
 * @returns {Promise<{ok:boolean, paths:string[], degraded:boolean, reason:string|null}>}
 */
export async function recordAttribution(options) {
  const { stateDir, session, turn, step } = options
  const root = canonicalRoot(options.root)
  const diff = await diffTrees(options)
  const ledgerErrorPre = ensureLedgerReady(stateDir)
  if (diff.ok !== true) {
    let ledgerOk = false
    if (ledgerErrorPre === null) {
      try {
        appendEntry(stateDir, {
          kind: BOUNDARY_KIND.ATTRIBUTION, session, root, turn, step,
          from: options.from ?? null, to: options.to ?? null, paths: [], degraded: true, reason: diff.reason ?? null,
        })
        ledgerOk = true
      } catch { /* 下面按 ledgerOk=false 回传 */ }
    }
    return { ok: false, paths: [], degraded: true, reason: diff.reason ?? null, ledgerOk, ledgerError: ledgerErrorPre }
  }

  const paths = []
  const seen = new Set()
  const addRel = (rel) => {
    if (typeof rel !== 'string' || rel.length === 0) return
    const abs = join(root, ...rel.split('/'))
    const key = canonicalPathKey(abs)
    if (seen.has(key)) return
    seen.add(key)
    paths.push(abs)
  }
  for (const entry of diff.entries) {
    // **rename 必须把旧路径也纳入归属**：只记新路径会让 undo 后旧文件名永久消失
    // （2026-10-11 全面复核实证：a.txt→b.txt 后 undo 只处理 b.txt，a.txt 只留在 trash 里，
    //  CLI 却报成功退出 0）。`renamedFrom` 由 diffTrees 的 numstat -z 解析给出。
    addRel(entry.renamedFrom)
    addRel(entry.path)
  }
  paths.sort()

  let ledgerOk = false
  let ledgerError = ledgerErrorPre
  if (ledgerError === null) {
    try {
      appendEntry(stateDir, {
        kind: BOUNDARY_KIND.ATTRIBUTION, session, root, turn, step,
        from: options.from ?? null, to: options.to ?? null, paths, degraded: false, reason: null,
      })
      ledgerOk = true
    } catch (error) {
      ledgerError = String(error && error.message ? error.message : error)
    }
  }

  return { ok: true, paths, degraded: false, reason: null, ledgerOk, ledgerError }
}

/**
 * 定位边界 tree（契约 §10.6 第 1 条的三档退化）：
 *   1. 该 step 的 `start` 快照；
 *   2. 该轮最小的非负 step 的 `start` 快照；
 *   3. 该轮的轮级快照（`step === TURN_LEVEL_STEP` 的 `start`）。
 *
 * @param {object[]} entries 账本条目（按追加顺序）
 * @param {{session:string, turn:number, step?:number}} target
 * @returns {{tree:string, ref:string, source:'step-start'|'turn-start', step:number}|null}
 */
export function resolveBoundary(entries, target) {
  const snapshots = (Array.isArray(entries) ? entries : []).filter((entry) =>
    entry && entry.kind === BOUNDARY_KIND.SNAPSHOT &&
    entry.session === target.session && entry.turn === target.turn &&
    entry.phase === BOUNDARY_PHASE.START && typeof entry.tree === 'string' && entry.tree.length > 0)

  if (snapshots.length === 0) return null
  const wanted = Number.isFinite(target.step) ? target.step : undefined

  if (wanted !== undefined) {
    const exact = snapshots.find((entry) => entry.step === wanted)
    if (exact !== undefined) {
      return { tree: exact.tree, ref: boundaryRefName(target.session, target.turn, exact.step, BOUNDARY_PHASE.START), source: 'step-start', step: exact.step }
    }
  }

  const stepLevel = snapshots
    .filter((entry) => Number.isFinite(entry.step) && entry.step >= 0)
    .sort((a, b) => a.step - b.step)
  if (stepLevel.length > 0) {
    const first = stepLevel[0]
    return { tree: first.tree, ref: boundaryRefName(target.session, target.turn, first.step, BOUNDARY_PHASE.START), source: 'step-start', step: first.step }
  }

  const turnLevel = snapshots.find((entry) => entry.step === TURN_LEVEL_STEP)
  if (turnLevel !== undefined) {
    return { tree: turnLevel.tree, ref: boundaryRefName(target.session, target.turn, TURN_LEVEL_STEP, BOUNDARY_PHASE.START), source: 'turn-start', step: TURN_LEVEL_STEP }
  }
  return null
}

/**
 * 算出"边界之后被归属的路径集合 P"（契约 §10.6 第 2 条）。
 *
 * "之后" = 同一会话中 `turn > 边界 turn`，或 `turn === 边界 turn && step >= 边界 step`。
 * 同时给出该路径**最后一次**归属快照的 `to` tree —— 参照校验只准用它（§10.6 第 4 条）。
 *
 * @param {object[]} entries
 * @param {{session:string, turn:number, step?:number}} boundary
 * @returns {{paths:Set<string>, lastTo:Map<string, string|null>, lastFrom:Map<string, string|null>,
 *   originalPath:Map<string, string>, records:number}}
 *   `paths`/`lastTo`/`originalPath` 的键均为 `canonicalPathKey(绝对路径)`；
 *   `originalPath` 保留该路径在账本里的**原始写法**（Windows 大小写别名归并不改变显示与操作口径）。
 */
export function collectAttributionPaths(entries, boundary) {
  const paths = new Set()
  const lastTo = new Map()
  const lastFrom = new Map()
  const originalPath = new Map()
  let records = 0
  const boundaryStep = Number.isFinite(boundary.step) ? boundary.step : -Infinity

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.kind !== BOUNDARY_KIND.ATTRIBUTION) continue
    if (entry.session !== boundary.session) continue
    if (!Number.isFinite(entry.turn)) continue
    if (entry.turn < boundary.turn) continue
    if (entry.turn === boundary.turn) {
      const step = Number.isFinite(entry.step) ? entry.step : -Infinity
      if (step < boundaryStep) continue
    }
    records += 1
    for (const raw of Array.isArray(entry.paths) ? entry.paths : []) {
      if (typeof raw !== 'string' || raw.length === 0) continue
      const key = canonicalPathKey(raw)
      paths.add(key)
      lastTo.set(key, typeof entry.to === 'string' ? entry.to : null)
      lastFrom.set(key, typeof entry.from === 'string' ? entry.from : null)
      originalPath.set(key, raw)
    }
  }

  return { paths, lastTo, lastFrom, originalPath, records }
}

/**
 * 产出边界回滚计划（契约 §10.6）。**只读**：不写账本、不动文件系统。
 *
 * 逐路径判定顺序（顺序即语义，不可调换）：
 *   1. 越出被审计根 → `skip`（reason: 越界）；
 *   2. 当前状态读不出来（目录/权限）→ `skip`（reason: 读取失败）——fail-closed；
 *   3. 一致性：当前 blob oid 必须等于"该路径在边界之后最后一次归属快照里的版本"，
 *      否则 `skip`（reason: 边界后被改动），只有 `force: true` 才继续；
 *   4. 边界 tree 中该路径存在 → `restore`（`from` = 边界处的 blob oid）；
 *   5. 边界 tree 中不存在且当前存在 → `trash`；当前也不存在 → `skip`（reason: 当前已不存在）。
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} options.root 被审计根
 * @param {string} options.session
 * @param {number} options.turn
 * @param {number} [options.step]
 * @param {boolean} [options.force] 允许覆盖"边界后被改动"的路径
 * @param {object[]} [options.entries] 账本条目（省略时自行读取）
 * @returns {Promise<object>} 计划对象（`ok:false` 时 `reason` 说明为何无从回滚）
 */
export async function planBoundaryRollback(options) {
  const { stateDir, session, turn } = options
  const root = canonicalRoot(options.root)
  const base = {
    session, turn, step: Number.isFinite(options.step) ? options.step : null,
    boundary: null, actions: [], counted: { restore: 0, trash: 0, skip: 0 }, attributed: 0,
  }

  let entries
  try {
    entries = Array.isArray(options.entries) ? options.entries : readAllEntries(stateDir)
  } catch (error) {
    return { ...base, ok: false, reason: BOUNDARY_REASON.LEDGER_UNREADABLE, detail: String(error && error.message ? error.message : error) }
  }

  const boundary = resolveBoundary(entries, { session, turn, step: options.step })
  if (boundary === null) return { ...base, ok: false, reason: BOUNDARY_REASON.BOUNDARY_MISSING }

  const collected = collectAttributionPaths(entries, { session, turn, step: boundary.step })
  const plan = {
    ...base,
    ok: true,
    reason: null,
    boundary: { tree: boundary.tree, ref: boundary.ref, source: boundary.source, step: boundary.step },
    attributed: collected.paths.size,
    actions: [],
  }

  const skip = (absPath, reason, from = null, treeFrom = null) => {
    plan.actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from, treeFrom, reason })
    plan.counted.skip += 1
  }

  // 按路径稳定排序，保证同一账本得到同一计划（可复核）。
  const keys = [...collected.paths].sort()
  for (const key of keys) {
    // 用账本里的原始写法（`originalPath`）展示与操作；归并键只用于去重与参照。
    const absPath = collected.originalPath.get(key) ?? key
    const rel = toRelPath(root, absPath)
    if (rel === null) { skip(absPath, '越出被审计根'); continue }

    const current = readCurrentFile(absPath)
    if (current.existed === null) { skip(absPath, `当前状态不可读（${current.error}）`); continue }

    const referenceTree = collected.lastTo.get(key) ?? boundary.tree
    const reference = await readTreeEntry({ stateDir, root, tree: referenceTree, relPath: rel })
    if (reference.ok !== true) { skip(absPath, `参照不可读（${reference.reason}）`); continue }

    const consistent = current.existed === reference.exists &&
      (current.existed === false || current.oid === reference.oid)
    if (!consistent && options.force !== true) {
      skip(absPath, '边界后被改动', reference.exists ? reference.oid : null, referenceTree)
      continue
    }

    const atBoundary = await readTreeEntry({ stateDir, root, tree: boundary.tree, relPath: rel })
    if (atBoundary.ok !== true) { skip(absPath, `边界快照不可读（${atBoundary.reason}）`); continue }

    if (atBoundary.exists && atBoundary.type === 'blob' && ['100644', '100755'].includes(atBoundary.mode)) {
      plan.actions.push({ path: absPath, action: PLAN_ACTION.RESTORE, from: atBoundary.oid, mode: atBoundary.mode, treeFrom: boundary.tree, reason: null,
        expectedCurrent: { existed: current.existed, oid: current.oid } })
      plan.counted.restore += 1
      continue
    }
    if (atBoundary.exists) {
      skip(absPath, `边界处不是普通文件（${atBoundary.type}/${atBoundary.mode}）`, null, boundary.tree)
      continue
    }

    if (current.existed === false) { skip(absPath, '当前已不存在', null, boundary.tree); continue }
    plan.actions.push({ path: absPath, action: PLAN_ACTION.TRASH, from: null, treeFrom: boundary.tree, reason: null,
      expectedCurrent: { existed: current.existed, oid: current.oid } })
    plan.counted.trash += 1
  }

  return plan
}

/**
 * 把计划渲染成中文可读文本（CLI dry-run 与 GUI 预览共用）。
 * @param {object} plan
 * @returns {string}
 */
export function renderBoundaryPlan(plan) {
  if (plan === null || typeof plan !== 'object') return ''
  const lines = []
  if (plan.ok !== true) {
    lines.push(`无法生成回滚计划：${plan.reason}${plan.detail ? `（${plan.detail}）` : ''}`)
    return lines.join('\n')
  }
  lines.push(`边界：turn ${plan.turn}${plan.step === null ? '' : ` step ${plan.step}`}（${plan.boundary.source}，tree ${plan.boundary.tree.slice(0, 12)}…）`)
  lines.push(`归属路径：${plan.attributed} 个；动作：恢复 ${plan.counted.restore}、移除 ${plan.counted.trash}、跳过 ${plan.counted.skip}`)
  for (const action of plan.actions) {
    const tail = action.reason ? ` —— ${action.reason}` : ''
    lines.push(`  [${action.action}] ${action.path}${tail}`)
  }
  return lines.join('\n')
}

/**
 * 从账本里还原被审计根（离线 CLI 未传 `--root` 时用）。
 *
 * 为什么必须存在：影子库路径是 `<stateDir>/shadow/<workspaceKey(root)>`，而 `workspaceKey` 是
 * root 的哈希——没有 root 就定位不到影子库。因此阶段 B 的 `snapshot` / `attribution` / `rollback`
 * 条目都带 `root` 字段；阶段 A 的旧条目没有该字段，此时只能要求调用方显式传 `--root`，
 * **返回 null 而不猜**。
 *
 * @param {object[]} entries
 * @param {{session?:string}} [filter]
 * @returns {string|null}
 */
export function resolveRootFromLedger(entries, filter = {}) {
  const list = Array.isArray(entries) ? entries : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i]
    if (!entry || typeof entry.root !== 'string' || entry.root.length === 0) continue
    // `null` 与 `undefined` 一律视为"不按会话过滤"：早期写成 `!== undefined`，
    // 于是 gc 传 null 时会把所有条目都跳过，导致"账本里明明有 root 却报没有"
    // （2026-10-11 全面复核实证）。
    if (filter.session != null && entry.session !== filter.session) continue
    return entry.root
  }
  return null
}
