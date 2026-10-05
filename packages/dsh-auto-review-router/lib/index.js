/**
 * 可指定模型的 Auto 审查门。
 * reviewer 路由来自插件配置；配置不全时按 fallbackToSessionRoute 回退会话路由，否则拒绝。
 * 使用已声明 peer 的官方 Config schema 与 sandbox-mode setter；设置持久化归官方 Settings。
 */

import { REVIEW_POLICY, parseDecision, resolveReviewRoute } from './policy.js'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Config, DEFAULT_CONFIG, normalizeConfig } from './config.js'
import { createApprovalHistory, parseHistoryRequest, parseHistoryResult } from './approval-history.js'
import { createGrantStore, grantLedgerPath, targetPathOf, operationClassOf, setCanonicalPath } from './grant-store.js'
export { Config, DEFAULT_CONFIG, normalizeConfig }
import {
  absoluteCwd,
  buildReviewContext,
  extractReviewSources,
  pendingActionOf,
} from './context.js'

/** Cordis 插件名，与 patch 行 id 一致。 */
export const name = 'auto-review-router'

/** sessions 必需：禁止在无法枚举现有 Auto 会话时假定关闭安全。 */
export const inject = ['approval', 'llm', 'permissionPresets', 'tools', 'sessions', 'profileContext']

const AUTO_PRESET = 'auto'
const RUN_CODE_NAME = 'run_code'

const DENIED_ERROR_NAME = 'AutoReviewDeniedError'
const DENIED_ERROR_CODE = 'AUTO_REVIEW_DENIED'
const CONFLICT_WARN = '官方 dsh-experimental-auto-review 已注册 Auto，本插件无法同时启用；请先禁用其一'

/**
 * 插件入口。enabled 为假时不发布 Auto；保留 Loader 配置通知以支持热启用。
 * @param {object} ctx
 * @param {object} [rawConfig]
 */
/**
 * 只读诊断。假 ctx 可直接调用：若该 ctx 已经 apply 过，读当时记下的注册结果；
 * 否则只按 `rawConfig ?? ctx.config` 回显配置与路由判定，注册状态为未观察。
 * 不调用 registerAuto，不订阅事件。
 * @param {object} ctx
 * @param {object} [rawConfig]
 */
export function queryRouterStatus(ctx, rawConfig) {
  const live = ctx !== null && typeof ctx === 'object' ? runtimeByCtx.get(ctx) : undefined
  const config = live?.readConfig() ?? normalizeConfig(rawConfig ?? ctx?.config)
  return {
    plugin: 'dsh-auto-review-router',
    enabled: config.enabled,
    registration: {
      observed: live !== undefined,
      attempted: live?.attempted === true,
      registered: live?.registered === true,
      conflict: live?.conflict === true,
      conflictWarning: live?.conflict === true ? CONFLICT_WARN : null,
      closeFailed: live?.closeFailed === true,
      error: live?.error ?? null,
    },
    route: describeRoute(config),
    budget: {
      maxContextBytes: config.maxContextBytes,
      historyLimit: config.historyLimit,
      timeoutMs: config.timeoutMs,
      temperature: config.temperature,
      logDecisions: config.logDecisions,
    },
  }
}

function describeRoute(config) {
  const resolved = resolveReviewRoute(config, undefined)
  if (resolved.ok && resolved.route.source === 'config') {
    return {
      source: 'config',
      provider: resolved.route.provider,
      model: resolved.route.model,
      effort: resolved.route.reasoningEffort ?? null,
      fallbackToSessionRoute: config.fallbackToSessionRoute,
      rejection: null,
    }
  }
  if (config.fallbackToSessionRoute) {
    return {
      source: 'session-fallback',
      provider: null,
      model: null,
      effort: null,
      fallbackToSessionRoute: true,
      rejection: null,
    }
  }
  return {
    source: 'rejected',
    provider: null,
    model: null,
    effort: null,
    fallbackToSessionRoute: false,
    rejection: resolved.ok ? null : resolved.reason,
  }
}

