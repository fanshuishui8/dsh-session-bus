/**
 * dsh-session-bus — 浏览器半：输入框左侧的「会话总线」多选面板。
 *
 * 作用：用鼠标**多选**本会话可以通信的会话（不用在对话里打字指定目标）。
 * 会话按**工作区分组、可折叠**，与侧边栏的组织方式一致。
 *
 * 数据流（没有自建 RPC，全部走框架既有通道）：
 *   允许清单 → props.useProjection('sessionBus')（折叠会话日志里的 /session-bus 命令）
 *   分组与工作区 → props.useWorkspaces()（WorkspaceSnapshot.items[].sessionIds）
 *   会话行 → props.useSessions()（宿主实时推送）
 *   勾选后「应用」→ props.inputActions.setDraft('/session-bus allow <id…>') + submit()
 *
 * 注意：静态客户端模块只能 require 平台种子里的模块（react / react-dom / @deepseek-ai/cordis /
 * dsh-client-store / ui-slots / ui-primitives / ui-dockkit）；样式以组件内 <style> 渲染，
 * 只引用 --dsw-alias-* 主题 token；可见文案走客户端 locale 服务。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-bus',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-bus'
    const COMMAND = 'session-bus'
    const SLOT = 'conversation.input.left'

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
.sbus-root { position: relative; display: inline-flex; align-items: center; }
.sbus-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; }
.sbus-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sbus-btn[data-open="true"], .sbus-btn[data-restricted="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.sbus-panel { position: absolute; bottom: calc(100% + 8px); left: 0; width: 360px; max-height: 52vh; overflow: auto;
  box-sizing: border-box; padding: 10px; border-radius: 10px; background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); z-index: 40; }
.sbus-title { font-size: 12px; color: var(--dsw-alias-label-primary); }
.sbus-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); margin: 4px 0 8px; line-height: 1.5; }
.sbus-group { margin-bottom: 2px; }
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
.sbus-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
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

    /** 工作区显示名：标题优先，否则取目录尾名。 */
    function workspaceLabel(workspace) {
      if (typeof workspace.title === 'string' && workspace.title !== '') return workspace.title
      const path = typeof workspace.path === 'string' ? workspace.path : ''
      const parts = path.split('/').filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : path
    }

    function LinkIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          d: 'M6.5 9.5 9.5 6.5M6 11H4.5A2.5 2.5 0 0 1 4.5 6H6m4-1h1.5a2.5 2.5 0 0 1 0 5H10',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round',
        }))
    }

    function Picker(props) {
      const t = props.__t
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState({})
      const rootRef = React.useRef(null)

      const sessions = props.useSessions((state) => state)
      const workspaces = props.useWorkspaces((state) => state)
      const projection = props.useProjection('sessionBus')

      const hosted = projection !== undefined && projection !== null && Array.isArray(projection.ids) ? projection.ids : []
      const unrestricted = hosted.length === 0 || hosted.indexOf('*') >= 0
      const selected = draft === null ? hosted.filter((x) => x !== '*') : draft
      const archived = new Set(Array.isArray(workspaces === undefined || workspaces === null ? undefined : workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : [])
      const nowMs = Date.now()

      // 会话行：排除自己 / subagent / 归档
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

      // 分组：按工作区顺序取它的 sessionIds；没归入任何工作区的进「未分组」
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

      // Escape 关闭 + 点外部关闭
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        const onDown = (event) => {
          const root = rootRef.current
          if (root !== null && root !== undefined && !root.contains(event.target)) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [open])

      const apply = () => {
        const ids = selected.filter((x) => x !== '*')
        props.inputActions.setDraft(ids.length === 0 ? '/' + COMMAND + ' clear' : '/' + COMMAND + ' allow ' + ids.join(' '))
        props.inputActions.submit()
        setDraft(null)
        setOpen(false)
      }

      const toggle = (id) => {
        setDraft((current) => {
          const base = current === null ? hosted.filter((x) => x !== '*') : current
          return base.indexOf(id) >= 0 ? base.filter((x) => x !== id) : base.concat([id])
        })
      }

      const label = unrestricted
        ? t.button + ' · ' + t.all
        : t.button + ' · ' + String(selected.length) + '/' + String(total)

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
          // 默认折叠；有勾选的分组默认展开（用户显式折叠过的以用户为准）
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

      return h('div', { className: 'sbus-root', ref: rootRef },
        h('style', { 'data-plugin': 'dsh-session-bus' }, CSS),
        h('button', {
          type: 'button',
          className: 'sbus-btn',
          'data-open': open ? 'true' : 'false',
          'data-restricted': unrestricted ? 'false' : 'true',
          title: t.title,
          onClick: () => { setDraft(null); setOpen((value) => !value) },
        }, h(LinkIcon), h('span', null, label)),
        open ? h('div', { className: 'sbus-panel', role: 'dialog', 'aria-label': t.title },
          h('div', { className: 'sbus-title' }, t.title),
          h('div', { className: 'sbus-hint' }, t.hint),
          body,
          h('div', { className: 'sbus-actions' },
            h('button', { type: 'button', className: 'sbus-mini', onClick: () => setDraft(allIds.slice()) }, t.allowAll),
            h('button', { type: 'button', className: 'sbus-mini', onClick: () => setDraft([]) }, t.clear),
            h('span', { className: 'sbus-spacer' }),
            h('button', { type: 'button', className: 'sbus-mini', onClick: () => { setDraft(null); setOpen(false) } }, t.cancel),
            h('button', { type: 'button', className: 'sbus-mini', 'data-primary': 'true', onClick: apply }, t.apply),
          )) : null,
      )
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
        slots.inject(SLOT, () => slots.register(
          { name: SLOT, id: 'session-bus-peers', order: 30, label: () => dict.button },
          (props) => h(Picker, Object.assign({}, props, { __t: dict })),
        ))
      },
    }
  },
})
