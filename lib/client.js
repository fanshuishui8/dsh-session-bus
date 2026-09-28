/**
 * dsh-session-bus — 浏览器半：输入框左侧的「会话总线」多选面板。
 *
 * 作用：让用户用鼠标**多选**本会话可以通信的对端会话，不用再在对话里打字指定名字。
 *
 * 数据流（没有任何自建 RPC，全部走框架既有通道）：
 *   宿主投影 `sessionBus`（会话日志里的 `/session-bus allow …` 命令折叠而来）
 *     → 定位到本组件的 props.useProjection('sessionBus')，得到当前允许清单；
 *   用户勾选后「应用」→ props.inputActions.setDraft('/session-bus allow <id…>') + submit()
 *     → 宿主命令处理器 → command/run 事件 → 投影更新 → 面板回显。
 *
 * 注意：静态客户端模块只能 require 平台种子里的模块（react / react-dom / @deepseek-ai/cordis /
 * dsh-client-store / ui-slots / ui-primitives / ui-dockkit），没有 host.call 通道；
 * 样式以组件内 <style> 元素渲染（挂载时插入、卸载即移除），只引用 --dsw-alias-* 主题 token。
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
        hint: '多选后点「应用」；未勾选任何会话时不再限制。当前没打开的会话也能先勾上，等它打开后自动生效。命令以 /session-bus 写入会话日志，模型看不到。',
        allowAll: '不限',
        clear: '清空',
        apply: '应用',
        cancel: '取消',
        busy: '忙',
        idle: '空闲',
        noPeers: '当前没有其他打开着的会话',
        cwd: '目录',
      },
      en: {
        button: 'Session bus',
        all: 'any',
        title: 'Which sessions may this session talk to',
        hint: 'Tick targets and Apply. An empty selection removes the restriction. Sessions that are not open yet can be ticked too and take effect once opened. The command lands in the session log as /session-bus; the model never sees it.',
        allowAll: 'Any',
        clear: 'Clear',
        apply: 'Apply',
        cancel: 'Cancel',
        busy: 'busy',
        idle: 'idle',
        noPeers: 'No other session is open right now',
        cwd: 'cwd',
      },
    }

    const CSS = `
.sbus-root { position: relative; display: inline-flex; align-items: center; }
.sbus-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; }
.sbus-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sbus-btn[data-open="true"], .sbus-btn[data-restricted="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.sbus-panel { position: absolute; bottom: calc(100% + 8px); left: 0; width: 340px; max-height: 48vh; overflow: auto;
  box-sizing: border-box; padding: 10px; border-radius: 10px; background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); z-index: 40; }
.sbus-title { font-size: 12px; color: var(--dsw-alias-label-primary); margin-bottom: 4px; }
.sbus-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; line-height: 1.5; }
.sbus-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
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
      const rootRef = React.useRef(null)

      // 会话列表与允许清单都来自框架既有通道
      const sessions = props.useSessions((state) => state)
      const projection = props.useProjection('sessionBus')

      const hosted = projection !== undefined && projection !== null && Array.isArray(projection.ids) ? projection.ids : []
      const unrestricted = hosted.length === 0 || hosted.indexOf('*') >= 0
      const selected = draft === null ? hosted.filter((x) => x !== '*') : draft

      const peers = []
      if (sessions !== undefined && sessions !== null && sessions.byId !== undefined) {
        const ids = Array.isArray(sessions.ids) ? sessions.ids : []
        for (const id of ids) {
          const row = sessions.byId[id]
          if (row === undefined || row === null) continue
          if (id === props.sessionId) continue
          if (row.origin === 'subagent') continue
          // 客户端无法可靠判断「该会话当前是否在本进程里存活」（retainedBy 只反映本页
          // 当前 retain 的会话）。允许清单存的是 token、在每次工具调用时才解析，
          // 所以未打开的会话也可以先勾上，等它打开后自动生效 —— 这里不做任何禁用。
          peers.push({
            id: id,
            title: row.displayTitle === undefined || row.displayTitle === '' ? String(id) : row.displayTitle,
            running: row.running === true,
            cwd: typeof row.cwd === 'string' ? row.cwd : '',
          })
        }
        // 正在跑的排在前面，便于优先挑到「有话要说」的会话
        peers.sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1))
      }

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
        : t.button + ' · ' + String(selected.length) + '/' + String(peers.length)

      const rows = peers.length === 0
        ? h('div', { className: 'sbus-hint' }, t.noPeers)
        : peers.map((peer) => h('label', { className: 'sbus-row', key: peer.id },
          h('input', {
            type: 'checkbox',
            checked: selected.indexOf(peer.id) >= 0,
            onChange: () => toggle(peer.id),
          }),
          h('span', { className: 'sbus-name', title: peer.id }, peer.title),
          peer.cwd === '' ? null : h('span', { className: 'sbus-meta', title: peer.cwd }, peer.cwd.split('/').filter(Boolean).slice(-1)[0] || ''),
          h('span', { className: 'sbus-dot', style: { background: peer.running ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)' } }),
          h('span', { className: 'sbus-meta' }, peer.running ? t.busy : t.idle),
        ))

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
          rows,
          h('div', { className: 'sbus-actions' },
            h('button', { type: 'button', className: 'sbus-mini', onClick: () => setDraft(peers.map((p) => p.id)) }, t.allowAll),
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
              const current = snap !== undefined && snap !== null ? snap.active : undefined
              dict = dictFor(current)
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
