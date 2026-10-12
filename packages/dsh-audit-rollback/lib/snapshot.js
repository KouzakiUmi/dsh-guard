/**
 * dsh-audit-rollback · 影子 git 快照引擎（阶段 B / B1）
 *
 * 契约：docs/design-audit-rollback.md §10.3、§10.4、§10.10。
 *
 * 本模块是**纯 node:* 的存储/计算层**（与 ledger.js 同款定位）：不依赖 Cordis，
 * 可被插件、CLI 与测试独立调用。它只做三件事：
 *
 *   1. 在 <stateDir>/shadow/<workspaceKey> 下维护一个**独立影子 git 库**，
 *      用 --git-dir / --work-tree 指向被审计根——**不要求被审计根自己是 git 仓库**，
 *      也绝不触碰用户仓库的 index、refs 或工作树；
 *   2. 把整个工作区固化成一个 tree 对象（captureTree），并给出两个 tree 之间的
 *      归属路径集合（diffTrees）；
 *   3. 提供边界 ref 的读写与恢复所需的字节读取（writeBoundaryRef / readTreeEntry / readBlob）。
 *
 * 三条实现红线（违反即视为缺陷）：
 *   - 所有 git 子进程必须显式带 --git-dir 与 --work-tree，并从环境里剔除 GIT_* 变量，
 *     避免被外部环境（或用户 shell）改道到用户仓库；
 *   - 必须固定 core.autocrlf=false：否则 Windows 上 add/restore 会做 CRLF 规范化，
 *     恢复出来的字节与账本 CAS 的字节口径不一致，等于"回滚成功但内容不对"；
 *   - 任何失败都返回 degraded 结果、**不抛异常**（快照失败绝不能影响工具调用与轮次推进）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { existingPathGuards, matchesAnyGlob, safeMkdir, safeStateWrite } from './ledger.js'

/** 影子库目录名（stateDir 下一级）。 */
export const SHADOW_DIR_NAME = 'shadow'

/** git 的空树对象（所有仓库恒定）。首次快照没有 from 时用它当基线。 */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** 边界 ref 的命名前缀（契约 §10.3）。 */
export const BOUNDARY_REF_PREFIX = 'refs/dsh'

/** 默认 git 可执行名（测试可注入替代路径以覆盖降级分支）。 */
export const DEFAULT_GIT = 'git'

/** 降级原因常量（写进账本 note / CLI 输出的机器可读字段）。 */
export const SNAPSHOT_REASON = {
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  INIT_FAILED: 'INIT_FAILED',
  WORKTREE_MISMATCH: 'WORKTREE_MISMATCH',
  TIMEOUT: 'TIMEOUT',
  ADD_FAILED: 'ADD_FAILED',
  WRITE_TREE_FAILED: 'WRITE_TREE_FAILED',
  OUTPUT_TRUNCATED: 'OUTPUT_TRUNCATED',
  NOT_IN_ROOT: 'NOT_IN_ROOT',
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  OVER_BUDGET: 'OVER_BUDGET',
  SCAN_INCOMPLETE: 'SCAN_INCOMPLETE',
  SCAN_UNREADABLE: 'SCAN_UNREADABLE',
}

/** 快照默认参数（契约 §10.4 的默认值；插件侧 config 优先）。 */
export const SNAPSHOT_DEFAULTS = {
  timeoutMs: 10000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxListEntries: 200000,
}

/**
 * 工作区预算默认值（2026-10-11 实测后新增，契约 §10.4 预算条款）。
 *
 * 为什么必须有预算：本机实测 `~/.dsh` 有 **26702 个文件 / 2.2 GB**
 * （python-engine 822 MB、storages 312 MB、dsh-runtimes 282 MB、dsh-codex-connect 194 MB…），
 * 对它跑无预算的 `git add -A` 超过 4 分钟仍未结束、且已向影子库写入 **1.3 GB** 对象；
 * 而正常代码仓库（D:\dsh-guard，112 文件 / 1.8 MB）只需 **499 ms**。
 * 所以"全量快照"必须先过预算，否则这个能力在大目录上等于不可用。
 */
export const SNAPSHOT_BUDGET_DEFAULTS = {
  maxFiles: 50000,
  maxBytes: 512 * 1024 * 1024,
  scanMs: 5000,
}

/**
 * 路径是否被排除表命中。
 *
 * 与阶段 A 的 `matchesAnyGlob` 语义完全一致（不含通配符按路径片段匹配），
 * 差别只在**同时检查目录形式**：`/node_modules/` 要能命中 `…/node_modules` 目录本身，
 * 否则盘点会把整个 node_modules 子树算进预算。
 *
 * @param {string} absPath
 * @param {string[]} globs
 * @returns {boolean}
 */
export function pathExcluded(absPath, globs) {
  const normalized = String(absPath).replace(/\\/g, '/')
  return matchesAnyGlob(normalized, globs) || matchesAnyGlob(`${normalized}/`, globs)
}

/**
 * 轻量盘点工作区规模，用于在真正 `git add -A` 之前判预算。
 *
 * 特点：按顶层项分别累计，任一顶层项自身超预算就停止深入该子树（记 oversized），
 * 因此在大目录上它能在 scanMs 内返回"谁是大块头"，而不是傻等全量遍历。
 *
 * @param {string} root
 * @param {object} [options]
 * @param {string[]} [options.excludeGlobs]
 * @returns {{ok:boolean, files:number, bytes:number, partial:boolean, overBudget:boolean,
 *   heaviest:{path:string, files:number, bytes:number, oversized:boolean}[], ms:number}}
 */
