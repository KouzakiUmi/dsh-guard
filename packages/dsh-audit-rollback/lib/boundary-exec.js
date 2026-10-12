/**
 * dsh-audit-rollback · 边界回滚执行（阶段 B / B3）
 *
 * 契约：docs/design-audit-rollback.md §10.6（恢复语义）、§10.7（CLI）、§3（trash 三条规则）。
 *
 * 职责边界（与 boundary.js 的分工不能混）：
 *   - `boundary.js` 只**产出计划**，不碰文件系统；
 *   - 本模块**执行计划**：先备份进 trash、确认成功、再恢复或移除，并写 `rollback` 条目。
 *
 * 复用与照抄：trash 的三条规则（保留盘符的卷标识、目标已存在绝不覆盖、先备份后改动）
 * 与"已搬走又失败必须搬回原位"的失败语义，全部沿用阶段 A `lib/ledger.js` 的既有实现与口径
 * （`newTrashDir` / `trashRelativePath` / `uniqueTrashPath` / `probeFile`），不另造一套。
 *
 * 与阶段 A `executePlan` 的唯一差别：恢复内容来自**影子库 tree 的 blob**，不是 CAS 对象。
 *
 * 三条不可违反的顺序约束：
 *   1. `restore` 的 blob 必须在**任何移动发生之前**取到（取不到就降级 skip，不许先搬空原文件）；
 *   2. 备份必须在改动之前完成；备份失败则该条降级 skip；
 *   3. `redo` 的参照来自 undo 执行后捕获的 `postTree`，缺失时不猜、直接拒绝。
 */

import { constants, copyFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appendEntry,
  newTrashDir,
  probeFile,
  readAllEntries,
  safeMkdir,
  trashRelativePath,
  uniqueTrashPath,
} from './ledger.js'
import { BOUNDARY_REF_PREFIX, canonicalRoot, captureTree, readBlob, readTreeEntry, toRelPath, writeBoundaryRef } from './snapshot.js'
import { BOUNDARY_KIND, PLAN_ACTION, gitBlobOid, planBoundaryRollback, readCurrentFile, sessionKeyOf } from './boundary.js'

/** 单次恢复允许读取的最大 blob（超过即 skip，不把超大对象拉进内存）。 */
export const DEFAULT_BLOB_MAX_BYTES = 64 * 1024 * 1024

/** 执行层失败原因。 */
export const EXEC_REASON = {
  BOUNDARY_MISSING: 'BOUNDARY_MISSING',
  NO_REDO_TARGET: 'NO_REDO_TARGET',
  REDO_REFERENCE_MISSING: 'REDO_REFERENCE_MISSING',
  PRE_TREE_UNAVAILABLE: 'PRE_TREE_UNAVAILABLE',
}

/**
 * 执行一批动作（内部共用）：先备份、后改动；单条失败不中断整体。
 *
 * @param {object} ctx
 * @param {string} ctx.stateDir
 * @param {string} ctx.root
 * @param {object[]} ctx.actions `restore`（`from` 为影子库 blob oid）/ `trash` / `skip`
 * @param {number} [ctx.blobMaxBytes]
 * @returns {Promise<{actions:object[], changed:number}>}
 */
