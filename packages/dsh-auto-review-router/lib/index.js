/**
 * 可指定模型的 Auto 审查门。
 * reviewer 路由来自插件配置；配置不全时按 fallbackToSessionRoute 回退会话路由，否则拒绝。
 * 不 import 任何核心包。内部会话 API 一律探测，探测失败只降级或拒执行。
 */

import { REVIEW_POLICY, parseDecision, resolveReviewRoute } from './policy.js'
import {
  absoluteCwd,
  buildReviewContext,
  extractReviewSources,
  pendingActionOf,
} from './context.js'

/** Cordis 插件名，与 patch 行 id 一致。 */
export const name = 'auto-review-router'

/** 缺一不可的宿主服务。sessions / commands 只做运行时探测。 */
export const inject = ['approval', 'llm', 'permissionPresets', 'tools']

const AUTO_PRESET = 'auto'
const RUN_CODE_NAME = 'run_code'
const FULL_ACCESS_PRESET = 'danger-full-access'
const DENIED_ERROR_NAME = 'AutoReviewDeniedError'
const DENIED_ERROR_CODE = 'AUTO_REVIEW_DENIED'
const CONFLICT_WARN = '官方 dsh-experimental-auto-review 已注册 Auto，本插件无法同时启用；请先禁用其一'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  reviewerProvider: '',
  reviewerModel: '',
  reviewerEffort: '',
  fallbackToSessionRoute: true,
  maxContextBytes: 32768,
  historyLimit: 20,
  includeProjectInstructions: true,
  temperature: 0,
  timeoutMs: 20000,
  logDecisions: true,
})

/**
 * 把 loader 传入的原始配置收成内部结构。未导出 Config schema（不能依赖 cordis）。
 * @param {object | null | undefined} raw
 */
export function normalizeConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: cfg.enabled === true,
    reviewerProvider: asString(cfg.reviewerProvider, DEFAULT_CONFIG.reviewerProvider),
    reviewerModel: asString(cfg.reviewerModel, DEFAULT_CONFIG.reviewerModel),
    reviewerEffort: asString(cfg.reviewerEffort, DEFAULT_CONFIG.reviewerEffort),
    fallbackToSessionRoute: cfg.fallbackToSessionRoute !== false,
    maxContextBytes: positiveInt(cfg.maxContextBytes, DEFAULT_CONFIG.maxContextBytes),
    historyLimit: nonNegativeInt(cfg.historyLimit, DEFAULT_CONFIG.historyLimit),
    includeProjectInstructions: cfg.includeProjectInstructions !== false,
    temperature: typeof cfg.temperature === 'number' && Number.isFinite(cfg.temperature) ? cfg.temperature : DEFAULT_CONFIG.temperature,
    timeoutMs: positiveInt(cfg.timeoutMs, DEFAULT_CONFIG.timeoutMs),
    logDecisions: cfg.logDecisions !== false,
  }
}

