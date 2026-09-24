/**
 * dsh-session-bus — 会话间消息总线（静态 Cordis 宿主插件，零依赖）
 *
 * 让**同一个 dsh 进程内**的任意两个会话互发消息：提问/答复、通知/触发、多轮协作。
 * 没有任何网络、没有持久化、没有后台轮询；不调用工具时零开销。
 *
 * 实现要点（都是在本机 dsh 0.1.5-rc.1 上实测过的行为）：
 *  - 投递：ctx.agents.get(targetId).followup|steer(手写 UserMessage)；
 *    对端空闲→立刻起一轮；对端 running→进它 inbox 排队，等它自己那轮结束。
 *  - 答复双保险：①对端显式 peer_reply 立刻回到调用方工具结果；
 *    ②否则监听全局 session/event，在对端处理该消息的那一轮 turn/end 时
 *      自动捕获该轮最后一段 assistant 文本回传。
 *  - 异步自描述：迟到/异步答复的信封自带「你当时问的原文 + 提问时间 + 答复时间 + 端到端耗时」，
 *    所有时间都是本机本地时间（带时区偏移）。
 *  - 忙闲自适应：投递前看对端 status，running 时只等 busyWaitMs 就转异步，不堵住调用方。
 *  - 防乒乓：按会话对限速（pairWindowMs 内 pairMaxAsks 次 ask / pairMaxNotes 次 note），
 *    不用「未答复就禁止反问」这种状态机硬拦（那会拦住正常的多轮）。
 *
 * 服务依赖（全部通过 ctx.get 可选获取，缺失时优雅降级）：
 *  agents / sessionTitle / tools；计时器需要 inject: ['timer']。
 *
 * @module dsh-session-bus
 */

export const name = 'dsh-session-bus'

export const inject = ['timer']

const DEFAULTS = {
  self: 'local',
  aliases: {},
  defaultPeer: 'other',
  busyWaitMs: 10000,
  defaultAskMs: 90000,
  maxAskMs: 300000,
  staleNoticeMs: 120000,
  pairWindowMs: 60000,
  pairMaxAsks: 8,
  pairMaxNotes: 20,
  maxText: 8000,
  maxLog: 200,
  trustLevel: 'instruction',
}

// 工具结果 schema：dsh-tools 支持的标准 JSON Schema 子集
// （type/oneOf/properties/required/additionalProperties/items/enum/const + 注解）
const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
    corr: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
}

/**
 * 把会话总线挂载到宿主组合。
 * @param {object} ctx - Cordis 宿主上下文。
 * @param {object} [config] - cordis.patch.yml 里 insert 行的 config。
 */
