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
  canonicalPathKey,
  capturePath,
  createTurnState,
  initState,
  matchesAnyGlob,
  previewArgs,
  readAllEntries,
  resolveStateDir,
  sha1Hex,
} from './ledger.js'

import { readConfigValues } from './config.js'
import { createRollbackApi, DEFAULT_CAPTURE_TOOLS } from './rollback-preview.js'
import { rollbackDescriptors, rollbackMethods } from './rollback-remote.js'
// 阶段 B：边界快照与归属（纯 node 库层，不依赖 Cordis）
import { TURN_LEVEL_STEP, captureBoundary, recordAttribution, resolveRootFromLedger } from './boundary.js'
import { shadowStats, workspaceKey } from './snapshot.js'
export { Config } from './config.js'

export const name = 'audit-rollback'

/** 只强依赖工具注册表（契约第 5.1 节）。 */
export const inject = ['tools']

/** 默认捕获上限：2 MiB（2097152，契约 §2.1 写定，与 cordis.patch.yml 默认值逐字段一致）。 */
const DEFAULT_CAPTURE_MAX_BYTES = 2 * 1024 * 1024

/** 默认参数预览上限（契约第 4 节：argsMaxBytes 默认 4096 UTF-8 字节）。 */
const DEFAULT_ARGS_MAX_BYTES = 4096

/** 默认排除片段（契约 §2.1 写定，与 cordis.patch.yml 默认值一致）：依赖目录 / 版本库 / 记忆目录 / 缓存目录。 */
const DEFAULT_EXCLUDE_GLOBS = ['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/']

/** 阶段 B 影子库默认值（契约 §10.4；必须与 config.js 的 Schema 默认值逐字段一致）。 */
const DEFAULT_SNAPSHOT_EXCLUDE_GLOBS = ['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/', '/audit-rollback/']
const DEFAULT_SNAPSHOT_MAX_FILES = 50000
const DEFAULT_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024 // 512 MiB
const DEFAULT_SNAPSHOT_SCAN_MS = 5000
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10000
const DEFAULT_SNAPSHOT_RETENTION_DAYS = 14

/** 阶段 B 的枚举取值（规范化与设置页校验必须一致）。 */
const SNAPSHOT_MODES = ['per-step', 'per-turn']
const SNAPSHOT_IGNORE_POLICIES = ['git', 'force']
const ROLLBACK_ON_ABORT_MODES = ['off', 'prompt', 'auto']

