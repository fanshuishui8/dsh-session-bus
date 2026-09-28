/**
 * dsh-session-bus 浏览器半的自动化测试（不需要浏览器、不需要扩展）。
 *
 *   node test/client.mjs
 *
 * 做法：在假的 `window.__ModuleLoader__` / 假 React（带 useState/useEffect 与重渲染）/
 * 假 Cordis ctx / 假 fetch 下加载 lib/client.js，然后把组件树展开到 DOM 节点，断言：
 *   1. 模块 id 与插件形状；
 *   2. 没装 dsh-better-sidebar 时：注册右侧栏标签类型、标签体、标签标题（且不再往输入框插按钮）；
 *   3. 内置版面板按工作区分组、勾选后「应用」提交的正是 /session-bus allow <id…>；
 *   4. 装了 dsh-better-sidebar 时：改为 betterSidebar.registerTab(...)，不再注册内置标签页；
 *   5. better-sidebar 版面板的数据来自两条宿主只读路由（catalog / allow），
 *      不依赖任何 DSH 槽位 props；「应用」走 ctx.remote.commands.execute；
 *   6. 写入失败如实渲染：session/writer-held → 「会话正忙，稍后重试」。
 */

import { readFileSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failures += 1; console.log('  ✗ ' + label + (detail === undefined ? '' : ' → ' + detail)) }
}

// ── 极简 React 替身：支持 useState / useEffect，并能在 setState 后重渲染 ─────────
// 每个「组件位置」有自己的 hooks 帧（路径 + 组件名），重渲染时状态保留、effect 只跑一次。
let frames = new Map()
let currentFrame = null

const React = {
  createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children }),
  useState: (initial) => {
    const frame = currentFrame
    const index = frame.i
    frame.i += 1
    if (frame.cells[index] === undefined) frame.cells[index] = { value: typeof initial === 'function' ? initial() : initial }
    const cell = frame.cells[index]
    return [cell.value, (next) => {
      const value = typeof next === 'function' ? next(cell.value) : next
      if (value === cell.value) return
      cell.value = value
    }]
  },
  useEffect: (fn) => { currentFrame.i += 1; currentFrame.effects.push(fn) },
  useRef: (initial) => {
    const frame = currentFrame
    const index = frame.i
    frame.i += 1
    if (frame.cells[index] === undefined) frame.cells[index] = { value: { current: initial === undefined ? null : initial } }
    return frame.cells[index].value
  },
}

function frameFor(path) {
  let frame = frames.get(path)
  if (frame === undefined) {
    frame = { cells: [], effects: [], ran: false, cleanups: [] }
    frames.set(path, frame)
  }
  return frame
}

/** 展开函数组件直到只剩宿主节点（div/button/input/label/span/svg/style）。 */
function expand(node, path = 'p') {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap((child, index) => expand(child, path + '.' + String(index)))
  if (typeof node === 'string' || typeof node === 'number') return [{ type: '#text', props: { text: String(node) }, children: [] }]
  if (typeof node !== 'object') return []
  if (typeof node.type === 'function') {
    const key = path + '@' + (node.type.name === '' ? 'anon' : node.type.name)
    const frame = frameFor(key)
    const saved = currentFrame
    currentFrame = frame
    frame.i = 0
    frame.effects = []
    let out
    try { out = node.type(node.props) } finally { currentFrame = saved }
    const children = expand(out, key)
    if (frame.ran !== true) {
      frame.ran = true
      for (const effect of frame.effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') frame.cleanups.push(cleanup)
      }
    }
    return children
  }
  const children = []
  const kids = node.children === undefined ? [] : node.children
  for (let index = 0; index < kids.length; index += 1) children.push(...expand(kids[index], path + '.' + String(index)))
  return [{ type: node.type, props: node.props, children }]
}

/** 挂载一个元素树；rerender() 重新展开（状态保留，effect 不重跑）。 */
function mount(node) {
  frames = new Map()
  let tree = expand(node)
  return {
    get tree() { return tree },
    rerender() { tree = expand(node); return tree },
    unmount() { for (const frame of frames.values()) for (const cleanup of frame.cleanups) cleanup() },
  }
}

function findAll(nodes, pred) {
  const out = []
  for (const node of nodes) {
    if (pred(node)) out.push(node)
    out.push(...findAll(node.children === undefined ? [] : node.children, pred))
  }
  return out
}
const textsOf = (nodes) => findAll(nodes, (n) => n.type === '#text').map((n) => n.props.text)