async function runActions(ctx) {
  const { stateDir, root, actions } = ctx
  const blobMaxBytes = Number.isFinite(ctx.blobMaxBytes) ? ctx.blobMaxBytes : DEFAULT_BLOB_MAX_BYTES
  const trashDir = newTrashDir(stateDir)
  let changed = 0

  for (const action of actions) {
    if (action.action === PLAN_ACTION.SKIP) continue
    let movedTo = null // 原路径已被搬去的 trash 位置（失败后要搬回）
    try {
      // 1) 对象预检：必须在任何移动之前（契约 §10.6 第 4 条）
      let buffer = null
      if (action.action === PLAN_ACTION.RESTORE) {
        const blob = await readBlob({ stateDir, root, oid: action.from, maxBytes: blobMaxBytes, gitPath: ctx.gitPath, timeoutMs: ctx.timeoutMs })
        if (blob.ok !== true || blob.buffer === null) {
          action.action = PLAN_ACTION.SKIP
          action.reason = blob.oversized === true ? `快照对象超限（${blob.bytes} 字节）` : '快照对象缺失'
          continue
        }
        buffer = blob.buffer
      }

      // 2) 读取当前状态；"读不出来"不等于"不存在"
      const probe = probeFile(action.path, blobMaxBytes)
      if (probe.existed === null) {
        throw probe.error instanceof Error ? probe.error : new Error(String(probe.error))
      }
      if (probe.oversized === true) throw new Error('CURRENT_FILE_TOO_LARGE')
      // 计划到执行之间有多次 await（preTree、对象读取）；这期间的新改动也必须保护。
      if (action.expectedCurrent && (probe.existed !== action.expectedCurrent.existed ||
          (probe.existed && gitBlobOid(probe.buffer) !== action.expectedCurrent.oid))) {
        throw new Error('CURRENT_STATE_CHANGED_AFTER_PLAN')
      }

      // 3) 先备份（卷标识保留盘符；目标已存在绝不覆盖）
      if (probe.existed) {
        const trashFile = uniqueTrashPath(join(trashDir, trashRelativePath(action.path)))
        safeMkdir(dirname(trashFile))
        try {
          renameSync(action.path, trashFile)
        } catch {
          copyFileSync(action.path, trashFile, constants.COPYFILE_EXCL)
          unlinkSync(action.path)
        }
        movedTo = trashFile
        action.backup = trashFile
      }

      // 4) 后改动
      if (action.action === PLAN_ACTION.RESTORE) {
        safeMkdir(dirname(action.path))
        // Git tree 只记录可执行位，不记录完整权限；不把原本私有的文件放宽为 world-readable。
        const baseMode = probe.existed ? (probe.identity.mode & 0o777) : 0o600
        const mode = action.mode === '100755' ? (baseMode | 0o100) : (baseMode & ~0o111)
        writeFileSync(action.path, buffer, { flag: 'wx', mode })
        movedTo = null // 恢复成功，备份正常留在 trash
        changed += 1
      } else if (action.action === PLAN_ACTION.TRASH) {
        // 文件已在上一步移入 trash，无需再动
        changed += 1
      }
    } catch (error) {
      action.action = PLAN_ACTION.SKIP
      let reason = `执行失败：${error && error.message ? error.message : String(error)}`
      if (movedTo !== null) {
        reason += '；原路径已移入 trash'
        try {
          // 排他恢复失败可能是因为已有并发创建的新文件，不能再用搬回覆盖它。
          if (probeFile(action.path).existed !== false) throw new Error('恢复目标已存在或不可读')
          try {
            renameSync(movedTo, action.path)
            action.backup = null
            reason += '，已搬回原位'
          } catch {
            copyFileSync(movedTo, action.path, constants.COPYFILE_EXCL)
            reason += '，已复制回原位（备份仍留 trash）'
          }
        } catch (backError) {
          reason += `，搬回失败，备份在 ${movedTo}（${backError && backError.message ? backError.message : backError}）`
        }
      }
      action.reason = reason
    }
  }

  return { actions, changed }
}

/** 从计划里取实际会改动文件的路径集合（skip 不算）。 */
function changedPathsOf(actions) {
  const set = new Set()
  for (const action of actions) {
    if (action.action === PLAN_ACTION.SKIP) continue
    set.add(action.path)
  }
  return set
}

/**
 * 给回滚参照树（`preTree` / `postTree`）写一条 ref，使对象**可达**、不被 git gc 剪掉。
 *
 * 为什么必须做：这两个 tree 原先只作为裸 oid 记在账本里，其可达性依赖 git 的 cruft pack
 * （`gc.cruftPacks`，≥2.x 默认开启）。仓库一旦关闭它或手工 prune，`redo` 就会失效。
 *
 * 参考实现的取舍也支持这个方向：
 * - **Roo Code**：checkpoint 就是 shadow 仓库里的 **git commit**（官方文档明写 "stored as Git commits"），
 *   恢复时 hard reset 到该 commit；
 * - **Cline**：独立 shadow 仓库 + 每次工具调用后 commit（代价是有人遇到 262 GB 的 pack —— 提醒我们
 *   对象体积必须可见、可清理，本包的 `shadowStats` 与 `gc --keep-days` 正是为此）；
 * - **OpenCode**：裸 tree + 后台 `git gc --prune=7.days`，其 issue #36093 自述"这是基于年龄的清理，
 *   不是从持久会话状态可达性出发"——正是本函数要避开的形态。
 *
 * ref 名带时间戳，`gc --keep-days` 会连同其它 `refs/dsh/*` 一起清理。
 * @returns {Promise<string|null>} 写入成功时返回 ref 名，否则 null（降级不阻断回滚本身）
 */