// Host/Client 统一形状：client.js 的 parseStatus 与本函数逻辑逐句一致，改动时两边一起改，
// 互反接受/拒绝样例由 test/status.mjs 回归。
function parseRouterStatus(value) {
  if (!value || typeof value !== 'object' || value.plugin !== 'dsh-auto-review-router') {
    throw new Error('Invalid auto-review-router status')
  }
  const registration = value.registration
  if (!registration || typeof registration !== 'object'
    || typeof registration.observed !== 'boolean' || typeof registration.attempted !== 'boolean'
    || typeof registration.registered !== 'boolean' || typeof registration.conflict !== 'boolean'
    || typeof registration.closeFailed !== 'boolean'
    || (registration.conflictWarning !== null && typeof registration.conflictWarning !== 'string')
    || (registration.error !== null && typeof registration.error !== 'string')) {
    throw new Error('Invalid auto-review-router status.registration')
  }
  if (!value.route || typeof value.route.source !== 'string') throw new Error('Invalid auto-review-router status.route')
  const budget = value.budget
  if (!budget || typeof budget !== 'object'
    || typeof budget.maxContextBytes !== 'number' || typeof budget.historyLimit !== 'number'
    || typeof budget.timeoutMs !== 'number' || typeof budget.temperature !== 'number'
    || typeof budget.logDecisions !== 'boolean') {
    throw new Error('Invalid auto-review-router status.budget')
  }
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
export const routerStatusRemote = {
  package: 'dsh-auto-review-router',
  descriptors: [
    {
      id: 'dsh-auto-review-router#autoReviewRouter/read',
      service: 'autoReviewRouter',
      namespace: 'autoReviewRouter',
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [],
      result: statusCodec('dsh-auto-review-router#RouterStatus', parseRouterStatus),
    },
    {
      id: 'dsh-auto-review-router#autoReviewRouter/history',
      service: 'autoReviewRouter',
      namespace: 'autoReviewRouter',
      method: 'history',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json',
        codec: statusCodec('dsh-auto-review-router#ApprovalHistoryRequest', parseHistoryRequest) }],
      result: statusCodec('dsh-auto-review-router#ApprovalHistoryResult', parseHistoryResult),
    },
  ],
}

/** Read-only business DTO; no Agent lookup and no cold-session activation. */
export async function queryApprovalHistory(ctx, request) {
  const live = runtimeByCtx.get(ctx)
  if (!live?.history) return { ok: false, error: { code: 'history-unavailable', message: '审批历史暂不可用。' } }
  try { return await live.history.history(request) }
  catch { return { ok: false, error: { code: 'history-unavailable', message: '审批历史暂不可用。' } } }
}

const runtimeByCtx = new WeakMap()
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

class RouterStatusRemote {
  read() {
    throw new Error('autoReviewRouter.read 未绑定')
  }
  history(request) {
    throw new Error('autoReviewRouter.history 未绑定')
  }
}
markDirectRemote(RouterStatusRemote.prototype, 'read')
markDirectRemote(RouterStatusRemote.prototype, 'history')

