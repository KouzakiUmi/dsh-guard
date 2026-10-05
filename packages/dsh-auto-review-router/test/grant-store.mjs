// 授权记忆（询问抑制器）的安全边界回归。零网络、零模型、只用临时目录。
import './runtime.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGrantStore, targetPathOf, operationClassOf, grantLedgerPath,
  isProtectedTarget, isTooBroadRoot, setCanonicalPath } from '../lib/grant-store.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-grant-'))
const ledger = grantLedgerPath(root)
let passed = 0
const ok = (name) => { passed += 1; console.log(`PASS ${name}`) }

try {
  // 记忆键必须锚定规范化后的实际目标：注入一个会改写路径的 canonicalPath 验证确实被调用。
  {
    let called = 0
    setCanonicalPath(p => { called += 1; return p })
    const store = createGrantStore(ledger)
    const dir = join(root, 'proj'); mkdirSync(dir, { recursive: true })
    const target = join(dir, 'a.txt'); writeFileSync(target, 'x')
    assert.equal(store.check(target, 'edit').hit, false)
    assert.deepEqual(store.remember(target, 'edit', { session: 's', tool: 'edit', approvalRequestId: 'r' }), { ok: true, reason: 'stored' })
    assert.ok(called > 0, 'canonicalPath 注入被实际调用')
    assert.equal(store.check(target, 'edit').hit, true, '同目录同操作命中')
    setCanonicalPath(null)
    ok('记忆键走 canonicalPath（Codex issue #4212 教训）')
  }

  // R1：不在已授权根之下 → 不命中
  {
    const store = createGrantStore(ledger)
    const other = join(root, 'other.txt'); writeFileSync(other, 'x')
    const r = store.check(other, 'edit')
    assert.equal(r.hit, false); assert.equal(r.reason, 'not-granted')
    ok('R1 授权根之外不命中')
  }

  // R2：.git / .codex / .agents / .ssh / *.env 受保护前缀不受记忆抑制
  {
    const store = createGrantStore(ledger)
    const base = join(root, 'r2'); mkdirSync(base, { recursive: true })
    for (const seg of ['.git', '.codex', '.agents', '.ssh']) {
      const p = join(base, seg, 'config'); mkdirSync(join(base, seg), { recursive: true }); writeFileSync(p, 'x')
      assert.equal(store.remember(p, 'edit', { session: 's', tool: 'edit', approvalRequestId: 'r' }).ok, false, `${seg} 目录本身不可授权`)
      assert.equal(store.check(p, 'edit').hit, false, `${seg} 下写入每次重问`)
    }
    const env = join(base, 'x.env'); writeFileSync(env, 'k=v')
    // .env 所在目录仍可授权（授权粒度是目录），但写 .env 本身每次重问。
    assert.equal(store.remember(env, 'edit', { session: 's', tool: 'edit', approvalRequestId: 'r' }).ok, true, '含 .env 的目录可授权')
    assert.equal(store.check(env, 'edit').hit, false, '写 .env 仍每次重新问')
    assert.equal(isProtectedTarget(env.toLowerCase(), base.toLowerCase()), true)
    const plain = join(base, 'ok.txt'); writeFileSync(plain, 'x')
    assert.equal(store.check(plain, 'edit').hit, true, '同目录普通文件免问')
    ok('R2 敏感文件不受记忆抑制（.git/.env 每次重问）')
  }

  // R3：删除类永不记忆
  {
    const store = createGrantStore(ledger)
    const p = join(root, 'r3.txt'); writeFileSync(p, 'x')
    for (const tool of ['delete', 'rm', 'unlink', 'rmdir']) {
      assert.equal(operationClassOf(tool, {}).startsWith('delete'), true, `${tool} 归为删除类`)
      assert.equal(store.remember(p, operationClassOf(tool, {}), { session: 's', tool, approvalRequestId: 'r' }).ok, false)
    }
    assert.equal(store.check(p, 'delete').hit, false)
    assert.equal(operationClassOf('write', {}), 'create')
    assert.equal(operationClassOf('edit', {}), 'edit')
    assert.equal(operationClassOf('unknown_tool', {}), undefined, '未知工具不记忆')
    assert.equal(operationClassOf('pwsh', { command: 'rm -rf /' }), undefined, 'shell 类不做目录记忆')
    ok('R3 删除类与 shell 类永不记忆')
  }

  // R8：过宽的根永不记忆
  {
    const store = createGrantStore(ledger)
    assert.equal(isTooBroadRoot('c:\\'), true)
    assert.equal(isTooBroadRoot('c:\\users'), true)
    assert.equal(store.remember('C:\\Users\\Fractal\\anything.txt', 'edit', { session: 's', tool: 'edit', approvalRequestId: 'r' }).ok, false)
    ok('R8 盘根/用户根不可授权')
  }

  // R10：使用次数超限 → 重新问
  {
    const local = grantLedgerPath(join(root, 'r10'))
    const store = createGrantStore(local, { maxUseCount: 2 })
    const dir = join(root, 'r10'); mkdirSync(dir, { recursive: true })
    const p = join(dir, 'a.txt'); writeFileSync(p, 'x')
    store.remember(p, 'edit', { session: 's', tool: 'edit', approvalRequestId: 'r' })
    assert.equal(store.check(p, 'edit').hit, true, '第 1 次')
    assert.equal(store.check(p, 'edit').hit, true, '第 2 次')
    assert.equal(store.check(p, 'edit').hit, false, '第 3 次触发上限')
    ok('R10 使用次数超限重新询问')
  }

  // 操作类别不匹配不命中（抄 Codex：目录 + 操作类别，不是整条命令）
  {
    const store = createGrantStore(ledger)
    const dir = join(root, 'r-op'); mkdirSync(dir, { recursive: true })
    const p = join(dir, 'a.txt'); writeFileSync(p, 'x')
    store.remember(p, 'edit', { session: 's', tool: 'edit', approvalRequestId: 'r' })
    assert.equal(store.check(p, 'create').hit, false, '类别不同不命中')
    assert.equal(store.check(p, 'edit').hit, true, '同类命中')
    ok('授权按 目录+操作类别 匹配，不按整条命令')
  }

  // 落盘失败即不记（fail closed：记不住就继续问）
  {
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'not a directory')
    const store = createGrantStore(join(blocked, 'nested', 'g.jsonl'))
    const p = join(root, 'r-fail.txt'); writeFileSync(p, 'x')
    const r = store.remember(p, 'edit', { session: 's', tool: 'edit', approvalRequestId: 'r' })
    assert.equal(r.ok, false, '写不进去就不记')
    assert.equal(store.check(p, 'edit').hit, false, '记不住绝不静默放行')
    ok('落盘失败 fail closed')
  }

  // 证据不全不记
  {
    const store = createGrantStore(grantLedgerPath(join(root, 'r-ev')))
    const p = join(root, 'r-ev.txt'); writeFileSync(p, 'x')
    for (const bad of [{}, { session: 's' }, { session: 's', tool: 'edit' }, { session: '', tool: 'edit', approvalRequestId: 'r' }]) {
      assert.equal(store.remember(p, 'edit', bad).ok, false, `证据不全：${JSON.stringify(bad)}`)
    }
    assert.equal(targetPathOf({ file_path: 'relative.txt' }), undefined, '相对路径不猜')
    assert.equal(targetPathOf({ path: join(root, 'abs.txt') }), join(root, 'abs.txt'))
    assert.equal(targetPathOf({}), undefined)
    ok('证据不全与相对路径一律不记忆')
  }

  // 损坏行不影响其余记录
  {
    const dir = join(root, 'r-corrupt'); mkdirSync(dir, { recursive: true })
    const file = grantLedgerPath(dir)
    mkdirSync(join(dir, 'dsh-auto-review-router'), { recursive: true })
    writeFileSync(file, [
      '{not json',
      JSON.stringify({ v: 1, dir: join(root, 'ok').toLowerCase(), opClass: 'edit', tool: 'edit', session: 's', approvalRequestId: 'r', at: Date.now(), useCount: 0 }),
      JSON.stringify({ v: 2, dir: 'x', opClass: 'delete', tool: 'rm', session: 's', approvalRequestId: 'r', at: Date.now() }),
    ].join('\n') + '\n')
    const store = createGrantStore(file)
    assert.equal(store.list().length, 1, '只保留合法记录')
    ok('损坏与非法记录被丢弃，不影响合法授权')
  }

  console.log(`grant-store: ${passed} 组场景通过；临时目录已清理`)
} finally {
  await rm(root, { recursive: true, force: true })
}
