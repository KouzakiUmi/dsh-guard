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
 * 退出码：0 全部完成；1 参数错误或状态不可读；2 有文件被 skip（部分完成）；
 * 3 该轮没有可回滚的捕获。
 *
 * dry-run（默认）不触碰任何目标文件，只打印将执行的动作；
 * 但按契约第 7 节仍会往账本追加一条 rollback 计划条目（applied:false）。
 */

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

/** 打印用法（参数错误时走退出码 1）。 */
function usage() {
  console.error(`用法：
  audit-rollback list     [--state <dir>] [--session <sid>] [--turn <n>] [--limit N] [--json]
  audit-rollback sessions [--state <dir>] [--json]
  audit-rollback show     <sessionId> <turn> [--state <dir>] [--json]
  audit-rollback undo     <sessionId> <turn> [--state <dir>] [--apply] [--force]
  audit-rollback last     [--state <dir>] [--apply] [--force] [--json]`)
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

process.exitCode = main()