function asNames(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

function asPositiveInt(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback
}

/** 非负整数（`snapshotRetentionDays` 允许 0＝不保留历史边界）。 */
function asNonNegativeInt(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback
}

/** 枚举取值校验：不在集合内一律回落默认（非法配置不抛错，与既有风格一致）。 */
function asEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** 把 profile 传入的原始 config 规范化为内部结构（非法字段忽略，不抛错）。 */
export function normalizeConfig(raw) {
  const cfg = readConfigValues(raw !== null && typeof raw === 'object' ? raw : {})
  const captureTools = asNames(cfg.captureTools)
  return {
    stateDir: resolveStateDir(cfg),
    captureTools: captureTools.length > 0 ? captureTools : DEFAULT_CAPTURE_TOOLS.slice(),
    captureMaxBytes: asPositiveInt(cfg.captureMaxBytes, DEFAULT_CAPTURE_MAX_BYTES),
    argsMaxBytes: asPositiveInt(cfg.argsMaxBytes, DEFAULT_ARGS_MAX_BYTES),
    logCalls: cfg.logCalls !== false,
    excludeGlobs: Array.isArray(cfg.excludeGlobs) ? asNames(cfg.excludeGlobs) : DEFAULT_EXCLUDE_GLOBS.slice(),
    gitSnapshot: cfg.gitSnapshot === true,
    // ---- 阶段 B（契约 §10.4 / §10.8）。gitSnapshot 为 false 时这些值不产生任何行为。----
    snapshotMode: asEnum(cfg.snapshotMode, SNAPSHOT_MODES, 'per-step'),
    snapshotExcludeGlobs: Array.isArray(cfg.snapshotExcludeGlobs)
      ? asNames(cfg.snapshotExcludeGlobs)
      : DEFAULT_SNAPSHOT_EXCLUDE_GLOBS.slice(),
    snapshotIgnorePolicy: asEnum(cfg.snapshotIgnorePolicy, SNAPSHOT_IGNORE_POLICIES, 'git'),
    snapshotMaxFiles: asPositiveInt(cfg.snapshotMaxFiles, DEFAULT_SNAPSHOT_MAX_FILES),
    snapshotMaxBytes: asPositiveInt(cfg.snapshotMaxBytes, DEFAULT_SNAPSHOT_MAX_BYTES),
    snapshotScanMs: asPositiveInt(cfg.snapshotScanMs, DEFAULT_SNAPSHOT_SCAN_MS),
    snapshotTimeoutMs: asPositiveInt(cfg.snapshotTimeoutMs, DEFAULT_SNAPSHOT_TIMEOUT_MS),
    snapshotAutoExcludeOversized: cfg.snapshotAutoExcludeOversized === true,
    rollbackOnAbort: asEnum(cfg.rollbackOnAbort, ROLLBACK_ON_ABORT_MODES, 'prompt'),
    snapshotRetentionDays: asNonNegativeInt(cfg.snapshotRetentionDays, DEFAULT_SNAPSHOT_RETENTION_DAYS),
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

const LEDGER_KINDS = ['turn/start', 'call', 'capture', 'turn/end', 'rollback', 'note', 'snapshot', 'attribution', 'abort']

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
  const config = live?.readConfig() ?? normalizeConfig(rawConfig ?? ctx?.config)
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

  // ---- 阶段 B 概览（只读）----
  // 被审计根从账本里的 root 字段还原（阶段 B 条目才带；旧账本为 null → 影子库显示为未知）。
  const shadowRootPath = resolveRootFromLedger(entries, {})
  const shadow = {
    enabled: config.gitSnapshot === true,
    workspaceKey: shadowRootPath === null ? null : workspaceKey(shadowRootPath),
    objects: 0,
    refs: 0,
    // 自动排除的顶层项（最近一次）与熔断原因：都必须在设置页可见，不许静默（§10.4 第 6 条）。
    autoExcluded: Array.isArray(live?.snapshotRuntime?.lastAutoExcluded) ? live.snapshotRuntime.lastAutoExcluded.slice() : [],
    fused: live?.snapshotRuntime?.fused === null || live?.snapshotRuntime?.fused === undefined
      ? null
      : live.snapshotRuntime.fused.reason,
  }
  if (shadowRootPath !== null) {
    try {
      const stats = shadowStats(stateDir, shadowRootPath)
      shadow.objects = stats.objects
      shadow.refs = stats.refs
    } catch {
      /* 影子库不可读时保持 0，不阻断状态查询 */
    }
  }
  const boundaryEntries = entries.filter((entry) => entry && entry.kind === 'snapshot')
  const lastBoundary = boundaryEntries.length > 0 ? boundaryEntries[boundaryEntries.length - 1] : null
  const snapshotStats = {
    boundaries: boundaryEntries.length,
    lastTurn: lastBoundary !== null && typeof lastBoundary.turn === 'number' ? lastBoundary.turn : null,
    lastStep: lastBoundary !== null && typeof lastBoundary.step === 'number' ? lastBoundary.step : null,
  }

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
      // 阶段 B 字段一并回传：设置页与「描述符一致性」测试读的是同一份。
      snapshotMode: config.snapshotMode,
      snapshotExcludeGlobs: config.snapshotExcludeGlobs.slice(),
      snapshotIgnorePolicy: config.snapshotIgnorePolicy,
      snapshotMaxFiles: config.snapshotMaxFiles,
      snapshotMaxBytes: config.snapshotMaxBytes,
      snapshotScanMs: config.snapshotScanMs,
      snapshotTimeoutMs: config.snapshotTimeoutMs,
      snapshotAutoExcludeOversized: config.snapshotAutoExcludeOversized,
      rollbackOnAbort: config.rollbackOnAbort,
      snapshotRetentionDays: config.snapshotRetentionDays,
    },
    shadow,
    snapshotStats,
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

auditStatusRemote.descriptors.push(...rollbackDescriptors)

class AuditStatusRemote {
  read() { throw new Error('auditRollback.read 未绑定') }
  changedFiles(request) { throw new Error('auditRollback.changedFiles 未绑定') }
  preview(request) { throw new Error('auditRollback.preview 未绑定') }
  restore(request) { throw new Error('auditRollback.restore 未绑定') }
}
for (const method of ['read', ...rollbackMethods]) markDirectRemote(AuditStatusRemote.prototype, method)

/**
 * 会话存在性/可变性校验（HIGH-3）：changedFiles/preview/restore 调用前的 fail-closed 门。
 * - 存在性走 Host `sessionController.inspect(sessionId)`：现场 0.2.1-alpha.1
 *   dsh-api-session-controller 的 inspect 是只读路径（attached 快照或
 *   sessionQuery.observeSession(projectionMode:'none') 的冷读），不激活、不
 *   resume Agent/模型；resolveAgent/lookup 会冷 resume，明确不用。
 * - mutation（restore）还要求 `agents.get(sessionId)?.status !== 'running'`，
 *   防止恢复进行中轮次的会话文件。
 * - 任一服务缺失或读取失败一律抛错拒绝（SESSION_VERIFIER_UNAVAILABLE），
 *   不静默放行。
 */
function createSessionVerifier(ctx) {
  const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  const notFound = (sessionId) => {
    const error = new Error(`SESSION_NOT_FOUND: ${sessionId}`)
    error.code = 'SESSION_NOT_FOUND'
    return error
  }
  return async function assertSession(sessionId, mutation) {
    const controller = get('sessionController')
    if (!controller || typeof controller.inspect !== 'function') {
      throw new Error('SESSION_VERIFIER_UNAVAILABLE: sessionController 服务缺失，按 fail-closed 拒绝')
    }
    try {
      const inspected = await controller.inspect(sessionId)
      if (!inspected || !inspected.meta || typeof inspected.meta.id !== 'string') throw notFound(sessionId)
    } catch (error) {
      // 现场 ApiSessionNotFound 的消息为 `session "<id>" not found`；其余错误
      // （持久化读失败等）无法区分「不存在」与「读不出」，一律按校验不可用拒绝。
      if (error && error.code === 'SESSION_NOT_FOUND') throw error
      const message = error && error.message ? error.message : String(error)
      if (/not found/i.test(message)) throw notFound(sessionId)
      throw new Error(`SESSION_VERIFIER_UNAVAILABLE: ${message}`)
    }
    if (mutation) {
      const agents = get('agents')
      if (!agents || typeof agents.get !== 'function') {
        throw new Error('SESSION_VERIFIER_UNAVAILABLE: agents 服务缺失，按 fail-closed 拒绝变更')
      }
      const agent = agents.get(sessionId)
      if (agent && agent.status === 'running') {
        throw new Error('SESSION_TURN_ACTIVE: 会话有进行中的轮，拒绝恢复活动会话文件')
      }
    }
  }
}

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
    // captureTools 决定哪些工具的 call 算「改动意图」；列表只列真正有快照的文件。
    const liveConfig = runtimeByCtx.get(ctx).readConfig()
    const api = createRollbackApi(liveConfig.stateDir, {
      assertSession: createSessionVerifier(ctx),
      captureTools: () => runtimeByCtx.get(ctx)?.readConfig().captureTools,
    })
    service.changedFiles = function changedFiles(request) { return api.changedFiles(request) }
    service.preview = function preview(request) { return api.preview(request) }
    service.restore = function restore(request) { return api.restore(request) }
    if (typeof ctx.effect === 'function') ctx.effect(() => () => api.dispose())
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
  // Ordinary stateDir stays tied to this instance. Volatile fields are dereferenced at
  // each new turn; an in-flight turn never changes policy or object-store location.
  const readConfig = () => ({ ...normalizeConfig(rawConfig), stateDir: config.stateDir })
  /** 阶段 B 运行态：熔断标志与最近一次自动排除（供 status 只读展示）。 */
  const snapshotRuntime = { fused: null, lastAutoExcluded: [] }
  runtimeByCtx.set(ctx, { readConfig, stateReady, initError, snapshotRuntime })
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)))
  }
  exposeAuditRemote(ctx)

  // 加载 banner（契约第 6.1 条）
  ctx.logger.info(
    `[audit-rollback] 已加载 stateDir=${config.stateDir} ` +
      `captureTools=[${config.captureTools.join(',')}] ` +
      `captureMaxBytes=${config.captureMaxBytes} ` +
      `gitSnapshot=${config.gitSnapshot ? `true(${config.snapshotMode})` : 'false'}`,
  )

  // 阶段 B（契约 §10.4）：只有 gitSnapshot=true 才启用影子库边界快照。
  // **默认 false 时不触碰任何 git、不注册任何新行为**——这是 B2b 的回归红线。
  if (config.gitSnapshot === true) {
    ctx.logger.info(
      `[audit-rollback] 影子库边界快照已启用：mode=${config.snapshotMode} policy=${config.snapshotIgnorePolicy} ` +
        `budget=${config.snapshotMaxFiles}文件/${Math.round(config.snapshotMaxBytes / 1048576)}MiB ` +
        `scanMs=${config.snapshotScanMs} timeoutMs=${config.snapshotTimeoutMs} ` +
        `autoExcludeOversized=${config.snapshotAutoExcludeOversized ? 'true' : 'false'}`,
    )
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

  /**
   * 对本轮所有已捕获路径补做 capture/after（整轮只做一次，契约第 6.4 条）。
   * 权威 after 只在 turn/end 采集（MEDIUM-5）：agent/turn-stopping 之后核心仍可
   * 继续 next step 并落盘（现场 agent-loop 在 stopping 后才 append turn/end），
   * 在 stopping 采集会把后像记成中间态；abort 而没有 turn/end 的轮次，恢复侧
   * 本来就以 TURN_NOT_ENDED 拒绝（fail-closed），不需要提前兜底。
   */
  function captureAfterOnce(sessionId, slot) {
    if (slot.state === null || slot.state.afterDone) return
    slot.state.afterDone = true
    const config = slot.config
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

  /**
   * 补采漏掉的 after 与 turn/end 条目（2026-10-06）。
   *
   * `sessions` 是 **apply 实例内存态**：插件热重载或轮次中途加载后 Map 为空，
   * 此时 turn/end 到达时 `slot.state === null`，旧口径直接跳过整段——该轮的 after
   * 与 turn/end 永久缺失，文件永远停在 preimage-only 且被 TURN_NOT_ENDED 拒绝。
   * 现场实测 154 个有 before 的 (session,turn) 中有 4 个正是这样丢的：
   * turn/start 与 turn/end 事件都在，after 却没写。
   *
   * 补救：轮号从事件本身取（重载后 `slot.turn` 还是 -1），回扫账本找出该轮所有
   * before 路径重新 probe 补写 after，并补 turn/end 条目。**只在这条异常路径上**
   * 付一次全账本读取，正常轮次沿用内存态、零额外开销（pre-execute 红线不受影响）。
   *
   * @returns {number|null} 补写的 after 条数；null 表示账本里该轮本就完整或无从补起
   */
  function recoverTurnEnd(sessionId, turn) {
    const config = readConfig()
    const stateDir = config.stateDir
    const before = new Map()
    const afterSeen = new Set()
    let hasStart = false
    let hasEnd = false
    for (const entry of readAllEntries(stateDir)) {
      if (entry.session !== sessionId || entry.turn !== turn) continue
      if (entry.kind === 'turn/start') hasStart = true
      else if (entry.kind === 'turn/end') hasEnd = true
      else if (entry.kind === 'capture' && typeof entry.path === 'string') {
        const key = canonicalPathKey(entry.path)
        if (entry.phase === 'before') { if (!before.has(key)) before.set(key, entry.path) }
        else if (entry.phase === 'after') afterSeen.add(key)
      }
    }
    // 已有 turn/end：账本自洽，不重复写。没有 turn/start：本次 turn 根本不属于本插件。
    if (hasEnd || !hasStart) return null
    let captured = 0
    for (const [key, path] of before) {
      if (afterSeen.has(key)) continue
      try {
        capturePath(stateDir, { session: sessionId, turn, path, phase: 'after', maxBytes: config.captureMaxBytes })
        captured += 1
      } catch (error) {
        ctx.logger.warn(`[audit-rollback] 补采 after 失败 ${path}: ${error && error.message ? error.message : error}`)
      }
    }
    appendEntry(stateDir, { kind: 'turn/end', session: sessionId, turn, captured, recovered: true })
    return captured
  }

  // ---- 阶段 B：影子库边界快照（契约 §10.4 / §10.6）----------------------------
  //
  // 串行队列：所有影子库操作排队执行，避免同一影子库的并发索引冲突。
  // （契约 §10.4 第 5 条；参考 Roo Code 的做法——"同一流式操作内不重复 checkpoint"。）
  // 任务内部自带 try/catch，因此链条不会被单个失败污染。
  let snapshotChain = Promise.resolve()
  let snapshotDisposed = false
  function enqueueSnapshot(task) {
    snapshotChain = snapshotChain.then(task, task)
    return snapshotChain
  }

  /**
   * 待配对的 start 快照。**键必须含 (turn, step)**：只按 sessionId 配对时，
   * 交错边界或跨轮残留会让 end 配到别人的 start，使归属的 `from` 与它声明的 turn/step 脱节
   * ——而归属是回滚的唯一依据（2026-10-11 独立复核实证：乱序 step 事件会错配且丢条目）。
   */
  const pendingBoundaries = new Map()
  const boundaryKeyOf = (sessionId, turn, step) => `${sessionId}|${turn}|${step}`
  /** 该会话所有未配对的 start 键（用于 turn/end 与 session/disposed 清理残留）。 */
  const pendingKeysOf = (sessionId) => {
    const prefix = `${sessionId}|`
    return [...pendingBoundaries.keys()].filter((key) => key.startsWith(prefix))
  }

  /** 环境性失败（重试也不会好）一律熔断，避免每个边界都重试并重复告警（契约 §10.4 第 1 条）。 */
  const FUSING_REASONS = new Set([
    'GIT_UNAVAILABLE', 'INIT_FAILED', 'WORKTREE_MISMATCH', 'SCAN_UNREADABLE',
    'TIMEOUT', 'OVER_BUDGET', 'SCAN_INCOMPLETE',
  ])

  /** 快照延迟超过这个毫秒数时，说明"事件时刻"与"真正捕获时刻"之间已隔了文件改动。 */
  const SNAPSHOT_LAG_WARN_MS = 250

  /** 由生效配置构造影子库调用参数。 */
  function snapshotCallOptions(cfg, root, sessionId) {
    return {
      stateDir: cfg.stateDir,
      root,
      session: sessionId,
      excludeGlobs: cfg.snapshotExcludeGlobs,
      ignorePolicy: cfg.snapshotIgnorePolicy,
      budget: { maxFiles: cfg.snapshotMaxFiles, maxBytes: cfg.snapshotMaxBytes, scanMs: cfg.snapshotScanMs },
      timeoutMs: cfg.snapshotTimeoutMs,
      autoExcludeOversized: cfg.snapshotAutoExcludeOversized === true,
    }
  }

  /** 自动排除必须记账（契约 §10.4 第 6 条）；只在集合变化时写 note，避免刷屏。 */
  function noteAutoExcluded(cfg, result) {
    const excluded = Array.isArray(result.autoExcluded) ? result.autoExcluded : []
    if (excluded.length === 0) return
    const signature = excluded.join(',')
    if (snapshotRuntime.lastAutoExcluded.join(',') === signature) return
    snapshotRuntime.lastAutoExcluded = excluded.slice()
    ctx.logger.warn(`[audit-rollback] 快照自动排除 ${excluded.length} 个超限顶层项：${signature}（审计覆盖面已缩小）`)
    if (stateReady) {
      appendEntry(cfg.stateDir, { kind: 'note', text: `快照自动排除超限顶层项：${signature}` })
    }
  }

  /** 环境性失败一律熔断：写一次 note、告警一次，此后本实例不再尝试（契约 §10.4 第 1 条）。 */
  function fuseIfEnvironmental(cfg, reason, where) {
    if (snapshotRuntime.fused !== null) return
    ctx.logger.warn(`[audit-rollback] 边界快照未生效 ${where}: ${reason}`)
    if (FUSING_REASONS.has(reason) !== true) return
    snapshotRuntime.fused = { reason }
    ctx.logger.warn(`[audit-rollback] 影子库快照已降级并熔断（${reason}）：本实例后续不再尝试，直到插件重载`)
    if (stateReady) {
      appendEntry(cfg.stateDir, { kind: 'note', text: `影子库快照熔断：${reason}（本实例后续不再尝试）` })
    }
  }

  /**
   * 在边界写快照，并在 end 时把归属路径写进账本。
   *
   * 三条硬约束（都在 2026-10-11 的独立复核里被实证过缺一即错）：
   *   1. start/end **按 (session, turn, step) 配对**——只按会话配对时，交错事件会让 end 配到别人的 start，
   *      使归属的 `from` 与它声明的 turn/step 脱节（而归属是回滚的唯一依据）；
   *   2. start 失败时**不写归属**——否则 end 侧会把整棵树当成"新增"，产出垃圾归属集合；
   *   3. 失败只 warn / note，绝不抛出：快照不得影响轮次推进（契约 §10.10）。
   */
  function scheduleBoundarySnapshot({ cfg, root, sessionId, turn, step, phase, eventAt }) {
    enqueueSnapshot(async () => {
      if (snapshotDisposed || snapshotRuntime.fused !== null) return
      const key = boundaryKeyOf(sessionId, turn, step)
      const lagMs = Number.isFinite(eventAt) ? Math.max(0, Date.now() - eventAt) : undefined
      try {
        const options = snapshotCallOptions(cfg, root, sessionId)
        if (phase === 'start') {
          const started = await captureBoundary({ ...options, turn, step, phase: 'start', lagMs })
          noteAutoExcluded(cfg, started)
          if (started.ledgerOk !== true) ctx.logger.warn(`[audit-rollback] 开始快照审计写入失败：${started.ledgerError}`)
          if (started.ok === true) {
            pendingBoundaries.set(key, { turn, step, tree: started.tree })
          } else {
            pendingBoundaries.delete(key)
            fuseIfEnvironmental(cfg, started.reason, `${sessionId}/${turn}#${step}`)
          }
          return
        }
        // end：只认同一 (turn, step) 的 start；不匹配就只留 end 快照，不写归属
        const pending = pendingBoundaries.get(key)
        pendingBoundaries.delete(key)
        const ended = await captureBoundary({ ...options, turn, step, phase: 'end', lagMs })
        noteAutoExcluded(cfg, ended)
        if (ended.ledgerOk !== true) ctx.logger.warn(`[audit-rollback] 结束快照审计写入失败：${ended.ledgerError}`)
        if (ended.ok !== true) {
          fuseIfEnvironmental(cfg, ended.reason, `${sessionId}/${turn}#${step}`)
          return
        }
        if (pending === undefined || typeof pending.tree !== 'string') return

        const attributed = await recordAttribution({ ...options, turn, step, from: pending.tree, to: ended.tree })
        if (attributed.ledgerOk !== true) ctx.logger.warn(`[audit-rollback] 归属审计写入失败：${attributed.ledgerError}`)
        if (attributed.ok !== true) {
          ctx.logger.warn(`[audit-rollback] 归属计算失败 ${sessionId}/${turn}#${step}: ${attributed.reason}`)
          return
        }
        // 追拍窗口过大时 start 树可能已在改动之后才捕获 → 这一步的归属不可信，必须记账而不是静默
        if (attributed.paths.length === 0 && Number.isFinite(lagMs) && lagMs > SNAPSHOT_LAG_WARN_MS && stateReady) {
          appendEntry(cfg.stateDir, {
            kind: 'note',
            text: `边界快照延迟 ${lagMs}ms（阈值 ${SNAPSHOT_LAG_WARN_MS}ms）：turn ${turn} step ${step} 的归属可能不完整（start 树可能在文件改动之后才捕获）`,
          })
        }
      } catch (error) {
        ctx.logger.warn(`[audit-rollback] 边界快照异常: ${error && error.message ? error.message : error}`)
      }
    })
  }

  /**
   * 事件 → 边界快照的唯一入口：按 `snapshotMode` 过滤事件层级。
   * `step === TURN_LEVEL_STEP` 表示轮级事件；per-step 模式只认步级，per-turn 只认轮级。
   */
  function scheduleShadowBoundary({ cfg, session, sessionId, turn, step, phase }) {
    if (cfg.gitSnapshot !== true || stateReady !== true) return
    if (snapshotRuntime.fused !== null) return // 已熔断：不再重试、不再重复告警
    const isTurnLevel = step === TURN_LEVEL_STEP
    if ((cfg.snapshotMode === 'per-step') === isTurnLevel) return
    const root = cwdOf(session)
    if (typeof root !== 'string' || root.length === 0) return
    // 本函数在事件处理器里**同步**调用，因此这里的时刻即"事件时刻"，
    // 用于度量"事件 → 真正捕获"的延迟（滞后过大说明 start 树可能失真）。
    scheduleBoundarySnapshot({ cfg, root, sessionId, turn: turn >= 0 ? turn : -1, step, phase, eventAt: Date.now() })
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
        slot.config = readConfig()
        appendEntry(slot.config.stateDir, { kind: 'turn/start', session: id, turn, cwd: cwdOf(session) ?? '' })
        scheduleShadowBoundary({ cfg: slot.config, session, sessionId: id, turn, step: TURN_LEVEL_STEP, phase: 'start' })
      } else if (event.type === 'step/start' || event.type === 'step/end') {
        // 阶段 B：步级边界（只有 per-step 模式会真的落快照，由 scheduleShadowBoundary 判定）
        const step = event.data && typeof event.data.step === 'number' ? event.data.step : TURN_LEVEL_STEP
        scheduleShadowBoundary({
          cfg: slot.state !== null ? slot.config : readConfig(),
          session,
          sessionId: id,
          turn: turn >= 0 ? turn : slot.turn,
          step,
          phase: event.type === 'step/start' ? 'start' : 'end',
        })
      } else if (event.type === 'turn/end') {
        scheduleShadowBoundary({
          cfg: slot.state !== null ? slot.config : readConfig(),
          session,
          sessionId: id,
          turn: turn >= 0 ? turn : slot.turn,
          step: TURN_LEVEL_STEP,
          phase: 'end',
        })
        // 轮结束：清掉本会话**该轮**所有未配对的 start，防止跨轮残留被后来的 end 误配
        const endingTurn = turn >= 0 ? turn : slot.turn
        if (endingTurn >= 0) {
          // 必须排在 end 捕获与归属之后；同步清理会提前删掉已完成的 start。
          enqueueSnapshot(() => {
            const prefix = `${id}|${endingTurn}|`
            for (const key of pendingKeysOf(id)) if (key.startsWith(prefix)) pendingBoundaries.delete(key)
          })
        }
        if (slot.state !== null) {
          captureAfterOnce(id, slot)
          appendEntry(slot.config.stateDir, {
            kind: 'turn/end',
            session: id,
            turn: slot.turn,
            captured: slot.state.capturedPaths.size,
          })
          slot.state = null // 清理本轮内存态，会话槽位留给下一轮
        } else {
          // 内存态已丢（重载/中途加载）：轮号只能取自事件，槽位里的还是 -1。
          const endTurn = turn >= 0 ? turn : slot.turn
          if (endTurn >= 0) {
            const captured = recoverTurnEnd(id, endTurn)
            if (captured !== null) {
              ctx.logger.warn(
                `[audit-rollback] 轮次 ${id}/${endTurn} 的内存态已丢失（插件重载或中途加载），` +
                `已回扫账本补写 ${captured} 个后像与 turn/end 条目`,
              )
            }
          }
        }
      }
    } catch (error) {
      ctx.logger.warn(`[audit-rollback] session/event 处理失败: ${error && error.message ? error.message : error}`)
    }
  })

  const offDisposed = ctx.on('session/disposed', (session) => {
    const id = sessionIdOf(session)
    // 会话销毁时同清未配对的 start 残留（否则后续 end 可能配到已消失会话的树）
    enqueueSnapshot(() => {
      for (const key of pendingKeysOf(id)) pendingBoundaries.delete(key)
    })
    sessions.delete(id)
  })

  // tools/pre-execute：记 call + 捕获 before；绝不能改变调用结果（契约第 5.2 节）
  const offPreExecute = ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      try {
        const session = exec && exec.agent ? exec.agent.session : undefined
        const id = sessionIdOf(session)
        const slot = session !== undefined ? slotFor(session) : { turn: -1, state: null }
        const config = slot.state !== null ? slot.config : readConfig()
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
            // Do not persist raw tool arguments (file content, credentials, tokens).
            argsSha1: sha1Hex(Buffer.from(previewArgs({ keys: Object.keys(exec.arguments ?? {}) }, config.argsMaxBytes), 'utf8')),
            argsPreview: previewArgs({ keys: Object.keys(exec.arguments ?? {}) }, config.argsMaxBytes),
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
            tool: toolName,
            callId: typeof exec.callId === 'string' ? exec.callId : '',
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
  ctx.effect(() => async () => {
    snapshotDisposed = true
    offSessionEvent()
    offDisposed()
    offPreExecute()
    // 已在运行的子进程有超时；等待其结束，排队中尚未开始的快照不再执行。
    await snapshotChain
    pendingBoundaries.clear()
    sessions.clear()
  })
}
