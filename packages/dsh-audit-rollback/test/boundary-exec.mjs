#!/usr/bin/env node
/**
 * test/boundary-exec.mjs —— 边界回滚执行层自测（阶段 B / B3）
 *
 * 覆盖契约 §10.6（恢复语义）、§10.7（退出码）、§3（trash 三条规则）：
 *   - 归属路径之外的**无关文件**在任何阶段都不被触碰（字节级断言）；
 *   - dry-run 不触碰文件，但仍写 applied:false 的审计条目；
 *   - apply 后：修改的恢复、新建的移入 trash（且 trash 里确实有副本）、删除的回来；
 *   - shell 造成的改动同样被覆盖（用子进程改文件模拟 shell，不经文件工具）；
 *   - `preTree`/`postTree` 落账，`redo` 能把状态退回 undo 之前；
 *   - 一致性被破坏时默认 skip、`--force` 才覆盖；
 *   - 没有可 redo 的记录时明确失败，而不是猜。
 *
 * 全部使用系统临时目录；退出码 0 全通过，1 有失败。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEntry, readAllEntries } from '../lib/ledger.js'
import { captureBoundary, recordAttribution } from '../lib/boundary.js'
import { EXEC_REASON, executeBoundaryRollback, redoBoundaryRollback, renderExecuteResult } from '../lib/boundary-exec.js'
import { canonicalRoot, cleanGitEnv, readTreeEntry, shadowGitDir } from '../lib/snapshot.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-exec-test-'))
process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
})

let passed = 0
const failed = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`[PASS] ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`[FAIL] ${name} — ${error && error.message ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const ROOT = join(TMP, 'work')
const STATE = join(TMP, 'state')
const SESSION = 'session-exec-1'

function write(relPath, content) {
  const full = join(ROOT, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

function read(relPath) {
  const full = join(ROOT, relPath)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

const hasGit = spawnSync('git', ['--version'], { env: cleanGitEnv(), encoding: 'utf8' }).status === 0
if (!hasGit) {
  console.log('[WARN] 本机 git 不可用：边界快照不可用，相关用例会失败（这是预期内的显性失败）')
}

getStart()

async function getStart() {
  write('src/a.txt', 'v1\n')
  write('src/c.txt', 'will-be-deleted\n')
  write('other/untouched.txt', 'do-not-touch\n')
  write('src/crlf.txt', 'A\r\nB\r\n')
}

/** 造一轮：快照 start → 改动 → 快照 end → 归属。 */
async function makeTurn(turn, mutate, step = 0) {
  const start = await captureBoundary({ stateDir: STATE, root: ROOT, session: SESSION, turn, step, phase: 'start' })
  assert(start.ok, `start 快照应成功：${start.reason}`)
  assert(start.ledgerOk === true, `start 应写入账本：${start.ledgerError}`)
  mutate()
  const end = await captureBoundary({ stateDir: STATE, root: ROOT, session: SESSION, turn, step, phase: 'end' })
  assert(end.ok, `end 快照应成功：${end.reason}`)
  const attribution = await recordAttribution({ stateDir: STATE, root: ROOT, session: SESSION, turn, step, from: start.tree, to: end.tree })
  assert(attribution.ok, `归属应成功：${attribution.reason}`)
  return { start, end, attribution }
}

