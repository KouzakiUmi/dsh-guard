#!/usr/bin/env node
/**
 * audit-rollback —— dsh-audit-rollback 的独立 CLI。
 *
 * 纯 node:* 实现，可被 `node <path>` 直接运行。子命令与退出码逐字遵守
 * docs/design-audit-rollback.md 第 7 节：
 *
 *   audit-rollback list     [--state <dir>] [--session <sid>] [--turn <n>] [--limit N] [--json]
 *   audit-rollback sessions [--state <dir>] [--json]
 *   audit-rollback show     <sessionId> <turn> [--state <dir>] [--json]
 *   audit-rollback undo     <sessionId> <turn> [--state <dir>] [--apply] [--force]
 *   audit-rollback last     [--state <dir>] [--apply] [--force] [--json]
 *
 * 阶段 B 追加（契约 §10.7）——边界快照口径，不是 CAS 口径：
 *   audit-rollback snapshot list [--state <dir>] [--session <sid>] [--turn <n>] [--json]
 *   audit-rollback snapshot show <sessionId> <turn> [--step <n>] [--state <dir>] [--json]
 *   audit-rollback diff         <sessionId> <turn> [--step <n>] [--path <p>] [--state <dir>] [--json]
 *   audit-rollback undo-to      <sessionId> <turn> [--step <n>] [--root <dir>] [--state <dir>] [--apply] [--force] [--json]
 *   audit-rollback redo         <sessionId> <turn> [--root <dir>] [--state <dir>] [--apply] [--json]
 *   audit-rollback gc           [--root <dir>] [--state <dir>] [--keep-days N] [--apply] [--json]
 *
 * 退出码：0 全部完成；1 参数错误或状态不可读；2 有文件被 skip（部分完成）；
 * 3 该轮没有可回滚的捕获（或没有任何归属路径）；4 边界快照不可用（阶段 B 追加）；
 * 5 没有可 redo 的回滚记录或参照缺失（阶段 B 追加）。
 *
 * dry-run（默认）不触碰任何目标文件，只打印将执行的动作；
 * 但按契约第 7 节仍会往账本追加一条 rollback 计划条目（applied:false）。
 */

import { join, resolve } from 'node:path'

import {
  findLastCapturedTurn,
  executePlan,
  isStateDirReadable,
  matchesReference,
  planRollback,
  probeFile,
  readAllEntries,
  recordRollback,
  resolveStateDir,
  sha1Hex,
  turnReferences,
} from '../lib/ledger.js'
import {
  BOUNDARY_KIND,
  collectAttributionPaths,
  resolveBoundary,
  resolveRootFromLedger,
} from '../lib/boundary.js'
import { executeBoundaryRollback, redoBoundaryRollback, renderExecuteResult } from '../lib/boundary-exec.js'
import { diffTrees, gcShadow, listBoundaryRefs, shadowStats } from '../lib/snapshot.js'

/** 打印用法（参数错误时走退出码 1）。 */
function usage() {
  console.error(`用法：
  audit-rollback list     [--state <dir>] [--session <sid>] [--turn <n>] [--limit N] [--json]
  audit-rollback sessions [--state <dir>] [--json]
  audit-rollback show     <sessionId> <turn> [--state <dir>] [--json]
  audit-rollback undo     <sessionId> <turn> [--state <dir>] [--apply] [--force]
  audit-rollback last     [--state <dir>] [--apply] [--force] [--json]

阶段 B（边界快照口径；需要账本里有 snapshot/attribution 条目）：
  audit-rollback snapshot list [--state <dir>] [--session <sid>] [--turn <n>] [--json]
  audit-rollback snapshot show <sessionId> <turn> [--step <n>] [--state <dir>] [--json]
  audit-rollback diff         <sessionId> <turn> [--step <n>] [--path <p>] [--state <dir>] [--json]
  audit-rollback undo-to      <sessionId> <turn> [--step <n>] [--root <dir>] [--state <dir>] [--apply] [--force] [--json]
  audit-rollback redo         <sessionId> <turn> [--root <dir>] [--state <dir>] [--apply] [--json]
  audit-rollback gc           [--root <dir>] [--state <dir>] [--keep-days N] [--apply] [--json]`)
}

