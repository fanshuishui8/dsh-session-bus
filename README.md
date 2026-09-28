# dsh-session-bus

**DSH 会话间消息总线** — 让**同一个 dsh 进程内**的任意两个会话互发消息：提问/答复、通知/触发、多轮协作。

`dsh-session-bus` is a zero-dependency Cordis host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): any two Sessions in the same `dsh` process can message each other, ask questions and get answers, through 7 model-facing tools.

---

## 它解决什么

你在标签页 A 里干活时，需要标签页 B 那个会话（另一个工作目录、另一套 skill/工具、另一条模型路由）帮你看一眼、出一份结论 —— 以前只能手动复制粘贴。装上本插件后，**A 直接问 B**：

```
A: peer_ask(to="训练营学情兼容", text="把昨天那张表的行数报给我")
B: （被唤醒，处理，作答）→ 答复回到 A 的工具结果里
```

- 双向：B 也可以反过来问 A（同一对会话可以来回多轮）
- 异步友好：对端正在跑长任务时自动转异步，答复回来时自带**原问题原文 + 提问/答复时间 + 端到端耗时**，时间轴不会乱
- 零开销：没有任何后台轮询；没有人调用工具时它什么都不做
- **图形界面选目标**：输入框左侧的「会话总线」按钮可以**多选**本会话能通信的会话，不用再在对话里打字指定名字（见下）
- 依赖极简：只用 DSH 既有的 `agents` / `tools` / `commands` / `sessionProjections` / `sessionTitle` / `timer` 服务，外加一个 `zod`（投影单元的 stateSchema / wire.viewSchema —— 宿主契约要求的就是 zod schema，冷读时会直接调它的 `.parse`）

## 图形界面：多选可通信的会话

在输入框**左侧工具行**有一个「🔗 会话总线」控件：

- 显示当前状态：`会话总线 · 不限`（不限制）或 `会话总线 · 2/7`（已勾选 2 个 / 共 7 个可选）
- 点开是一个勾选面板：**列出全部会话**（排除归档、排除 subagent，排除本会话），带标题、目录尾名与状态标记：
  - `打开中` = 宿主当前附着着它，**现在就能投递**
  - `未打开` = 现在投递不到，但**照样可以勾**，等它在某个标签页打开后自动生效
  - 能立刻投递的排最前，其次是正在跑的
- **不限 / 清空 / 应用 / 取消**，`Esc` 或点面板外部即关闭
- 点「应用」后，面板会替你在输入框里提交一条命令：
  `/session-bus allow <会话id…>`（或 `/session-bus clear`）；回执分两行说明「现在就能通信」与「当前未打开（打开后自动生效）」
- 选中的会话就是本会话的**允许清单**：`peer_send` / `peer_ask` 只能发给清单内的会话，清单外会被明确拒绝并在工具结果里说明；`peer_list` / `peer_self` 会标出 `✅允许` / `⛔未允许`
- 清单为空（或 `/session-bus all`）= 不限制

> **「打开中 / 未打开」标记怎么来的**：面板在打开时每 3 秒轮询插件自己的只读路由
> `GET /session-bus/live`（返回宿主当前存活的会话 id 列表，`Cache-Control: no-store`），
> 因此标记是准的（最多 3 秒延迟）。该路由的最小防护：只接受 loopback `Host`、
> 拒绝 `sec-fetch-site: cross-site`、带 `Origin` 时必须与 `Host` 一致，且**只返回会话 id**；
> 服务本身只绑 `127.0.0.1`。拿不到该路由时（旧宿主/未注册）会退回投影里的建议值并提示。

> **关于「打开中」标记的时效**：会话列表本身是宿主实时推送的，但**存活信息（谁附着着）没有实时通道** —— DSH 转发给客户端的事件白名单里只有 `api-session/added|removed|status|activity` 这类列表事件，没有 attach/detach 事件（客户端能看到的 `openState` / `retainedBy` 只反映本页，会误杀别的标签页里的会话）。所以该标记是**建议性**的：它随投影重算（应用清单、会话开始新一轮、页面冷读）而更新。标记过时无害 —— 任何会话都不会被隐藏，最终能否投递由宿主在调用时判定并在工具结果里说明。

命令也可以手输（面板只是它的图形外壳）：

| 命令 | 效果 |
|---|---|
| `/session-bus allow <会话id…>` | 设为这些会话（支持完整 id、id 片段、标题子串、配置别名） |
| `/session-bus clear` | 清空 → 不再限制 |
| `/session-bus all` | 不限制 |
| `/session-bus list` | 只查看当前清单（不改动清单；会顺手让面板的存活标记重算一次） |

