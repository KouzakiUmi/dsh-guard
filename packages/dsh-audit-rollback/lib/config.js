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
  // 阶段 B 总开关（§10.4）：可编辑复选框；false 时行为与阶段 A 完全一致。
  gitSnapshot: Schema.boolean().default(false)
    .description('阶段 B 总开关，默认 false；false 时行为与阶段 A 完全一致').volatile(),
  // —— 以下为阶段 B 新增（§10.4 / §10.8），全部 volatile，保存仅对新轮次生效 ——
  snapshotMode: Schema.union(['per-step', 'per-turn'])
    .description('快照粒度：per-step 每步前后各一次；per-turn 每轮前后各一次（默认 per-step）')
    .default('per-step').volatile(),
  snapshotExcludeGlobs: Schema.array(Schema.string().min(1))
    .description('快照排除规则（语义同 excludeGlobs：无通配符按路径片段，含通配符按 glob）')
    .default(['/node_modules/', '/.git/', '/.dsh-memory/', '/.graphflow-cache/', '/audit-rollback/']).volatile(),
  snapshotIgnorePolicy: Schema.union(['git', 'force'])
    .description('忽略策略：git 尊重 .gitignore 与 excludesFile；force 用 add -A -f 强制纳入')
    .default('git').volatile(),
  snapshotMaxFiles: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .description('快照工作区预算：文件数上限（超预算默认拒绝，默认 50000）')
    .default(50000).volatile(),
  snapshotMaxBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .description('快照工作区预算：字节数上限（默认 536870912 = 512 MiB）')
    .default(536870912).volatile(),
  snapshotScanMs: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .description('快照前轻量盘点的最长耗时（毫秒，默认 5000）；未扫完也必须拒绝')
    .default(5000).volatile(),
  snapshotTimeoutMs: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .description('单次快照 git 子进程超时（毫秒，默认 10000），超时即降级不阻塞轮次')
    .default(10000).volatile(),
  snapshotAutoExcludeOversized: Schema.boolean().default(false)
    .description('超预算/未扫完时是否自动排除 oversized 顶层项后各重试一次（默认不自动排除）').volatile(),
  rollbackOnAbort: Schema.union(['off', 'prompt', 'auto'])
    .description('轮次被中断后的联动：off 只记录；prompt 提示回滚命令；auto 自动回滚（本阶段仅落配置与展示）')
    .default('prompt').volatile(),
  snapshotRetentionDays: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)
    .description('影子快照保留天数（gc --keep-days 默认值，非负，默认 14）')
    .default(14).volatile(),
})

/** Cordis supplies volatile references; direct/fake contexts can still pass plain values. */
export function readConfigValues(raw) {
  return Object.fromEntries(Object.entries(raw ?? {}).map(([key, value]) => [
    key, value && typeof value.get === 'function' ? value.get() : value,
  ]))
}
