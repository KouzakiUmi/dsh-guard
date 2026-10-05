// 授权记忆（询问抑制器）的安全边界回归。零网络、零模型、只用临时目录。
// 2026-10-05 改造：授权记忆改为**本次运行内有效（纯内存）**，原先验证落盘、
// 压实、墓碑、时钟回拨、多实例并发的场景已随持久化层一并删除。
// 保留的是与存储无关的路径安全判定：junction/hardlink 逃逸、敏感段、
// 过宽根、操作类别、判定同源。
import './runtime.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, readFileSync, rmSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGrantStore, targetPathOf, operationClassOf,
  isProtectedTarget, isTooBroadRoot, verifyAncestors, isInside, canonicalPathKey } from '../lib/grant-store.js'

// Windows 上 os.tmpdir() 落在 %LOCALAPPDATA%\Temp，而 AppData 是授权记忆的
// 敏感段（会把 fixture 判成过宽根）—— 那里用 D 盘根下的一次性目录，
// 语义上等价于「普通项目目录」。其它平台直接用系统临时目录：
// 硬编码 D:\ 在 Linux 上不是绝对路径，所有路径判定会提前失败（CI 曾因此变红）。
const isWin = process.platform === 'win32'
const root = mkdtempSync(join(isWin ? 'D:\\' : tmpdir(), 'dsh-grant-test-'))
const evidence = { tool: 'edit', approvalRequestId: 'r' }
// 内存 store：每次调用建一个独立实例；作用域是本次运行，无落盘。
const store = () => createGrantStore()
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
  // 段名判定与平台无关（无论盘符语义如何，段里含 AppData 就是过宽）；
  // 带盘符/绝对根形态的断言只在对应平台有意义，分开写以免互相掩盖。
  {
    if (isWin) {
      assert.equal(isTooBroadRoot('c:\\'), true, '盘根过宽')
      assert.equal(isTooBroadRoot('c:\\users'), true)
      assert.equal(isTooBroadRoot('c:\\users\\fractal'), true, 'win32 profile 根过宽')
      assert.equal(isTooBroadRoot('c:\\users\\fractal\\.dsh'), true, '~/.dsh 不可授权')
      assert.equal(isTooBroadRoot('c:\\users\\fractal\\appdata\\local\\temp'), true, 'AppData 不可授权')
      assert.equal(isTooBroadRoot('c:\\program files\\dsh next\\resources\\app'), true, 'DSH 安装目录不可授权')
      assert.equal(isTooBroadRoot('d:\\dsh-guard'), false, '项目根不应被连坐（复核实测此处过宽）')
      assert.equal(isTooBroadRoot('d:\\dsh-guard\\packages'), false, '项目子目录可授权')
      const s = store('r8')
      assert.equal(s.remember('C:\\Users\\Fractal\\.dsh\\settings.json', 'create', evidence).ok, false,
        'profile 下的 .dsh 不可授权')
    } else {
      assert.equal(isTooBroadRoot('/'), true, '文件系统根过宽')
      assert.equal(isTooBroadRoot('/home'), true)
      assert.equal(isTooBroadRoot('/home/user'), true, 'POSIX 家目录根过宽')
      assert.equal(isTooBroadRoot('/root'), true, '/root 过宽')
      assert.equal(isTooBroadRoot('/home/user/.dsh'), true, '~/.dsh 不可授权')
      assert.equal(isTooBroadRoot('/home/user/.config/app'), true, '.config 不可授权')
      const s = store('r8')
      assert.equal(s.remember('/home/user/.ssh/id_rsa', 'edit', evidence).ok, false, '凭据路径不可授权')
      // 反向：普通项目根不受连坐
      assert.equal(isTooBroadRoot('/srv/project'), false, '项目根不应被连坐')
      assert.equal(isTooBroadRoot('/srv/project/app'), false, '项目子目录可授权')
      assert.equal(isTooBroadRoot('/srv/project/root'), false, '中间段叫 root 不应误伤')
    }
    ok(`MEDIUM-1 R8：敏感子树拒、普通项目目录不连坐（${process.platform}）`)
  }

  // ── 证据不全不记 ────────────────────────────────────────────────
  {
    const s = store('evidence')
    const p = file(join(dir('evidence'), 'a.txt'))
    // 契约：`tool` 必填（记忆必须能追溯到一次真实的人工放行）；
    // `approvalRequestId` 可选 —— 它由 SDK 的 approval/asked 事件异步带入，
    // 拿不到时不应阻断记忆，只在有值时记下来供审计关联。
    for (const bad of [{}, { approvalRequestId: 'r' }, { tool: '', approvalRequestId: 'r' },
      { tool: 42, approvalRequestId: 'r' }, null, 'edit']) {
      assert.equal(s.remember(p, 'edit', bad).ok, false, `证据不全：${JSON.stringify(bad)}`)
    }
    assert.equal(s.check(p, 'edit').hit, false, '证据不全不得产生授权')
    // 无 approvalRequestId 时必须照样写入，且字段落成 null 而不是 undefined
    assert.equal(s.remember(p, 'edit', { tool: 'edit' }).ok, true, '缺 approvalRequestId 不应阻断记忆')
    assert.equal(s.check(p, 'edit').hit, true)
    assert.equal(s.list()[0].approvalRequestId, null, '缺 id 时应落 null')
    ok('证据契约：tool 必填、approvalRequestId 可选')
  }

  // ── 内存作用域：clear 立刻生效，且不跨实例泄漏 ───────────────────
  {
    const s = store('scope')
    const d = dir('scope')
    const p = file(join(d, 'a.txt'))
    assert.equal(s.remember(p, 'edit', evidence).ok, true)
    assert.equal(s.check(p, 'edit').hit, true, '授权后免问')
    assert.equal(s.clear(), true, 'clear 应成功')
    assert.equal(s.check(p, 'edit').hit, false, 'clear 后立刻重新询问')
    assert.equal(s.list().length, 0, 'clear 后列表为空')
    // 另一个实例看不到别人的授权 —— 作用域是本次运行内的单个 store
    const other = store('scope-other')
    assert.equal(other.check(p, 'edit').hit, false, '不同实例之间不共享授权')
    ok('内存作用域：clear 立刻生效、实例间不共享')
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

  // ── N10：isInside 的目录归属判定 ────────────────────────────────
  {
    if (isWin) {
      // 大小写归一只有 win32 才有（canonicalPathKey 在 POSIX 上原样返回）。
      assert.equal(isInside('D:\\PROJ\\x', 'd:\\proj'), true, '大小写不同仍应判定为在内')
      assert.equal(isInside('d:\\proj', 'D:\\PROJ'), true)
    } else {
      assert.equal(isInside('/proj/x', '/proj'), true, 'POSIX：子路径必须判定为在内')
      assert.equal(isInside('/proj', '/proj'), true, '自身算在内')
      assert.equal(isInside('/PROJ/x', '/proj'), false, 'POSIX 区分大小写')
    }
    // 这两条与平台无关：前缀相似但不是子目录必须判否。
    assert.equal(isInside(join(root, 'proj2', 'x'), join(root, 'proj')), false, '前缀相同但不同目录不得误判')
    ok(`N10 isInside 目录归属判定（${process.platform}）`)
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

  console.log(`grant-store: ${passed} 组场景通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
  console.log('临时目录已清理')
}
