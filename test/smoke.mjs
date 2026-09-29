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
 *   9. 只读路由：/session-bus/live 的信任判定，以及面板数据路由
 *      /session-bus/catalog（工作区 + 会话目录；字段白名单、未附着标题批量读取、TTL 缓存）
 *      与 /session-bus/allow（允许清单真值 {ids, unrestricted}）的 200/400/403/404/405。
 *
 * 每个用例用独立宿主，避免共享限速窗口互相干扰。
 */

import { apply, name, inject, parseSelection, isTrustedLiveRequest, LIVE_PATH, CATALOG_PATH, ALLOW_PATH } from '../lib/index.js'

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

  // 假 sessions（内存会话 store）：真实宿主里只装**进程里已加载**的会话，所以这里只从 agents 派生
  const coldSessions = new Map()   // 冷会话（只在持久化里），由测试用 addColdSession 塞
  const sessionsStore = {
    get: (id) => {
      const agent = agents.get(String(id))
      return agent === undefined ? undefined : agent.session
    },
    list: () => [...agents.values()].map((a) => a.session),
  }

  // 假 workspaceRegistry：工作区列表 + 归档集合（测试用 setWorkspaces 摆数据）
  const workspaceRegistry = {
    workspaces: [],
    archivedSessionIds: [],
    list() { return workspaceRegistry.workspaces },
  }

  // 假 sessionProjectionCache：冷会话的「最后活动时间」来源（header.createdAt 之外的信息）
  const sessionProjectionCache = {
    cachedSnapshot(header) {
      const at = header !== undefined && header !== null ? header.__lastPromptAt : undefined
      if (typeof at !== 'number') return undefined
      return { asOfSeq: 1, values: { sessionListMetadata: { lastPromptAt: at } } }
    },
  }

  // 假 sessionQuery：listSessions = 持久化目录；readTitleSnapshots = 未附着会话的批量标题观测
  const sessionQuery = {
    reads: [],
    lists: 0,
    async listSessions() {
      sessionQuery.lists += 1
      return [...coldSessions.values()].map((s) => ({ header: s.header, live: false, persisted: true }))
    },
    async readTitleSnapshots(ids) {
      sessionQuery.reads.push(ids.slice())
      return ids.map((id) => {
        const key = String(id)
        if (key.indexOf('bad') >= 0) return { sessionId: key, status: 'rejected', reason: new Error('读不了这个会话') }
        const cold = coldSessions.get(key)
        const header = cold !== undefined ? cold.header : { id: key, createdAt: 1000, cwd: '/tmp/cold', version: 4, isSeeded: false }
        return {
          sessionId: key,
          status: 'fulfilled',
          value: Object.assign(
            { session: header },
            key.indexOf('notitle') >= 0 ? {} : { title: { title: '标题 ' + key, eventSeq: 1, updatedAt: 2000 } },
          ),
        }
      })
    },
  }

  const ctx = {
    get(service) {
      if (service === 'tools') return { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } }
      if (service === 'agents') return registry
      if (service === 'sessionTitle') return { get: (session) => ({ title: session.__title }) }
      if (service === 'commands') return commands
      if (service === 'sessionProjections') return projections
      if (service === 'webServer') return webServer
      if (service === 'sessionController') return sessionController
      if (service === 'sessions') return sessionsStore
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionQuery') return sessionQuery
      if (service === 'sessionProjectionCache') return sessionProjectionCache
      return undefined
    },
    webServer, // 插件通过 ctx.inject(['webServer'], (webCtx) => webCtx.webServer...) 使用
    inject(services, callback) { callback(ctx); return () => {} },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event) },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout(fn, ms) { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
  }

  // 假投影注册表：够用来验证「命令事件 → 允许清单」的折叠与读取
  // cachedSnapshot 用来喂「最后活动时间」的口径（sessionListMetadata.lastPromptAt）
  const projections = {
    units: new Map(),
    states: new Map(),
    cachedSnapshot(session) {
      const at = session !== undefined && session !== null ? session.__lastPromptAt : undefined
      if (typeof at !== 'number') return undefined
      return { asOfSeq: 1, values: { sessionListMetadata: { lastPromptAt: at } } }
    },
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

  // 假 sessionController：resolveAgent = 冷恢复（成功则把 agent 注册进 registry）
  const sessionController = {
    resumes: [],
    async resolveAgent(sessionId) {
      const id = String(sessionId)
      sessionController.resumes.push(id)
      if (id.indexOf('0badc0de') >= 0) return { error: { code: 'session/not-found', message: '没有这个会话' } }
      if (agents.has(id)) return { agent: agents.get(id) }
      return { agent: addAgent(id, '被唤醒的会话') }
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

  /** 摆工作区数据（面板目录路由的数据源）。 */
  function setWorkspaces(items, archived = []) {
    workspaceRegistry.workspaces = items
    workspaceRegistry.archivedSessionIds = archived
  }
  /** 塞一个「未附着」的冷会话（历史会话，只在持久化里，不在 agents 里）。 */
  function addColdSession(id, origin) {
    const session = { id: String(id), header: { id: String(id), createdAt: 1000, cwd: '/tmp/cold', version: 4, isSeeded: false, ...(origin === undefined ? {} : { origin }) } }
    coldSessions.set(String(id), session)
    return session
  }

  apply(ctx, Object.assign({ self: 'test', defaultAskMs: 60000, busyWaitMs: 5000 }, config))
  const A = addAgent('session-aaaa', '会话A')
  const B = addAgent('session-bbbb', '会话B')
  return {
    ctx, tools, emit, A, B, agents, projections, commands, addAgent, webServer, sessionController,
    setWorkspaces, addColdSession, sessionQuery, workspaceRegistry, sessionsStore,
  }
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
  await sleep(10) // 投递是异步的（允许按需唤醒），先让出一拍
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
  await sleep(10)
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
  await sleep(10)
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
  await sleep(10)
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

  // 视图只带允许清单：v0.3.6 起不再带 `live` 存活表（面板早就不显示存活标记，
  // 而视图每次 turn/start 都要重算 —— 等于每轮白走一遍 agents 注册表）
  const busUnit = projections.units.get('sessionBus')
  const view = busUnit.wire.view(busUnit.init(A.session.header, 0))
  check('视图只带允许清单（没有 live 字段）',
    Array.isArray(view.ids) && Object.prototype.hasOwnProperty.call(view, 'live') === false,
    JSON.stringify(view))
  check('视图字段就两个：ids / updatedAt',
    Object.keys(view).sort().join(',') === 'ids,updatedAt', Object.keys(view).join(','))

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

console.log('\n== 10. 按需唤醒（allowResume）==')
{
  const DEAD = 'session-deadbeef-0000-0000-0000-000000000001'
  const fleet = newFleet()
  const { tools, A, sessionController } = fleet

  // 未附着的完整 id：按需唤醒后投递
  const sent = await tools.get('peer_send').execute({ to: DEAD, text: '叫醒你' }, { agent: A })
  check('未附着的完整 id 会按需唤醒', sent.ok === true && sessionController.resumes.includes(DEAD), JSON.stringify(sent).slice(0, 140))
  check('唤醒后消息已投递', fleet.agents.get(DEAD) !== undefined && fleet.agents.get(DEAD).inbox.length === 1, 'inbox=' + (fleet.agents.get(DEAD) === undefined ? 'n/a' : fleet.agents.get(DEAD).inbox.length))
  check('结果里说明是唤醒投递', String(sent.text).includes('未附着'), String(sent.text).slice(0, 120))

  // 唤醒失败：把控制器错误如实带出
  const failed = await tools.get('peer_send').execute({ to: 'session-0badc0de-0000-0000-0000-000000000002', text: 'x' }, { agent: A })
  check('唤醒失败时如实报错', failed.ok === false && String(failed.text).includes('唤醒失败'), JSON.stringify(failed).slice(0, 160))

  // 关掉 allowResume：明确拒绝并给出两种出路
  const off = newFleet({ allowResume: false })
  const refused = await off.tools.get('peer_send').execute({ to: DEAD, text: 'x' }, { agent: off.A })
  check('关掉 allowResume 后拒绝并说明', refused.ok === false && String(refused.text).includes('未附着') && String(refused.text).includes('allowResume'), JSON.stringify(refused).slice(0, 180))

  // 允许清单 + 未附着 id：勾了就允许，未勾就拦
  const fleet2 = newFleet()
  runCommand(fleet2, fleet2.A, 'allow ' + DEAD)
  const okSend = await fleet2.tools.get('peer_send').execute({ to: DEAD, text: '允许内' }, { agent: fleet2.A })
  check('允许清单里的未附着 id 可投递', okSend.ok === true, JSON.stringify(okSend).slice(0, 140))
  const other = 'session-feedface-0000-0000-0000-000000000003'
  const blocked = await fleet2.tools.get('peer_send').execute({ to: other, text: '越界' }, { agent: fleet2.A })
  check('允许清单外的未附着 id 被拦', blocked.ok === false && String(blocked.text).includes('不在本会话的允许清单里'), JSON.stringify(blocked).slice(0, 160))
}

console.log('\n== 11. 面板只读路由：catalog / allow ==')
{
  check('路由路径固定', CATALOG_PATH === '/session-bus/catalog' && ALLOW_PATH === '/session-bus/allow')

  const HOST = { host: '127.0.0.1:3080' }
  async function call(route, req) {
    let status = 0
    let body = ''
    const res = { writeHead(code) { status = code }, end(chunk) { if (typeof chunk === 'string') body = chunk } }
    route.handler(req, res)
    await sleep(10)   // catalog 是异步的（要读未附着会话的标题）
    return { status, body }
  }

  const fleet = newFleet({ defaultAskMs: 50 })
  fleet.B.status = 'running'
  fleet.B.session.__lastPromptAt = 1_700_000_000_123   // 比 createdAt（Date.now()）小？不影响断言：取 max 后应等于它或 createdAt
  fleet.B.session.header.createdAt = 1_600_000_000_000 // 让 lastPromptAt 明确更大
  const SUB = fleet.addAgent('session-sub123', '子代理')
  SUB.session.header.origin = 'subagent'
  const D = fleet.addAgent('session-dddd', '会话D')   // 没有 lastPromptAt 元数据 → 时间应退化为 createdAt
  D.session.header.createdAt = 1_234_567_890_000
  fleet.setWorkspaces([
    { id: 'ws-1', title: '项目一', path: '/tmp/one', sessionIds: ['session-bbbb', 'session-cold1', 'session-notitle1', 'session-bad1', 'session-ghost1', 'session-dddd'] },
    { id: 'ws-2', title: '项目二', path: '/tmp/two', sessionIds: ['session-cold2', 'session-sub123'] },
  ], ['session-cold2'])
  const cold1 = fleet.addColdSession('session-cold1')
  cold1.header.__lastPromptAt = 1_650_000_000_456
  cold1.header.createdAt = 1000
  fleet.addColdSession('session-cold2')
  fleet.addColdSession('session-orphan1')   // 不属于任何工作区：面板会把它显示成「未分组」

  const catalogRoute = fleet.webServer.routes.get(CATALOG_PATH)
  check('目录路由已注册（exact）', catalogRoute !== undefined && catalogRoute.kind === 'exact')
  let out = await call(catalogRoute, { method: 'GET', url: CATALOG_PATH + '?session=session-aaaa', headers: HOST })
  check('可信 GET 返回 200', out.status === 200, String(out.status))
  const cat = JSON.parse(out.body)
  check('目录含工作区（workspaceId/标题/path/sessionIds）',
    Array.isArray(cat.workspaces) && cat.workspaces.length === 2
    && cat.workspaces[0].workspaceId === 'ws-1' && cat.workspaces[0].title === '项目一' && cat.workspaces[0].path === '/tmp/one'
    && JSON.stringify(cat.workspaces[0].sessionIds) === JSON.stringify(['session-bbbb', 'session-cold1', 'session-notitle1', 'session-bad1', 'session-ghost1', 'session-dddd']),
    JSON.stringify(cat.workspaces))
  const rows = new Map(cat.sessions.map((r) => [r.id, r]))
  check('自己不出现在目录里', rows.has('session-aaaa') === false, JSON.stringify([...rows.keys()]))
  check('subagent 会话被过滤', rows.has('session-sub123') === false, JSON.stringify([...rows.keys()]))
  check('附着会话标 attached、标题取自 sessionTitle', rows.get('session-bbbb').attached === true && rows.get('session-bbbb').title === '会话B', JSON.stringify(rows.get('session-bbbb')))
  check('running 取自 agent 状态', rows.get('session-bbbb').running === true, JSON.stringify(rows.get('session-bbbb')))
  check('未附着会话标题来自批量观测', rows.get('session-cold1').attached === false && rows.get('session-cold1').title === '标题 session-cold1', JSON.stringify(rows.get('session-cold1')))
  check('归档标记如实带出', rows.get('session-cold2').archived === true && rows.get('session-cold1').archived === false, JSON.stringify([rows.get('session-cold2'), rows.get('session-cold1')]))
  check('没有标题的会话退化为空串（客户端用 id 兜底）', rows.get('session-notitle1').title === '' && rows.get('session-bad1').title === '', JSON.stringify([rows.get('session-notitle1'), rows.get('session-bad1')]))
  check('工作区里登记但读不到 header 的会话也会列出', rows.has('session-ghost1') === true, JSON.stringify([...rows.keys()]))
  check('不属于任何工作区的历史会话也列出（面板显示为「未分组」）', rows.has('session-orphan1') === true, JSON.stringify([...rows.keys()]))
  check('目录行的字段是白名单（无 cwd / 事件 / 日志）',
    Object.keys(rows.get('session-bbbb')).sort().join(',') === 'archived,attached,id,running,title,updatedAt',
    Object.keys(rows.get('session-bbbb')).join(','))
  check('未附着标题一次批量读完', fleet.sessionQuery.reads.length === 1 && fleet.sessionQuery.reads[0].length === 6, JSON.stringify(fleet.sessionQuery.reads))

  // 「最后活动时间」= 官方口径 max(createdAt, sessionListMetadata.lastPromptAt)
  check('附着会话：活动时间取自投影的 lastPromptAt', rows.get('session-bbbb').updatedAt === 1_700_000_000_123, String(rows.get('session-bbbb').updatedAt))
  check('附着但没有活动元数据时退化为 createdAt',
    rows.get('session-dddd') !== undefined && rows.get('session-dddd').updatedAt === rows.get('session-dddd').updatedAt
    && rows.get('session-dddd').updatedAt === D.session.header.createdAt,
    JSON.stringify(rows.get('session-dddd')))
  check('冷会话：活动时间取自投影缓存', rows.get('session-cold1').updatedAt === 1_650_000_000_456, String(rows.get('session-cold1').updatedAt))
  check('冷会话没有缓存时退化为 createdAt', rows.get('session-ghost1').updatedAt === 1000, String(rows.get('session-ghost1').updatedAt))

  out = await call(catalogRoute, { method: 'GET', url: CATALOG_PATH + '?session=session-aaaa', headers: HOST })
  check('TTL 内不重复读未附着会话标题', fleet.sessionQuery.reads.length === 1, String(fleet.sessionQuery.reads.length))
  check('TTL 内不重复扫持久化目录', fleet.sessionQuery.lists === 1, String(fleet.sessionQuery.lists))

  out = await call(catalogRoute, { method: 'HEAD', url: CATALOG_PATH, headers: HOST })
  check('HEAD 返回 200 且无正文', out.status === 200 && out.body === '', JSON.stringify(out))
  out = await call(catalogRoute, { method: 'GET', url: CATALOG_PATH, headers: { host: 'evil.example.com' } })
  check('目录路由：不可信 Host 403', out.status === 403, String(out.status))
  out = await call(catalogRoute, { method: 'POST', url: CATALOG_PATH, headers: HOST })
  check('目录路由：非 GET/HEAD 405', out.status === 405, String(out.status))

  const allowRoute = fleet.webServer.routes.get(ALLOW_PATH)
  check('清单路由已注册（exact）', allowRoute !== undefined && allowRoute.kind === 'exact')
  out = await call(allowRoute, { method: 'GET', url: ALLOW_PATH + '?session=session-aaaa', headers: HOST })
  check('未设清单时 unrestricted=true', out.status === 200 && JSON.parse(out.body).unrestricted === true, out.body)
  runCommand(fleet, fleet.A, 'allow session-bbbb')
  out = await call(allowRoute, { method: 'GET', url: ALLOW_PATH + '?session=session-aaaa', headers: HOST })
  const allow = JSON.parse(out.body)
  check('设了清单后返回 ids 真值', out.status === 200 && allow.unrestricted === false && JSON.stringify(allow.ids) === JSON.stringify(['session-bbbb']), out.body)
  out = await call(allowRoute, { method: 'GET', url: ALLOW_PATH + '?session=session-nope', headers: HOST })
  check('未知会话 404', out.status === 404, String(out.status))
  out = await call(allowRoute, { method: 'GET', url: ALLOW_PATH, headers: HOST })
  check('缺 session 参数 400', out.status === 400, String(out.status))
  out = await call(allowRoute, { method: 'GET', url: ALLOW_PATH + '?session=session-aaaa', headers: { host: 'evil.example.com' } })
  check('清单路由：不可信 Host 403', out.status === 403, String(out.status))
  out = await call(allowRoute, { method: 'POST', url: ALLOW_PATH, headers: HOST })
  check('清单路由：非 GET/HEAD 405', out.status === 405, String(out.status))
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)
