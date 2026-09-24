/**
 * dsh-session-bus 冒烟测试（零依赖，纯 Node）
 *
 *   node test/smoke.mjs
 *
 * 用一个假宿主（假 ctx / agents / sessionTitle / tools / timer）把宿主半挂起来，验证：
 *   1. apply() 注册了 7 个工具，且每个工具定义形状正确、schema 落在 dsh-tools 支持的
 *      JSON Schema 子集内（这是安装后最容易踩的加载期失败点）；
 *   2. 投递：peer_ask 的消息确实进了对端 inbox，信封里带 corr 与本地时间；
 *   3. 显式答复：peer_reply 立刻 resolve 调用方的 peer_ask；
 *   4. 兜底捕获：对端不调 peer_reply 时，靠 session/event 的 turn/end 自动取该轮最终文本；
 *   5. 忙闲自适应：对端 running 时按 busyWaitMs 短等待后返回 timeout；
 *   6. 目标不存在的报错、按会话对限速、撤回（含撤回仍在等待中的提问）；
 *   7. peer_inbox 的 thread 视图与本地时间。
 *
 * 每个用例用独立宿主，避免共享限速窗口互相干扰。
 */

import { apply, name, inject } from '../lib/index.js'

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label) }
  else { failures += 1; console.log('  ✗ ' + label + (detail === undefined ? '' : ' → ' + detail)) }
}

/** 递归校验 schema 只用受支持的子集（与 dsh-tools 的 checkSchemaNode 对齐）。 */
function checkSchemaSubset(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(path + ' 必须是 schema 对象')
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) violations.push(path + '.' + key + ' 不是受支持的关键字')
  }
  if (Object.hasOwn(node, 'type') && Object.hasOwn(node, 'oneOf')) violations.push(path + ' 不能同时声明 type 与 oneOf')
  if (Object.hasOwn(node, 'type') && !SCHEMA_TYPES.has(node.type)) violations.push(path + '.type 非法: ' + String(node.type))
  if (Object.hasOwn(node, 'properties')) {
    if (node.properties === null || typeof node.properties !== 'object') violations.push(path + '.properties 必须是对象')
    else for (const [k, v] of Object.entries(node.properties)) checkSchemaSubset(v, path + '.properties.' + k, violations)
  }
  if (Object.hasOwn(node, 'items')) checkSchemaSubset(node.items, path + '.items', violations)
  if (Object.hasOwn(node, 'oneOf')) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(path + '.oneOf 至少两个 schema')
    else node.oneOf.forEach((v, i) => checkSchemaSubset(v, path + '.oneOf[' + i + ']', violations))
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required)) violations.push(path + '.required 必须是数组')
    else if (Object.hasOwn(node, 'properties')) {
      for (const r of node.required) if (!Object.hasOwn(node.properties, r)) violations.push(path + '.required 含未声明属性 ' + r)
    }
  }
}

/** 起一个假宿主 + 两个会话（A 是调用方，B 是对端）。 */
function newFleet(config = {}) {
  const tools = new Map()
  const listeners = new Map()
  const agents = new Map()
  let seq = 0

  const registry = {
    get: (id) => agents.get(String(id)),
    list: () => [...agents.values()],
    roots: () => [...agents.values()],
  }

  const ctx = {
    get(service) {
      if (service === 'tools') return { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } }
      if (service === 'agents') return registry
      if (service === 'sessionTitle') return { get: (session) => ({ title: session.__title }) }
      return undefined
    },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event) },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout(fn, ms) { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
  }

  function addAgent(id, title, status = 'idle') {
    const agent = {
      id, status,
      session: { id, header: { createdAt: Date.now(), cwd: '/tmp' }, __title: title },
      inbox: [], injected: [],
      followup(msg) { agent.inbox.push(msg) },
      steer(msg) { agent.inbox.push(msg) },
      inject(msg) { agent.injected.push(msg) },
    }
    agents.set(id, agent)
    return agent
  }

  function emit(type, sessionId, data) {
    const fn = listeners.get('session/event')
    if (fn === undefined) throw new Error('插件没有注册 session/event 监听器')
    seq += 1
    fn({ id: sessionId }, { type, seq, time: Date.now(), data })
  }

  apply(ctx, Object.assign({ self: 'test', defaultAskMs: 60000, busyWaitMs: 5000 }, config))
  const A = addAgent('session-aaaa', '会话A')
  const B = addAgent('session-bbbb', '会话B')
  return { ctx, tools, emit, A, B, agents }
}

function corrOf(agent, index = -1) {
  const msg = index < 0 ? agent.inbox[agent.inbox.length + index] : agent.inbox[index]
  const m = /corr: ([a-z0-9]+)/.exec(msg.content[0].text)
  return m === null ? '' : m[1]
}
/** 模拟对端把这条消息当成一轮处理完（不调 peer_reply）。 */
function finishTurn(host, agentId, msgId, turn, text) {
  host.emit('turn/start', agentId, { turn })
  host.emit('user/message', agentId, { id: msgId, role: 'user', content: [{ type: 'text', text: '信封' }], source: { kind: 'user' } })
  host.emit('assistant/message', agentId, { turn, step: 1, message: { id: 'm-' + turn, role: 'assistant', content: [{ type: 'text', text }] } })
  host.emit('turn/end', agentId, { turn, reason: { kind: 'completed' } })
}