await test('一轮改动（含 shell 改文件）全部入账，无关文件不在归属集合里', async () => {
  assert(hasGit, '需要 git')
  const { attribution } = await makeTurn(1, () => {
    write('src/a.txt', 'v2\n')                       // 模拟文件工具改动
    write('src/b.txt', 'created\n')                  // 新建
    rmSync(join(ROOT, 'src', 'c.txt'), { force: true }) // 删除
    // 模拟 shell 改动：走子进程写文件，完全不经文件工具
    spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(ROOT, 'src', 'by-shell.txt'))}, 'from-shell\\n')`], { encoding: 'utf8' })
    write('src/crlf.txt', 'C\r\nD\r\n')
  })
  const paths = attribution.paths.map((p) => p.split(/[/\\]/).pop()).sort()
  assert(paths.includes('a.txt'), `归属应含 a.txt：${JSON.stringify(paths)}`)
  assert(paths.includes('b.txt'), '归属应含新建的 b.txt')
  assert(paths.includes('c.txt'), '归属应含删除的 c.txt')
  assert(paths.includes('by-shell.txt'), `shell 改动必须入账：${JSON.stringify(paths)}`)
  assert(paths.includes('crlf.txt'), 'CRLF 文件应入账')
  assert(!attribution.paths.some((p) => p.endsWith('untouched.txt')), '无关文件不得进入归属集合')
})

await test('dry-run：不触碰文件，但写 applied:false 审计条目', async () => {
  assert(hasGit, '需要 git')
  const before = readAllEntries(STATE).length
  const aBefore = read('src/a.txt')
  const result = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, apply: false })
  assert(result.ok, `dry-run 应成功：${result.reason}`)
  assert(result.applied === false, 'dry-run 不应标记已执行')
  assert(read('src/a.txt') === aBefore, 'dry-run 不得改动文件')
  assert(read('src/b.txt') === 'created\n', 'dry-run 不得删除新建文件')
  const after = readAllEntries(STATE)
  assert(after.length === before + 1, `dry-run 应追加一条账本：${before} → ${after.length}`)
  const last = after[after.length - 1]
  assert(last.kind === 'rollback' && last.applied === false, '应写 applied:false 的 rollback 条目')
  assert(last.source === 'snapshot', `rollback 条目应带 source=snapshot，实际 ${last.source}`)
  assert(typeof last.root === 'string' && last.root.length > 0, 'rollback 条目应带 root')
})

await test('apply：修改恢复、新建入 trash、删除恢复，且无关文件字节不变', async () => {
  assert(hasGit, '需要 git')
  const untouchedBefore = readFileSync(join(ROOT, 'other', 'untouched.txt'), 'utf8')
  const result = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, step: 0, apply: true })
  assert(result.ok && result.applied === true, `apply 应成功：${result.reason}`)
  assert(result.counted.restore >= 3, `应至少有 3 个 restore，实际 ${JSON.stringify(result.counted)}`)
  assert(result.counted.trash >= 1, '应至少有 1 个 trash（新建的文件）')

  assert(read('src/a.txt') === 'v1\n', `a.txt 应恢复为 v1，实际 ${JSON.stringify(read('src/a.txt'))}`)
  assert(read('src/c.txt') === 'will-be-deleted\n', 'c.txt 应被恢复')
  assert(read('src/crlf.txt') === 'A\r\nB\r\n', `crlf 应逐字恢复，实际 ${JSON.stringify(read('src/crlf.txt'))}`)
  assert(!existsSync(join(ROOT, 'src', 'b.txt')), 'b.txt（边界后新建）应被移除')
  assert(!existsSync(join(ROOT, 'src', 'by-shell.txt')), 'shell 建的文件也应被移除')
  assert(readFileSync(join(ROOT, 'other', 'untouched.txt'), 'utf8') === untouchedBefore, '无关文件必须字节不变')

  // trash 里必须有备份（先备份、后改动）
  const trashRoot = join(STATE, 'trash')
  const trashFiles = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else trashFiles.push(full)
    }
  }
  walk(trashRoot)
  assert(trashFiles.some((f) => f.endsWith('b.txt')), `trash 里应有 b.txt 副本：${JSON.stringify(trashFiles)}`)

  const entries = readAllEntries(STATE)
  const last = entries[entries.length - 1]
  assert(last.kind === 'rollback' && last.applied === true, '应写 applied:true 的 rollback 条目')
  assert(typeof last.preTree === 'string', 'apply 应记录 preTree')
  assert(typeof last.postTree === 'string', 'apply 应记录 postTree')
})

await test('redo：把状态退回 undo 之前', async () => {
  assert(hasGit, '需要 git')
  const result = await redoBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 1, apply: true })
  assert(result.ok, `redo 应成功：${result.reason}`)
  assert(read('src/a.txt') === 'v2\n', `redo 后 a.txt 应回到 v2，实际 ${JSON.stringify(read('src/a.txt'))}`)
  assert(read('src/b.txt') === 'created\n', 'redo 后 b.txt 应回来')
  assert(read('src/by-shell.txt') === 'from-shell\n', 'redo 后 shell 建的文件应回来')
  assert(!existsSync(join(ROOT, 'src', 'c.txt')), 'redo 后 c.txt 应重新消失')
  assert(read('src/crlf.txt') === 'C\r\nD\r\n', 'redo 后 crlf.txt 应回到 undo 前的版本')
  const entries = readAllEntries(STATE)
  const last = entries[entries.length - 1]
  assert(last.kind === 'rollback' && last.redoOf !== undefined, '应写带 redoOf 的 rollback 条目')
})

await test('没有可 redo 的记录时明确失败', async () => {
  const result = await redoBoundaryRollback({ stateDir: STATE, root: ROOT, session: 'session-never', turn: 99, apply: true })
  assert(result.ok === false && result.reason === EXEC_REASON.NO_REDO_TARGET,
    `应报 NO_REDO_TARGET，实际 ${result.reason}`)
})

await test('边界后被手改：默认 skip；force 才覆盖', async () => {
  assert(hasGit, '需要 git')
  await makeTurn(2, () => { write('src/d.txt', 'turn2\n') })
  write('src/d.txt', 'manually-changed\n') // 边界后手改，且不产生新的归属记录

  const normal = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 2, step: 0, apply: false })
  const skipped = normal.actions.find((a) => a.path.endsWith('d.txt'))
  assert(skipped !== undefined && skipped.action === 'skip', `默认应 skip d.txt，实际 ${JSON.stringify(skipped)}`)
  assert(/边界后被改动/.test(skipped.reason ?? ''), `原因应写明，实际 ${skipped.reason}`)

  const forced = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 2, step: 0, apply: true, force: true })
  assert(forced.ok, `force 应可执行：${forced.reason}`)
  assert(!existsSync(join(ROOT, 'src', 'd.txt')), 'force 后 d.txt 应被移除（边界时不存在）')
})

await test('边界缺失时拒绝执行并给出可读原因', async () => {
  const result = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 999, apply: true })
  assert(result.ok === false && result.reason === 'BOUNDARY_MISSING', `应报 BOUNDARY_MISSING，实际 ${result.reason}`)
  const text = renderExecuteResult(result)
  assert(text.includes('无法执行'), `渲染应给出中文原因：${text}`)
})

await test('账本条目结构完整且旧口径可读', async () => {
  const entries = readAllEntries(STATE)
  const snapshots = entries.filter((e) => e.kind === 'snapshot')
  const attributions = entries.filter((e) => e.kind === 'attribution')
  assert(snapshots.length >= 4, `应有至少 4 条 snapshot，实际 ${snapshots.length}`)
  assert(attributions.length >= 2, `应有至少 2 条 attribution，实际 ${attributions.length}`)
  for (const entry of [...snapshots, ...attributions]) {
    assert(typeof entry.root === 'string' && entry.root.length > 0, '阶段 B 条目必须带 root')
    assert(typeof entry.v === 'number' && typeof entry.ts === 'string', '所有条目应带 v/ts')
  }
  assert(readFileSync(join(STATE, 'ledger', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8').split('\n').filter(Boolean).length === entries.length,
    '账本应为 append-only：行数等于条目数')
})

// ------------------------------------------------------- 2026-10-11 独立复核缺陷回归

await test('preTree 捕获失败时默认拒绝 --apply（不许产生不可 redo 的回滚）', async () => {
  assert(hasGit, '需要 git')
  write('pretree/x.txt', 'base\n')
  await makeTurn(9, () => { write('pretree/x.txt', 'modified\n') })

  // 极小预算让 captureTree（preTree）必然失败
  const tight = { maxFiles: 1, maxBytes: 1, scanMs: 2000 }
  const refused = await executeBoundaryRollback({
    stateDir: STATE, root: ROOT, session: SESSION, turn: 9, step: 0, apply: true, budget: tight,
  })
  assert(refused.ok === false && refused.reason === EXEC_REASON.PRE_TREE_UNAVAILABLE,
    `应报 PRE_TREE_UNAVAILABLE，实际 ok=${refused.ok} reason=${refused.reason}`)
  assert(refused.applied === false, '拒绝时不得标记已执行')
  assert(read('pretree/x.txt') === 'modified\n', '拒绝时不得改动文件')

  const allowed = await executeBoundaryRollback({
    stateDir: STATE, root: ROOT, session: SESSION, turn: 9, step: 0, apply: true, budget: tight, allowWithoutRedo: true,
  })
  assert(allowed.ok === true, `显式 allowWithoutRedo 后应执行：${allowed.reason}`)
  assert(read('pretree/x.txt') === 'base\n', '应恢复为 base')
  assert(allowed.preTree === null, 'preTree 为 null（本次确实不可 redo）')
})

await test('redo 的路径集合包含上次被 skip 的路径（不从链条脱落）', async () => {
  assert(hasGit, '需要 git')
  write('redochain/a.txt', 'base\n')
  await makeTurn(10, () => { write('redochain/a.txt', 'v2\n') })

  const undo1 = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 10, step: 0, apply: true })
  assert(undo1.ok && undo1.applied === true, `undo 应成功：${undo1.reason}`)
  assert(read('redochain/a.txt') === 'base\n', 'undo 后应为 base')

  write('redochain/a.txt', 'v3-manual\n') // 破坏 redo 的参照
  const redo1 = await redoBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 10, apply: true })
  assert(redo1.ok, `第一次 redo 应成功：${redo1.reason}`)
  const first = redo1.actions.find((a) => a.path.endsWith('a.txt'))
  assert(first !== undefined && first.action === 'skip', `第一次 redo 应 skip a.txt：${JSON.stringify(first)}`)

  const redo2 = await redoBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 10, apply: false, force: true })
  assert(redo2.ok, `第二次 redo 应成功：${redo2.reason}`)
  assert(redo2.actions.some((a) => a.path.endsWith('a.txt')),
    `第二次 redo 必须仍含 a.txt（早期实现会永久脱落）：${JSON.stringify(redo2.actions)}`)
})

await test('CLI redo 认识 --force（不再报未知选项）', async () => {
  const cli = fileURLToPath(new URL('../scripts/audit-rollback.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [cli, 'redo', SESSION, '1', '--force', '--state', STATE], { encoding: 'utf8' })
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(!/未知选项/.test(combined), `--force 必须被注册：${combined}`)
  assert(!/缺少取值/.test(combined), `--force 是布尔开关，不应要求取值：${combined}`)
})

// -------------------------------------------- 2026-10-11 全面复核缺陷回归（7 条）

const CLI = fileURLToPath(new URL('../scripts/audit-rollback.mjs', import.meta.url))

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

await test('rename：旧路径必须进入归属集合，undo 后旧文件名恢复', async () => {
  assert(hasGit, '需要 git')
  write('ren/a.txt', 'v1\n')
  const { attribution } = await makeTurn(11, () => {
    renameSync(join(ROOT, 'ren', 'a.txt'), join(ROOT, 'ren', 'b.txt'))
  })
  const names = attribution.paths.map((p) => p.split(/[/\\]/).pop()).sort()
  assert(names.includes('a.txt'), `归属必须含旧路径 a.txt：${JSON.stringify(names)}`)
  assert(names.includes('b.txt'), `归属必须含新路径 b.txt：${JSON.stringify(names)}`)

  const undone = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 11, step: 0, apply: true })
  assert(undone.ok, `undo 应成功：${undone.reason}`)
  assert(read('ren/a.txt') === 'v1\n', `旧路径应恢复为边界内容，实际 ${JSON.stringify(read('ren/a.txt'))}`)
  assert(!existsSync(join(ROOT, 'ren', 'b.txt')), '边界后新建的 b.txt 应被移除')
})

await test('CLI gc 不带 --root 也能从账本还原被审计根', async () => {
  assert(hasGit, '需要 git')
  const run = runCli(['gc', '--state', STATE])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(!/没有可用的被审计根/.test(combined), `应能从账本取 root：${combined}`)
  assert(run.status === 0, `gc 应退出 0，实际 ${run.status}：${combined}`)
})

await test('全部动作被 skip 时 CLI 退出 2（部分完成），不是 3', async () => {
  assert(hasGit, '需要 git')
  write('exitcode/x.txt', 'v1\n')
  await makeTurn(12, () => { write('exitcode/x.txt', 'v2\n') })
  write('exitcode/x.txt', 'v3-manual\n') // 边界后被手改 → 计划必然全 skip
  const run = runCli(['undo-to', SESSION, '12', '--step', '0', '--state', STATE, '--apply'])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 2, `应退出 2（部分完成），实际 ${run.status}：${combined}`)
})

await test('影子库损坏时 CLI gc 明确失败（不谎报无需清理）', async () => {
  assert(hasGit, '需要 git')
  const state2 = join(TMP, 'state-gc-damaged')
  write('gcd/x.txt', 'x\n')
  const cap = await captureBoundary({ stateDir: state2, root: ROOT, session: 'gc-damaged', turn: 1, step: 0, phase: 'start' })
  assert(cap.ok, `快照应成功：${cap.reason}`)
  const gitDir = shadowGitDir(state2, ROOT)
  rmSync(join(gitDir, 'objects'), { recursive: true, force: true })
  rmSync(join(gitDir, 'refs'), { recursive: true, force: true })
  const run = runCli(['gc', '--state', state2, '--apply'])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 1, `损坏时应退出 1，实际 ${run.status}：${combined}`)
})

await test('回滚参照树写 ref：即使 gc --prune=now 也仍可读（不依赖 cruft pack）', async () => {
  assert(hasGit, '需要 git')
  write('refkeep/x.txt', 'v1\n')
  await makeTurn(13, () => { write('refkeep/x.txt', 'v2\n') })
  const undone = await executeBoundaryRollback({ stateDir: STATE, root: ROOT, session: SESSION, turn: 13, step: 0, apply: true })
  assert(undone.ok && undone.applied === true, `undo 应成功：${undone.reason}`)
  assert(typeof undone.preTreeRef === 'string' && undone.preTreeRef.startsWith('refs/dsh/'),
    `应为 preTree 写 ref，实际 ${undone.preTreeRef}`)
  assert(typeof undone.postTreeRef === 'string' && undone.postTreeRef.startsWith('refs/dsh/'),
    `应为 postTree 写 ref，实际 ${undone.postTreeRef}`)

  // 直接调 git 的地方必须和 lib/snapshot.js 走同一套 env（cleanGitEnv）：否则会继承
  // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE 等改道变量，git 打到的是用户仓库而非影子库。
  const gitDir = shadowGitDir(STATE, ROOT)
  const listed = spawnSync('git', [`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname)', 'refs/dsh/'], { env: cleanGitEnv(), encoding: 'utf8' })
  assert(listed.status === 0, `for-each-ref 应退出 0，实际 ${listed.status}：${listed.stderr ?? ''}`)
  assert((listed.stdout ?? '').includes(undone.preTreeRef), `for-each-ref 应列出 preTree ref：${listed.stdout}`)

  // 最坏配置：关闭 cruft pack，再让所有不可达对象立即被剪掉。
  // 这三条命令的退出码也要断言：失败却不报错会让本用例"因为别的原因通过"，变成假绿。
  const noCruft = spawnSync('git', [`--git-dir=${gitDir}`, 'config', 'gc.cruftPacks', 'false'], { env: cleanGitEnv(), encoding: 'utf8' })
  assert(noCruft.status === 0, `config gc.cruftPacks 应退出 0，实际 ${noCruft.status}：${noCruft.stderr ?? ''}`)
  const expireReflog = spawnSync('git', [`--git-dir=${gitDir}`, 'reflog', 'expire', '--expire=now', '--all'], { env: cleanGitEnv(), encoding: 'utf8' })
  assert(expireReflog.status === 0, `reflog expire 应退出 0，实际 ${expireReflog.status}：${expireReflog.stderr ?? ''}`)
  const pruned = spawnSync('git', [`--git-dir=${gitDir}`, 'gc', '--prune=now', '--quiet'], { env: cleanGitEnv(), encoding: 'utf8' })
  assert(pruned.status === 0, `gc --prune=now 应退出 0，实际 ${pruned.status}：${pruned.stderr ?? ''}`)

  const lookup = await readTreeEntry({ stateDir: STATE, root: ROOT, tree: undone.preTree, relPath: 'refkeep/x.txt' })
  assert(lookup.ok === true && lookup.exists === true,
    `prune 后 preTree 仍应可读（对象由 ref 保护）：${JSON.stringify(lookup)}`)
})