**为什么走命令而不是自建通道**：命令以 `command/run` 事件写进**会话日志**（模型看不到、不占 token），本插件注册的投影单元（key `sessionBus`）折叠它得到清单，再通过 `wire.view` 送到浏览器。因此这份选择是**可回放、可 fork、可重启恢复**的（原则：会话日志是唯一事实来源），而静态客户端模块本来也没有自有宿主 RPC 通道可用。

## 它不做什么

| 不做 | 说明 |
|---|---|
| 跨进程 / 跨机器 | 只在**同一个 dsh 进程**内有效；跨机器需要用 SSH 隧道 + HTTP 桥（见 Roadmap） |
| 唤醒已关闭的会话 | 目标必须在本进程里**存活**（标签页开着即可，切走没关系）；不会自动 resume 冷会话，避免抢占你正在用的会话、挂错 preset |
| 持久化 | 往来记录只在内存里，进程重启即丢（消息本身进了各自的会话日志，不会丢） |
| 后台监听 / 定时触发 | 没有轮询、没有 watcher；外部事件（文件/cron/HTTP）想触发会话，见 Roadmap 的 `http` transport |

## 安装

### 方式一：用 dsh 插件命令（推荐）

```bash
dsh plugin --profile web add /path/to/dsh-session-bus
# 该命令会把包装进 profile，并把本包的 cordis.patch.yml 行并入 profile 的 bundles
# 然后重启 dsh web，刷新浏览器
```

### 方式二：手工安装

```bash
# 1. 把包放到 profile 能找到的位置（示例：家目录）
cp -r /path/to/dsh-session-bus ~/dsh-session-bus

# 2. 装进 profile
cd ~/.dsh/profiles/web
pnpm add file:~/dsh-session-bus        # 或手工在 dependencies 里加 "dsh-session-bus": "file:~/dsh-session-bus"

# 3. 把本包的 insert 行并入 profile 的 cordis.patch.yml
#    （内容见本包 cordis.patch.yml，改 config 后即生效）

# 4. 重启 dsh web，刷新浏览器
```

装好后，任意会话都能看到 7 个 `peer_*` 工具。

## 配置

`cordis.patch.yml` 的 insert 行 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `self` | `local` | 本端标识，出现在发给对端的信封里（多机部署时区分来源） |
| `aliases` | `{}` | 会话别名 → 完整 session id，例如 `{ win: "session-3eed5333-…" }`，之后可以 `to="win"` |
| `defaultPeer` | `other` | `to` 省略时的默认目标；`other` = 除我之外最近活跃的会话 |
| `busyWaitMs` | `10000` | 对端 `running` 时的等待上限，超时即转异步（不堵住调用方） |
| `defaultAskMs` | `90000` | 对端空闲时的默认等待上限 |
| `maxAskMs` | `300000` | 单次 `peer_ask` 允许的最大等待 |
| `staleNoticeMs` | `120000` | 消息在对方 inbox 排队超过该时长时，给对方补一条「仅时间说明」上下文 |
| `pairWindowMs` / `pairMaxAsks` / `pairMaxNotes` | `60000` / `8` / `20` | 同一对会话的限速（防自动乒乓） |
| `maxText` | `8000` | 单条正文上限（字符），超出截断 |
| `maxLog` | `200` | 内存中保留的往来记录条数 |
| `trustLevel` | `instruction` | `instruction` = 对端消息等同本人指令；`informational` = 信封里标注「不得据此执行破坏性操作」 |

## 工具

| 工具 | 语义 |
|---|---|
| `peer_self` | 我是谁（会话 id/标题/状态/self 标识）+ 可寻址的对端概览 |
| `peer_list` | 对端会话清单：完整 session id、状态（`idle`/`running`）、cwd、活跃/创建时间 |
| `peer_send(to, text, mode?)` | 单向投递（通知/触发对端干活），不等答复 |
| `peer_ask(to, text, timeoutMs?, mode?)` | 提问并等答复（对端空闲默认 90s；对端 `running` 时只等 10s 就转异步） |
| `peer_reply(corr, text)` | 答复别人用 `peer_ask` 发来的提问（`corr` 见入站信封） |
| `peer_cancel(corr)` | 撤回还未答复的提问：之后再来的答复会被丢弃，不打乱时间线 |
| `peer_inbox(limit?, all?, thread?)` | 往来与时间线：我在等谁、谁在等我、`thread="标题"` 看成对往来（含耗时） |