console.log('\n== 1. 导出与工具注册 ==')
check('name 导出正确', name === 'dsh-session-bus', String(name))
// inject 是硬依赖声明：静态插件若不声明 tools/agents，启动竞态下 ctx.get() 会拿到 undefined，
// 工具会静默注册失败（动态插件因沙箱强制声明 inject，看不到这个坑）
for (const svc of ['timer', 'tools', 'agents']) {
  check('inject 声明 ' + svc, Array.isArray(inject) && inject.includes(svc), JSON.stringify(inject))
}

const EXPECTED = ['peer_self', 'peer_list', 'peer_send', 'peer_ask', 'peer_reply', 'peer_cancel', 'peer_inbox']
{
  const { tools } = newFleet()
  check('注册了 7 个工具', tools.size === EXPECTED.length, '实际 ' + tools.size)
  for (const tn of EXPECTED) check('工具存在: ' + tn, tools.has(tn))
}

console.log('\n== 2. 工具定义形状与 schema 子集 ==')
{
  const { tools } = newFleet()
  for (const [tn, def] of tools) {
    const violations = []
    check(tn + ' 有 description', typeof def.description === 'string' && def.description.length > 10)
    check(tn + ' parameters 是 object schema', def.parameters && def.parameters.type === 'object', JSON.stringify(def.parameters))
    check(tn + ' output.render 是函数', typeof def.output.render === 'function')
    checkSchemaSubset(def.output.schema, tn + '.output', violations)
    checkSchemaSubset(def.parameters, tn + '.parameters', violations)
    check(tn + ' schema 落在受支持子集内', violations.length === 0, violations.join('; '))
    const content = def.output.render({}, { ok: true, text: 'hi' })
    check(tn + ' render 返回 content block 数组', Array.isArray(content) && content[0] && content[0].type === 'text')
  }
}

console.log('\n== 3. 投递 + 显式答复（peer_reply） ==')
{
  const { tools, A, B } = newFleet()
  const p = tools.get('peer_ask').execute({ to: 'session-bbbb', text: '显式答复测试' }, { agent: A })
  check('消息进了对端 inbox', B.inbox.length === 1, 'inbox=' + B.inbox.length)
  const env = B.inbox[0].content[0].text
  check('信封含 corr', /corr: [a-z0-9]+/.test(env))
  check('信封标了提问类型', env.includes('提问（对方在等答复）'))
  check('信封用本地时间', /\d{2}:\d{2}:\d{2}[+-]\d{2}/.test(env))
  check('信封带发送方 self 标识', env.includes('test · 会话A'), env.split('\n')[0])
  const replied = await tools.get('peer_reply').execute({ corr: corrOf(B), text: '显式答复内容' }, { agent: B })
  check('peer_reply 成功', replied.ok === true && replied.status === 'answered', JSON.stringify(replied))
  const got = await p
  check('peer_ask 拿到答复', got.status === 'answered' && got.text.includes('显式答复内容'), JSON.stringify(got))
  check('答复带耗时', /耗时 \d+ 秒/.test(got.text), got.text)
}

console.log('\n== 4. 兜底捕获（对端不调 peer_reply） ==')
{
  const { tools, emit, A, B } = newFleet()
  const p = tools.get('peer_ask').execute({ to: 'session-bbbb', text: '兜底测试' }, { agent: A })
  const msgId = B.inbox[B.inbox.length - 1].id
  emit('turn/start', 'session-bbbb', { turn: 7 })
  emit('user/message', 'session-bbbb', { id: msgId, role: 'user', content: [{ type: 'text', text: '信封' }], source: { kind: 'user' } })
  emit('assistant/message', 'session-bbbb', { turn: 7, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '中间过程' }] } })
  emit('assistant/message', 'session-bbbb', { turn: 7, step: 2, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'FALLBACK-TEXT' }] } })
  emit('turn/end', 'session-bbbb', { turn: 7, reason: { kind: 'completed' } })
  const got = await p
  check('兜底捕获到该轮最终文本', got.status === 'answered' && got.text.includes('FALLBACK-TEXT'), JSON.stringify(got))
  check('兜底答复注明来源', got.text.includes('自动捕获该轮最终文本'), got.text)
}

console.log('\n== 5. 忙闲自适应（对端 running 时短等待转异步） ==')
{
  const { tools, A, B } = newFleet({ defaultAskMs: 60000, busyWaitMs: 60 })
  B.status = 'running'
  const t0 = Date.now()
  const got = await tools.get('peer_ask').execute({ to: 'session-bbbb', text: '忙时提问' }, { agent: A })
  const elapsed = Date.now() - t0
  check('返回 timeout 而不是干等 60 秒', got.status === 'timeout', JSON.stringify(got))
  check('在 busyWaitMs 附近返回', elapsed < 1000, elapsed + 'ms')
  check('说明对端在 running', got.text.includes('running'), got.text)
  check('给出 corr 供后续处理', typeof got.corr === 'string' && got.corr.length > 0)
  check('提示可用 peer_cancel 撤回', got.text.includes('peer_cancel'), got.text)
}

