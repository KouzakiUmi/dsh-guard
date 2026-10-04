// dsh-audit-rollback —— 设置页（Client 侧，手写，零构建）
//
// 状态读取保留独立 remote；配置只走官方 remote.settings 的 revision 读写。
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

      gitNote: 'gitSnapshot 当前为 true，但影子 git 快照本阶段未实现。',
      editorTitle: '捕获策略设置',
      editorLimits: 'stateDir 只读，不支持热迁移；gitSnapshot 未实现，不可设置。列表每行一项。保存仅对新轮次生效。',
      captureTools: '捕获工具名（captureTools）',
      captureMaxBytes: '单文件捕获上限（captureMaxBytes，字节）',
      argsMaxBytes: '参数预览上限（argsMaxBytes，字节）',
      logCalls: '记录工具调用（logCalls）',
      excludeGlobs: '排除规则（excludeGlobs）',
      save: '保存',
      saving: '处理中…',
      cancelReload: '取消并重新读取',
      loadConfig: '读取配置',
      saved: '已保存到官方 profile；新轮次生效，进行中轮次保持原配置。',
      stale: '配置已过期，未覆盖其他修改；草稿保留。请取消并重新读取后再编辑。',
      settingsUnavailable: '官方 settings 服务未就绪，请确认 settings/configEditor 已启用。',
      settingsNotWritable: 'audit-rollback 配置不可写，请确认官方 settings/configEditor 已启用且插件处于 ACTIVE。',
      positiveInteger: '必须是正安全整数',
      toolsRequired: '至少需要一个工具名',
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

      gitNote: 'gitSnapshot is true, but the shadow git snapshot is not implemented in this phase.',
      editorTitle: 'Capture policy settings',
      editorLimits: 'stateDir is read-only: live migration is unsupported. gitSnapshot is unavailable. One list item per line. Saves apply to new turns only.',
      captureTools: 'Capture tool names (captureTools)',
      captureMaxBytes: 'File capture limit (captureMaxBytes, bytes)',
      argsMaxBytes: 'Argument preview limit (argsMaxBytes, bytes)',
      logCalls: 'Log tool calls (logCalls)',
      excludeGlobs: 'Exclude patterns (excludeGlobs)',
      save: 'Save',
      saving: 'Working…',
      cancelReload: 'Cancel & reload',
      loadConfig: 'Load configuration',
      saved: 'Saved to the official profile. New turns use this policy; in-flight turns retain their snapshot.',
      stale: 'Stale revision: no concurrent edits overwritten; draft retained. Cancel and reload, then edit again.',
      settingsUnavailable: 'Official settings service unavailable; enable settings/configEditor.',
      settingsNotWritable: 'audit-rollback is not writable; ensure settings/configEditor and the ACTIVE plugin are enabled.',
      positiveInteger: 'must be a positive safe integer',
      toolsRequired: 'at least one tool name is required',
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

    const editableFields = ['captureTools', 'captureMaxBytes', 'argsMaxBytes', 'logCalls', 'excludeGlobs']
    function toDraft(value) {
      return {
        captureTools: (value.captureTools || []).join('\n'),
        excludeGlobs: (value.excludeGlobs || []).join('\n'),
        captureMaxBytes: String(value.captureMaxBytes),
        argsMaxBytes: String(value.argsMaxBytes),
        logCalls: value.logCalls === true,
      }
    }
    function validateDraft(draft, t = (key) => en[key] || key) {
      const value = { logCalls: draft.logCalls === true }
      for (const key of ['captureMaxBytes', 'argsMaxBytes']) {
        const n = Number(draft[key])
        if (!Number.isSafeInteger(n) || n < 1) throw new Error(key + ': ' + t('positiveInteger'))
        value[key] = n
      }
      for (const key of ['captureTools', 'excludeGlobs']) {
        value[key] = String(draft[key]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      }
      if (!value.captureTools.length) throw new Error('captureTools: ' + t('toolsRequired'))
      return value
    }
    function unwrapSettings(result) {
      if (result && result.ok === true) return result.value
      const detail = result && result.error
      const error = new Error(detail && detail.message || 'Settings request failed')
      error.code = detail && detail.code
      throw error
    }
    function SettingsEditor({ settingsCall, t, onSaved }) {
      const [view, setView] = react.useState(null)
      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [message, setMessage] = react.useState('')
      const accept = (row) => { setView(row); setDraft(toDraft(row.value)) }
      const reload = async () => {
        setBusy(true); setError(''); setMessage('')
        try {
          const result = await settingsCall('describe')
          const row = result.namespaces.find((item) => item.ns === 'audit-rollback')
          if (!row || !result.writable) throw new Error(t('settingsNotWritable'))
          accept(row)
        } catch (err) { setError(err.message || String(err)) }
        finally { setBusy(false) }
      }
      react.useEffect(() => { reload() }, [settingsCall])
      const save = async () => {
        setError(''); setMessage('')
        let patch
        try { patch = validateDraft(draft, t) }
        catch (err) { setError(err.message); return }
        setBusy(true)
        try {
          // Revision is held with the draft, never replaced by a background refresh.
          const row = await settingsCall('update', 'audit-rollback', patch, view.revision)
          accept(row)
          setMessage(t('saved'))
          // Diagnostics refresh must never turn an accepted write into a save failure.
          if (onSaved) Promise.resolve().then(onSaved).catch(() => {})
        } catch (err) {
          setError((err.code === 'settings/conflict' || err.code === 'SETTINGS_CONFLICT'
            ? t('stale') + ' ' : '') + (err.message || String(err)))
        } finally { setBusy(false) }
      }
      const field = (key) => h('label', { key, style: { display: 'block', marginTop: 8 } },
        h('span', null, t(key)),
        key === 'logCalls'
          ? h('input', { type: 'checkbox', 'aria-label': key, checked: draft[key], disabled: busy, onChange: (e) => { setDraft({ ...draft, [key]: e.target.checked }); setMessage('') } })
          : h(key === 'captureTools' || key === 'excludeGlobs' ? 'textarea' : 'input', {
              value: draft[key], disabled: busy, type: 'number', min: 1, step: 1,
              rows: 4, 'aria-label': key, style: { display: 'block', width: '100%', boxSizing: 'border-box' },
              onChange: (e) => { setDraft({ ...draft, [key]: e.target.value }); setMessage('') },
            }),
      )
      return h('section', { style: cardStyle },
        h('h3', null, t('editorTitle')),
        h('p', null, t('editorLimits')),
        error ? h('p', { role: 'alert', style: { color: '#dc2626' } }, error) : null,
        message ? h('p', { role: 'status' }, message) : null,
        draft ? h('form', { onSubmit: (e) => { e.preventDefault(); save() } },
          ...editableFields.map(field),
          h('button', { type: 'submit', disabled: busy, style: btnStyle }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', disabled: busy, style: btnStyle, onClick: reload }, t('cancelReload')),
        ) : h('button', { type: 'button', disabled: busy, onClick: reload }, t('loadConfig')),
      )
    }

    function AuditPage({ call, settingsCall, t }) {
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
        h(SettingsEditor, { settingsCall, t, onSaved: load }),
      )
    }

    const name = 'dsh-audit-rollback'
    const inject = ['slots', 'locale', 'remote']
    function apply(ctx) {
      console.info('[dsh-audit-rollback] client 已加载')
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
      const settingsCall = async (method, ...args) => {
        const service = ctx.get('remote.settings')
        if (!service || typeof service[method] !== 'function') throw new Error(t('settingsUnavailable'))
        return unwrapSettings(await service[method](...args))
      }
      // 注册字段对齐官方范本（dsh-client-ui-settings-plugins / plugin-inventory）：name/id/order/label/locale/inject。
      // locale: NS 让槽渲染器把 label 绑定到本包字典命名空间并随语言切换刷新。
      const entry = {
        tabId: 'audit-rollback-tab',
        order: 40,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ call, settingsCall, t }),
      }
      // ctx.slots.inject 是等待语义：槽未声明时回调不执行、不抛错（renderer Slots.inject 用
      // subscribeDeclaration 等待声明），因此 try/catch 回退永远不触发；诊断只能靠探针 + 日志。
      const registerInto = (slot, id) => ctx.slots.inject(slot, () => {
        const dispose = ctx.slots.register({
          name: slot,
          id,
          order: entry.order,
          label: entry.label,
          locale: NS,
          inject: entry.inject,
        }, AuditPage)
        console.info(`[dsh-audit-rollback] 已注册设置页: slot=${slot} id=${id} order=${entry.order}`)
        return dispose
      })
      // 唯一入口：设置 → 内置插件；不再注册设置侧栏独立页面。
      // settings.plugins.tab 由 dsh-client-ui-settings-plugins 的 section children 声明，
      // 存在性取决于该内置包是否启用。用 ctx.slots.spec()（Slots 服务公开方法，未声明返回 undefined）
      // 打探针日志；注册本身仍走 inject 等待，以兼容该槽晚于本包声明的启动顺序。
      const tabSpec = typeof ctx.slots.spec === 'function' ? ctx.slots.spec('settings.plugins.tab') : undefined
      if (tabSpec !== undefined) {
        console.info('[dsh-audit-rollback] 探针: settings.plugins.tab 已声明，注册内置插件插件页签')
      } else {
        console.warn('[dsh-audit-rollback] 探针: settings.plugins.tab 当前未声明，注册内置插件挂起等待；若重启后始终无「已注册 settings.plugins.tab」日志，说明 dsh-client-ui-settings-plugins 未启用')
      }
      registerInto('settings.plugins.tab', entry.tabId)
    }

    // Pure client helpers exported for the zero-build VM/UI contract tests.
    exports.dictionaries = { zh, en }
    exports.SettingsEditor = SettingsEditor
    exports.validateDraft = validateDraft
    exports.unwrapSettings = unwrapSettings
    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
