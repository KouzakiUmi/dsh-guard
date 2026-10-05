/**
 * dsh-audit-rollback · 存储层（ledger）
 *
 * 职责：审计账本（JSONL，append-only）、内容寻址对象库（CAS，SHA-1）、
 * 回滚计划与执行。本模块**只用 node:* 内建模块、不依赖 Cordis**，
 * 因此 CLI（scripts/audit-rollback.mjs）与离线自测（test/selftest.mjs）
 * 可以直接复用同一套逻辑；插件侧（lib/index.js）只做事件适配。
 *
 * 字段名、目录布局、kind 取值逐字遵守 docs/design-audit-rollback.md 第 3、4 节。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  writeSync,
  lstatSync,
  openSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, posix, resolve, sep, win32 } from 'node:path'

/** 账本条目版本号（契约第 4 节：所有条目恒为 1）。 */
export const LEDGER_VERSION = 1

/**
 * 展开开头的 `~` / `~/`，让配置里写 `~/.dsh/...` 也能落到真实 home。
 * （与 dsh-preset-tool-guard 同款惯例。）
 */
export function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 解析 stateDir（契约第 3 节）：
 * config.stateDir（展开 `~`）→ $DSH_HOME/audit-rollback → ~/.dsh/audit-rollback。
 * @param {object} [config] 插件 config 或 CLI 侧构造的对象
 * @returns {string} 绝对路径
 */
export function resolveStateDir(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  if (typeof cfg.stateDir === 'string' && cfg.stateDir.length > 0) {
    return resolve(expandHome(cfg.stateDir))
  }
  const dshHome =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(dshHome, 'audit-rollback')
}

/** 计算 Buffer 的 SHA-1（十六进制小写），账本的 hash 一律用这个口径。 */
export function sha1Hex(buffer) {
  return createHash('sha1').update(buffer).digest('hex')
}

/**
 * 路径聚合键（预览/回滚侧归并同一物理文件的大小写别名）：
 * win32 下 NTFS 默认大小写不敏感，`target.txt` 与 `TARGET.TXT` 是同一文件，
 * 聚合一律用小写键；其它平台原样返回。
 * 注意方向：这只用于「把疑似同一路径的账本条目归并/互相佐证」，归并错只会让
 * 一致性校验变严而拒绝恢复（fail-closed），不会放行本不该放行的恢复。
 */
export function canonicalPathKey(absPath) {
  return process.platform === 'win32' ? String(absPath).toLowerCase() : String(absPath)
}

/** 当前 UTC 日期（YYYY-MM-DD），账本按此分文件。 */
export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/** 账本文件路径：<stateDir>/ledger/YYYY-MM-DD.jsonl */
export function ledgerFile(stateDir, date = utcDate()) {
  return join(stateDir, 'ledger', `${date}.jsonl`)
}

/** CAS 对象路径：<stateDir>/objects/<sha1[0:2]>/<sha1> */
export function objectPath(stateDir, hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{40}$/.test(hash)) throw new Error('INVALID_OBJECT_HASH')
  return join(stateDir, 'objects', hash.slice(0, 2), hash)
}

/** Validate every existing ancestor; create each missing directory without recursive traversal. */
export function safeMkdir(dir) {
  let info
  try { info = lstatSync(dir) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!info) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('UNSAFE_MISSING_ROOT')
    safeMkdir(parent)
    existingPathGuards(dir)
    try { mkdirSync(dir) } catch (e) { if (e.code !== 'EEXIST') throw e }
    info = lstatSync(dir)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSAFE_STATE_DIRECTORY')
  existingPathGuards(join(dir, '.guard'))
}