/**
 * 极简参数解析：位置参数进 positional，`--key value` 与 `--flag` 进 options。
 * 不引第三方依赖；未知选项直接报错（退出码 1）。
 */
function parseArgv(argv, knownFlags, knownValues) {
  const options = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (knownFlags.includes(key)) {
        options[key] = true
      } else if (knownValues.includes(key)) {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`选项 --${key} 缺少取值`)
        }
        options[key] = value
        i += 1
      } else {
        throw new Error(`未知选项 --${key}`)
      }
    } else {
      positional.push(arg)
    }
  }
  return { options, positional }
}

/** 解析 stateDir 并校验可读性；不可读返回 null（调用方走退出码 1）。 */
function openState(options) {
  const stateDir = options.state !== undefined ? resolveStateDir({ stateDir: options.state }) : resolveStateDir({})
  return isStateDirReadable(stateDir) ? stateDir : null
}

/** 把 turn 选项/位置参数解析为整数；非法返回 null。 */
function parseTurn(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null
  return Number.parseInt(value, 10)
}

/** 单条目的紧凑中文行（list 默认输出）。 */
function formatEntry(entry) {
  const ts = typeof entry.ts === 'string' ? entry.ts : '????-??-??T??:??:??'
  switch (entry.kind) {
    case 'turn/start':
      return `${ts}  turn/start   会话=${entry.session} 轮=${entry.turn} cwd=${entry.cwd}`
    case 'call':
      return `${ts}  call         会话=${entry.session} 轮=${entry.turn} 工具=${entry.tool} 目标=${(entry.targets ?? []).join(',') || '(未识别)'}`
    case 'capture':
      return `${ts}  capture      会话=${entry.session} 轮=${entry.turn} ${entry.phase} ${entry.path} hash=${entry.hash ?? 'null'} 字节=${entry.bytes} 原存在=${entry.existed}`
    case 'turn/end':
      return `${ts}  turn/end     会话=${entry.session} 轮=${entry.turn} 捕获路径数=${entry.captured}`
    case 'rollback':
      return `${ts}  rollback     会话=${entry.session} 轮=${entry.turn} 已执行=${entry.applied} 动作数=${(entry.actions ?? []).length}`
    case 'note':
      return `${ts}  note         ${entry.text}`
    case 'corrupt':
      return `${ts}  (损坏行)     ${entry.lineError}`
    default:
      return `${ts}  ${entry.kind}`
  }
}

/** list：按时间正序列出条目（默认 --limit 50，取最近 N 条再按正序打印）。 */
function cmdList(options) {
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  let entries = readAllEntries(stateDir)
  if (options.session !== undefined) entries = entries.filter((e) => e.session === options.session)
  if (options.turn !== undefined) {
    const turn = parseTurn(options.turn)
    if (turn === null) {
      console.error('错误：--turn 必须是整数')
      return 1
    }
    entries = entries.filter((e) => e.turn === turn)
  }
  let limit = 50
  if (options.limit !== undefined) {
    limit = parseTurn(options.limit)
    if (limit === null || limit <= 0) {
      console.error('错误：--limit 必须是正整数')
      return 1
    }
  }
  const shown = entries.slice(-limit)
  if (options.json === true) {
    console.log(JSON.stringify(shown, null, 2))
  } else {
    if (shown.length === 0) console.log('（没有匹配的账本条目）')
    for (const entry of shown) console.log(formatEntry(entry))
    console.log(`共 ${entries.length} 条匹配，显示最近 ${shown.length} 条（--limit 可调）`)
  }
  return 0
}