export function scanBudget(root, options = {}) {
  const started = Date.now()
  const excludeGlobs = Array.isArray(options.excludeGlobs) ? options.excludeGlobs : []
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : SNAPSHOT_BUDGET_DEFAULTS.maxFiles
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SNAPSHOT_BUDGET_DEFAULTS.maxBytes
  const scanMs = Number.isFinite(options.scanMs) ? options.scanMs : SNAPSHOT_BUDGET_DEFAULTS.scanMs
  const empty = { ok: false, files: 0, bytes: 0, partial: true, overBudget: false, heaviest: [], ms: 0 }

  let entries
  try {
    entries = readdirSync(canonicalRoot(root), { withFileTypes: true })
  } catch {
    return empty
  }

  const heaviest = []
  let files = 0
  let bytes = 0
  let partial = false
  let unreadable = false

  for (const entry of entries) {
    if (Date.now() - started > scanMs) { partial = true; break }
    const full = join(root, entry.name)
    if (pathExcluded(full, excludeGlobs)) continue
    const acc = { files: 0, bytes: 0, oversized: false, unreadable: false }
    if (entry.isDirectory()) walkBudget(full, acc, excludeGlobs, started, scanMs, maxFiles, maxBytes)
    else {
      acc.files = 1
      try { acc.bytes = lstatSync(full).size } catch { acc.unreadable = true }
    }
    if (acc.unreadable) unreadable = true
    if (acc.oversized) partial = true
    files += acc.files
    bytes += acc.bytes
    heaviest.push({ path: entry.name, files: acc.files, bytes: acc.bytes, oversized: acc.oversized })
  }

  heaviest.sort((a, b) => b.bytes - a.bytes)
  return {
    ok: !unreadable,
    files,
    bytes,
    partial,
    overBudget: files > maxFiles || bytes > maxBytes,
    heaviest: heaviest.slice(0, 8),
    ms: Date.now() - started,
  }
}

/** 盘点内部递归：累计到本子树自身的预算上限即停（避免大目录把整个盘点拖死）。 */
function walkBudget(dir, acc, excludeGlobs, started, scanMs, maxFiles, maxBytes) {
  if (acc.oversized) return
  if (Date.now() - started > scanMs) { acc.oversized = true; return }
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { acc.unreadable = true; return }
  let sinceTimeCheck = 0
  for (const entry of entries) {
    if (acc.oversized) return
    // 逐项时间闸门：单层超大目录（数万文件）不会进入递归分支，
    // 若只在函数入口检查时间，scanMs 会被远远超越——2026-10-11 全面复核实测
    // 20000 个扁平文件在 scanMs=1 下仍返回 partial:false / ms=1025，预算闸门因此放行。
    sinceTimeCheck += 1
    if (sinceTimeCheck >= 64) {
      sinceTimeCheck = 0
      if (Date.now() - started > scanMs) { acc.oversized = true; return }
    }
    const full = join(dir, entry.name)
    if (pathExcluded(full, excludeGlobs)) continue
    if (entry.isDirectory()) {
      walkBudget(full, acc, excludeGlobs, started, scanMs, maxFiles, maxBytes)
    } else {
      acc.files += 1
      try { acc.bytes += lstatSync(full).size } catch { acc.unreadable = true }
      if (acc.files > maxFiles || acc.bytes > maxBytes) { acc.oversized = true; return }
    }
  }
}

/**
 * 规范化被审计根：绝对路径 + Windows 盘符大写 + 去尾分隔符。
 * 影子库的 key 与漂移校验都用这个口径，**不得**另造一套。
 * @param {string} root
 * @returns {string}
 */
export function canonicalRoot(root) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('SNAPSHOT_ROOT_REQUIRED')
  let out = resolve(root)
  if (out !== parse(out).root && (out.endsWith(sep) || out.endsWith('/'))) out = out.slice(0, -1)
  if (process.platform === 'win32' && /^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1)
  return out
}

/**
 * 工作区标识：规范化根路径（统一正斜杠）的 SHA-1 前 16 位。
 * 用途：同一台机器上多个被审计根各有一个影子库，互不干扰。
 * @param {string} root
 * @returns {string}
 */
export function workspaceKey(root) {
  const canonical = canonicalRoot(root).replace(/\\/g, '/')
  return createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

/** `<stateDir>/shadow`。 */
export function shadowRoot(stateDir) {
  return join(resolve(stateDir), SHADOW_DIR_NAME)
}

/** 某被审计根对应的影子库目录（GIT_DIR）。 */
export function shadowGitDir(stateDir, root) {
  return join(shadowRoot(stateDir), workspaceKey(root))
}

/** 记录被审计根明文的文件（漂移校验用；影子库内部，不进账本）。 */
export function shadowWorktreeFile(stateDir, root) {
  return join(shadowGitDir(stateDir, root), 'WORKTREE')
}

/**
 * 把 DSH 的 `excludeGlobs` 语义**近似映射**成 gitignore 语法，写进影子库自己的
 * `<GIT_DIR>/info/exclude`。这样 `git add -A` 天然尊重排除表，且不改用户仓库的
 * `.gitignore`、也不写用户仓库的 `.git/info/exclude`。
 *
 * 映射规则（必须在 README 里写明是近似映射）：
 *   - `/node_modules/`（首尾斜杠、无通配符）→ `node_modules/`（gitignore 中不含斜杠的模式匹配任意深度）
 *   - `/afile.txt` → `afile.txt`
 *   - 含 `*` / `?` 的原样保留（gitignore 的 `*` 不跨 `/`，与 DSH 语义一致）
 *   - 无论何种策略，`.git` 恒被排除（影子库永不把用户仓库元数据纳入快照）
 * @param {string[]} excludeGlobs
 * @param {'git'|'force'} ignorePolicy
 * @returns {string} 文件内容
 */
export function excludeFileContent(excludeGlobs, ignorePolicy = 'git') {
  const lines = ['.git/', '.git']
  // force 策略下 add -f 会无视 ignore 表，写进去也没有意义，只保留 .git 保护。
  if (ignorePolicy !== 'force') {
    for (const raw of Array.isArray(excludeGlobs) ? excludeGlobs : []) {
      if (typeof raw !== 'string') continue
      const pattern = raw.replace(/\\/g, '/').replace(/^\/+/, '')
      if (pattern.length === 0) continue
      if (!lines.includes(pattern)) lines.push(pattern)
    }
  }
  return `${lines.join('\n')}\n`
}

/** 与 info/exclude 同口径的近似映射，但在 add -f 时也作为独立 pathspec 闸门生效。 */
function excludePathspecs(globs) {
  const specs = new Set()
  for (const raw of globs) {
    if (typeof raw !== 'string') continue
    const pattern = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!pattern) continue
    const prefix = pattern.startsWith('**/') ? '' : '**/'
    specs.add(`:(top,exclude,glob)${prefix}${pattern}`)
    specs.add(`:(top,exclude,glob)${prefix}${pattern}/**`)
  }
  return [...specs]
}