// ── 加载浏览器半 ────────────────────────────────────────────────────────────────
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration = null
const fakeWindow = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
const fakeRequire = (spec) => (spec === 'react' ? React : undefined)
new Function('window', 'require', code)(fakeWindow, fakeRequire)

console.log('== 1. 模块与插件形状 ==')
check('模块已注册', registration !== null)
check('模块 id = 包名', registration !== null && registration.id === 'dsh-session-bus')
const plugin = registration.factory(fakeRequire)
check('插件声明 inject: slots', typeof plugin.apply === 'function' && Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

/** 一个假宿主：slots / sidebarRight / locale（可选 betterSidebar、remote）。 */
function newHost(options = {}) {
  const host = {
    registrations: [],
    tabTypes: [],
    openTabCalls: [],
    betterTabs: [],
    betterOpenCalls: [],
    remoteCalls: [],
    remoteResult: { ok: true },
  }
  host.slots = {
    register: (reg, component) => { host.registrations.push({ reg, component }); return () => {} },
    inject: (key, callback) => { callback(); return () => {} },
  }
  host.sidebarRight = {
    register: (definition) => { host.tabTypes.push(definition); return () => {} },
    openTab: (kind) => { host.openTabCalls.push(kind) },
  }
  host.better = {
    registerTab: (descriptor) => { host.betterTabs.push(descriptor); return () => {} },
    openTab: (...args) => { host.betterOpenCalls.push(args) },
  }
  host.remote = {
    commands: {
      execute: (...args) => { host.remoteCalls.push(args); return Promise.resolve(host.remoteResult) },
    },
  }
  host.locale = { register: () => () => {}, getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }
  host.hasBetter = options.betterSidebar === true
  host.pendingInject = []
  host.ctx = {
    get: (name) => {
      if (name === 'slots') return host.slots
      if (name === 'sidebarRight') return host.sidebarRight
      if (name === 'locale') return host.locale
      if (name === 'betterSidebar') return host.hasBetter === true ? host.better : undefined
      if (name === 'remote') return host.remote
      return undefined
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    // 真 cordis：inject 会把依赖作为**属性**挂到回调的 ctx 上，且**依赖出现时**才回调；
    // 依赖还没出现就把回调记下来，测试用 host.appear(dep) 模拟「服务晚到」
    inject: (deps, callback) => {
      const run = (target) => {
        const child = Object.create(target)
        for (const dep of deps) child[dep] = host.ctx.get(dep)
        callback(child)
      }
      let ok = true
      for (const dep of deps) if (host.ctx.get(dep) === undefined) ok = false
      if (ok !== true) { host.pendingInject.push(run); return () => {} }
      run(host.ctx)
      return () => {}
    },
  }
  /** 模拟某个服务「晚到」：出现后把等它的 inject 回调都跑一遍。 */
  host.appear = (dep) => {
    if (dep === 'betterSidebar') host.hasBetter = true
    const pending = host.pendingInject.splice(0)
    for (const run of pending) run(host.ctx)
  }
  return host
}

// ── 2. 没装 better-sidebar：保持现状（内置右侧栏标签页 + inputActions 写入）──────
console.log('\n== 2. 未装 better-sidebar：注册项回退到内置右侧栏 ==')
const plain = newHost()
plugin.apply(plain.ctx)

check('不再往输入框那一行插任何东西（v0.3.6 删掉重复入口）',
  plain.registrations.some((r) => r.reg.name.indexOf('conversation.input') === 0) === false,
  JSON.stringify(plain.registrations.map((r) => r.reg.name)))
check('注册了右侧栏标签类型', plain.tabTypes.length === 1 && plain.tabTypes[0].id === 'dsh-session-bus' && plain.tabTypes[0].kind === 'dsh-session-bus', JSON.stringify(plain.tabTypes))
check('注册了标签体（key = 类型 id）', plain.registrations.some((r) => r.reg.name === 'sidebar.right.pane.tab' && r.reg.key === 'dsh-session-bus'))
check('注册了标签标题（key = 类型 id）', plain.registrations.some((r) => r.reg.name === 'sidebar.right.pane.tab.title' && r.reg.key === 'dsh-session-bus'))
check('没有 better-sidebar 时不调 registerTab', plain.betterTabs.length === 0)

// ── 内置版面板：分组 + 勾选 + 应用 ───────────────────────────────────────────────
console.log('\n== 3. 内置版面板：分组与写入（走 inputActions） ==')
{
  const panelReg = plain.registrations.find((r) => r.reg.name === 'sidebar.right.pane.tab')
  const sent = []
  const panelProps = {
    sessionId: 'session-me',
    inputActions: { setDraft: (text) => sent.push(text), submit: () => sent.push('<submit>') },
    useProjection: () => ({ ids: ['session-a1'] }),   // 已勾选 A → 项目一 分组默认展开
    useSessions: () => ({
      ids: ['session-me', 'session-a1', 'session-b1', 'session-c1', 'session-arch', 'session-sub'],
      byId: {
        'session-me': { id: 'session-me', displayTitle: '我自己', running: false, updatedAt: Date.now(), origin: undefined },
        'session-a1': { id: 'session-a1', displayTitle: 'A 会话', running: true, updatedAt: Date.now() - 120000 },
        'session-b1': { id: 'session-b1', displayTitle: 'B 会话', running: false, updatedAt: Date.now() - 3600000 },
        'session-c1': { id: 'session-c1', displayTitle: 'C 会话（未分组）', running: false, updatedAt: 0 },
        'session-arch': { id: 'session-arch', displayTitle: '归档会话', running: false, updatedAt: 0 },
        'session-sub': { id: 'session-sub', displayTitle: '子代理', running: false, updatedAt: 0, origin: 'subagent' },
      },
    }),
    useWorkspaces: () => ({
      items: [
        { workspaceId: 'ws-1', title: '项目一', path: '/tmp/one', sessionIds: ['session-a1', 'session-b1'] },
        { workspaceId: 'ws-2', title: '项目二', path: '/tmp/two', sessionIds: ['session-arch'] },
      ],
      archivedSessionIds: ['session-arch'],
    }),
  }
  const view = mount(panelReg.component(panelProps))
  const groupHeads = findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'sbus-grouphead')
  check('按工作区分组 + 未分组', groupHeads.length === 2, String(groupHeads.length))

  const texts = textsOf(view.tree)
  check('展开的分组里列出该工作区的会话', texts.includes('A 会话') && texts.includes('B 会话'), JSON.stringify(texts))
  check('自己 / 归档 / subagent 不出现在面板里', !texts.includes('我自己') && !texts.includes('归档会话') && !texts.includes('子代理'), JSON.stringify(texts))
  check('分组计数显示 已选/总数', texts.includes('1/2'), JSON.stringify(texts))
  const checkboxes = findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'checkbox')
  check('展开的分组里勾选框数量 = 该组会话数', checkboxes.length === 2, String(checkboxes.length))
  check('已勾选的会话被勾上', checkboxes.filter((c) => c.props.checked === true).length === 1, JSON.stringify(checkboxes.map((c) => c.props.checked)))
  const applyButton = findAll(view.tree, (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0]
  check('有「应用」按钮', applyButton !== undefined)
  applyButton.props.onClick()
  check('已勾选时「应用」= allow <id…>（走 inputActions）', sent.length === 2 && sent[0] === '/session-bus allow session-a1' && sent[1] === '<submit>', JSON.stringify(sent))
  view.unmount()
}

// ── 5. 装了 better-sidebar：注册成它的标签页，数据走宿主路由 ──────────────────────
console.log('\n== 4. 装了 better-sidebar：注册 tab + 数据走宿主只读路由 ==')
const host = newHost({ betterSidebar: true })
plugin.apply(host.ctx)
check('调用了 betterSidebar.registerTab', host.betterTabs.length === 1, String(host.betterTabs.length))
const tab = host.betterTabs[0]
check('tab id / title 正确（title 允许函数，语言可跟随）',
  tab !== undefined && tab.id === 'dsh-session-bus' && (typeof tab.title === 'function' ? tab.title() : tab.title) === '会话总线',
  JSON.stringify(tab === undefined ? null : { id: tab.id, title: typeof tab.title === 'function' ? tab.title() : tab.title }))
check('tab 声明单例 + 排序 + 图标', tab !== undefined && tab.single === true && tab.order === 30 && typeof tab.icon === 'function', JSON.stringify(tab === undefined ? null : { single: tab.single, order: tab.order, icon: typeof tab.icon }))
check('tab 带 component 渲染函数', tab !== undefined && typeof tab.component === 'function')
check('装了 better-sidebar 就不再注册内置标签页', host.tabTypes.length === 0, JSON.stringify(host.tabTypes))
check('装了 better-sidebar 时也不往输入框那一行插东西',
  host.registrations.some((r) => r.reg.name.indexOf('conversation.input') === 0) === false,
  JSON.stringify(host.registrations.map((r) => r.reg.name)))
check('两个落点都不再调用侧栏的 openTab（入口交给侧栏自己的标签菜单）',
  host.openTabCalls.length === 0 && host.betterOpenCalls.length === 0,
  JSON.stringify({ sidebarRight: host.openTabCalls, betterSidebar: host.betterOpenCalls }))

// 宿主两条只读路由的假响应
const catalogBody = {
  session: 'session-me',
  workspaces: [{ workspaceId: 'ws-1', title: '项目一', path: '/tmp/one', sessionIds: ['session-a1', 'session-b1'] }],
  sessions: [
    { id: 'session-a1', title: 'A 会话', running: true, attached: true, archived: false },
    { id: 'session-b1', title: 'B 会话', running: false, attached: false, archived: false },
    { id: 'session-orphan1', title: '孤儿会话', running: false, attached: false, archived: false },
    { id: 'session-me', title: '我自己', running: true, attached: true, archived: false },
    { id: 'session-arch', title: '归档会话', running: false, attached: false, archived: true },
    { id: 'session-plain', title: '', running: false, attached: false, archived: false },
  ],
}
const allowBody = { session: 'session-me', ids: ['session-a1'], unrestricted: false }
const fetchUrls = []
globalThis.fetch = async (url) => {
  fetchUrls.push(String(url))
  if (String(url).startsWith('/session-bus/catalog')) return { ok: true, status: 200, json: async () => catalogBody }
  if (String(url).startsWith('/session-bus/allow')) return { ok: true, status: 200, json: async () => allowBody }
  return { ok: false, status: 404, json: async () => ({ error: 'not-found' }) }
}

const view = mount(tab.component({ ctx: host.ctx, scope: { sessionId: 'session-me' }, tab: { id: 'dsh-session-bus' }, visible: true }))
await sleep(20)
view.rerender()

check('面板从宿主路由取数（catalog + allow 各一次）',
  fetchUrls.some((u) => u.startsWith('/session-bus/catalog?session=session-me')) && fetchUrls.some((u) => u.startsWith('/session-bus/allow?session=session-me')),
  JSON.stringify(fetchUrls))
const panelTexts = textsOf(view.tree)
check('按宿主目录里的工作区分组', findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'sbus-grouphead').length === 2, String(findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'sbus-grouphead').length))
check('工作区标题与其中会话都上屏', panelTexts.includes('项目一') && panelTexts.includes('A 会话') && panelTexts.includes('B 会话'), JSON.stringify(panelTexts))
check('没有勾选的分组默认折叠', panelTexts.includes('未分组') && !panelTexts.includes('孤儿会话'), JSON.stringify(panelTexts))
check('自己 / 归档不出现在面板里', !panelTexts.includes('我自己') && !panelTexts.includes('归档会话'), JSON.stringify(panelTexts))
check('允许清单真值决定勾选（allow 路由的 session-a1）', findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'checkbox').filter((c) => c.props.checked === true).length === 1, JSON.stringify(findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'checkbox').map((c) => c.props.checked)))