/**
 * 插件入口。enabled 为假时不注册任何订阅。
 * @param {object} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger?.info?.('dsh-auto-review-router: 未启用（enabled: false），不注册 Auto 集成。')
    return
  }
  if (typeof ctx.on !== 'function' || typeof ctx.permissionPresets?.registerAuto !== 'function') {
    throw new Error('auto-review-router: 缺少 tools 事件总线或 permissionPresets.registerAuto')
  }

  const state = {
    accepting: true,
    active: new Set(),
    lifecycle: new AbortController(),
    warnedCwd: false,
    warnedHistory: false,
  }
  const handler = (exec, next) => reviewGate(ctx, config, state, exec, next)
  const removeListener = ctx.on('tools/pre-execute', handler, { prepend: true })

  let removeAuto
  try {
    removeAuto = ctx.permissionPresets.registerAuto(() => {
      if (!state.accepting) throw new Error('auto-review-router: 集成正在关闭，拒绝选中 Auto')
    })
  } catch (error) {
    callDisposer(removeListener)
    if (isAutoConflict(error)) {
      ctx.logger?.warn?.(CONFLICT_WARN)
      return
    }
    throw error
  }

  const shutdown = async () => {
    if (!state.accepting) return
    state.accepting = false
    try {
      migrateAutoSessions(ctx)
    } finally {
      state.lifecycle.abort(new Error('auto-review-router 集成已卸载'))
      await Promise.allSettled([...state.active])
      callDisposer(removeAuto)
      callDisposer(removeListener)
    }
  }

  const effect = typeof ctx.effect === 'function' ? ctx.effect : ctx.fiber?.effect
  if (typeof effect === 'function') {
    try {
      effect.call(ctx.fiber ?? ctx, () => shutdown, 'auto-review-router 卸载')
    } catch (error) {
      ctx.logger?.warn?.(`auto-review-router: 无法挂载卸载回调：${errorMessage(error)}`)
    }
  }
}

async function reviewGate(ctx, config, state, exec, next) {
  if (exec?.agent == null) return next()
  if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return next()
  let preset
  try {
    preset = ctx.permissionPresets.current(exec.agent.session)
  } catch (error) {
    return failed(exec.name, error)
  }
  if (preset !== AUTO_PRESET) return next()
  if (!state.accepting || state.lifecycle.signal.aborted || exec.signal?.aborted) {
    return { kind: 'cancel' }
  }

  const ticket = Promise.withResolvers()
  state.active.add(ticket.promise)
  const started = Date.now()
  let routeLabel = 'unresolved'
  try {
    const signal = combineSignals(exec.signal, state.lifecycle.signal, config.timeoutMs)
    const outcome = await bounded(classify(ctx, config, state, exec, signal), signal)
    if (state.lifecycle.signal.aborted || exec.signal?.aborted) return { kind: 'cancel' }
    routeLabel = outcome.routeLabel
    logDecision(ctx, config, exec.name, routeLabel, outcome.decision.risk, outcome.decision.decision, started)
    if (outcome.decision.decision === 'allow') return next()
    if (approvalPolicy(ctx, exec.agent.session) === 'never') return denied(exec.name, outcome.decision.reason)
    const downstream = await next()
    if (state.lifecycle.signal.aborted) return { kind: 'cancel' }
    if (downstream?.kind !== 'allow') return downstream
    return askUser(exec.name, outcome.decision.reason)
  } catch (error) {
    if (state.lifecycle.signal.aborted || exec.signal?.aborted) return { kind: 'cancel' }
    logDecision(ctx, config, exec.name, routeLabel, 'failed', 'deny', started)
    return failed(exec.name, error)
  } finally {
    state.active.delete(ticket.promise)
    ticket.resolve()
  }
}

async function classify(ctx, config, state, exec, signal) {
  const session = exec.agent.session
  const sessionRoute = readSessionRoute(session)
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
    pendingAction: pendingActionOf(exec),
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
  if (typeof ctx.approval?.overrideOf !== 'function') return 'ask'
  try {
    return ctx.approval.overrideOf(session) === 'never' ? 'never' : 'ask'
  } catch {
    return 'ask'
  }
}

function readSessionRoute(session) {
  if (typeof session?.requestHeader !== 'function') return undefined
  try {
    const header = session.requestHeader()
    const provider = header?.config?.provider
    const model = header?.config?.model
    if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
      return { provider, model }
    }
  } catch {
    return undefined
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
  const presets = ctx.permissionPresets
  if (typeof presets?.set !== 'function' || typeof presets?.current !== 'function') return
  for (const session of listSessions(ctx)) {
    try {
      if (presets.current(session) !== AUTO_PRESET) continue
      presets.set(session, FULL_ACCESS_PRESET)
    } catch (error) {
      ctx.logger?.warn?.(`auto-review-router: 迁移 Auto 会话失败：${errorMessage(error)}`)
    }
  }
}

function listSessions(ctx) {
  const sessions = ctx.sessions
  if (typeof sessions?.list !== 'function') return []
  try {
    const listed = sessions.list()
    if (listed == null) return []
    return Array.isArray(listed) ? listed : [...listed]
  } catch {
    return []
  }
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