function safeLeaf(file) {
  let info
  try { info = lstatSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  const physical = realpathSync.native(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (process.platform === 'win32' ? physical.toLowerCase() !== file.toLowerCase() : physical !== file)) throw new Error('UNSAFE_STATE_FILE')
  return info
}

/** Append or create using the verified file descriptor; never truncate an existing file. */
export function safeStateWrite(file, data, { append = false, exclusive = false } = {}) {
  const guards = existingPathGuards(file)
  const existing = safeLeaf(file)
  if (exclusive && existing) throw new Error('STATE_FILE_EXISTS')
  const fd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW || 0) |
    (existing ? (append ? constants.O_APPEND : 0) : constants.O_CREAT | constants.O_EXCL), 0o600)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino))) throw new Error('STATE_FILE_EXCHANGED')
    const leaf = safeLeaf(file)
    if (!leaf || leaf.dev !== opened.dev || leaf.ino !== opened.ino || !sameGuards(guards, existingPathGuards(file))) throw new Error('STATE_PATH_EXCHANGED')
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset, append ? null : offset)
      if (!n) throw new Error('STATE_SHORT_WRITE')
      offset += n
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
function sameGuards(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

/**
 * 初始化状态目录（契约第 6.1 条）：
 * 建 ledger/ 与 objects/ 目录；state.json 不存在则创建（不覆盖已有）。
 */
export function initState(stateDir) {
  safeMkdir(join(stateDir, 'ledger'))
  safeMkdir(join(stateDir, 'objects'))
  const stateFile = join(stateDir, 'state.json')
  existingPathGuards(stateFile)
  if (!safeLeaf(stateFile)) safeStateWrite(stateFile, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }) + '\n', { exclusive: true })
}

/**
 * 追加一条账本条目。自动补 `v` 与 `ts`；账本 append-only，
 * 本函数只追加一行，绝不改写或删除已有内容。
 * @returns {object} 实际写入的完整条目
 */
export function appendEntry(stateDir, entry) {
  const full = { v: LEDGER_VERSION, ts: new Date().toISOString(), ...entry }
  safeStateWrite(ledgerFile(stateDir), JSON.stringify(full) + '\n', { append: true })
  return full
}

/**
 * 把内容写入 CAS（内容寻址，写入幂等：同 hash 只存一份，契约第 3 节）。
 * @param {Buffer} buffer 原始字节
 * @returns {string} SHA-1 十六进制小写
 */
export function putObject(stateDir, buffer) {
  const hash = sha1Hex(buffer)
  const file = objectPath(stateDir, hash)
  safeMkdir(dirname(file))
  existingPathGuards(file)
  if (!safeLeaf(file)) {
    try { safeStateWrite(file, buffer, { exclusive: true }) }
    catch (error) { if (error.code !== 'EEXIST') throw error; existingPathGuards(file); safeLeaf(file) }
  }
  return hash
}

/** CAS 里是否有该对象。 */
export function hasObject(stateDir, hash) {
  return existsSync(objectPath(stateDir, hash))
}

/** 读取 CAS 对象；缺失返回 null（调用方据此把 restore 降级为 skip）。 */
export function readObject(stateDir, hash) {
  const file = objectPath(stateDir, hash)
  return existsSync(file) ? readFileSync(file) : null
}

/**
 * 读取全部账本条目（按文件名日期 + 行序，即时间正序）。
 * 目录不存在返回空数组；单行 JSON 解析失败不抛错，该行以
 * `{ kind: 'corrupt', raw, lineError }` 占位，保证审计可见。
 */
export function readAllEntries(stateDir) {
  const dir = join(stateDir, 'ledger')
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
  const entries = []
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        entries.push(JSON.parse(line))
      } catch (error) {
        entries.push({ kind: 'corrupt', raw: line, lineError: String(error) })
      }
    }
  }
  return entries
}

/**
 * 极简 glob 匹配（不引第三方依赖）：支持 `*`（不跨分隔符）、
 * `**`（跨分隔符）、`?`（单字符）。匹配前把路径统一为正斜杠。
 * 未核实的复杂语义（如 brace 扩展）不支持，见 README「未核实项」。
 */