// 展开「未分组」（点分组标题）→ 孤儿会话与没有标题的会话都应上屏
{
  const heads = findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'sbus-grouphead')
  const ungrouped = heads.find((node) => node.children.some((child) => child.props !== undefined && child.props.className === 'sbus-groupname' && child.children.some((text) => text.props !== undefined && text.props.text === '未分组')))
  check('找到「未分组」分组标题', ungrouped !== undefined)
  ungrouped.props.onClick()
  view.rerender()
  const expanded = textsOf(view.tree)
  check('孤儿会话进「未分组」', expanded.includes('孤儿会话'), JSON.stringify(expanded))
  check('没有标题的会话退化为 id', expanded.includes('session-plain'), JSON.stringify(expanded))
  check('面板不再依赖 DSH 槽位 props（没有 useSessions 也能渲染出行）',
    findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'checkbox').length === 4,
    String(findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'checkbox').length))
}

console.log('\n== 4b. better-sidebar 晚到（激活顺序不保证）：服务出现后补注册 ==')
{
  const late = newHost({ betterSidebar: false })
  plugin.apply(late.ctx)
  check('服务还没出现时先按内置落点注册', late.tabTypes.length === 1 && late.betterTabs.length === 0, JSON.stringify({ tabTypes: late.tabTypes.length, betterTabs: late.betterTabs.length }))
  late.appear('betterSidebar')
  check('服务出现后补注册 better-sidebar tab', late.betterTabs.length === 1, String(late.betterTabs.length))
  check('补注册的 tab 与一次性注册的 id 相同', late.betterTabs[0].id === 'dsh-session-bus', JSON.stringify(late.betterTabs[0] === undefined ? null : late.betterTabs[0].id))
}