/** sessions：列出出现过的 sessionId 及其轮次范围与捕获文件数。 */
function cmdSessions(options) {
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const entries = readAllEntries(stateDir)
  const bySession = new Map()
  for (const entry of entries) {
    if (typeof entry.session !== 'string' || entry.kind === 'note' || entry.kind === 'corrupt') continue
    let agg = bySession.get(entry.session)
    if (agg === undefined) {
      agg = { session: entry.session, turnMin: null, turnMax: null, captures: 0, files: new Set() }
      bySession.set(entry.session, agg)
    }
    if (typeof entry.turn === 'number' && entry.turn >= 0) {
      agg.turnMin = agg.turnMin === null ? entry.turn : Math.min(agg.turnMin, entry.turn)
      agg.turnMax = agg.turnMax === null ? entry.turn : Math.max(agg.turnMax, entry.turn)
    }
    if (entry.kind === 'capture') {
      agg.captures += 1
      agg.files.add(entry.path)
    }
  }
  const rows = [...bySession.values()].map((agg) => ({
    session: agg.session,
    turnMin: agg.turnMin,
    turnMax: agg.turnMax,
    captures: agg.captures,
    files: agg.files.size,
  }))
  if (options.json === true) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    if (rows.length === 0) console.log('（账本里还没有任何会话）')
    for (const row of rows) {
      console.log(
        `会话=${row.session} 轮次范围=${row.turnMin ?? '-'}~${row.turnMax ?? '-'} ` +
          `捕获条目=${row.captures} 捕获文件数=${row.files}`,
      )
    }
    console.log(`共 ${rows.length} 个会话`)
  }
  return 0
}

/** show：打印该轮全部 capture 条目与当前文件状态。 */
function cmdShow(options, positional) {
  if (positional.length < 2) {
    console.error('错误：show 需要 <sessionId> <turn> 两个参数')
    return 1
  }
  const [sessionId, turnRaw] = positional
  const turn = parseTurn(turnRaw)
  if (turn === null) {
    console.error('错误：<turn> 必须是整数')
    return 1
  }
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const entries = readAllEntries(stateDir)
  const captures = entries.filter(
    (e) => e.kind === 'capture' && e.session === sessionId && e.turn === turn,
  )
  if (captures.length === 0) {
    console.error(`会话 ${sessionId} 第 ${turn} 轮没有任何 capture 条目`)
    return 3
  }
  // 每路径参照 = 该轮 after（无 then before），与 undo 完全同口径（契约第 7 节，
  // F2 修正：共用 turnReferences/matchesReference，两处结论不得互相矛盾）
  const refs = turnReferences(entries, sessionId, turn)
  const status = [...refs.entries()].map(([path, info]) => {
    const { ref, laterCapture } = info
    const probe = probeFile(path)
    let verdict
    if (probe.existed === null) {
      verdict = `读取失败（${probe.error && probe.error.code ? probe.error.code : '未知错误'}），按不一致处理`
    } else if (!probe.existed) {
      verdict = ref.existed ? '文件已消失（与账本不一致）' : '文件不存在（与账本一致）'
    } else if (ref.hash === null) {
      verdict = probe.bytes === ref.bytes ? `字节数一致（${probe.bytes}，参照无哈希）` : `字节数不一致（当前 ${probe.bytes} / 账本 ${ref.bytes}，参照无哈希）`
    } else {
      const current = sha1Hex(probe.buffer)
      verdict = current === ref.hash ? `哈希一致（${current}）` : `哈希不一致（当前 ${current} / 账本 ${ref.hash}）`
    }
    const consistent = matchesReference(probe, ref)
    if (laterCapture) {
      verdict += '；该路径在后续轮次另有捕获，undo 将视为不一致'
    } else if (consistent) {
      verdict += '；undo 可直接回滚'
    }
    return { path, phase: ref.phase, existed: probe.existed, verdict }
  })
  if (options.json === true) {
    console.log(JSON.stringify({ session: sessionId, turn, captures, status }, null, 2))
  } else {
    console.log(`会话 ${sessionId} 第 ${turn} 轮，共 ${captures.length} 条 capture：`)
    for (const entry of captures) console.log('  ' + formatEntry(entry))
    console.log('当前文件状态：')
    for (const item of status) console.log(`  ${item.path} [参照 ${item.phase}] ${item.verdict}`)
  }
  return 0
}

