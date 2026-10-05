// dsh-auto-review-router —— 设置页（Client 侧，手写，零构建）
//
// 官方 settings.describe/update 管理 Config；本页仅保存编辑草稿，不自建配置状态。
// Remote 描述符与 Host lib/index.js 的 routerStatusRemote 对齐。

window.__ModuleLoader__.load({
  id: 'dsh-auto-review-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const h = react.createElement

    const NS = 'dsh-auto-review-router'
    const zh = {
      nav: 'Auto 审查路由',
      configuration: '配置', save: '保存', saving: '保存中…', cancel: '取消', saved: '已保存（即时生效）',
      reloadConfig: '重新读取（丢弃草稿）', stale: '配置已过期，请重新读取后再应用修改。',
      safety: '通过官方 Settings 保存。启用仅发布 Auto 选项，不自动更改当前权限或审批策略；关闭会将现有 Auto 会话文件权限收紧为只读。',
      catalogTitle: 'DSH 已配置模型', catalogNote: '仅列出当前活动 Provider 的已配置模型，不探测供应商或调用模型。清空专用路由后按原设置回退当前会话。',
      catalogLoading: '正在读取模型目录…', catalogEmpty: '没有可用的已配置模型；请先在 DSH 模型设置中配置。', catalogFailed: '模型目录读取失败', catalogRefresh: '刷新模型目录', catalogRefreshing: '重新读取模型目录…',
      chooseProvider: '选择 Provider', chooseModel: '选择 Model', clearRoute: '清空专用路由', providerDefault: '模型默认', unavailable: '不可用（保留原值）', checking: '等待目录核验（保留原值）',
      unavailableRoute: '此审查路由不在当前模型目录中；已保留草稿，请刷新、重新选择或清空专用路由。', unavailableEffort: '此 effort 不受所选模型支持；已保留草稿，请重新选择。', catalogRequired: '保存专用路由前必须成功读取模型目录。',
      field_enabled: '启用', field_reviewerProvider: '审查 Provider', field_reviewerModel: '审查 Model', field_reviewerEffort: '审查 Effort',
      field_fallbackToSessionRoute: '允许回退会话路由', field_maxContextBytes: '上下文字节预算', field_historyLimit: '历史条数预算',
      field_includeProjectInstructions: '加入项目指令', field_temperature: '温度', field_timeoutMs: '超时（毫秒）', field_logDecisions: '记录审查决定',
      required: '必填', range: '超出范围或不是合法整数', pair: 'provider 与 model 必须同时填写或同时留空', effortRoute: 'effort 需要完整审查路由', noFallbackRoute: '关闭回退时必须填写审查路由',
      missingRevision: '缺少修订号，请重新读取', remoteFailed: '设置调用失败', readOnly: '设置不可写', noForm: '找不到唯一活动配置条目',
      field_manualFallback: '高危拒绝转官方人工审批', field_manualApprovalTimeoutMs: '人工审批超时（毫秒）',
      manualNote: '高危审查拒绝可转交官方人工审批；默认 60 秒，超时由 Host 取消并拒绝。Never 策略不变，本页不提供人工放行按钮。',
      auditNote: '关闭 logDecisions 仅停止旧日志输出，不关闭持久审批历史。',
      historyTitle: '审批历史', historyScope: '当前会话持久审批历史；结果提示在对应轮次的消息流卡片展示，不是聊天或轨迹工具卡片徽章。',
      historyExecutionNote: '审查允许 ≠ 工具已执行；未收到执行报告时结果未知。', historyLoading: '正在读取审批历史…', historyFailed: '审批历史读取失败（保留已读记录）',
      historyEmpty: '当前会话没有审批记录。', historyNoSession: '请先选择会话。', historyBlank: '请先开始会话。', historyGap: '历史可能不完整或不可用，请检查审计健康状态。',
      historyServiceUnavailable: '无法调用审批历史服务：Host 端插件未加载、RPC 未挂载，或返回内容不合法。这不是账本读取失败——账本本身可能完好。请检查 dsh-auto-review-router 是否处于启用状态，并查看宿主日志。',
      historyTurnCardMore: '条同类结果',
      historyTurnCardGranted: '（命中已授权目录，未询问）',
      historyRisk: '风险', historyRoute: '审查路由', historyLocation: '轮次 / 步骤 / 调用', historyUnknown: '未知', historyUnlinked: '未建立唯一调用关联', historyInspect: '在轨迹中查看调用', historyOlder: '加载更早记录', historyTimeout: '人工审批超时，已拒绝',
      historyPhase_reviewer: '自动审查', historyPhase_downstream: '权限审批', historyPhase_manual: '人工审批', 'historyPhase_reported-result': '工具执行报告',
      history_reviewer_allow: '审查允许（不代表执行）', history_reviewer_deny: '审查拒绝', history_reviewer_failure: '审查失败', history_reviewer_cancel: '审查取消',
      history_downstream_allow: '权限允许（不代表执行）', history_downstream_deny: '权限拒绝', history_downstream_ask: '请求人工审批', history_downstream_cancel: '权限审批取消', history_downstream_failure: '权限审批失败',
      'history_manual_allowed-once': '人工仅本次允许（不代表执行）', history_manual_requested: '等待官方人工审批', history_manual_rejected: '人工拒绝', history_manual_cancelled: '人工审批取消', history_manual_unavailable: '人工审批不可用',
      'history_reported-result_reported-ok': '已报告执行成功', 'history_reported-result_reported-error': '已报告执行错误', 'history_reported-result_unknown': '执行结果未知',
      title: 'Auto 审查路由',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取状态…',
      empty: '还没有读到状态。',
      state: '状态',
      enabled: '已启用',
      disabled: '未启用',
      registered: '已注册 Auto',
      notRegistered: '未注册 Auto',
      notObserved: '尚未观察到注册结果',
      route: '路由',
      sourceConfig: '配置路由',
      sourceSession: '会话回退',
      sourceRejected: '拒绝：配置不全且已关闭会话回退',
      provider: 'provider',
      model: 'model',
      effort: 'effort',
      fallback: '允许回退会话',
      sessionNote: '设置页没有当前会话。回退开启时，每次审查再从会话头读取 provider/model。',
      conflictTitle: '与官方 Auto 冲突',
      conflictBody: '官方 dsh-experimental-auto-review 已注册 Auto，本插件无法同时启用；请先禁用其一。',
      conflictAdvice: '禁用本插件或官方 dsh-experimental-auto-review 中的一个。不要与 dsh-codex-connect 的 enableAutoReview 同时启用。',
      budget: '预算',
      guidance: '修改指引',
      guidanceBody: '使用上方表单通过官方 Settings 保存，持久化由 ConfigEditor 负责。字段校验失败或配置过期时不会覆盖。',
    }
    const en = {
      nav: 'Auto review router',
      configuration: 'Configuration', save: 'Save', saving: 'Saving…', cancel: 'Cancel', saved: 'Saved (applies live)',
      reloadConfig: 'Reload config (discard draft)', stale: 'Configuration is stale; reload before reapplying edits.',
      safety: 'Official Settings owns persistence. Enabling only publishes Auto, without changing current permissions or approval policy. Disabling narrows existing Auto sessions to read-only file access.',
      catalogTitle: 'Configured DSH models', catalogNote: 'Only configured models from active providers are listed; no provider probing or model calls. Clearing the dedicated route keeps the existing session-fallback setting.',
      catalogLoading: 'Reading model catalog…', catalogEmpty: 'No configured models are available; configure models in DSH model settings first.', catalogFailed: 'Model catalog request failed', catalogRefresh: 'Refresh model catalog', catalogRefreshing: 'Reloading model catalog…',
      chooseProvider: 'Choose provider', chooseModel: 'Choose model', clearRoute: 'Clear dedicated route', providerDefault: 'Model default', unavailable: 'Unavailable (value retained)', checking: 'Awaiting catalog (value retained)',
      unavailableRoute: 'This reviewer route is absent from the current catalog; the draft is retained. Refresh, select another model, or clear the dedicated route.', unavailableEffort: 'This effort is not supported by the selected model; the draft is retained. Select another effort.', catalogRequired: 'Load the model catalog successfully before saving a dedicated route.',
      field_enabled: 'Enabled', field_reviewerProvider: 'Reviewer provider', field_reviewerModel: 'Reviewer model', field_reviewerEffort: 'Reviewer effort',
      field_fallbackToSessionRoute: 'Allow session-route fallback', field_maxContextBytes: 'Context byte budget', field_historyLimit: 'History item budget',
      field_includeProjectInstructions: 'Include project instructions', field_temperature: 'Temperature', field_timeoutMs: 'Timeout (ms)', field_logDecisions: 'Log review decisions',
      required: 'Required', range: 'Out of range or invalid integer', pair: 'Provider and model must both be filled or empty', effortRoute: 'Effort requires a complete reviewer route', noFallbackRoute: 'A reviewer route is required when fallback is off',
      missingRevision: 'Missing revision; reload configuration', remoteFailed: 'Settings request failed', readOnly: 'Settings are read-only', noForm: 'No unique active configuration entry',
      field_manualFallback: 'Escalate high-risk denial to official approval', field_manualApprovalTimeoutMs: 'Manual approval timeout (ms)',
      manualNote: 'A high-risk denial can use official manual approval; default 60 seconds. Host cancels and rejects on timeout. Never policy is unchanged; this page has no allow button.',
      auditNote: 'Disabling logDecisions only stops legacy log output, not durable approval history.',
      historyTitle: 'Approval history', historyScope: 'Durable history for this session. Result reminders appear as message-flow cards on their turn, not as chat or trajectory tool-card badges.',
      historyExecutionNote: 'Review allow ≠ tool execution; execution is unknown without a reported result.', historyLoading: 'Reading approval history…', historyFailed: 'Approval history read failed (retaining loaded records)',
      historyEmpty: 'No approval records for this session.', historyNoSession: 'Select a session first.', historyBlank: 'Start a conversation first.', historyGap: 'History may be incomplete or unavailable; check audit health.',
      historyServiceUnavailable: 'Cannot reach the approval history service: the host plugin is not loaded, the RPC is not mounted, or the response failed validation. This is not a ledger read failure — the ledger itself may be intact. Check that dsh-auto-review-router is enabled and inspect the host log.',
      historyTurnCardMore: 'more like this',
      historyTurnCardGranted: '(matched a granted directory; not asked again)',
      historyRisk: 'Risk', historyRoute: 'Reviewer route', historyLocation: 'Turn / step / call', historyUnknown: 'Unknown', historyUnlinked: 'No verified unique call association', historyInspect: 'Inspect call in trajectory', historyOlder: 'Load earlier records', historyTimeout: 'Manual approval timed out; rejected',
      historyPhase_reviewer: 'Auto review', historyPhase_downstream: 'Permission approval', historyPhase_manual: 'Manual approval', 'historyPhase_reported-result': 'Reported tool result',
      history_reviewer_allow: 'Review allowed (not execution)', history_reviewer_deny: 'Review denied', history_reviewer_failure: 'Review failed', history_reviewer_cancel: 'Review cancelled',
      history_downstream_allow: 'Permission allowed (not execution)', history_downstream_deny: 'Permission denied', history_downstream_ask: 'Manual approval requested', history_downstream_cancel: 'Permission approval cancelled', history_downstream_failure: 'Permission approval failed',
      'history_manual_allowed-once': 'Allowed once by human (not execution)', history_manual_requested: 'Waiting for official manual approval', history_manual_rejected: 'Rejected by human', history_manual_cancelled: 'Manual approval cancelled', history_manual_unavailable: 'Manual approval unavailable',
      'history_reported-result_reported-ok': 'Execution reported successful', 'history_reported-result_reported-error': 'Execution reported an error', 'history_reported-result_unknown': 'Execution result unknown',
      title: 'Auto review router',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Reading status…',
      empty: 'No status yet.',
      state: 'Status',
      enabled: 'Enabled',
      disabled: 'Disabled',
      registered: 'Auto registered',
      notRegistered: 'Auto not registered',
      notObserved: 'Registration has not been observed',
      route: 'Route',
      sourceConfig: 'Configured route',
      sourceSession: 'Session fallback',
      sourceRejected: 'Rejected: route config is incomplete and session fallback is off',
      provider: 'provider',
      model: 'model',
      effort: 'effort',
      fallback: 'Session fallback',
      sessionNote: 'This page has no current session. While fallback is on, each review reads provider/model from the session header.',
      conflictTitle: 'Conflicts with official Auto',
      conflictBody: 'Official dsh-experimental-auto-review already registered Auto. This plugin cannot enable at the same time; disable one of them.',
      conflictAdvice: 'Disable either this plugin or official dsh-experimental-auto-review. Do not enable it together with dsh-codex-connect enableAutoReview.',
      budget: 'Budget',
      guidance: 'How to change config',
      guidanceBody: 'Use the form above. Official Settings and ConfigEditor own persistence and revision checks. Refused or stale edits never overwrite current configuration.',
    }

    // 与 Host lib/index.js 的 parseRouterStatus 逻辑逐句一致；互反样例见 test/status.mjs。
    function parseStatus(value) {
      if (!value || typeof value !== 'object' || value.plugin !== 'dsh-auto-review-router') {
        throw new Error('Invalid auto-review-router status')
      }
      const registration = value.registration
      if (!registration || typeof registration !== 'object'
        || typeof registration.observed !== 'boolean' || typeof registration.attempted !== 'boolean'
        || typeof registration.registered !== 'boolean' || typeof registration.conflict !== 'boolean'
        || typeof registration.closeFailed !== 'boolean'
        || (registration.conflictWarning !== null && typeof registration.conflictWarning !== 'string')
        || (registration.error !== null && typeof registration.error !== 'string')) {
        throw new Error('Invalid auto-review-router status.registration')
      }
      if (!value.route || typeof value.route.source !== 'string') throw new Error('Invalid auto-review-router status.route')
      const budget = value.budget
      if (!budget || typeof budget !== 'object'
        || typeof budget.maxContextBytes !== 'number' || typeof budget.historyLimit !== 'number'
        || typeof budget.timeoutMs !== 'number' || typeof budget.temperature !== 'number'
        || typeof budget.logDecisions !== 'boolean') {
        throw new Error('Invalid auto-review-router status.budget')
      }
      return value
    }

    const statusRemote = {
      package: 'dsh-auto-review-router',
      descriptors: [
        {
          id: 'dsh-auto-review-router#autoReviewRouter/read',
          service: 'autoReviewRouter',
          namespace: 'autoReviewRouter',
          method: 'read',
          invocation: { kind: 'direct' },
          parameters: [],
          result: {
            mode: 'strict',
            typeSymbol: 'dsh-auto-review-router#RouterStatus',
            schema: { parse: parseStatus },
            create: () => ({ parse: parseStatus }),
          },
        },
        {
          id: 'dsh-auto-review-router#autoReviewRouter/history',
          service: 'autoReviewRouter', namespace: 'autoReviewRouter', method: 'history',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json',
            codec: statusCodec('dsh-auto-review-router#ApprovalHistoryRequest', parseHistoryRequest) }],
          result: statusCodec('dsh-auto-review-router#ApprovalHistoryResult', parseHistoryResult),
        },
      ],
    }
    function statusCodec(typeSymbol, parse) {
      return { mode: 'strict', typeSymbol, schema: { parse }, create: () => ({ parse }) }
    }

    const pageStyle = { padding: 16, maxWidth: 760, font: '13px/1.55 sans-serif' }
    const cardStyle = { marginTop: 14, padding: 12, border: '1px solid rgba(128,128,128,.28)', borderRadius: 10 }
    const btnStyle = { padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', cursor: 'pointer' }
    const labelStyle = { opacity: 0.7, marginRight: 8 }
    const rowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }
    const warnStyle = { marginTop: 14, padding: 12, borderRadius: 10, border: '1px solid rgba(220,38,38,.45)', background: 'rgba(220,38,38,.08)' }

    function line(label, value) {
      return h('div', { style: rowStyle }, h('span', { style: labelStyle }, label), h('span', { style: { overflowWrap: 'anywhere' } }, value))
    }

    function show(value) {
      if (value === null || value === undefined || value === '') return '—'
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return String(value)
    }

    function routeLabel(source, t) {
      if (source === 'config') return t('sourceConfig')
      if (source === 'session-fallback') return t('sourceSession')
      return t('sourceRejected')
    }

    const formFields = [
      ['enabled', 'boolean'], ['reviewerProvider', 'string'], ['reviewerModel', 'string'], ['reviewerEffort', 'string'],
      ['fallbackToSessionRoute', 'boolean'], ['maxContextBytes', 'number', 1, 1048576], ['historyLimit', 'number', 0, 1000],
      ['includeProjectInstructions', 'boolean'], ['temperature', 'number', 0, 2], ['timeoutMs', 'number', 1, 300000], ['logDecisions', 'boolean'],
      ['manualFallback', 'boolean'], ['manualApprovalTimeoutMs', 'number', 1000, 300000],
    ]
    function validateDraft(draft, t = key => zh[key] || key) {
      const values = {}
      for (const [key, type, min, max] of formFields) {
        if (type === 'number') {
          if (String(draft[key]).trim() === '') throw new Error(`${key}: ${t('required')}`)
          const value = Number(draft[key])
          if (!Number.isFinite(value) || value < min || value > max || (key !== 'temperature' && !Number.isInteger(value))) throw new Error(`${key}: ${t('range')} (${min}–${max})`)
          values[key] = value
        } else if (type === 'boolean') {
          if (typeof draft[key] !== 'boolean') throw new Error(`${key}: boolean required`)
          values[key] = draft[key]
        } else values[key] = String(draft[key] ?? '').trim()
      }
      if (Boolean(values.reviewerProvider) !== Boolean(values.reviewerModel)) throw new Error(t('pair'))
      if (values.reviewerEffort && !values.reviewerProvider) throw new Error(t('effortRoute'))
      if (values.enabled && !values.fallbackToSessionRoute && !values.reviewerProvider) throw new Error(t('noFallbackRoute'))
      return values
    }
    function unwrap(result, t = key => zh[key] || key) {
      if (result?.ok === true) return result.value
      const error = new Error(result?.error?.message || t('remoteFailed'))
      error.code = result?.error?.code
      throw error
    }
    function createSettingsIO(service, t = key => zh[key] || key, isDisposed = () => false) {
      const check = () => { if (isDisposed()) throw new Error('Client disposed') }
      return {
        async read() {
          check()
          const result = unwrap(await service.describe(), t)
          check()
          if (!result.writable) throw new Error(t('readOnly'))
          const matches = result.namespaces.filter(row => row.ns === 'auto-review-router')
          if (matches.length !== 1) throw new Error(t('noForm'))
          return matches[0]
        },
        async save(form, draft) {
          check()
          if (!Number.isInteger(form?.revision)) throw new Error(t('missingRevision'))
          const value = unwrap(await service.update(form.ns, validateDraft(draft, t), form.revision), t)
          check()
          return value
        },
      }
    }
    // Official session/modelCatalog is a global, zero-argument catalog read. Unlike
    // llm.listModels (Host-only), it carries resolved reasoning metadata to clients.
    function createCatalogIO(service, isDisposed = () => false, t = key => zh[key] || key) {
      return async () => {
        if (isDisposed()) throw new Error('Client disposed')
        const value = unwrap(await service.modelCatalog(), t)
        if (isDisposed()) throw new Error('Client disposed')
        return value
      }
    }
    function catalogModel(catalog, provider, model) {
      return catalog?.groups.find(group => group.id === provider)?.models.find(row => row.id === model)
    }
    function catalogProblem(values, state, original, t) {
      // Closing Auto must remain possible during outages, retaining the original
      // dedicated route verbatim. This is UI validation only, not a Host policy.
      const unchanged = ['reviewerProvider', 'reviewerModel', 'reviewerEffort'].every(key => values[key] === String(original?.[key] ?? '').trim())
      if (!values.enabled && unchanged) return ''
      if (!values.reviewerProvider || !values.reviewerModel) return '' // Config owns pair validation.
      if (state.status !== 'ready') return t('catalogRequired')
      const model = catalogModel(state.value, values.reviewerProvider, values.reviewerModel)
      if (!model) return t('unavailableRoute')
      if (values.reviewerEffort && !model.reasoning?.efforts.some(effort => effort.id === values.reviewerEffort)) return t('unavailableEffort')
      return ''
    }
    function RouterPage({ call, settings, loadCatalog, t }) {
      const lifetime = react.useRef({ active: true, status: 0, form: 0, catalog: 0 })
      react.useEffect(() => {
        lifetime.current.active = true
        return () => {
          lifetime.current.active = false
          for (const key of ['status', 'form', 'catalog']) lifetime.current[key]++
        }
      }, [])
      const current = (key, generation) => lifetime.current.active && lifetime.current[key] === generation
      const [status, setStatus] = react.useState(null)
      const [error, setError] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const load = react.useCallback(async () => {
        if (!lifetime.current.active) return
        const generation = ++lifetime.current.status
        setBusy(true); setError('')
        try {
          const value = await call('read')
          if (current('status', generation)) setStatus(value)
        } catch (error) {
          if (current('status', generation)) setError(error?.message || String(error))
        } finally { if (current('status', generation)) setBusy(false) }
      }, [call])
      react.useEffect(() => { load(); return () => { lifetime.current.status++ } }, [load])

      const [catalog, setCatalog] = react.useState({ value: null, status: 'idle', error: '' })
      const reloadCatalog = react.useCallback(async () => {
        if (!lifetime.current.active) return
        const generation = ++lifetime.current.catalog
        // Do not offer a stale directory while refreshing. Draft values never change.
        setCatalog({ value: null, status: 'loading', error: '' })
        try {
          const value = await loadCatalog()
          if (current('catalog', generation)) setCatalog({ value, status: 'ready', error: '' })
        } catch (error) {
          if (current('catalog', generation)) setCatalog({ value: null, status: 'error', error: error?.message || String(error) })
        }
      }, [loadCatalog])
      react.useEffect(() => { reloadCatalog(); return () => { lifetime.current.catalog++ } }, [reloadCatalog])

      const [form, setForm] = react.useState(null)
      const [draft, setDraft] = react.useState(null)
      const [formError, setFormError] = react.useState('')
      const [saving, setSaving] = react.useState(false)
      const [notice, setNotice] = react.useState('')
      const reloadForm = react.useCallback(async () => {
        if (!lifetime.current.active) return
        const generation = ++lifetime.current.form
        setSaving(true); setFormError('')
        try {
          const value = await settings.read()
          if (current('form', generation)) { setForm(value); setDraft({ ...value.value }); setNotice('') }
        } catch (error) { if (current('form', generation)) setFormError(error.message) }
        finally { if (current('form', generation)) setSaving(false) }
      }, [settings])
      react.useEffect(() => { reloadForm(); return () => { lifetime.current.form++ } }, [reloadForm])
      const save = async () => {
        if (!lifetime.current.active || saving) return
        const generation = ++lifetime.current.form
        setSaving(true); setFormError(''); setNotice('')
        try {
          const values = validateDraft(draft, t)
          const problem = catalogProblem(values, catalog, form?.value, t)
          if (problem) throw new Error(problem)
          const value = await settings.save(form, values)
          if (current('form', generation)) {
            setForm(value); setDraft({ ...value.value }); setNotice(t('saved'))
            await load()
          }
        } catch (error) {
          // Never advance the revision or discard edits after a refusal.
          if (current('form', generation)) setFormError(error.code === 'settings/conflict' ? `${t('stale')} ${error.message}` : error.message)
        } finally { if (current('form', generation)) setSaving(false) }
      }
      const dirty = !!form && JSON.stringify(draft) !== JSON.stringify(form.value)
      const groups = catalog.value?.groups || []
      const selectedProvider = groups.find(group => group.id === draft?.reviewerProvider)
      const selectedModel = catalogModel(catalog.value, draft?.reviewerProvider, draft?.reviewerModel)
      const efforts = selectedModel?.reasoning?.efforts || []
      const defaultEffort = efforts.find(effort => effort.id === selectedModel?.reasoning?.defaultEffort)
      const ready = catalog.status === 'ready'
      const problem = draft ? catalogProblem(draft, catalog, form?.value, t) : ''
      const retainedOption = value => h('option', { value, disabled: true }, `${value} — ${t(ready ? 'unavailable' : 'checking')}`)
      const select = (key, options, onChange, disabled = false) => h('select', {
        'aria-label': key, value: draft[key] ?? '', disabled: saving || disabled, onChange,
      }, ...options)
      const changeProvider = event => {
        const provider = event.target.value
        setDraft(previous => provider === previous.reviewerProvider ? previous : { ...previous, reviewerProvider: provider, reviewerModel: '', reviewerEffort: '' })
      }
      const changeModel = event => {
        const model = event.target.value
        setDraft(previous => {
          const info = catalogModel(catalog.value, previous.reviewerProvider, model)
          const compatible = info?.reasoning?.efforts.some(effort => effort.id === previous.reviewerEffort)
          return { ...previous, reviewerModel: model, reviewerEffort: compatible ? previous.reviewerEffort : '' }
        })
      }
      const routeControl = key => {
        if (key === 'reviewerProvider') return select(key, [
          h('option', { value: '' }, t('chooseProvider')),
          ...(draft[key] && !selectedProvider ? [retainedOption(draft[key])] : []),
          ...groups.map(group => h('option', { key: group.id, value: group.id }, `${group.name} (${group.id})`)),
        ], changeProvider, !ready)
        if (key === 'reviewerModel') return select(key, [
          h('option', { value: '' }, t('chooseModel')),
          ...(draft[key] && !selectedModel ? [retainedOption(draft[key])] : []),
          ...(selectedProvider?.models || []).map(model => h('option', { key: model.id, value: model.id }, `${model.name} (${model.id})`)),
        ], changeModel, !ready || !selectedProvider)
        return select(key, [
          h('option', { value: '' }, `${t('providerDefault')}${defaultEffort ? ` — ${defaultEffort.name} (${defaultEffort.id})` : ''}`),
          ...(draft[key] && !efforts.some(effort => effort.id === draft[key]) ? [retainedOption(draft[key])] : []),
          ...efforts.map(effort => h('option', { key: effort.id, value: effort.id }, `${effort.name} (${effort.id})`)),
        ], event => setDraft(previous => ({ ...previous, reviewerEffort: event.target.value })), !ready || !selectedModel || (!efforts.length && !draft[key]))
      }
      const reg = status ? status.registration : null
      const route = status ? status.route : null
      return h('div', { style: pageStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('h2', { style: { margin: 0, fontSize: 16 } }, t('title')),
          h('button', { type: 'button', disabled: busy, style: btnStyle, onClick: () => load() }, busy ? t('refreshing') : t('refresh')),
        ),
        h('section', { style: cardStyle },
          h('h3', null, t('configuration')),
          h('p', null, t('safety')),
          h('p', null, t('manualNote')),
          h('p', null, t('auditNote')),
          h('h4', null, t('catalogTitle')),
          h('p', null, t('catalogNote')),
          h('button', { type: 'button', disabled: saving, style: btnStyle, onClick: reloadCatalog }, catalog.status === 'loading' ? t('catalogRefreshing') : t('catalogRefresh')),
          catalog.status === 'loading' ? h('p', { role: 'status' }, t('catalogLoading')) : null,
          catalog.error ? h('p', { role: 'alert' }, `${t('catalogFailed')}: ${catalog.error}`) : null,
          ready && !groups.length ? h('p', { role: 'status' }, t('catalogEmpty')) : null,
          ...(catalog.value?.failures || []).map(failure => h('p', { key: failure.id, role: 'alert' }, `${failure.name} (${failure.id}): ${failure.message}`)),
          ready && draft?.reviewerModel && !selectedModel ? h('p', { role: 'alert' }, t('unavailableRoute')) : null,
          ready && selectedModel && draft?.reviewerEffort && !efforts.some(effort => effort.id === draft.reviewerEffort) ? h('p', { role: 'alert' }, t('unavailableEffort')) : null,
          problem && !ready ? h('p', { role: 'status' }, problem) : null,
          formError ? h('p', { role: 'alert', style: { color: '#dc2626' } }, formError) : null,
          notice ? h('p', { role: 'status' }, notice) : null,
          draft ? h('form', { onSubmit: (event) => { event.preventDefault(); if (!saving) save() } },
            ...formFields.map(([key, type, min, max]) => h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' } },
              h('span', { style: { minWidth: 185 } }, t('field_' + key)),
              type === 'string' ? routeControl(key) : h('input', {
                'aria-label': key, type: type === 'boolean' ? 'checkbox' : 'number',
                disabled: saving, ...(type === 'boolean' ? { checked: draft[key] === true } : { value: draft[key] ?? '' }),
                ...(type === 'number' ? { min, max, step: key === 'temperature' ? 'any' : 1 } : {}),
                onChange: (event) => setDraft(previous => ({ ...previous, [key]: type === 'boolean' ? event.target.checked : event.target.value })),
              }),
            )),
            h('button', { type: 'button', disabled: saving || !(draft.reviewerProvider || draft.reviewerModel || draft.reviewerEffort), style: btnStyle, onClick: () => { setDraft(previous => ({ ...previous, reviewerProvider: '', reviewerModel: '', reviewerEffort: '' })); setFormError(''); setNotice('') } }, t('clearRoute')),
            h('button', { type: 'submit', disabled: saving || !dirty || !!problem, style: btnStyle }, saving ? t('saving') : t('save')),
            h('button', { type: 'button', disabled: saving || !dirty, style: btnStyle, onClick: () => { setDraft({ ...form.value }); setFormError(''); setNotice('') } }, t('cancel')),
          ) : null,
          h('button', { type: 'button', disabled: saving, style: btnStyle, onClick: reloadForm }, t('reloadConfig')),
        ),
        error ? h('p', { role: 'alert', style: { color: '#dc2626', overflowWrap: 'anywhere' } }, error) : null,
        !status && !error ? h('p', null, busy ? t('loading') : t('empty')) : null,
        reg?.error ? h('p', { role: 'alert', style: warnStyle }, reg.error) : null,
        reg && reg.conflict ? h('section', { role: 'alert', style: warnStyle },
          h('strong', null, t('conflictTitle')),
          h('p', { style: { margin: '6px 0 0' } }, reg.conflictWarning || t('conflictBody')),
          h('p', { style: { margin: '6px 0 0' } }, t('conflictAdvice')),
        ) : null,
        status ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('state')),
          line(t('state'), status.enabled ? t('enabled') : t('disabled')),
          line('Auto', !reg.observed ? t('notObserved') : (reg.registered ? t('registered') : t('notRegistered'))),
        ) : null,
        route ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('route')),
          line(t('route'), routeLabel(route.source, t)),
          line(t('provider'), show(route.provider)),
          line(t('model'), show(route.model)),
          line(t('effort'), show(route.effort)),
          line(t('fallback'), show(route.fallbackToSessionRoute)),
          route.rejection ? h('p', { role: 'alert', style: { color: '#dc2626' } }, route.rejection) : null,
          route.source === 'session-fallback' ? h('p', { style: { opacity: 0.8 } }, t('sessionNote')) : null,
        ) : null,
        status ? h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('budget')),
          line('maxContextBytes', show(status.budget.maxContextBytes)),
          line('historyLimit', show(status.budget.historyLimit)),
          line('timeoutMs', show(status.budget.timeoutMs)),
          line('temperature', show(status.budget.temperature)),
          line('logDecisions', show(status.budget.logDecisions)),
        ) : null,
        h('section', { style: cardStyle },
          h('h3', { style: { margin: '0 0 6px', fontSize: 14 } }, t('guidance')),
          h('p', { style: { margin: 0 } }, t('guidanceBody')),
        ),
      )
    }

    // UI-only history: no prompt/messages, no tool renderer replacement, no approval buttons.
    const HISTORY_ERRORS = new Set(['invalid-request', 'session-not-found', 'session-unavailable', 'history-unavailable'])
    const safeText = (value, length = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length) : ''
    // These browser-only parsers mirror approval-history.js. No Node module import.
    const PHASES = {
      reviewer: ['allow', 'deny', 'failure', 'cancel'],
      downstream: ['allow', 'deny', 'ask', 'cancel', 'failure'],
      manual: ['requested', 'allowed-once', 'rejected', 'cancelled', 'unavailable'],
      'reported-result': ['reported-ok', 'reported-error', 'unknown'],
    }
    const OPTIONAL_TEXT = { parentDispatchId: 80, parentCallId: 200, subCallId: 200,
      approvalRequestId: 80, cause: 80, errorName: 80, errorCode: 80, route: 160, reasonSummary: 240 }
    const OPTIONAL_NUMBERS = ['callEventSeq', 'durationMs', 'deadlineAt', 'sourceSeq']
    const CODE_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/
    const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
    const int = value => Number.isSafeInteger(value) && value >= 0
    const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
    function parseHistoryRequest(value) {
      if (!plain(value) || Object.keys(value).some(key => !['sessionId', 'cursor', 'limit'].includes(key))
        || !text(value.sessionId, 200) || !value.sessionId.trim()
        || value.cursor !== undefined && (!text(value.cursor, 1024) || !/^[A-Za-z0-9_-]+$/.test(value.cursor))
        || value.limit !== undefined && (!int(value.limit) || value.limit < 1 || value.limit > 100)) {
        throw new TypeError('Invalid approval history request')
      }
      return { sessionId: value.sessionId, ...(value.cursor === undefined ? {} : { cursor: value.cursor }), limit: value.limit ?? 50 }
    }
    function parseHistoryRecord(value) {
      const required = ['schemaVersion', 'eventId', 'time', 'ledgerSeq', 'dispatchId', 'sessionId', 'turn', 'step', 'callId', 'rootCallId', 'toolName', 'phase', 'outcome']
      if (!plain(value) || Object.keys(value).some(key => ![...required, ...Object.keys(OPTIONAL_TEXT), ...OPTIONAL_NUMBERS, 'risk'].includes(key))
        || required.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1
        || !UUID.test(value.eventId) || !UUID.test(value.dispatchId) || !int(value.time) || !int(value.ledgerSeq)
        || !text(value.sessionId, 200) || !value.sessionId.trim() || !text(value.callId, 200) || !text(value.rootCallId, 200)
        || !text(value.toolName, 160) || !PHASES[value.phase]?.includes(value.outcome)
        || value.turn !== null && !int(value.turn) || value.step !== null && !int(value.step)
        || Object.entries(OPTIONAL_TEXT).some(([key, max]) => value[key] !== undefined && !text(value[key], max))
        || ['errorName', 'errorCode'].some(key => value[key] !== undefined && !CODE_TOKEN.test(value[key]))
        || OPTIONAL_NUMBERS.some(key => value[key] !== undefined && !int(value[key]))
        || value.risk !== undefined && !['low', 'medium', 'high'].includes(value.risk)) {
        throw new TypeError('Invalid approval history record')
      }
      return value
    }
    function parseHistoryResult(value) {
      if (!plain(value) || typeof value.ok !== 'boolean') throw new TypeError('Invalid approval history result')
      if (!value.ok) {
        if (Object.keys(value).some(key => !['ok', 'error'].includes(key)) || !plain(value.error)
          || Object.keys(value.error).some(key => !['code', 'message'].includes(key))
          || !['invalid-request', 'session-not-found', 'session-unavailable', 'history-unavailable'].includes(value.error.code)
          || !text(value.error.message, 200)) throw new TypeError('Invalid approval history error')
        return value
      }
      const page = value.value, health = page?.health
      if (Object.keys(value).some(key => !['ok', 'value'].includes(key)) || !plain(page)
        || Object.keys(page).some(key => !['records', 'nextCursor', 'health'].includes(key))
        || !Array.isArray(page.records) || page.records.length > 100
        || page.nextCursor !== null && !text(page.nextCursor, 1024) || !plain(health)
        || Object.keys(health).some(key => !['ready', 'gap', 'writeFailures', 'readFailures', 'droppedRecords', 'corruptRecords', 'missingProfile', 'closing', 'lastErrorCode'].includes(key))
        || ['ready', 'gap', 'missingProfile', 'closing'].some(key => typeof health[key] !== 'boolean')
        || ['writeFailures', 'readFailures', 'droppedRecords', 'corruptRecords'].some(key => !int(health[key]))
        || health.lastErrorCode !== null && !text(health.lastErrorCode, 80)) throw new TypeError('Invalid approval history page')
      for (const record of page.records) parseHistoryRecord(record)
      return value
    }
    const parseHistory = value => parseHistoryResult({ ok: true, value }).value
    // One source/poller per session, shared by history Tab and resident dock. Requests
    // are read-only; abort invalidates their local lifetime even if transport cannot cancel.
    function createHistoryStore(read, options = {}) {
      const timer = options.setTimeout || setTimeout
      const clearTimer = options.clearTimeout || clearTimeout
      const sources = new Map()
      let disposed = false
      const empty = (sessionId, status = 'idle') => ({ sessionId, status, records: [], nextCursor: null, health: null, error: '' })
      function source(sessionId) {
        const key = typeof sessionId === 'string' && sessionId ? sessionId : null
        if (sources.has(key)) return sources.get(key)
        let state = empty(key, disposed ? 'disposed' : key ? 'idle' : 'sessionless')
        let active = false, closed = disposed, generation = 0, timeout, controller, pages = 1
        const listeners = new Set()
        const emit = value => { state = value; for (const listener of [...listeners]) listener() }
        const cancel = () => { generation++; controller?.abort(); controller = undefined; if (timeout !== undefined) clearTimer(timeout); timeout = undefined }
        const schedule = () => {
          if (active && !closed && key) timeout = timer(() => { timeout = undefined; void load('poll') }, options.pollMs || 2500)
        }
        async function load(mode = 'refresh') {
          if (!active || closed || !key) return
          cancel()
          const token = generation
          controller = new AbortController()
          const signal = controller.signal
          const current = () => active && !closed && token === generation && !signal.aborted
          const older = mode === 'older'
          if (older && state.nextCursor === null) { schedule(); return }
          if (mode === 'refresh') pages = 1
          const depth = older ? 1 : pages
          const before = state
          emit({ ...state, status: state.health === null ? 'loading' : older ? 'loading-older' : 'refreshing', error: '' })
          try {
            let cursor = older ? before.nextCursor : undefined, health, records = older ? [...before.records] : []
            for (let index = 0; index < depth; index++) {
              const value = parseHistory(await read({ sessionId: key, ...(cursor === undefined ? {} : { cursor }), limit: 50 }, signal))
              if (!current()) return
              if (value.records.some(row => row.sessionId !== key)) throw new Error('Cross-session history response')
              records.push(...value.records); health = value.health; cursor = value.nextCursor
              if (cursor === null) break
            }
            if (!current()) return
            const unique = new Map(records.map(row => [row.eventId, row]))
            records = [...unique.values()].sort((a, b) => b.ledgerSeq - a.ledgerSeq)
            if (older) pages++
            emit({ sessionId: key, status: 'ready', records, nextCursor: cursor ?? null, health, error: '' })
          } catch (error) {
            // Host 业务错误码（HISTORY_ERRORS，由 Host 结果携带）原样透传；RPC 挂载失败、
            // 服务缺失、超时、解析失败等无 code 错误一律归类为 service-unavailable，
            // 不得误标为账本读取失败（history-unavailable）。
            if (current()) emit({ ...state, status: 'error', error: HISTORY_ERRORS.has(error?.code) ? error.code : 'service-unavailable' })
          } finally { if (current()) { controller = undefined; schedule() } }
        }
        const entry = {
          getSnapshot: () => state,
          subscribe(listener) {
            if (closed) return () => {}
            listeners.add(listener)
            if (!active && key) { active = true; void load('poll') }
            return () => {
              listeners.delete(listener)
              if (!listeners.size) { active = false; cancel(); pages = 1; state = empty(key, key ? 'idle' : 'sessionless') }
            }
          },
          refresh: () => load('refresh'),
          older: () => load('older'),
          dispose() { closed = true; active = false; cancel(); emit(empty(key, 'disposed')); listeners.clear() },
        }
        sources.set(key, entry)
        return entry
      }
      return { source, dispose() { disposed = true; for (const value of sources.values()) value.dispose() } }
    }
    function groupHistory(records) {
      const groups = new Map()
      for (const row of records) {
        let group = groups.get(row.dispatchId)
        if (!group) { group = { dispatchId: row.dispatchId, rows: [], latest: row }; groups.set(row.dispatchId, group) }
        group.rows.push(row)
      }
      for (const group of groups.values()) group.rows.sort((a, b) => a.ledgerSeq - b.ledgerSeq)
      // DTO has no whole-session occurrence-uniqueness proof. Page-local counts
      // cannot authorize inspectCall(callId); show coordinates without navigation.
      return [...groups.values()]
    }
    function outcomeText(row, t) {
      const key = `history_${row.phase}_${row.outcome}`
      const label = t(key)
      return row.phase === 'manual' && row.cause === 'timeout' ? t('historyTimeout') : label === key ? safeText(row.outcome, 80) : label
    }
    function historyHealth(health, t) {
      if (!health) return null
      const gap = !health.ready || health.gap || health.missingProfile || health.closing || health.writeFailures > 0 || health.readFailures > 0 || health.droppedRecords > 0 || health.corruptRecords > 0
      return gap ? h('p', { role: 'alert', style: warnStyle }, `${t('historyGap')} · write=${health.writeFailures}, read=${health.readFailures}, dropped=${health.droppedRecords}, corrupt=${health.corruptRecords}${health.lastErrorCode ? ` · ${safeText(health.lastErrorCode, 80)}` : ''}`) : null
    }
    function useHistory({ sessionId, useSession, history }) {
      const session = useSession(value => value)
      const eligibleId = sessionId && session && !session.blank ? sessionId : null
      const source = history.source(eligibleId)
      const state = react.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
      return { source, state, blank: !!session?.blank }
    }
    function HistoryView(props) {
      const { source, state, blank } = useHistory(props), t = props.t
      const groups = groupHistory(state.records)
      const loading = ['loading', 'refreshing', 'loading-older'].includes(state.status)
      const errorText = (code) => {
        if (code === 'service-unavailable') return t('historyServiceUnavailable')
        if (code === 'history-unavailable') return `${t('historyFailed')} · ${code}`
        return `${t('historyFailed')} · ${code}`
      }
      return h('section', { style: { ...pageStyle, flex: 1, minHeight: 0, overflowY: 'auto', overflowWrap: 'anywhere', boxSizing: 'border-box', width: '100%' } },
        h('h2', null, t('historyTitle')),
        h('p', null, t('historyScope')),
        h('p', null, t('historyExecutionNote')),
        state.sessionId === null ? h('p', { role: 'status' }, t(blank ? 'historyBlank' : 'historyNoSession')) : h('button', { type: 'button', style: btnStyle, disabled: loading || state.status === 'disposed', onClick: () => source.refresh() }, t('refresh')),
        loading ? h('p', { role: 'status' }, t('historyLoading')) : null,
        // 2026-10-05 用户裁定：三类原因必须分开说，不能都归成「服务不可用」。
        // - service-unavailable：RPC 挂载/传输/解析层失败，与账本内容无关。
        // - history-unavailable：Host 侧明确回报账本不可用（真实读取失败）。
        // - 其它业务码（invalid-request / session-not-found / session-unavailable）：按码显示。
        state.error ? h('p', { role: 'alert' }, errorText(state.error, t)) : null,
        historyHealth(state.health, t),
        state.status === 'ready' && !groups.length && state.health.ready && !state.health.gap && !state.health.missingProfile && !state.health.closing ? h('p', { role: 'status' }, t('historyEmpty')) : null,
        ...groups.map(group => h('article', { key: group.dispatchId, style: cardStyle },
          h('h3', null, safeText(group.latest.toolName, 160)),
          h('p', null, `${new Date(group.latest.time).toLocaleString()} · ${t('historyRisk')}: ${safeText(group.rows.find(row => row.risk)?.risk, 20) || t('historyUnknown')}`),
          h('p', null, `${t('historyRoute')}: ${safeText(group.rows.find(row => row.route)?.route, 160) || t('historyUnknown')}`),
          h('p', null, `${t('historyLocation')}: ${Number.isInteger(group.latest.turn) ? group.latest.turn : '?'} / ${Number.isInteger(group.latest.step) ? group.latest.step : '?'} · ${safeText(group.latest.callId, 160) || t('historyUnlinked')}`),
          h('ol', null, ...group.rows.map(row => h('li', { key: row.eventId },
            h('strong', null, `${t('historyPhase_' + row.phase)}: ${outcomeText(row, t)}`),
            h('span', null, ` · ${new Date(row.time).toLocaleString()}`),
            row.reasonSummary ? h('span', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, ` — ${safeText(row.reasonSummary)}`) : null,
            row.cause ? h('span', null, ` · cause: ${safeText(row.cause, 80)}`) : null,
            row.deadlineAt !== undefined ? h('span', null, ` · deadline: ${new Date(row.deadlineAt).toLocaleString()}`) : null,
          ))),
          h('p', null, `dispatchId: ${safeText(group.dispatchId, 160)} · callEventSeq: ${Number.isInteger(group.latest.callEventSeq) ? group.latest.callEventSeq : t('historyUnknown')}`),
          h('p', null, `rootCallId: ${safeText(group.latest.rootCallId, 200) || t('historyUnlinked')} · parentCallId: ${safeText(group.latest.parentCallId, 200) || t('historyUnknown')} · subCallId: ${safeText(group.latest.subCallId, 200) || t('historyUnknown')}`),
          h('span', null, t('historyUnlinked')),
        )),
        state.nextCursor !== null ? h('button', { type: 'button', style: btnStyle, disabled: loading || state.status === 'disposed', onClick: () => source.older() }, t('historyOlder')) : null,
      )
    }
    // conversation.chat.turnTail 卡片（官方消息流追加槽，与 deliverables/plan/schedule 卡并列，
    // 渲染在每轮收尾 assistant 文本之后）。
    // 2026-10-05 用户裁定：审批结果应当在工具调用条目下可见，因此不再只挑「异常」——
    // 每个被审查过的调用都出卡片，优先展示最需要注意的那条（拒绝/失败/人工介入/权限拒绝），
    // 纯放行作为兜底展示。查询失败、服务不可用、读取中、无记录一律不渲染；
    // 错误与健康细节仍只在「审批历史」Tab 内展示。
    // 优先级：数字越小越优先；同优先级按 ledgerSeq 降序取最新。
    const TURN_CARD_RANK = {
      'manual:rejected': 0, 'manual:cancelled': 0, 'manual:unavailable': 0,
      'manual:requested': 1, 'manual:allowed-once': 1,
      'reviewer:deny': 2, 'reviewer:failure': 2, 'downstream:deny': 2, 'downstream:ask': 2,
      'downstream:failure': 2, 'downstream:cancel': 2, 'reviewer:cancel': 3,
      'reviewer:allow': 4, 'downstream:allow': 5,
    }
    // 人工「等待中」不是终态：同一 dispatch 若已有更晚的 manual 结果则不重复显示。
    function turnCardRow(rows) {
      const settled = new Set(rows.filter(row => row.phase === 'manual' && row.outcome !== 'requested')
        .map(row => row.dispatchId))
      const visible = rows.filter(row => !(row.phase === 'manual' && row.outcome === 'requested' && settled.has(row.dispatchId)))
      if (!visible.length) return null
      return [...visible].sort((a, b) => {
        const rank = (TURN_CARD_RANK[`${a.phase}:${a.outcome}`] ?? 6) - (TURN_CARD_RANK[`${b.phase}:${b.outcome}`] ?? 6)
        return rank !== 0 ? rank : b.ledgerSeq - a.ledgerSeq
      })[0]
    }
    function ApprovalTurnCard(props) {
      const { state } = useHistory(props), t = props.t
      if (state.sessionId === null || state.status === 'disposed' || state.error || state.health === null) return null
      // 每个 dispatchId 归为一次「被审查的调用」；一张卡只讲最需要讲的那次调用。
      const byDispatch = new Map()
      for (const row of state.records) {
        if (row.turn !== props.turn) continue
        const key = typeof row.dispatchId === 'string' && row.dispatchId ? row.dispatchId : row.callId
        if (!byDispatch.has(key)) byDispatch.set(key, [])
        byDispatch.get(key).push(row)
      }
      const shown = [...byDispatch.values()].map(turnCardRow).filter(row => row !== null)
      if (!shown.length) return null
      // LOW-2：shown 是 Map 的插入序（账本序），不能直接取 [0]。
      // 主卡片必须是 rank 最高的那次调用，否则会标错「latest」。
      const latest = [...shown].sort((a, b) => {
        const rank = (TURN_CARD_RANK[`${a.phase}:${a.outcome}`] ?? 6) - (TURN_CARD_RANK[`${b.phase}:${b.outcome}`] ?? 6)
        return rank !== 0 ? rank : b.ledgerSeq - a.ledgerSeq
      })[0]
      return h('div', { role: 'status', style: { padding: '4px 8px', overflowWrap: 'anywhere' } },
        `${safeText(latest.toolName, 160)} · ${t('historyPhase_' + latest.phase)}: ${outcomeText(latest, t)} · ${t('historyExecutionNote')}`,
        // MEDIUM-7：授权记忆免问与「用户刚点了放行」在 outcome 上同形，
        // 必须靠 cause 区分，否则用户不知道自己刚授予了一个目录。
        latest.cause === 'granted-directory' ? ` · ${t('historyTurnCardGranted')}` : null,
        shown.length > 1 ? ` · +${shown.length - 1} ${t('historyTurnCardMore')}` : null,
      )
    }

    const name = 'dsh-auto-review-router'
    const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.session']
    function apply(ctx) {
      console.info('[dsh-auto-review-router] client 已加载')
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auto-review-router: dictionaries')
      } catch (error) {
        console.error('[dsh-auto-review-router] locale 注册失败:', error)
      }
      const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] || key
      let mounted = Promise.resolve()
      let disposed = false
      try {
        mounted = ctx.remote.$mount(statusRemote)
        if (typeof ctx.effect === 'function') ctx.effect(async () => await mounted, 'dsh-auto-review-router: mount remotes')
      } catch (error) {
        mounted = Promise.reject(error)
        mounted.catch(() => {})
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { disposed = true }, 'dsh-auto-review-router: dispose client')
      }
      const abortable = (promise, signal) => new Promise((resolve, reject) => {
        let timer
        const cleanup = () => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        const abort = () => { cleanup(); reject(new Error('History read cancelled')) }
        if (signal?.aborted) return abort()
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => { cleanup(); reject(new Error('History read timed out')) }, 20000)
        Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
      })
      const readHistory = async (query, signal) => {
        const request = parseHistoryRequest(query)
        if (disposed || signal?.aborted) throw new Error('Client disposed or read cancelled')
        await abortable(mounted, signal)
        const deadline = Date.now() + 20000
        for (;;) {
          if (disposed || signal?.aborted) throw new Error('Client disposed or read cancelled')
          const service = ctx.get('remote.autoReviewRouter')
          if (service !== undefined) {
            if (typeof service.history !== 'function') throw new Error('Host history is unavailable')
            const value = unwrap(parseHistoryResult(await abortable(service.history(request), signal)), t)
            if (disposed || signal?.aborted) throw new Error('Client disposed or read cancelled')
            return parseHistory(value)
          }
          if (Date.now() > deadline) throw new Error('Host history mount timed out')
          await abortable(new Promise(resolve => setTimeout(resolve, 250)), signal)
        }
      }
      const history = createHistoryStore(readHistory)
      ctx.effect(() => () => history.dispose(), 'dsh-auto-review-router: history sources')
      const call = async (method) => {
        const deadline = Date.now() + 20000
        await mounted
        for (;;) {
          if (disposed) throw new Error('Client 已卸载')
          const service = ctx.get('remote.autoReviewRouter')
          if (service !== undefined) {
            if (typeof service[method] !== 'function') throw new Error(`Host 缺少 ${method}`)
            const result = await service[method]()
            if (disposed) throw new Error('Client disposed')
            if (!result || result.ok !== true) {
              const message = result && result.error ? (result.error.message || String(result.error)) : 'remote 调用失败'
              throw new Error(message)
            }
            return parseStatus(result.value)
          }
          if (Date.now() > deadline) throw new Error('remote.autoReviewRouter 挂载超时（20 秒）：Host 端状态服务未就绪')
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      // 注册字段对齐官方范本（dsh-client-ui-settings-plugins / plugin-inventory）：name/id/order/label/locale/inject。
      // locale: NS 让槽渲染器把 label 绑定到本包字典命名空间并随语言切换刷新。
      const settingsIO = createSettingsIO(ctx.get('remote.settings'), t, () => disposed)
      const loadCatalog = createCatalogIO(ctx.get('remote.session'), () => disposed, t)
      const entry = {
        tabId: 'auto-review-router-tab',
        order: 50,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ call, settings: settingsIO, loadCatalog, t }),
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
        }, RouterPage)
        console.info(`[dsh-auto-review-router] 已注册设置页: slot=${slot} id=${id} order=${entry.order}`)
        return dispose
      })
      // 唯一入口：设置 → 内置插件；不再注册设置侧栏独立页面。
      // settings.plugins.tab 由 dsh-client-ui-settings-plugins 的 section children 声明，
      // 存在性取决于该内置包是否启用。用 ctx.slots.spec()（Slots 服务公开方法，未声明返回 undefined）
      // 打探针日志；注册本身仍走 inject 等待，以兼容该槽晚于本包声明的启动顺序。
      const tabSpec = typeof ctx.slots.spec === 'function' ? ctx.slots.spec('settings.plugins.tab') : undefined
      if (tabSpec !== undefined) {
        console.info('[dsh-auto-review-router] 探针: settings.plugins.tab 已声明，注册内置插件插件页签')
      } else {
        console.warn('[dsh-auto-review-router] 探针: settings.plugins.tab 当前未声明，注册内置插件挂起等待；若重启后始终无「已注册 settings.plugins.tab」日志，说明 dsh-client-ui-settings-plugins 未启用')
      }
      registerInto('settings.plugins.tab', entry.tabId)
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'dsh-guard.approval-history', order: 20,
        label: () => t('historyTitle'), locale: NS, inject: () => ({ history, t }),
      }, HistoryView))
      // 消息流追加槽（官方 list 槽，replaceRisk none）：审批结果只作为卡片出现在对应轮次
      // 收尾文本之后；输入框上方（composer.dock）不再注册任何内容。
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail', id: 'dsh-guard.approval-result', order: 20,
        locale: NS, inject: () => ({ history, t }),
      }, ApprovalTurnCard))
    }

    exports.statusRemote = statusRemote
    exports.parseHistoryRequest = parseHistoryRequest
    exports.parseHistoryRecord = parseHistoryRecord
    exports.parseHistoryResult = parseHistoryResult
    exports.createHistoryStore = createHistoryStore
    exports.groupHistory = groupHistory
    exports.HistoryView = HistoryView
    exports.ApprovalTurnCard = ApprovalTurnCard
    exports.dictionaries = { zh, en }
    exports.validateDraft = validateDraft
    exports.createSettingsIO = createSettingsIO
    exports.createCatalogIO = createCatalogIO
    exports.RouterPage = RouterPage
    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
