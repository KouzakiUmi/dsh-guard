/**
 * 审查上下文组装：分区、字节上限、历史降级。纯函数，不依赖 Cordis。
 */
import { isAbsolute, resolve } from 'node:path'

import { HISTORY_ITEM_MAX_BYTES, TRUNCATION_SUFFIX } from './policy.js'

const SECTION_GAP = '\n\n'

/**
 * 把可能是相对路径的 cwd 收成绝对路径。空值交给调用方决定回退。
 * @param {string} cwd
 * @returns {string}
 */
export function absoluteCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  return isAbsolute(cwd) ? cwd : resolve(cwd)
}

/**
 * 按 UTF-8 字节截断，不拆开码点。超长时后缀为 …[truncated]，总长不超过上限。
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateUtf8(text, maxBytes = HISTORY_ITEM_MAX_BYTES) {
  const source = String(text ?? '')
  if (byteLength(source) <= maxBytes) return source
  const suffix = TRUNCATION_SUFFIX
  const suffixBytes = byteLength(suffix)
  const budget = Math.max(0, maxBytes - suffixBytes)
  const bytes = Buffer.from(source, 'utf8')
  let end = Math.min(budget, bytes.length)
  // 续字节（10xxxxxx）说明切在多字节字符中间，往回退。
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}${suffix}`
}

/**
 * 从会话事件抽出项目指令与历史。不可用的事件列表由调用方改走无历史分区。
 * agent-instructions 默认只进项目指令，避免同一段约束占两份预算。
 * @param {readonly object[] | null | undefined} events
 * @param {{ includeProjectInstructions?: boolean, pendingCallId?: string }} [options]
 */
export function extractReviewSources(events, options = {}) {
  const includeProject = options.includeProjectInstructions !== false
  const projectInstructions = []
  const history = []
  if (!Array.isArray(events)) {
    return { projectInstructions, history, historyAvailable: false }
  }
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const source = event.data?.source
      const kind = source?.kind
      if (kind === 'tool') continue
      const content = renderBlocks(event.data?.content)
      if (kind === 'agent-instructions') {
        projectInstructions.push({
          source: plainJson(source),
          content: plainJson(event.data?.content),
        })
        if (!includeProject) history.push({ role: 'constraint', content })
        continue
      }
      history.push({
        role: kind === 'user' ? 'human-instruction' : 'fact',
        content,
      })
      continue
    }
    if (event.type !== 'assistant/message') continue
    const blocks = event.data?.message?.content ?? event.data?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
      if (options.pendingCallId !== undefined && block.id === options.pendingCallId) continue
      history.push({ role: 'fact', content: renderToolCall(block) })
    }
  }
  return { projectInstructions, history, historyAvailable: true }
}

/**
 * 待审动作。arguments 收成规范化 JSON 字符串。外层传输用 native，PTC 内层用 ptc-inner。
 * native schema 来自本次模型请求头；只有 PTC 内层使用执行对象携带的绑定 schema。
 * @param {object} exec
 * @param {{ tools?: readonly object[] } | undefined} requestHeader
 */
export function pendingActionOf(exec, requestHeader) {
  if (typeof exec?.name !== 'string' || exec.name.length === 0) throw new Error('pending tool name is missing')
  const mode = exec.parent === undefined ? 'native' : 'ptc-inner'
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  let schema
  if (mode === 'native') {
    const matches = (Array.isArray(requestHeader?.tools) ? requestHeader.tools : [])
      .filter(value => isRecord(value) && value.name === exec.name)
    if (matches.length !== 1) throw new Error('pending native tool schema is missing or ambiguous in request header')
    schema = matches[0]
  } else {
    schema = exec.schema
    if (!isRecord(schema) || schema.name !== exec.name) throw new Error('pending PTC binding schema is missing or inconsistent')
  }
  if (typeof schema.description !== 'string' || !isRecord(schema.parameters)) {
    throw new Error(`pending ${mode} tool schema is incomplete`)
  }
  return {
    mode,
    name: exec.name,
    description: schema.description,
    parameters: schema.parameters,
    arguments: canonicalJson(exec.arguments),
  }
}

/**
 * 按契约分区顺序拼审查文本，并按逆序裁剪可裁分区。
 * POLICY / ENVIRONMENT / PENDING_ACTION 不裁；裁完仍超限则抛错。
 * @param {object} input
 * @returns {string}
 */
export function buildReviewContext(input) {
  const policy = String(input.policy ?? '')
  const cwd = absoluteCwd(String(input.cwd ?? ''))
  const maxBytes = input.maxContextBytes
  const limit = Number.isInteger(input.historyLimit) && input.historyLimit >= 0 ? input.historyLimit : 20
  const includeProject = input.includeProjectInstructions !== false
  const historyAvailable = input.historyAvailable !== false

  const policySection = `POLICY\n${policy}`
  const environmentSection = `ENVIRONMENT\n${JSON.stringify({ cwd })}`
  const pendingSection = `PENDING_ACTION\n${JSON.stringify(input.pendingAction)}`

  let projectItems = []
  if (includeProject && Array.isArray(input.projectInstructions) && input.projectInstructions.length > 0) {
    projectItems = input.projectInstructions.slice()
  }
  let historyItems = []
  if (historyAvailable && Array.isArray(input.history)) {
    historyItems = input.history.slice(-limit).map((item) => ({
      role: item.role,
      content: truncateUtf8(String(item?.content ?? '')),
    }))
  }

  const render = (projects, history) => {
    const parts = [policySection, environmentSection]
    if (projects.length > 0) parts.push(`PROJECT_INSTRUCTIONS\n${JSON.stringify(projects)}`)
    if (history.length > 0) parts.push(`RECENT_HISTORY\n${JSON.stringify(history)}`)
    parts.push(pendingSection)
    return parts.join(SECTION_GAP)
  }

  // 先丢掉最旧的历史，再丢掉最旧的项目指令。空分区直接省略，不写空数组。
  while (byteLength(render(projectItems, historyItems)) > maxBytes && historyItems.length > 0) {
    historyItems.shift()
  }
  while (byteLength(render(projectItems, historyItems)) > maxBytes && projectItems.length > 0) {
    projectItems.shift()
  }
  const text = render(projectItems, historyItems)
  if (byteLength(text) > maxBytes) {
    throw new Error(`review context exceeds maxContextBytes (${byteLength(text)} > ${maxBytes}); protected sections were not trimmed`)
  }
  return text
}

/** 对象键排序后的 JSON，用作 arguments 的规范化字符串。 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value)) ?? 'null'
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key])
    return sorted
  }
  return value
}

function renderBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content == null) return ''
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else {
      try {
        parts.push(JSON.stringify(block))
      } catch {
        parts.push('')
      }
    }
  }
  return parts.join('\n')
}

function renderToolCall(block) {
  const name = typeof block.name === 'string' ? block.name : 'tool'
  const args = typeof block.arguments === 'string' ? block.arguments : canonicalJson(block.arguments ?? {})
  return `${name} ${args}`
}

function plainJson(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}
