/**
 * dsh-audit-rollback —— 持久化审计账本 + 可精确回滚的编辑前内容。
 *
 * 背景：DSH 0.2.1-alpha.1 自带的 dsh-workspace-changes 只把每轮改动留在 Host
 * 内存里，重启即失；全安装树没有 revert/undo 入口。本插件补上持久层：
 * 每次文件工具（write/edit/str_replace_editor）动手前，把目标路径的编辑前字节
 * 存进内容寻址对象库（CAS），并按轮次写 JSONL 审计账本；回滚由独立 CLI
 * （scripts/audit-rollback.mjs）离线完成，不占模型上下文。
 *
 * 本文件只做**事件适配**：所有存储与回滚逻辑都在 lib/ledger.js（纯 node，
 * 不依赖 Cordis），事件签名逐字按契约 docs/design-audit-rollback.md 第 5.2 节。
 *
 * 性能红线（契约第 6 节）：tools/pre-execute 里只“读一个文件 + 写一个对象”，
 * 不遍历目录；同一路径同一轮只读一次（beforeSeen 去重）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  appendEntry,
  capturePath,
  createTurnState,
  initState,
  matchesAnyGlob,
  previewArgs,
  readAllEntries,
  resolveStateDir,
  sha1Hex,
} from './ledger.js'

export const name = 'audit-rollback'

/** 只强依赖工具注册表（契约第 5.1 节）。 */
export const inject = ['tools']

/** 默认捕获的工具名（契约第 5.4 节）。 */
const DEFAULT_CAPTURE_TOOLS = ['write', 'edit', 'str_replace_editor']

/** 默认捕获上限：2 MiB（2097152，契约 §2.1 写定，与 cordis.patch.yml 默认值逐字段一致）。 */
const DEFAULT_CAPTURE_MAX_BYTES = 2 * 1024 * 1024

/** 默认参数预览上限（契约第 4 节：argsMaxBytes 默认 4096 UTF-8 字节）。 */
const DEFAULT_ARGS_MAX_BYTES = 4096

/** 默认排除片段（契约 §2.1 写定，与 cordis.patch.yml 默认值一致）：依赖目录 / 版本库 / 记忆目录 / 缓存目录。 */
const DEFAULT_EXCLUDE_GLOBS = ['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/']

function asNames(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

function asPositiveInt(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback
}

/** 把 profile 传入的原始 config 规范化为内部结构（非法字段忽略，不抛错）。 */
export function normalizeConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  const captureTools = asNames(cfg.captureTools)
  return {
    stateDir: resolveStateDir(cfg),
    captureTools: captureTools.length > 0 ? captureTools : DEFAULT_CAPTURE_TOOLS.slice(),
    captureMaxBytes: asPositiveInt(cfg.captureMaxBytes, DEFAULT_CAPTURE_MAX_BYTES),
    argsMaxBytes: asPositiveInt(cfg.argsMaxBytes, DEFAULT_ARGS_MAX_BYTES),
    logCalls: cfg.logCalls !== false,
    excludeGlobs: Array.isArray(cfg.excludeGlobs) ? asNames(cfg.excludeGlobs) : DEFAULT_EXCLUDE_GLOBS.slice(),
    gitSnapshot: cfg.gitSnapshot === true,
  }
}

/**
 * 从 exec.arguments 探测目标路径（契约第 5.4 节）：
 * 按顺序探测 path / file_path / filePath / filename，取第一个字符串值；
 * 相对路径用会话 cwd 解析为绝对路径；识别不出返回 undefined。
 */
export function identifyTarget(argsValue, cwd) {
  if (argsValue === null || typeof argsValue !== 'object') return undefined
  for (const key of ['path', 'file_path', 'filePath', 'filename']) {
    const value = argsValue[key]
    if (typeof value === 'string' && value.length > 0) {
      if (isAbsolute(value)) return resolve(value)
      if (typeof cwd === 'string' && cwd.length > 0) return resolve(cwd, value)
      return undefined // 相对路径但没有 cwd：识别失败，不猜
    }
  }
  return undefined
}

/** 设置页「最近捕获」条数。只读查询固定取这个窗口，避免无参 remote 再传 limit。 */
export const RECENT_CAPTURE_LIMIT = 8

const LEDGER_KINDS = ['turn/start', 'call', 'capture', 'turn/end', 'rollback', 'note']

/** 每个 apply 实例的生效配置与初始化结果。假 ctx 测试与设置页读的是同一份。 */
const runtimeByCtx = new WeakMap()

/**
 * 只读状态。可对假 ctx 直接调用：优先用该 ctx 上一次 apply 记下的配置，
 * 否则规范化 `rawConfig ?? ctx.config`。不注册监听、不写账本。
 * @param {object} ctx
 * @param {object} [rawConfig]
 */