/** undo/last 共用：计划 →（可选）执行 → 记账 → 退出码。 */
function runRollback(stateDir, sessionId, turn, options) {
  const plan = planRollback(stateDir, sessionId, turn, { force: options.force === true })
  if (plan.actions.length === 0) {
    console.error(`会话 ${sessionId} 第 ${turn} 轮没有可回滚的捕获`)
    return 3
  }
  const apply = options.apply === true
  const actions = apply ? executePlan(stateDir, plan.actions) : plan.actions

  // 契约第 7 节：无论是否 --apply 都写 rollback 条目（applied 反映是否真执行）；
  // dry-run 只追加账本，不触碰目标文件。
  recordRollback(stateDir, sessionId, turn, apply, actions)

  const skipCount = actions.filter((a) => a.action === 'skip').length
  if (options.json === true) {
    console.log(JSON.stringify({ session: sessionId, turn, applied: apply, actions }, null, 2))
  } else {
    console.log(
      `会话 ${sessionId} 第 ${turn} 轮回滚${apply ? '（已执行）' : '（dry-run，未触碰文件；加 --apply 才真正执行）'}：`,
    )
    for (const action of actions) {
      const reason = action.reason !== undefined ? ` 原因：${action.reason}` : ''
      const from = action.from !== null && action.from !== undefined ? ` from=${action.from}` : ''
      console.log(`  ${action.action.padEnd(7)} ${action.path}${from}${reason}`)
    }
    console.log(`合计 ${actions.length} 条动作，其中 skip ${skipCount} 条`)
    if (options.force === true) console.log('（--force 已打开：轮后改动照常被覆盖，原内容已进回收站）')
  }
  return skipCount > 0 ? 2 : 0
}

/** undo <sessionId> <turn> [--apply] [--force] */
function cmdUndo(options, positional) {
  if (positional.length < 2) {
    console.error('错误：undo 需要 <sessionId> <turn> 两个参数')
    return 1
  }
  const [sessionId, turnRaw] = positional
  const turn = parseTurn(turnRaw)
  if (turn === null) {
    console.error('错误：<turn> 必须是整数')
    return 1
  }
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  return runRollback(stateDir, sessionId, turn, options)
}

/** last [--apply] [--force]：回滚最近一次有可回滚捕获的轮次。 */
function cmdLast(options) {
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const found = findLastCapturedTurn(stateDir)
  if (found === null) {
    console.error('账本里没有任何可回滚的捕获')
    return 3
  }
  return runRollback(stateDir, found.session, found.turn, options)
}

// ---------------------------------------------------------------------------
// 阶段 B：边界快照口径（契约 §10.6 / §10.7）
//
// 与上面 CAS 口径命令的分工必须写清（README 同步）：
//   - undo/last：走阶段 A 的 CAS 前像，精确但只覆盖"文件工具点名的路径"；
//   - undo-to/redo：走影子库边界 tree，覆盖工作区一切来源（含 shell 改动），
//     但要求账本里有该轮的 snapshot/attribution 条目（插件接线后才自动产生）。
// 两套命令的既有语义互不覆盖：本段只**追加**，不改上面任何一条的行为。
// ---------------------------------------------------------------------------

/**
 * 解析被审计根：优先 `--root`，其次账本里的 `root` 字段。
 * 拿不到时返回 null（调用方要求显式 --root，**不猜**——影子库路径由 root 的哈希决定）。
 */
function resolveBoundaryRoot(options, entries, sessionId) {
  if (options.root !== undefined) return resolve(options.root)
  return resolveRootFromLedger(entries, { session: sessionId })
}

