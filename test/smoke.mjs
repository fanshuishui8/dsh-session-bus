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
 *   7. peer_inbox 的 thread 视图与本地时间；
 *   8. 投影单元契约：sessionBus 的 stateSchema / wire.viewSchema 具备宿主冷读
 *      （dsh-session-projection 的 hydrate() → restore()）会调用的 .parse，
 *      且 wire.view 的结果能通过校验 —— 用 schemastery 顶替 zod 会在这一步炸成
 *      `def.wire.viewSchema.parse is not a function`。
 *
 * 每个用例用独立宿主，避免共享限速窗口互相干扰。
 */

import { apply, name, inject, parseSelection, isTrustedLiveRequest, LIVE_PATH } from '../lib/index.js'

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

  // 假 webServer：记录注册的精确路由，便于断言
  const webServer = {
    routes: new Map(),
    register(route) { webServer.routes.set(route.path, route); return () => webServer.routes.delete(route.path) },
  }

  const ctx = {
    get(service) {
      if (service === 'tools') return { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } }
      if (service === 'agents') return registry
      if (service === 'sessionTitle') return { get: (session) => ({ title: session.__title }) }
      if (service === 'commands') return commands
      if (service === 'sessionProjections') return projections
      if (service === 'webServer') return webServer
      return undefined
    },
    webServer, // 插件通过 ctx.inject(['webServer'], (webCtx) => webCtx.webServer...) 使用
    inject(services, callback) { callback(ctx); return () => {} },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event) },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout(fn, ms) { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
  }

  // 假投影注册表：够用来验证「命令事件 → 允许清单」的折叠与读取
  const projections = {
    units: new Map(),
    states: new Map(),
    register(definition) { projections.units.set(definition.key, definition); return () => projections.units.delete(definition.key) },
    /** 测试辅助：把一个会话事件喂给所有单元（引用不变则视为未改动）。 */
    drive(session, event) {
      for (const [key, unit] of projections.units) {
        const k = String(session.id) + '::' + key
        const prev = projections.states.has(k) ? projections.states.get(k) : unit.init(session.header, 0)
        const next = unit.apply(prev, event)
        if (next !== prev) projections.states.set(k, next)
      }
    },
    stateOf(session, key) {
      const unit = projections.units.get(key)
      if (unit === undefined) return undefined
      const k = String(session.id) + '::' + key
      return projections.states.has(k) ? projections.states.get(k) : unit.init(session.header, 0)
    },
  }

  // 假命令注册表：暴露 handler 供测试直接驱动
  const commands = {
    defs: new Map(),
    register(definition) { commands.defs.set(definition.name, definition); return () => commands.defs.delete(definition.name) },
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
  return { ctx, tools, emit, A, B, agents, projections, commands, addAgent, webServer }
}