export function queryAuditStatus(ctx, rawConfig) {
  const live = ctx !== null && typeof ctx === 'object' ? runtimeByCtx.get(ctx) : undefined
  const config = live?.config ?? normalizeConfig(rawConfig ?? ctx?.config)
  return collectAuditStatus(config, live)
}

function collectAuditStatus(config, live) {
  const stateDir = config.stateDir
  const stateFile = readStateMeta(stateDir)
  const entries = safeEntries(stateDir)
  const byKind = emptyKinds()
  for (const entry of entries) {
    const kind = entry && typeof entry.kind === 'string' ? entry.kind : 'other'
    if (LEDGER_KINDS.includes(kind)) byKind[kind] += 1
    else byKind.other += 1
  }
  const captures = summarizeCaptures(entries)
  const objects = readObjectStats(stateDir)
  return {
    plugin: 'dsh-audit-rollback',
    state: {
      stateDir,
      stateReady: live ? live.stateReady === true : stateFile.readable,
      version: stateFile.version,
      createdAt: stateFile.createdAt,
      stateError: stateFile.error,
      initError: live?.initError ?? null,
    },
    ledger: {
      fileCount: countLedgerFiles(stateDir),
      entryCount: entries.length,
      byKind,
    },
    objects,
    captures,
    config: {
      captureTools: config.captureTools.slice(),
      captureMaxBytes: config.captureMaxBytes,
      argsMaxBytes: config.argsMaxBytes,
      logCalls: config.logCalls,
      excludeGlobs: config.excludeGlobs.slice(),
      gitSnapshot: config.gitSnapshot,
    },
  }
}

function emptyKinds() {
  const byKind = { other: 0 }
  for (const kind of LEDGER_KINDS) byKind[kind] = 0
  return byKind
}

function safeEntries(stateDir) {
  try {
    return readAllEntries(stateDir)
  } catch {
    return []
  }
}

function countLedgerFiles(stateDir) {
  const dir = join(stateDir, 'ledger')
  if (!existsSync(dir)) return 0
  try {
    return readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).length
  } catch {
    return 0
  }
}

function readStateMeta(stateDir) {
  const file = join(stateDir, 'state.json')
  if (!existsSync(file)) return { readable: false, version: null, createdAt: null, error: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      readable: true,
      version: parsed && typeof parsed.version === 'number' ? parsed.version : null,
      createdAt: parsed && typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
      error: null,
    }
  } catch (error) {
    return {
      readable: false,
      version: null,
      createdAt: null,
      error: error && error.message ? error.message : String(error),
    }
  }
}

function readObjectStats(stateDir) {
  const root = join(stateDir, 'objects')
  if (!existsSync(root)) return { count: 0, totalBytes: 0, error: null }
  let count = 0
  let totalBytes = 0
  const stack = [root]
  try {
    while (stack.length > 0) {
      const dir = stack.pop()
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const info = statSync(full)
        if (info.isDirectory()) stack.push(full)
        else if (info.isFile()) {
          count += 1
          totalBytes += info.size
        }
      }
    }
    return { count, totalBytes, error: null }
  } catch (error) {
    return {
      count,
      totalBytes,
      error: error && error.message ? error.message : String(error),
    }
  }
}

function summarizeCaptures(entries) {
  const paths = new Set()
  const rows = []
  for (const entry of entries) {
    if (!entry || entry.kind !== 'capture') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    if (path.length > 0) paths.add(path)
    rows.push({
      ts: typeof entry.ts === 'string' ? entry.ts : '',
      phase: typeof entry.phase === 'string' ? entry.phase : '',
      fileName: path.length > 0 ? basename(path) : '',
      hashPrefix: typeof entry.hash === 'string' && entry.hash.length > 0 ? entry.hash.slice(0, 8) : null,
      bytes: typeof entry.bytes === 'number' ? entry.bytes : null,
    })
  }
  return {
    uniquePaths: paths.size,
    recentLimit: RECENT_CAPTURE_LIMIT,
    recent: rows.slice(-RECENT_CAPTURE_LIMIT).reverse(),
  }
}

function parseAuditStatus(value) {
  if (!value || typeof value !== 'object' || value.plugin !== 'dsh-audit-rollback') {
    throw new Error('Invalid audit-rollback status')
  }
  if (!value.state || typeof value.state.stateDir !== 'string') throw new Error('Invalid audit-rollback status.state')
  if (!value.ledger || typeof value.ledger.fileCount !== 'number' || typeof value.ledger.entryCount !== 'number' || !value.ledger.byKind) {
    throw new Error('Invalid audit-rollback status.ledger')
  }
  if (!value.objects || typeof value.objects.count !== 'number' || typeof value.objects.totalBytes !== 'number') {
    throw new Error('Invalid audit-rollback status.objects')
  }
  if (!value.captures || typeof value.captures.uniquePaths !== 'number' || !Array.isArray(value.captures.recent)) {
    throw new Error('Invalid audit-rollback status.captures')
  }
  if (!value.config || !Array.isArray(value.config.captureTools)) throw new Error('Invalid audit-rollback status.config')
  return value
}