// ------------------------------ 2026-10-12 CLI 阶段 B 回归（成功路径 JSON + 边界退出码）

/** CLI 的 stdout 必须是纯 JSON：任何夹杂的提示都会让调用方解析失败。 */
function parseCliJson(run) {
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  try {
    return JSON.parse(run.stdout ?? '')
  } catch (error) {
    throw new Error(`stdout 不是合法 JSON（${error && error.message ? error.message : String(error)}）：${combined}`)
  }
}

/** 归属/差异里的绝对路径按平台分隔符给出，断言时统一放宽分隔符并转义正则元字符。 */
function endsWithPath(value, rel) {
  if (typeof value !== 'string') return false
  const escaped = rel.split('/').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]')
  return new RegExp(`${escaped}$`).test(value)
}

await test('CLI snapshot list --json：退出 0 且逐条列出 start/end 边界快照', async () => {
  assert(hasGit, '需要 git')
  write('clijson/a.txt', 'v1\n')
  await makeTurn(20, () => { write('clijson/a.txt', 'v2\n') })

  const run = runCli(['snapshot', 'list', '--state', STATE, '--session', SESSION, '--turn', '20', '--json'])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 0, `snapshot list 应退出 0，实际 ${run.status}：${combined}`)
  const rows = parseCliJson(run)
  assert(Array.isArray(rows), `snapshot list --json 应输出数组，实际 ${typeof rows}`)
  assert(rows.length === 2, `本轮应有 start/end 两条快照，实际 ${rows.length}：${combined}`)
  for (const row of rows) {
    assert(row.session === SESSION && row.turn === 20, `行应归属本轮：${JSON.stringify(row)}`)
    assert(row.step === 0, `步应为 0，实际 ${JSON.stringify(row)}`)
    assert(typeof row.tree === 'string' && row.tree.length > 0, `应带 tree：${JSON.stringify(row)}`)
    assert(row.root === canonicalRoot(ROOT), `应带被审计根：${JSON.stringify(row)}`)
    assert(row.degraded === false, `不应降级：${JSON.stringify(row)}`)
    assert(typeof row.files === 'number' && typeof row.ms === 'number', `应带 files/ms：${JSON.stringify(row)}`)
  }
  assert(rows.map((row) => row.phase).sort().join(',') === 'end,start',
    `phase 应为 start/end，实际 ${JSON.stringify(rows.map((row) => row.phase))}`)
})

