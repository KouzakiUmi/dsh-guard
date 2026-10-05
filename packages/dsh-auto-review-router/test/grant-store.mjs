// 授权记忆（询问抑制器）的安全边界回归。零网络、零模型、只用临时目录。
// 2026-10-05 第二次扩充：加入独立安全复核实证的 junction 逃逸、.git 绕过、
// 账本伪造矩阵、useCount 落盘与过期复活等反例。
import './runtime.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { createGrantStore, targetPathOf, operationClassOf, grantLedgerPath,
  isProtectedTarget, isTooBroadRoot, verifyAncestors, isInside } from '../lib/grant-store.js'

// 不用 os.tmpdir()：它落在 %LOCALAPPDATA%\Temp 下，而 AppData 是授权记忆的
// 敏感段（MEDIUM-1 修复），会把 fixture 判成过宽根。改用 D 盘根下的
// 一次性目录，语义上等价于「普通项目目录」。
const root = mkdtempSync('D:\\dsh-grant-test-')
const evidence = { session: 's', tool: 'edit', approvalRequestId: 'r' }
const store = (name = 'g') => createGrantStore(grantLedgerPath(join(root, name)))
const dir = (name) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d }
const file = (p, content = 'x') => { writeFileSync(p, content); return p }
let passed = 0
const ok = (name) => { passed += 1; console.log(`PASS ${name}`) }
const canSymlink = (() => { try { symlinkSync(root, join(root, '_probe'), 'junction'); return true } catch { return false } })()
// N1 探针：hardlink 通常无特权即可创建，但网络盘/特殊 FS 可能不支持。
const canHardlink = (() => {
  try {
    const a = join(root, '_hl-probe-a'), b = join(root, '_hl-probe-b')
    writeFileSync(a, 'x'); linkSync(a, b); return true
  } catch { return false }
})()