function statusCodec(typeSymbol, parse) {
  return {
    mode: 'strict',
    typeSymbol,
    schema: { parse },
    create: () => ({ parse }),
  }
}

/** 与 lib/client.js 的 remote 描述符对齐。Client 不能 import 本文件，改动时两边一起改。 */
export const auditStatusRemote = {
  package: 'dsh-audit-rollback',
  descriptors: [
    {
      id: 'dsh-audit-rollback#auditRollback/read',
      service: 'auditRollback',
      namespace: 'auditRollback',
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [],
      result: statusCodec('dsh-audit-rollback#AuditStatus', parseAuditStatus),
    },
  ],
}

// Gateway 用这个属性名读 SRC 方法标记。这是字符串键，不是对核心包的 import。
const REMOTE_METHOD_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

function markDirectRemote(prototype, method) {
  const current = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_KEY)?.value
  const methods = Array.isArray(current?.methods) ? current.methods : []
  if (methods.some((item) => item.method === method)) return
  Object.defineProperty(prototype, REMOTE_METHOD_KEY, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        ...methods,
        Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
      ]),
    }),
  })
}

class AuditStatusRemote {
  read() {
    throw new Error('auditRollback.read 未绑定')
  }
}
markDirectRemote(AuditStatusRemote.prototype, 'read')