export function apply(ctx, config = {}) {
  const cfg = Object.assign({}, DEFAULTS, config === null || typeof config !== 'object' ? {} : config)

  const tools = ctx.get('tools')
  const agents = ctx.get('agents')
  const sessionTitle = ctx.get('sessionTitle')
  if (tools === undefined) {
    console.error('[dsh-session-bus] tools 服务不可用，插件未注册任何工具（请检查宿主组合）')
    return
  }

  const aliases = cfg.aliases !== null && typeof cfg.aliases === 'object' ? cfg.aliases : {}

  const pending = new Map()   // corr -> {resolve, timer, askerId, targetId, label, question, sentAt, settled, timedOut, cancelled}
  const anchors = new Map()   // msgId -> {corr, askerId, targetId, label, seq, turn, texts, sentAt, question}
  const openAsks = new Map()  // corr -> {askerId, targetId, answered, at, question, sentAt}
  const cancelled = new Set() // 被撤回的 corr：迟到答复直接丢弃
  const pairAsks = new Map()  // pairKey -> number[]（限速窗口）
  const pairSeq = new Map()   // pairKey -> 本对会话第几次往来
  const lastSeen = new Map()  // sessionId -> ms（插件启动后观测到的活跃时间）
  const lastTurn = new Map()  // sessionId -> turn
  const log = []              // 最近往来记录（只保留叶子字段）

  function now() { return Date.now() }
  function rid() { return Math.random().toString(36).slice(2, 8) + now().toString(36).slice(-4) }
  function sid(v) { return v === undefined || v === null ? '' : String(v) }
  function clip(v, n) {
    const s = v === undefined || v === null ? '' : String(v)
    return s.length > n ? s.slice(0, n) + ' …(截断)' : s
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n }
  /** 本机本地时间（带时区偏移），与 dsh Web UI 里显示的时间一致。 */
  function fmtLocal(t) {
    try {
      const d = new Date(t)
      const off = -d.getTimezoneOffset() / 60
      const offTxt = (off >= 0 ? '+' : '-') + pad2(Math.floor(Math.abs(off)))
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + offTxt
    } catch (e) { return '--:--:--' }
  }
  /** 人类可读的耗时。 */
  function durText(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return s + ' 秒'
    const m = Math.floor(s / 60)
    if (m < 60) return m + ' 分' + (s % 60 === 0 ? '' : (s % 60) + ' 秒')
    const h = Math.floor(m / 60)
    return h + ' 小时' + (m % 60 === 0 ? '' : (m % 60) + ' 分')
  }
  function push(rec) { log.push(rec); if (log.length > cfg.maxLog) log.splice(0, log.length - cfg.maxLog) }
  function noteOpenAsk(corr, askerId, targetId, question, sentAt) {
    openAsks.set(corr, { askerId: askerId, targetId: sid(targetId), answered: false, at: now(), question: question, sentAt: sentAt })
    while (openAsks.size > 200) { const k = openAsks.keys().next(); if (k.done === true) break; openAsks.delete(k.value) }
  }
  function markAnswered(corr) { const ask = openAsks.get(corr); if (ask !== undefined) ask.answered = true }
  function markCancelled(corr) {
    cancelled.add(corr)
    while (cancelled.size > 200) { const k = cancelled.values().next(); if (k.done === true) break; cancelled.delete(k.value) }
  }
  function pairKeyOf(x, y) { const a = sid(x); const b = sid(y); return a < b ? a + '|' + b : b + '|' + a }
  function nextRound(x, y) {
    const key = pairKeyOf(x, y)
    const n = (pairSeq.get(key) || 0) + 1
    pairSeq.set(key, n)
    return n
  }
  function rateLimited(fromId, toId, isAsk) {
    const key = pairKeyOf(fromId, toId)
    const t = now()
    let list = pairAsks.get(key)
    if (list === undefined) { list = []; pairAsks.set(key, list) }
    while (list.length > 0 && t - list[0] > cfg.pairWindowMs) list.shift()
    const cap = isAsk === true ? cfg.pairMaxAsks : cfg.pairMaxNotes
    if (list.length >= cap) {
      return '节流：本会话与目标会话在最近 ' + Math.round(cfg.pairWindowMs / 1000) + ' 秒内已有 ' + list.length + ' 次投递（上限 ' + cap + '）。如果是自动乒乓，请停下来把结论交给人类；确需继续可稍后再试。'
    }
    list.push(t)
    return ''
  }

  function titleOf(sessionId) {
    try {
      if (agents === undefined || typeof agents.get !== 'function') return ''
      const a = agents.get(sessionId)
      if (a === undefined || sessionTitle === undefined || typeof sessionTitle.get !== 'function') return ''
      const snap = sessionTitle.get(a.session)
      return snap !== undefined && typeof snap.title === 'string' ? snap.title : ''
    } catch (e) { return '' }
  }
  function labelOf(sessionId) {
    const s = sid(sessionId)
    const t = titleOf(s)
    return (t === '' ? '会话' : t + ' ') + '#' + s.slice(-6)
  }
  /** 对端看到的发送方标识：可带本端 self 名（多机部署时区分来源）。 */
  function senderLabel(sessionId) {
    const self = sid(cfg.self)
    return (self === '' ? '' : self + ' · ') + labelOf(sessionId)
  }
  function statusOf(sessionId) {
    try {
      if (agents === undefined || typeof agents.get !== 'function') return '?'
      const a = agents.get(sessionId)
      return a !== undefined && typeof a.status === 'string' ? a.status : '?'
    } catch (e) { return '?' }
  }
  function activityOf(p) { return (p.observed === true ? '活跃于 ' : '创建于 ') + fmtLocal(p.seen) }

  /** 存活的对端会话（排除自己与 subagent），只读叶子字段。 */
  function livePeers(meId) {
    const out = []
    if (agents === undefined || typeof agents.list !== 'function') return out
    let list
    try { list = typeof agents.roots === 'function' ? agents.roots() : agents.list() } catch (e) { return out }
    for (const a of list) {
      try {
        const id = sid(a.id)
        if (id === '' || id === sid(meId)) continue
        const session = a.session
        const header = session === undefined || session === null ? undefined : session.header
        if (header !== undefined && header.origin === 'subagent') continue
        const cwd = header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''
        const born = header !== undefined && typeof header.createdAt === 'number' ? header.createdAt : 0
        const observed = lastSeen.has(id)
        out.push({
          id: id,
          status: typeof a.status === 'string' ? a.status : '?',
          cwd: cwd,
          seen: observed ? lastSeen.get(id) : born,
          observed: observed,
          label: labelOf(id),
        })
      } catch (e) { /* 跳过不可读的 agent */ }
    }
    out.sort(function (x, y) { return y.seen - x.seen })
    return out
  }

  /** to → {id,label}：别名 → 完整 id → id 片段 → 标题子串 → other/auto。 */
  function resolveTarget(to, meId) {
    const peers = livePeers(meId)
    const want = to === undefined || to === null || String(to).trim() === '' ? 'other' : String(to).trim()
    if (Object.prototype.hasOwnProperty.call(aliases, want)) {
      const id = sid(aliases[want])
      if (agents !== undefined && typeof agents.get === 'function' && agents.get(id) !== undefined) {
        return { ok: true, id: id, label: labelOf(id) + '（别名 ' + want + '）' }
      }
      return { ok: false, message: '别名 "' + want + '" 指向的会话 ' + id + ' 不在本进程中存活（未打开或已关闭）。' }
    }
    if (want === 'other' || want === 'auto') {
      if (peers.length === 0) return { ok: false, message: '当前没有其他存活会话可投递（需要在另一个标签页打开第二个会话）。' }
      return { ok: true, id: peers[0].id, label: peers[0].label }
    }
    let hit
    for (const p of peers) if (p.id === want) { hit = p; break }
    if (hit === undefined) for (const p of peers) if (p.id.indexOf(want) >= 0) { hit = p; break }
    if (hit === undefined) for (const p of peers) if (p.label.indexOf(want) >= 0) { hit = p; break }
    if (hit === undefined) {
      const names = peers.length === 0 ? '（无）' : peers.map(function (p) { return p.label }).join('、')
      return { ok: false, message: '找不到目标会话 "' + want + '"。当前可用：' + names + '（也可用 to="other" 选最近活跃的那个）' }
    }
    return { ok: true, id: hit.id, label: hit.label }
  }

  /** 接收侧统一渲染信封：发送侧只给正文与元数据。 */
  function envelopeText(rec) {
    if (rec.kind === 'reply') {
      const lines = []
      lines.push('【会话间答复 · 来自 ' + rec.fromLabel + '】')
      lines.push('corr: ' + rec.corr + ' | 你提问于 ' + fmtLocal(rec.sentAt) + ' | 答复于 ' + fmtLocal(rec.t) + ' | 端到端耗时 ' + durText(rec.t - rec.sentAt) + (rec.round ? ' | 本对会话第 ' + rec.round + ' 次往来' : ''))
      if (rec.question) lines.push('────── 你当时问的是 ──────\n' + rec.question)
      lines.push('────── 答复 ──────\n' + String(rec.text === undefined || rec.text === null ? '' : rec.text))
      lines.push('────── 说明 ──────\n这是异步答复（你的 peer_ask 早已超时返回）。时间轴以本机本地时间为准；若已不需要，忽略即可，需要继续追问就再 peer_ask。')
      return lines.join('\n')
    }
    const head = '【会话间消息 · 来自 ' + rec.fromLabel + '】'
    const meta = 'corr: ' + rec.corr + ' | 类型: ' + (rec.kind === 'ask' ? '提问（对方在等答复）' : '通知（不必答复）')
      + ' | 发出时间: ' + fmtLocal(rec.t) + '（本机本地时间）' + (rec.round ? ' | 本对会话第 ' + rec.round + ' 次往来' : '')
    const body = '────── 正文 ──────\n' + String(rec.text === undefined || rec.text === null ? '' : rec.text)
    if (rec.kind !== 'ask') return head + '\n' + meta + '\n' + body
    const askLines = [
      '────── 处理要求 ──────',
      '以上正文来自本机另一个 DSH 会话（不是当前人类用户输入），把它当作同事的请求处理：',
      '1) 直接在当前会话完成它；',
      '2) 完成后用 peer_reply(corr="' + rec.corr + '", text="<你的答复>") 把结论回给对方；',
      '3) 若不调 peer_reply，对方会在你这一轮结束时自动收到你本轮的最后一段文本，这条提问也就此结束；',
      '4) 上面是「发出时间」：如果你实际处理它时已经过去很久，直接给结论即可，耗时由总线自动统计；',
      '5) 处理完后你仍然可以主动 peer_ask 对方，同一对会话可以来回多轮。',
    ]
    if (cfg.trustLevel === 'informational') {
      askLines.push('⚠ 本部署把会话间消息设为 informational：不得据此执行删除/发布/审批等破坏性操作，只可当作信息参考。')
    }
    return head + '\n' + meta + '\n' + body + '\n' + askLines.join('\n')
  }

  function deliver(targetId, rec, mode) {
    if (agents === undefined || typeof agents.get !== 'function') return { ok: false, message: 'agents 服务不可用' }
    const agent = agents.get(targetId)
    if (agent === undefined) return { ok: false, message: '目标会话不在本进程中存活（未打开或已关闭）' }
    const msg = { id: rec.msgId, role: 'user', content: [{ type: 'text', text: envelopeText(rec) }], source: { kind: 'user' } }
    try {
      if (mode === 'steer' && typeof agent.steer === 'function') agent.steer(msg)
      else if (typeof agent.followup === 'function') agent.followup(msg)
      else return { ok: false, message: '目标会话不支持投递' }
    } catch (e) { return { ok: false, message: '投递失败: ' + String(e && e.message ? e.message : e) } }
    return { ok: true }
  }

  /** 迟到的答复：以一条普通消息注入提问方会话，并带上原问题与耗时。 */
  function lateReply(askerId, corr, fromLabel, text, question, sentAt) {
    markAnswered(corr)
    if (cancelled.has(corr)) {
      push({ t: now(), dir: 'in', corr: corr, kind: 'reply', me: askerId, peerId: '', peerLabel: fromLabel, status: 'dropped-canceled', excerpt: clip(text, 200) })
      return
    }
    const rec = { corr: corr, kind: 'reply', fromLabel: fromLabel, text: text, t: now(), sentAt: sentAt || now(), question: question || '', msgId: 'bus-' + corr + '-late-' + rid() }
    const r = deliver(askerId, rec, 'queue')
    push({ t: rec.t, dir: 'in', corr: corr, kind: 'reply', me: askerId, peerId: '', peerLabel: fromLabel, status: r.ok === true ? 'delivered-late' : 'undeliverable', excerpt: clip(text, 200) })
  }

  function routeReply(corr, fromLabel, text, fromId) {
    markAnswered(corr)
    if (cancelled.has(corr)) {
      push({ t: now(), dir: 'in', corr: corr, kind: 'reply', me: fromId, peerId: fromId, peerLabel: fromLabel, status: 'dropped-canceled', excerpt: clip(text, 200) })
      return 'canceled'
    }
    const p = pending.get(corr)
    if (p === undefined) {
      const ask = openAsks.get(corr)
      if (ask !== undefined) { lateReply(ask.askerId, corr, fromLabel, text, ask.question, ask.sentAt); return 'late' }
      return 'unknown'
    }
    if (p.settled !== true) {
      p.settled = true
      if (typeof p.timer === 'function') { try { p.timer() } catch (e) { /* ignore */ } }
      pending.delete(corr)
      p.resolve({ ok: true, status: 'answered', corr: corr, text: fromLabel + ' 的答复（提问 ' + fmtLocal(p.sentAt) + ' → 答复 ' + fmtLocal(now()) + '，耗时 ' + durText(now() - p.sentAt) + '）：\n' + text })
      return 'answered'
    }
    if (p.timedOut === true) { pending.delete(corr); lateReply(p.askerId, corr, fromLabel, text, p.question, p.sentAt); return 'late' }
    pending.delete(corr)
    return 'duplicate'
  }

  /** 对端处理该提问的那一轮结束了：不论显式还是兜底，都收口并把该提问标记为已处理。 */
  function finalizeAnchor(mid, a, reason) {
    anchors.delete(mid)
    markAnswered(a.corr)
    if (cancelled.has(a.corr)) return
    const p = pending.get(a.corr)
    if (p === undefined) return
    const reply = a.texts.length > 0 ? a.texts[a.texts.length - 1] : ''
    if (p.settled !== true) {
      p.settled = true
      if (typeof p.timer === 'function') { try { p.timer() } catch (e) { /* ignore */ } }
      pending.delete(a.corr)
      const body = reply === ''
        ? '（' + a.label + ' 处理完了这一轮，但没有产生文本答复；结束原因: ' + String(reason) + '）'
        : a.label + ' 的答复（自动捕获该轮最终文本；提问 ' + fmtLocal(a.sentAt) + ' → 完成 ' + fmtLocal(now()) + '，耗时 ' + durText(now() - a.sentAt) + '）：\n' + reply
      p.resolve({ ok: true, status: 'answered', corr: a.corr, text: body })
      push({ t: now(), dir: 'in', corr: a.corr, kind: 'reply', me: a.askerId, peerId: a.targetId, peerLabel: a.label, status: 'auto-answered', excerpt: clip(reply, 200) })
      return
    }
    if (p.timedOut === true) {
      pending.delete(a.corr)
      if (reply !== '') lateReply(p.askerId, a.corr, a.label, reply, p.question, p.sentAt)
    }
  }

  function textOfMessage(message) {
    if (message === undefined || message === null) return ''
    const content = message.content
    if (Array.isArray(content) !== true) return ''
    const parts = []
    for (const b of content) {
      if (b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text !== '') parts.push(b.text)
    }
    return parts.join('\n').trim()
  }

  /** 全局会话事件流：认领锚点（消息被处理）+ 捕获该轮最终文本 + 排队过久时补时间说明。 */
  function onSessionEvent(session, event) {
    try {
      if (session === undefined || event === undefined) return
      const s = sid(session.id)
      lastSeen.set(s, now())
      const data = event.data
      if (event.type === 'turn/start') { lastTurn.set(s, data ? data.turn : undefined); return }
      if (event.type === 'user/message') {
        const mid = data !== undefined && data !== null && data.id !== undefined ? sid(data.id) : ''
        if (mid !== '' && anchors.has(mid)) {
          const a = anchors.get(mid)
          a.seq = event.seq
          a.turn = lastTurn.has(s) ? lastTurn.get(s) : null
          const waited = now() - a.sentAt
          if (waited > cfg.staleNoticeMs && agents !== undefined && typeof agents.get === 'function') {
            const ag = agents.get(s)
            if (ag !== undefined && typeof ag.inject === 'function') {
              try {
                ag.inject({
                  id: 'bus-notice-' + a.corr,
                  role: 'user',
                  content: [{ type: 'text', text: '【会话总线 · 仅时间说明】你正在处理的这条会话间消息（corr=' + a.corr + '）发出于 ' + fmtLocal(a.sentAt) + '，在你这里排队了 ' + durText(waited) + ' 才被处理。给出结论即可，耗时由总线自动统计，不需要你换算时间。' }],
                  source: { kind: 'user' },
                })
              } catch (e) { /* 提示失败不影响主流程 */ }
            }
          }
        }
        return
      }
      if (event.type === 'assistant/message') {
        const turn = data ? data.turn : undefined
        const text = textOfMessage(data ? data.message : undefined)
        if (text === '') return
        for (const a of anchors.values()) {
          if (a.targetId !== s || a.seq === null || event.seq <= a.seq) continue
          if (a.turn !== null && a.turn !== undefined && turn !== undefined && turn !== a.turn) continue
          a.texts.push(text)
        }
        return
      }
      if (event.type === 'turn/end') {
        const turn = data ? data.turn : undefined
        const reason = data !== undefined && data !== null && data.reason !== undefined && data.reason !== null ? sid(data.reason.kind) : 'completed'
        const done = []
        for (const entry of anchors) {
          const mid = entry[0]
          const a = entry[1]
          if (a.targetId !== s || a.seq === null || event.seq <= a.seq) continue
          if (a.turn !== null && a.turn !== undefined && turn !== undefined && turn !== a.turn) continue
          done.push([mid, a])
        }
        for (const pair of done) finalizeAnchor(pair[0], pair[1], reason)
      }
    } catch (e) {
      console.error('[dsh-session-bus] session/event 处理失败: ' + String(e && e.message ? e.message : e))
    }
  }

  /** peer_send / peer_ask 的共同实现。wait=true 表示提问并等待答复。 */
  function sendTo(args, exec, wait) {
    const a = args === undefined || args === null ? {} : args
    const meId = exec !== undefined && exec.agent !== undefined ? sid(exec.agent.id) : ''
    if (meId === '') return { ok: false, text: '当前工具调用没有会话上下文，无法确定发送方会话。' }
    const text = String(a.text === undefined || a.text === null ? '' : a.text).trim()
    if (text === '') return { ok: false, text: '正文不能为空。' }
    const to = a.to === undefined || a.to === null || String(a.to).trim() === '' ? cfg.defaultPeer : a.to
    const target = resolveTarget(to, meId)
    if (target.ok !== true) return { ok: false, text: target.message }
    const mode = a.mode === 'steer' ? 'steer' : 'queue'
    const throttled = rateLimited(meId, target.id, wait === true)
    if (throttled !== '') return { ok: false, text: throttled }
    const peerStatus = statusOf(target.id)
    const busy = peerStatus === 'running'
    const round = nextRound(meId, target.id)
    const corr = rid()
    const rec = { corr: corr, kind: wait === true ? 'ask' : 'note', fromLabel: senderLabel(meId), text: clip(text, cfg.maxText), t: now(), msgId: 'bus-' + corr, round: round }
    if (rec.kind === 'ask') {
      anchors.set(rec.msgId, { corr: corr, askerId: meId, targetId: sid(target.id), label: target.label, seq: null, turn: null, texts: [], sentAt: rec.t, question: clip(text, 200) })
    }
    const sent = deliver(target.id, rec, mode)
    if (sent.ok !== true) {
      if (rec.kind === 'ask') anchors.delete(rec.msgId)
      return { ok: false, text: '投递失败：' + sent.message }
    }
    if (rec.kind === 'ask') noteOpenAsk(corr, meId, target.id, clip(text, 200), rec.t)
    push({ t: rec.t, dir: 'out', corr: corr, kind: rec.kind, me: meId, peerId: target.id, peerLabel: target.label, status: wait === true ? 'waiting' : 'sent', excerpt: clip(text, 200) })
    if (wait !== true) {
      return { ok: true, status: 'sent', corr: corr, text: '已投递给 ' + target.label + '（corr=' + corr + '，mode=' + mode + '，发出 ' + fmtLocal(rec.t) + '）。对端当前 ' + peerStatus + '；需要答复请用 peer_ask。' }
    }
    let asked
    if (typeof a.timeoutMs === 'number' && isFinite(a.timeoutMs) && a.timeoutMs > 1000) asked = Math.min(a.timeoutMs, cfg.maxAskMs)
    else asked = busy === true ? cfg.busyWaitMs : cfg.defaultAskMs
    return new Promise(function (resolve) {
      const entry = { resolve: resolve, timer: undefined, askerId: meId, targetId: target.id, label: target.label, question: clip(text, 200), sentAt: rec.t, settled: false, timedOut: false, cancelled: false }
      pending.set(corr, entry)
      entry.timer = ctx.timeout(function () {
        const p = pending.get(corr)
        if (p === undefined || p.settled === true || p.cancelled === true) return
        p.settled = true
        p.timedOut = true
        const tail = busy === true
          ? '对端现在是 running（正在跑自己的一轮），你的消息已进它的 inbox 排队，预计不会很快答复。'
          : '对端可能仍在处理。'
        p.resolve({
          ok: true,
          status: 'timeout',
          corr: corr,
          text: '已等 ' + Math.round(asked / 1000) + ' 秒未收到 ' + target.label + ' 的答复（提问时间 ' + fmtLocal(rec.t) + '）。' + tail
            + '\n答复到达时会以【会话间答复】进入本会话，带着你原问题的原文与耗时，不需要你再问一遍；'
            + '已不需要可用 peer_cancel(corr="' + corr + '") 撤回，看时间线用 peer_inbox(thread="' + target.label + '")。',
        })
      }, asked)
    })
  }

  function render(args, value) {
    const t = value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : String(value)
    return [{ type: 'text', text: t }]
  }
  function register(definition) {
    const tool = Object.assign({ output: { schema: OUT_SCHEMA, render: render } }, definition)
    ctx.effect(function () { return tools.register(tool) }, 'dsh-session-bus: ' + definition.name)
  }

  register({
    name: 'peer_self',
    description: '查看本会话在「会话总线」里的身份，以及当前可作为对端的其他存活会话（同进程的另一个标签页）。',
    parameters: { type: 'object', properties: {} },
    execute: async function (args, exec) {
      const meId = exec !== undefined && exec.agent !== undefined ? sid(exec.agent.id) : ''
      const peers = livePeers(meId)
      const lines = []
      lines.push('我：' + (meId === '' ? '（无会话上下文）' : senderLabel(meId) + ' · id=' + meId + ' · 状态=' + statusOf(meId)))
      lines.push('本端标识 self=' + sid(cfg.self) + '；可寻址的其他存活会话：' + peers.length + ' 个')
      if (peers.length === 0) lines.push('（暂无 —— 在另一个标签页新建/打开一个会话后即可互发消息）')
      for (const p of peers.slice(0, 12)) lines.push('· ' + p.label + ' · 状态=' + p.status + ' · ' + activityOf(p) + (p.cwd === '' ? '' : ' · cwd=' + p.cwd))
      lines.push('用法：peer_ask(to="other", text="…") 提问并等答复；peer_send(to="other", text="…") 只通知；peer_list 看完整 id。')
      return { ok: true, status: meId === '' ? 'no-context' : 'ok', text: lines.join('\n') }
    },
  })

  register({
    name: 'peer_list',
    description: '列出本 dsh 进程内其他存活会话（完整 session id、状态、工作目录、活跃/创建时间）。状态 running 表示它正忙，这时 peer_ask 会自动改成短等待后转异步。',
    parameters: { type: 'object', properties: {} },
    execute: async function (args, exec) {
      const meId = exec !== undefined && exec.agent !== undefined ? sid(exec.agent.id) : ''
      const peers = livePeers(meId)
      if (peers.length === 0) return { ok: true, status: 'empty', text: '当前没有其他存活会话。请在同一 dsh web 的另一个标签页打开第二个会话。' }
      const lines = ['存活对端会话 ' + peers.length + ' 个（活跃过的排前面）：']
      for (const p of peers) {
        lines.push('· ' + p.label + '\n    id=' + p.id + '\n    状态=' + p.status + ' · ' + activityOf(p) + (p.cwd === '' ? '' : '\n    cwd=' + p.cwd))
      }
      lines.push('提示：to="other" 即选最近活跃的那个；也可以直接给 id、id 片段、标题子串或配置里的别名。')
      return { ok: true, status: 'ok', text: lines.join('\n') }
    },
  })

  register({
    name: 'peer_send',
    description: '向另一个存活会话投递一条消息，不等待答复（通知/触发对端干活）。对端在它自己的回合边界处理：空闲则立刻起一轮，忙碌则排队。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标会话：完整 id、id 片段、标题子串、配置别名，或 "other"（默认，除我之外最近活跃的会话）' },
        text: { type: 'string', description: '要投递的正文（会以【会话间消息】信封包好交给对端）' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue=排队不打断（默认）；steer=插到对端最近一个 step 边界' },
      },
      required: ['text'],
    },
    execute: async function (args, exec) { return sendTo(args, exec, false) },
  })

  register({
    name: 'peer_ask',
    description: '向另一个存活会话提问并等待答复。对端空闲时默认等 90 秒；对端 running（正忙）时自动只等 10 秒就返回并转异步——答复会以【会话间答复】进入本会话（带原问题原文、提问/答复时间与耗时）。对端显式 peer_reply 会立刻返回；否则在对端这一轮结束时自动捕获其最终文本。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标会话：完整 id、id 片段、标题子串、配置别名，或 "other"（默认）' },
        text: { type: 'string', description: '要问对方的问题（越具体越好，对端会当作同事请求处理）' },
        timeoutMs: { type: 'number', description: '显式指定最长等待毫秒数（默认：对端空闲 90000，对端 running 10000；上限 300000）' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue=排队不打断（默认）；steer=插到对端最近一个 step 边界' },
      },
      required: ['text'],
    },
    timeoutMs: DEFAULTS.maxAskMs + 30000,
    execute: async function (args, exec) { return sendTo(args, exec, true) },
  })

  register({
    name: 'peer_reply',
    description: '答复另一个会话用 peer_ask 发来的提问。corr 取那条【会话间消息】里的 corr 字段；答复会立刻回到对方的 peer_ask 工具结果里。',
    parameters: {
      type: 'object',
      properties: {
        corr: { type: 'string', description: '入站消息信封里的 corr 值' },
        text: { type: 'string', description: '给你的答复内容（结论优先，必要时分点；不必自己写时间戳，总线会自动附上）' },
      },
      required: ['corr', 'text'],
    },
    execute: async function (args, exec) {
      const a = args === undefined || args === null ? {} : args
      const corr = String(a.corr === undefined || a.corr === null ? '' : a.corr).trim()
      const text = clip(String(a.text === undefined || a.text === null ? '' : a.text).trim(), cfg.maxText)
      if (corr === '' || text === '') return { ok: false, text: 'corr 与 text 都不能为空。' }
      const meId = exec !== undefined && exec.agent !== undefined ? sid(exec.agent.id) : ''
      const outcome = routeReply(corr, senderLabel(meId), text, meId)
      if (outcome === 'unknown') return { ok: false, text: '找不到 corr=' + corr + ' 对应的待答复提问（可能已答复、已超时或来自更早的进程）。' }
      if (outcome === 'canceled') return { ok: false, text: '对方已撤回 corr=' + corr + ' 这条提问，答复未被投递。' }
      push({ t: now(), dir: 'out', corr: corr, kind: 'reply', me: meId, peerId: '', peerLabel: 'asker', status: outcome, excerpt: clip(text, 200) })
      return { ok: true, status: outcome, corr: corr, text: '已回传答复（corr=' + corr + '，' + outcome + '）。' }
    },
  })

  register({
    name: 'peer_cancel',
    description: '撤回一条还在等待答复的 peer_ask：对端之后即使答复了也不会再注入本会话（避免陈旧答复事后打断时间线）。',
    parameters: {
      type: 'object',
      properties: { corr: { type: 'string', description: 'peer_ask 返回的 corr' } },
      required: ['corr'],
    },
    execute: async function (args, exec) {
      const a = args === undefined || args === null ? {} : args
      const corr = String(a.corr === undefined || a.corr === null ? '' : a.corr).trim()
      if (corr === '') return { ok: false, text: 'corr 不能为空。' }
      const meId = exec !== undefined && exec.agent !== undefined ? sid(exec.agent.id) : ''
      const p = pending.get(corr)
      const ask = openAsks.get(corr)
      const question = p !== undefined ? p.question : (ask !== undefined ? ask.question : '')
      markCancelled(corr)
      markAnswered(corr)
      if (p !== undefined) {
        if (p.settled !== true) {
          // 撤回一条仍被 peer_ask 等待的提问：必须让那个工具调用立刻收口，否则它只能干等工具层超时
          p.settled = true
          p.cancelled = true
          if (typeof p.timer === 'function') { try { p.timer() } catch (e) { /* ignore */ } }
          p.resolve({ ok: true, status: 'canceled', corr: corr, text: '这条提问已被本会话撤回（corr=' + corr + '），对端之后即使答复也会被丢弃。' })
        } else {
          p.cancelled = true
          if (typeof p.timer === 'function') { try { p.timer() } catch (e) { /* ignore */ } }
        }
        pending.delete(corr)
      }
      for (const entry of anchors) { if (entry[1].corr === corr) anchors.delete(entry[0]) }
      push({ t: now(), dir: 'out', corr: corr, kind: 'cancel', me: meId, peerId: '', peerLabel: 'asker', status: 'canceled', excerpt: clip(question, 160) })
      return { ok: true, status: 'canceled', corr: corr, text: '已撤回 corr=' + corr + (question === '' ? '' : '（原问题：' + clip(question, 80) + '）') + '；对端稍后答复也会被丢弃并在 peer_inbox 标记 canceled。' }
    },
  })

  register({
    name: 'peer_inbox',
    description: '查看会话总线的往来与时间线：谁在等我答复、我在等谁答复、最近的收发记录；用 thread 可以只看与某一个对端的成对往来（含耗时）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少条最近记录，默认 10，上限 50' },
        all: { type: 'boolean', description: 'true=返回本进程所有会话的往来（调试用），默认只看和我相关的' },
        thread: { type: 'string', description: '只看与某个对端的往来：对端 id、id 片段或标题子串' },
      },
    },
    execute: async function (args, exec) {
      const a = args === undefined || args === null ? {} : args
      const meId = exec !== undefined && exec.agent !== undefined ? sid(exec.agent.id) : ''
      const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.min(Math.floor(a.limit), 50) : 10
      const lines = []
      const waiting = []
      const mineInbound = []
      for (const entry of pending) {
        const v = entry[1]
        if (v.askerId === meId && v.settled !== true) waiting.push(entry[0] + '（问 ' + v.label + '，' + durText(now() - v.sentAt) + '前）')
      }
      for (const entry of openAsks) {
        const v = entry[1]
        if (v.targetId === meId && v.answered !== true) mineInbound.push(entry[0])
      }
      lines.push('我：' + (meId === '' ? '（无会话上下文）' : senderLabel(meId)) + ' | 现在 ' + fmtLocal(now()))
      lines.push('我正在等答复（' + waiting.length + '）：' + (waiting.length === 0 ? '无' : waiting.join('、')))
      lines.push('别人在等我答复（' + mineInbound.length + '）：' + (mineInbound.length === 0 ? '无' : mineInbound.join('、')))
      const thread = a.thread === undefined || a.thread === null ? '' : String(a.thread).trim()
      let rows
      if (thread !== '') {
        rows = log.filter(function (r) {
          return r.peerId === thread || r.peerLabel === thread || (r.peerLabel || '').indexOf(thread) >= 0
        }).slice(-limit)
        lines.push('与 "' + thread + '" 的往来（' + rows.length + ' 条，按时间顺序）：')
      } else {
        rows = log.filter(function (r) { return a.all === true || r.me === meId }).slice(-limit)
        lines.push('最近记录（' + rows.length + ' 条）：')
      }
      if (rows.length === 0) lines.push('（无）')
      for (const r of rows) {
        lines.push('· ' + fmtLocal(r.t) + ' [' + r.dir + '/' + r.kind + '] ' + r.status + ' corr=' + r.corr + '\n    ' + clip(r.excerpt, 160))
      }
      return { ok: true, status: 'ok', text: lines.join('\n') }
    },
  })

  ctx.on('session/event', onSessionEvent)

  console.log('[dsh-session-bus] 已启动：self=' + sid(cfg.self)
    + '，agents=' + (agents === undefined ? '缺失' : '可用')
    + '，已注册 7 个工具（peer_self/peer_list/peer_send/peer_ask/peer_reply/peer_cancel/peer_inbox，全局可见）')
}