await test('CLI snapshot show --json：退出 0 且给出边界与归属路径', async () => {
  assert(hasGit, '需要 git')
  write('clijson/b.txt', 'v1\n')
  await makeTurn(22, () => { write('clijson/b.txt', 'v2\n') })

  const run = runCli(['snapshot', 'show', SESSION, '22', '--step', '0', '--state', STATE, '--json'])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 0, `snapshot show 应退出 0，实际 ${run.status}：${combined}`)
  const payload = parseCliJson(run)
  assert(payload.session === SESSION && payload.turn === 22 && payload.step === 0,
    `应回显查询目标：${JSON.stringify({ session: payload.session, turn: payload.turn, step: payload.step })}`)
  assert(Array.isArray(payload.snapshots) && payload.snapshots.length === 2,
    `应带两条原始快照条目：${JSON.stringify(payload.snapshots)}`)
  assert(payload.boundary !== null && typeof payload.boundary.tree === 'string',
    `应解析出边界：${JSON.stringify(payload.boundary)}`)
  assert(typeof payload.boundary.ref === 'string' && payload.boundary.ref.length > 0, '边界应带 ref')
  assert(payload.attributed >= 1, `归属路径数应 ≥1，实际 ${payload.attributed}`)
  assert(payload.paths.some((p) => endsWithPath(p, 'clijson/b.txt')),
    `归属路径应含 clijson/b.txt：${JSON.stringify(payload.paths)}`)
})

