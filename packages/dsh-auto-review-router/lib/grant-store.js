/**
 * 人工放行后的「已授权目录」记忆 —— 询问抑制器，不是权限收窄器。
 *
 * 为什么需要：核心的审批结果是封闭枚举，`'allowed-once' is the only grant`
 * （dsh-user-approval/lib/index.js:124），授权只对单次请求生效。于是同一条项目目录外
 * 的中风险操作会被反复问人，人工继承退化成永久打断。
 *
 * 设计依据：docs/codex-approval-sandbox-reference.md（2026-10-05 调研）。
 * 抄 Codex 的两点：① 记忆键锚定**规范化后的实际目标**而非 UI/模型展示串
 *   （GitHub issue #4212 就是因为键绑在展示串上而反复失效）；② 授权范围是
 *   「目录 + 操作类别」而非整条命令（Codex 官方 on_request.md 明确要求）。
 *
 * 明确的边界：本模块只决定「是否还要再问一次」。它不授予任何沙箱或权限预设，
 * 命中的调用仍走完整的上游门与下游门。核心的 `never` 策略在 waterfall 之前
 * 就返回 rejected（dsh-user-approval/lib/index.js:175），此时本模块完全不参与。
 *
 * 安全红线（缺一条即重新问，全部来自调研文档 §5.6）：
 * R2 敏感前缀（.git/.codex/.agents/.ssh/*.env）不受记忆抑制
 * R3 删除类操作永不记忆
 * R4/R5 never 策略与已是 danger-full-access 时不询问也不记忆（由调用方保证）
 * R6 只有用户显式放行才写入
 * R7 规范化失败或逃逸出已授权根 → fail closed
 * R8 过宽的根（盘根、用户 profile 根、系统目录）永不记忆
 * R9 跨卷/跨逻辑边界不记忆
 * R10 使用次数或时效超限 → 重新问一次
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

/** 与 dsh-audit-rollback 的 canonicalPathKey 同口径：win32 下小写归一。 */
export function canonicalPathKey(value) {
  const text = typeof value === 'string' ? value : ''
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/**
 * 官方路径规范化。语义与 dsh-sandbox 的 canonicalPath 一致：
 * 解析失败时返回原样（缺失路径此刻匹配不到任何授权根，是保守结果）。
 * 优先复用官方导出；取不到时退回本地等价实现，绝不自己发明规则。
 */
function officialCanonicalPath() {
  // 动态取，避免把 dsh-sandbox 变成硬依赖（peer 版本差异会让插件整体加载失败）。
  try {
    // eslint-disable-next-line
    const mod = globalThis.__dshSandboxCanonicalPath
    return typeof mod === 'function' ? mod : null
  } catch { return null }
}

let injectedCanonical = null
/** 供 Loader 与测试注入官方 canonicalPath；未注入时用本地等价实现。 */
export function setCanonicalPath(fn) { injectedCanonical = typeof fn === 'function' ? fn : null }

function canonicalize(target) {
  if (injectedCanonical !== null) {
    try { return injectedCanonical(target) } catch { /* 落到本地实现 */ }
  }
  const fallback = officialCanonicalPath()
  if (fallback !== null) {
    try { return fallback(target) } catch { /* 落到本地实现 */ }
  }
  return target
}

/**
 * 目标路径所属目录的 key。
 * 输入既可能是目录也可能是文件（工具参数给的是文件），一律取其**父目录**：
 * 授权粒度是「目录 + 操作类别」，若把文件名当成目录名，授权会退化成单文件，
 * 同目录的其它文件仍要反复问——正好是本功能要消除的痛点。
 */
function directoryKey(target) {
  const normalized = resolve(target)
  const root = parse(normalized).root
  const withoutTrailing = normalized.length > root.length && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized
  // 去掉末段：调用方给的是文件路径。已经是目录的调用方传父目录即可。
  const trimmed = withoutTrailing === root ? withoutTrailing : dirname(withoutTrailing)
  return canonicalPathKey(trimmed)
}

function isInside(childKey, parentKey) {
  if (childKey === parentKey) return true
  return childKey.startsWith(parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`)
}

/** 目标所在卷（win32 盘符或 POSIX 挂载点），跨卷不记忆（R9）。 */
function volumeOf(key) {
  const root = parse(key).root.toLowerCase()
  return root
}

/**
 * 永远不记忆的目标：敏感目录与过宽的根。
 * Codex 对这些路径是硬性只读保护，DSH 没有等价表达，只能靠重新问近似（R2/R8）。
 */
const PROTECTED_SEGMENTS = new Set(['.git', '.codex', '.agents', '.ssh', '.gnupg'])
const NEVER_GRANT_ROOTS = new Set(['c:\\', 'c:\\users', 'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
  'c:\\programdata', 'c:\\users\\public'])
const SYSTEM_DIR_NAMES = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'system32', 'users', '$recycle.bin'])

/**
 * 匹配时用：目标相对已授权根的路径里是否含受保护段（.git/.env 等）。
 * Codex 对这些路径是硬性只读，DSH 只能靠重新问近似（R2）。
 */
function isProtectedTarget(dirKey, rootKey) {
  const relative = dirKey.slice(rootKey.length).replace(/^[\\/]+/, '')
  if (!relative) return false
  for (const segment of relative.split(/[\\/]+/)) {
    if (PROTECTED_SEGMENTS.has(segment.toLowerCase())) return true
  }
  return /\.env$/i.test(relative) || /(^|[\\/])\.env\.[^\\/]+$/i.test(relative)
}

/**
 * 授权目录自身是否不可授权：路径里含受保护段，或末段形如 .env*。
 * 只看**授权键自身**——不扫盘（避免 TOCTOU 与性能代价）。
 * 目录里「恰好存在」.env 这类情况由匹配时的 isProtectedTarget 兜住：
 * 该目录被授权后，往其中的 .git/.env 写入依然每次重新问。
 */
function isSelfProtected(dirKey) {
  const root = parse(dirKey).root
  for (const segment of dirKey.slice(root.length).split(/[\\/]+/)) {
    if (segment !== '' && PROTECTED_SEGMENTS.has(segment.toLowerCase())) return true
  }
  return /\.env$/i.test(dirKey) || /(^|[\\/])\.env\.[^\\/]+$/i.test(dirKey)
}

/**
 * 过宽的根判定：命中固定黑名单，或路径层级不足（盘根 / 用户 profile 根 / 系统目录）。
 * 用层级数表达而非写死各机器的用户名，避免换台机器就漏判。
 */
function isTooBroadRoot(dirKey) {
  if (NEVER_GRANT_ROOTS.has(dirKey)) return true
  const root = parse(dirKey).root
  const segments = dirKey.slice(root.length).split(/[\\/]+/).filter(part => part !== '')
  if (segments.length <= 1) return true                                  // 盘根、C:\Users、C:\Windows
  if (segments.length === 2 && SYSTEM_DIR_NAMES.has(segments[0].toLowerCase())) return true
  // C:\Users\<name> 是用户 profile 根：授权它等于授权整个用户目录，同样过宽。
  if (segments.length === 2 && segments[0].toLowerCase() === 'users') return true
  return false
}

/** 从工具参数取目标路径（只认白名单键；相对路径不猜，识别不出返回 undefined）。 */
export function targetPathOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'notebook_path']) {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) continue
    if (!isAbsolute(value)) return undefined
    return value
  }
  return undefined
}

/**
 * 判定操作类别。删除类永不记忆（R3）；识别不出返回 undefined（fail closed）。
 * @returns {'create'|'edit'|'rename'|'delete'|'delete-recursive'|undefined}
 */
export function operationClassOf(toolName, args) {
  if (typeof toolName !== 'string' || toolName === '' || args === null || typeof args !== 'object') return undefined
  const isDir = args.is_directory === true || args.recursive === true
  const destructive = toolName === 'delete' || toolName === 'remove' || toolName === 'rm' || toolName === 'unlink'
    || toolName === 'rmdir' || toolName === 'rmtree'
  if (destructive) return isDir ? 'delete-recursive' : 'delete'
  if (toolName === 'write' || toolName === 'create') return 'create'
  if (toolName === 'edit' || toolName === 'str_replace_editor' || toolName === 'patch' || toolName === 'apply_patch') {
    return isDir ? undefined : 'edit'
  }
  if (toolName === 'rename' || toolName === 'move' || toolName === 'mv') return 'rename'
  return undefined
}

const GRANTABLE_OPS = new Set(['create', 'edit', 'rename'])

function parseGrant(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { v, dir, opClass, tool, session, approvalRequestId, at, useCount } = raw
  if (v !== 1) return null
  if (typeof dir !== 'string' || dir === '' || dir.length > 1024) return null
  if (!GRANTABLE_OPS.has(opClass)) return null
  if (typeof tool !== 'string' || tool.length > 160) return null
  if (typeof session !== 'string' || session.length > 200) return null
  if (typeof approvalRequestId !== 'string' || approvalRequestId.length > 80) return null
  if (!Number.isSafeInteger(at) || at < 0) return null
  return { v: 1, dir, opClass, tool, session, approvalRequestId, at, useCount: Number.isSafeInteger(useCount) && useCount >= 0 ? useCount : 0 }
}

/**
 * 已授权目录账本。profile 本地 JSONL，单写者、有界、可整体清空。
 * @param {string} filePath 账本绝对路径
 * @param {{ maxGrants?: number, maxUseCount?: number, maxAgeMs?: number }} [options]
 */
export function createGrantStore(filePath, options = {}) {
  const maxGrants = Number.isInteger(options.maxGrants) && options.maxGrants > 0 ? options.maxGrants : 200
  const maxUseCount = Number.isInteger(options.maxUseCount) && options.maxUseCount > 0 ? options.maxUseCount : 100
  const maxAgeMs = Number.isInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : 30 * 24 * 3600 * 1000
  let grants = null
  let writable = true

  function load() {
    if (grants !== null) return grants
    grants = []
    try {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (!line) continue
        let parsed = null
        try { parsed = JSON.parse(line) } catch { continue }
        const grant = parseGrant(parsed)
        if (grant !== null) grants.push(grant)
      }
      if (grants.length > maxGrants) grants = grants.slice(grants.length - maxGrants)
    } catch {
      // 账本不存在是正常的首次状态；读失败按「无可信记忆」处理（继续问人）。
      grants = []
    }
    return grants
  }

  /**
   * 该目标是否已被人工授权过。仅 medium 风险、且调用方已确认策略允许时使用。
   * @param {string} rawPath 目标绝对路径（内部会规范化，不信任传入字符串）
   * @param {string} opClass 操作类别
   * @returns {{ hit: boolean, reason?: string }} hit=false 时带原因，便于记账
   */
  function check(rawPath, opClass) {
    if (typeof rawPath !== 'string' || rawPath === '') return { hit: false, reason: 'no-path' }
    if (!GRANTABLE_OPS.has(opClass)) return { hit: false, reason: 'not-grantable-op' }
    // 敏感判定必须看**完整目标路径**（含文件名）：只按目录判会把 x.env 当成普通目录放过。
    if (isSelfProtected(canonicalPathKey(canonicalize(rawPath)))) return { hit: false, reason: 'protected-path' } // R2
    const targetKey = directoryKey(canonicalize(rawPath))
    const targetVolume = volumeOf(targetKey)
    for (const grant of load()) {
      if (!isInside(targetKey, grant.dir)) continue
      if (grant.opClass !== opClass) continue
      if (volumeOf(grant.dir) !== targetVolume) return { hit: false, reason: 'cross-volume' } // R9
      if (isProtectedTarget(targetKey, grant.dir)) return { hit: false, reason: 'protected-path' } // R2
      if (isTooBroadRoot(grant.dir)) return { hit: false, reason: 'root-too-broad' } // R8
      if (grant.useCount >= maxUseCount) return { hit: false, reason: 'use-limit' } // R10
      if (Date.now() - grant.at > maxAgeMs) return { hit: false, reason: 'expired' } // R10
      grant.useCount += 1
      return { hit: true, dir: grant.dir }
    }
    return { hit: false, reason: 'not-granted' }
  }

  /**
   * 记住一次人工放行（R6：只由用户显式放行触发）。落盘失败返回 false，
   * 调用方据此继续走「再问一次」——记不住就问，绝不静默放行。
   */
  function remember(rawPath, opClass, evidence) {
    if (!writable) return { ok: false, reason: 'store-unwritable' }
    if (typeof rawPath !== 'string' || rawPath === '') return { ok: false, reason: 'no-path' }
    if (!GRANTABLE_OPS.has(opClass)) return { ok: false, reason: 'not-grantable-op' }
    if (evidence === null || typeof evidence !== 'object') return { ok: false, reason: 'no-evidence' }
    const { session, tool, approvalRequestId } = evidence
    if (typeof session !== 'string' || session === '' || typeof tool !== 'string' || tool === ''
      || typeof approvalRequestId !== 'string' || approvalRequestId === '') return { ok: false, reason: 'bad-evidence' }
    const dirKey = directoryKey(canonicalize(rawPath))
    if (isTooBroadRoot(dirKey)) return { ok: false, reason: 'root-too-broad' }
    if (isSelfProtected(dirKey)) return { ok: false, reason: 'protected-path' }
    const current = load()
    if (current.some(grant => grant.dir === dirKey && grant.opClass === opClass)) return { ok: true, reason: 'already' }
    const grant = { v: 1, dir: dirKey, opClass, tool, session, approvalRequestId, at: Date.now(), useCount: 0 }
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      appendFileSync(filePath, `${JSON.stringify(grant)}\n`, 'utf8')
    } catch {
      writable = false
      return { ok: false, reason: 'write-failed' }
    }
    current.push(grant)
    if (current.length > maxGrants) current.splice(0, current.length - maxGrants)
    return { ok: true, reason: 'stored' }
  }

  return {
    check,
    remember,
    list() { return load().map(grant => ({ ...grant })) },
    /** 全部清空（供设置页「撤销所有已授权目录」）。 */
    clear() {
      try { mkdirSync(dirname(filePath), { recursive: true }); appendFileSync(filePath, '', 'utf8') } catch { return false }
      grants = []
      return true
    },
  }
}

/** 账本默认位置：与审批历史同在 profile 目录下。 */
export function grantLedgerPath(profileDir) {
  return join(profileDir, 'dsh-auto-review-router', 'granted-directories.jsonl')
}

export { directoryKey, isInside, volumeOf, isProtectedTarget, isTooBroadRoot }