/** snapshot list：列出账本里的边界快照条目。 */
function cmdSnapshotList(options) {
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  let entries = readAllEntries(stateDir).filter((e) => e.kind === BOUNDARY_KIND.SNAPSHOT)
  if (options.session !== undefined) entries = entries.filter((e) => e.session === options.session)
  if (options.turn !== undefined) {
    const turn = parseTurn(options.turn)
    if (turn === null) {
      console.error('错误：--turn 必须是整数')
      return 1
    }
    entries = entries.filter((e) => e.turn === turn)
  }
  const rows = entries.map((e) => ({
    ts: e.ts, session: e.session, turn: e.turn, step: e.step, phase: e.phase,
    tree: e.tree ?? null, files: e.files ?? 0, ms: e.ms ?? 0,
    degraded: e.degraded === true, reason: e.reason ?? null, root: e.root ?? null,
  }))
  if (options.json === true) {
    console.log(JSON.stringify(rows, null, 2))
    return 0
  }
  if (rows.length === 0) {
    console.log('（账本里还没有边界快照：阶段 B 需要插件接线后自动产生，或用 lib/boundary.js 手工写入）')
    return 0
  }
  for (const row of rows) {
    const tree = row.tree === null ? 'null' : `${String(row.tree).slice(0, 12)}…`
    const degraded = row.degraded ? ` 降级=${row.reason ?? '未知'}` : ''
    console.log(`${row.ts}  会话=${row.session} 轮=${row.turn} 步=${row.step} ${row.phase} tree=${tree} 文件=${row.files} 用时=${row.ms}ms${degraded}`)
  }
  console.log(`共 ${rows.length} 条边界快照（账本口径；快照对象在 <stateDir>/shadow 下）`)
  return 0
}

/** snapshot show：显示某轮/某步的边界快照与归属路径集合。 */
function cmdSnapshotShow(options, positional) {
  if (positional.length < 2) {
    console.error('错误：snapshot show 需要 <sessionId> <turn> 两个参数')
    return 1
  }
  const [sessionId, turnRaw] = positional
  const turn = parseTurn(turnRaw)
  if (turn === null) {
    console.error('错误：<turn> 必须是整数')
    return 1
  }
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const step = options.step !== undefined ? parseTurn(options.step) : undefined
  if (options.step !== undefined && step === null) {
    console.error('错误：--step 必须是整数')
    return 1
  }
  const entries = readAllEntries(stateDir)
  const snapshots = entries.filter((e) => e.kind === BOUNDARY_KIND.SNAPSHOT && e.session === sessionId && e.turn === turn)
  if (snapshots.length === 0) {
    console.error(`会话 ${sessionId} 第 ${turn} 轮没有边界快照（阶段 B 口径不可用）`)
    return 4
  }
  const boundary = resolveBoundary(entries, { session: sessionId, turn, step })
  const collected = boundary === null
    ? { paths: new Set(), records: 0 }
    : collectAttributionPaths(entries, { session: sessionId, turn, step: boundary.step })
  // 展示账本里的原始写法（Windows 大小写别名只影响归并，不改变这里的显示与 undo-to 的操作口径）
  const paths = [...collected.paths]
    .map((key) => (collected.originalPath !== undefined && collected.originalPath.get(key)) || key)
    .sort()
  if (options.json === true) {
    console.log(JSON.stringify({ session: sessionId, turn, step: step ?? null, snapshots, boundary, attributed: paths.length, paths }, null, 2))
    return boundary === null ? 4 : 0
  }
  console.log(`会话 ${sessionId} 第 ${turn} 轮，共 ${snapshots.length} 条边界快照：`)
  for (const entry of snapshots) {
    console.log(`  ${entry.phase} 步=${entry.step} tree=${entry.tree ?? 'null'} 文件=${entry.files ?? 0}${entry.degraded ? '（降级）' : ''}`)
  }
  if (boundary === null) {
    console.log('边界：不可用（该轮没有可用的 start 快照）')
    return 4
  }
  console.log(`边界：${boundary.source}（步=${boundary.step}）tree=${String(boundary.tree).slice(0, 12)}… ref=${boundary.ref}`)
  console.log(`归属路径（回滚只允许触碰这些）：${paths.length} 个，来自 ${collected.records} 条归属记录`)
  for (const path of paths) console.log(`  ${path}`)
  return 0
}

