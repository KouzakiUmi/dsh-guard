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

    // Keep the same strict descriptor/remote metadata path as the status service.
    function parseRollbackRequest(method, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
      const fields = method === 'changedFiles' ? ['sessionId', 'cursor', 'limit', 'turn'] : method === 'preview' ? ['sessionId', 'entryId'] : ['sessionId', 'entryId', 'nonce', 'expectedCurrentHash']
      if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error('UNEXPECTED_REQUEST_FIELD')
      if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId === 'unknown' || value.sessionId.length > 512) throw new Error('INVALID_SESSION')
      if (method === 'changedFiles') {
        for (const key of ['cursor', 'limit', 'turn']) if (value[key] !== undefined && !Number.isSafeInteger(value[key])) throw new Error('INVALID_PAGE')
        if ((value.cursor ?? 0) < 0 || (value.limit ?? 25) < 1 || (value.limit ?? 25) > 100) throw new Error('INVALID_PAGE')
      } else {
        if (!/^entry-[a-f0-9]{64}$/.test(value.entryId || '')) throw new Error('INVALID_ENTRY_ID')
        if (method === 'restore' && (!/^[a-f0-9-]{36}$/.test(value.nonce || '') || !/^(absent|[a-f0-9]{40})$/.test(value.expectedCurrentHash || ''))) throw new Error('INVALID_PREVIEW_BINDING')
      }
      return value
    }
    function parseRollbackResult(method, value) {
      if (!value || typeof value !== 'object' || typeof value.sessionId !== 'string') throw new Error('INVALID_ROLLBACK_RESULT')
      if (method === 'changedFiles' && (!Array.isArray(value.rows) || !Number.isSafeInteger(value.total))) throw new Error('INVALID_FILE_LIST')
      if (method === 'preview' && (typeof value.entryId !== 'string' || typeof value.canRestore !== 'boolean' || !value.diff || typeof value.diff.text !== 'string')) throw new Error('INVALID_PREVIEW')
      if (method === 'restore' && (typeof value.applied !== 'boolean' || typeof value.recorded !== 'boolean' || typeof value.operationId !== 'string')) throw new Error('INVALID_RECEIPT')
      return value
    }
    const rollbackMethods = ['changedFiles', 'preview', 'restore']
    const rollbackCodec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, schema: { parse }, create: () => ({ parse }) })
    const rollbackDescriptors = rollbackMethods.map((method) => ({
      id: 'dsh-audit-rollback#auditRollback/' + method,
      service: 'auditRollback', namespace: 'auditRollback', method, invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: rollbackCodec('dsh-audit-rollback#' + method + ':request', (v) => parseRollbackRequest(method, v)) }],
      result: rollbackCodec('dsh-audit-rollback#' + method + ':result', (v) => parseRollbackResult(method, v)),
    }))
    statusRemote.descriptors.push(...rollbackDescriptors)

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

    const reasonText = {
      DISCONTINUOUS_CAPTURE_HISTORY: '轮次间捕获不连续，不能覆盖未捕获的修改', INCOMPLETE_CAPTURE_IDENTITY: '中间捕获缺路径身份',
      UNCAPTURED_TOOL_TARGET: '存在未捕获工具目标，历史不完整', AMBIGUOUS_TURN_CAPTURE: '轮次捕获歧义，不能恢复', INVALID_CAPTURE_FACT: '捕获记录无效',
      NO_PREIMAGE: '没有前像，不能恢复', PREIMAGE_ONLY_NO_POSTIMAGE: '只有前像：不能证明工具已执行或成功，不能恢复',
      INCOMPLETE_TURN_CAPTURE: '部分轮次缺后像，不能恢复', TURN_NOT_ENDED: '捕获轮次尚未结束', ACTIVE_SESSION_TURN: '会话正在运行，禁止恢复',
      LEGACY_CAPTURE_NO_PATH_IDENTITY: '旧账本没有路径身份证据，仅可查看', BASELINE_ANCESTOR_CHANGED: '前像路径祖先已变更',
      PATH_IDENTITY_CHANGED: '文件或路径身份已变更', CURRENT_HASH_CONFLICT: '当前文件已被修改，保护后续手改',
      NEWER_OR_OTHER_SESSION_CAPTURE: '存在后续或其他会话捕获，禁止覆盖', NO_CAPTURED_CHANGE: '捕获前后内容相同（可能拒绝或未执行）',
      CAS_MISSING_OR_CORRUPT: '前像/后像对象缺失或校验失败', IMAGE_UNAVAILABLE_OR_OVERSIZED: '捕获对象缺失或超限',
      CURRENT_OVERSIZED: '当前文件超限', UNSAFE_OR_UNREADABLE_PATH: '路径不安全或无法读取（链接、目录等）',
    }
    const reasonLabel = (s) => reasonText[s] || s || '—'
    const changeLabel = (s) => ({ created: '创建', deleted: '删除', modified: '修改', unchanged: '未变化', unknown: '未知（捕获不等于实际修改）' }[s] || s)
    const captureLabel = (s) => ({ 'not-captured': '未捕获', 'preimage-only': '仅前像', 'before-and-after': '前像与后像', 'incomplete-history': '捕获历史不完整' }[s] || s)

    function ChangedFilesPage({ sessionId, call, running = false }) {
      const [page, setPage] = react.useState(null)
      const [selected, setSelected] = react.useState(null)
      const [confirmation, setConfirmation] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [message, setMessage] = react.useState('')
      const live = react.useRef({ sessionId, epoch: 0, busy: false })
      if (live.current.sessionId !== sessionId) { live.current.sessionId = sessionId; live.current.epoch++; live.current.busy = false }
      live.current.running = running
      const current = (epoch) => live.current.sessionId === sessionId && live.current.epoch === epoch
      const work = async (fn) => {
        if (!sessionId || live.current.sessionId !== sessionId || live.current.busy || live.current.running) return
        const epoch = live.current.epoch
        live.current.busy = true; setBusy(true); setError(''); setMessage('')
        try { await fn(epoch) }
        catch (err) { if (current(epoch)) setError(err.message || String(err)) }
        finally { if (current(epoch)) { live.current.busy = false; setBusy(false) } }
      }
      const load = (cursor = 0) => work(async (epoch) => {
        setConfirmation(null); setSelected(null)
        const value = await call('changedFiles', { sessionId, cursor, limit: 25 })
        if (value.sessionId !== sessionId) throw new Error('会话不匹配，已拒绝显示')
        if (current(epoch)) setPage({ ...value, cursor })
      })
      react.useEffect(() => {
        live.current.epoch++; live.current.busy = false
        setPage(null); setSelected(null); setConfirmation(null); setMessage(''); setError(''); setBusy(false)
        if (sessionId && !running) load()
        return () => { live.current.epoch++; live.current.busy = false }
      }, [sessionId, call, running])
      const view = (row, confirm) => work(async (epoch) => {
        setConfirmation(null)
        const value = await call('preview', { sessionId, entryId: row.entryId })
        if (value.sessionId !== sessionId || value.entryId !== row.entryId) throw new Error('预览绑定不匹配')
        if (current(epoch)) { setSelected(value); if (confirm && value.canRestore) setConfirmation(value) }
      })
      const restore = () => {
        const bound = confirmation
        if (!bound || bound.sessionId !== sessionId || running || !bound.canRestore || !bound.nonce) return
        work(async (epoch) => {
          // Read the exact same preview shown in the confirmation. No pathname or force is accepted.
          setConfirmation(null)
          const receipt = await call('restore', { sessionId: bound.sessionId, entryId: bound.entryId, nonce: bound.nonce, expectedCurrentHash: bound.expectedCurrentHash })
          if (receipt.sessionId !== sessionId || receipt.entryId !== bound.entryId) throw new Error('操作回执会话不匹配')
          if (!current(epoch)) return
          setSelected(null)
          setMessage(receipt.applied ? ('已恢复此文件；操作 ' + receipt.operationId + (receipt.recorded ? '' : '；审计回执未写入：' + receipt.auditError)) : '未完成恢复：' + receipt.error)
          const value = await call('changedFiles', { sessionId, cursor: 0, limit: 25 })
          if (value.sessionId === sessionId && current(epoch)) setPage({ ...value, cursor: 0 })
        })
      }
      const visible = page && page.sessionId === sessionId ? page : null
      const preview = selected && selected.sessionId === sessionId ? selected : null
      const confirm = confirmation && confirmation.sessionId === sessionId ? confirmation : null
      if (!sessionId) return h('p', null, '请先选择会话；不会读取其他会话的文件。')
      return h('section', { style: pageStyle },
        h('h2', null, '已修改文件'),
        h('p', null, '会话：' + sessionId + '。只列有前后像快照的文件；仅被读取的文件不计入。捕获条目不代表工具成功；shell、其他插件、人工编辑未覆盖。'),
        running ? h('p', { role: 'status' }, '当前会话运行中；轮次结束后刷新，运行中禁止恢复。') : null,
        h('button', { type: 'button', disabled: busy || running, onClick: () => load(), style: btnStyle }, busy ? '读取中…' : '刷新文件'),
        error ? h('p', { role: 'alert' }, error) : null,
        message ? h('p', { role: 'status' }, message) : null,
        visible && !visible.rows.length ? h('p', null, '此会话没有被文件工具改动的文件（只被读取的文件不计入；不表示没有 shell 改动）。') : null,
        visible ? h('div', null,
          h('p', null, visible.coverage),
          ...visible.rows.map((row) => h('article', { key: row.entryId, style: cardStyle },
            h('strong', { style: { overflowWrap: 'anywhere' } }, row.path),
            line('修改类型', changeLabel(row.changeType)), line('捕获状态', captureLabel(row.captureStatus)),
            line('轮次 / 工具', row.turns.join(', ') + ' / ' + (row.tools.join(', ') || '未记录工具名')),
            line('前像可用', row.preImage && row.preImage.available ? '是' : '否'),
            line('当前版本', row.current.status + ' / ' + row.current.bytes + ' 字节 / ' + (row.current.hash || '无哈希')),
            !row.canRestore ? line('恢复限制', reasonLabel(row.reason)) : null,
            h('button', { type: 'button', disabled: busy || running, onClick: () => view(row, false), style: btnStyle }, '查看差异'),
            h('button', { type: 'button', disabled: busy || running || !row.canRestore, onClick: () => view(row, true), style: btnStyle }, '恢复此文件'),
          )),
          h('p', null, '共 ' + visible.total + ' 个已修改文件；当前 ' + (visible.cursor + 1) + '–' + (visible.cursor + visible.rows.length)),
          h('button', { type: 'button', disabled: busy || running || visible.cursor === 0, onClick: () => load(Math.max(0, visible.cursor - 25)) }, '上一页'),
          h('button', { type: 'button', disabled: busy || running || visible.nextCursor === null, onClick: () => load(visible.nextCursor) }, '下一页'),
        ) : null,
        preview ? h('section', { style: cardStyle },
          h('h3', null, '文件差异：' + preview.path), h('p', null, preview.diffBasis),
          preview.captureStatus === 'preimage-only' ? h('p', null, '仅前像：缺少后像，无法证明本次工具实际执行或成功。') : null,
          preview.diff.kind === 'text' ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 440, overflowY: 'auto' } }, preview.diff.text)
            : h('p', null, preview.diff.kind === 'binary' ? '二进制或非 UTF-8 文件：不提供文本差异。' : '对象缺失或文件超限：无法生成文本差异。'),
          preview.diff.truncated ? h('p', null, '差异已精简/截断，不是完整文件。') : null,
          !preview.canRestore ? h('p', null, reasonLabel(preview.reason)) : null,
          h('button', { type: 'button', disabled: busy || running || !preview.canRestore, onClick: () => setConfirmation(preview), style: btnStyle }, '恢复此文件'),
        ) : null,
        confirm ? h('section', { role: 'dialog', 'aria-label': '确认恢复此文件', style: cardStyle },
          h('h3', null, '确认恢复此文件？'), h('p', null, confirm.path), h('p', null, confirm.action),
          line('预览绑定的当前版本', confirm.expectedCurrentHash), line('将恢复前像', confirm.preImage && (confirm.preImage.existed ? confirm.preImage.hash : '原先不存在：撤回创建')),
          h('p', null, '只恢复这个文件，不自动处理其他文件。文件、类型或路径变化将拒绝写入；当前内容先备份。不提供强制覆盖。预览两分钟有效。'),
          h('button', { type: 'button', disabled: busy || running, onClick: restore, style: btnStyle }, '确认恢复'),
          h('button', { type: 'button', disabled: busy, onClick: () => setConfirmation(null), style: btnStyle }, '取消'),
        ) : null,
      )
    }
    function ChangedFilesView(props) {
      const running = props.useSession((s) => s.running) || false
      return h(ChangedFilesPage, { key: props.sessionId || 'no-session', sessionId: props.sessionId, call: props.call, running })
    }
    // conversation.chat.turnTail 卡片（官方消息流追加槽，渲染在每轮收尾 assistant 文本之后）。
    // 会话级摘要只在最新收尾轮的单元格渲染，避免每个历史轮次重复出现；触发条件不变。
    function ChangedFilesSummary({ sessionId, useSession, useChat, call, turn }) {
      const running = useSession((s) => s.running) || false
      const latestTurn = typeof useChat === 'function' ? useChat((snapshot) => snapshot.timeline.turnOrder.at(-1)) : undefined
      const [value, setValue] = react.useState(null)
      const [error, setError] = react.useState('')
      react.useEffect(() => {
        let alive = true
        setValue(null); setError('')
        if (sessionId && !running) call('changedFiles', { sessionId, cursor: 0, limit: 1 }).then((row) => {
          if (alive && row.sessionId === sessionId) setValue(row)
        }).catch((err) => { if (alive) setError(err.message || String(err)) })
        return () => { alive = false }
      }, [sessionId, running, call])
      if (!sessionId || running) return null
      if (turn !== undefined && latestTurn !== undefined && turn !== latestTurn) return null
      // 与审批结果卡一致：读取失败不在消息流提示区渲染错误；失败细节由「已修改文件」Tab 的错误态承担。
      if (error) return null
      if (!value || value.sessionId !== sessionId || !value.total) return null
      return h('small', { role: 'status' }, '已修改文件：' + value.total + ' 个有快照的文件。请打开「已修改文件」页签查看差异与单文件恢复；shell 等改动未覆盖。')
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
      const call = async (method, ...args) => {
        const deadline = Date.now() + 20000
        await mounted
        for (;;) {
          if (disposed) throw new Error('Client 已卸载')
          const service = ctx.get('remote.auditRollback')
          if (service !== undefined) {
            if (typeof service[method] !== 'function') throw new Error(`Host 缺少 ${method}`)
            if (method !== 'read') parseRollbackRequest(method, args[0])
            const result = await service[method](...args)
            if (!result || result.ok !== true) {
              const message = result && result.error ? (result.error.message || String(result.error)) : 'remote 调用失败'
              throw new Error(message)
            }
            return method === 'read' ? parseStatus(result.value) : parseRollbackResult(method, result.value)
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
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'dsh-guard.changed-files', order: 120, label: '已修改文件',
        inject: () => ({ call }),
      }, ChangedFilesView))
      // 输入框上方（composer.dock）不再注册任何内容；摘要迁移到官方消息流追加槽。
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail', id: 'dsh-guard.changed-files-summary', order: 120,
        inject: () => ({ call }),
      }, ChangedFilesSummary))
    }

    // Pure client helpers exported for the zero-build VM/UI contract tests.
    exports.ChangedFilesPage = ChangedFilesPage
    exports.ChangedFilesView = ChangedFilesView
    exports.ChangedFilesSummary = ChangedFilesSummary
    exports.rollbackDescriptors = rollbackDescriptors
    exports.parseRollbackRequest = parseRollbackRequest
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
