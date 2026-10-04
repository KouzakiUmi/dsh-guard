/**
 * 离线自测。断言名与契约第 8.2 节一一对应，便于机械复核。
 */
import { Buffer } from 'node:buffer'

import { buildReviewContext } from '../lib/context.js'
import './runtime.mjs'
const { apply } = await import('../lib/index.js')
import { REVIEW_POLICY, parseDecision, resolveReviewRoute } from '../lib/policy.js'

let failed = 0

function pass(name) {
  console.log(`PASS ${name}`)
}

function fail(name, error) {
  failed += 1
  const message = error instanceof Error ? error.message : String(error)
  console.error(`FAIL ${name}: ${message}`)
}

function check(name, fn) {
  try {
    fn()
    pass(name)
  } catch (error) {
    fail(name, error)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    pass(name)
  } catch (error) {
    fail(name, error)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? '断言失败')
}

function bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

const LEGAL = [
  { risk: 'low', decision: 'allow' },
  { risk: 'medium', decision: 'allow' },
  { risk: 'medium', decision: 'deny' },
  { risk: 'medium', decision: 'deny', reason: 'scope is wider than authorized' },
  { risk: 'high', decision: 'deny' },
  { risk: 'high', decision: 'deny', reason: 'secret leaves the trust boundary' },
]

check('合法决策解析：6 种合法形状全部通过', () => {
  assert(LEGAL.length === 6, `期望 6 种，实际 ${LEGAL.length}`)
  for (const shape of LEGAL) {
    const parsed = parseDecision(JSON.stringify(shape))
    assert(parsed.risk === shape.risk && parsed.decision === shape.decision, JSON.stringify(shape))
    if (shape.reason === undefined) assert(parsed.reason === undefined, 'allow/无理由 deny 不应带 reason')
    else assert(parsed.reason === shape.reason, 'reason 未保留')
  }
})

function rejects(text, messageIncludes) {
  let caught
  try {
    parseDecision(text)
  } catch (error) {
    caught = error
  }
  if (caught === undefined) throw new Error(`应当抛错：${text}`)
  if (messageIncludes !== undefined && !String(caught.message).includes(messageIncludes)) {
    throw new Error(`错误文案不含「${messageIncludes}」：${caught.message}`)
  }
}

check('非法决策拒绝：low+deny', () => {
  rejects('{"risk":"low","decision":"deny"}')
})

check('非法决策拒绝：high+allow', () => {
  rejects('{"risk":"high","decision":"allow"}')
})

check('非法决策拒绝：allow 带 reason', () => {
  rejects('{"risk":"low","decision":"allow","reason":"no"}')
  rejects('{"risk":"medium","decision":"allow","reason":"no"}')
})

check('非法决策拒绝：重复成员', () => {
  // 覆盖后仍是合法的 low+allow / medium+deny。只有顶层重复成员检测能拦住。
  rejects('{"risk":"low","decision":"allow","risk":"low"}', 'repeats a JSON member')
  rejects('{"risk":"medium","decision":"deny","reason":"a","reason":"b"}', 'repeats a JSON member')
})

check('非法决策拒绝：非 JSON', () => {
  rejects('not json')
  rejects('')
  rejects('```json\\n{"risk":"low","decision":"allow"}')
})

check('非法决策拒绝：数组', () => {
  // 文案必须来自「非对象」分支。去掉 Array.isArray / null 判断后，这条不会再命中该文案。
  rejects('[{"risk":"low","decision":"allow"}]', 'must be one JSON object')
  rejects('null', 'must be one JSON object')
})

check('路由解析：配置齐全 → 用配置路由', () => {
  const resolved = resolveReviewRoute({
    reviewerProvider: 'review-provider',
    reviewerModel: 'review-model',
    reviewerEffort: 'high',
    fallbackToSessionRoute: true,
  }, { provider: 'session-provider', model: 'session-model' })
  assert(resolved.ok === true, '应当成功')
  assert(resolved.route.source === 'config', resolved.route.source)
  assert(resolved.route.provider === 'review-provider' && resolved.route.model === 'review-model', '未使用配置路由')
  assert(resolved.route.reasoningEffort === 'high', '非空 effort 应当附带')
})

