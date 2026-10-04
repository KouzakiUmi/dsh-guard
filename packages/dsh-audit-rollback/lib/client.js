// dsh-audit-rollback —— 设置页（Client 侧，手写，零构建）
//
// 第一版只读：状态、账本、对象库、最近捕获、生效配置。不写配置。
// Remote 描述符与 Host lib/index.js 的 auditStatusRemote 对齐。

window.__ModuleLoader__.load({
  id: 'dsh-audit-rollback',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const h = react.createElement

    const NS = 'dsh-audit-rollback'
    const zh = {
      nav: '审计与回滚',
      title: '审计与回滚',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取状态…',
      empty: '还没有读到状态。',
      state: '状态',
      stateDir: '状态目录',
      version: 'state.json 版本',
      createdAt: '创建时间',
      ready: '目录已就绪',
      notReady: '目录初始化失败',
      absent: '尚未创建',
      ledger: '账本统计',
      fileCount: '账本文件数',
      entryCount: '总条目数',
      kindStart: 'turn/start',
      kindCall: 'call',
      kindCapture: 'capture',
      kindEnd: 'turn/end',
      kindRollback: 'rollback',
      kindNote: 'note',
      kindOther: '其他',
      objects: '对象库',
      objectCount: '对象数',
      objectBytes: '总字节',
      captures: '捕获概况',
      uniquePaths: '唯一被捕获路径',
      recent: '最近捕获',
      noCapture: '还没有 capture 条目。',
      colTime: '时间',
      colPhase: '相位',
      colFile: '文件名',
      colHash: 'hash 前 8 位',
      colBytes: '字节',
      config: '生效配置',
      guidance: '修改指引',
      guidanceBody: '改配置写在 ~/.dsh/profiles/<profile>/cordis.patch.yml 的 - id: audit-rollback 下。同 id 的 config 是整体替换，字段要写全。',
      gitNote: 'gitSnapshot 当前为 true，但影子 git 快照本阶段未实现。',
    }
    const en = {
      nav: 'Audit & rollback',
      title: 'Audit & rollback',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Reading status…',
      empty: 'No status yet.',
      state: 'Status',
      stateDir: 'State directory',
      version: 'state.json version',
      createdAt: 'Created at',
      ready: 'Directory ready',
      notReady: 'Directory init failed',
      absent: 'Not created',
      ledger: 'Ledger',
      fileCount: 'Ledger files',
      entryCount: 'Entries',
      kindStart: 'turn/start',
      kindCall: 'call',
      kindCapture: 'capture',
      kindEnd: 'turn/end',
      kindRollback: 'rollback',
      kindNote: 'note',
      kindOther: 'other',
      objects: 'Object store',
      objectCount: 'Objects',
      objectBytes: 'Total bytes',
      captures: 'Captures',
      uniquePaths: 'Unique captured paths',
      recent: 'Recent captures',
      noCapture: 'No capture entries yet.',
      colTime: 'Time',
      colPhase: 'Phase',
      colFile: 'File',
      colHash: 'Hash prefix',
      colBytes: 'Bytes',
      config: 'Effective config',
      guidance: 'How to change config',
      guidanceBody: 'Write config under - id: audit-rollback in ~/.dsh/profiles/<profile>/cordis.patch.yml. Config for the same id is replaced as a whole; include every field.',
      gitNote: 'gitSnapshot is true, but the shadow git snapshot is not implemented in this phase.',
    }

    function parseStatus(value) {
      if (!value || typeof value !== 'object' || value.plugin !== 'dsh-audit-rollback') {
        throw new Error('Invalid audit-rollback status')
      }
      if (!value.state || typeof value.state.stateDir !== 'string') throw new Error('Invalid audit-rollback status.state')
      if (!value.ledger || typeof value.ledger.entryCount !== 'number' || !value.ledger.byKind) {
        throw new Error('Invalid audit-rollback status.ledger')
      }
      if (!value.objects || typeof value.objects.count !== 'number') throw new Error('Invalid audit-rollback status.objects')
      if (!value.captures || !Array.isArray(value.captures.recent)) throw new Error('Invalid audit-rollback status.captures')
      if (!value.config || !Array.isArray(value.config.captureTools)) throw new Error('Invalid audit-rollback status.config')
      return value
    }

    const statusRemote = {
      package: 'dsh-audit-rollback',
      descriptors: [
        {
          id: 'dsh-audit-rollback#auditRollback/read',
          service: 'auditRollback',
          namespace: 'auditRollback',
          method: 'read',
          invocation: { kind: 'direct' },
          parameters: [],
          result: {
            mode: 'strict',
            typeSymbol: 'dsh-audit-rollback#AuditStatus',
            schema: { parse: parseStatus },
            create: () => ({ parse: parseStatus }),
          },
        },
      ],
    }

    const pageStyle = { padding: 16, maxWidth: 760, font: '13px/1.55 sans-serif' }
    const cardStyle = { marginTop: 14, padding: 12, border: '1px solid rgba(128,128,128,.28)', borderRadius: 10 }
    const btnStyle = { padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', cursor: 'pointer' }
    const labelStyle = { opacity: 0.7, marginRight: 8 }
    const rowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }

    function line(label, value) {
      return h('div', { style: rowStyle }, h('span', { style: labelStyle }, label), h('span', { style: { overflowWrap: 'anywhere' } }, value))
    }

    function show(value) {
      if (value === null || value === undefined || value === '') return '—'
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      if (Array.isArray(value)) return value.join(', ')
      return String(value)
    }

    function AuditPage({ call, t }) {
      const [status, setStatus] = react.useState(null)
      const [error, setError] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const load = react.useCallback(() => {
        setBusy(true)
        setError('')
        return call('read').then((value) => {
          setStatus(value)
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
        }).finally(() => setBusy(false))
      }, [call])
      react.useEffect(() => { load() }, [load])

      const kinds = status ? status.ledger.byKind : null
      const recent = status ? status.captures.recent : []
      return h('div', { style: pageStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('h2', { style: { margin: 0, fontSize: 16 } }, t('title')),
          h('button', { type: 'button', disabled: busy, style: btnStyle, onClick: () => load() }, busy ? t('refreshing') : t('refresh')),
        ),
        error ? h('p', { role: 'alert', style: { color: '#dc2626', overflowWrap: 'anywhere' } }, error) : null,
        !status && !error ? h('p', null, busy ? t('loading') : t('empty')) : null,
        status ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('state')),
          line(t('stateDir'), status.state.stateDir),
          line(t('version'), show(status.state.version)),
          line(t('createdAt'), show(status.state.createdAt)),
          line(status.state.stateReady ? t('ready') : (status.state.initError ? t('notReady') : t('absent')), show(status.state.initError || status.state.stateError)),
        ) : null,
        status ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('ledger')),
          line(t('fileCount'), show(status.ledger.fileCount)),
          line(t('entryCount'), show(status.ledger.entryCount)),
          line(t('kindStart'), show(kinds['turn/start'])),
          line(t('kindCall'), show(kinds.call)),
          line(t('kindCapture'), show(kinds.capture)),
          line(t('kindEnd'), show(kinds['turn/end'])),
          line(t('kindRollback'), show(kinds.rollback)),
          line(t('kindNote'), show(kinds.note)),
          line(t('kindOther'), show(kinds.other)),
        ) : null,
        status ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('objects')),
          line(t('objectCount'), show(status.objects.count)),
          line(t('objectBytes'), show(status.objects.totalBytes)),
          status.objects.error ? h('p', { role: 'alert', style: { color: '#dc2626' } }, status.objects.error) : null,
        ) : null,
        status ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('captures')),
          line(t('uniquePaths'), show(status.captures.uniquePaths)),
          h('div', { style: { marginTop: 8, fontWeight: 600 } }, t('recent')),
          recent.length === 0 ? h('p', { style: { opacity: 0.75 } }, t('noCapture')) : h('div', { style: { overflowX: 'auto' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr .6fr 1fr .8fr .5fr', gap: 6, marginTop: 6, fontSize: 12 } },
              h('span', { style: labelStyle }, t('colTime')),
              h('span', { style: labelStyle }, t('colPhase')),
              h('span', { style: labelStyle }, t('colFile')),
              h('span', { style: labelStyle }, t('colHash')),
              h('span', { style: labelStyle }, t('colBytes')),
              ...recent.flatMap((row, index) => [
                h('span', { key: `t${index}`, style: { overflowWrap: 'anywhere' } }, show(row.ts)),
                h('span', { key: `p${index}` }, show(row.phase)),
                h('span', { key: `f${index}`, style: { overflowWrap: 'anywhere' } }, show(row.fileName)),
                h('span', { key: `h${index}` }, show(row.hashPrefix)),
                h('span', { key: `b${index}` }, show(row.bytes)),
              ]),
            ),
          ),
        ) : null,
        status ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('config')),
          line('captureTools', show(status.config.captureTools)),
          line('captureMaxBytes', show(status.config.captureMaxBytes)),
          line('argsMaxBytes', show(status.config.argsMaxBytes)),
          line('logCalls', show(status.config.logCalls)),
          line('excludeGlobs', show(status.config.excludeGlobs)),
          line('gitSnapshot', show(status.config.gitSnapshot)),
          status.config.gitSnapshot ? h('p', { style: { color: '#b7791f' } }, t('gitNote')) : null,
        ) : null,
        h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('guidance')),
          h('p', { style: { margin: 0 } }, t('guidanceBody')),
        ),
      )
    }

    const name = 'dsh-audit-rollback'
    const inject = ['slots', 'locale', 'remote']
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-audit-rollback: dictionaries')
      } catch (error) {
        console.error('[dsh-audit-rollback] locale 注册失败:', error)
      }
      const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] || key
      let mounted = Promise.resolve()
      let disposed = false
      try {
        mounted = ctx.remote.$mount(statusRemote)
        if (typeof ctx.effect === 'function') ctx.effect(async () => await mounted, 'dsh-audit-rollback: mount remotes')
      } catch (error) {
        mounted = Promise.reject(error)
        mounted.catch(() => {})
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { disposed = true }, 'dsh-audit-rollback: dispose client')
      }
      const call = async (method) => {
        const deadline = Date.now() + 20000
        await mounted
        for (;;) {
          if (disposed) throw new Error('Client 已卸载')
          const service = ctx.get('remote.auditRollback')
          if (service !== undefined) {
            if (typeof service[method] !== 'function') throw new Error(`Host 缺少 ${method}`)
            const result = await service[method]()
            if (!result || result.ok !== true) {
              const message = result && result.error ? (result.error.message || String(result.error)) : 'remote 调用失败'
              throw new Error(message)
            }
            return parseStatus(result.value)
          }
          if (Date.now() > deadline) throw new Error('remote.auditRollback 挂载超时（20 秒）：Host 端状态服务未就绪')
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      const entry = {
        id: 'audit-rollback',
        order: 40,
        label: () => t('nav'),
        inject: () => ({ call, t }),
      }
      const register = (slot) => ctx.slots.inject(slot, () => ctx.slots.register({
        name: slot,
        id: entry.id,
        order: entry.order,
        label: entry.label,
        inject: entry.inject,
      }, AuditPage))
      try {
        register('settings.plugins.tab')
      } catch (error) {
        console.error('[dsh-audit-rollback] settings.plugins.tab 不可用，退回 settings.section:', error)
        try { register('settings.section') } catch (fallback) {
          console.error('[dsh-audit-rollback] 设置页注册失败:', fallback)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
