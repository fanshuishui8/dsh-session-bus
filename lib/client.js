/**
 * dsh-session-bus — 浏览器半。
 *
 * 两处 UI：
 *  1) 输入框工具行左侧一个**小按钮**（🔗 + 已选/总数）：点它打开/聚焦右侧栏里的面板；
 *  2) 面板体在**右侧栏标签页**里（`sidebar.right.pane.tab`，key = 标签类型 id），
 *     不再遮挡对话；会话按工作区分组、可折叠。
 *
 * 通道（没有自建 RPC）：
 *   允许清单 → props.useProjection('sessionBus')（折叠会话日志里的 /session-bus 命令）
 *   分组 → props.useWorkspaces()；会话行 → props.useSessions()（宿主实时推送）
 *   写入 → props.inputActions.setDraft('/session-bus allow <id…>') + submit()
 *   打开面板 → ctx.get('sidebarRight').openTab(kind)
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
        ungrouped: '未分组',
        running: '正在运行',
        empty: '当前没有其他会话',
        expand: '展开',
        collapse: '折叠',
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
        ungrouped: 'Ungrouped',
        running: 'running',
        empty: 'No other session',
        expand: 'Expand',
        collapse: 'Collapse',
      },
    }

    const CSS = `
.sbus-root { display: inline-flex; align-items: center; }
.sbus-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; line-height: 1; cursor: pointer; white-space: nowrap; }
.sbus-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sbus-btn[data-restricted="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.sbus-panel { display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; padding: 10px 12px;
  height: 100%; overflow: auto; font-size: 13px; }
.sbus-title { font-size: 12px; color: var(--dsw-alias-label-primary); }
.sbus-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
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

    function LinkIcon() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          d: 'M6.5 9.5 9.5 6.5M6 11H4.5A2.5 2.5 0 0 1 4.5 6H6m4-1h1.5a2.5 2.5 0 0 1 0 5H10',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round',
        }))
    }

    /** 输入框那一行的小按钮：只负责打开右侧栏面板。 */
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
      const label = unrestricted ? t.all : String(selectedCount) + '/' + String(total)
      return h('div', { className: 'sbus-root' },
        h('style', { 'data-plugin': 'dsh-session-bus' }, CSS),
        h('button', {
          type: 'button',
          className: 'sbus-btn',
          'data-restricted': unrestricted ? 'false' : 'true',
          title: t.button + ' · ' + t.title,
          'aria-label': t.button,
          onClick: () => { if (typeof props.__openTab === 'function') props.__openTab() },
        }, h(LinkIcon), h('span', null, label)))
    }

    /** 右侧栏标签页里的面板体：分组多选 + 应用。 */
    function Panel(props) {
      const t = props.__t
      const [draft, setDraft] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState({})

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

      const groups = []
      const grouped = new Set()
      const items = workspaces !== undefined && workspaces !== null && Array.isArray(workspaces.items) ? workspaces.items : []
      for (const workspace of items) {
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

      const total = rowsById.size
      const allIds = []
      for (const id of rowsById.keys()) allIds.push(id)

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

      const renderRow = (row) => h('label', { className: 'sbus-row', key: row.id },
        h('input', {
          type: 'checkbox',
          checked: selected.indexOf(row.id) >= 0,
          onChange: () => toggle(row.id),
        }),
        h('span', { className: 'sbus-name', title: row.id }, row.title),
        row.running ? h('span', { className: 'sbus-dot', title: t.running, style: { background: 'var(--dsw-alias-state-warn-primary)' } }) : null,
        h('span', { className: 'sbus-meta' }, relativeTime(row.updatedAt, nowMs)),
      )

      const body = total === 0
        ? h('div', { className: 'sbus-hint' }, t.empty)
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
        body,
        h('div', { className: 'sbus-actions' },
          h('button', { type: 'button', className: 'sbus-mini', onClick: () => setDraft(allIds.slice()) }, t.allowAll),
          h('button', { type: 'button', className: 'sbus-mini', onClick: () => setDraft([]) }, t.clear),
          h('span', { className: 'sbus-spacer' }),
          h('button', { type: 'button', className: 'sbus-mini', onClick: () => setDraft(null) }, t.cancel),
          h('button', { type: 'button', className: 'sbus-mini', 'data-primary': 'true', onClick: apply }, t.apply),
        ))
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

        const openTab = (kind) => {
          const svc = ctx.get('sidebarRight')
          if (svc === undefined || svc === null || typeof svc.openTab !== 'function') return
          try { svc.openTab(kind) } catch (error) { console.error('[session-bus] openTab failed', error) }
        }

        // 右侧栏标签类型 + 标签体/标签标题（会话作用域的 keyed 槽位，key = 类型 id）
        const sidebarRight = ctx.get('sidebarRight')
        if (sidebarRight !== undefined && sidebarRight !== null && typeof sidebarRight.register === 'function') {
          ctx.effect(() => sidebarRight.register({ id: TAB_ID, kind: TAB_KIND }), 'dsh-session-bus: sidebar tab type')
          slots.inject('sidebar.right.pane.tab', () => slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID },
            (props) => h(Panel, Object.assign({}, props, { __t: dict })),
          ))
          slots.inject('sidebar.right.pane.tab.title', () => slots.register(
            { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
            () => h('span', null, dict.button),
          ))
        } else {
          console.error('[session-bus] sidebarRight 服务不可用，右侧栏面板未注册')
        }

        // 输入框那一行的小按钮：打开/聚焦右侧栏面板
        slots.inject(BUTTON_SLOT, () => slots.register(
          { name: BUTTON_SLOT, id: 'session-bus-peers', order: 30, label: () => dict.button },
          (props) => h(OpenButton, Object.assign({}, props, { __t: dict, __openTab: () => openTab(TAB_KIND) })),
        ))
      },
    }
  },
})
