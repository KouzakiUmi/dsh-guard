/**
 * 人工放行后的「已授权目录」记忆 —— 询问抑制器，不是权限收窄器。
 *
 * 为什么需要：核心的审批结果是封闭枚举，`'allowed-once' is the only grant`
 * （dsh-user-approval/lib/index.js:124），授权只对单次请求生效。于是同一条项目目录外
 * 的中风险操作会被反复问人，人工继承退化成永久打断。
 *
 * **作用域：本次运行（进程内存）**。授权不落盘、不跨重启，DSH 重启后重新逐次询问。
 * 2026-10-05 的决定：原先设计成 30 天持久授权，为守护「用户已批准的目录」这条
 * 边界引入了账本、压实、撤销墓碑、时钟钳制、多实例并发等一批机制，连续五轮独立
 * 复核每轮都能挖出新的 HIGH（撤销复活、压实丢授权、时钟回拨失效），而所有这些
 * 缺陷的利用前提都是「攻击者已获得被授权目录的写权限」或「系统时钟被回拨」——
 * 前者意味着已经失陷，后者极罕见。改成本次运行内有效后，整个持久化面消失，
 * 那些缺陷从根上不存在；代价只是重启后要多批一次。
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
 * 安全红线（缺一条即重新问）：
 * R1 目标必须落在已授权根之下（verifyAncestors 逐级证明，不是字符串前缀）
 * R2 敏感前缀（.git/.codex/.agents/.ssh/*.env/凭据文件名）不受记忆抑制
 * R3 删除类、shell 类与 move/rename 永不记忆
 * R4 会话审批策略为 never 时不询问也不记忆（manualFallback 首句即返回）
 * R5 **已删除**：原写「沙箱已是 danger-full-access 时不记忆」，但核心没有公开的
 *    「读当前沙箱模式」API（dsh-sandbox-policy 只导出 setSandboxMode，overrideOf 是
 *    内部方法），无法可靠实现。留着这条声明等于给不存在的防护背书，故删除。
 * R6 只有用户显式放行才写入
 * R7 路径规范化失败、祖先缺失或任一级是 link/重定向 → fail closed
 * R8 过宽的根（盘根、用户 profile 根、系统与凭据目录）永不记忆
 * R9 跨卷/跨逻辑边界不记忆
 * R10 目标文件本身不可信（符号链接/硬链接/非普通文件）→ 重新问一次
 */

import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'

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
  // dirKey 是归一化键（win32 转小写），用于比较；dirPath 保留磁盘上的真实大小写，
  // 只用于展示 —— 让用户在审批弹窗里看到的路径与磁盘上的一模一样，便于核对。
  return { ok: true, dirKey: canonicalPathKey(dirname(resolved)), dirPath: dirname(resolved) }
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
  // 用户 profile 根：授权它等于授权整个用户目录。三种平台形态都要认。
  // 2026-10-05：此前只判 win32 的 `C:\Users\<name>`，POSIX 的 `/home/<user>`
  // 与 `/root` 完全漏判 —— 在 Linux 上把家目录整棵授权出去是允许的。
  // 只按**首段**判定，避免误伤路径中间出现的同名目录（如 /proj/root）。
  // 只封到「用户根」这一层：`/home/<user>/projects/app` 这种项目目录仍可授权。
  if (lower[0] === 'users' && lower.length <= 2) return true      // C:\Users、C:\Users\<name>
  if (lower[0] === 'home' && lower.length <= 2) return true       // /home、/home/<user>
  if (lower[0] === 'root' && lower.length === 1) return true      // /root
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

/**
 * 本次运行内的已授权目录表。**纯内存**：不落盘、不跨重启、无账本。
 * @param {{ maxGrants?: number }} [options]
 */
