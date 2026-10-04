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

    function parseStatus(value) {
      if (!value || typeof value !== 'object' || value.plugin !== 'dsh-auto-review-router') {
        throw new Error('Invalid auto-review-router status')
      }
      if (!value.registration || typeof value.registration.registered !== 'boolean') {
        throw new Error('Invalid auto-review-router status.registration')
      }
      if (!value.route || typeof value.route.source !== 'string') throw new Error('Invalid auto-review-router status.route')
      if (!value.budget || typeof value.budget.timeoutMs !== 'number') throw new Error('Invalid auto-review-router status.budget')
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
      ],
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
    }

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