/** 复用阶段 A 的目录/叶子守卫；元数据缩短时以空行填充，避免旧排除规则残留。 */
function writeShadowMetadata(file, text) {
  safeMkdir(dirname(file))
  let info
  try { info = lstatSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('UNSAFE_STATE_FILE')
  const content = Buffer.from(text, 'utf8')
  const padded = Buffer.alloc(Math.max(content.length, info?.size ?? 0), 10)
  content.copy(padded)
  safeStateWrite(file, padded)
}

/** Git 启动前也检查影子库关键目录/元数据，不允许改道到链接目标或外部对象库。 */
function assertShadowPaths(gitDir) {
  existingPathGuards(join(gitDir, '.guard'))
  for (const name of ['HEAD', 'config', 'index', 'WORKTREE', 'packed-refs', 'shallow',
    'objects', 'objects/info', 'objects/pack', 'refs', 'info', 'info/exclude', 'info/attributes']) {
    const path = join(gitDir, name)
    let info
    try { info = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
      throw new Error('UNSAFE_SHADOW_PATH')
    existingPathGuards(info.isDirectory() ? join(path, '.guard') : path)
  }
  if (existsSync(join(gitDir, 'objects', 'info', 'alternates'))) throw new Error('UNSAFE_SHADOW_ALTERNATES')
}

/** 剔除会改道 git 的环境变量，并关掉交互提示。 */
export function cleanGitEnv(base = process.env) {
  const env = { ...base }
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

/**
 * 把 git 失败现象翻译成**可操作**的中文说明。
 *
 * 参考实现（Roo Code 的 checkpoints）在初始化失败时会给用户"clear notification"，
 * 而不是抛一个裸错误码；本函数就是同一思路：识别锁冲突、权限、路径过长等常见成因，
 * 并给出下一步动作。**不自动删除 `index.lock`**——删别人的锁有风险，只提示。
 *
 * @param {string} stderr
 * @returns {string} 说明（可能为空串）
 */
export function describeGitFailure(stderr) {
  const text = typeof stderr === 'string' ? stderr : ''
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (/\.lock|index\.lock|Unable to create/i.test(text)) {
    const lockPath = /'([^']*\.lock)'/.exec(text)
    const where = lockPath === null ? '' : `（${lockPath[1]}）`
    return `git 锁冲突${where}：另一个 git 操作正在进行，或上次快照异常中断留下了锁文件；`
      + '确认没有其它快照在写同一个影子库后，可删除该锁文件再重试'
  }
  if (/not a git repository/i.test(text)) return 'git 报告目标不是仓库（影子库可能被删除或损坏）'
  if (/Permission denied|Access is denied|EACCES/i.test(text)) return '权限不足（无法读写影子库或工作区文件）'
  if (/Filename too long/i.test(text)) return '路径过长（Windows 下需要 git 的 core.longpaths）'
  if (/No space left|disk full/i.test(text)) return '磁盘空间不足'
  return firstLine.length > 0 ? firstLine.slice(0, 200) : ''
}

/**
 * 运行一次 git 子进程。
 *
 * 前缀固定为 `-c core.autocrlf=false -c core.bare=false --git-dir=<GIT_DIR> --work-tree=<ROOT>`：
 * 前两者保证字节保真与"bare 库也能当作 work tree 用"，后两者保证绝不落到用户仓库。
 *
 * @param {object} options
 * @param {string} options.gitDir 影子库目录
 * @param {string} [options.workTree] 被审计根（ls-tree 等对象命令可不传）
 * @param {string[]} options.args 子命令与其参数（不含前缀）
 * @param {string} [options.gitPath] git 可执行（默认 `git`，测试可注入坏路径）
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputBytes]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:Buffer, stderr:string, ms:number, timedOut:boolean, truncated:boolean, reason:string|null}>}
 */
export function runGit(options) {
  const {
    gitDir,
    workTree,
    args,
    gitPath = DEFAULT_GIT,
    timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs,
    maxOutputBytes = SNAPSHOT_DEFAULTS.maxOutputBytes,
  } = options

  const prefix = [
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'core.bare=false',
    '-c', 'init.templateDir=',
    '-c', `core.hooksPath=${join(gitDir, 'hooks-disabled')}`,
    `--git-dir=${gitDir}`,
  ]
  if (typeof workTree === 'string' && workTree.length > 0) prefix.push(`--work-tree=${workTree}`)

  const started = Date.now()
  return new Promise((promiseResolve) => {
    let child
    try {
      assertShadowPaths(gitDir)
      child = spawn(gitPath, [...prefix, ...args], {
        cwd: typeof workTree === 'string' && existsSync(workTree) ? workTree : process.cwd(),
        env: cleanGitEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      promiseResolve({
        ok: false,
        code: null,
        stdout: Buffer.alloc(0),
        stderr: error && error.message ? error.message : String(error),
        ms: Date.now() - started,
        timedOut: false,
        truncated: false,
        reason: error?.code === 'ENOENT' ? SNAPSHOT_REASON.GIT_UNAVAILABLE : SNAPSHOT_REASON.INIT_FAILED,
      })
      return
    }

    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let spawnError = null

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, Math.max(1, timeoutMs))

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > maxOutputBytes) { truncated = true; return }
      outChunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length
      if (errBytes > 64 * 1024) return
      errChunks.push(chunk)
    })
    child.on('error', (error) => { spawnError = error })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stderr = Buffer.concat(errChunks).toString('utf8')
      if (spawnError !== null) {
        promiseResolve({
          ok: false,
          code: null,
          stdout: Buffer.alloc(0),
          stderr: spawnError.message,
          ms: Date.now() - started,
          timedOut: false,
          truncated: false,
          reason: /ENOENT/.test(spawnError.code ?? '') ? SNAPSHOT_REASON.GIT_UNAVAILABLE : SNAPSHOT_REASON.INIT_FAILED,
        })
        return
      }
      if (timedOut) {
        promiseResolve({
          ok: false,
          code,
          stdout: Buffer.concat(outChunks),
          stderr,
          ms: Date.now() - started,
          timedOut: true,
          truncated,
          reason: SNAPSHOT_REASON.TIMEOUT,
        })
        return
      }
      if (truncated) {
        promiseResolve({
          ok: false,
          code,
          stdout: Buffer.concat(outChunks),
          stderr,
          ms: Date.now() - started,
          timedOut: false,
          truncated: true,
          reason: SNAPSHOT_REASON.OUTPUT_TRUNCATED,
        })
        return
      }
      promiseResolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(outChunks),
        stderr,
        ms: Date.now() - started,
        timedOut: false,
        truncated: false,
        reason: code === 0 ? null : 'GIT_EXIT_' + String(code),
        detail: code === 0 ? null : describeGitFailure(stderr),
      })
    })
  })
}