export function globToRegExp(glob) {
  const src = String(glob).replace(/\\/g, '/')
  let out = ''
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '*') {
      if (src[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * 判断绝对路径是否命中 excludeGlobs 之一。
 * 语义：含通配符（`*` / `**` / `?`）的模式按 glob 对全串匹配；
 * 不含通配符的模式按路径片段（子串）匹配——如 `/node_modules/` 命中其下任意文件。
 */
export function matchesAnyGlob(absPath, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false
  const normalized = String(absPath).replace(/\\/g, '/')
  return globs.some((glob) => {
    const pat = String(glob).replace(/\\/g, '/')
    if (!pat.includes('*') && !pat.includes('?')) return normalized.includes(pat)
    return globToRegExp(pat).test(normalized)
  })
}

/**
 * 一轮的内存态（插件每个会话每轮各持有一份；自测直接新建）。
 * - capturedPaths：本轮捕获过的路径（turn/end 的 captured 计数、after 遍历依据）
 * - beforeSeen：已写过 before 的路径（契约第 4 节：同轮同路径 before 只记第一条）
 * - afterDone：本轮是否已做过 after 捕获（权威 after 只在 turn/end 采集一次；
 *   turn-stopping 不再写 after——stopping 之后核心仍可继续落盘，提前采集会把
 *   后像记成中间态；无 turn/end 的轮次恢复侧本来就以 TURN_NOT_ENDED 拒绝）
 */
export function createTurnState() {
  return { capturedPaths: new Set(), beforeSeen: new Set(), afterDone: false }
}

/**
 * 读取文件当前状态（契约修正 F4）：
 * - 存在 → { existed: true, buffer, bytes }
 * - ENOENT → { existed: false, buffer: null, bytes: 0 }
 * - 其它错误（EISDIR/EACCES/EBUSY…）→ { existed: null, error }：
 *   「读不出来」不等于「不存在」。若把目录/权限错误记成 existed:false，
 *   回滚时会把原本存在的文件当新建处理而 trash 掉（核验者用目录实证过）。
 */
export function fileIdentity(info) {
  return { dev: String(info.dev), ino: String(info.ino), mode: info.mode, nlink: info.nlink,
    size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

/**
 * 祖先链安全校验：每级目录必须是真实目录、非符号链接、realpath 与词法路径一致。
 *
 * 2026-10-05 修正：祖先目录**尚不存在**时，`lstatSync` 抛 ENOENT 原先会冒泡成
 * `existed:null`（读失败），导致「在新建目录里首次创建文件」完全不落 capture，
 * 新目录下的文件一律不可回滚。目录不存在不等于路径不安全——此时该终止向上遍历，
 * 把已验证的那一段作为 guards 返回，由 probeFile 据此判定 existed:false。
 * 其它错误（ENOTDIR/EACCES/EINVAL 等）仍然照旧冒泡，保持 fail-closed。
 */
export function pathGuards(absPath) {
  if (typeof absPath !== 'string' || !isAbsolute(absPath) || resolve(absPath) !== absPath ||
      absPath.includes('\0') || absPath.split(/[/\\]+/).includes('..') ||
      (process.platform === 'win32' && (absPath.slice(2).includes(':') || absPath.startsWith('\\\\?')))) {
    throw new Error('UNSAFE_PATH')
  }
  const guards = []
  let dir = dirname(absPath)
  for (;;) {
    let info
    try {
      info = lstatSync(dir)
    } catch (error) {
      // 祖先不存在：已验证段到此为止，交给调用方按「尚不存在」处理。
      if (error && error.code === 'ENOENT') return { guards, missing: true }
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSAFE_ANCESTOR')
    const physical = realpathSync.native(dir)
    const equal = process.platform === 'win32' ? physical.toLowerCase() === dir.toLowerCase() : physical === dir
    if (!equal) throw new Error('PATH_REDIRECTION')
    guards.push({ path: dir, dev: String(info.dev), ino: String(info.ino), physical })
    if (dir === parse(dir).root) break
    dir = dirname(dir)
  }
  return { guards, missing: false }
}

/**
 * 严格版：祖先链必须完整存在，否则抛错。
 * 状态目录与回滚票据等安全关键路径一律用这个——它们操作的路径本就应当存在，
 * 出现 missing 说明有东西在期间被删或被换，必须 fail-closed 而不是继续。
 */
export function existingPathGuards(absPath) {
  const { guards, missing } = pathGuards(absPath)
  if (missing) throw new Error('ANCESTOR_MISSING')
  return guards
}

export function probeFile(absPath, maxBytes = Number.MAX_SAFE_INTEGER) {
  let fd
  try {
    const probe = pathGuards(absPath)
    const guards = probe.guards
    // 父目录链上有一段尚不存在：该路径此刻必然不存在，按 existed:false 记账。
    if (probe.missing) return { existed: false, buffer: null, bytes: 0, identity: null, guards }
    let info
    try { info = lstatSync(absPath) }
    catch (error) {
      if (error.code === 'ENOENT') return { existed: false, buffer: null, bytes: 0, identity: null, guards }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('UNSAFE_FILE_TYPE')
    const physical = realpathSync.native(absPath)
    if (process.platform === 'win32' ? physical.toLowerCase() !== absPath.toLowerCase() : physical !== absPath) throw new Error('FILE_PATH_REDIRECTION')
    fd = openSync(absPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const opened = fstatSync(fd)
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile()) throw new Error('PATH_EXCHANGED')
    const identity = fileIdentity(opened)
    if (opened.size > maxBytes) return { existed: true, buffer: null, bytes: opened.size, identity, guards, oversized: true }
    const chunks = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes - total + 1))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) break
      total += count
      if (total > maxBytes) throw new Error('FILE_EXCEEDED_LIMIT')
      chunks.push(chunk.subarray(0, count))
    }
    const buffer = Buffer.concat(chunks)
    if (buffer.length > maxBytes || JSON.stringify(fileIdentity(fstatSync(fd))) !== JSON.stringify(identity)) throw new Error('FILE_CHANGED_DURING_READ')
    if (JSON.stringify(pathGuards(absPath).guards) !== JSON.stringify(guards) || lstatSync(absPath).ino !== opened.ino) throw new Error('PATH_EXCHANGED')
    return { existed: true, buffer, bytes: buffer.length, identity, guards }
  } catch (error) {
    if (!error.code) error.code = 'EUNSAFE'
    return { existed: null, buffer: null, bytes: 0, error }
  } finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * 捕获某路径在某相位（before|after）的内容快照并记账（契约第 6.3/6.4 条）。
 *
 * before 的去重靠 turnState.beforeSeen：同轮同路径只写第一条，
 * 已写过时返回 null（不写账本）。
 *
 * 超限（> maxBytes）时：hash 记 null、bytes 记实际大小、existed 记 true，
 * 并补一条 note 说明超限（不存对象，回滚时该路径会因对象缺失而 skip）。
 *
 * @returns {object|null} 写入的 capture 条目；被去重时返回 null
 */
export function capturePath(stateDir, options) {
  const { session, turn, path: absPath, phase, maxBytes, turnState } = options
  if (phase === 'before' && turnState !== undefined && turnState.beforeSeen.has(absPath)) return null
  const probe = probeFile(absPath, maxBytes)
  if (probe.existed === null) {
    // 读失败（非 ENOENT，契约 F4 修正）：不得记 existed:false、不写这条 capture；
    // 抛出由上层（插件事件处理器）warn，且不占 beforeSeen 名额（下次可重试）。
    const code = probe.error && probe.error.code ? probe.error.code : 'UNKNOWN'
    const err = new Error(`capture/${phase} 读取失败：${absPath}（${code}）`)
    err.code = code
    throw err
  }
  let hash = null
  let oversized = false
  if (probe.existed) {
    if (probe.bytes <= maxBytes) {
      hash = putObject(stateDir, probe.buffer)
    } else {
      oversized = true
    }
  }
  const entry = appendEntry(stateDir, {
    kind: 'capture',
    id: randomUUID(),
    session,
    turn,
    path: absPath,
    identity: probe.identity,
    guards: probe.guards,
    ...(typeof options.tool === 'string' ? { tool: options.tool } : {}),
    ...(typeof options.callId === 'string' ? { callId: options.callId } : {}),
    phase,
    hash,
    bytes: probe.bytes,
    existed: probe.existed,
  })
  // 写入成功才标记 beforeSeen（契约第 4 节：同轮同路径 before 只记第一条）
  if (phase === 'before' && turnState !== undefined) turnState.beforeSeen.add(absPath)
  if (turnState !== undefined) turnState.capturedPaths.add(absPath)
  if (oversized) {
    appendEntry(stateDir, {
      kind: 'note',
      text: `capture/${phase} 超限未存对象：${absPath}（${probe.bytes} 字节 > 上限 ${maxBytes}）`,
    })
  }
  return entry
}

/**
 * 参数 JSON 截断预览（契约第 4 节 argsPreview）：
 * 按 UTF-8 字节截到 maxBytes，截断时末尾加 `…(截断)`。
 */
export function previewArgs(argsValue, maxBytes) {
  let text
  try {
    text = JSON.stringify(argsValue)
  } catch {
    text = String(argsValue)
  }
  if (text === undefined) text = ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(0, maxBytes).toString('utf8') + '…(截断)'
}

/**
 * 该轮的一致性参照（契约第 7 节，2026-10-04 修正 F2；undo 与 show 共用本函数，
 * 保证两处口径完全一致）：
 * - 每路径参照 = 该轮的 after（该轮没有 after 才退到该轮的 before）；
 * - 同时标记该路径在**后续轮次**是否另有 capture（有则 undo 视为不一致）。
 * 严禁用「全账本最后一次 capture」作参照——旧口径会让 undo 旧轮拿着
 * 后续轮的 after 去比对当前文件，通过后直接覆盖后续轮的工作成果。
 *
 * @returns {Map<string, { ref: object, laterCapture: boolean }>}
 */
export function turnReferences(entries, sessionId, turn) {
  const refByPath = new Map() // path → { ref, index }
  const later = new Set()
  entries.forEach((entry, index) => {
    if (entry.kind !== 'capture' || typeof entry.path !== 'string') return
    if (entry.session === sessionId && entry.turn === turn) {
      const prev = refByPath.get(entry.path)
      // 同轮内 after 优先（无 after 时保留 before 兜底）
      if (prev === undefined || entry.phase === 'after') refByPath.set(entry.path, { ref: entry, index })
    } else if (refByPath.has(entry.path) && index > refByPath.get(entry.path).index) {
      later.add(entry.path)
    }
  })
  const result = new Map()
  for (const [path, { ref }] of refByPath) {
    result.set(path, { ref, laterCapture: later.has(path) })
  }
  return result
}

/**
 * 一致性比对（undo 与 show 共用，契约第 7 节）：
 * 当前文件与参照逐字段对齐；probe.existed === null（读取失败，F4 修正）
 * 一律按不一致处理——无法证明一致时绝不能放行覆盖。
 */
export function matchesReference(probe, ref) {
  if (probe.existed === null || probe.existed !== ref.existed) return false
  if (!probe.existed) return true // 双方都不存在
  if (ref.hash === null) return probe.bytes === ref.bytes // 参照无哈希（超限），退化为比字节数
  return sha1Hex(probe.buffer) === ref.hash
}

/**
 * 生成一次回滚计划（契约第 7 节 undo 语义）：
 * - 收集该轮所有 before 捕获（同路径取最早一条）；
 * - 一致性参照 = 该轮的 after（无 after 才用该轮 before）；该路径在后续
 *   轮次另有 capture 也视为不一致（turnReferences 统一口径）；
 * - 一致 → restore（before.existed:true）或 trash（existed:false）；
 * - 不一致 → skip「轮后已被改动」（force 时改为正常执行）；
 * - restore 但 CAS 对象缺失 → skip「对象缺失」（计划阶段即判定，执行前先校验）。
 *
 * @returns {{ session: string, turn: number, actions: Array<object> }}
 *   actions 元素：{ path, action: 'restore'|'trash'|'skip', from, reason? }
 */
export function planRollback(stateDir, sessionId, turn, options = {}) {
  const force = options.force === true
  const entries = readAllEntries(stateDir)

  // 该轮的 before：同路径取最早一条（entries 已是时间正序，先见即最早）。
  const befores = new Map()
  for (const entry of entries) {
    if (
      entry.kind === 'capture' &&
      entry.session === sessionId &&
      entry.turn === turn &&
      entry.phase === 'before' &&
      !befores.has(entry.path)
    ) {
      befores.set(entry.path, entry)
    }
  }

  const refs = turnReferences(entries, sessionId, turn)

  const actions = []
  for (const [path, before] of befores) {
    const probe = probeFile(path)
    const refInfo = refs.get(path) // before 本身是兜底参照，理论上必然存在
    let consistent = false
    let reason = '轮后已被改动'
    if (probe.existed === null) {
      // 读取失败（F4）：无法证明一致，默认跳过
      reason = `无法读取当前文件（${probe.error && probe.error.code ? probe.error.code : '未知错误'}）`
    } else if (refInfo !== undefined && matchesReference(probe, refInfo.ref)) {
      if (refInfo.laterCapture) {
        reason = '轮后已被改动（该路径在后续轮次另有捕获）'
      } else {
        consistent = true
      }
    }

    if (!consistent && !force) {
      actions.push({ path, action: 'skip', from: before.hash ?? null, reason })
      continue
    }
    if (before.existed) {
      if (before.hash === null || !hasObject(stateDir, before.hash)) {
        actions.push({ path, action: 'skip', from: before.hash ?? null, reason: '对象缺失' })
      } else {
        actions.push({ path, action: 'restore', from: before.hash })
      }
    } else {
      // before 时文件不存在 → 回滚 = 把新建的文件收进回收站
      actions.push({ path, action: 'trash', from: null })
    }
  }
  return { session: sessionId, turn, actions }
}

/** 回收站目录名：ISO 时间戳去冒号（Windows 文件名不允许冒号）；撞名加序号。 */
export function newTrashDir(stateDir) {
  const stamp = new Date().toISOString().replace(/:/g, '')
  let dir = join(stateDir, 'trash', stamp)
  let suffix = 1
  while (existsSync(dir)) {
    dir = join(stateDir, 'trash', `${stamp}-${suffix}`)
    suffix += 1
  }
  return dir
}

/** 按 `/` 或 `\` 切开，丢掉空段。不使用平台 `path.resolve`。 */
function splitPathSegments(value) {
  return String(value).split(/[/\\]+/).filter(Boolean)
}

/**
 * 绝对路径 → 回收站内相对路径（契约第 3 节）。
 *
 * 在调用平台 `path.resolve` 之前识别路径形态。POSIX 的 `resolve('C:\\proj\\...')`
 * 会把盘符字符串当成相对路径拼进 cwd，第一段变成 `home` 之类的偶然结果；
 * Windows 的 `resolve('/proj/...')` 又会补上当前盘符。两种都不是稳定的卷标识。
 *
 * - Windows 盘符：`C:\a\b.txt` / `C:/a/b.txt` → 第一段为盘符字母，其余为路径段。
 * - UNC：`\\server\share\...` 或 `//server/share/...` → `UNC/server/share/...`。
 * - POSIX 绝对路径：去掉根斜杠，`/home/runner/proj/same/file.txt` → `home/runner/proj/same/file.txt`。
 *   这是卷根 `/` 的可读转写，不依赖 cwd，同后缀不同根不会碰撞。
 * 相对路径才交给当前平台 `resolve`，得到绝对路径后再走上面的分支。
 */
export function trashRelativePath(absPath) {
  const raw = String(absPath)
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(raw)
  if (drive) {
    const rest = win32.normalize(raw).slice(2)
    return [drive[1], ...splitPathSegments(rest)].join(sep)
  }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return ['UNC', ...splitPathSegments(raw.replace(/^[/\\]+/, ''))].join(sep)
  }
  if (raw.startsWith('/')) {
    return splitPathSegments(posix.normalize(raw)).join(sep)
  }
  return trashRelativePath(resolve(raw))
}

/** trash 目标已存在时禁止覆盖（契约第 3 节）：追加 -1/-2 … 直到取到未占用名。 */
export function uniqueTrashPath(target) {
  if (!existsSync(target)) return target
  for (let i = 1; ; i += 1) {
    const candidate = `${target}-${i}`
    if (!existsSync(candidate)) return candidate
  }
}

/**
 * 执行回滚计划（契约第 7 节）：先备份、确认成功、再改动；
 * restore 的 CAS 对象必须在任何移动之前判定（F3 修正）；skip 条目不碰文件。
 * 单条失败不中断整体：该条降级为 skip，reason 写明错误；若失败发生在文件
 * 已被搬走之后，reason 必须说明「原路径已移入 trash」并尽力搬回原位。
 *
 * @returns {Array<object>} 实际执行后的 actions（原地更新并返回）
 */
export function executePlan(stateDir, actions) {
  const trashDir = newTrashDir(stateDir)
  for (const action of actions) {
    if (action.action === 'skip') continue
    let movedTo = null // 原路径已被搬去的 trash 位置（用于失败后搬回）
    try {
      // F3：restore 的对象缺失必须在任何移动之前判定，不得先搬空原路径再报 skip
      let buffer = null
      if (action.action === 'restore') {
        buffer = readObject(stateDir, action.from)
        if (buffer === null) {
          action.action = 'skip'
          action.reason = '对象缺失'
          continue
        }
      }
      const probe = probeFile(action.path)
      if (probe.existed === null) {
        throw probe.error instanceof Error ? probe.error : new Error(String(probe.error))
      }
      if (probe.existed) {
        // 备份：卷标识保留盘符；目标已存在则加序号，绝不覆盖已有备份
        const trashFile = uniqueTrashPath(join(trashDir, trashRelativePath(action.path)))
        mkdirSync(dirname(trashFile), { recursive: true })
        try {
          renameSync(action.path, trashFile) // 同盘改名
        } catch {
          copyFileSync(action.path, trashFile) // 跨盘退化为复制+删除
          unlinkSync(action.path)
        }
        movedTo = trashFile
      }
      if (action.action === 'restore') {
        mkdirSync(dirname(action.path), { recursive: true })
        writeFileSync(action.path, buffer)
        movedTo = null // 恢复成功，备份正常留在 trash
      }
      // action === 'trash'：上面已把文件移走，此处无需再做
    } catch (error) {
      action.action = 'skip'
      let reason = `执行失败：${error && error.message ? error.message : String(error)}`
      if (movedTo !== null) {
        // 已搬走又失败：必须写明去向并尽力搬回，不得报成普通 skip（契约第 7 节）
        reason += '；原路径已移入 trash'
        try {
          renameSync(movedTo, action.path)
          reason += '，已搬回原位'
        } catch (backError) {
          try {
            copyFileSync(movedTo, action.path)
            reason += '，已复制回原位（备份仍留 trash）'
          } catch {
            reason += `，搬回失败，备份在 ${movedTo}（${backError && backError.message ? backError.message : backError}）`
          }
        }
      }
      action.reason = reason
    }
  }
  return actions
}

/**
 * 写一条 rollback 账本条目（契约第 4/7 节：applied 反映是否真的执行）。
 * dry-run 也会写计划条目（applied:false），审计上可追溯；这不触碰目标文件。
 */
export function recordRollback(stateDir, sessionId, turn, applied, actions) {
  return appendEntry(stateDir, {
    kind: 'rollback',
    session: sessionId,
    turn,
    applied,
    actions: actions.map((a) => {
      const item = { path: a.path, action: a.action, from: a.from ?? null }
      if (a.reason !== undefined) item.reason = a.reason
      return item
    }),
  })
}

/**
 * 找出账本中“最近一次有可回滚捕获的轮次”（CLI 的 last 子命令用）。
 * @returns {{ session: string, turn: number } | null}
 */
export function findLastCapturedTurn(stateDir) {
  const entries = readAllEntries(stateDir)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.kind === 'capture' && entry.phase === 'before') {
      return { session: entry.session, turn: entry.turn }
    }
  }
  return null
}

/** stateDir 是否可读且像本插件的状态目录（CLI 退出码 1 的判据之一）。 */
export function isStateDirReadable(stateDir) {
  try {
    return statSync(stateDir).isDirectory() && existsSync(join(stateDir, 'state.json'))
  } catch {
    return false
  }
}
