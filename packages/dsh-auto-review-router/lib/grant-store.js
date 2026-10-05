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
 * 安全红线（缺一条即重新问，全部来自调研文档 §5.6，并按 2026-10-05 独立复核调整）：
 * R1 目标必须落在已授权根之下（verifyAncestors 逐级证明，不是字符串前缀）
 * R2 敏感前缀（.git/.codex/.agents/.ssh/*.env）不受记忆抑制
 * R3 删除类、shell 类与 move/rename 永不记忆
 * R4 会话审批策略为 never 时不询问也不记忆（manualFallback 首句即返回）
 * R5 **已删除**：原写「沙箱已是 danger-full-access 时不记忆」，但核心没有公开的
 *    「读当前沙箱模式」API（dsh-sandbox-policy 只导出 setSandboxMode，overrideOf 是
 *    内部方法），无法可靠实现。留着这条声明等于给不存在的防护背书，故删除。
 * R6 只有用户显式放行才写入
 * R7 路径规范化失败、祖先缺失或任一级是 link/重定向 → fail closed
 * R8 过宽的根（盘根、用户 profile 根、系统与凭据目录）永不记忆
 * R9 跨卷/跨逻辑边界不记忆
 * R10 使用次数或时效超限 → 重新问一次
 */

import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

/** 与 dsh-audit-rollback 的 canonicalPathKey 同口径：win32 下小写归一。 */
export function canonicalPathKey(value) {
  const text = typeof value === 'string' ? value : ''
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/**
 * 路径规范化，语义与 dsh-sandbox 的 canonicalPath 一致：realpath 解析失败时返回原样。
 *
 * 2026-10-05 安全修正：这一层此前是**空操作**——Loader 从未调用 setCanonicalPath，
 * globalThis 上的兜底也无人写入，导致「记忆键锚定 canonicalPath」在运行时为假，
 * 词法比较成了唯一防线（junction 逃逸由此得手）。现在直接用 realpathSync.native，
 * 不再依赖任何注入点；注入式 API 一并删除，避免再次出现「测试注入掩盖生产空转」。
 *
 * 注意：这一层**不是**安全边界。真正的边界是 verifyAncestors ——
 * 它逐级 lstat + realpath 比对，失败即 fail closed。
 */
function canonicalize(target) {
  try { return realpathSync.native(target) } catch { return target }
}



/**
 * 目录归属判定。内部归一大小写（N10）：作为导出 API 时，
 * `isInside('D:\\PROJ\\x', 'd:\\proj')` 必须为真，否则调用方一旦忘记归一
 * 就会得到「明明在里面却不命中」的反直觉结果。
 */
function isInside(childKey, parentKey) {
  const child = canonicalPathKey(childKey)
  const parent = canonicalPathKey(parentKey)
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/**
 * 逐级验证目标路径的祖先链，任何 link / 重定向 / 不一致都判定为不可授权。
 *
 * 2026-10-05 安全修正（HIGH-1/HIGH-2 的根因）：此前 check/remember 只做**词法**比较，
 * `C:\T\safe\dir\evil\pwned.txt` 只要字符串以授权根开头就命中，而 evil 可以是
 * 指向 `C:\T\OUTSIDE` 的 junction —— 实测文件真的落在授权根之外。
 * 同样的手法可让 `dir\cache` 指向 `repo\.git`，绕过 R2 改写 `.git\config`。
 *
 * 判定口径与 dsh-audit-rollback 的 pathGuards 一致（同一套安全模型）：
 * 每级祖先必须是真实目录、非符号链接、realpath 与词法路径一致。
 * 目标文件本身尚不存在是允许的（create 场景），但它的**父目录链**必须全部可信；
 * 父目录链中任何一段不存在也不可信——无法证明它日后不会被换成 junction。
 *
 * @returns {{ ok: true, dirKey: string } | { ok: false, reason: string }}
 */
export function verifyAncestors(targetPath) {
  if (typeof targetPath !== 'string' || targetPath === '') return { ok: false, reason: 'no-path' }
  if (!isAbsolute(targetPath)) return { ok: false, reason: 'not-absolute' }
  const resolved = resolve(targetPath)
  // 与 dsh-audit-rollback/lib/ledger.js 的 UNSAFE_PATH 同口径：词法穿越、
  // \\?\ 长路径前缀与 NTFS ADS 一律拒绝，避免用同一份路径造出两种解释。
  if (resolved !== targetPath) return { ok: false, reason: 'not-canonical-lexical' }
  if (targetPath.includes('\0') || targetPath.split(/[/\\]+/).includes('..')) return { ok: false, reason: 'traversal' }
  if (process.platform === 'win32'
    && (targetPath.slice(2).includes(':') || targetPath.startsWith('\\\\?') || targetPath.startsWith('\\\\'))) {
    return { ok: false, reason: 'unsupported-path-form' }
  }
  const root = parse(resolved).root
  let dir = dirname(resolved)
  for (;;) {
    let info
    try { info = lstatSync(dir) }
    catch (error) {
      // 祖先不存在：无法证明它日后不会被换成 junction，fail closed。
      return { ok: false, reason: `ancestor-missing:${error && error.code ? error.code : 'UNKNOWN'}` }
    }
    if (info.isSymbolicLink()) return { ok: false, reason: 'ancestor-symlink' }
    if (!info.isDirectory()) return { ok: false, reason: 'ancestor-not-directory' }
    let physical
    try { physical = realpathSync.native(dir) }
    catch { return { ok: false, reason: 'ancestor-realpath-failed' } }
    const same = process.platform === 'win32' ? physical.toLowerCase() === dir.toLowerCase() : physical === dir
    // realpath 不一致即说明该级是 junction/重定向点，实际落点不在授权根内。
    if (!same) return { ok: false, reason: 'ancestor-redirected' }
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) return { ok: false, reason: 'walk-stalled' }
    dir = parent
  }
  return { ok: true, dirKey: canonicalPathKey(dirname(resolved)) }
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
const NEVER_GRANT_ROOTS = new Set(['c:\\', 'c:\\users', 'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
  'c:\\programdata', 'c:\\users\\public'])

/**
 * 匹配时用：目标相对已授权根的路径里是否含受保护段（.git/.env 等）。
 * Codex 对这些路径是硬性只读，DSH 只能靠重新问近似（R2）。
 */
function isProtectedTarget(dirKey, rootKey) {
  const relative = dirKey.slice(rootKey.length).replace(/^[\\/]+/, '')
  if (!relative) return false
  for (const segment of relative.split(/[\\/]+/)) {
    const lower = segment.toLowerCase()
    if (PROTECTED_SEGMENTS.has(lower) || PROTECTED_FILE_NAMES.has(lower)) return true
  }
  return /\.env$/i.test(relative) || /(^|[\\/])\.env\.[^\\/]+$/i.test(relative)
}

/**
 * 路径级受保护段：出现在**授权路径任意一层**即拒绝。
 * 2026-10-05 第三轮复核实证（MEDIUM-4）：此前这里只有 5 项，凭据**文件名**
 * （.npmrc / id_rsa / credentials / service-account.json …）完全没纳入 ——
 * 普通项目目录一旦被授权，这些文件的写入就免问。SENSITIVE_SEGMENTS 只被
 * isTooBroadRoot（根级判定）使用，管不到路径级。
 */
const PROTECTED_SEGMENTS = new Set([
  // 版本控制与 agent 状态目录
  '.git', '.codex', '.agents', '.ssh', '.gnupg',
  // DSH 自身状态与记忆
  '.dsh', '.dsh-memory',
  // 包管理器配置（内含 registry 凭据）
  '.npm', '.yarn', '.cargo', '.gem', '.composer', '.m2', '.gradle', '.nuget',
  // 云与容器凭据
  '.aws', '.azure', '.kube', '.docker', '.config', '.password-store', '.keyring', '.vault',
  // 其它 agent 的配置目录
  '.claude', '.gemini', '.cursor', '.copilot',
  // 凭据/密钥目录名
  'secrets', '.secrets', 'credentials', '.credentials', 'keys', '.keys',
])

/** 凭据类**文件名**：出现在路径任一层即拒绝。 */
const PROTECTED_FILE_NAMES = new Set([
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.dockercfg',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', 'credentials.json', 'service-account.json', 'serviceaccount.json',
  'htpasswd', '.htpasswd', '.pgpass', 'my.cnf', 'saml.json', 'local.settings.json',
])

/**
 * 授权目录自身是否不可授权：路径里含受保护段，或末段形如 .env*。
 * 只看**授权键自身**——不扫盘（避免 TOCTOU 与性能代价）。
 * 目录里「恰好存在」.env 这类情况由匹配时的 isProtectedTarget 兜住：
 * 该目录被授权后，往其中的 .git/.env 写入依然每次重新问。
 */
function isSelfProtected(dirKey) {
  const root = parse(dirKey).root
  for (const segment of dirKey.slice(root.length).split(/[\\/]+/)) {
    if (segment === '') continue
    const lower = segment.toLowerCase()
    if (PROTECTED_SEGMENTS.has(lower) || PROTECTED_FILE_NAMES.has(lower)) return true
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
  if (segments.length === 0) return true                                     // 盘根本身
  const lower = segments.map(part => part.toLowerCase())
  // 2026-10-05 第三轮复核实证（MEDIUM-3）：单段早退让 `C:\inetpub`、`C:\secrets`、
  // `C:\recovery` 走不到敏感段循环，整张表被绕过。改为单段也要查表。
  for (const sensitive of SENSITIVE_SEGMENTS) {
    if (lower.includes(sensitive)) return true
  }
  // C:\Users\<name> 是用户 profile 根：授权它等于授权整个用户目录。
  if (lower[0] === 'users' && lower.length >= 2) return true
  return false
}

/**
 * 出现在授权路径任一层即拒绝：这些目录承载凭据、配置、会话记忆或系统文件。
 * 2026-10-05 复核实证（N3）：原名单遗漏了 DSH 自身的记忆目录 `.dsh-memory`
 * （工作区级记忆日志与反思）、其它 agent 的配置目录、以及包管理器凭据目录。
 */
const SENSITIVE_SEGMENTS = new Set([
  // DSH 自身
  '.dsh', '.dsh-memory', 'dsh-memory-palace', '.deepseek-harness',
  // 凭据与密钥
  '.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.kube', '.docker', '.password-store',
  '.keyring', '.vault', 'secrets', '.secrets', 'credentials', '.credentials', 'keys', '.keys',
  // 其它 agent 的配置/记忆
  '.claude', '.gemini', '.cursor', '.copilot', '.aider', '.opencode', '.continue',
  '.windsurf', '.cline', '.config',
  // 包管理器（内含 credentials.xml / .npmrc / gradle.properties 等）
  '.m2', '.gradle', '.nuget', '.ivy2', '.sbt', '.cabal', '.stack',
  '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup', '.gem', '.composer', '.cache',
  // 系统与共享目录
  'appdata', 'programdata', 'system32', 'windows', 'public', 'inetpub', 'perflogs',
  '$recycle.bin', 'recovery', 'sysvol',
  'program files', 'program files (x86)',
])

/**
 * 从工具参数取目标路径（只认白名单键）。
 * 相对路径不猜（cwd 不在授权键内），词法穿越与 \\?\ 前缀直接拒（LOW-3），
 * 与 dsh-audit-rollback/lib/ledger.js 的 UNSAFE_PATH 同口径。
 */
export function targetPathOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'notebook_path']) {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) continue
    if (!isAbsolute(value)) return undefined
    if (value !== resolve(value)) return undefined
    if (value.split(/[/\\]+/).includes('..')) return undefined
    if (process.platform === 'win32' && (value.startsWith('\\\\?') || value.slice(2).includes(':'))) return undefined
    return value
  }
  return undefined
}