try {
  // ── 正常路径：授权后同目录同类免问 ────────────────────────────────
  {
    const s = store('basic')
    const d = dir('basic')
    const target = file(join(d, 'a.txt'))
    assert.equal(s.check(target, 'edit').hit, false, '未授权时不命中')
    assert.deepEqual(s.remember(target, 'edit', evidence), { ok: true, reason: 'stored' })
    assert.equal(s.check(target, 'edit').hit, true, '授权后同目录同类免问')
    assert.equal(s.check(join(d, 'b.txt'), 'edit').hit, true, '同目录其它文件也免问')
    assert.equal(s.check(target, 'create').hit, false, '操作类别不同不命中')
    ok('基础授权：目录 + 操作类别')
  }

  // ── HIGH-1 junction 逃逸授权根 ────────────────────────────────────
  if (canSymlink) {
    {
      const s = store('junction')
      const base = dir('junction')
      const safe = join(base, 'safe'); mkdirSync(safe, { recursive: true })
      const outside = dir('junction-outside')
      s.remember(file(join(safe, 'ok.txt')), 'create', { ...evidence, tool: 'write' })
      assert.equal(s.check(join(safe, 'x.txt'), 'create').hit, true, '同目录正常命中')
      symlinkSync(outside, join(safe, 'evil'), 'junction')
      const escaped = s.check(join(safe, 'evil', 'pwned.txt'), 'create')
      assert.equal(escaped.hit, false, `junction 逃逸必须不命中（实际 ${JSON.stringify(escaped)}）`)
      ok('HIGH-1 junction 逃逸授权根被拒')
    }
    // ── HIGH-2 借 junction 绕过 R2（指向 .git）──────────────────────
    {
      const s = store('junction-git')
      const repo = dir('junction-git-repo')
      const git = join(repo, '.git'); mkdirSync(git, { recursive: true })
      file(join(git, 'config'), '[core]\n')
      const safe = join(repo, 'work'); mkdirSync(safe, { recursive: true })
      s.remember(file(join(safe, 'ok.txt')), 'create', { ...evidence, tool: 'write' })
      symlinkSync(git, join(safe, 'cache'), 'junction')
      const attack = s.check(join(safe, 'cache', 'config'), 'create')
      assert.equal(attack.hit, false, `不得借 junction 改写 .git（实际 ${JSON.stringify(attack)}）`)
      ok('HIGH-2 借 junction 绕过 R2 被拒')
    }
    // 祖先链里任一级是 junction 即整体不可信
    {
      const real = dir('anc-real')
      const linkParent = join(root, 'anc-link'); symlinkSync(real, linkParent, 'junction')
      const v = verifyAncestors(join(linkParent, 'child.txt'))
      assert.equal(v.ok, false, `祖先含 junction 必须 fail closed（实际 ${JSON.stringify(v)}）`)
      ok('祖先链含 junction 即 fail closed')
    }
  } else {
    console.log('SKIP junction 用例：本进程无法创建 junction')
  }

  // ── 目标文件尚不存在但父目录可信 → 允许（create 场景）────────────
  {
    const s = store('missing-leaf')
    const d = dir('missing-leaf')
    const v = verifyAncestors(join(d, 'not-yet.txt'))
    assert.equal(v.ok, true, '父目录可信时允许尚不存在的目标')
    ok('新建文件（父目录已存在）可授权')
  }
  // 父目录不存在 → fail closed（无法证明日后不会被换成 junction）
  {
    const v = verifyAncestors(join(root, 'no-such-dir', 'deep', 'x.txt'))
    assert.equal(v.ok, false, '祖先缺失必须 fail closed')
  }

  // ── R1 授权根之外不命中 ─────────────────────────────────────────
  {
    const s = store('r1')
    assert.equal(s.check(file(join(dir('r1-other'), 'x.txt')), 'edit').hit, false)
    ok('R1 授权根之外不命中')
  }

  // ── R2 敏感路径每次重问 ─────────────────────────────────────────
  {
    const s = store('r2')
    const base = dir('r2')
    for (const seg of ['.git', '.codex', '.agents', '.ssh']) {
      const sub = join(base, seg); mkdirSync(sub, { recursive: true })
      assert.equal(s.remember(file(join(sub, 'config')), 'edit', evidence).ok, false, `${seg} 目录不可授权`)
    }
    // 2026-10-05 第三轮复核（MEDIUM-1）：直接以 .env 为目标授权时**不得**成立。
    // 旧行为是「记住该目录 → 同目录其它文件从此免问」，而弹窗写的是
    // 「本次决定仅对这一次调用生效，不会被记住」——文案与实现反向分叉。
    // 现在 preview 与 remember 共用 evaluate()，两边都拒绝。
    const env = file(join(base, 'x.env'), 'k=v')
    assert.equal(s.preview(env, 'edit').grantable, false, '.env 目标不得承诺可授权')
    assert.equal(s.remember(env, 'edit', evidence).ok, false, '.env 目标不得被记住')
    assert.equal(s.check(env, 'edit').hit, false, '写 .env 仍每次重问')
    // 目录里恰好有 .env 时，授权该目录仍可（.env 本身由 isProtectedTarget 兜住）
    const other = file(join(base, 'ok.txt'))
    assert.equal(s.remember(other, 'edit', evidence).ok, true, '普通目标可授权')
    assert.equal(s.check(env, 'edit').hit, false, '写 .env 仍每次重问')
    assert.equal(s.check(other, 'edit').hit, true, '同目录普通文件免问')
    assert.equal(isProtectedTarget(env.toLowerCase(), base.toLowerCase()), true)
    ok('R2 敏感文件不受记忆抑制，且 .env 目标不可授权（MEDIUM-1）')
  }

  // ── R3 删除类 / shell / move 永不记忆（MEDIUM-3）─────────────────
  {
    const s = store('r3')
    const p = file(join(dir('r3'), 'a.txt'))
    for (const tool of ['delete', 'rm', 'unlink', 'rmdir', 'rmtree', 'remove']) {
      assert.equal(operationClassOf(tool, {}).startsWith('delete'), true, `${tool} 归为删除类`)
    }
    for (const tool of ['pwsh', 'bash', 'shell', 'run_code', 'unknown_tool']) {
      assert.equal(operationClassOf(tool, { command: 'rm -rf /' }), undefined, `${tool} 不做目录记忆`)
    }
    // MEDIUM-3：move/rename 的 destination 不参与判定，故一律不记忆
    assert.equal(operationClassOf('move', { file_path: p, new_path: 'C:\\Windows\\x' }), undefined, 'move 不记忆')
    assert.equal(operationClassOf('rename', { file_path: p, new_path: 'C:\\Windows\\x' }), undefined, 'rename 不记忆')
    assert.equal(operationClassOf('mv', { file_path: p, new_path: 'C:\\Windows\\x' }), undefined, 'mv 不记忆')
    assert.equal(s.remember(p, 'delete', evidence).ok, false)
    assert.equal(s.check(p, 'delete').hit, false)
    ok('R3 删除类、shell 类与 move/rename 永不记忆')
  }

  // ── R4 大小写别名（.GIT / .GiT）──────────────────────────────────
  {
    const s = store('case')
    const base = dir('case')
    const git = join(base, '.GIT'); mkdirSync(git, { recursive: true })
    assert.equal(s.remember(file(join(git, 'config')), 'edit', evidence).ok, false, '混合大小写 .GIT 同样被拒')
    assert.equal(s.check(file(join(git, 'c2')), 'edit').hit, false)
    ok('R2 大小写别名无法绕过')
  }

  // ── R5 LOW-3 路径形式：.. 与 \\?\ 前缀 ───────────────────────────
  {
    assert.equal(targetPathOf({ file_path: 'D:\\proj\\..\\Windows\\x' }), undefined, '词法穿越被拒')
    assert.equal(targetPathOf({ file_path: 'C:\\..\\Windows\\x' }), undefined, 'win32 词法穿越被拒')
    assert.equal(targetPathOf({ file_path: '\\\\?\\C:\\Windows\\x' }), undefined, '长路径前缀被拒')
    assert.equal(targetPathOf({ file_path: 'C:\\x.txt:stream' }), undefined, 'ADS 被拒')
    assert.equal(targetPathOf({ file_path: 'relative.txt' }), undefined, '相对路径不猜')
    assert.equal(verifyAncestors('\\\\server\\share\\x.txt').ok, false, 'UNC 被拒')
    ok('LOW-3 危险路径形式一律拒绝')
  }

  // ── MEDIUM-1 R8：敏感子树不可授权，但普通项目目录不受连坐 ──────────
  {
    assert.equal(isTooBroadRoot('c:\\'), true)
    assert.equal(isTooBroadRoot('c:\\users'), true)
    assert.equal(isTooBroadRoot('c:\\users\\fractal'), true, 'profile 根过宽')
    assert.equal(isTooBroadRoot('c:\\users\\fractal\\.dsh'), true, '~/.dsh 不可授权')
    assert.equal(isTooBroadRoot('c:\\users\\fractal\\appdata\\local\\temp'), true, 'AppData 不可授权')
    assert.equal(isTooBroadRoot('c:\\program files\\dsh next\\resources\\app'), true, 'DSH 安装目录不可授权')
    assert.equal(isTooBroadRoot('d:\\dsh-guard'), false, '项目根不应被连坐（复核实测此处过宽）')
    assert.equal(isTooBroadRoot('d:\\dsh-guard\\packages'), false, '项目子目录可授权')
    const s = store('r8')
    assert.equal(s.remember('C:\\Users\\Fractal\\.dsh\\settings.json', 'create', evidence).ok, false)
    ok('MEDIUM-1 R8：敏感子树拒、普通项目目录不连坐')
  }

  // ── MEDIUM-2 useCount 落盘（重启不归零）──────────────────────────
  {
    const name = 'r10'
    const s = store(name)
    const d = dir(name)
    const p = file(join(d, 'a.txt'))
    s.remember(p, 'edit', evidence)
    for (let i = 0; i < 5; i += 1) assert.equal(s.check(p, 'edit').hit, true, `第 ${i + 1} 次命中`)
    const raw = readFileSync(grantLedgerPath(join(root, name)), 'utf8')
    const counts = raw.trim().split('\n').map(l => JSON.parse(l).useCount)
    assert.ok(counts[counts.length - 1] >= 5, `useCount 必须落盘（实际 ${JSON.stringify(counts)}）`)
    // 重新 open（模拟重启）：计数应延续而不是归零
    const reopened = store(name)
    assert.equal(reopened.check(p, 'edit').hit, true)
    const raw2 = readFileSync(grantLedgerPath(join(root, name)), 'utf8')
    const last = JSON.parse(raw2.trim().split('\n').pop())
    assert.ok(last.useCount >= 6, `重启后计数必须延续（实际 ${last.useCount}）`)
    ok('MEDIUM-2 useCount 落盘，重启不归零')
  }

  // ── MEDIUM-6 过期授权可复活 ──────────────────────────────────────
  {
    const name = 'expired'
    const s = store(name)
    const d = dir(name)
    const p = file(join(d, 'a.txt'))
    s.remember(p, 'edit', evidence)
    // 手工把 at 改到 31 天前
    const file_ = grantLedgerPath(join(root, name))
    const lines = readFileSync(file_, 'utf8').trim().split('\n')
    const old = JSON.parse(lines[0]); old.at = Date.now() - 31 * 24 * 3600 * 1000
    writeFileSync(file_, `${JSON.stringify(old)}\n`)
    const fresh = store(name)
    assert.equal(fresh.check(p, 'edit').hit, false, '过期后不再命中')
    assert.equal(fresh.check(p, 'edit').reason, 'expired', '原因标记为 expired')
    assert.deepEqual(fresh.remember(p, 'edit', evidence), { ok: true, reason: 'stored' },
      '过期后重新批准必须能写新行复活')
    assert.equal(store(name).check(p, 'edit').hit, true, '复活后重新命中')
    ok('MEDIUM-6 过期授权可重新批准复活')
  }

  // ── MEDIUM-5 check 不被浅层/超限记录遮蔽 ────────────────────────
  {
    const name = 'shadow'
    const s = store(name)
    const d = dir(name)
    const p = file(join(d, 'a.txt'))
    const file_ = grantLedgerPath(join(root, name))
    mkdirSync(join(root, name, 'dsh-auto-review-router'), { recursive: true })
    // 第一行：浅层但已超限的授权（若实现提前 return，深层那条永远轮不到）
    writeFileSync(file_, [
      JSON.stringify({ v: 1, dir: root, opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'a', at: Date.now(), useCount: 999999 }),
      JSON.stringify({ v: 1, dir: d, opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'b', at: Date.now(), useCount: 0 }),
    ].join('\n') + '\n')
    assert.equal(createGrantStore(file_).check(p, 'edit').hit, true, '深层合法授权必须能被找到')
    ok('MEDIUM-5 超限记录不遮蔽其它合法授权')
  }

  // ── 同一键多行以最后一行为准 ───────────────────────────────────
  {
    const name = 'lastwins'
    const s = store(name)
    const d = dir(name)
    const p = file(join(d, 'a.txt'))
    s.remember(p, 'edit', evidence)
    const file_ = grantLedgerPath(join(root, name))
    writeFileSync(file_, `${readFileSync(file_, 'utf8').trim()}\n${JSON.stringify({ v: 1, dir: d, opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'x', at: Date.now() - 40 * 24 * 3600 * 1000, useCount: 0 })}\n`)
    assert.equal(createGrantStore(file_).check(p, 'edit').hit, false, '最后一行是过期记录 → 不命中')
    ok('同键多行以最后一行为准')
  }

  // ── LOW-4 账本伪造矩阵 ─────────────────────────────────────────
  {
    const name = 'forged'
    const d = dir(name)
    const file_ = grantLedgerPath(join(root, name))
    mkdirSync(join(root, name, 'dsh-auto-review-router'), { recursive: true })
    const valid = JSON.stringify({ v: 1, dir: d, opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now(), useCount: 0 })
    writeFileSync(file_, [
      '{not json',
      JSON.stringify({ v: 2, dir: d, opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now() }),
      JSON.stringify({ v: 1, dir: d, opClass: 'delete', tool: 'rm', session: 's', approvalRequestId: 'r', at: Date.now() }),
      JSON.stringify({ v: 1, dir: d, opClass: 'Create', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now() }),
      JSON.stringify({ v: 1, dir: '..', opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now() }),
      JSON.stringify({ v: 1, dir: 'c:', opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now() }),
      JSON.stringify({ v: 1, dir: 'c:\\', opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now() }),
      JSON.stringify({ v: 1, dir: d, opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now(), useCount: 999999999 }),
      valid,
    ].join('\n') + '\n')
    const list = createGrantStore(file_).list()
    assert.equal(list.length, 1, `只应保留唯一合法记录（实际 ${JSON.stringify(list.map(g => g.dir))}）`)
    ok('LOW-4 账本伪造行全部被拒')
  }

  // ── 落盘失败 fail closed ────────────────────────────────────────
  {
    const blocked = file(join(root, 'blocked'), 'not a directory')
    const s = createGrantStore(join(blocked, 'nested', 'g.jsonl'))
    const p = file(join(dir('r-fail'), 'a.txt'))
    assert.equal(s.remember(p, 'edit', evidence).ok, false, '写不进去就不记')
    assert.equal(s.check(p, 'edit').hit, false, '记不住绝不静默放行')
    ok('落盘失败 fail closed')
  }

  // ── 证据不全不记 ────────────────────────────────────────────────
  {
    const s = store('evidence')
    const p = file(join(dir('evidence'), 'a.txt'))
    for (const bad of [{}, { session: 's' }, { session: 's', tool: 'edit' }, { session: '', tool: 'edit', approvalRequestId: 'r' }]) {
      assert.equal(s.remember(p, 'edit', bad).ok, false, `证据不全：${JSON.stringify(bad)}`)
    }
    assert.equal(existsSync(grantLedgerPath(join(root, 'evidence'))), false, '不产生空账本')
    ok('证据不全一律不记忆')
  }

  // ── clear ───────────────────────────────────────────────────────
  {
    const s = store('clear')
    const p = file(join(dir('clear'), 'a.txt'))
    s.remember(p, 'edit', evidence)
    assert.equal(s.list().length, 1)
    assert.equal(s.clear(), true)
    assert.equal(s.list().length, 0, '清空后无残留授权')
    assert.equal(s.check(p, 'edit').hit, false)
    ok('clear 撤销全部授权')
  }

  // ── N1 HIGH：hardlink 逃逸授权根 ────────────────────────────────
  if (canHardlink) {
    {
      const s = store('hardlink')
      const base = dir('hardlink')
      const safe = join(base, 'safe'); mkdirSync(safe, { recursive: true })
      const outside = dir('hardlink-outside')
      const victim = join(outside, 'victim.txt')
      writeFileSync(victim, 'ORIGINAL')
      s.remember(file(join(safe, 'ok.txt')), 'edit', evidence)
      // 在授权目录内放一个指向根外文件的 hardlink
      const alias = join(safe, 'notes.txt')
      linkSync(victim, alias)
      const r = s.check(alias, 'edit')
      assert.equal(r.hit, false, `hardlink 必须不命中（实际 ${JSON.stringify(r)}）`)
      // 端到端：即使绕过判定写入，授权根外也不该被改（此处验证 r.hit=false 即可）
      assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', '授权根外文件未被触碰')
      // remember 侧同样拒绝
      assert.equal(s.remember(alias, 'edit', evidence).ok, false, 'hardlink 不可被授权')
      ok('N1 HIGH hardlink 逃逸授权根被拒')
    }
    // hardlink 指向 .git\config —— HIGH-2 的等价变体
    {
      const s = store('hardlink-git')
      const repo = dir('hardlink-git-repo')
      const git = join(repo, '.git'); mkdirSync(git, { recursive: true })
      const cfg = join(git, 'config'); writeFileSync(cfg, '[core]\n')
      const safe = join(repo, 'work'); mkdirSync(safe, { recursive: true })
      s.remember(file(join(safe, 'ok.txt')), 'edit', evidence)
      const alias = join(safe, 'config')
      linkSync(cfg, alias)
      assert.equal(s.check(alias, 'edit').hit, false, '不得借 hardlink 改写 .git/config')
      assert.equal(readFileSync(cfg, 'utf8'), '[core]\n', '.git/config 未被触碰')
      ok('N1b 借 hardlink 改写 .git/config 被拒')
    }
  } else {
    console.log('SKIP hardlink 用例：文件系统不支持')
  }

  // ── N2 HIGH：clear() 撤销必须跨重启生效 ─────────────────────────
  {
    const name = 'revoke'
    const s = store(name)
    const d = dir(name)
    const p = file(join(d, 'a.txt'))
    assert.equal(s.remember(p, 'edit', evidence).ok, true)
    assert.equal(s.check(p, 'edit').hit, true)
    assert.equal(s.clear(), true, 'clear 应成功')
    assert.equal(s.check(p, 'edit').hit, false, 'clear 后本进程不再命中')
    // 关键：模拟重启（新 store 实例）后必须仍然是撤销状态
    const after = createGrantStore(grantLedgerPath(join(root, name)))
    assert.equal(after.check(p, 'edit').hit, false, '重启后撤销不得失效')
    assert.equal(after.list().length, 0, '重启后账本无存活授权')
    ok('N2 HIGH clear() 撤销跨重启生效')
  }

  // ── N4/N5：preview 与 remember/check 同源 ───────────────────────
  {
    const s = store('preview')
    const d = dir('preview')
    const p = file(join(d, 'a.txt'))
    // N4：delete 类不可授权，文案不得承诺
    assert.deepEqual(s.preview(p, 'delete'), { grantable: false, reason: 'not-grantable-op' })
    assert.deepEqual(s.preview(p, undefined), { grantable: false, reason: 'not-grantable-op' })
    // N5：.env 目标不可授权（check 也恒不命中），文案不得承诺 30 天免问
    const env = file(join(d, 'secret.env'), 'K=V')
    assert.equal(s.preview(env, 'edit').grantable, false, '.env 不得承诺可授权')
    assert.equal(s.check(env, 'edit').hit, false)
    // 正常目标：preview 说可授权，remember 也必须真存下
    const good = s.preview(p, 'edit')
    assert.equal(good.grantable, true, `正常目标应可授权（${JSON.stringify(good)}）`)
    assert.equal(s.remember(p, 'edit', evidence).ok, true)
    assert.equal(s.check(p, 'edit').hit, true, 'preview 说能记，check 就必须命中')
    ok('N4/N5 preview 与 remember/check 同源')
  }

  // ── N7：str_replace_editor 的 view 不产生授权 ───────────────────
  {
    const s = store('sre')
    const d = dir('sre')
    const p = file(join(d, 'a.txt'))
    assert.equal(operationClassOf('str_replace_editor', { command: 'view' }), undefined, '只读 view 不记忆')
    assert.equal(operationClassOf('str_replace_editor', { command: 'create' }), 'create')
    assert.equal(operationClassOf('str_replace_editor', { command: 'str_replace' }), 'edit')
    assert.equal(operationClassOf('str_replace_editor', { command: 'insert' }), 'edit')
    assert.equal(operationClassOf('str_replace_editor', { command: 'unknown' }), undefined, '未知 command fail closed')
    assert.equal(operationClassOf('str_replace_editor', {}), undefined, '无 command fail closed')
    ok('N7 str_replace_editor 按 command 分类，view 不授权')
  }

  // ── N3：敏感段覆盖 DSH 记忆目录与包管理器凭据 ───────────────────
  {
    for (const seg of ['.dsh-memory', '.claude', '.m2', '.gradle', 'secrets', 'credentials', '.npm', '.cargo']) {
      assert.equal(isTooBroadRoot(`d:\\proj\\${seg}\\sub`), true, `${seg} 子树不可授权`)
    }
    for (const p of ['c:\\windows\\temp\\x', 'c:\\users\\public\\documents\\x', 'c:\\$recycle.bin\\s-1-5-21-1\\x', 'c:\\inetpub\\wwwroot\\x', 'c:\\perflogs\\x']) {
      assert.equal(isTooBroadRoot(p), true, `${p} 不可授权`)
    }
    ok('N3 敏感段与系统目录覆盖完整')
  }

  // ── N8：账本行数有界（压实）─────────────────────────────────────
  {
    const name = 'compact'
    const s = createGrantStore(grantLedgerPath(join(root, name)), { maxLedgerLines: 20, maxUseCount: 1000 })
    const d = dir(name)
    const p = file(join(d, 'a.txt'))
    s.remember(p, 'edit', evidence)
    for (let i = 0; i < 200; i += 1) s.check(p, 'edit')
    const lines = readFileSync(grantLedgerPath(join(root, name)), 'utf8').trim().split('\n').filter(Boolean)
    assert.ok(lines.length <= 40, `账本行数必须有界（实际 ${lines.length}）`)
    assert.equal(s.check(p, 'edit').hit, true, '压实后授权仍有效')
    // 重启后要用同一组上限，否则 200 次已超过默认 100 次上限（那是正确行为，不是缺陷）
    const reopened = createGrantStore(grantLedgerPath(join(root, name)), { maxLedgerLines: 20, maxUseCount: 1000 })
    assert.equal(reopened.check(p, 'edit').hit, true, '压实后重启仍有效')
    const counted = reopened.check(p, 'edit')
    assert.equal(counted.hit, true)
    // 超过 1000 次上限后应停止命中（默认上限下的行为另测）
    for (let i = 0; i < 1000; i += 1) reopened.check(p, 'edit')
    assert.equal(reopened.check(p, 'edit').hit, false, '超过次数上限应停止免问')
    ok('N8 账本行数有界（压实），重启后计数延续')
  }

  // ── N10：isInside 大小写归一 ────────────────────────────────────
  {
    assert.equal(isInside('D:\\PROJ\\x', 'd:\\proj'), true, '大小写不同仍应判定为在内')
    assert.equal(isInside('d:\\proj', 'D:\\PROJ'), true)
    assert.equal(isInside('d:\\proj2\\x', 'd:\\proj'), false, '前缀相同但不同目录不得误判')
    ok('N10 isInside 大小写归一')
  }

  // ── 第三轮 HIGH-2：compact() 不得抹掉触发压实的那条授权 ─────────
  {
    const name = 'compact-edge'
    const ledger = grantLedgerPath(join(root, name))
    // 上界设成 3，让第 3 条 remember 正好触发压实
    const s = createGrantStore(ledger, { maxLedgerLines: 3, maxUseCount: 1000 })
    const d = dir(name)
    for (let i = 0; i < 3; i += 1) {
      const p = file(join(d, `f${i}.txt`))
      assert.equal(s.remember(p, 'edit', evidence).ok, true, `第 ${i + 1} 条授权应写入`)
    }
    // 三条都必须跨重启存活 —— 压实不得吃掉触发它的最后一条
    const reopened = createGrantStore(ledger, { maxLedgerLines: 3, maxUseCount: 1000 })
    for (let i = 0; i < 3; i += 1) {
      const p = join(d, `f${i}.txt`)
      assert.equal(reopened.check(p, 'edit').hit, true, `第 ${i + 1} 条授权在压实后必须存活`)
    }
    ok('第三轮 HIGH-2 compact() 不丢触发压实的那条授权')
  }

  // ── 第三轮 MEDIUM-3：单段也必须查敏感表 ─────────────────────────
  {
    for (const p of ['c:\\inetpub', 'c:\\secrets', 'c:\\recovery', 'c:\\sysvol', 'c:\\appdata', 'd:\\secrets', 'd:\\keys']) {
      assert.equal(isTooBroadRoot(p), true, `单段 ${p} 不可授权`)
    }
    // 反向：正常项目根仍可授权
    for (const p of ['d:\\proj', 'd:\\proj\\app', 'd:\\dsh-guard\\packages']) {
      assert.equal(isTooBroadRoot(p), false, `正常项目根 ${p} 应可授权`)
    }
    ok('第三轮 MEDIUM-3 单段路径也查敏感表')
  }

  // ── 第三轮 MEDIUM-4：凭据文件名纳入保护 ─────────────────────────
  {
    const s = store('cred')
    const d = dir('cred')
    for (const name of ['.npmrc', 'id_rsa', 'credentials.json', 'service-account.json', '.pypirc', '.git-credentials']) {
      const p = file(join(d, name), 'x')
      assert.equal(s.preview(p, 'edit').grantable, false, `${name} 不得可授权`)
      assert.equal(s.remember(p, 'edit', evidence).ok, false, `${name} 不得被记住`)
    }
    // 目录被授权后，这些文件在 check 侧也要每次重问
    const okFile = file(join(d, 'main.js'))
    assert.equal(s.remember(okFile, 'edit', evidence).ok, true)
    for (const name of ['.npmrc', 'id_rsa']) {
      assert.equal(s.check(file(join(d, name)), 'edit').hit, false, `${name} 在已授权目录内仍须重问`)
    }
    assert.equal(s.check(okFile, 'edit').hit, true)
    ok('第三轮 MEDIUM-4 凭据文件名纳入保护')
  }

  // ── 第三轮 MEDIUM-5：时钟回拨不得让墓碑永久压死新授权 ───────────
  {
    const name = 'clock'
    const ledger = grantLedgerPath(join(root, name))
    const first = createGrantStore(ledger)
    const d = dir(name)
    const p = file(join(d, 'a.txt'))
    assert.equal(first.remember(p, 'edit', evidence).ok, true)
    assert.equal(first.clear(), true)
    // 模拟时钟回拨：把「现在」设到墓碑之前
    const realNow = Date.now
    const tombstoneAt = realNow()
    Date.now = () => tombstoneAt - 60_000
    try {
      const rewound = createGrantStore(ledger)
      assert.equal(rewound.clear(), false || true)   // 再次 clear 也应成功
      const revived = createGrantStore(ledger)
      // 重新授权必须真的写进去，且跨重启存活
      const r = revived.remember(p, 'edit', evidence)
      assert.equal(r.ok, true, '时钟回拨后重新授权必须成功')
      const after = createGrantStore(ledger)
      assert.equal(after.check(p, 'edit').hit, true, '时钟回拨下的新授权必须跨重启存活')
    } finally {
      Date.now = realNow
    }
    ok('第三轮 MEDIUM-5 时钟回拨不压死新授权')
  }

  // ── 第三轮 LOW-2：两个 store 实例共享一份账本，不得互相抹掉 ───────
  {
    const name = 'multi-instance'
    const ledger = grantLedgerPath(join(root, name))
    // 上界 3：store2 的第 3 条会触发 compact()，正好是丢更新的时机
    const store1 = createGrantStore(ledger, { maxLedgerLines: 3, maxUseCount: 1000 })
    const store2 = createGrantStore(ledger, { maxLedgerLines: 3, maxUseCount: 1000 })
    const d1 = dir(`${name}-a`)
    const d2 = dir(`${name}-b`)
    const p1 = file(join(d1, 'a.txt'))
    const p2 = file(join(d2, 'b.txt'))
    // 交替授权：两个实例各写两条，store2 最后一条触发压实
    assert.equal(store1.remember(p1, 'edit', evidence).ok, true, 'store1 第 1 条')
    assert.equal(store2.remember(p2, 'edit', evidence).ok, true, 'store2 第 1 条')
    assert.equal(store1.remember(p1, 'create', evidence).ok, true, 'store1 第 2 条（不同 opClass）')
    assert.equal(store2.remember(p2, 'create', evidence).ok, true, 'store2 第 2 条 → 触发压实')
    // store1 写的授权不得被 store2 的压实抹掉
    assert.equal(store1.check(p1, 'edit').hit, true, 'store1 的授权必须仍在')
    assert.equal(store2.check(p2, 'edit').hit, true, 'store2 的授权必须仍在')
    // 跨「重启」验证：磁盘上的内容必须完整
    const reopened = createGrantStore(ledger, { maxLedgerLines: 3, maxUseCount: 1000 })
    assert.equal(reopened.check(p1, 'edit').hit, true, '重启后 store1 的授权仍在')
    assert.equal(reopened.check(p2, 'edit').hit, true, '重启后 store2 的授权仍在')
    assert.equal(reopened.check(p1, 'create').hit, true, '重启后 store1 的 create 授权仍在')
    assert.equal(reopened.check(p2, 'create').hit, true, '重启后 store2 的 create 授权仍在')
    ok('第三轮 LOW-2 多实例压实不丢对方的授权')
  }

  console.log(`grant-store: ${passed} 组场景通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
  console.log('临时目录已清理')
}