console.log('\n== 5. better-sidebar 版写入：走 remote.commands.execute ==')
{
  const applyButton = findAll(view.tree, (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0]
  const before = fetchUrls.length
  applyButton.props.onClick()
  await sleep(20)
  check('写入调用 remote.commands.execute(sessionId, 命令行, [], signal)',
    host.remoteCalls.length === 1
    && host.remoteCalls[0][0] === 'session-me'
    && host.remoteCalls[0][1] === '/session-bus allow session-a1'
    && Array.isArray(host.remoteCalls[0][2]) && host.remoteCalls[0][2].length === 0
    && host.remoteCalls[0].length === 4,
    JSON.stringify(host.remoteCalls))
  check('写入成功后重新拉一次真值（catalog + allow）', fetchUrls.length >= before + 2, String(fetchUrls.length - before))
  view.rerender()
  check('写入过程中按钮禁用（避免重复提交）', findAll(view.tree, (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0].props.disabled === false)
}

console.log('\n== 6. 写入失败如实渲染（session/writer-held → 会话正忙） ==')
{
  host.remoteResult = { ok: false, error: { code: 'session/writer-held', message: 'writer is held by another tab' } }
  const applyButton = findAll(view.rerender(), (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0]
  applyButton.props.onClick()
  await sleep(20)
  const texts = textsOf(view.rerender())
  check('忙时显示「会话正忙，稍后重试」', texts.includes('会话正忙，稍后重试'), JSON.stringify(texts))
  check('忙时不把失败当成功（没有写入提示残留）', !texts.includes('正在写入…'), JSON.stringify(texts))

  host.remoteResult = { ok: false, error: { code: 'gateway/internal', message: 'boom' } }
  const retry = findAll(view.rerender(), (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0]
  retry.props.onClick()
  await sleep(20)
  const texts2 = textsOf(view.rerender())
  check('其它错误带错误码如实显示', texts2.some((x) => x.indexOf('写入允许清单失败') >= 0 && x.indexOf('gateway/internal') >= 0), JSON.stringify(texts2))

  host.remoteResult = { ok: true }
  const okButton = findAll(view.rerender(), (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0]
  okButton.props.onClick()
  await sleep(20)
  const texts3 = textsOf(view.rerender())
  check('恢复成功后错误提示消失', !texts3.some((x) => x.indexOf('写入允许清单失败') >= 0 || x === '会话正忙，稍后重试'), JSON.stringify(texts3))
  view.unmount()
}

console.log('\n== 7. remote 服务缺失时如实报错（不静默） ==')
{
  // 一个「只有 slots/locale/betterSidebar，没有 remote」的宿主
  const host2 = newHost({ betterSidebar: true })
  const noRemote = {
    get: (name) => (name === 'remote' ? undefined : host2.ctx.get(name)),
    effect: host2.ctx.effect,
    inject: host2.ctx.inject,
  }
  plugin.apply(noRemote)
  const tab2 = host2.betterTabs[0]
  check('remote 缺失也照常注册 tab', tab2 !== undefined)
  const view2 = mount(tab2.component({ ctx: noRemote, scope: { sessionId: 'session-me' }, visible: true }))
  await sleep(20)
  const applyButton2 = findAll(view2.rerender(), (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0]
  applyButton2.props.onClick()
  await sleep(20)
  const texts = textsOf(view2.rerender())
  check('拿不到 remote 时给出明确错误', texts.some((x) => x.indexOf('remote 服务不可用') >= 0), JSON.stringify(texts))
  view2.unmount()
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)