await test('CLI diff --json：退出 0 且给出行数变化', async () => {
  assert(hasGit, '需要 git')
  write('clijson/c.txt', 'line1\n')
  await makeTurn(23, () => { write('clijson/c.txt', 'line1\nline2\n') })

  const run = runCli(['diff', SESSION, '23', '--step', '0', '--state', STATE, '--json'])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 0, `diff 应退出 0，实际 ${run.status}：${combined}`)
  const payload = parseCliJson(run)
  assert(payload.session === SESSION && payload.turn === 23 && payload.step === 0, '应回显查询目标')
  assert(typeof payload.root === 'string' && payload.root.length > 0, '应解析出被审计根')
  const row = payload.rows.find((item) => endsWithPath(item.path, 'clijson/c.txt'))
  assert(row !== undefined, `应含 clijson/c.txt 的差异行：${JSON.stringify(payload.rows)}`)
  assert(row.path.startsWith(payload.root), `差异路径应挂在被审计根下：${row.path}`)
  assert(row.binary === false, `文本文件不应判为二进制：${JSON.stringify(row)}`)
  assert(row.added === 1 && row.deleted === 0, `新增一行应为 +1/-0，实际 ${JSON.stringify(row)}`)
})

await test('CLI undo-to：该轮没有边界快照时退出 4（阶段 B 口径不可用）', async () => {
  assert(hasGit, '需要 git')
  const run = runCli(['undo-to', SESSION, '777', '--step', '0', '--state', STATE])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 4, `边界缺失应退出 4，实际 ${run.status}：${combined}`)
  assert(/边界快照/.test(run.stderr ?? ''), `stderr 应说明是边界快照缺失：${combined}`)
})