/**
 * 懒初始化影子库：`git init --bare` + 写 info/exclude + 写 WORKTREE 明文。
 * 已存在且 WORKTREE 匹配时直接复用（不重复 init）。
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} options.root 被审计根
 * @returns {Promise<{ok:boolean, gitDir:string, created:boolean, reason:string|null, stderr?:string}>}
 */
export async function ensureShadowRepo(options) {
  const { stateDir, gitPath = DEFAULT_GIT, timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs } = options
  const root = canonicalRoot(options.root)
  const gitDir = shadowGitDir(stateDir, root)
  const worktreeFile = shadowWorktreeFile(stateDir, root)

  try {
    safeMkdir(gitDir)
    assertShadowPaths(gitDir)
  } catch (error) {
    return { ok: false, gitDir, created: false, reason: SNAPSHOT_REASON.INIT_FAILED, stderr: String(error.message) }
  }

  if (existsSync(join(gitDir, 'HEAD'))) {
    const recorded = readWorktreeRecord(worktreeFile)
    if (recorded === null) {
      // 老布局或 WORKTREE 丢失：补写（不重建库，避免丢已有对象）。
      try { writeShadowMetadata(worktreeFile, root + '\n') } catch (error) {
        return { ok: false, gitDir, created: false, reason: SNAPSHOT_REASON.INIT_FAILED, stderr: String(error.message) }
      }
      return { ok: true, gitDir, created: false, reason: null }
    }
    if (canonicalRoot(recorded) !== root) {
      return { ok: false, gitDir, created: false, reason: SNAPSHOT_REASON.WORKTREE_MISMATCH }
    }
    return { ok: true, gitDir, created: false, reason: null }
  }

  try {
    safeMkdir(gitDir)
  } catch (error) {
    return { ok: false, gitDir, created: false, reason: SNAPSHOT_REASON.INIT_FAILED, stderr: String(error && error.message) }
  }

  const init = await runGit({
    gitDir,
    args: ['init', '--bare', '--quiet'],
    gitPath,
    timeoutMs,
  })
  if (!init.ok) {
    return { ok: false, gitDir, created: false, reason: init.reason ?? SNAPSHOT_REASON.INIT_FAILED, stderr: init.stderr }
  }

  try {
    writeShadowMetadata(join(gitDir, 'info', 'exclude'), excludeFileContent(options.excludeGlobs ?? [], options.ignorePolicy ?? 'git'))
    writeShadowMetadata(worktreeFile, root + '\n')
  } catch (error) {
    return { ok: false, gitDir, created: true, reason: SNAPSHOT_REASON.INIT_FAILED, stderr: String(error && error.message) }
  }

  return { ok: true, gitDir, created: true, reason: null }
}