function exposeRouterRemote(ctx) {
  try {
    const service = new RouterStatusRemote()
    service.name = 'autoReviewRouter'
    service.typertRemote = Object.freeze({
      service,
      serviceKey: 'autoReviewRouter',
      namespace: 'autoReviewRouter',
    })
    service.read = function read() {
      return queryRouterStatus(ctx)
    }
    service.history = function history(request) {
      return queryApprovalHistory(ctx, request)
    }
    if (typeof ctx.reflect?.provide === 'function') {
      ctx.reflect.provide('autoReviewRouter', service)
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['typert'], (scope) => {
        const register = () => {
          try {
            if (typeof scope.typert?.register !== 'function') return undefined
            return scope.typert.register({
              package: routerStatusRemote.package,
              face: 'host',
              schemas: [],
              model: { services: [], events: [], objects: [] },
              invocations: routerStatusRemote.descriptors,
            })
          } catch (error) {
            scope.logger?.warn?.(`auto-review-router: remote 描述符注册失败：${error instanceof Error ? error.message : String(error)}`)
            return undefined
          }
        }
        if (typeof scope.effect === 'function') scope.effect(register)
        else register()
      })
    }
  } catch (error) {
    ctx.logger?.warn?.(`auto-review-router: 只读状态暴露失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * historyOptions 是测试专用的审计存储注入缝（如注入永 pending 的 memory fs 验证
 * stall 有界性）；运行时 Loader 只传 (ctx, config)，默认真实 fs 与常规界限不变。
 */
export function apply(ctx, rawConfig, historyOptions) {
  const readConfig = () => normalizeConfig(rawConfig)
  const history = createApprovalHistory(ctx, historyOptions)
  // 授权记忆：与审批历史同在 profile 目录，取不到目录时禁用记忆（退化为每次询问）。
  let grants = null
  try {
    const profileDir = ctx.profileContext?.dir
    if (typeof profileDir === 'string' && profileDir !== '') grants = createGrantStore(grantLedgerPath(profileDir))
  } catch (error) {
    ctx.logger?.warn?.(`auto-review-router: 授权记忆不可用，将每次询问：${error instanceof Error ? error.message : String(error)}`)
    grants = null
  }
  const snap = { readConfig, history, grants, attempted: false, registered: false, conflict: false, closeFailed: false, error: null }
  runtimeByCtx.set(ctx, snap)
  const offHistorySession = ctx.on?.('session/event', (session, event) => history.sessionEvent(session, event))
  const offHistoryResult = ctx.on?.('tools/result', (exec, result) => history.result(exec, result))
  // Registered BEFORE registerAuto/shutdown: Cordis reverse teardown drains the
  // safety generation first, then flushes and removes these passive observers.
  ctx.effect?.(() => async () => {
    await history.close()
    callDisposer(offHistorySession)
    callDisposer(offHistoryResult)
  }, 'auto-review-router 审批历史排空')
  exposeRouterRemote(ctx)
  ctx.inject?.(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  let generation
  let closed = false
  let guard

  /**
   * 停止当前准入代。final=false（热关闭，fiber 还活着）：收紧失败时保留现有 live
   * guard/Auto 注册，报错供下一次 reconcile 重试。final=true（fiber 卸载）：宿主
   * 强制排空不受插件控制——Cordis 会继续移除 guard 监听与调用方所属的 registerAuto
   * effect（官方 README 声明的强析构极限，无公开 API 可阻止），因此失败后只能如实
   * 上报 closeFailed，不得再声称守卫仍保留。
   */
  const stop = (final = false) => {
    if (!generation) return
    const previous = generation
    previous.accepting = false
    previous.lifecycle.abort(new Error('auto-review-router 集成已关闭'))
    // Narrow file access only: never call presets.set(), which also changes approval.
    try { migrateAutoSessions(ctx) }
    catch (error) {
      if (final) {
        generation = undefined
        snap.registered = false
        snap.closeFailed = true
        snap.error = `安全关闭失败：宿主强制卸载可能已移除审查守卫与 Auto 注册，而会话权限未被收紧（仍保持原有模式）；请人工收紧相关会话为只读：${errorMessage(error)}`
        throw new Error(snap.error, { cause: error })
      }
      snap.error = `安全关闭失败，Auto 注册与拒绝守卫仍保留：${errorMessage(error)}`
      throw new Error(snap.error, { cause: error })
    }
    callDisposer(previous.removeAuto)
    generation = undefined
    callDisposer(guard)
    guard = undefined
    snap.registered = false
    snap.closeFailed = false
    snap.error = null
  }
  const reconcile = () => {
    const config = readConfig()
    if (closed || !config.enabled) { stop(); return }
    if (generation?.accepting) return
    if (generation) stop() // Retry a failed narrowing before any new admission.
    if (typeof ctx.on !== 'function' || typeof ctx.permissionPresets?.registerAuto !== 'function') {
      throw new Error('auto-review-router: 缺少 tools 事件总线或 permissionPresets.registerAuto')
    }
    // 关闭失败保留拒绝守卫；成功收紧后撤回，避免误拦后续合法 Auto 所有者。
    guard ??= ctx.on('tools/pre-execute', (exec, next) => {
      const state = generation
      if (!state) {
        if (exec?.agent && ctx.permissionPresets.current(exec.agent.session) === AUTO_PRESET) return { kind: 'cancel' }
        return next()
      }
      return reviewGate(ctx, readConfig(), state, exec, next, history)
    }, { prepend: true })
    const state = { accepting: true, active: new Set(), lifecycle: new AbortController(), warnedCwd: false, warnedHistory: false, grants }
    snap.attempted = true
    snap.conflict = false
    snap.error = null
    try {
      state.removeAuto = ctx.permissionPresets.registerAuto(() => {
        if (closed || !state.accepting || !readConfig().enabled) throw new Error('auto-review-router: 集成正在关闭，拒绝选中 Auto')
      })
      generation = state
      snap.registered = true
      // Cordis disposes effects in reverse order. Each generation's shutdown
      // MUST be registered after registerAuto(), before Auto identity disappears.
      ctx.effect?.(() => shutdown, 'auto-review-router 安全卸载')
    } catch (error) {
      callDisposer(guard)
      guard = undefined
      if (!isAutoConflict(error)) { snap.error = errorMessage(error); throw error }
      snap.conflict = true
      ctx.logger?.warn?.(CONFLICT_WARN)
    }
  }
  // Loader commits the root reference before this synchronous notification.
  ctx.on?.('loader/volatile-update', () => {
    try { reconcile() } catch (error) { snap.error = errorMessage(error); ctx.logger?.warn?.(snap.error) }
  })
  const shutdown = async () => {
    if (closed) return
    closed = true
    const pending = generation ? [...generation.active] : []
    // 收紧失败不能跳过在途取消与审计排空；状态由 stop(final=true) 如实记录。
    // 继续抛出让 Cordis 记录该 effect 失败；宿主仍会继续强制排空其余 effect。
    let stopError
    try { stop(true) } catch (error) { stopError = error }
    await Promise.allSettled(pending)
    await history.drain()
    callDisposer(guard)
    if (stopError) throw stopError
  }
  reconcile()
}
async function reviewGate(ctx, config, state, exec, next, history) {
  if (exec?.agent == null) return next()
  let preset
  try {
    preset = ctx.permissionPresets.current(exec.agent.session)
  } catch (error) {
    return failed(exec.name, error)
  }
  if (preset !== AUTO_PRESET) return next()
  const entry = history.begin(exec)
  const cancelled = () => !state.accepting || state.lifecycle.signal.aborted || exec.signal?.aborted
  if (!config.enabled || cancelled()) {
    history.record(entry, 'reviewer', 'cancel', { cause: 'admission-closed' })
    return { kind: 'cancel' }
  }
  // 外层 PTC 仅在健康启用时豁免审查；保留 token 映射供并发子调用关联。
  if (exec.parent === undefined && exec.name === RUN_CODE_NAME) {
    const downstream = await next()
    if (entry) entry.coreAsk = downstream?.kind === 'ask'
    history.record(entry, 'downstream', downstream?.kind ?? 'failure', { cause: 'ptc-transport' })
    return cancelled() ? { kind: 'cancel' } : downstream
  }

  const ticket = Promise.withResolvers()
  state.active.add(ticket.promise)
  const started = Date.now()
  let routeLabel = 'unresolved', stage = 'reviewer'
  try {
    const signal = combineSignals(exec.signal, state.lifecycle.signal, config.timeoutMs)
    const outcome = await bounded(classify(ctx, config, state, exec, signal), signal)
    if (cancelled()) {
      history.record(entry, 'reviewer', 'cancel', { cause: 'caller-or-lifecycle' })
      return { kind: 'cancel' }
    }
    routeLabel = outcome.routeLabel
    history.record(entry, 'reviewer', outcome.decision.decision, { risk: outcome.decision.risk,
      route: routeLabel, reasonSummary: outcome.decision.reason, durationMs: Date.now() - started })
    logDecision(ctx, config, exec.name, routeLabel, outcome.decision.risk, outcome.decision.decision, started)
    if (cancelled()) return { kind: 'cancel' }
    if (outcome.decision.decision === 'deny'
      && (approvalPolicy(ctx, exec.agent.session) === 'never' || config.manualFallback === false)) {
      return denied(exec.name, outcome.decision.reason)
    }
    stage = 'downstream'
    const downstream = await next()
    if (entry) entry.coreAsk = downstream?.kind === 'ask'
    history.record(entry, 'downstream', downstream?.kind ?? 'failure', {
      ...(downstream?.kind === 'ask' ? { cause: 'handed-to-core-approval' } : {}) })
    if (cancelled()) return { kind: 'cancel' }
    // Never overrule an existing gate's deny/cancel/ask. An ask belongs to Core.
    if (downstream?.kind !== 'allow' || outcome.decision.decision === 'allow') return downstream
    stage = 'manual'
    return await manualFallback(ctx, config, state, exec, outcome.decision, history, entry)
  } catch (error) {
    if (cancelled()) {
      history.record(entry, stage === 'manual' ? 'manual' : stage, stage === 'manual' ? 'cancelled' : 'cancel', { cause: 'caller-or-lifecycle' })
      return { kind: 'cancel' }
    }
    history.record(entry, stage === 'manual' ? 'manual' : stage, stage === 'manual' ? 'unavailable' : 'failure', { cause: `${stage}-failed` })
    logDecision(ctx, config, exec.name, routeLabel, 'failed', 'deny', started)
    return failed(exec.name, error)
  } finally {
    state.active.delete(ticket.promise)
    ticket.resolve()
  }
}

/** 授权记忆访问器：store 缺失时返回一个恒不命中的替身（退化为每次询问）。 */
function grantMemoFor(state, exec) {
  const store = state.grants
  if (store === null || store === undefined) return NOOP_GRANTS
  return store
}

const NOOP_GRANTS = {
  check() { return { hit: false, reason: 'store-unavailable' } },
  remember() { return { ok: false, reason: 'store-unavailable' } },
}

const sessionIdOf = (session) => (session && typeof session.id === 'string' ? session.id : 'unknown')

async function manualFallback(ctx, config, state, exec, decision, history, entry) {
  const { risk, reason } = decision
  // effectivePolicy includes the configured default; overrideOf alone can miss never.
  if (approvalPolicy(ctx, exec.agent.session) === 'never') return denied(exec.name, reason)

  // 授权记忆：仅 medium 风险可被抑制（high 每次必问，policy.js 规定 high 必 deny）。
  // 命中只是「不再打扰」，不改变任何权限——上游 reviewer 与下游门都已各自判过。
  if (risk === 'medium') {
    const memo = grantMemoFor(state, exec)
    const target = targetPathOf(exec.arguments)
    const opClass = operationClassOf(exec.name, exec.arguments)
    if (target !== undefined && opClass !== undefined) {
      let hit = { hit: false, reason: 'no-store' }
      try { hit = memo.check(target, opClass) } catch { hit = { hit: false, reason: 'check-failed' } }
      if (hit.hit) {
        history.record(entry, 'manual', 'allowed-once', { cause: 'granted-directory' })
        return { kind: 'allow' }
      }
      if (entry) entry.grantMissReason = hit.reason
    } else if (entry) {
      entry.grantMissReason = target === undefined ? 'no-target-path' : 'unknown-op-class'
    }
  }

  if (typeof ctx.approval?.request !== 'function') {
    history.manualOutcome(entry, 'unavailable')
    return denied(exec.name, 'official approval channel unavailable')
  }
  const ms = Number.isInteger(config.manualApprovalTimeoutMs) && config.manualApprovalTimeoutMs >= 1000
    && config.manualApprovalTimeoutMs <= 300000 ? config.manualApprovalTimeoutMs : 60000
  const controller = new AbortController()
  const removers = []
  const abort = cause => {
    if (controller.signal.aborted) return
    if (entry) entry.abortCause = cause
    controller.abort(new Error(`auto-review approval ${cause}`))
  }
  for (const [signal, cause] of [[exec.signal, 'caller'], [state.lifecycle.signal, 'lifecycle']]) {
    if (!signal) continue
    const listener = () => abort(cause)
    signal.addEventListener('abort', listener, { once: true })
    removers.push(() => signal.removeEventListener('abort', listener))
    if (signal.aborted) listener()
  }
  if (entry) entry.deadlineAt = Date.now() + ms
  const deadlineMono = performance.now() + ms
  const seconds = Math.ceil(ms / 1000)
  const timer = setTimeout(() => abort('timeout'), ms)
  // 审批提示必须让人看懂「到底要批什么」：把工具名与调用摘要拼进 displayReason。
  const summary = summarizeCall(exec)
  const riskLabel = risk === 'high' ? { en: 'high', zh: '高危' } : { en: 'medium', zh: '中风险' }
  const detail = summary === undefined ? '' : `\n${summary}`
  try {
    const response = await history.invokeManual(entry, () => ctx.approval.request({
      agent: exec.agent, toolName: exec.name, callId: exec.callId,
      reason: `${askUser(exec.name, reason).reason}${summary === undefined ? '' : ` — ${summary}`}`,
      displayReason: {
        en: `Automatic review classified this ${riskLabel.en}-risk call to "${exec.name}" as needing a human decision. Allow once? No response within ${seconds} seconds means rejection.${detail}`,
        zh: `自动审批判断工具「${exec.name}」为${riskLabel.zh}操作，需要你决定是否放行。${seconds}秒未响应自动拒绝。${detail}`,
      },
      signal: controller.signal,
    }))
    // Settle the request deadline BEFORE any audit I/O. A delayed event loop
    // cannot admit a late grant merely because its timer has not run yet.
    if (performance.now() >= deadlineMono) abort('timeout')
    clearTimeout(timer)
    const outcome = ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(response) ? response : 'unavailable'
    const final = controller.signal.aborted ? 'cancelled' : outcome
    history.manualOutcome(entry, final)
    if (!state.accepting || state.lifecycle.signal.aborted || exec.signal?.aborted) return { kind: 'cancel' }
    if (final === 'allowed-once') {
      // R6：只有用户显式放行才写记忆。放行本身即显式授权，写入失败也只是退回「下次再问」。
      if (risk === 'medium' && entry?.approvalRequestId) {
        const memo = grantMemoFor(state, exec)
        const target = targetPathOf(exec.arguments)
        const opClass = operationClassOf(exec.name, exec.arguments)
        if (target !== undefined && opClass !== undefined) {
          try {
            memo.remember(target, opClass, {
              session: sessionIdOf(exec.agent?.session),
              tool: exec.name,
              approvalRequestId: entry.approvalRequestId,
            })
          } catch { /* 记不住就下次再问，不影响本次放行 */ }
        }
      }
      return { kind: 'allow' }
    }
    return denied(exec.name, final === 'cancelled' && entry?.abortCause === 'timeout'
      ? 'manual approval timed out' : `manual approval ${final}`)
  } finally {
    clearTimeout(timer)
    for (const remove of removers) remove()
  }
}

async function classify(ctx, config, state, exec, signal) {
  const session = exec.agent.session
  // One synchronous request-header snapshot pairs route and native tool schema.
  const requestHeader = readRequestHeader(session)
  const sessionRoute = readSessionRoute(requestHeader)
  const resolved = resolveReviewRoute(config, sessionRoute)
  if (!resolved.ok) throw new Error(resolved.reason)
  const cwd = readCwd(session, () => warnOnce(ctx, state, 'cwd', '会话没有 header.cwd，审查环境回退到进程工作目录'))
  const events = readEvents(session, () => warnOnce(ctx, state, 'history', 'snapshotEvents 不可用，本次审查省略历史分区'))
  const extracted = events === null
    ? { projectInstructions: [], history: [], historyAvailable: false }
    : extractReviewSources(events, {
      includeProjectInstructions: config.includeProjectInstructions,
      pendingCallId: exec.callId,
    })
  const text = buildReviewContext({
    policy: REVIEW_POLICY,
    cwd,
    projectInstructions: extracted.projectInstructions,
    history: extracted.history,
    historyAvailable: extracted.historyAvailable,
    pendingAction: pendingActionOf(exec, requestHeader),
    maxContextBytes: config.maxContextBytes,
    historyLimit: config.historyLimit,
    includeProjectInstructions: config.includeProjectInstructions,
  })
  const options = {
    provider: resolved.route.provider,
    model: resolved.route.model,
    system: REVIEW_POLICY,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    temperature: config.temperature,
    signal,
  }
  if (resolved.route.reasoningEffort) options.reasoningEffort = resolved.route.reasoningEffort
  if (typeof ctx.llm?.stream !== 'function') throw new Error('llm.stream is unavailable')
  const decision = await readDecision(ctx.llm.stream(options))
  return { decision, routeLabel: `${resolved.route.source}:${resolved.route.provider}/${resolved.route.model}` }
}

/**
 * 极简分片累加：只要最后一个 text 块，以及它前面的 reasoning 块。
 * finish 不是 stop，或流本身失败，都抛错。
 * @param {AsyncIterable<object>} stream
 */
export async function readDecision(stream) {
  const blocks = new Map()
  const order = []
  let finished = false
  let finishReason
  for await (const chunk of stream) {
    if (finished) throw new Error('reviewer emitted data after its terminal finish')
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'block-start') {
      if (!blocks.has(chunk.index)) {
        order.push(chunk.index)
        blocks.set(chunk.index, { type: chunk.blockType, text: '' })
      }
      continue
    }
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      let block = blocks.get(chunk.index)
      if (block === undefined) {
        order.push(chunk.index)
        block = { type, text: '' }
        blocks.set(chunk.index, block)
      }
      if (block.type === type && typeof chunk.text === 'string') block.text += chunk.text
      continue
    }
    if (chunk.type === 'finish') {
      finished = true
      finishReason = chunk.reason
    }
  }
  if (!finished) throw new Error('reviewer emitted no terminal finish')
  if (finishReason?.kind === 'error' || finishReason?.kind === 'aborted') {
    const code = finishReason.failure?.code ?? 'unknown'
    const message = finishReason.failure?.message ?? finishReason.kind
    throw new Error(`reviewer ended with ${finishReason.kind} ${code}: ${message}`)
  }
  if (finishReason?.kind !== 'stop') {
    throw new Error(`reviewer ended with ${finishReason?.kind ?? 'missing'}`)
  }
  const assembled = order.map((index) => blocks.get(index)).filter(Boolean)
  const final = assembled.at(-1)
  if (final?.type !== 'text') throw new Error('reviewer must end with a text block')
  if (assembled.slice(0, -1).some((block) => block.type !== 'reasoning')) {
    throw new Error('reviewer blocks before the final text must be reasoning')
  }
  return parseDecision(final.text)
}

function denied(toolName, reason) {
  return {
    kind: 'deny',
    reason: `Auto review rejected tool "${toolName}"; its body was not executed`,
    info: {
      name: DENIED_ERROR_NAME,
      code: DENIED_ERROR_CODE,
      ...reason === undefined ? {} : { reason },
    },
  }
}

/**
 * 人工审批请求要展示的具体调用摘要。审批提示必须让人看懂「到底要批什么」，
 * 因此把路径/命令等白名单键拼进 displayReason。
 * 只取白名单键、清理控制字符并裁剪长度；识别不出返回 undefined，绝不猜。
 * 刻意不写入审批历史账本：账本 DTO 无此字段，命令正文亦属敏感内容。
 */
export function summarizeCall(exec) {
  const args = exec && typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : null
  if (args === null) return undefined
  const clean = value => (typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim() : '')
  const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}…` : value)
  const parts = []
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'notebook_path']) {
    const value = clean(args[key])
    if (value) { parts.push(`${key}=${clip(value, 200)}`); break }
  }
  const command = clean(args.command)
  if (command) parts.push(`command=${clip(command, 300)}`)
  for (const key of ['old_string', 'new_string', 'content', 'pattern', 'url', 'glob']) {
    const value = clean(args[key])
    if (value) { parts.push(`${key}=${clip(value, 120)}`); break }
  }
  if (!parts.length) return undefined
  return clip(parts.join('  '), 600)
}