await test('CLI redo：没有已执行的回滚记录时退出 5（不猜）', async () => {
  assert(hasGit, '需要 git')
  const run = runCli(['redo', SESSION, '778', '--state', STATE])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 5, `无 redo 记录应退出 5，实际 ${run.status}：${combined}`)
  assert(/没有可 redo/.test(run.stderr ?? ''), `stderr 应写明没有可 redo 的记录：${combined}`)
})

await test('CLI undo-to：零归属路径时退出 3（不是"成功"也不是"部分完成"）', async () => {
  assert(hasGit, '需要 git')
  write('noop/a.txt', 'unchanged\n')
  // 必须是最新轮：undo-to 也会包含目标之后各轮的归属路径。
  const { attribution } = await makeTurn(24, () => { /* 最新轮刻意零改动 → 归属集合为空 */ })
  assert(attribution.paths.length === 0, `前置条件：本轮应无归属路径，实际 ${JSON.stringify(attribution.paths)}`)

  const run = runCli(['undo-to', SESSION, '24', '--step', '0', '--state', STATE])
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert(run.status === 3, `零归属路径应退出 3，实际 ${run.status}：${combined}`)
  assert(read('noop/a.txt') === 'unchanged\n', '零归属路径不得触碰任何文件')
})

await test('CLI snapshot show --json：存在降级记录但无可用边界时仍退出 4', async () => {
  appendEntry(STATE, { kind: 'snapshot', session: SESSION, turn: 779, step: 0, phase: 'start', tree: null, degraded: true })
  const run = runCli(['snapshot', 'show', SESSION, '779', '--state', STATE, '--json'])
  assert(run.status === 4, `降级边界的 JSON 输出也应退出 4，实际 ${run.status}：${run.stderr ?? ''}`)
  assert(parseCliJson(run).boundary === null, '降级记录不可伪装成可用边界')
})

// ------------------------------------------------------- 汇总

console.log('')
console.log(`用例：通过 ${passed}，失败 ${failed.length}`)
if (failed.length > 0) {
  for (const item of failed) {
    console.log(`  - ${item.name}: ${item.error && item.error.stack ? item.error.stack.split('\n')[0] : item.error}`)
  }
  process.exitCode = 1
} else {
  process.exitCode = 0
}