function exposeAuditRemote(ctx) {
  try {
    const service = new AuditStatusRemote()
    service.name = 'auditRollback'
    service.typertRemote = Object.freeze({
      service,
      serviceKey: 'auditRollback',
      namespace: 'auditRollback',
    })
    // 实例方法覆盖原型，供 Gateway Reflect.get 调用；参数表仍以原型上的无参 read 为准。
    service.read = function read() {
      return queryAuditStatus(ctx)
    }
    if (typeof ctx.reflect?.provide === 'function') {
      ctx.reflect.provide('auditRollback', service)
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['typert'], (scope) => {
        const register = () => {
          try {
            if (typeof scope.typert?.register !== 'function') return undefined
            return scope.typert.register({
              package: auditStatusRemote.package,
              face: 'host',
              schemas: [],
              model: { services: [], events: [], objects: [] },
              invocations: auditStatusRemote.descriptors,
            })
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            scope.logger?.warn?.(`[audit-rollback] remote 描述符注册失败: ${message}`)
            return undefined
          }
        }
        if (typeof scope.effect === 'function') scope.effect(register)
        else register()
      })
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    ctx.logger?.warn?.(`[audit-rollback] 只读状态暴露失败: ${message}`)
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  // initState 可能因 stateDir 父路径是文件（ENOTDIR）等原因失败：
  // 不抛错拖垮宿主，warn 降级——后续各事件处理器本就有 try/catch warn-only。
  let stateReady = true
  let initError = null
  try {
    initState(config.stateDir)
  } catch (error) {
    stateReady = false
    initError = error && error.message ? error.message : String(error)
    ctx.logger.warn(
      `[audit-rollback] 状态目录初始化失败，捕获与记账将全部降级为 warn-only: ${initError}`,
    )
  }
  // 只读诊断：记下本次 apply 的生效配置，供设置页与离线假 ctx 查询。不改变捕获语义。
  runtimeByCtx.set(ctx, { config, stateReady, initError })
  exposeAuditRemote(ctx)

  // 加载 banner（契约第 6.1 条）：stateDir、captureTools、captureMaxBytes、gitSnapshot 状态
  ctx.logger.info(
    `[audit-rollback] 已加载 stateDir=${config.stateDir} ` +
      `captureTools=[${config.captureTools.join(',')}] ` +
      `captureMaxBytes=${config.captureMaxBytes} ` +
      `gitSnapshot=${config.gitSnapshot ? 'true(未实现)' : 'false'}`,
  )

  // gitSnapshot 只留开关不实现（契约第 1/6.7 条）：warn + 账本 note，不得静默无效
  if (config.gitSnapshot) {
    ctx.logger.warn('[audit-rollback] gitSnapshot=true：影子 git 快照本阶段未实现，仅记录本说明，行为不变')
    if (stateReady) {
      appendEntry(config.stateDir, { kind: 'note', text: 'gitSnapshot 未实现：开关已打开但影子 git 快照本阶段不生效' })
    }
  }

  // 每个会话的轮次状态：{ turn: 当前轮号(未知 -1), state: createTurnState() | null }
  const sessions = new Map()

  const sessionIdOf = (session) => (session && typeof session.id === 'string' ? session.id : 'unknown')
  const cwdOf = (session) =>
    session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : undefined

  /** 取会话槽位（不存在则建；turn 未知用 -1，契约第 5.2 节）。 */
  function slotFor(session) {
    const id = sessionIdOf(session)
    let slot = sessions.get(id)
    if (slot === undefined) {
      slot = { turn: -1, state: null }
      sessions.set(id, slot)
    }
    return slot
  }

  /** 对本轮所有已捕获路径补做 capture/after（整轮只做一次，契约第 6.4 条）。 */
  function captureAfterOnce(sessionId, slot) {
    if (slot.state === null || slot.state.afterDone) return
    slot.state.afterDone = true
    for (const path of slot.state.capturedPaths) {
      try {
        capturePath(config.stateDir, {
          session: sessionId,
          turn: slot.turn,
          path,
          phase: 'after',
          maxBytes: config.captureMaxBytes,
          turnState: slot.state,
        })
      } catch (error) {
        ctx.logger.warn(`[audit-rollback] capture/after 失败 ${path}: ${error && error.message ? error.message : error}`)
      }
    }
  }

  // turn/start：记条目并初始化本轮内存态；turn/end：补 after、记账、清轮态
  const offSessionEvent = ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      const id = sessionIdOf(session)
      const slot = slotFor(session)
      const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : -1
      if (event.type === 'turn/start') {
        slot.turn = turn
        slot.state = createTurnState()
        appendEntry(config.stateDir, { kind: 'turn/start', session: id, turn, cwd: cwdOf(session) ?? '' })
      } else if (event.type === 'turn/end') {
        if (slot.state !== null) {
          captureAfterOnce(id, slot)
          appendEntry(config.stateDir, {
            kind: 'turn/end',
            session: id,
            turn: slot.turn,
            captured: slot.state.capturedPaths.size,
          })
          slot.state = null // 清理本轮内存态，会话槽位留给下一轮
        }
      }
    } catch (error) {
      ctx.logger.warn(`[audit-rollback] session/event 处理失败: ${error && error.message ? error.message : error}`)
    }
  })

  const offDisposed = ctx.on('session/disposed', (session) => {
    sessions.delete(sessionIdOf(session))
  })

  // agent/turn-stopping：整轮结束前补一次 capture/after（契约第 6.4 条）
  const offStopping = ctx.on('agent/turn-stopping', async ({ agent }) => {
    try {
      const session = agent && agent.session
      if (session === undefined) return
      const slot = sessions.get(sessionIdOf(session))
      if (slot !== undefined) captureAfterOnce(sessionIdOf(session), slot)
    } catch (error) {
      ctx.logger.warn(`[audit-rollback] turn-stopping 处理失败: ${error && error.message ? error.message : error}`)
    }
  })

  // tools/pre-execute：记 call + 捕获 before；绝不能改变调用结果（契约第 5.2 节）
  const offPreExecute = ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      try {
        const session = exec && exec.agent ? exec.agent.session : undefined
        const id = sessionIdOf(session)
        const slot = session !== undefined ? slotFor(session) : { turn: -1, state: null }
        const toolName = typeof exec.name === 'string' ? exec.name : ''
        const target = identifyTarget(exec.arguments, cwdOf(session))
        const targets = target === undefined ? [] : [target]

        if (config.logCalls) {
          appendEntry(config.stateDir, {
            kind: 'call',
            session: id,
            turn: slot.turn,
            tool: toolName,
            callId: typeof exec.callId === 'string' ? exec.callId : '',
            argsSha1: sha1Hex(Buffer.from(previewArgs(exec.arguments, config.argsMaxBytes), 'utf8')),
            argsPreview: previewArgs(exec.arguments, config.argsMaxBytes),
            targets,
          })
        }

        // 捕获 before：工具在名单内、路径识别出、本轮未捕获过、不命中排除 globs
        if (
          slot.state !== null &&
          target !== undefined &&
          config.captureTools.includes(toolName) &&
          !matchesAnyGlob(target, config.excludeGlobs)
        ) {
          capturePath(config.stateDir, {
            session: id,
            turn: slot.turn,
            path: target,
            phase: 'before',
            maxBytes: config.captureMaxBytes,
            turnState: slot.state,
          })
        }
      } catch (error) {
        // 内部异常只 warn，随后照常放行工具调用（契约第 5.2 节红线）
        ctx.logger.warn(`[audit-rollback] pre-execute 捕获失败: ${error && error.message ? error.message : error}`)
      }
      return next()
    },
    { prepend: false },
  )

  // 插件卸载时摘掉全部监听（契约第 5.1 节：ctx.effect 清理）
  ctx.effect(() => () => {
    offSessionEvent()
    offDisposed()
    offStopping()
    offPreExecute()
    sessions.clear()
  })
}
