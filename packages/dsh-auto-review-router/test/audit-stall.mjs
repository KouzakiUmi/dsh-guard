// P1-A 回归：审计持久 I/O 永 pending（memory fs）时，审批门、调用方取消、热禁用、
// 卸载、查询都必须有界结束；stall 后共享 writer 被 quarantine（绝不开第二 writer），
// 旧 I/O 晚完成不得乱序或掩盖 gap。零真实模型请求；只用测试自有目录。
import './runtime.mjs'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { updateVolatile } = await import('@deepseek-ai/cosmokit')
const { createApprovalHistory } = await import('../lib/approval-history.js')
const { Config } = await import('../lib/config.js')
const router = await import('../lib/index.js')

const testDir = dirname(fileURLToPath(import.meta.url))
const temp = await fs.mkdtemp(join(testDir, '.tmp-stall-'))
const stores = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const never = () => new Promise(() => {})
const settledWithin = async (promise, ms, label) => {
  const start = Date.now()
  const value = await promise
  assert.ok(Date.now() - start < ms, `${label} 必须在 ${ms}ms 内有界结束`)
  return value
}

/** fs.stat / open / write / datasync 四个阶段之一永久 pending 的注入 fs。 */
function hangingFs(point) {
  if (point === 'stat') return { ...fs, stat: never }
  if (point === 'open') return { ...fs, open: never }
  return {
    ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args)
      return {
        writeFile: point === 'write' ? never : line => handle.writeFile(line),
        datasync: point === 'datasync' ? never : () => handle.datasync(),
        close: () => handle.close(),
      }
    },
  }
}

function unitStore(name, options) {
  const profile = join(temp, name)
  const warnings = []
  const session = { id: `session-${name}`, snapshotEvents: () => [] }
  const ctx = { profileContext: { dir: profile }, sessions: { get: id => id === session.id ? session : undefined },
    logger: { warn: message => warnings.push(message) } }
  const result = createApprovalHistory(ctx, options)
  stores.push(result)
  return { result, profile, session, warnings }
}
function execOf(session, callId) {
  return { token: Symbol(callId), agent: { session }, callId, rootCallId: callId, name: 'edit', parent: undefined, signal: new AbortController().signal }
}

