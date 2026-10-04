import Schema from '@deepseek-ai/schemastery'

/** Only these fields may be changed without remounting the audit listeners. */
export const Config = Schema.object({
  stateDir: Schema.string().description('状态目录（只读；迁移需停轮后按官方配置流程重新加载）'),
  captureTools: Schema.array(Schema.string().min(1)).min(1)
    .default(['write', 'edit', 'str_replace_editor']).volatile(),
  captureMaxBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .default(2097152).volatile(),
  argsMaxBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .default(4096).volatile(),
  logCalls: Schema.boolean().default(true).volatile(),
  excludeGlobs: Schema.array(Schema.string().min(1))
    .default(['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/']).volatile(),
  // Compatibility with old profiles only; deliberately absent from the editable form.
  gitSnapshot: Schema.boolean().default(false).description('未实现，不可设置；旧配置 true 仅告警'),
})

/** Cordis supplies volatile references; direct/fake contexts can still pass plain values. */
export function readConfigValues(raw) {
  return Object.fromEntries(Object.entries(raw ?? {}).map(([key, value]) => [
    key, value && typeof value.get === 'function' ? value.get() : value,
  ]))
}