/** diff：显示某轮/某步的归属路径与行数变化（行数需要影子库与 git 可用）。 */
async function cmdDiff(options, positional) {
  if (positional.length < 2) {
    console.error('错误：diff 需要 <sessionId> <turn> 两个参数')
    return 1
  }
  const [sessionId, turnRaw] = positional
  const turn = parseTurn(turnRaw)
  if (turn === null) {
    console.error('错误：<turn> 必须是整数')
    return 1
  }
  const step = options.step !== undefined ? parseTurn(options.step) : undefined
  if (options.step !== undefined && step === null) {
    console.error('错误：--step 必须是整数')
    return 1
  }
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const entries = readAllEntries(stateDir)
  let records = entries.filter((e) => e.kind === BOUNDARY_KIND.ATTRIBUTION && e.session === sessionId && e.turn === turn)
  if (step !== undefined) records = records.filter((e) => e.step === step)
  if (records.length === 0) {
    console.error(`会话 ${sessionId} 第 ${turn} 轮没有归属记录（阶段 B 口径不可用）`)
    return 3
  }
  const root = resolveBoundaryRoot(options, entries, sessionId)
  const onlyPath = options.path !== undefined ? options.path : null
  const rows = []
  for (const record of records) {
    if (typeof record.from !== 'string' || typeof record.to !== 'string') continue
    const diff = root === null
      ? { ok: false, entries: [], reason: 'ROOT_UNKNOWN' }
      : await diffTrees({ stateDir, root, from: record.from, to: record.to })
    if (diff.ok !== true) {
      rows.push({ turn: record.turn, step: record.step, path: null, note: `无法读取差异（${diff.reason}）` })
      continue
    }
    for (const item of diff.entries) {
      const abs = root === null ? item.path : join(root, ...item.path.split('/'))
      if (onlyPath !== null && !abs.endsWith(onlyPath)) continue
      rows.push({ turn: record.turn, step: record.step, path: abs, added: item.added, deleted: item.deleted, binary: item.binary === true })
    }
  }
  if (options.json === true) {
    console.log(JSON.stringify({ session: sessionId, turn, step: step ?? null, root, rows }, null, 2))
    return rows.length === 0 ? 3 : 0
  }
  if (root === null) console.log('提示：账本里没有被审计根，无法计算行数；用 --root <dir> 指定后重试')
  if (rows.length === 0) {
    console.log('（没有匹配的归属差异）')
    return 3
  }
  for (const row of rows) {
    if (row.path === null) {
      console.log(`  步=${row.step} ${row.note}`)
      continue
    }
    const stat = row.binary ? '（二进制）' : `+${row.added ?? 0} -${row.deleted ?? 0}`
    console.log(`  步=${row.step} ${stat}  ${row.path}`)
  }
  console.log(`共 ${rows.length} 条归属差异`)
  return 0
}

/** undo-to：按边界 tree 回滚（需要账本里有 snapshot/attribution）。 */
async function cmdUndoTo(options, positional) {
  if (positional.length < 2) {
    console.error('错误：undo-to 需要 <sessionId> <turn> 两个参数')
    return 1
  }
  const [sessionId, turnRaw] = positional
  const turn = parseTurn(turnRaw)
  if (turn === null) {
    console.error('错误：<turn> 必须是整数')
    return 1
  }
  const step = options.step !== undefined ? parseTurn(options.step) : undefined
  if (options.step !== undefined && step === null) {
    console.error('错误：--step 必须是整数')
    return 1
  }
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const entries = readAllEntries(stateDir)
  const root = resolveBoundaryRoot(options, entries, sessionId)
  if (root === null) {
    console.error('错误：账本里没有可用的被审计根（阶段 A 旧条目没有该字段），请用 --root <dir> 显式指定')
    return 1
  }
  const result = await executeBoundaryRollback({
    stateDir,
    root,
    session: sessionId,
    turn,
    step,
    apply: options.apply === true,
    force: options.force === true,
    allowWithoutRedo: options['no-redo'] === true,
  })
  if (result.ok !== true) {
    if (result.reason === 'BOUNDARY_MISSING') {
      console.error(`会话 ${sessionId} 第 ${turn} 轮没有可用的边界快照（阶段 B 需要 snapshot 条目）`)
      return 4
    }
    if (result.reason === 'PRE_TREE_UNAVAILABLE') {
      console.error('错误：执行前的工作树快照（preTree）捕获失败——若继续回滚，这次改动将永远无法 redo。')
      console.error('      先处理快照失败原因（预算 / 磁盘 / git 可用性），或确认不需要 redo 时加 --no-redo 重试。')
      return 4
    }
    console.error(`错误：${result.reason}`)
    return 1
  }
  if (options.json === true) console.log(JSON.stringify(result, null, 2))
  else console.log(renderExecuteResult(result))
  // 契约 §10.12 第 3 条：有归属路径但**全部**被 skip 时属于"部分完成"= 2；
  // 只有"根本没有可处理的动作"才是 3（早期把全 skip 一并算成 3，与契约不符）。
  const total = result.counted.restore + result.counted.trash + result.counted.skip
  if (total === 0) return 3
  return result.counted.skip > 0 ? 2 : 0
}