/** 读 WORKTREE 记录；不存在或不可读返回 null。 */
export function readWorktreeRecord(worktreeFile) {
  try {
    const text = readFileSync(worktreeFile, 'utf8').split(/\r?\n/)[0].trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * 刷新影子库的排除表（配置热更新后调用）。
 * @returns {{ok:boolean, reason:string|null}}
 */
export function refreshExcludeFile(stateDir, root, excludeGlobs, ignorePolicy = 'git') {
  const file = join(shadowGitDir(stateDir, root), 'info', 'exclude')
  try {
    writeShadowMetadata(file, excludeFileContent(excludeGlobs, ignorePolicy))
    // info/attributes 优先于工作区 .gitattributes；禁用所有入库转换与 clean filter。
    writeShadowMetadata(join(shadowGitDir(stateDir, root), 'info', 'attributes'),
      '* -text -eol -filter -ident -working-tree-encoding\n')
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: String(error && error.message) }
  }
}

/**
 * 把整个工作区固化为一个 tree 对象。
 *
 * 流程：ensureShadowRepo → `add -A`（或 `add -A -f`）→ `write-tree` → 数 tree 里的文件数。
 * 任何一步失败都返回 `{ok:false, degraded:true}`，**不抛异常**（契约 §10.4 第 1、5 条）。
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} options.root 被审计根
 * @param {string[]} [options.excludeGlobs]
 * @param {'git'|'force'} [options.ignorePolicy]
 * @param {{maxFiles?:number, maxBytes?:number, scanMs?:number}} [options.budget] 工作区预算（默认 SNAPSHOT_BUDGET_DEFAULTS）
 * @param {boolean} [options.autoExcludeOversized] 超预算时是否自动排除最重的顶层目录后重试（默认 false＝拒绝）
 * @returns {Promise<{ok:boolean, tree:string|null, files:number, ms:number, degraded:boolean, reason:string|null,
 *   autoExcluded?:string[], oversize?:object[], scanned?:object, budget?:object|null}>}
 */
export async function captureTree(options) {
  const {
    stateDir,
    gitPath = DEFAULT_GIT,
    timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs,
    maxOutputBytes = SNAPSHOT_DEFAULTS.maxOutputBytes,
    ignorePolicy = 'git',
    gitInit = true,
  } = options
  const started = Date.now()
  const fail = (reason, extra = {}) => ({
    ok: false, tree: null, files: 0, ms: Date.now() - started, degraded: true, reason, ...extra,
  })

  let root
  try {
    root = canonicalRoot(options.root)
  } catch {
    return fail(SNAPSHOT_REASON.NOT_IN_ROOT)
  }
  if (!existsSync(root)) return fail(SNAPSHOT_REASON.NOT_IN_ROOT)
  // 根必须是**目录**：否则 git 子进程的 cwd 非法，报出来的会是误导性的 GIT_UNAVAILABLE，
  // 而且预算闸门根本走不到（2026-10-11 全面复核实证：root 为文件时 reason 不是预算类）。
  try {
    if (!statSync(root).isDirectory()) return fail(SNAPSHOT_REASON.SCAN_UNREADABLE)
  } catch {
    return fail(SNAPSHOT_REASON.SCAN_UNREADABLE)
  }

  // 状态目录不能被自身快照递归纳入；即使用户改了 stateDir 或清空排除表也一样。
  if (relative(root, resolve(stateDir)).length === 0) return fail(SNAPSHOT_REASON.INIT_FAILED, { detail: 'STATE_EQUALS_WORKTREE' })
  const ownStateRel = toRelPath(root, resolve(stateDir))
  const gitDir = shadowGitDir(stateDir, root)
  if (gitInit) {
    const ready = await ensureShadowRepo({ ...options, root, gitPath, timeoutMs })
    if (!ready.ok) return fail(ready.reason ?? SNAPSHOT_REASON.INIT_FAILED)
  } else if (!existsSync(join(gitDir, 'HEAD'))) {
    return fail(SNAPSHOT_REASON.INIT_FAILED)
  }

  // 漂移校验：影子库记录的根必须是本次要快照的根（契约 §10.10）。
  const recorded = readWorktreeRecord(shadowWorktreeFile(stateDir, root))
  if (recorded !== null && canonicalRoot(recorded) !== root) return fail(SNAPSHOT_REASON.WORKTREE_MISMATCH)

  // ---- 工作区预算（2026-10-11 实测后新增）----------------------------------
  // 先用一次轻量盘点判预算：超预算时默认**拒绝**（OVER_BUDGET，附最重的顶层项），
  // 只有调用方显式 autoExcludeOversized 才把最重目录并入排除表后重试一次。
  // 默认拒绝而不是默认自动排除：自动排除会静默缩小审计覆盖面，必须由调用方决定。
  const budget = { ...SNAPSHOT_BUDGET_DEFAULTS, ...(options.budget ?? {}) }
  let excludeGlobs = ['/.git/', ...(Array.isArray(options.excludeGlobs) ? options.excludeGlobs : []),
    ...(ownStateRel === null ? [] : [`/${ownStateRel}/`])]
  let autoExcluded = []
  let scanned = null
  if (budget.maxFiles > 0 || budget.maxBytes > 0) {
    scanned = scanBudget(root, { ...budget, excludeGlobs })
    // 允许"自动排除最重目录"时最多重试一次（无论原因是超预算还是盘点没扫完）。
    // **只排除真正 oversized 的顶层项**：早期版本把 heaviest 前 8 项整体排除，
    // 会把正常目录与顶层文件一并静默踢出快照（2026-10-11 独立复核实证：
    // autoExcluded 变成 ["/big/","/small1/","/small2/","/root.txt/"]，后三者其实远未超限）。
    const oversizedTops = scanned.ok === true
      ? scanned.heaviest.filter((item) => item.oversized === true)
      : []
    if (scanned.ok && (scanned.overBudget || scanned.partial) &&
      options.autoExcludeOversized === true && oversizedTops.length > 0) {
      autoExcluded = oversizedTops.map((item) => `/${String(item.path).replace(/\\/g, '/')}/`)
      excludeGlobs = [...excludeGlobs, ...autoExcluded]
      scanned = scanBudget(root, { ...budget, excludeGlobs })
    }
    // 盘点本身失败（根不可读、根不是目录…）也必须 fail-closed：
    // 早期版本三个拒绝分支都先判 `scanned.ok`，于是失败时直接落到 add -A（复核实证 reason=ADD_*）。
    if (scanned.ok !== true) {
      return fail(SNAPSHOT_REASON.SCAN_UNREADABLE, { scanned, autoExcluded })
    }
    if (scanned.ok && scanned.overBudget) {
      return fail(SNAPSHOT_REASON.OVER_BUDGET, { oversize: scanned.heaviest, scanned, autoExcluded })
    }
    // `partial: true` 表示盘点在 scanMs 内**没扫完**：此时"未超预算"不可信——
    // 据此放行全量 add 正是分钟级挂起的入口（契约 §10.4 第 6 条）。
    // 宁可拒绝并要求调用方给专属排除表或缩小范围，也不赌一次全量遍历。
    if (scanned.ok && scanned.partial) {
      return fail(SNAPSHOT_REASON.SCAN_INCOMPLETE, { oversize: scanned.heaviest, scanned, autoExcluded })
    }
  }

  const refreshed = refreshExcludeFile(stateDir, root, excludeGlobs, ignorePolicy)
  if (refreshed.ok !== true) return fail(SNAPSHOT_REASON.INIT_FAILED, { detail: refreshed.reason })

  // 每次重建自己的索引，避免已经 tracked 的路径绕过热更新后的 ignore/exclude。
  // refs 仍保留历史 tree；用户仓库的 index 完全不参与。
  const resetIndex = await runGit({ gitDir, workTree: root, args: ['read-tree', '--empty'], gitPath, timeoutMs, maxOutputBytes })
  if (!resetIndex.ok) return fail(resetIndex.reason ?? SNAPSHOT_REASON.ADD_FAILED, { detail: describeGitFailure(resetIndex.stderr) })
  const addArgs = ['add', '-A']
  if (ignorePolicy === 'force') addArgs.push('-f')
  // force 只改变 gitignore 策略，显式排除仍必须生效；.git 无论配置如何都不能入库。
  addArgs.push('--', '.', ...excludePathspecs(['/.git/', ...excludeGlobs]))
  const add = await runGit({ gitDir, workTree: root, args: addArgs, gitPath, timeoutMs, maxOutputBytes })
  if (!add.ok) return fail(add.reason ?? SNAPSHOT_REASON.ADD_FAILED, { detail: add.detail ?? null })

  const writeTree = await runGit({ gitDir, workTree: root, args: ['write-tree'], gitPath, timeoutMs, maxOutputBytes })
  if (!writeTree.ok) return fail(writeTree.reason ?? SNAPSHOT_REASON.WRITE_TREE_FAILED, { detail: writeTree.detail ?? null })
  const tree = writeTree.stdout.toString('utf8').trim()
  if (!/^[a-f0-9]{40}$/.test(tree)) return fail(SNAPSHOT_REASON.EMPTY_OUTPUT)

  const lsTree = await runGit({
    gitDir, workTree: root, args: ['ls-tree', '-r', '--name-only', '-z', tree], gitPath, timeoutMs, maxOutputBytes,
  })
  const files = lsTree.ok ? countZeroSeparated(lsTree.stdout) : 0

  return {
    ok: true,
    tree,
    files,
    ms: Date.now() - started,
    degraded: false,
    reason: null,
    autoExcluded,
    budget: scanned === null ? null : { files: scanned.files, bytes: scanned.bytes, partial: scanned.partial },
  }
}

/** 数 `-z` 输出里的条目数（尾部单个 \0 不算）。 */
export function countZeroSeparated(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 0
  let count = 0
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0) count += 1
  return count
}

