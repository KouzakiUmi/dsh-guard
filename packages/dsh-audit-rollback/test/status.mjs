#!/usr/bin/env node
/**
 * 假 ctx 调用 Host 只读状态查询。
 * 覆盖账本统计、objects 统计、capture 明细、配置回显。
 * 数据只写系统临时目录（mkdtemp，finally 清理），不落仓库、不写 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, queryAuditStatus, auditStatusRemote } from '../lib/index.js'
import { appendEntry, capturePath, initState, putObject, sha1Hex } from '../lib/ledger.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-audit-status-'))
const stateDir = join(tmpRoot, 'state')
const sample = join(tmpRoot, 'sample.txt')
const sampleText = 'hello-audit'

initState(stateDir)
writeFileSync(sample, sampleText)
appendEntry(stateDir, { kind: 'turn/start', session: 's', turn: 1 })
appendEntry(stateDir, { kind: 'call', session: 's', turn: 1, tool: 'write' })
const captured = capturePath(stateDir, {
  session: 's',
  turn: 1,
  path: sample,
  phase: 'before',
  maxBytes: 4096,
})
appendEntry(stateDir, { kind: 'turn/end', session: 's', turn: 1, captured: 1 })
appendEntry(stateDir, { kind: 'rollback', session: 's', turn: 1, applied: false })
appendEntry(stateDir, { kind: 'note', text: 'status-test' })
putObject(stateDir, Buffer.from('object-bytes'))

const fakeCtx = {
  logger: { info() {}, warn() {} },
  config: {
    stateDir,
    captureTools: ['write'],
    captureMaxBytes: 111,
    argsMaxBytes: 222,
    logCalls: false,
    excludeGlobs: ['/custom/'],
    gitSnapshot: true,
  },
}

let failed = 0
function ok(label, fn) {
  try {
    fn()
    console.log(`通过  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`失败  ${label}`)
    console.error(error)
  }
}

try {
ok('假 ctx 回显账本、objects、capture 与配置', () => {
  const status = queryAuditStatus(fakeCtx)
  assert.equal(status.plugin, 'dsh-audit-rollback')
  assert.equal(status.state.stateDir, stateDir)
  assert.equal(status.state.version, 1)
  assert.equal(typeof status.state.createdAt, 'string')
  assert.equal(status.ledger.fileCount, 1)
  assert.equal(status.ledger.entryCount, 6)
  assert.equal(status.ledger.byKind['turn/start'], 1)
  assert.equal(status.ledger.byKind.call, 1)
  assert.equal(status.ledger.byKind.capture, 1)
  assert.equal(status.ledger.byKind['turn/end'], 1)
  assert.equal(status.ledger.byKind.rollback, 1)
  assert.equal(status.ledger.byKind.note, 1)
  assert.equal(status.ledger.byKind.other, 0)
  assert.equal(status.objects.count, 2)
  assert.ok(status.objects.totalBytes >= Buffer.byteLength(sampleText) + Buffer.byteLength('object-bytes'))
  assert.equal(status.captures.uniquePaths, 1)
  assert.equal(status.captures.recent.length, 1)
  const row = status.captures.recent[0]
  assert.equal(row.phase, 'before')
  assert.equal(row.fileName, 'sample.txt')
  assert.equal(row.bytes, Buffer.byteLength(sampleText))
  assert.equal(row.hashPrefix, sha1Hex(Buffer.from(sampleText)).slice(0, 8))
  assert.equal(row.hashPrefix.length, 8)
  assert.equal(typeof row.ts, 'string')
  assert.equal(captured.hash.slice(0, 8), row.hashPrefix)
  assert.deepEqual(status.config.captureTools, ['write'])
  assert.equal(status.config.captureMaxBytes, 111)
  assert.equal(status.config.argsMaxBytes, 222)
  assert.equal(status.config.logCalls, false)
  assert.deepEqual(status.config.excludeGlobs, ['/custom/'])
  assert.equal(status.config.gitSnapshot, true)
  console.log(JSON.stringify({
    stateDir: status.state.stateDir,
    version: status.state.version,
    ledger: status.ledger,
    objects: status.objects,
    capture: row,
    config: status.config,
  }))
})

ok('apply 后的假 ctx 读到本次生效配置，且不要求 reflect/inject', () => {
  const live = {
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(fn) { const dispose = fn(); return dispose },
    get() { return undefined },
    config: { captureTools: ['stale'] },
  }
  apply(live, { stateDir, captureTools: ['edit'], gitSnapshot: false })
  const status = queryAuditStatus(live)
  assert.deepEqual(status.config.captureTools, ['edit'])
  assert.equal(status.config.gitSnapshot, false)
  assert.equal(status.state.stateReady, true)
  assert.equal(status.ledger.entryCount, 6)
})

ok('client 描述符与 host 逐字段全等，且两端都没有核心包 import', () => {
  const client = readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8')
  const host = readFileSync(join(testDir, '..', 'lib', 'index.js'), 'utf8')
  const descriptor = auditStatusRemote.descriptors[0]
  assert.equal(descriptor.id, 'dsh-audit-rollback#auditRollback/read')
  // 客户端是 ModuleLoader factory 无法 import，从源码文本提取描述符字段与 host 逐字段严格相等。
  // （此前用 includes 子串断言，read→readX 这类变异会幸存。）
  const grab = (pattern, field) => {
    const match = client.match(pattern)
    assert.ok(match, `client.js 未找到描述符字段 ${field}`)
    return match[1]
  }
  const extracted = {
    id: grab(/\bid:\s*'([^']*#[^']*)'/, 'id'),
    service: grab(/\bservice:\s*'([^']+)'/, 'service'),
    namespace: grab(/\bnamespace:\s*'([^']+)'/, 'namespace'),
    method: grab(/\bmethod:\s*'([^']+)'/, 'method'),
    typeSymbol: grab(/\btypeSymbol:\s*'([^']+)'/, 'typeSymbol'),
  }
  assert.equal(extracted.id, descriptor.id)
  assert.equal(extracted.service, descriptor.service)
  assert.equal(extracted.namespace, descriptor.namespace)
  assert.equal(extracted.method, descriptor.method)
  assert.equal(extracted.typeSymbol, descriptor.result.typeSymbol)
  // 客户端实际调用点 call('<method>') 必须与描述符 method 一致，否则运行时 Host 缺方法。
  const invokedMethods = [...client.matchAll(/\bcall\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.ok(invokedMethods.length > 0, 'client.js 未找到 call(...) 调用点')
  for (const invoked of invokedMethods) {
    assert.equal(invoked, descriptor.method)
  }
  assert.ok(client.includes("require('react')"))
  const forbidden = /(?:from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\/|import\(\s*['"]@deepseek-ai\/)/
  assert.equal(forbidden.test(client), false)
  assert.equal(forbidden.test(host), false)
})

ok('client 设置页注册契约：settings.section 主入口 + plugins.tab 探针附加', () => {
  const client = readFileSync(join(testDir, '..', 'lib', 'client.js'), 'utf8')
  const grab = (pattern, field) => {
    const match = client.match(pattern)
    assert.ok(match, `client.js 未找到设置页注册字段 ${field}`)
    return match[1]
  }
  // 实机验证结论：plugins.tab 单独注册会静默不出现（inject 等待语义，try/catch 回退不触发），
  // 因此 settings.section 必须是主入口且在前，plugins.tab 降级为探针可选附加。
  const registrations = [...client.matchAll(/registerInto\('([^']+)', entry\.(\w+)\)/g)]
    .map((match) => ({ slot: match[1], idField: match[2] }))
  assert.deepEqual(registrations, [
    { slot: 'settings.section', idField: 'id' },
    { slot: 'settings.plugins.tab', idField: 'tabId' },
  ])
  // 两个槽的注册 id 必须不同（同一 id 跨槽注册虽合法，但区分 id 便于日志定位）。
  // 描述符 id 含 '#' 被 [^'#]+ 排除，首个匹配即 entry.id。
  const entryId = grab(/\bid:\s*'([^'#]+)'/, 'entry.id')
  const tabId = grab(/\btabId:\s*'([^']+)'/, 'entry.tabId')
  assert.notEqual(entryId, tabId)
  // 注册字段对齐官方范本：label 走 t('nav')，且 locale 命名空间随注册提交（entry 与 register 各一处代码行）。
  assert.equal(grab(/\blabel:\s*\(\) => t\('([^']+)'\)/, 'label key'), 'nav')
  assert.equal([...client.matchAll(/^\s*locale:\s*NS,$/gm)].length, 2)
  // 探针用 ctx.slots.spec()（Slots 服务公开方法，未声明返回 undefined），不靠 try/catch 兜底。
  assert.equal(grab(/ctx\.slots\.spec\('([^']+)'\)/, 'probe slot'), 'settings.plugins.tab')
  assert.equal(client.includes('退回 settings.section'), false, '旧的 try/catch 回退路径必须删除')
  // apply 入口必须有加载日志，否则「没出现且无报错」无法定位。
  assert.ok(client.includes("console.info('[dsh-audit-rollback] client 已加载')"), '缺 apply 入口日志')
})

} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
}
if (failed > 0) {
  console.error(`status: ${failed} 项失败`)
  process.exit(1)
}
console.log('status: 全部通过')
