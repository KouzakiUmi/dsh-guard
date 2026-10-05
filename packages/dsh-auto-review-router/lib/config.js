import z from '@deepseek-ai/schemastery'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false, reviewerProvider: '', reviewerModel: '', reviewerEffort: '',
  fallbackToSessionRoute: true, maxContextBytes: 32768, historyLimit: 20,
  includeProjectInstructions: true, temperature: 0, timeoutMs: 20000, logDecisions: true,
  manualFallback: true, manualApprovalTimeoutMs: 60000,
})

/** Cross-field validation runs inside official resolveConfig, before persistence. */
export function validateConfig(config) {
  const provider = config.reviewerProvider.trim()
  const model = config.reviewerModel.trim()
  if (Boolean(provider) !== Boolean(model)) throw new Error('reviewerProvider 与 reviewerModel 必须同时填写或同时留空')
  if (config.reviewerEffort.trim() && !provider) throw new Error('reviewerEffort 需要完整的 reviewer 路由')
  if (config.enabled && !config.fallbackToSessionRoute && !provider) throw new Error('启用且关闭回退时必须填写 reviewer 路由')
  const manualApprovalTimeoutMs = config.manualApprovalTimeoutMs ?? DEFAULT_CONFIG.manualApprovalTimeoutMs
  if (!Number.isInteger(manualApprovalTimeoutMs) || manualApprovalTimeoutMs < 1000 || manualApprovalTimeoutMs > 300000) throw new Error('manualApprovalTimeoutMs 必须为 1000–300000 毫秒的整数')
  return { ...config, manualApprovalTimeoutMs, reviewerProvider: provider, reviewerModel: model, reviewerEffort: config.reviewerEffort.trim() }
}

const fields = z.object({
  enabled: z.boolean().default(false),
  reviewerProvider: z.string().default(''),
  reviewerModel: z.string().default(''),
  reviewerEffort: z.string().default(''),
  fallbackToSessionRoute: z.boolean().default(true),
  maxContextBytes: z.number().step(1).min(1).max(1048576).default(32768),
  historyLimit: z.number().step(1).min(0).max(1000).default(20),
  includeProjectInstructions: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0),
  timeoutMs: z.number().step(1).min(1).max(300000).default(20000),
  logDecisions: z.boolean().default(true),
  manualFallback: z.boolean().default(true),
  manualApprovalTimeoutMs: z.number().step(1).min(1000).max(300000).default(60000),
})

// One root reference makes each operation's snapshot atomic across all fields.
export const Config = z.transform(fields, validateConfig, true).default({}).volatile()

/** Compatibility with direct apply callers; production receives Config.get(). */
export function normalizeConfig(raw) {
  const source = typeof raw?.get === 'function' ? raw.get() : raw
  const cfg = source && typeof source === 'object' ? source : {}
  const result = { ...DEFAULT_CONFIG }
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = typeof cfg[key]?.get === 'function' ? cfg[key].get() : cfg[key]
    if (typeof value !== typeof fallback) continue
    if (typeof value === 'number' && (!Number.isFinite(value) || (key !== 'temperature' && (!Number.isInteger(value) || value < (key === 'historyLimit' ? 0 : 1))))) continue
    result[key] = value
  }
  if (result.manualApprovalTimeoutMs < 1000 || result.manualApprovalTimeoutMs > 300000) result.manualApprovalTimeoutMs = DEFAULT_CONFIG.manualApprovalTimeoutMs
  return Object.freeze(result)
}