/** redo：撤销上一次已执行的边界回滚。 */
async function cmdRedo(options, positional) {
  if (positional.length < 2) {
    console.error('错误：redo 需要 <sessionId> <turn> 两个参数')
    return 1
  }
  const [sessionId, turnRaw] = positional
  const turn = parseTurn(turnRaw)
  if (turn === null) {
    console.error('错误：<turn> 必须是整数')
    return 1
  }
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const entries = readAllEntries(stateDir)
  const root = resolveBoundaryRoot(options, entries, sessionId)
  if (root === null) {
    console.error('错误：账本里没有可用的被审计根，请用 --root <dir> 显式指定')
    return 1
  }
  const result = await redoBoundaryRollback({
    stateDir,
    root,
    session: sessionId,
    turn,
    entries,
    apply: options.apply === true,
    force: options.force === true,
  })
  if (result.ok !== true) {
    console.error(result.reason === 'NO_REDO_TARGET'
      ? `会话 ${sessionId} 第 ${turn} 轮没有可 redo 的回滚记录（只认 applied:true 且 source:snapshot 的条目）`
      : `无法 redo：${result.reason}`)
    return 5
  }
  if (options.json === true) console.log(JSON.stringify(result, null, 2))
  else console.log(renderExecuteResult(result))
  // 契约 §10.12 第 3 条：有归属路径但**全部**被 skip 时属于"部分完成"= 2；
  // 只有"根本没有可处理的动作"才是 3（早期把全 skip 一并算成 3，与契约不符）。
  const total = result.counted.restore + result.counted.trash + result.counted.skip
  if (total === 0) return 3
  return result.counted.skip > 0 ? 2 : 0
}

/** gc：清理过期的边界 ref 并回收影子库对象（默认只出计划）。 */
async function cmdGc(options) {
  const stateDir = openState(options)
  if (stateDir === null) {
    console.error('错误：状态目录不可读（用 --state 指定，或先让插件初始化）')
    return 1
  }
  const entries = readAllEntries(stateDir)
  // 传 `undefined`（而不是 `null`）表示"不按会话过滤"：早期传 null 会被
  // resolveRootFromLedger 的 `!== undefined` 判定当成"按会话 null 过滤"，
  // 于是账本里明明有 root 也报"没有可用的被审计根"（2026-10-11 复核实证）。
  const root = resolveBoundaryRoot(options, entries, undefined)
  if (root === null) {
    console.error('错误：账本里没有可用的被审计根，请用 --root <dir> 显式指定')
    return 1
  }
  let keepDays = 14
  if (options['keep-days'] !== undefined) {
    const parsed = parseTurn(options['keep-days'])
    if (parsed === null || parsed < 0) {
      console.error('错误：--keep-days 必须是非负整数')
      return 1
    }
    keepDays = parsed
  }
  const apply = options.apply === true
  const before = shadowStats(stateDir, root)
  const refs = await listBoundaryRefs({ stateDir, root })
  // 影子库损坏时必须显式失败：早期版本不检查 ok，会在 refs/objects 缺失时
  // 仍打印"没有需要清理的 ref"并退出 0，把损坏掩盖成"一切正常"（2026-10-11 复核实证）。
  if (refs.ok !== true) {
    console.error(`错误：无法列出边界 ref（${refs.reason === null || refs.reason === undefined ? '未知原因' : refs.reason}）——影子库可能已损坏`)
    return 1
  }
  const result = await gcShadow({ stateDir, root, keepDays, apply })
  if (result.ok !== true) {
    console.error(`错误：gc 失败（${result.reason === null || result.reason === undefined ? '未知原因' : result.reason}）`)
    return 1
  }
  const after = shadowStats(stateDir, root)
  if (options.json === true) {
    console.log(JSON.stringify({ stateDir, root, keepDays, applied: apply, refs: refs.refs, plan: result.plan, deleted: result.deleted, kept: result.kept, objectsBefore: before.objects, objectsAfter: after.objects }, null, 2))
    return 0
  }
  console.log(`影子库：${root}`)
  console.log(`对象数：${before.objects}${apply ? ` → ${after.objects}` : ''}；边界 ref：${refs.refs.length}`)
  if (result.plan.length === 0) console.log(`没有超过 ${keepDays} 天的边界 ref 需要清理`)
  else for (const item of result.plan) console.log(`  ${apply ? '已删除' : '将删除'} ${item.ref}（${item.reason}）`)
  if (!apply && result.plan.length > 0) console.log('（dry-run；加 --apply 才真正删除并 gc）')
  return 0
}