/**
 * 判定操作类别。删除类永不记忆（R3）；识别不出返回 undefined（fail closed）。
 * @returns {'create'|'edit'|undefined}
 */
export function operationClassOf(toolName, args) {
  if (typeof toolName !== 'string' || toolName === '' || args === null || typeof args !== 'object') return undefined
  const isDir = args.is_directory === true || args.recursive === true
  const destructive = toolName === 'delete' || toolName === 'remove' || toolName === 'rm' || toolName === 'unlink'
    || toolName === 'rmdir' || toolName === 'rmtree'
  if (destructive) return isDir ? 'delete-recursive' : 'delete'
  if (toolName === 'write' || toolName === 'create') return 'create'
  // N7：str_replace_editor 用 args.command 区分行为（官方枚举 view|create|str_replace|insert）。
  // 此前一律返回 'edit'，于是「查看文件」这种只读操作也会被记成编辑授权并免问，
  // 提示里写的命令与实际执行的不符。
  if (toolName === 'str_replace_editor') {
    const command = args.command
    if (command === 'view') return undefined            // 只读：没有可授予的写权限
    if (command === 'create') return isDir ? undefined : 'create'
    if (command === 'str_replace' || command === 'insert') return isDir ? undefined : 'edit'
    return undefined                                    // 未知 command：fail closed
  }
  if (toolName === 'edit' || toolName === 'patch' || toolName === 'apply_patch') {
    return isDir ? undefined : 'edit'
  }
  // MEDIUM-3：rename/move 的 destination 落在另一个目录，而 targetPathOf 只取源。
  // 授权 C:\proj 后，一次把文件移到 C:\Windows 的调用不会再被询问。
  // 移动类一律不记忆，直到 destination 也能纳入判定为止。
  return undefined
}