export function createGrantStore(options = {}) {
  const maxGrants = Number.isInteger(options.maxGrants) && options.maxGrants > 0 ? options.maxGrants : 200
  // key = `${dirKey} ${opClass}`
  const grants = new Map()

  /**
   * 目标**文件本身**是否可信。
   *
   * 2026-10-05 独立复核实证：verifyAncestors 只从 dirname 向上走，目标文件从不
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
   * 授权判定的唯一实现。preview()（给审批文案）与 remember()（真正写入）都走这里，
   * 结构上杜绝「文案说一套、写入做另一套」。
   *
   * 独立复核实证过两类错配：delete 类文案承诺会记住而 remember 必然拒绝；
   * .env 目标文案说 30 天免问而 check 恒返回 protected-path。
   *
   * @returns {{ grantable: true, dir: string, dirPath: string, opClass: string } | { grantable: false, reason: string }}
   */
  function evaluate(targetPath, opClass) {
    if (!GRANTABLE_OPS.has(opClass)) return { grantable: false, reason: 'not-grantable-op' }
    const leaf = verifyLeaf(targetPath)
    if (!leaf.ok) return { grantable: false, reason: leaf.reason }
    const verified = verifyAncestors(targetPath)
    if (!verified.ok) return { grantable: false, reason: verified.reason }
    if (isTooBroadRoot(verified.dirKey)) return { grantable: false, reason: 'root-too-broad' }
    if (isSelfProtected(verified.dirKey)) return { grantable: false, reason: 'protected-path' }
    // 敏感判定必须看**完整目标路径**（含文件名）：只按目录判会把 x.env 当成普通目录放过。
    if (isSelfProtected(canonicalPathKey(canonicalize(targetPath)))) {
      return { grantable: false, reason: 'protected-path' }
    }
    return { grantable: true, dir: verified.dirKey, dirPath: verified.dirPath, opClass }
  }

  /**
   * 记住一次人工放行（R6：只由用户显式放行触发）。
   * 证据只要求 `tool`：写入的前置保证是调用方确认了 `final === 'allowed-once'`，
   * 那才是「用户显式放行」的事实来源。`approvalRequestId` 由 SDK 的
   * `approval/asked` 事件异步带入，曾经被当作硬性前置 —— 结果是该分支在
   * 测试夹具（拦截 approval/request、绕过那次 append）里从未执行过，
   * 集成路径实际未被验证。改为可选：拿到就记下来供审计关联，拿不到不影响记忆。
   */
  function remember(rawPath, opClass, evidence) {
    if (typeof rawPath !== 'string' || rawPath === '') return { ok: false, reason: 'no-path' }
    if (!GRANTABLE_OPS.has(opClass)) return { ok: false, reason: 'not-grantable-op' }
    if (evidence === null || typeof evidence !== 'object') return { ok: false, reason: 'no-evidence' }
    const { tool, approvalRequestId } = evidence
    if (typeof tool !== 'string' || tool === '') return { ok: false, reason: 'bad-evidence' }
    const verdict = evaluate(rawPath, opClass)
    if (!verdict.grantable) return { ok: false, reason: verdict.reason }
    const key = `${verdict.dir} ${opClass}`
    if (grants.has(key)) return { ok: true, reason: 'already' }
    grants.set(key, { dir: verdict.dir, opClass, tool,
      approvalRequestId: typeof approvalRequestId === 'string' && approvalRequestId !== '' ? approvalRequestId : null,
      at: Date.now(), useCount: 0 })
    // 有界：条目数固定上限，超出即淘汰最早写入的一条。
    while (grants.size > maxGrants) grants.delete(grants.keys().next().value)
    return { ok: true, reason: 'stored' }
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
    // 祖先链干净还不够，目标文件本身也要可信。hardlink 让「写进来」等于
    // 「写到别处去」，而 inode 别名是词法检查看不见的。
    const leaf = verifyLeaf(rawPath)
    if (!leaf.ok) return { hit: false, reason: leaf.reason }
    // 敏感判定必须看完整目标路径（含文件名）。
    if (isSelfProtected(canonicalPathKey(canonicalize(rawPath)))) return { hit: false, reason: 'protected-path' } // R2
    const targetKey = verified.dirKey
    const targetVolume = volumeOf(targetKey)
    // 任何一条不满足都要 continue 到下一条，而不是提前 return ——
    // 提前 return 会让一条浅层/过宽的记录永久遮蔽后面用户真正批准的深层授权。
    for (const grant of grants.values()) {
      if (!isInside(targetKey, grant.dir)) continue
      if (grant.opClass !== opClass) continue
      if (volumeOf(grant.dir) !== targetVolume) continue // R9
      if (isProtectedTarget(targetKey, grant.dir)) return { hit: false, reason: 'protected-path' } // R2
      if (isTooBroadRoot(grant.dir)) continue // R8
      grant.useCount += 1
      return { hit: true, dir: grant.dir }
    }
    return { hit: false, reason: 'not-granted' }
  }

  return {
    check,
    remember,
    /**
     * 这次调用**会不会**被记忆吸收。与 remember() 共用 evaluate()，
     * 审批文案据此如实告知用户「会记住什么 / 只对本次生效」。
     */
    preview(targetPath, opClass) {
      if (typeof targetPath !== 'string' || targetPath === '') return { grantable: false, reason: 'no-path' }
      return evaluate(targetPath, opClass)
    },
    list() { return [...grants.values()].map(grant => ({ ...grant })) },
    /** 清空本次运行的全部授权（设置页「撤销」）。内存操作，不会失败。 */
    clear() { grants.clear(); return true },
  }
}

export { isInside, volumeOf, isProtectedTarget, isTooBroadRoot, isSelfProtected }
