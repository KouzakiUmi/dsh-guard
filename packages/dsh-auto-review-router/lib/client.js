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
    function createSettingsIO(service, t = key => zh[key] || key) {
      return {
        async read() {
          const result = unwrap(await service.describe(), t)
          if (!result.writable) throw new Error(t('readOnly'))
          const matches = result.namespaces.filter(row => row.ns === 'auto-review-router')
          if (matches.length !== 1) throw new Error(t('noForm'))
          return matches[0]
        },
        async save(form, draft) {
          if (!Number.isInteger(form?.revision)) throw new Error(t('missingRevision'))
          return unwrap(await service.update(form.ns, validateDraft(draft, t), form.revision), t)
        },
      }
    }
    function RouterPage({ call, settings, t }) {
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

      const [form, setForm] = react.useState(null)
      const [draft, setDraft] = react.useState(null)
      const [formError, setFormError] = react.useState('')
      const [saving, setSaving] = react.useState(false)
      const [notice, setNotice] = react.useState('')
      const reloadForm = react.useCallback(async () => {
        setSaving(true)
        setFormError('')
        try {
          const value = await settings.read()
          setForm(value); setDraft({ ...value.value }); setNotice('')
        } catch (error) { setFormError(error.message) }
        finally { setSaving(false) }
      }, [settings])
      react.useEffect(() => { reloadForm() }, [reloadForm])
      const save = async () => {
        setSaving(true); setFormError(''); setNotice('')
        try {
          const value = await settings.save(form, draft)
          setForm(value); setDraft({ ...value.value }); setNotice(t('saved'))
          await load()
        } catch (error) {
          // Never advance the revision or discard edits after a refusal.
          setFormError(error.code === 'settings/conflict' ? `${t('stale')} ${error.message}` : error.message)
        } finally { setSaving(false) }
      }
      const dirty = !!form && JSON.stringify(draft) !== JSON.stringify(form.value)
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
          formError ? h('p', { role: 'alert', style: { color: '#dc2626' } }, formError) : null,
          notice ? h('p', { role: 'status' }, notice) : null,
          draft ? h('form', { onSubmit: (event) => { event.preventDefault(); if (!saving) save() } },
            ...formFields.map(([key, type, min, max]) => h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' } },
              h('span', { style: { minWidth: 185 } }, t('field_' + key)),
              h('input', {
                'aria-label': key, type: type === 'boolean' ? 'checkbox' : type === 'number' ? 'number' : 'text',
                disabled: saving, ...(type === 'boolean' ? { checked: draft[key] === true } : { value: draft[key] ?? '' }),
                ...(type === 'number' ? { min, max, step: key === 'temperature' ? 'any' : 1 } : {}),
                onChange: (event) => setDraft(previous => ({ ...previous, [key]: type === 'boolean' ? event.target.checked : event.target.value })),
              }),
            )),
            h('button', { type: 'submit', disabled: saving || !dirty, style: btnStyle }, saving ? t('saving') : t('save')),
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
    const inject = ['slots', 'locale', 'remote', 'remote.settings']
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
      const settingsIO = createSettingsIO(ctx.get('remote.settings'), t)
      const entry = {
        tabId: 'auto-review-router-tab',
        order: 50,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ call, settings: settingsIO, t }),
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
    exports.RouterPage = RouterPage
    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
