/**
 * 假 ctx 桩：apply 的注册行为。与 selftest 分开，供中控脚本单独执行。
 */
import './runtime.mjs'
const { apply } = await import('../lib/index.js')

let failed = 0

function pass(name) {
  console.log(`PASS ${name}`)
}

function fail(name, error) {
  failed += 1
  console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * 假 ctx 桩。没有 fiber，也不提供 effect，用来确认 apply 本身会同步注册。
 */
function fakeCtx() {
  const listeners = []
  const calls = { registerAuto: 0 }
  return {
    listeners,
    calls,
    logger: {
      info() {},
      warn() {},
    },
    approval: { overrideOf() { return 'ask' } },
    permissionPresets: {
      current() { return 'auto' },
      registerAuto(admit) {
        calls.registerAuto += 1
        calls.admit = admit
        return () => {}
      },
    },
    llm: { stream() { throw new Error('smoke 不应发起模型请求') } },
    on(name, listener, opts) {
      listeners.push({ name, listener, opts })
      return () => {
        const index = listeners.findIndex((item) => item.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
}

try {
  const disabled = fakeCtx()
  apply(disabled, { enabled: false })
  if (disabled.listeners.some(row => row.name === 'tools/pre-execute') || disabled.calls.registerAuto !== 0) {
    throw new Error(`listeners=${disabled.listeners.length} registerAuto=${disabled.calls.registerAuto}`)
  }
  pass('apply(ctx, { enabled: false }) 不注册任何订阅')
} catch (error) {
  fail('apply(ctx, { enabled: false }) 不注册任何订阅', error)
}

try {
  const enabled = fakeCtx()
  apply(enabled, { enabled: true })
  const gate = enabled.listeners.find((item) => item.name === 'tools/pre-execute')
  if (!gate) throw new Error('未注册 tools/pre-execute')
  if (gate.opts?.prepend !== true) throw new Error('tools/pre-execute 未 prepend')
  if (enabled.calls.registerAuto !== 1) throw new Error(`registerAuto 调用次数 ${enabled.calls.registerAuto}`)
  if (typeof enabled.calls.admit !== 'function') throw new Error('registerAuto 未收到同步 admit')
  pass('apply(ctx, { enabled: true }) 注册 tools/pre-execute 并调用 registerAuto')
} catch (error) {
  fail('apply(ctx, { enabled: true }) 注册 tools/pre-execute 并调用 registerAuto', error)
}

if (failed > 0) {
  console.error(`plugin-smoke: ${failed} 项失败`)
  process.exit(1)
}
console.log('plugin-smoke: 全部通过')