function main() {
  const [, , command, ...rest] = process.argv
  try {
    switch (command) {
      case 'list': {
        const { options } = parseArgv(rest, ['json'], ['state', 'session', 'turn', 'limit'])
        return cmdList(options)
      }
      case 'sessions': {
        const { options } = parseArgv(rest, ['json'], ['state'])
        return cmdSessions(options)
      }
      case 'show': {
        const { options, positional } = parseArgv(rest, ['json'], ['state'])
        return cmdShow(options, positional)
      }
      case 'undo': {
        const { options, positional } = parseArgv(rest, ['apply', 'force', 'json'], ['state'])
        return cmdUndo(options, positional)
      }
      case 'last': {
        const { options } = parseArgv(rest, ['apply', 'force', 'json'], ['state'])
        return cmdLast(options)
      }
      // ---- 阶段 B：边界快照口径（追加，不影响上面任何既有命令） ----
      case 'snapshot': {
        const { options, positional } = parseArgv(rest, ['json'], ['state', 'session', 'turn', 'step'])
        const sub = positional.shift()
        if (sub === 'list') return cmdSnapshotList(options)
        if (sub === 'show') return cmdSnapshotShow(options, positional)
        console.error(`错误：snapshot 需要 list 或 show 子命令（收到 ${sub === undefined ? '(空)' : sub}）`)
        usage()
        return 1
      }
      case 'diff': {
        const { options, positional } = parseArgv(rest, ['json'], ['state', 'step', 'path', 'root'])
        return cmdDiff(options, positional)
      }
      case 'undo-to': {
        const { options, positional } = parseArgv(rest, ['apply', 'force', 'json', 'no-redo'], ['state', 'step', 'root'])
        return cmdUndoTo(options, positional)
      }
      case 'redo': {
        // `--force` 必须注册：2026-10-11 独立复核实证早期版本漏了它，
        // `redo --force` 会直接报"未知选项"（exit 1），使 force 在 redo 场景完全不可达。
        const { options, positional } = parseArgv(rest, ['apply', 'json', 'force'], ['state', 'root', 'step'])
        return cmdRedo(options, positional)
      }
      case 'gc': {
        const { options } = parseArgv(rest, ['apply', 'json'], ['state', 'root', 'keep-days'])
        return cmdGc(options)
      }
      case undefined:
      case 'help':
      case '--help':
        usage()
        return command === undefined ? 1 : 0
      default:
        console.error(`错误：未知子命令 ${command}`)
        usage()
        return 1
    }
  } catch (error) {
    console.error(`错误：${error && error.message ? error.message : error}`)
    return 1
  }
}

// 同步命令直接给退出码；阶段 B 的命令是 async（要等影子库子进程），
// 所以统一在这里处理 Promise —— 不改变任何既有命令的退出码语义。
const outcome = main()
if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
  outcome.then(
    (code) => { process.exitCode = code },
    (error) => {
      console.error(`错误：${error && error.message ? error.message : error}`)
      process.exitCode = 1
    },
  )
} else {
  process.exitCode = outcome
}