check('路由解析：配置为空 + fallbackToSessionRoute: true → 用会话路由', () => {
  const resolved = resolveReviewRoute({
    reviewerProvider: '',
    reviewerModel: '',
    reviewerEffort: '',
    fallbackToSessionRoute: true,
  }, { provider: 'session-provider', model: 'session-model' })
  assert(resolved.ok === true, '应当成功')
  assert(resolved.route.source === 'session', resolved.route.source)
  assert(resolved.route.provider === 'session-provider' && resolved.route.model === 'session-model', '未使用会话路由')
  assert(resolved.route.reasoningEffort === undefined, '会话回退不应附带 effort')
})

check('路由解析：配置不全 + fallback 关 → fail-closed', () => {
  const resolved = resolveReviewRoute({
    reviewerProvider: 'only-provider',
    reviewerModel: '',
    reviewerEffort: 'high',
    fallbackToSessionRoute: false,
  }, { provider: 'session-provider', model: 'session-model' })
  assert(resolved.ok === false, '应当失败')
  assert(typeof resolved.reason === 'string' && resolved.reason.includes('incomplete'), resolved.reason)
})

const pendingAction = {
  mode: 'native',
  name: 'edit',
  description: 'edit one file',
  parameters: { type: 'object' },
  arguments: '{"path":"PENDING-ARG-KEEP"}',
}

function sampleContext(extra) {
  return buildReviewContext({
    policy: `${REVIEW_POLICY}\nPOLICY-BODY-KEEP`,
    cwd: 'D:/review-cwd',
    projectInstructions: [{ source: { kind: 'agent-instructions' }, content: 'PROJECT-BODY-KEEP' }],
    history: [
      { role: 'fact', content: 'H0-OLDEST' },
      { role: 'human-instruction', content: 'H1-MIDDLE' },
      { role: 'constraint', content: 'H2-NEWEST' },
    ],
    historyAvailable: true,
    includeProjectInstructions: true,
    pendingAction,
    maxContextBytes: 1_000_000,
    historyLimit: 20,
    ...extra,
  })
}

check('上下文组装：分区顺序正确', () => {
  const text = sampleContext()
  const titles = ['POLICY', 'ENVIRONMENT', 'PROJECT_INSTRUCTIONS', 'RECENT_HISTORY', 'PENDING_ACTION']
  let cursor = -1
  for (const title of titles) {
    const at = text.indexOf(`${title}\n`)
    assert(at > cursor, `${title} 顺序错误：${at} <= ${cursor}`)
    cursor = at
  }
  assert(text.includes('POLICY-BODY-KEEP'), '策略正文缺失')
  assert(text.includes('D:/review-cwd'), 'cwd 缺失')
  assert(text.includes('PROJECT-BODY-KEEP'), '项目指令缺失')
  assert(text.includes('H0-OLDEST') && text.includes('H2-NEWEST'), '历史缺失')
  assert(text.includes('PENDING-ARG-KEEP'), '待审动作缺失')
  assert(!text.includes('RECENT_HISTORY\n[]'), '空历史不应写成空数组')
})

check('上下文裁剪：先裁 RECENT_HISTORY', () => {
  const full = sampleContext()
  const trimmed = sampleContext({ maxContextBytes: bytes(full) - 1 })
  assert(trimmed.includes('PROJECT-BODY-KEEP'), '尚未裁历史完就动了项目指令')
  assert(trimmed.includes('PROJECT_INSTRUCTIONS'), '项目指令分区不应先消失')
  assert(!trimmed.includes('H0-OLDEST'), '应当先丢掉最旧历史')
  assert(trimmed.includes('H2-NEWEST'), '最新历史应尽量保留')
  assert(trimmed.indexOf('PROJECT_INSTRUCTIONS') < trimmed.indexOf('RECENT_HISTORY'), '裁剪后分区顺序被打乱')
})