/**
 * 解析 `git diff-tree -r -M --numstat -z` 输出。
 * 形态：`<added>\t<deleted>\t<path>\0`；二进制为 `-\t-\t<path>\0`；
 * 改名/复制为 `<added>\t<deleted>\t\0<old>\0<new>\0`（中间是空路径占位）。
 * @param {Buffer} buffer
 * @returns {{path:string, added:number|null, deleted:number|null, binary:boolean, renamedFrom:string|null}[]}
 */
export function parseNumstatZ(buffer) {
  const entries = []
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field.length === 0) continue
    const firstTab = field.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : field.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const addedRaw = field.slice(0, firstTab)
    const deletedRaw = field.slice(firstTab + 1, secondTab)
    const pathRaw = field.slice(secondTab + 1)
    const binary = addedRaw === '-' || deletedRaw === '-'
    let path = pathRaw
    let renamedFrom = null
    if (path.length === 0) {
      renamedFrom = fields[i + 1] ?? null
      path = fields[i + 2] ?? ''
      i += 2
    }
    if (path.length === 0) continue
    entries.push({
      path,
      added: binary ? null : Number.parseInt(addedRaw, 10),
      deleted: binary ? null : Number.parseInt(deletedRaw, 10),
      binary,
      renamedFrom,
    })
  }
  return entries
}

/**
 * 两个 tree 之间的归属路径集合（契约 §10.4 第 3 条）。
 * `from` 为空时用 git 的空树当基线（首次快照）。
 * @returns {Promise<{ok:boolean, entries:object[], degraded:boolean, reason:string|null}>}
 */
export async function diffTrees(options) {
  const {
    stateDir,
    gitPath = DEFAULT_GIT,
    timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs,
    maxOutputBytes = SNAPSHOT_DEFAULTS.maxOutputBytes,
  } = options
  const root = canonicalRoot(options.root)
  const from = options.from ?? EMPTY_TREE_OID
  const to = options.to
  if (typeof to !== 'string' || !/^[a-f0-9]{40}$/.test(to)) {
    return { ok: false, entries: [], degraded: true, reason: SNAPSHOT_REASON.EMPTY_OUTPUT }
  }
  const gitDir = shadowGitDir(stateDir, root)
  const result = await runGit({
    gitDir,
    workTree: root,
    args: ['diff-tree', '-r', '-M', '--numstat', '-z', from, to],
    gitPath,
    timeoutMs,
    maxOutputBytes,
  })
  if (!result.ok) return { ok: false, entries: [], degraded: true, reason: result.reason }
  return { ok: true, entries: parseNumstatZ(result.stdout), degraded: false, reason: null }
}

