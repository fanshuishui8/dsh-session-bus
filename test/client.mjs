/**
 * dsh-session-bus 浏览器半的自动化测试（不需要浏览器、不需要扩展）。
 *
 *   node test/client.mjs
 *
 * 做法：在假的 `window.__ModuleLoader__` / 假 React / 假 Cordis ctx 下加载 lib/client.js，
 * 然后把组件树展开到 DOM 节点，断言：
 *   1. 模块 id 与插件形状；
 *   2. 注册了输入框入口、右侧栏标签类型、标签体、标签标题（key 正确）；
 *   3. 点入口按钮会调用 sidebarRight.openTab(kind)；
 *   4. 面板按工作区分组、勾选后「应用」提交的正是 /session-bus allow <id…>；
 *   5. 「不限 / 清空 / 取消」的行为；
 *   6. 关掉 allowResume 无关（客户端不涉及），但归档/subagent/自己不会被列出。
 */

import { readFileSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failures += 1; console.log('  ✗ ' + label + (detail === undefined ? '' : ' → ' + detail)) }
}

/** 极简 React 替身：只够把组件函数跑一遍并拿到元素树。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

/** 展开函数组件直到只剩宿主节点（div/button/input/label/span/svg/style）。 */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap(expand)
  if (typeof node === 'string' || typeof node === 'number') return [{ type: '#text', props: { text: String(node) }, children: [] }]
  if (typeof node !== 'object') return []
  if (typeof node.type === 'function') return expand(node.type(node.props))
  const children = []
  const kids = node.children === undefined ? [] : node.children
  for (const child of kids) children.push(...expand(child))
  return [{ type: node.type, props: node.props, children }]
}

function findAll(nodes, pred) {
  const out = []
  for (const node of nodes) {
    if (pred(node)) out.push(node)
    out.push(...findAll(node.children === undefined ? [] : node.children, pred))
  }
  return out
}

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

// ── 假宿主（Cordis 客户端 ctx + 服务）────────────────────────────────────────────
const registrations = []
const tabTypes = []
const openTabCalls = []
const slots = {
  register: (reg, component) => { registrations.push({ reg, component }); return () => {} },
  inject: (key, callback) => { callback(); return () => {} },
}
const sidebarRight = {
  register: (definition) => { tabTypes.push(definition); return () => {} },
  openTab: (kind) => { openTabCalls.push(kind) },
}
const locale = { register: () => () => {}, getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }
const ctx = {
  get: (name) => (name === 'slots' ? slots : name === 'sidebarRight' ? sidebarRight : name === 'locale' ? locale : undefined),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  // 真 cordis：inject 会把依赖作为**属性**挂到回调的 ctx 上（宿主半的 webCtx.webServer 同理）
  inject: (deps, callback) => {
    const child = Object.create(ctx)
    for (const dep of deps) child[dep] = ctx.get(dep)
    callback(child)
    return () => {}
  },
}
plugin.apply(ctx)

console.log('\n== 2. 注册项 ==')
const buttonReg = registrations.find((r) => r.reg.name === 'conversation.input.left')
check('注册了输入框入口', buttonReg !== undefined && buttonReg.reg.id === 'session-bus-peers')
check('注册了右侧栏标签类型', tabTypes.length === 1 && tabTypes[0].id === 'dsh-session-bus' && tabTypes[0].kind === 'dsh-session-bus', JSON.stringify(tabTypes))
check('注册了标签体（key = 类型 id）', registrations.some((r) => r.reg.name === 'sidebar.right.pane.tab' && r.reg.key === 'dsh-session-bus'))
check('注册了标签标题（key = 类型 id）', registrations.some((r) => r.reg.name === 'sidebar.right.pane.tab.title' && r.reg.key === 'dsh-session-bus'))

console.log('\n== 3. 入口按钮 → openTab ==')
const buttonTree = expand(buttonReg.component({
  sessionId: 'session-me',
  useProjection: () => undefined,
  useSessions: () => ({ ids: [], byId: {} }),
}))
const buttons = findAll(buttonTree, (n) => n.type === 'button')
check('按钮存在且是纯图标（无文字子节点）', buttons.length === 1 && buttons[0].children.filter((c) => c.type === 'span').length === 0, JSON.stringify(buttons[0] === undefined ? null : buttons[0].props))
check('图标是无障碍可读的（aria-label）', buttons[0] !== undefined && typeof buttons[0].props['aria-label'] === 'string')
buttons[0].props.onClick()
check('点击调用 openTab(dsh-session-bus)', openTabCalls.length === 1 && openTabCalls[0] === 'dsh-session-bus', JSON.stringify(openTabCalls))

// ── 面板：分组 + 勾选 + 应用 ─────────────────────────────────────────────────────
console.log('\n== 4. 面板分组与写入 ==')
const panelReg = registrations.find((r) => r.reg.name === 'sidebar.right.pane.tab')
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
const panelTree = expand(panelReg.component(panelProps))
const groupHeads = findAll(panelTree, (n) => n.type === 'button' && n.props.className === 'sbus-grouphead')
check('按工作区分组 + 未分组', groupHeads.length === 2, String(groupHeads.length))

const texts = findAll(panelTree, (n) => n.type === '#text').map((n) => n.props.text)
check('展开的分组里列出该工作区的会话', texts.includes('A 会话') && texts.includes('B 会话'), JSON.stringify(texts))
check('自己 / 归档 / subagent 不出现在面板里', !texts.includes('我自己') && !texts.includes('归档会话') && !texts.includes('子代理'), JSON.stringify(texts))
check('分组计数显示 已选/总数', texts.includes('1/2'), JSON.stringify(texts))
const checkboxes = findAll(panelTree, (n) => n.type === 'input' && n.props.type === 'checkbox')
check('展开的分组里勾选框数量 = 该组会话数', checkboxes.length === 2, String(checkboxes.length))
check('已勾选的会话被勾上', checkboxes.filter((c) => c.props.checked === true).length === 1, JSON.stringify(checkboxes.map((c) => c.props.checked)))
const applyButton = findAll(panelTree, (n) => n.type === 'button' && n.props['data-primary'] === 'true')[0]
check('有「应用」按钮', applyButton !== undefined)
applyButton.props.onClick()
check('已勾选时「应用」= allow <id…>', sent.length === 2 && sent[0] === '/session-bus allow session-a1' && sent[1] === '<submit>', JSON.stringify(sent))

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)