function askUser(toolName, reason) {
  const head = `Auto review denied tool "${toolName}"`
  return {
    kind: 'ask',
    reason: reason === undefined ? head : `${head}: ${reason}`,
    displayReason: reason === undefined ? {
      en: 'Auto review denied this call.',
      zh: 'Auto review 拒绝了此调用。',
    } : {
      en: `Auto review denied this call: ${reason}`,
      zh: `Auto review 拒绝了此调用：${reason}`,
    },
  }
}

function failed(toolName, error) {
  return {
    kind: 'deny',
    reason: `Auto review of tool "${toolName}" failed; its body was not executed: ${errorMessage(error)}`,
  }
}

function approvalPolicy(ctx, session) {
  try {
    const policy = typeof ctx.approval?.effectivePolicy === 'function'
      ? ctx.approval.effectivePolicy(session) : ctx.approval?.overrideOf?.(session)
    return policy === 'never' ? 'never' : 'ask'
  } catch {
    // A policy lookup failure cannot open a new manual approval channel.
    return 'never'
  }
}

function readRequestHeader(session) {
  if (typeof session?.requestHeader !== 'function') return undefined
  try { return session.requestHeader() } catch { return undefined }
}

function readSessionRoute(header) {
  const provider = header?.config?.provider
  const model = header?.config?.model
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
    return { provider, model }
  }
  return undefined
}