async function keepTreeRef(ctx, kind, tree) {
  if (typeof tree !== 'string' || tree.length === 0) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '')
  const ref = `${BOUNDARY_REF_PREFIX}/${sessionKeyOf(ctx.session)}/rb-${stamp}-${kind}`
  const written = await writeBoundaryRef({
    stateDir: ctx.stateDir,
    root: ctx.root,
    ref,
    tree,
    message: `dsh rollback keep ${kind} turn ${ctx.turn}`,
    gitPath: ctx.gitPath,
    timeoutMs: ctx.timeoutMs,
  })
  return written.ok === true ? ref : null
}

/** 写一条边界回滚账本条目（契约 §10.5 的 rollback 扩展字段）。 */
function recordBoundaryRollback(stateDir, payload) {
  try {
    appendEntry(stateDir, {
      kind: 'rollback',
      session: payload.session,
      turn: payload.turn,
      step: payload.step ?? null,
      root: payload.root,
      applied: payload.applied,
      source: 'snapshot',
      boundary: payload.boundary ?? null,
      preTree: payload.preTree ?? null,
      postTree: payload.postTree ?? null,
      ...(payload.redoOf === undefined ? {} : { redoOf: payload.redoOf }),
      actions: payload.actions.map((a) => {
        const item = { path: a.path, action: a.action, from: a.from ?? null }
        if (a.treeFrom !== undefined) item.treeFrom = a.treeFrom ?? null
        if (a.mode !== undefined) item.mode = a.mode
        if (a.backup !== undefined) item.backup = a.backup
        if (a.reason !== undefined) item.reason = a.reason
        return item
      }),
    })
    return true
  } catch {
    return false
  }
}

/**
 * 执行边界回滚（`undo-to`）。
 *
 * dry-run（`apply: false`）**不触碰任何目标文件**，但仍按阶段 A 的口径写一条 `applied:false`
 * 的 rollback 条目（审计可追溯）。
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} options.root 被审计根
 * @param {string} options.session
 * @param {number} options.turn
 * @param {number} [options.step]
 * @param {boolean} [options.apply] 默认 false
 * @param {boolean} [options.force] 允许覆盖"边界后被改动"的路径
 * @returns {Promise<object>}
 */
export async function executeBoundaryRollback(options) {
  const root = canonicalRoot(options.root)
  const plan = await planBoundaryRollback({ ...options, root })
  const base = {
    ok: plan.ok === true,
    reason: plan.reason ?? null,
    session: options.session,
    turn: options.turn,
    step: Number.isFinite(options.step) ? options.step : null,
    boundary: plan.boundary ?? null,
    actions: plan.actions,
    counted: plan.counted,
    applied: false,
    preTree: null,
    postTree: null,
  }
  if (plan.ok !== true) return base

  const apply = options.apply === true
  let preTree = null
  let postTree = null
  let preTreeRef = null
  let postTreeRef = null
  let actions = plan.actions
  let changed = 0

  if (apply) {
    // undo 之前的完整工作树（redo 的目标）。**捕获失败默认拒绝执行**：
    // 改了文件却永久不可 redo，违背本插件"可回滚"的核心承诺。
    // （2026-10-11 独立复核实证：早期实现在 preTree 缺失时仍照常回滚，事后 redo 只会得到
    //  `REDO_REFERENCE_MISSING`／退出码 5。要知情地跳过 redo 能力，调用方须显式传
    //  `allowWithoutRedo: true`，CLI 对应 `--no-redo`。）
    const before = await captureTree({ ...options, root })
    preTree = before.ok === true ? before.tree : null
    // 先给参照树写 ref：对象因此可达，redo 不再依赖 git 的 cruft pack 保留策略。
    preTreeRef = preTree === null ? null : await keepTreeRef({ ...options, root, session: options.session, turn: options.turn }, 'pre', preTree)
    if (preTree === null && options.allowWithoutRedo !== true) {
      return {
        ...base,
        ok: false,
        reason: EXEC_REASON.PRE_TREE_UNAVAILABLE,
        applied: false,
        actions: plan.actions,
        counted: plan.counted,
        preTree: null,
        postTree: null,
      }
    }

    const ran = await runActions({ ...options, root, actions })
    actions = ran.actions
    changed = ran.changed

    // undo 之后的工作树（redo 的参照）：apply 时就捕获。
    // 早期实现只在 changed > 0 时捕获，导致"改动全被 skip 的回滚"永远不可 redo；
    // 参照确实拿不到时应由 redo 侧 fail-closed，而不是在写入侧留空洞。
    {
      const after = await captureTree({ ...options, root })
      postTree = after.ok === true ? after.tree : null
      postTreeRef = postTree === null ? null : await keepTreeRef({ ...options, root, session: options.session, turn: options.turn }, 'post', postTree)
    }
  }

  const ledgerOk = recordBoundaryRollback(options.stateDir, {
    session: options.session,
    turn: options.turn,
    step: Number.isFinite(options.step) ? options.step : null,
    root,
    applied: apply,
    boundary: plan.boundary.tree,
    preTree,
    postTree,
    actions,
  })

  const counted = { restore: 0, trash: 0, skip: 0 }
  for (const action of actions) {
    if (action.action === PLAN_ACTION.RESTORE) counted.restore += 1
    else if (action.action === PLAN_ACTION.TRASH) counted.trash += 1
    else counted.skip += 1
  }

  return { ...base, ok: true, applied: apply, preTree, postTree, preTreeRef, postTreeRef, actions, counted, changed, ledgerOk }
}

