/**
 * dsh-session-bus — 浏览器半。
 *
 * 两处 UI：
 *  1) 输入框工具行左侧一个**小按钮**（🔗 + 状态）：点它打开/聚焦侧栏面板；
 *  2) 面板体，两种落点（同一份渲染，只差取数与写入）：
 *     · **内置右侧栏标签页**（`sidebar.right.pane.tab`，key = 标签类型 id）——
 *       数据走 DSH 槽位 props（useSessions / useWorkspaces / useProjection），
 *       写入走 props.inputActions.setDraft + submit；
 *     · **dsh-better-sidebar 标签页**（`betterSidebar.registerTab`，惰性 ctx.get）——
 *       数据走宿主只读路由 GET /session-bus/catalog 与 /session-bus/allow，
 *       写入走 ctx.get('remote').commands.execute(sessionId, '/session-bus allow <id…>', [])。
 *       这条路过不依赖任何 DSH 槽位 props，所以换宿主 UI 也能用。
 *
 * 通道（没有自建 RPC）：
 *   允许清单（内置版） → props.useProjection('sessionBus')（折叠会话日志里的 /session-bus 命令）
 *   分组（内置版）     → props.useWorkspaces()；会话行 → props.useSessions()（宿主实时推送）
 *   允许清单（外部版） → GET /session-bus/allow（宿主 selectionOf 的真值）
 *   目录（外部版）     → GET /session-bus/catalog（工作区 + 会话 id/标题/running/archived）
 *   写入（外部版）     → ctx.remote.commands.execute(sessionId, 命令行, [], signal)
 *   打开面板           → betterSidebar.openTab（有就顺手用）/ ctx.get('sidebarRight').openTab(kind)
 *
 * 静态客户端模块只能 require 平台种子里的模块；样式以组件内 <style> 渲染，
 * 只引用 --dsw-alias-* 主题 token；可见文案走客户端 locale 服务。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-bus',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-bus'
    const COMMAND = 'session-bus'
    const BUTTON_SLOT = 'conversation.input.left'
    const TAB_ID = 'dsh-session-bus'
    const TAB_KIND = 'dsh-session-bus'
    const CATALOG_PATH = '/session-bus/catalog'
    const ALLOW_PATH = '/session-bus/allow'
    /** 面板打开时的刷新周期（走本地 loopback 只读路由，宿主侧还有 TTL 缓存）。 */
    const POLL_MS = 3000

    const DICTS = {
      zh: {
        button: '会话总线',
        all: '不限',
        title: '本会话可以与哪些会话通信',
        hint: '按工作区分组，点分组标题可折叠。勾选后点「应用」写入允许清单；未勾选任何会话时不再限制。未打开的会话也能勾 —— 投递时插件会按需唤醒它（allowResume 关掉时则等它打开后自动生效）。命令以 /session-bus 写入会话日志，模型看不到。',
        allowAll: '不限',
        clear: '清空',
        apply: '应用',
        cancel: '取消',
        refresh: '刷新',
        ungrouped: '未分组',
        running: '正在运行',
        empty: '当前没有其他会话',
        expand: '展开',
        collapse: '折叠',
        loading: '正在读取会话目录…',
        writing: '正在写入…',
        busy: '会话正忙，稍后重试',
        loadFailed: '读取面板数据失败：',
        writeFailed: '写入允许清单失败：',
        remoteUnavailable: 'remote 服务不可用（这个宿主 UI 里拿不到 ctx.remote）',
        commandFailed: '命令未执行',
      },
      en: {
        button: 'Session bus',
        all: 'any',
        title: 'Which sessions may this session talk to',
        hint: 'Grouped by workspace; click a group title to collapse it. Tick and Apply to write the allowlist; an empty selection removes the restriction. Not-yet-open sessions can be ticked too — the plugin wakes them on delivery (or they take effect once opened, when allowResume is off). The command lands in the session log as /session-bus; the model never sees it.',
        allowAll: 'Any',
        clear: 'Clear',
        apply: 'Apply',
        cancel: 'Cancel',
        refresh: 'Refresh',
        ungrouped: 'Ungrouped',
        running: 'running',
        empty: 'No other session',
        expand: 'Expand',
        collapse: 'Collapse',
        loading: 'Reading session catalog…',
        writing: 'Writing…',
        busy: 'Session is busy, try again later',
        loadFailed: 'Failed to read panel data: ',
        writeFailed: 'Failed to write the allowlist: ',
        remoteUnavailable: 'the remote service is unavailable in this host UI (no ctx.remote)',
        commandFailed: 'command not executed',
      },
    }

    const CSS = `
.sbus-root { display: inline-flex; align-items: center; }
.sbus-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; line-height: 1; cursor: pointer; white-space: nowrap; }
.sbus-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sbus-btn[data-restricted="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.sbus-panel { display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; padding: 10px 12px;
  height: 100%; overflow: auto; font-size: 13px; }
.sbus-title { font-size: 12px; color: var(--dsw-alias-label-primary); }
.sbus-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.sbus-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); line-height: 1.5; }
.sbus-group { margin-top: 2px; }
.sbus-grouphead { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 6px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.sbus-grouphead:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sbus-caret { width: 10px; flex: none; font-size: 10px; opacity: 0.8; }
.sbus-groupname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.sbus-groupcount { flex: none; font-size: 11px; opacity: 0.85; }
.sbus-groupbody { padding: 1px 0 4px 14px; }
.sbus-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; cursor: pointer; }
.sbus-row:hover { background: var(--dsw-alias-bg-layer-2); }
.sbus-name { flex: 1; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbus-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.sbus-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.sbus-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: auto; padding-top: 8px; }
.sbus-mini { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); }
.sbus-mini:hover { background: var(--dsw-alias-bg-layer-2); }
.sbus-mini[data-primary="true"] { background: var(--dsw-alias-brand-primary); color: #fff; border-color: transparent; }
.sbus-mini:disabled { opacity: 0.5; cursor: default; }
.sbus-spacer { flex: 1; }
`

    function dictFor(localeId) {
      const id = String(localeId === undefined || localeId === null ? '' : localeId).toLowerCase()
      return id.startsWith('zh') ? DICTS.zh : DICTS.en
    }

    /** 相对时间，与侧边栏一致的口径。 */
    function relativeTime(then, nowMs) {
      const t = typeof then === 'number' && isFinite(then) ? then : 0
      if (t <= 0) return ''
      const seconds = Math.max(0, Math.round((nowMs - t) / 1000))
      if (seconds < 60) return '刚刚'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + ' 小时'
      return Math.round(hours / 24) + ' 天'
    }

    function workspaceLabel(workspace) {
      if (typeof workspace.title === 'string' && workspace.title !== '') return workspace.title
      const path = typeof workspace.path === 'string' ? workspace.path : ''
      const parts = path.split('/').filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : path
    }

    /** 会话行 + 工作区 → 分组（分页数据来自槽位 props 还是宿主路由，都用这一份）。 */
    function buildGroups(rowsById, workspaceItems, t) {
      const groups = []
      const grouped = new Set()
      for (const workspace of workspaceItems) {
        if (workspace === undefined || workspace === null) continue
        const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        const rows = []
        for (const id of ids) {
          const row = rowsById.get(id)
          if (row === undefined) continue
          grouped.add(id)
          rows.push(row)
        }
        if (rows.length > 0) groups.push({ key: String(workspace.workspaceId), label: workspaceLabel(workspace), rows: rows })
      }
      const orphans = []
      for (const entry of rowsById) if (grouped.has(entry[0]) === false) orphans.push(entry[1])
      if (orphans.length > 0) groups.push({ key: '__ungrouped__', label: t.ungrouped, rows: orphans })
      const allIds = []
      for (const id of rowsById.keys()) allIds.push(id)
      return { groups: groups, total: rowsById.size, allIds: allIds }
    }

    function LinkIcon() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          d: 'M6.5 9.5 9.5 6.5M6 11H4.5A2.5 2.5 0 0 1 4.5 6H6m4-1h1.5a2.5 2.5 0 0 1 0 5H10',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round',
        }))
    }

    /** 输入框那一行的小按钮：只负责打开侧栏面板。 */
    function OpenButton(props) {
      const t = props.__t
      const projection = props.useProjection('sessionBus')
      const sessions = props.useSessions((state) => state)
      const hosted = projection !== undefined && projection !== null && Array.isArray(projection.ids) ? projection.ids : []
      const unrestricted = hosted.length === 0 || hosted.indexOf('*') >= 0
      const selectedCount = unrestricted ? 0 : hosted.filter((x) => x !== '*').length
      let total = 0
      if (sessions !== undefined && sessions !== null && sessions.byId !== undefined) {
        const ids = Array.isArray(sessions.ids) ? sessions.ids : []
        for (const id of ids) {
          const row = sessions.byId[id]
          if (row === undefined || row === null) continue
          if (id === props.sessionId || row.origin === 'subagent') continue
          total += 1
        }
      }
      // 按钮只留图标：状态与计数放进 tooltip，受限时用品牌色边框提示
      const state = unrestricted ? t.all : String(selectedCount) + '/' + String(total)
      const tip = t.button + ' · ' + state + '\n' + t.title
      return h('div', { className: 'sbus-root' },
        h('style', { 'data-plugin': 'dsh-session-bus' }, CSS),
        h('button', {
          type: 'button',
          className: 'sbus-btn',
          'data-restricted': unrestricted ? 'false' : 'true',
          title: tip,
          'aria-label': t.button + ' ' + state,
          onClick: () => { if (typeof props.__openPanel === 'function') props.__openPanel() },
        }, h(LinkIcon)))
    }

    /**
     * 面板视图：两种数据来源共用的渲染（分组多选 + 应用）。
     * 取数与写入都在外层组件里做，这里只画。
     */
    function PanelView(view) {
      const t = view.t
      const [collapsed, setCollapsed] = React.useState({})
      const selected = Array.isArray(view.selected) ? view.selected : []
      const groups = Array.isArray(view.groups) ? view.groups : []
      const total = typeof view.total === 'number' ? view.total : 0
      const allIds = Array.isArray(view.allIds) ? view.allIds : []
      const busy = view.busy === true
      const nowMs = typeof view.nowMs === 'number' ? view.nowMs : 0

      const renderRow = (row) => h('label', { className: 'sbus-row', key: row.id },
        h('input', {
          type: 'checkbox',
          checked: selected.indexOf(row.id) >= 0,
          disabled: busy,
          onChange: () => view.onToggle(row.id),
        }),
        h('span', { className: 'sbus-name', title: row.id }, row.title),
        row.running ? h('span', { className: 'sbus-dot', title: t.running, style: { background: 'var(--dsw-alias-state-warn-primary)' } }) : null,
        h('span', { className: 'sbus-meta' }, relativeTime(row.updatedAt, nowMs)),
      )

      const body = total === 0
        ? h('div', { className: 'sbus-hint' }, view.loading === true ? t.loading : t.empty)
        : groups.map((group) => {
          let picked = 0
          for (const row of group.rows) if (selected.indexOf(row.id) >= 0) picked += 1
          const isCollapsed = collapsed[group.key] !== undefined ? collapsed[group.key] === true : picked === 0
          return h('div', { className: 'sbus-group', key: group.key },
            h('button', {
              type: 'button',
              className: 'sbus-grouphead',
              'aria-expanded': isCollapsed ? 'false' : 'true',
              title: isCollapsed ? t.expand : t.collapse,
              onClick: () => setCollapsed((current) => {
                const next = Object.assign({}, current)
                next[group.key] = isCollapsed !== true
                return next
              }),
            },
              h('span', { className: 'sbus-caret' }, isCollapsed ? '▸' : '▾'),
              h('span', { className: 'sbus-groupname' }, group.label),
              h('span', { className: 'sbus-groupcount' }, picked > 0 ? String(picked) + '/' + String(group.rows.length) : String(group.rows.length)),
            ),
            isCollapsed ? null : h('div', { className: 'sbus-groupbody' }, group.rows.map(renderRow)),
          )
        })

      return h('div', { className: 'sbus-panel' },
        h('style', { 'data-plugin': 'dsh-session-bus' }, CSS),
        h('div', { className: 'sbus-title' }, t.title),
        h('div', { className: 'sbus-hint' }, t.hint),
        busy ? h('div', { className: 'sbus-hint' }, t.writing) : null,
        view.error !== undefined && view.error !== '' ? h('div', { className: 'sbus-error' }, view.error) : null,
        body,
        h('div', { className: 'sbus-actions' },
          h('button', { type: 'button', className: 'sbus-mini', disabled: busy, onClick: () => view.onAllowAll() }, t.allowAll),
          h('button', { type: 'button', className: 'sbus-mini', disabled: busy, onClick: () => view.onClear() }, t.clear),
          h('span', { className: 'sbus-spacer' }),
          typeof view.onRefresh === 'function'
            ? h('button', { type: 'button', className: 'sbus-mini', disabled: busy, onClick: () => view.onRefresh() }, t.refresh)
            : null,
          h('button', { type: 'button', className: 'sbus-mini', disabled: busy, onClick: () => view.onCancel() }, t.cancel),
          h('button', { type: 'button', className: 'sbus-mini', 'data-primary': 'true', disabled: busy, onClick: () => view.onApply() }, t.apply),
        ))
    }

    /**
     * 面板（内置右侧栏标签页版）：数据来自 DSH 槽位 props，写入走 inputActions。
     * 需要 props.useSessions / useWorkspaces / useProjection / inputActions —— 只有 DSH 内置槽位会给。
     */
    function Panel(props) {
      const t = props.__t
      const [draft, setDraft] = React.useState(null)

      const sessions = props.useSessions((state) => state)
      const workspaces = props.useWorkspaces((state) => state)
      const projection = props.useProjection('sessionBus')

      const hosted = projection !== undefined && projection !== null && Array.isArray(projection.ids) ? projection.ids : []
      const unrestricted = hosted.length === 0 || hosted.indexOf('*') >= 0
      const selected = draft === null ? hosted.filter((x) => x !== '*') : draft
      const archived = new Set(Array.isArray(workspaces === undefined || workspaces === null ? undefined : workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : [])
      const nowMs = Date.now()

      const rowsById = new Map()
      if (sessions !== undefined && sessions !== null && sessions.byId !== undefined) {
        const ids = Array.isArray(sessions.ids) ? sessions.ids : []
        for (const id of ids) {
          const row = sessions.byId[id]
          if (row === undefined || row === null) continue
          if (id === props.sessionId) continue
          if (row.origin === 'subagent') continue
          if (archived.has(id)) continue
          rowsById.set(id, {
            id: id,
            title: row.displayTitle === undefined || row.displayTitle === '' ? String(id) : row.displayTitle,
            running: row.running === true,
            updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
          })
        }
      }

      const items = workspaces !== undefined && workspaces !== null && Array.isArray(workspaces.items) ? workspaces.items : []
      const { groups, total, allIds } = buildGroups(rowsById, items, t)

      const apply = () => {
        const ids = selected.filter((x) => x !== '*')
        props.inputActions.setDraft(ids.length === 0 ? '/' + COMMAND + ' clear' : '/' + COMMAND + ' allow ' + ids.join(' '))
        props.inputActions.submit()
        setDraft(null)
      }

      const toggle = (id) => {
        setDraft((current) => {
          const base = current === null ? hosted.filter((x) => x !== '*') : current
          return base.indexOf(id) >= 0 ? base.filter((x) => x !== id) : base.concat([id])
        })
      }

      return h(PanelView, {
        t: t,
        groups: groups,
        total: total,
        allIds: allIds,
        selected: selected,
        busy: false,
        error: '',
        nowMs: nowMs,
        onToggle: toggle,
        onAllowAll: () => setDraft(allIds.slice()),
        onClear: () => setDraft([]),
        onCancel: () => setDraft(null),
        onApply: apply,
      })
    }

    /**
     * 面板（宿主路由版，给 dsh-better-sidebar 这类外部宿主 UI 用）：
     * 数据自己 fetch /session-bus/catalog + /session-bus/allow，写入走 ctx.remote.commands.execute。
     * **不依赖任何 DSH 槽位 props** —— 只用到传进来的 ctx（惰性取 remote）与 scope.sessionId。
     */
    function HostPanel(props) {
      const t = props.__t
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [data, setData] = React.useState({ phase: 'loading', workspaces: [], sessions: [], allowIds: [], unrestricted: true, error: '' })
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [writeError, setWriteError] = React.useState('')
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        let cancelled = false
        const load = () => {
          Promise.resolve(props.__load(sessionId)).then(
            (next) => { if (cancelled !== true) setData(next) },
            (error) => {
              if (cancelled === true) return
              setData({ phase: 'error', workspaces: [], sessions: [], allowIds: [], unrestricted: true, error: String(error !== undefined && error.message !== undefined ? error.message : error) })
            },
          )
        }
        load()
        // 面板开着就定时刷新（宿主路由在本地 loopback 上，宿主侧还有 TTL 缓存）；
        // visible === false（标签页没在前台）时不轮询
        const timer = props.visible === false ? undefined : setInterval(load, POLL_MS)
        return () => {
          cancelled = true
          if (timer !== undefined) clearInterval(timer)
        }
      }, [sessionId, tick])

      const rowsById = new Map()
      const rows = Array.isArray(data.sessions) ? data.sessions : []
      for (const row of rows) {
        if (row === undefined || row === null) continue
        if (row.id === sessionId || row.archived === true) continue
        rowsById.set(row.id, {
          id: row.id,
          title: row.title === undefined || row.title === '' ? String(row.id) : row.title,
          running: row.running === true,
          updatedAt: 0,   // 宿主路由只给目录，不给「最后活动时间」——宁可不显示，也不显示错的
        })
      }
      const workspaceItems = Array.isArray(data.workspaces) ? data.workspaces : []
      const { groups, total, allIds } = buildGroups(rowsById, workspaceItems, t)

      const hosted = Array.isArray(data.allowIds) ? data.allowIds : []
      const selected = draft === null ? (data.unrestricted === true ? [] : hosted.slice()) : draft

      const toggle = (id) => {
        setDraft((current) => {
          const base = current === null ? (data.unrestricted === true ? [] : hosted.slice()) : current
          return base.indexOf(id) >= 0 ? base.filter((x) => x !== id) : base.concat([id])
        })
      }

      const apply = () => {
        if (busy === true) return
        const ids = selected.filter((x) => x !== '*')
        const line = ids.length === 0 ? '/' + COMMAND + ' clear' : '/' + COMMAND + ' allow ' + ids.join(' ')
        setBusy(true)
        setWriteError('')
        Promise.resolve(props.__write(sessionId, line)).then((result) => {
          if (result === undefined || result === null || result.ok !== true) {
            // 如实渲染失败：会话正忙（session/writer-held）单独给一句人话，其余带错误码
            const code = result !== undefined && result !== null && typeof result.code === 'string' ? result.code : ''
            const message = result !== undefined && result !== null && typeof result.message === 'string' ? result.message : ''
            setWriteError(code === 'session/writer-held' ? t.busy : t.writeFailed + (code === '' ? '' : '(' + code + ') ') + message)
            setBusy(false)
            return
          }
          setDraft(null)
          Promise.resolve(props.__load(sessionId)).then((next) => { setData(next); setBusy(false) }, () => setBusy(false))
        }, (error) => {
          setWriteError(t.writeFailed + String(error !== undefined && error.message !== undefined ? error.message : error))
          setBusy(false)
        })
      }

      const error = writeError !== ''
        ? writeError
        : (data.phase === 'error' && data.error !== '' ? t.loadFailed + data.error : '')

      return h(PanelView, {
        t: t,
        groups: groups,
        total: total,
        allIds: allIds,
        selected: selected,
        busy: busy,
        error: error,
        loading: data.phase === 'loading',
        nowMs: 0,
        onToggle: toggle,
        onAllowAll: () => setDraft(allIds.slice()),
        onClear: () => setDraft([]),
        onCancel: () => setDraft(null),
        onApply: apply,
        onRefresh: () => setTick((n) => n + 1),
      })
    }

    /** 取一条宿主只读路由的 JSON；失败不抛，交给面板如实渲染。 */
    async function fetchJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      let payload
      try { payload = await response.json() } catch (error) { payload = undefined }
      if (response.ok !== true) {
        const code = payload !== undefined && payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status)
        return { ok: false, error: code }
      }
      if (payload === undefined || payload === null) return { ok: false, error: 'not-json' }
      return { ok: true, value: payload }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        let dict = DICTS.en
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          for (const id of Object.keys(DICTS)) {
            try { ctx.effect(() => locale.register(NS, id, DICTS[id])) } catch (error) { console.error('[session-bus] locale register failed', error) }
          }
          const readDict = () => {
            try {
              const snap = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
              // LocaleSnapshot 的当前语言字段是 active（不是 locale/id）
              dict = dictFor(snap === undefined || snap === null ? undefined : snap.active)
            } catch (error) { /* 保持默认英文 */ }
          }
          readDict()
          if (typeof locale.subscribe === 'function') ctx.effect(() => locale.subscribe(readDict))
        } else {
          dict = DICTS.zh
        }

        const slots = ctx.get('slots')
        if (slots === undefined || slots === null) {
          console.error('[session-bus] slots 服务不可用，面板未注册')
          return
        }

        // ── 宿主路由版的数据通道（给 better-sidebar 那类外部宿主 UI 用）──────────────
        // 读：两条只读路由；写：/session-bus allow … 命令（remote.commands.execute）。
        // 一律**惰性**取服务，且不缓存 —— 面板可能比服务先存在。
        const loadFromHost = async (sessionId) => {
          const query = sessionId === '' ? '' : '?session=' + encodeURIComponent(sessionId)
          const [catalog, allow] = await Promise.all([fetchJson(CATALOG_PATH + query), fetchJson(ALLOW_PATH + query)])
          if (catalog.ok !== true) {
            return { phase: 'error', workspaces: [], sessions: [], allowIds: [], unrestricted: true, error: String(catalog.error) }
          }
          const value = catalog.value
          const allowValue = allow.ok === true ? allow.value : undefined
          const unrestricted = allowValue === undefined ? true : allowValue.unrestricted === true
          const allowIds = allowValue !== undefined && Array.isArray(allowValue.ids) ? allowValue.ids : []
          if (allow.ok !== true) {
            return {
              phase: 'error',
              workspaces: Array.isArray(value.workspaces) ? value.workspaces : [],
              sessions: Array.isArray(value.sessions) ? value.sessions : [],
              allowIds: allowIds,
              unrestricted: unrestricted,
              error: String(allow.error),
            }
          }
          return {
            phase: 'ready',
            workspaces: Array.isArray(value.workspaces) ? value.workspaces : [],
            sessions: Array.isArray(value.sessions) ? value.sessions : [],
            allowIds: allowIds,
            unrestricted: unrestricted,
            error: '',
          }
        }

        const writeViaRemote = async (sessionId, line, signal) => {
          const remote = ctx.get('remote')
          if (remote === undefined || remote === null || remote.commands === undefined || remote.commands === null
            || typeof remote.commands.execute !== 'function') {
            return { ok: false, code: 'client/remote-unavailable', message: dict.remoteUnavailable }
          }
          try {
            // DSH 自己的调用点都传「session id + 整行命令 + 附件」三个业务参数（可选第 4 个 AbortSignal），
            // 见 dsh-client-ui-commands 与 dsh-api-session-controller 的浏览器半；这里照抄同一种形态。
            const result = await remote.commands.execute(sessionId, line, [], signal)
            if (result === undefined || result === null || result.ok !== true) {
              const error = result !== undefined && result !== null ? result.error : undefined
              return {
                ok: false,
                code: error !== undefined && error !== null && error.code !== undefined ? String(error.code) : 'client/command-failed',
                message: error !== undefined && error !== null && error.message !== undefined ? String(error.message) : dict.commandFailed,
              }
            }
            return { ok: true, code: '', message: '' }
          } catch (error) {
            return { ok: false, code: 'client/command-threw', message: String(error !== undefined && error.message !== undefined ? error.message : error) }
          }
        }

        // 打开面板：优先外部侧栏（betterSidebar 若提供 openTab 就顺手用；它没有这个 API 也无所谓，
        // 用户点它自己的标签即可），否则退回 DSH 内置右侧栏。
        const openPanel = () => {
          const better = ctx.get('betterSidebar')
          if (better !== undefined && better !== null && typeof better.openTab === 'function') {
            try { better.openTab(TAB_ID); return } catch (error) { console.error('[session-bus] betterSidebar.openTab failed', error) }
          }
          const svc = ctx.get('sidebarRight')
          if (svc === undefined || svc === null || typeof svc.openTab !== 'function') {
            console.error('[session-bus] 没有可用的侧栏服务（sidebarRight / betterSidebar），无法打开面板')
            return
          }
          try { svc.openTab(TAB_KIND) } catch (error) { console.error('[session-bus] openTab failed', error) }
        }

        // ── 落点一：dsh-better-sidebar（装了就用它）──────────────────────────────
        // 惰性 ctx.get('betterSidebar')，不缓存；TabDescriptor 契约：
        // { id, title, description?, icon?, order?, hidden?, available?, dedupeKey?, single?, createTab?, component? }
        const registerBetterSidebar = () => {
          const better = ctx.get('betterSidebar')
          if (better === undefined || better === null || typeof better.registerTab !== 'function') return false
          ctx.effect(() => {
            const disposer = better.registerTab({
              id: TAB_ID,
              title: dict.button,
              order: 30,
              component: (tabProps) => {
                const scope = tabProps === undefined || tabProps === null ? undefined : tabProps.scope
                const sessionId = scope !== undefined && scope !== null && typeof scope.sessionId === 'string' ? scope.sessionId : ''
                return h(HostPanel, {
                  __t: dict,
                  sessionId: sessionId,
                  visible: tabProps === undefined || tabProps === null ? true : tabProps.visible,
                  __load: loadFromHost,
                  __write: writeViaRemote,
                })
              },
            })
            return typeof disposer === 'function' ? disposer : undefined
          }, 'dsh-session-bus: better-sidebar tab')
          console.log('[session-bus] 已注册 better-sidebar 标签：' + TAB_ID)
          return true
        }

        // ── 落点二：DSH 内置右侧栏标签页（没装 better-sidebar 时的现状实现）────────
        const registerBuiltInSidebar = () => {
          // 右侧栏标签类型 + 标签体/标签标题：等服务出现再注册（ctx.inject 会在它出现时回调；
          // 本插件的 apply 可能早于 dsh-client-ui-sidebar-right 激活，一次性 ctx.get 会拿到 undefined）
          ctx.inject(['sidebarRight'], (rightCtx) => {
            const service = rightCtx.sidebarRight
            if (service === undefined || service === null || typeof service.register !== 'function') {
              console.error('[session-bus] sidebarRight 服务缺少 register，右侧栏面板未注册')
              return
            }
            rightCtx.effect(() => service.register({ id: TAB_ID, kind: TAB_KIND }), 'dsh-session-bus: sidebar tab type')
            slots.inject('sidebar.right.pane.tab', () => slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID },
              (props) => h(Panel, Object.assign({}, props, { __t: dict })),
            ))
            slots.inject('sidebar.right.pane.tab.title', () => slots.register(
              { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
              () => h('span', null, dict.button),
            ))
            console.log('[session-bus] 右侧栏标签已注册：' + TAB_KIND)
          })
        }

        if (registerBetterSidebar() !== true) {
          // 服务晚到（插件激活顺序不保证）时再试一次；那时内置落点已注册，两个 UI 都能用
          ctx.inject(['betterSidebar'], () => { registerBetterSidebar() })
          registerBuiltInSidebar()
        }

        // 输入框那一行的小按钮：打开/聚焦面板
        slots.inject(BUTTON_SLOT, () => slots.register(
          { name: BUTTON_SLOT, id: 'session-bus-peers', order: 30, label: () => dict.button },
          (props) => h(OpenButton, Object.assign({}, props, { __t: dict, __openPanel: () => openPanel() })),
        ))
      },
    }
  },
})