function readCwd(session, warn) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return absoluteCwd(cwd)
  warn()
  return absoluteCwd(process.cwd())
}

function readEvents(session, warn) {
  if (typeof session?.snapshotEvents !== 'function') {
    warn()
    return null
  }
  try {
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) {
      warn()
      return null
    }
    return events
  } catch {
    warn()
    return null
  }
}

function warnOnce(ctx, state, key, message) {
  if (state[key === 'cwd' ? 'warnedCwd' : 'warnedHistory']) return
  if (key === 'cwd') state.warnedCwd = true
  else state.warnedHistory = true
  ctx.logger?.warn?.(`auto-review-router: ${message}`)
}

function migrateAutoSessions(ctx) {
  for (const session of listSessions(ctx)) {
    if (ctx.permissionPresets.current(session) !== AUTO_PRESET) continue
    // Official canonical setter preserves approval policy and records the narrowing.
    setSandboxMode(session, 'read-only')
  }
}
function listSessions(ctx) {
  if (typeof ctx.sessions?.list !== 'function') throw new Error('sessions.list 不可用，无法安全关闭 Auto')
  const listed = ctx.sessions.list()
  if (listed == null) throw new Error('sessions.list 未返回会话集合，无法安全关闭 Auto')
  return Array.isArray(listed) ? listed : [...listed]
}

function combineSignals(execSignal, lifecycleSignal, timeoutMs) {
  const signals = [lifecycleSignal]
  if (execSignal) signals.push(execSignal)
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  return AbortSignal.any(signals)
}

function bounded(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('review timed out or aborted')
}

function logDecision(ctx, config, toolName, routeLabel, risk, decision, started) {
  if (!config.logDecisions) return
  const elapsed = Date.now() - started
  ctx.logger?.info?.(`auto-review-router: tool=${toolName} route=${routeLabel} risk=${risk} decision=${decision} elapsedMs=${elapsed}`)
}

function isAutoConflict(error) {
  return errorMessage(error).includes('preset "auto" is already registered')
}

function callDisposer(dispose) {
  if (typeof dispose !== 'function') return
  try {
    dispose()
  } catch {
    // 回滚失败不能掩盖原来的冲突或卸载错误。
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function asString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}