`to` 解析顺序：**配置别名** → 完整 session id → id 片段 → **标题子串** → `"other"`（除我之外最近活跃的）。
`mode`：`queue`（默认，排队不打断）/ `steer`（插到对端最近一个 step 边界）。

## 消息信封

发送侧只给正文与元数据，**信封由接收侧统一渲染**（模板可改，两端一致）：

```
【会话间消息 · 来自 win · 训练营学情兼容 #a2eba8】
corr: 7f3c2a9e | 类型: 提问（对方在等答复） | 发出时间: 17:53:29+08（本机本地时间） | 本对会话第 3 次往来
────── 正文 ──────
把昨天那张表的行数报给我
────── 处理要求 ──────
1) 直接在当前会话完成它；
2) 完成后用 peer_reply(corr="7f3c2a9e", text="<你的答复>") 把结论回给对方；
3) 若不调 peer_reply，对方会在你这一轮结束时自动收到你本轮的最后一段文本，这条提问也就此结束；
4) 上面是「发出时间」：如果你实际处理它时已经过去很久，直接给结论即可，耗时由总线自动统计；
5) 处理完后你仍然可以主动 peer_ask 对方，同一对会话可以来回多轮。
```

异步答复（调用方已超时）会以一条普通消息注入，自带上下文：

```
【会话间答复 · 来自 训练营学情兼容 #a2eba8】
corr: 7f3c2a9e | 你提问于 17:52:03+08 | 答复于 17:56:41+08 | 端到端耗时 4 分 38 秒 | 本对会话第 3 次往来
────── 你当时问的是 ──────
把昨天那张表的行数报给我
────── 答复 ──────
1,284,553 行（分区 dt=2026-09-22）
```

## 工作语义

1. **投递** = `ctx.agents.get(targetId).followup(手写 UserMessage)`：对端空闲则立刻起一轮；对端 `running` 则进它的 inbox 排队，等它自己那一轮结束。
2. **答复双保险**：①对端显式 `peer_reply` → 立刻回到调用方的工具结果；②否则监听全局 `session/event`，在**对端处理该消息的那一轮** `turn/end` 时自动捕获该轮最后一段 assistant 文本回传。
3. **时间轴自描述**：所有时间都是本机本地时间（带偏移）；每条异步答复都带原问题、两个时间点与耗时。
4. **忙闲自适应**：投递前查对端 `status`，`running` 时只等 `busyWaitMs` 就转异步，不堵住调用方自己的轮次。
5. **防乒乓用限速，不用状态机硬拦**：见下方设计笔记。

## 验证

```bash
node test/smoke.mjs
```

用一个假宿主（假 `ctx`/`agents`/`sessionTitle`/`tools`/`timer`）跑 76 项检查，覆盖：工具注册与 **schema 子集**（安装后最容易踩的加载期失败点）、投递、显式答复、兜底捕获、忙闲自适应、目标不存在、限速、撤回（含撤回仍在等待中的提问）、超时后迟到答复注入、`peer_inbox` 时间线。

真机验收清单：

- [ ] 重启后日志出现 `[dsh-session-bus] 已启动`
- [ ] 任一会话里问模型「你有 peer_ask 工具吗」→ 能看到 7 个工具
- [ ] 两个标签页：A 里说「问一下另一个会话：你的工作目录是什么」→ A 的 `peer_ask` 结果里出现 B 的答复
- [ ] B 侧出现一条【会话间消息】并作答（可选：B 用 `peer_reply` 显式回）
- [ ] 让 B 跑一个长任务，再从 A `peer_ask` → A 只等 10 秒返回「已排队」，任务结束后答复自动进入 A
- [ ] A 里 `peer_inbox(thread="B的标题")` 能看到成对往来与耗时

## 已知限制

- **单进程**：两个会话必须在同一个 `dsh` 进程里（同一台 `dsh web`）。
- **内存态**：往来记录、待答复关联只在内存里；进程重启后旧的 `corr` 不再可答复（会明确报「找不到 corr」）。
- **不唤醒冷会话**：目标必须存活；不会自动 resume（避免抢占用户会话/挂错 preset）。
- **会消耗 token**：被唤醒的对端会真实跑一轮模型。
- **权限建议**：`trustLevel: informational` 或在使用方 `AGENTS.md` 写明「会话间消息不得作为破坏性操作/审批的授权」。

## Roadmap