try {
  // —— 单元层：四个 I/O 阶段各自永 pending 时，enqueue 同步、quarantine、drain/close/query 有界 ——
  for (const point of ['stat', 'open', 'write', 'datasync']) {
    const s = unitStore(`hang-${point}`, { fs: hangingFs(point), stallTimeoutMs: 40, drainTimeoutMs: 150, queryTimeoutMs: 150 })
    const entry = s.result.begin(execOf(s.session, `call-${point}`))
    assert.equal(s.result.record(entry, 'reviewer', 'allow'), true, `${point}: record 必须同步入队返回，不等落盘`)
    await sleep(90) // stallTimeoutMs=40 的看门狗已触发
    assert.equal(s.result.health().gap, true, `${point}: stall 必须记 health gap`)
    assert.equal(s.result.health().lastErrorCode, 'AUDIT_IO_STALL', `${point}: stall 错误码`)
    assert.equal(s.result.health().writeFailures, 1, `${point}: stall 计入 writeFailures`)
    assert.equal(s.result.record(entry, 'downstream', 'allow'), false, `${point}: quarantine 后显式丢弃`)
    assert.equal(s.result.health().lastErrorCode, 'AUDIT_WRITER_QUARANTINED')
    assert.equal(s.result.health().droppedRecords, 1)
    const page = await settledWithin(s.result.history({ sessionId: s.session.id }), 1000, `${point}: 查询`)
    // stat 悬挂时读也超时（history-unavailable）；datasync 悬挂时写入已提交、读可见至多一行。
    assert.ok(page.error?.code === 'history-unavailable' || page.value.records.length <= 1, `${point}: 查询有界且不乱序`)
    await settledWithin(s.result.drain(), 1000, `${point}: drain`)
    await settledWithin(s.result.close(), 1000, `${point}: close`)
    // quarantined writer 留在 writersByDir：同 profile 的新 store 不得开出第二 writer。
    const again = unitStore(`hang-${point}`, { fs: hangingFs(point), stallTimeoutMs: 40, drainTimeoutMs: 150, queryTimeoutMs: 150 })
    const entry2 = again.result.begin(execOf(again.session, `call-${point}-2`))
    assert.equal(again.result.record(entry2, 'reviewer', 'allow'), false, `${point}: 同目录新 store 必须复用已 quarantine 的 writer`)
    assert.equal(again.result.health().lastErrorCode, 'AUDIT_WRITER_QUARANTINED')
    await again.result.close()
    assert.ok(!again.warnings.join('').includes('秘密'), `${point}: 警告不得夹带内容`)
  }
  console.log('PASS stat/open/write/datasync 四阶段永 pending：同步 enqueue、quarantine 无第二 writer、drain/close/query 有界')

  // —— 顺序与 gap 真实性：datasync 悬挂时 fs.write 已提交（不可撤销），释放后晚完成不得更新元数据，
  //    后续记录全部丢弃，盘上只有已提交的一行，无空洞无乱序 ——
  {
    const data = new Map()
    let releaseDatasync
    const gate = new Promise(resolve => { releaseDatasync = resolve })
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const memfs = {
      async stat(path) { const c = data.get(path); if (c === undefined) throw enoent(); return { size: Buffer.byteLength(c), mtimeMs: 1, ino: 1 } },
      async readFile(path) { const c = data.get(path); if (c === undefined) throw enoent(); return c },
      async mkdir() {},
      async open(path) {
        return {
          async writeFile(line) { data.set(path, (data.get(path) ?? '') + line) },
          async datasync() { await gate },
          async close() {},
        }
      },
    }
    const s = unitStore('commit-then-stall', { fs: memfs, stallTimeoutMs: 40, drainTimeoutMs: 200, queryTimeoutMs: 200 })
    const entry = s.result.begin(execOf(s.session, 'call-commit'))
    assert.equal(s.result.record(entry, 'reviewer', 'allow'), true)
    assert.equal(s.result.record(entry, 'downstream', 'allow'), true) // 排在悬挂 work 之后
    await sleep(90) // datasync 悬挂 → 看门狗 quarantine
    assert.equal(s.result.record(entry, 'manual', 'cancelled'), false)
    releaseDatasync() // 释放旧 I/O：晚完成必须检查 epoch，不得把第一条之后的记录补写或更新元数据
    await settledWithin(s.result.drain(), 1000, '释放后 drain')
    const files = [...data.values()]
    assert.equal(files.length, 1, '只有一个会话文件被写入')
    const lines = files[0].split('\n').filter(Boolean)
    assert.equal(lines.length, 1, '只有 stall 前已提交的一行；后续记录全部丢弃')
    const row = JSON.parse(lines[0])
    assert.equal(row.phase, 'reviewer'); assert.equal(row.outcome, 'allow'); assert.equal(row.ledgerSeq, 0)
    const page = await s.result.history({ sessionId: s.session.id })
    assert.equal(page.ok, true)
    assert.equal(page.value.records.length, 1, '查询只见真实落盘的一行')
    assert.equal(page.value.health.gap, true)
    assert.ok(page.value.health.droppedRecords >= 2, '后续记录（含已在队列中的）全部计入 droppedRecords')
    assert.ok(page.value.health.writeFailures >= 1)
    await s.result.close()
  }
  console.log('PASS 旧 I/O 释放后：已提交行保留（fs.write 不可撤销）、后续丢弃、无乱序无空洞、gap 真实')

  // —— 门类：真实 apply 门路径 + 注入永 pending fs.stat；reviewer allow 后 caller 取消有界 ——
  const gateFixture = ({ policy = 'ask', stream, approvalRequest } = {}) => {
    const listeners = new Map(), effects = [], warnings = []
    const session = {
      id: 'stall-gate', header: { cwd: temp }, mode: 'danger-full-access',
      append(type, data) { if (type === 'sandbox/mode') this.mode = data.mode },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' }, tools: [{ name: 'edit', description: 'edit', parameters: { type: 'object' } }] }),
      snapshotEvents: () => [],
    }
    const ctx = {
      logger: { info() {}, warn(message) { warnings.push(message) } },
      approval: { overrideOf: () => policy, effectivePolicy: () => policy,
        request: approvalRequest ?? (async () => { throw new Error('must not prompt') }) },
      permissionPresets: { current: () => session.mode === 'read-only' ? 'custom' : 'auto', registerAuto: () => () => {} },
      llm: { stream },
      sessions: { list: () => [session] },
      profileContext: { dir: join(temp, 'gate-stall') },
      on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
      effect(factory) { effects.push(factory()) },
    }
    const ref = Config({ enabled: true, reviewerProvider: 'p', reviewerModel: 'm', manualApprovalTimeoutMs: 1000, logDecisions: false })
    router.apply(ctx, ref, { fs: { ...fs, stat: never }, stallTimeoutMs: 60000, drainTimeoutMs: 150, queryTimeoutMs: 150 })
    return { ctx, session, listeners, effects, warnings, ref,
      update(values) { updateVolatile(ref, Config({ ...ref.get(), ...values })); listeners.get('loader/volatile-update')() } }
  }
  const allowStream = () => (async function* () {
    await sleep(30)
    yield { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const gateCall = (f, callId, controller = new AbortController()) => {
    const exec = { name: 'edit', callId, rootCallId: callId, parent: undefined, arguments: {}, token: Symbol(callId), signal: controller.signal, agent: { session: f.session } }
    let bodyRuns = 0
    const result = f.listeners.get('tools/pre-execute')(exec, async () => { bodyRuns++; return { kind: 'allow' } })
    return { result, bodyRuns: () => bodyRuns }
  }

  {
    // P1-A 反例：reviewer allow 之后 caller 取消；旧实现 gate 会永远挂在 await history.record。
    const f = gateFixture({ stream: allowStream })
    const controller = new AbortController()
    const call = gateCall(f, 'cancel-after-allow', controller)
    setTimeout(() => controller.abort(new Error('caller cancelled')), 10)
    const result = await settledWithin(call.result, 5000, 'caller 取消的 gate')
    assert.equal(result.kind, 'cancel')
    assert.equal(call.bodyRuns(), 0, '取消后工具体不得执行')
    // 热禁用（fiber 活着）有界：stop 只取消与收紧，不等审计 I/O。
    f.update({ enabled: false })
    assert.equal(f.session.mode, 'read-only', '禁用仍须收紧会话')
    // 卸载（逆序 effect 排空）有界：审计 fs.stat 永 pending 时 drain/close 走超时支路。
    const start = Date.now()
    for (const dispose of [...f.effects].reverse()) await dispose()
    assert.ok(Date.now() - start < 5000, '卸载必须在 drain 时限内有界结束')
    assert.ok(f.warnings.join('').includes('AUDIT_DRAIN_TIMEOUT'), '卸载排空超时必须记 gap')
    const status = router.queryRouterStatus(f.ctx)
    assert.equal(status.registration.registered, false)
    assert.equal(status.registration.closeFailed, false, '收紧成功的卸载不得误报 closeFailed')
    await settledWithin(router.queryApprovalHistory(f.ctx, { sessionId: f.session.id }), 1000, '卸载后查询')
  }
  console.log('PASS 门类：reviewer allow 后 caller 取消 / 热禁用 / 卸载在永 pending 审计 I/O 下均有界')

  {
    const f = gateFixture({ stream: allowStream })
    const call = gateCall(f, 'allow-path')
    const result = await settledWithin(call.result, 5000, 'allow gate')
    assert.equal(result.kind, 'allow'); assert.equal(call.bodyRuns(), 1, 'stall 审计不影响正常 allow 放行')
    for (const dispose of [...f.effects].reverse()) await dispose()
  }
  {
    const f = gateFixture({ policy: 'never', stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '{"risk":"high","decision":"deny","reason":"secret exfiltration"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() })
    const call = gateCall(f, 'never-deny')
    const result = await settledWithin(call.result, 5000, 'never gate')
    assert.equal(result.kind, 'deny'); assert.equal(result.info?.code, 'AUTO_REVIEW_DENIED'); assert.equal(call.bodyRuns(), 0)
    for (const dispose of [...f.effects].reverse()) await dispose()
  }
  {
    const downstreamDeny = { kind: 'deny', reason: 'later gate denied' }
    const f = gateFixture({ stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '{"risk":"medium","decision":"deny","reason":"needs a human"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() })
    const exec = { name: 'edit', callId: 'downstream-deny', rootCallId: 'downstream-deny', parent: undefined, arguments: {}, token: Symbol('d'), signal: new AbortController().signal, agent: { session: f.session } }
    const result = await settledWithin(f.listeners.get('tools/pre-execute')(exec, async () => downstreamDeny), 5000, 'downstream deny gate')
    assert.equal(result, downstreamDeny, '下游既有 deny 必须原样透传，不得改写')
    for (const dispose of [...f.effects].reverse()) await dispose()
  }
  {
    // late grant 不得绕过：人工审批超时取消后，迟到的 allowed-once 不能放行；manualOutcome 同步捕获。
    const f = gateFixture({
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: '{"risk":"high","decision":"deny","reason":"irreversible"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
      approvalRequest: request => new Promise(resolve => {
        const timer = setTimeout(() => resolve('allowed-once'), 60000) // 迟到授权
        request.signal.addEventListener('abort', () => { clearTimeout(timer); resolve('cancelled') }, { once: true })
      }),
    })
    const call = gateCall(f, 'late-grant')
    const result = await settledWithin(call.result, 5000, 'late grant gate')
    // 下游（其它门禁/核心审批）被咨询一次属正常流程；超时取消后迟到授权必须最终拒绝。
    assert.equal(result.kind, 'deny')
    assert.equal(result.info?.reason, 'manual approval timed out', JSON.stringify(result.info))
    for (const dispose of [...f.effects].reverse()) await dispose()
  }
  console.log('PASS 门类：stall 审计下 allow / never / 下游 deny / 迟到人工授权语义不变')
} finally {
  for (const store of stores.reverse()) await store.close()
  assert.equal(dirname(resolve(temp)), resolve(testDir)); assert.ok(temp.includes('.tmp-stall-'))
  await fs.rm(temp, { recursive: true, force: true })
}
console.log('audit-stall: 全部通过（注入永 pending memory fs；零真实模型请求）')