check('上下文裁剪：POLICY 不被裁剪', () => {
  const fixed = sampleContext({
    history: [],
    historyAvailable: false,
    projectInstructions: [],
    includeProjectInstructions: false,
  })
  const trimmed = sampleContext({ maxContextBytes: bytes(fixed) })
  assert(trimmed.includes('POLICY-BODY-KEEP'), 'POLICY 正文被裁')
  assert(trimmed.includes(REVIEW_POLICY), '固定策略被裁')
  assert(!trimmed.includes('RECENT_HISTORY'), '预算只够固定分区时仍留下历史')
  assert(!trimmed.includes('PROJECT_INSTRUCTIONS'), '预算只够固定分区时仍留下项目指令')
  assert(trimmed.startsWith('POLICY\n'), 'POLICY 分区丢失')
})

check('上下文裁剪：PENDING_ACTION 不被裁剪', () => {
  const fixed = sampleContext({
    history: [],
    historyAvailable: false,
    projectInstructions: [],
    includeProjectInstructions: false,
  })
  const trimmed = sampleContext({ maxContextBytes: bytes(fixed) })
  assert(trimmed.includes('PENDING_ACTION'), 'PENDING_ACTION 分区丢失')
  assert(trimmed.includes('PENDING-ARG-KEEP'), '待审参数被裁')
  assert(trimmed.includes('"name":"edit"'), '待审动作名称被裁')
})