/**
 * 写/更新一个边界 ref（契约 §10.3：每个边界必须有 ref，否则对象会被 gc 剪掉）。
 * 优先写 commit（`commit-tree`，便于 `git log --all` 人读），失败退回直接指向 tree。
 *
 * @param {object} options
 * @param {string} options.ref 完整 ref 名，如 `refs/dsh/<sessionKey>/t3s2-start`
 * @returns {Promise<{ok:boolean, ref:string, target:string|null, kind:'commit'|'tree'|null, reason:string|null}>}
 */
export async function writeBoundaryRef(options) {
  const {
    stateDir,
    ref,
    tree,
    message = 'dsh snapshot boundary',
    gitPath = DEFAULT_GIT,
    timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs,
  } = options
  const root = canonicalRoot(options.root)
  if (typeof ref !== 'string' || !ref.startsWith(BOUNDARY_REF_PREFIX + '/')) {
    return { ok: false, ref: String(ref), target: null, kind: null, reason: 'INVALID_REF' }
  }
  if (typeof tree !== 'string' || !/^[a-f0-9]{40}$/.test(tree)) {
    return { ok: false, ref, target: null, kind: null, reason: SNAPSHOT_REASON.EMPTY_OUTPUT }
  }
  const gitDir = shadowGitDir(stateDir, root)

  const commit = await runGit({
    gitDir,
    workTree: root,
    args: [
      '-c', 'user.name=dsh-audit-rollback',
      '-c', 'user.email=audit-rollback@localhost',
      'commit-tree', tree, '-m', message,
    ],
    gitPath,
    timeoutMs,
  })
  const commitOid = commit.ok ? commit.stdout.toString('utf8').trim() : ''
  const target = /^[a-f0-9]{40}$/.test(commitOid) ? commitOid : tree
  const kind = target === tree ? 'tree' : 'commit'

  const update = await runGit({ gitDir, workTree: root, args: ['update-ref', ref, target], gitPath, timeoutMs })
  if (!update.ok) {
    return { ok: false, ref, target: null, kind: null, reason: update.reason ?? 'UPDATE_REF_FAILED' }
  }
  return { ok: true, ref, target, kind, reason: null }
}

/**
 * 列出边界 ref。返回项含 tree oid（commit 型 ref 会解引用到 tree）。
 * @returns {Promise<{ok:boolean, refs:{ref:string, object:string, tree:string|null, createdAt:string|null}[], reason:string|null}>}
 */
export async function listBoundaryRefs(options) {
  const {
    stateDir,
    gitPath = DEFAULT_GIT,
    timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs,
    prefix = BOUNDARY_REF_PREFIX,
  } = options
  const root = canonicalRoot(options.root)
  const gitDir = shadowGitDir(stateDir, root)
  if (!existsSync(join(gitDir, 'HEAD'))) return { ok: true, refs: [], reason: null }

  const result = await runGit({
    gitDir,
    workTree: root,
    args: ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)%09%(creatordate:iso-strict)', `${prefix}/`],
    gitPath,
    timeoutMs,
  })
  if (!result.ok) return { ok: false, refs: [], reason: result.reason }

  const refs = []
  for (const line of result.stdout.toString('utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const [ref, object, objectType, createdAt] = line.split('\t')
    if (!ref) continue
    let tree = objectType === 'tree' ? object : null
    if (objectType === 'commit') {
      const peek = await runGit({ gitDir, workTree: root, args: ['rev-parse', `${ref}^{tree}`], gitPath, timeoutMs })
      tree = peek.ok ? peek.stdout.toString('utf8').trim() : null
    }
    refs.push({ ref, object, tree, createdAt: createdAt && createdAt.length > 0 ? createdAt : null })
  }
  return { ok: true, refs, reason: null }
}

/**
 * 查 tree 里某个相对路径的条目（恢复时的"该文件在边界处是否存在"）。
 *
 * 路径用 `:(literal)` 前缀保证按字面匹配——文件名里含 `[`、`*` 等字符时，
 * 裸路径会被 git 当成 pathspec 模式，从而匹配到错误的文件。
 *
 * @param {object} options
 * @param {string} options.relPath 相对被审计根的正斜杠路径
 * @returns {Promise<{ok:boolean, exists:boolean, oid:string|null, mode:string|null, type:string|null, reason:string|null}>}
 */
export async function readTreeEntry(options) {
  const { stateDir, tree, relPath, gitPath = DEFAULT_GIT, timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs } = options
  const root = canonicalRoot(options.root)
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.startsWith('../')) {
    return { ok: false, exists: false, oid: null, mode: null, type: null, reason: SNAPSHOT_REASON.NOT_IN_ROOT }
  }
  const gitDir = shadowGitDir(stateDir, root)
  const result = await runGit({
    gitDir,
    workTree: root,
    args: ['ls-tree', '-z', tree, '--', `:(literal)${relPath}`],
    gitPath,
    timeoutMs,
  })
  if (!result.ok) return { ok: false, exists: false, oid: null, mode: null, type: null, reason: result.reason }
  const entry = parseLsTreeZ(result.stdout)[0]
  if (!entry) return { ok: true, exists: false, oid: null, mode: null, type: null, reason: null }
  return { ok: true, exists: true, oid: entry.oid, mode: entry.mode, type: entry.type, reason: null }
}

/** 解析 `git ls-tree -z`：`<mode> <type> <oid>\t<path>\0`。 */
export function parseLsTreeZ(buffer) {
  const out = []
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  for (const record of text.split('\0')) {
    if (record.length === 0) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const meta = record.slice(0, tab).split(' ')
    if (meta.length < 3) continue
    out.push({ mode: meta[0], type: meta[1], oid: meta[2], path: record.slice(tab + 1) })
  }
  return out
}

/**
 * 读 tree 里某个 blob 的原始字节（恢复时使用）。
 * 先 `cat-file -s` 判大小，超上限直接 oversized，避免把大对象拉进内存。
 *
 * @returns {Promise<{ok:boolean, buffer:Buffer|null, bytes:number, oversized:boolean, reason:string|null}>}
 */