const GRANTABLE_OPS = new Set(['create', 'edit'])

function parseGrant(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { v, dir, opClass, tool, session, approvalRequestId, at, useCount } = raw
  if (v !== 1) return null
  // LOW-4：dir 必须是绝对路径。`..`/`c:`/`c:\` 这类值会让后续所有检查走偏
  // （例如 `c:` 会让 C: 上的一切提前判成 cross-volume）。
  if (typeof dir !== 'string' || dir === '' || dir.length > 1024) return null
  if (!isAbsolute(dir) || dir !== resolve(dir)) return null
  if (dir.split(/[/\\]+/).includes('..')) return null
  // LOW-4：盘根与 profile 根不是合法的授权目标（isTooBroadRoot 会拦，但那种记录
  // 不该进账本——`c:` 这种更会让后续卷检查全部提前判成 cross-volume）。
  if (isTooBroadRoot(canonicalPathKey(dir))) return null
  if (!GRANTABLE_OPS.has(opClass)) return null
  if (typeof tool !== 'string' || tool.length > 160) return null
  if (typeof session !== 'string' || session.length > 200) return null
  if (typeof approvalRequestId !== 'string' || approvalRequestId.length > 80) return null
  if (!Number.isSafeInteger(at) || at < 0) return null
  // LOW-4：useCount 也要有上界，避免伪造的超大值把授权永久锁死或反向刷满。
  if (useCount !== undefined && (!Number.isSafeInteger(useCount) || useCount < 0 || useCount > 1e6)) return null
  // dir 必须归一化成 canonicalPathKey：check() 用的小写键要和这里一致，
  // 否则 win32 上 `D:\Proj` 与 `d:\proj` 会被当成两条记录（写入时命中、读取时落空）。
  return { v: 1, dir: canonicalPathKey(dir), opClass, tool, session, approvalRequestId, at,
    useCount: Number.isSafeInteger(useCount) && useCount >= 0 ? useCount : 0 }
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
  // N8：账本文件行数上界，超过即压实重写。
  const maxLedgerLines = Number.isInteger(options.maxLedgerLines) && options.maxLedgerLines > 0 ? options.maxLedgerLines : 512
  let linesWritten = 0
  let grants = null
  let writable = true
  // 撤销墓碑时间戳：所有 at <= 该值的授权行都视为已撤销（N2）。
  let clearedAt = 0

  const grantKey = (grant) => `${grant.dir} ${grant.opClass}`

  function load() {
    if (grants !== null) return grants
    const byKey = new Map()
    let latestEpoch = 0
    let lineCount = 0
    try {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (!line) continue
        lineCount += 1
        let parsed = null
        try { parsed = JSON.parse(line) } catch { continue }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        // 墓碑行：{ v: 1, epoch }。取最大值，最终生效。
        if (parsed.epoch !== undefined) {
          if (Number.isSafeInteger(parsed.epoch) && parsed.epoch > latestEpoch) latestEpoch = parsed.epoch
          continue
        }
        const grant = parseGrant(parsed)
        if (grant === null) continue
        // 同一 (dir, opClass) 可能有多行（计数落盘、过期后重新批准）。
        // 语义是 append-only 覆盖：最后一行是当前有效状态。
        byKey.set(grantKey(grant), grant)
      }
    } catch {
      // 账本不存在是正常的首次状态；读失败按「无可信记忆」处理（继续问人）。
    }
    linesWritten = lineCount
    if (latestEpoch > clearedAt) clearedAt = latestEpoch
    const live = [...byKey.values()].filter(grant => grant.at > clearedAt)
    grants = live
    if (grants.length > maxGrants) grants = grants.slice(grants.length - maxGrants)
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
    // R7 防线：先证明祖先链全部可信。junction/重定向一律 fail closed，
    // 词法前缀再像也不算命中。
    const verified = verifyAncestors(rawPath)
    if (!verified.ok) return { hit: false, reason: verified.reason }
    // N1：祖先链干净还不够，目标文件本身也要可信。hardlink 让「写进来」等于
    // 「写到别处去」，而 inode 别名是词法检查看不见的。
    const leaf = verifyLeaf(rawPath)
    if (!leaf.ok) return { hit: false, reason: leaf.reason }
    // 敏感判定必须看**完整目标路径**（含文件名）：只按目录判会把 x.env 当成普通目录放过。
    if (isSelfProtected(canonicalPathKey(canonicalize(rawPath)))) return { hit: false, reason: 'protected-path' } // R2
    const targetKey = verified.dirKey
    const targetVolume = volumeOf(targetKey)
    // MEDIUM-5：任何一条不满足都要 continue 到下一条，而不是提前 return。
    // 提前 return 会让一条浅层/已超限的记录永久遮蔽后面用户真正批准的深层授权。
    let sawExpired = false
    for (const grant of load()) {
      if (!isInside(targetKey, grant.dir)) continue
      if (grant.opClass !== opClass) continue
      if (volumeOf(grant.dir) !== targetVolume) continue // R9
      if (isProtectedTarget(targetKey, grant.dir)) return { hit: false, reason: 'protected-path' } // R2
      if (isTooBroadRoot(grant.dir)) continue // R8
      if (Date.now() - grant.at > maxAgeMs) { sawExpired = true; continue } // R10（MEDIUM-6：允许 remember 重新写行复活）
      if (grant.useCount >= maxUseCount) continue // R10
      grant.useCount += 1
      persistCount(grant)
      return { hit: true, dir: grant.dir }
    }
    return { hit: false, reason: sawExpired ? 'expired' : 'not-granted' }
  }

  /**
   * 目标**文件本身**是否可信。
   *
   * 2026-10-05 复核实证（N1）：verifyAncestors 只从 dirname 向上走，目标文件从不
   * 进入校验循环、也不查 nlink。授权 C:\T\safe\dir 后，在 dir 内 hardlink 一个
   * 指向 C:\T\OUTSIDE\victim.txt 的 notes.txt —— check 命中免问，而写操作
   * 实际改写了授权根之外的文件。同理可 hardlink 到 repo\.git\config，
   * 绕开 R2（.git 是词法检查看不见的）。hardlink 任何用户可建，零特权。
   *
   * 口径与 dsh-audit-rollback 的 probeFile 一致（nlink !== 1 → UNSAFE_FILE_TYPE）。
   * 目标不存在是 create 场景的正常状态，不算不可信。
   *
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function verifyLeaf(targetPath) {
    let info
    try { info = lstatSync(targetPath) }
    catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true }   // 尚不存在：create 场景
      return { ok: false, reason: `leaf-lstat-failed:${error && error.code ? error.code : 'UNKNOWN'}` }
    }
    if (info.isSymbolicLink()) return { ok: false, reason: 'leaf-symlink' }
    if (!info.isFile()) return { ok: false, reason: 'leaf-not-file' }
    // hardlink：同一 inode 有多个名字，写进来等于写到别处去。
    if (info.nlink !== 1) return { ok: false, reason: 'leaf-hardlink' }
    let physical
    try { physical = realpathSync.native(targetPath) }
    catch { return { ok: false, reason: 'leaf-realpath-failed' } }
    const same = process.platform === 'win32' ? physical.toLowerCase() === targetPath.toLowerCase() : physical === targetPath
    if (!same) return { ok: false, reason: 'leaf-redirected' }
    return { ok: true }
  }

  /**
   * 记住一次人工放行（R6：只由用户显式放行触发）。落盘失败返回 false，
   * 调用方据此继续走「再问一次」——记不住就问，绝不静默放行。
   */
  /**
   * 授权判定的唯一实现。preview()（给审批文案）与 remember()（真正落盘）都走这里，
   * 结构上杜绝「文案说一套、写入做另一套」。
   *
   * @returns {{ grantable: true, dir: string, opClass: string } | { grantable: false, reason: string }}
   */
  function evaluate(targetPath, opClass) {
    if (!GRANTABLE_OPS.has(opClass)) return { grantable: false, reason: 'not-grantable-op' }
    const leaf = verifyLeaf(targetPath)
    if (!leaf.ok) return { grantable: false, reason: leaf.reason }
    const verified = verifyAncestors(targetPath)
    if (!verified.ok) return { grantable: false, reason: verified.reason }
    if (isTooBroadRoot(verified.dirKey)) return { grantable: false, reason: 'root-too-broad' }
    if (isSelfProtected(verified.dirKey)) return { grantable: false, reason: 'protected-path' }
    // 2026-10-05 第三轮复核实证（MEDIUM-1）：此前 preview 多做一次全路径判定
    // （能抓住 .env 这类文件名），而 remember 只判目录键 —— 方向相反地分叉：
    // 弹窗说「本次决定仅对这一次调用生效，不会被记住」，点放行后却把该目录
    // 写进授权，同目录**其它**文件从此免问且跨重启有效。
    // 授权粒度是目录，所以 .env 本身每次仍会问（check 的 isProtectedTarget 负责），
    // 但目录授权本身应当建立 —— 关键是两边必须一致。
    if (isSelfProtected(canonicalPathKey(canonicalize(targetPath)))) {
      return { grantable: false, reason: 'protected-path' }
    }
    return { grantable: true, dir: verified.dirKey, opClass }
  }

  function remember(rawPath, opClass, evidence) {
    if (!writable) return { ok: false, reason: 'store-unwritable' }
    if (typeof rawPath !== 'string' || rawPath === '') return { ok: false, reason: 'no-path' }
    if (!GRANTABLE_OPS.has(opClass)) return { ok: false, reason: 'not-grantable-op' }
    if (evidence === null || typeof evidence !== 'object') return { ok: false, reason: 'no-evidence' }
    const { session, tool, approvalRequestId } = evidence
    if (typeof session !== 'string' || session === '' || typeof tool !== 'string' || tool === ''
      || typeof approvalRequestId !== 'string' || approvalRequestId === '') return { ok: false, reason: 'bad-evidence' }
    // 走与 preview 同一份判定（见 evaluate 的 MEDIUM-1 说明）。
    const verdict = evaluate(rawPath, opClass)
    if (!verdict.grantable) return { ok: false, reason: verdict.reason }
    const dirKey = verdict.dir
    const current = load()
    const existing = current.find(grant => grant.dir === dirKey && grant.opClass === opClass)
    // MEDIUM-6：已过期/已超限的旧记录必须允许重新写行复活，否则用户重新批准
    // 也写不进去（此前返回 already 且不写新行，at 永远停在过期时刻）。
    if (existing && Date.now() - existing.at <= maxAgeMs && existing.useCount < maxUseCount) {
      return { ok: true, reason: 'already' }
    }
    // 2026-10-05 第三轮复核实证（MEDIUM-5）：系统时钟回拨（NTP 阶跃、虚拟机快照
    // 恢复、手改日期）会让新的 at 落到旧墓碑之前，重启后被 `at <= clearedAt` 全部滤掉 ——
    // 静默、永久，直到时钟追上来。这里钳制 at 严格大于 clearedAt，
    // 让「刚重新授权」永远不会被同一进程自己写的墓碑压死。
    const at = Math.max(Date.now(), clearedAt + 1)
    const grant = { v: 1, dir: dirKey, opClass, tool, session, approvalRequestId, at, useCount: 0 }
    // 先并入内存缓存，再决定是否落盘。
    // 2026-10-05 第三轮复核实证（HIGH-2）：原顺序是 append → compact → push，
    // 而 compact() 从**陈旧内存缓存**重写整个文件 —— 刚 append 的那行当场被抹掉，
    // remember() 却仍返回 {ok:true, reason:'stored'}，UI 已承诺「记住 30 天」。
    // 生产默认第 512 行附近开始，每 512 行静默丢一条授权。
    current.push(grant)
    if (current.length > maxGrants) current.splice(0, current.length - maxGrants)
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      appendFileSync(filePath, `${JSON.stringify(grant)}\n`, 'utf8')
    } catch {
      writable = false
      current.pop()            // 落盘失败则不进缓存，保持内存与磁盘一致
      return { ok: false, reason: 'write-failed' }
    }
    linesWritten += 1
    if (linesWritten >= maxLedgerLines) compact()
    return { ok: true, reason: 'stored' }
  }

  /**
   * 落盘累计次数（MEDIUM-2）。此前 useCount 只在内存自增，重启即归零，
   * 每次重启白送 maxUseCount 次免问。这里以「同 (dir,opClass) 的最新一行为准」追加。
   * 写失败只是失去这项防护，不影响本次放行判定（检查已在上方完成）。
   *
   * 2026-10-05 复核实证（N8）：每次命中都 append 一行，账本文件行数无上界
   * （maxGrants 只裁内存条目数，文件侧 5 目录 ×120 次 = 505 行，且过期复活
   * 持续追加），每次 DSH 启动都要全量 readFileSync + 逐行 JSON.parse。
   * 现在超过行数上界就重写整份（compaction）；重写失败退回 append 语义。
   */
  function persistCount(grant) {
    if (!writable) return
    const line = `${JSON.stringify({ ...grant, useCount: grant.useCount })}\n`
    try { appendFileSync(filePath, line, 'utf8') } catch { return }
    linesWritten += 1
    if (linesWritten >= maxLedgerLines) compact()
  }

  /**
   * 重写账本：只保留当前有效授权 + 撤销墓碑。
   *
   * 2026-10-05 第三轮复核实证（LOW-1）：此前用 writeFileSync 原地截断重写，
   * 一旦在截断后失败，账本里**全部**授权一次性丢失，而注释却写「不影响正确性」——
   * 方向虽 fail-closed（重新问人），但数据损失无上界。
   * 现在改为「写临时文件 → rename 覆盖」，rename 在同一卷内是原子的：
   * 要么整份换成功，要么完全保持旧内容，不会出现半截账本。
   */
  function compact() {
    const live = load()
    const body = live.map(grant => JSON.stringify(grant)).join('\n')
    const header = clearedAt > 0 ? `${JSON.stringify({ v: 1, epoch: clearedAt })}\n` : ''
    const next = header + (body ? `${body}\n` : '')
    const tmp = `${filePath}.compact`
    try {
      writeFileSync(tmp, next, 'utf8')
      renameSync(tmp, filePath)
      linesWritten = header === '' ? live.length : live.length + 1
    } catch {
      // 压实失败：旧账本原封不动，继续 append 语义。
      try { unlinkSync(tmp) } catch { /* 临时文件残留无害 */ }
    }
  }

  return {
    check,
    remember,
    /**
     * 这次调用**会不会**被记忆吸收。与 remember() 共用 evaluate()，
     * 审批文案据此如实告知用户「会记住什么 / 只对本次生效」。
     *
     * @returns {{ grantable: true, dir: string, opClass: string } | { grantable: false, reason: string }}
     */
    preview(targetPath, opClass) {
      if (typeof targetPath !== 'string' || targetPath === '') return { grantable: false, reason: 'no-path' }
      return evaluate(targetPath, opClass)
    },
    list() { return load().map(grant => ({ ...grant })) },
    /**
     * 撤销全部已授权目录（供设置页「撤销所有已授权目录」）。
     *
     * 2026-10-05 复核实证（N2）：原实现只 `appendFileSync(filePath, '')` 写 0 字节、
     * 再把内存置空——**重启后 load() 全量重读旧行，授权原样复活**。
     * 「撤销」是用户拿回控制权的动作，不能只在内存里生效。
     *
     * 修法：写入一条 epoch 墓碑（`{v:1, epoch}`），load 时丢弃所有 `at <= epoch` 的行。
     * 墓碑与授权同文件、append-only，不需要重写既有内容，也不需要第二个文件。
     */
    clear() {
      const epoch = Date.now()
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        appendFileSync(filePath, `${JSON.stringify({ v: 1, epoch })}\n`, 'utf8')
      } catch { return false }
      // 立刻生效：墓碑之后的行才算数。先读出全部存活键，再按时间过滤。
      grants = null
      clearedAt = Math.max(clearedAt, epoch)
      load()
      return true
    },
  }
}

/** 账本默认位置：与审批历史同在 profile 目录下。 */
export function grantLedgerPath(profileDir) {
  return join(profileDir, 'dsh-auto-review-router', 'granted-directories.jsonl')
}

export { isInside, volumeOf, isProtectedTarget, isTooBroadRoot, isSelfProtected }