function decisionStream(text, extraChunks = []) {
  return (async function* () {
    if (extraChunks.length === 0) yield { type: 'text-delta', index: 0, text }
    else {
      for (const chunk of extraChunks) yield chunk
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/**
 * 假 ctx 桩：只记录订阅与模型请求，不连接宿主。
 * plugin-smoke 使用同一形状。
 */
function fakeCtx(options = {}) {
  const listeners = []
  const calls = { registerAuto: 0, stream: 0, info: [], warn: [] }
  const ctx = {
    listeners,
    calls,
    logger: {
      info(line) { calls.info.push(line) },
      warn(line) { calls.warn.push(line) },
    },
    approval: {
      overrideOf() {
        return options.policy ?? 'ask'
      },
    },
    permissionPresets: {
      current() {
        return options.preset ?? 'auto'
      },
      registerAuto(admit) {
        calls.registerAuto += 1
        calls.admit = admit
        if (options.conflict) throw new Error('permission: preset "auto" is already registered')
        return () => { calls.admit = undefined }
      },
      set() {},
    },
    llm: {
      stream(request) {
        calls.stream += 1
        calls.lastRequest = request
        return options.stream(request)
      },
    },
    on(name, listener, opts) {
      const record = { name, listener, opts }
      listeners.push(record)
      return () => {
        const index = listeners.indexOf(record)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  return ctx
}

function session(extra = {}) {
  return {
    header: { cwd: 'D:/review-cwd' },
    requestHeader() {
      return { config: { provider: 'session-provider', model: 'session-model' }, tools: [{ name: 'edit', description: 'edit one file', parameters: { type: 'object' } }] }
    },
    snapshotEvents() {
      return extra.events ?? []
    },
    ...extra,
  }
}

function execOf(overrides = {}) {
  return {
    name: 'edit',
    arguments: { path: 'a.txt', note: 'PENDING-ARG-KEEP' },
    callId: 'call-1',
    rootCallId: 'call-1',
    parent: undefined,
    signal: new AbortController().signal,
    agent: { session: session() },
    ...overrides,
  }
}

async function gate(options, execOverrides = {}, nextImpl) {
  const ctx = fakeCtx(options)
  apply(ctx, {
    enabled: true,
    reviewerProvider: options.reviewerProvider ?? 'review-provider',
    reviewerModel: options.reviewerModel ?? 'review-model',
    reviewerEffort: options.reviewerEffort ?? '',
    fallbackToSessionRoute: options.fallbackToSessionRoute ?? true,
    timeoutMs: options.timeoutMs ?? 20000,
    logDecisions: false,
    maxContextBytes: options.maxContextBytes ?? 32768,
  })
  const sub = ctx.listeners.find((item) => item.name === 'tools/pre-execute')
  if (!sub) throw new Error('未注册 tools/pre-execute')
  let nextCalls = 0
  const downstream = { kind: 'allow', via: 'next' }
  const next = nextImpl ?? (async () => {
    nextCalls += 1
    return downstream
  })
  const result = await sub.listener(execOf(execOverrides), async () => {
    nextCalls += 1
    return nextImpl ? nextImpl() : downstream
  })
  return { ctx, result, nextCalls, downstream }
}

await checkAsync('审查失败 fail-closed：假 llm 流报错', async () => {
  const { result, nextCalls } = await gate({
    stream() {
      return (async function* () {
        throw new Error('upstream broke')
      })()
    },
  })
  assert(result.kind === 'deny', `期望 deny，实际 ${result.kind}`)
  assert(result.kind !== 'ask', '失败不得转人工')
  assert(nextCalls === 0, '失败不得执行下游')
  assert(String(result.reason).includes('failed'), result.reason)
  assert(String(result.reason).includes('upstream broke'), result.reason)
})

await checkAsync('审查失败 fail-closed：返回非法 JSON', async () => {
  const { result, nextCalls } = await gate({
    stream() {
      return decisionStream('this is not a decision')
    },
  })
  assert(result.kind === 'deny', `期望 deny，实际 ${result.kind}`)
  assert(result.kind !== 'ask', '非法输出不得转人工')
  assert(nextCalls === 0, '非法输出不得执行下游')
  assert(String(result.reason).includes('failed'), result.reason)
})

await checkAsync('审查失败 fail-closed：超时', async () => {
  const { result, nextCalls } = await gate({
    timeoutMs: 30,
    stream(request) {
      return (async function* () {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000)
          const onAbort = () => {
            clearTimeout(timer)
            reject(request.signal.reason ?? new Error('aborted'))
          }
          if (request.signal?.aborted) {
            onAbort()
            return
          }
          request.signal?.addEventListener('abort', onAbort, { once: true })
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  assert(result.kind === 'deny', `期望 deny，实际 ${result.kind}`)
  assert(result.kind !== 'ask', '超时不得转人工')
  assert(nextCalls === 0, '超时不得执行下游')
  assert(String(result.reason).includes('failed'), result.reason)
})

await checkAsync('deny + ask → 返回 kind: ask', async () => {
  const { result, nextCalls } = await gate({
    policy: 'ask',
    stream() {
      return decisionStream('{"risk":"medium","decision":"deny","reason":"target not authorized"}')
    },
  })
  assert(result.kind === 'ask', `期望 ask，实际 ${result.kind}`)
  assert(nextCalls === 1, 'ask 分支应先询问下游')
  assert(String(result.reason).includes('target not authorized'), result.reason)
  assert(result.displayReason?.zh?.includes('Auto review 拒绝了此调用'), result.displayReason?.zh)
  assert(typeof result.displayReason?.en === 'string', '缺少英文 displayReason')
})

await checkAsync('deny + never → 返回 kind: deny', async () => {
  const { result, nextCalls } = await gate({
    policy: 'never',
    stream() {
      return decisionStream('{"risk":"high","decision":"deny","reason":"secret exfiltration"}')
    },
  })
  assert(result.kind === 'deny', `期望 deny，实际 ${result.kind}`)
  assert(nextCalls === 0, 'never 下不得继续下游')
  assert(result.info?.name === 'AutoReviewDeniedError', result.info?.name)
  assert(result.info?.code === 'AUTO_REVIEW_DENIED', result.info?.code)
  assert(result.info?.reason === 'secret exfiltration', result.info?.reason)
  assert(String(result.reason).includes('its body was not executed'), result.reason)
})

await checkAsync('allow → 调用 next() 且结果透传', async () => {
  const { result, nextCalls, downstream, ctx } = await gate({
    reviewerProvider: 'review-provider',
    reviewerModel: 'review-model',
    reviewerEffort: 'high',
    stream() {
      return decisionStream('{"risk":"low","decision":"allow"}')
    },
  })
  assert(nextCalls === 1, 'allow 必须调用 next()')
  assert(result === downstream, 'allow 必须透传 next() 的结果')
  assert(ctx.calls.lastRequest?.provider === 'review-provider', '审查请求未使用配置 provider')
  assert(ctx.calls.lastRequest?.model === 'review-model', '审查请求未使用配置 model')
  assert(ctx.calls.lastRequest?.reasoningEffort === 'high', '审查请求未带 effort')
  assert(ctx.calls.lastRequest?.temperature === 0, '温度应为 0')
})

await checkAsync('deny + ask + 下游非 allow → 透传下游结果', async () => {
  const downstreamDeny = { kind: 'deny', via: 'downstream', reason: 'later gate denied' }
  const { result, nextCalls } = await gate({
    policy: 'ask',
    stream() {
      return decisionStream('{"risk":"medium","decision":"deny","reason":"needs a human"}')
    },
  }, {}, async () => downstreamDeny)
  assert(nextCalls === 1, '应当先询问下游')
  assert(result === downstreamDeny, '下游非 allow 时必须原样返回下游结果，不能改成 ask')
  assert(result.kind !== 'ask', '不得改写成 ask')
})

await checkAsync('PTC 内层 run_code 会被审查', async () => {
  const { result, nextCalls, ctx } = await gate({
    policy: 'never',
    stream() {
      return decisionStream('{"risk":"high","decision":"deny","reason":"inner call"}')
    },
  }, { name: 'run_code', parent: { callId: 'outer-run-code' }, schema: { name: 'run_code', description: 'bound inner call', parameters: { type: 'object' } } })
  assert(ctx.calls.stream === 1, '内层 run_code 必须发起审查')
  assert(result.kind === 'deny', `内层审查拒绝应为 deny，实际 ${result.kind}`)
  assert(nextCalls === 0, 'never 下内层拒绝不得直接 next()')
  assert(result.info?.code === 'AUTO_REVIEW_DENIED', result.info?.code)
})

await checkAsync('受保护分区超 maxContextBytes → fail-closed', async () => {
  const { result, nextCalls, ctx } = await gate({
    maxContextBytes: 32,
    stream() {
      return decisionStream('{"risk":"low","decision":"allow"}')
    },
  })
  assert(result.kind === 'deny', `超限应为 deny，实际 ${result.kind}`)
  assert(result.kind !== 'ask', '超限不得转人工')
  assert(nextCalls === 0, '超限不得执行下游')
  assert(ctx.calls.stream === 0, '超限应在发起模型请求前失败')
  assert(String(result.reason).includes('failed'), result.reason)
  assert(String(result.reason).includes('protected sections'), result.reason)
})

await checkAsync('run_code 外层调用不被审查', async () => {
  const { result, nextCalls, downstream, ctx } = await gate({
    stream() {
      throw new Error('外层 run_code 不应发起审查')
    },
  }, { name: 'run_code', parent: undefined })
  assert(nextCalls === 1, '外层 run_code 应直接 next()')
  assert(result === downstream, '外层 run_code 应透传')
  assert(ctx.calls.stream === 0, '外层 run_code 不应调用 llm.stream')
})

if (failed > 0) {
  console.error(`selftest: ${failed} 项失败`)
  process.exit(1)
}
console.log('selftest: 全部通过')