/** 模拟一条 `/session-bus …` 命令落地：先写 command/run 事件，再调用处理器。 */
function runCommand(fleet, agent, args) {
  const session = agent.session
  fleet.emitRaw = fleet.emitRaw || null
  const unitEvent = { type: 'command/run', seq: 10000 + (runCommand.seq = (runCommand.seq || 0) + 1), time: Date.now(), data: { commandId: 'c' + runCommand.seq, name: 'session-bus', args, source: 'ui' } }
  fleet.projections.drive(session, unitEvent)
  const def = fleet.commands.defs.get('session-bus')
  return def === undefined ? { kind: 'error', text: '命令未注册' } : def.handler({ commandId: 'c', agent, rawInput: args, attachments: [], signal: undefined })
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

console.log('\n== 8. 允许清单：命令 / 投影折叠 / 准入 ==')
{
  // 参数解析
  const allow = parseSelection('allow session-bbbb 会话C')
  check('parseSelection: allow 取 token', allow.mutates === true && allow.ids.length === 2 && allow.ids[0] === 'session-bbbb', JSON.stringify(allow))
  check('parseSelection: clear 清空', parseSelection('clear').mutates === true && parseSelection('clear').ids.length === 0)
  check('parseSelection: all → *', parseSelection('all').ids[0] === '*')
  check('parseSelection: list 不改动', parseSelection('list').mutates === false)
  check('parseSelection: 留空不改动', parseSelection('').mutates === false)
  check('parseSelection: 未知动词不改动', parseSelection('frobnicate x').mutates === false && parseSelection('frobnicate x').verb === 'unknown')

  const fleet = newFleet({ defaultAskMs: 1200 })
  const { tools, projections, commands, A, B } = fleet
  const C = fleet.addAgent('session-cccc', '会话C')
  check('命令已注册', commands.defs.has('session-bus'))
  check('投影单元已注册', projections.units.has('sessionBus'))

  // 视图必须带上宿主侧存活会话表（客户端据此过滤列表）
  const busUnit = projections.units.get('sessionBus')
  const view = busUnit.wire.view(busUnit.init(A.session.header, 0))
  check('视图带 live 存活表（进程级真值）',
    Array.isArray(view.live) && view.live.includes('session-bbbb') && view.live.includes('session-cccc'),
    JSON.stringify(view.live))
  check('视图也带允许清单', Array.isArray(view.ids))

  // 刷新语义：list / 空参数 → 清单不动但状态引用变化（视图重算）；turn/start 也让视图保鲜
  const st0 = projections.stateOf(A.session, 'sessionBus')
  projections.drive(A.session, { type: 'command/run', seq: 900, time: 9, data: { name: 'session-bus', args: 'list' } })
  const st1 = projections.stateOf(A.session, 'sessionBus')
  check('/session-bus list 触发重算但不改清单', st1 !== st0 && JSON.stringify(st1.ids) === JSON.stringify(st0.ids) && st1.stamp > st0.stamp, JSON.stringify(st1))
  projections.drive(A.session, { type: 'turn/start', seq: 901, time: 10, data: { turn: 1 } })
  const st2 = projections.stateOf(A.session, 'sessionBus')
  check('turn/start 让视图保鲜（stamp 自增）', st2.stamp > st1.stamp && JSON.stringify(st2.ids) === JSON.stringify(st1.ids), JSON.stringify(st2))
  projections.drive(A.session, { type: 'assistant/message', seq: 902, time: 11, data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', content: [] } } })
  check('无关事件保持同一引用（不产生多余发布）', projections.stateOf(A.session, 'sessionBus') === st2)

  // 宿主投影契约：dsh-session-projection 冷读历史会话时（hydrate → restore）会直接调
  // def.stateSchema.parse(row.val) 与 def.wire.viewSchema.parse(def.wire.view(state))，
  // 契约类型也是 ZodType —— 只能是 zod schema，schemastery 实例没有 .parse。
  const unit = projections.units.get('sessionBus')
  check('stateSchema 具备宿主契约要求的 .parse', typeof unit.stateSchema?.parse === 'function')
  check('wire.viewSchema 具备宿主契约要求的 .parse', typeof unit.wire?.viewSchema?.parse === 'function')
  const folded = projections.stateOf(A.session, 'sessionBus')
  let parsedWire = null
  try { parsedWire = unit.wire.viewSchema.parse(unit.wire.view(folded)) } catch (err) { parsedWire = err }
  check('wire.view 结果能通过 viewSchema.parse（冷读路径）',
    parsedWire !== null && !(parsedWire instanceof Error)
      && Array.isArray(parsedWire.ids) && parsedWire.ids.length === folded.ids.length
      && parsedWire.updatedAt === folded.updatedAt,
    parsedWire instanceof Error ? parsedWire.message : JSON.stringify(parsedWire))
  let rejected = false
  try { unit.wire.viewSchema.parse({ ids: [1], updatedAt: 'x' }) } catch (err) { rejected = true }
  check('viewSchema 拒绝非法 wire 值', rejected)
  let seeded = null
  try { seeded = unit.stateSchema.parse({}) } catch (err) { seeded = err }
  check('stateSchema 校验（并补齐缺省）checkpoint 状态',
    seeded !== null && !(seeded instanceof Error) && Array.isArray(seeded.ids) && seeded.ids.length === 0 && seeded.updatedAt === 0,
    seeded instanceof Error ? seeded.message : JSON.stringify(seeded))

  // 投影只在本插件命令的改动型输入上改写状态
  projections.drive(A.session, { type: 'command/run', seq: 1, time: 1, data: { name: 'other-command', args: 'allow session-cccc' } })
  check('忽略其它命令的事件', projections.stateOf(A.session, 'sessionBus').ids.length === 0)
  projections.drive(A.session, { type: 'command/run', seq: 2, time: 2, data: { name: 'session-bus', args: 'list' } })
  check('list 不改写状态', projections.stateOf(A.session, 'sessionBus').ids.length === 0)

  // 允许 B
  let out = runCommand(fleet, A, 'allow session-bbbb')
  check('命令回执成功', out.kind === 'success' && out.text.includes('已允许 1 个会话'), JSON.stringify(out))
  check('清单已折叠进投影', JSON.stringify(projections.stateOf(A.session, 'sessionBus').ids) === JSON.stringify(['session-bbbb']))

  // 允许后：投递 B 正常，投递 C 被拦
  let got = await tools.get('peer_ask').execute({ to: 'session-bbbb', text: '允许内' }, { agent: A })
  check('允许清单内可投递', got.status === 'timeout' || got.status === 'answered', JSON.stringify(got).slice(0, 100))
  const blocked = await tools.get('peer_ask').execute({ to: 'session-cccc', text: '越界' }, { agent: A })
  check('清单外被拒绝', blocked.ok === false && blocked.text.includes('不在本会话的允许清单里'), JSON.stringify(blocked).slice(0, 160))
  check('被拒绝时不投递', C.inbox.length === 0, 'inbox=' + C.inbox.length)

  // 'other' 优先选清单内的（C 更新，若不受限会选 C）
  const other = await tools.get('peer_send').execute({ to: 'other', text: '给允许的那个' }, { agent: A })
  check('other 在受限时选清单内会话', other.ok === true && B.inbox.length >= 1 && C.inbox.length === 0, JSON.stringify(other).slice(0, 120))

  // 列表与自述标注
  const list = await tools.get('peer_list').execute({}, { agent: A })
  check('peer_list 标注允许/未允许', list.text.includes('✅允许') && list.text.includes('⛔未允许'), list.text.slice(0, 200))
  const self = await tools.get('peer_self').execute({}, { agent: A })
  check('peer_self 显示允许清单', self.text.includes('允许清单：1 个'), self.text.slice(0, 220))

  // 清空 / 不限 / 未知参数
  out = runCommand(fleet, A, 'clear')
  check('clear 后不再限制', out.kind === 'success' && projections.stateOf(A.session, 'sessionBus').ids.length === 0)
  const free = await tools.get('peer_send').execute({ to: 'session-cccc', text: '解禁后可以发' }, { agent: A })
  check('解禁后可投递', free.ok === true && C.inbox.length === 1, JSON.stringify(free).slice(0, 120))
  out = runCommand(fleet, A, 'all')
  check('all → 状态存 *', projections.stateOf(A.session, 'sessionBus').ids[0] === '*')
  check('all 后 peer_self 报告未限制', (await tools.get('peer_self').execute({}, { agent: A })).text.includes('未限制'))
  out = runCommand(fleet, A, 'frobnicate')
  check('未知参数回执为错误', out.kind === 'error' && out.text.includes('未知参数'), JSON.stringify(out))
  out = runCommand(fleet, A, 'allow 不存在的会话名')
  check('未打开的会话先记账并在回执里说明', out.kind === 'success' && out.text.includes('当前未打开'), JSON.stringify(out))
  out = runCommand(fleet, A, 'allow session-bbbb 不存在的会话名')
  check('回执区分「现在就能通信」与「当前未打开」', out.text.includes('现在就能通信') && out.text.includes('当前未打开'), JSON.stringify(out))
}

console.log('\n== 9. 存活表只读路由的可信判定 ==')
{
  check('路由路径固定', LIVE_PATH === '/session-bus/live')
  check('loopback 127.0.0.1 放行', isTrustedLiveRequest({ host: '127.0.0.1:3080' }) === true)
  check('localhost 放行', isTrustedLiveRequest({ host: 'localhost:3080' }) === true)
  check('IPv6 loopback 放行', isTrustedLiveRequest({ host: '[::1]:3080' }) === true)
  check('同源 Origin 放行', isTrustedLiveRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }) === true)
  check('非 loopback Host 拒绝（DNS rebinding）', isTrustedLiveRequest({ host: 'evil.example.com' }) === false)
  check('LAN 地址拒绝', isTrustedLiveRequest({ host: '10.131.71.187:3080' }) === false)
  check('跨站请求拒绝', isTrustedLiveRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }) === false)
  check('Origin 与 Host 不一致拒绝', isTrustedLiveRequest({ host: '127.0.0.1:3080', origin: 'http://evil.example.com' }) === false)
  check('畸形 Origin 拒绝', isTrustedLiveRequest({ host: '127.0.0.1:3080', origin: 'not a url' }) === false)
  check('空请求头拒绝', isTrustedLiveRequest({}) === false && isTrustedLiveRequest(undefined) === false)

  // 用假 req/res 真正跑一次注册好的路由处理器
  const fleet2 = newFleet()
  const route = fleet2.webServer.routes.get(LIVE_PATH)
  check('路由已注册到 webServer', route !== undefined && route.kind === 'exact')
  let status = 0
  let body = ''
  const res = { writeHead(code) { status = code }, end(chunk) { if (typeof chunk === 'string') body = chunk } }
  route.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, res)
  check('可信 GET 返回 200 + 存活表', status === 200 && JSON.parse(body).live.includes('session-bbbb'), body)
  status = 0
  route.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, res)
  check('不可信 Host 返回 403', status === 403, String(status))
  status = 0
  route.handler({ method: 'POST', headers: { host: '127.0.0.1:3080' } }, res)
  check('非 GET/HEAD 返回 405', status === 405, String(status))
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)