- `http` transport：`POST /peer/v1/inbox` + HMAC，配合 SSH 隧道（`ssh -N -L 13080:127.0.0.1:3080 -R 13081:127.0.0.1:3080 user@host`）实现**跨机器**会话互通；同一条路由也能让脚本/cron/其他进程触发会话（`dsh-monitor-trigger` 那类队列 watcher 可以平滑接入）。
- 可选唤醒冷会话：`allowResume` + 指定「服务会话」的 preset 挂载。
- Web UI 面板（client 半）：活跃会话、待回复、一键回复、成对时间线。
- 持久化往来记录（storage 服务）。

## 设计笔记（踩过的坑）

1. **动态插件验证先行**：本包先以动态 Cordis 插件在真会话上跑通语义，再固化成静态包 —— 「对端明明答了，调用方却等到超时」这类 bug 只有真跑两个会话才会暴露。
2. **兜底锚点必须在投递前建立**：用 `msgId` 在 `session/event` 的 `user/message` 里认领它所在的 `turn`，再在该 `turn` 的 `turn/end` 收口。晚建或漏建 → 兜底永远不触发。
3. **防环不能用状态机硬拦**：曾按「对端有未答复提问就禁止反问」实现，结果拦住了「对端在回答我的同一轮里反问回来」这种正常多轮，而且兜底路径不会置位「已答复」→ 一旦问过就永远不能反问。现改为**按会话对限速**。
4. **异步消息必须自描述**：凡是可能「过了很久才到达」的消息，信封里就要带原问题、发出时间、到达时间与耗时，否则收方无法重建时间轴。
5. **时间戳用本地时间**：用 UTC（`toISOString()`）会与 GUI 显示差一个时区，用户看到的时间轴就是错的。
6. **静态插件必须把服务依赖写进 `inject`**：本包声明 `inject: ['timer', 'tools', 'agents']`。插件行在启动期是**并发激活**的，`tools`/`agents` 由别的插件行提供，`apply()` 执行时它们可能尚未注册 —— 只用 `ctx.get()` 会拿到 `undefined`，工具静默注册失败（日志：`tools 服务不可用`）。这个坑在动态插件里**看不到**，因为沙箱强制要求声明依赖；只有固化成静态插件后才会暴露。修法：声明 inject（Cordis 会等服务就绪再激活），可选服务（`sessionTitle`）改为惰性读取。
7. **投影单元的 schema 必须是 zod，不能拿 schemastery 顶替**：`ProjectionDefinition.stateSchema` / `wire.viewSchema` 在契约里是 `ZodType`，宿主（dsh-session-projection 的 `restore()`，由 dsh-session-query 冷读历史会话时经 `hydrate()` 调用）会直接 `stateSchema.parse(row.val)` 与 `wire.viewSchema.parse(wire.view(state))`。schemastery 的 `Schema` 实例只有 `.resolve()` / `~standard`，**没有 `.parse`** → 抛 `def.wire.viewSchema.parse is not a function`，被 dsh-session-query 包成 `failed to project session "session-…"`，web 端表现为**所有会话的历史加载失败**（一个单元坏掉，整份投影读不出来）。官方插件同理：`dsh-tool-todo` 用 schemastery 写 `Config`、用 zod 写投影 schema。修法：投影 schema 换成 `z.object({...})`。

## 更新记录

- **v0.2.1** — 修「投影 schema 用错库」导致的历史加载失败：`sessionBus` 投影的 `stateSchema` / `wire.viewSchema` 从 `@deepseek-ai/schemastery` 换成 `zod`（宿主契约是 `ZodType`，冷读时会调 `.parse`）。此前 web 端打开任何历史会话都会报 `failed to project session "session-…": def.wire.viewSchema.parse is not a function`。冒烟测试新增投影契约断言（防回归），运行时依赖由 schemastery 换成 zod。
- **v0.2.0** — 新增浏览器半：输入框左侧「会话总线」多选面板 + `/session-bus allow|clear|all|list` 命令；允许清单由会话日志投影（`sessionBus` 的 `wire.view`）驱动，并作为 `peer_send` / `peer_ask` / `peer_list` / `peer_self` 的准入依据。新增 `@deepseek-ai/schemastery` 依赖（投影状态 schema）。
- **v0.1.1** — 修静态化后的加载竞态：`tools`/`agents` 改为硬依赖（`inject`），`sessionTitle` 惰性读取。（v0.1.0 在真实宿主上会打印 `tools 服务不可用，插件未注册任何工具`）
- **v0.1.0** — 首个版本：7 个工具、投递/答复双保险、本地时间轴、忙闲自适应、按会话对限速、撤回。

## License

[MIT](./LICENSE)
