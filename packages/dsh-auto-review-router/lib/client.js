// dsh-auto-review-router —— 设置页（Client 侧，手写，零构建）
//
// 第一版只读：启用状态、Auto 注册结果、路由判定、预算。不写配置。
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
      guidanceBody: '改配置写在 ~/.dsh/profiles/<profile>/cordis.patch.yml 的 - id: auto-review-router 下。同 id 的 config 是整体替换，字段要写全。启用后侧栏权限选择器会出现 Auto，且不得与官方 auto-review 或 dsh-codex-connect 的 enableAutoReview 同时启用。',
    }
    const en = {
      nav: 'Auto review router',
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
      guidanceBody: 'Write config under - id: auto-review-router in ~/.dsh/profiles/<profile>/cordis.patch.yml. Config for the same id is replaced as a whole; include every field. After enabling, the sidebar permission picker shows Auto. Do not enable it together with official auto-review or dsh-codex-connect enableAutoReview.',
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

    function RouterPage({ call, t }) {
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

      const reg = status ? status.registration : null
      const route = status ? status.route : null
      return h('div', { style: pageStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('h2', { style: { margin: 0, fontSize: 16 } }, t('title')),
          h('button', { type: 'button', disabled: busy, style: btnStyle, onClick: () => load() }, busy ? t('refreshing') : t('refresh')),
        ),
        error ? h('p', { role: 'alert', style: { color: '#dc2626', overflowWrap: 'anywhere' } }, error) : null,
        !status && !error ? h('p', null, busy ? t('loading') : t('empty')) : null,
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
    const inject = ['slots', 'locale', 'remote']
    function apply(ctx) {
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
      const entry = {
        id: 'auto-review-router',
        order: 50,
        label: () => t('nav'),
        inject: () => ({ call, t }),
      }
      const register = (slot) => ctx.slots.inject(slot, () => ctx.slots.register({
        name: slot,
        id: entry.id,
        order: entry.order,
        label: entry.label,
        inject: entry.inject,
      }, RouterPage))
      try {
        register('settings.plugins.tab')
      } catch (error) {
        console.error('[dsh-auto-review-router] settings.plugins.tab 不可用，退回 settings.section:', error)
        try { register('settings.section') } catch (fallback) {
          console.error('[dsh-auto-review-router] 设置页注册失败:', fallback)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