export async function readBlob(options) {
  const {
    stateDir,
    oid,
    maxBytes = 64 * 1024 * 1024,
    gitPath = DEFAULT_GIT,
    timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs,
  } = options
  const root = canonicalRoot(options.root)
  if (typeof oid !== 'string' || !/^[a-f0-9]{40}$/.test(oid)) {
    return { ok: false, buffer: null, bytes: 0, oversized: false, reason: SNAPSHOT_REASON.EMPTY_OUTPUT }
  }
  const gitDir = shadowGitDir(stateDir, root)
  const size = await runGit({ gitDir, workTree: root, args: ['cat-file', '-s', oid], gitPath, timeoutMs })
  if (!size.ok) return { ok: false, buffer: null, bytes: 0, oversized: false, reason: size.reason }
  const bytes = Number.parseInt(size.stdout.toString('utf8').trim(), 10)
  if (!Number.isFinite(bytes)) return { ok: false, buffer: null, bytes: 0, oversized: false, reason: SNAPSHOT_REASON.EMPTY_OUTPUT }
  if (bytes > maxBytes) return { ok: true, buffer: null, bytes, oversized: true, reason: null }

  const blob = await runGit({
    gitDir,
    workTree: root,
    args: ['cat-file', 'blob', oid],
    gitPath,
    timeoutMs,
    maxOutputBytes: Math.max(maxBytes + 1024, 64 * 1024),
  })
  if (!blob.ok) return { ok: false, buffer: null, bytes, oversized: false, reason: blob.reason }
  return { ok: true, buffer: blob.stdout, bytes: blob.stdout.length, oversized: false, reason: null }
}

/**
 * 绝对路径 → 影子库内的相对路径（正斜杠）。不在被审计根内返回 null。
 * @returns {string|null}
 */
export function toRelPath(root, absPath) {
  let canonical
  try { canonical = canonicalRoot(root) } catch { return null }
  const target = resolve(absPath)
  const rel = relative(canonical, target)
  if (rel.length === 0) return null
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

/**
 * 影子库占用统计（设置页展示用）。
 * @returns {{objects:number, refs:number, bytes:number|null}}
 */
export function shadowStats(stateDir, root) {
  try {
    const gitDir = shadowGitDir(stateDir, root)
    if (!existsSync(gitDir)) return { objects: 0, refs: 0, bytes: null }
    let objects = 0
    const objectsDir = join(gitDir, 'objects')
    if (existsSync(objectsDir)) {
      for (const shard of readdirSync(objectsDir)) {
        if (shard.length !== 2) continue
        try { objects += readdirSync(join(objectsDir, shard)).length } catch { /* 并发写 */ }
      }
    }
    let refs = 0
    const countRefs = (dir) => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) countRefs(join(dir, entry.name))
        else refs += 1
      }
    }
    countRefs(join(gitDir, 'refs'))
    return { objects, refs, bytes: null }
  } catch {
    return { objects: 0, refs: 0, bytes: null }
  }
}

/**
 * 清理影子库：删除 `--keep-days` 之外的边界 ref，再 gc 剪掉不可达对象。
 *
 * 只删除 commit 型 ref（有创作者时间可判定）；tree 型 ref（commit-tree 失败的兜底）
 * 一律保守保留并在结果里列出，绝不能让"时间不可知"变成"删掉历史"。
 *
 * @param {object} options
 * @param {boolean} [options.apply] 默认 false，只出计划
 * @returns {Promise<{ok:boolean, plan:{ref:string, reason:string}[], deleted:string[], kept:string[], reason:string|null}>}
 */
export async function gcShadow(options) {
  const {
    stateDir,
    keepDays = 14,
    apply = false,
    gitPath = DEFAULT_GIT,
    timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs,
    now = Date.now(),
  } = options
  const root = canonicalRoot(options.root)
  const listed = await listBoundaryRefs({ stateDir, root, gitPath, timeoutMs })
  if (!listed.ok) return { ok: false, plan: [], deleted: [], kept: [], reason: listed.reason }

  const cutoff = now - Math.max(0, keepDays) * 24 * 60 * 60 * 1000
  const plan = []
  const kept = []
  for (const item of listed.refs) {
    if (item.createdAt === null) { kept.push(item.ref); continue }
    const created = Date.parse(item.createdAt)
    if (!Number.isFinite(created) || created >= cutoff) { kept.push(item.ref); continue }
    plan.push({ ref: item.ref, reason: 'OLDER_THAN_KEEP_DAYS' })
  }

  if (!apply) return { ok: true, plan, deleted: [], kept, reason: null }

  const gitDir = shadowGitDir(stateDir, root)
  const deleted = []
  for (const item of plan) {
    const result = await runGit({ gitDir, workTree: root, args: ['update-ref', '-d', item.ref], gitPath, timeoutMs })
    if (result.ok) deleted.push(item.ref)
    else kept.push(item.ref)
  }
  await runGit({ gitDir, workTree: root, args: ['gc', '--prune=now', '--quiet'], gitPath, timeoutMs: Math.max(timeoutMs, 60000) })
  return { ok: true, plan, deleted, kept, reason: null }
}

/** 目录条目数（测试用：断言快照不向工作区写文件）。 */
export function listFilesRecursive(root, { limit = 5000 } = {}) {
  const out = []
  const walk = (dir, prefix) => {
    if (out.length >= limit) return
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      const rel = prefix.length === 0 ? name : `${prefix}/${name}`
      out.push(rel)
      if (out.length >= limit) return
      try {
        if (statSync(full).isDirectory()) walk(full, rel)
      } catch { /* 竞态 */ }
    }
  }
  walk(root, '')
  return out.sort()
}