/**
 * 撤销一次已执行的边界回滚（`redo`）。
 *
 * 语义（契约 §10.6 第 5 条）：把上次 undo 实际改动过的路径恢复到 `preTree`。
 * 参照是 `postTree`（undo 之后的状态）：当前状态与它不一致时默认 `skip`，只有 `--force` 才覆盖。
 * 取不到 `preTree`/`postTree` 时**拒绝执行**：宁可不动，也不猜。
 *
 * @returns {Promise<object>}
 */
export async function redoBoundaryRollback(options) {
  const root = canonicalRoot(options.root)
  const entries = Array.isArray(options.entries) ? options.entries : readAllEntries(options.stateDir)

  let target = null
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!entry || entry.kind !== 'rollback') continue
    if (entry.session !== options.session || entry.turn !== options.turn) continue
    if (options.step !== undefined && entry.step !== options.step) continue
    if (entry.applied !== true) continue
    if (entry.source !== 'snapshot') continue
    target = entry
    break
  }
  if (target === null) {
    return { ok: false, reason: EXEC_REASON.NO_REDO_TARGET, actions: [], applied: false, actionsCount: 0 }
  }
  if (typeof target.preTree !== 'string' || typeof target.postTree !== 'string') {
    return { ok: false, reason: EXEC_REASON.REDO_REFERENCE_MISSING, actions: [], applied: false, redoOf: target.ts ?? null }
  }

  // 取**全部**动作路径（含上次被 skip 的）：漏掉它们会让这些路径从 redo 链条永久脱落。
  // （2026-10-11 复核实证：undo → 手改 a.txt → redo（a.txt 因不一致被 skip）→ 再 redo 时
  //  a.txt 已不在 paths 里，于是永久停在手改后的内容。）
  const paths = [...new Set((target.actions ?? [])
    .filter((action) => action && typeof action.path === 'string')
    .map((action) => action.path))].sort()

  const actions = []
  for (const absPath of paths) {
    const rel = toRelPath(root, absPath)
    if (rel === null) {
      actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from: null, treeFrom: target.preTree, reason: '越出被审计根' })
      continue
    }
    // 参照：undo 之后该路径的版本（postTree）
    const reference = await readTreeEntry({ stateDir: options.stateDir, root, tree: target.postTree, relPath: rel })
    const current = readCurrentFile(absPath)
    if (current.existed === null || reference.ok !== true) {
      actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from: null, treeFrom: target.preTree,
        reason: current.existed === null ? `当前状态不可读（${current.error}）` : `参照不可读（${reference.reason}）` })
      continue
    }
    const consistent = current.existed === reference.exists && (current.existed === false || current.oid === reference.oid)
    if (!consistent && options.force !== true) {
      actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from: null, treeFrom: target.preTree, reason: '回滚后被改动' })
      continue
    }
    const atPre = await readTreeEntry({ stateDir: options.stateDir, root, tree: target.preTree, relPath: rel })
    if (atPre.ok !== true) {
      actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from: null, treeFrom: target.preTree, reason: `目标快照不可读（${atPre.reason}）` })
      continue
    }
    if (atPre.exists && atPre.type === 'blob' && ['100644', '100755'].includes(atPre.mode)) {
      if (current.existed && current.oid === atPre.oid && current.mode === atPre.mode) {
        actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from: atPre.oid, treeFrom: target.preTree, reason: '当前已等于 redo 目标，无需改写' })
        continue
      }
      actions.push({ path: absPath, action: PLAN_ACTION.RESTORE, from: atPre.oid, mode: atPre.mode, treeFrom: target.preTree, reason: null,
        expectedCurrent: { existed: current.existed, oid: current.oid } })
    } else if (atPre.exists) {
      actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from: null, treeFrom: target.preTree, reason: `目标处不是普通文件（${atPre.type}）` })
    } else if (current.existed === false) {
      actions.push({ path: absPath, action: PLAN_ACTION.SKIP, from: null, treeFrom: target.preTree, reason: '当前已不存在' })
    } else {
      actions.push({ path: absPath, action: PLAN_ACTION.TRASH, from: null, treeFrom: target.preTree, reason: null,
        expectedCurrent: { existed: current.existed, oid: current.oid } })
    }
  }

  const apply = options.apply === true
  let ran = { actions, changed: 0 }
  let postTree = null
  let postTreeRef = null
  if (apply && actions.some((action) => action.action !== PLAN_ACTION.SKIP)) {
    ran = await runActions({ ...options, root, actions })
  }
  if (apply) {
    // 即使本次全部 skip（changed === 0）也必须记录 postTree：它是"下一次 redo"的参照，
    // 缺了它 redo 链条就会断在 REDO_REFERENCE_MISSING。
    // （2026-10-11 回归测试暴露：undo → 手改 → redo（a.txt 被 skip）→ 再 redo 直接拒绝。）
    const after = await captureTree({ ...options, root })
    postTree = after.ok === true ? after.tree : null
    postTreeRef = postTree === null ? null : await keepTreeRef({ ...options, root, session: options.session, turn: options.turn }, 'post', postTree)
  }

  const counted = { restore: 0, trash: 0, skip: 0 }
  for (const action of ran.actions) {
    if (action.action === PLAN_ACTION.RESTORE) counted.restore += 1
    else if (action.action === PLAN_ACTION.TRASH) counted.trash += 1
    else counted.skip += 1
  }

  const ledgerOk = apply
    ? recordBoundaryRollback(options.stateDir, {
      session: options.session,
      turn: options.turn,
      step: Number.isFinite(options.step) ? options.step : null,
      root,
      applied: true,
      boundary: target.preTree,
      preTree: target.postTree,
      postTree,
      redoOf: target.ts ?? null,
      actions: ran.actions,
    })
    : false

  return {
    ok: true,
    reason: null,
    session: options.session,
    turn: options.turn,
    applied: apply,
    redoOf: target.ts ?? null,
    boundary: { tree: target.preTree, ref: null, source: 'redo', step: target.step ?? null },
    actions: ran.actions,
    counted,
    changed: ran.changed,
    postTree,
    postTreeRef,
    ledgerOk,
  }
}