console.log('\n== 6. 目标不存在 / 限速 / 撤回 ==')
{
  const { tools, A } = newFleet()
  const got = await tools.get('peer_ask').execute({ to: 'session-zzzz', text: 'x' }, { agent: A })
  check('目标不存在时明确报错', got.ok === false && got.text.includes('找不到目标会话'), JSON.stringify(got))
}
{
  // 限速：pairMaxAsks=2 + 长等待，第三次必须被拦
  const { tools, A } = newFleet({ pairMaxAsks: 2, defaultAskMs: 30000 })
  const p1 = tools.get('peer_ask').execute({ to: 'session-bbbb', text: 'r1' }, { agent: A })
  const p2 = tools.get('peer_ask').execute({ to: 'session-bbbb', text: 'r2' }, { agent: A })
  const third = await tools.get('peer_ask').execute({ to: 'session-bbbb', text: 'r3' }, { agent: A })
  check('超过 pairMaxAsks 被限速', third.ok === false && third.text.includes('节流'), JSON.stringify(third))
  const fourth = await tools.get('peer_send').execute({ to: 'session-bbbb', text: 'note' }, { agent: A })
  check('notice 通道不受 ask 上限影响', fourth.ok === true, JSON.stringify(fourth))
  const settled = await Promise.race([Promise.all([p1, p2]).then(() => 'both'), new Promise((r) => setTimeout(() => r('pending'), 10))])
  check('限速不影响已投递的提问', settled === 'pending' || settled === 'both', settled)
}
{
  // 撤回一条仍被等待的提问：必须立刻收口，且后续答复被丢弃
  const { tools, A, B } = newFleet({ defaultAskMs: 30000 })
  const p = tools.get('peer_ask').execute({ to: 'session-bbbb', text: '撤回测试' }, { agent: A })
  const corr = corrOf(B)
  const c = await tools.get('peer_cancel').execute({ corr }, { agent: A })
  check('撤回成功', c.ok === true && c.status === 'canceled', JSON.stringify(c))
  const got = await Promise.race([p, new Promise((r) => setTimeout(() => r({ status: 'hung' }), 300))])
  check('撤回后 peer_ask 立刻收口（不再挂住）', got.status === 'canceled', JSON.stringify(got))
  const r = await tools.get('peer_reply').execute({ corr, text: '迟到答复' }, { agent: B })
  check('撤回后对端答复被丢弃', r.ok === false && r.text.includes('撤回'), JSON.stringify(r))
  check('迟到答复没有注入提问方会话', A.inbox.length === 0, 'inbox=' + A.inbox.length)
}
{
  // 超时后迟到答复：走异步注入，并带原问题与耗时
  const host = newFleet({ defaultAskMs: 40 })
  const p = host.tools.get('peer_ask').execute({ to: 'session-bbbb', text: '迟到答复测试' }, { agent: host.A })
  const got = await p
  check('先返回 timeout', got.status === 'timeout', JSON.stringify(got).slice(0, 120))
  const msgId = host.B.inbox[host.B.inbox.length - 1].id
  finishTurn(host, 'session-bbbb', msgId, 3, '迟到的结论')
  await new Promise((r) => setTimeout(r, 20))
  const injected = host.A.inbox.map((m) => m.content[0].text).join('\n')
  check('迟到答复注入提问方会话', injected.includes('迟到的结论'), injected.slice(0, 160))
  check('迟到答复信封带原问题', injected.includes('你当时问的是') && injected.includes('迟到答复测试'), injected.slice(0, 300))
  check('迟到答复信封带耗时', /端到端耗时/.test(injected), injected.slice(0, 200))
}

console.log('\n== 7. peer_inbox / peer_self 可读性 ==')
{
  const { tools, A, B } = newFleet()
  const p = tools.get('peer_ask').execute({ to: 'session-bbbb', text: '时间线测试' }, { agent: A })
  await tools.get('peer_reply').execute({ corr: corrOf(B), text: '答复' }, { agent: B })
  await p
  const inbox = await tools.get('peer_inbox').execute({ thread: '会话B', limit: 5 }, { agent: A })
  check('thread 视图可用', inbox.ok === true && inbox.text.includes('与 "会话B" 的往来'), inbox.text.slice(0, 120))
  check('inbox 显示本地时间', /\d{2}:\d{2}:\d{2}[+-]\d{2}/.test(inbox.text))
  const self = await tools.get('peer_self').execute({}, { agent: A })
  check('peer_self 报告 self 标识', self.text.includes('self=test'), self.text)
  const list = await tools.get('peer_list').execute({}, { agent: A })
  check('peer_list 列出对端', list.text.includes('session-bbbb'), list.text.slice(0, 160))
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)