/** 供 CLI 渲染：把执行结果转成中文文本。 */
export function renderExecuteResult(result) {
  const lines = []
  if (result.ok !== true) {
    lines.push(`无法执行：${result.reason}`)
    return lines.join('\n')
  }
  const scope = result.step === null || result.step === undefined ? `turn ${result.turn}` : `turn ${result.turn} step ${result.step}`
  lines.push(`${scope} 边界回滚${result.applied ? '（已执行）' : '（dry-run，未触碰文件；加 --apply 才真正执行）'}`)
  if (result.boundary && result.boundary.tree) lines.push(`  边界 tree：${String(result.boundary.tree).slice(0, 12)}…`)
  if (result.preTree) lines.push(`  执行前快照(preTree)：${result.preTree.slice(0, 12)}…（redo 用）`)
  for (const action of result.actions ?? []) {
    const from = action.from ? ` from=${String(action.from).slice(0, 12)}…` : ''
    const reason = action.reason ? ` —— ${action.reason}` : ''
    lines.push(`  ${String(action.action).padEnd(7)} ${action.path}${from}${reason}`)
    if (action.backup) lines.push(`          备份：${action.backup}`)
  }
  const counted = result.counted ?? { restore: 0, trash: 0, skip: 0 }
  lines.push(`合计：恢复 ${counted.restore}、移除 ${counted.trash}、跳过 ${counted.skip}`)
  if (result.applied === true && result.ledgerOk === false) {
    lines.push('警告：账本条目写入失败——文件已改动但审计未落账，请立即检查状态目录可写性')
  }
  return lines.join('\n')
}
