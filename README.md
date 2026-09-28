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
- **图形界面选目标**：侧栏里的「会话总线」标签可以**多选**本会话能通信的会话，不用再在对话里打字指定名字（见下）；
  面板可挂在 DSH 内置右侧栏，也可注册成 dsh-better-sidebar 的标签页（数据走插件自己的只读路由）
- 依赖极简：只用 DSH 既有的 `agents` / `tools` / `commands` / `sessionProjections` / `sessionTitle` / `timer` 服务，外加一个 `zod`（投影单元的 stateSchema / wire.viewSchema —— 宿主契约要求的就是 zod schema，冷读时会直接调它的 `.parse`）

## 图形界面：多选可通信的会话

- **入口**：侧栏自己的标签菜单 —— better-sidebar 里点它侧栏的「+」选「会话总线」；
  DSH 内置右侧栏里点「新标签页」再选「会话总线」。（v0.3.3–v0.3.5 曾在输入框那一行插一个 🔗 图标按钮，
  面板变成常驻标签后它只是重复入口，v0.3.6 删掉了。）
- **面板体有两个落点，同一份渲染**：
  - 装了 [dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar) 时 → 注册成它的标签页
    （`ctx.get('betterSidebar').registerTab({ id, title, description, icon, order, single, component })`，
    惰性取服务、不缓存；`title`/`description`/`icon` 传函数，语言切换后「+」菜单跟着变；`single: true` 让同一会话只留一个标签）。
    打开它：按钮调 `betterSidebar.openTab({ type: 'dsh-session-bus', title }, { sessionId })`
    —— 注意 0.22.1 的 `openTab(seed, scope?)` 收的是**标签实例种子**（`seed.type` = 注册的 tab id），不是 id 字符串；
    也可以直接在侧栏的「+」菜单里选「会话总线」。
    数据走宿主只读路由 `GET /session-bus/catalog` + `GET /session-bus/allow`（面板打开时 3 秒轮询刷新，
    `visible === false` 时不轮询），写入走 `ctx.get('remote').commands.execute(sessionId, '/session-bus allow <id…>', [], signal)`；
    服务晚到（插件激活顺序不保证）时会补注册，此时两个落点都在
  - 没装时 → 现状实现：DSH **内置右侧栏标签页**（`sidebar.right.pane.tab`，标签类型由
    `ctx.get('sidebarRight').register({id, kind})` 定义，用 `sidebarRight.openTab(kind)` 打开），
    数据走 DSH 槽位 props（`useSessions` / `useWorkspaces` / `useProjection`），写入走 `props.inputActions`
- 面板内：会话**按工作区分组、可折叠**（与侧边栏一致），行上是标题（+ 内置版还有相对时间），正在运行的带黄点；
  已勾选的分组默认展开；归档与 subagent 会话不列
- **不限 / 清空 / 应用 / 取消**：点「应用」会替你提交 `/session-bus allow <会话id…>`
  （或 `/session-bus clear`），回执说明「现在就能通信 / 当前未打开（打开后自动生效）」
- **写入失败如实渲染**：会话正忙（`session/writer-held`）显示「会话正忙，稍后重试」，其余错误带错误码；
  拿不到 `ctx.remote` 时也会明说，不会静默假装成功
- 选中的会话就是本会话的**允许清单**：`peer_send` / `peer_ask` 只能发给清单内的会话，
  清单外会被明确拒绝；`peer_list` / `peer_self` 会标出 `✅允许` / `⛔未允许`；清单为空 = 不限制
- 面板**不显示"是否存活"**：v0.3.0 起未附着的会话会在投递时按需唤醒
  （宿主仍保留只读诊断路由 `GET /session-bus/live`，界面不再使用）

## 宿主只读路由（面板的数据来源）

三条路由都走同一套信任围栏：非 `GET`/`HEAD` → 405，不可信请求 → 403（Host 必须是 loopback、
不能是 `cross-site`、带 `Origin` 时必须与 `Host` 一致），响应一律 `Cache-Control: no-store`。
真正的边界仍是 `dsh web` 只绑 `127.0.0.1`。

| 路由 | 返回 | 说明 |
| --- | --- | --- |
| `GET /session-bus/live` | `{live: [会话id], at}` | 宿主当前存活的顶层会话 id（诊断用） |
| `GET /session-bus/catalog?session=<id>` | `{session, workspaces, sessions, at}` | 面板目录。工作区给 `workspaceId/标题/path/sessionIds`，会话只给 `id/标题/running/attached/归档` —— **字段白名单，不透出 cwd、事件、日志内容**；`session` 参数只用于剔除自己 |
| `GET /session-bus/allow?session=<id>` | `{session, ids, unrestricted, at}` | 该会话允许清单的**真值**（就是 `selectionOf()` 的结果）；缺参数 400，会话不在本进程 404 |

实现细节：会话目录 = `workspaceRegistry.list()` ∪ `ctx.sessions.list()` ∪ `sessionQuery.listSessions()`
（这样「还没打开的历史会话」与「不属于任何工作区的会话（面板显示为未分组）」都能列出来）；
未附着会话的标题用 `sessionQuery.readTitleSnapshots()` **一次批量**读，标题与持久化目录各带 15s / 10s TTL 缓存。
`workspaceRegistry` / `sessions` / `sessionQuery` 刻意**不进 `inject`**：它们只被这两条只读路由用到，
缺失时降级（空工作区、空标题），不能因为一个可选读服务缺失就让整条消息总线拒绝激活。

## 按需唤醒（allowResume，默认开）

目标会话**未附着**（没有任何打开的页面连上它）时，插件会先唤醒它再投递：

- 实现：`sessionController.resolveAgent(sessionId)` —— 与客户端「打开一个会话」**同一条路径**，
  preset 挂载、模型选择、日志卷载都由会话控制器负责（不自己拼 preset，避免挂错环境）
- 触发点：`peer_send` / `peer_ask` 指定**完整 session id**（面板勾选写入的就是完整 id），
  或该 id 在允许清单里
- 同一次唤醒只跑一遍（并发去重）；唤醒失败会如实带出控制器错误
- 关掉它（`allowResume: false`）：只投给已附着的会话；未附着的会明确告知「等它打开后自动生效」
- 代价如常：唤醒意味着那个会话开始一轮真实模型调用（token），并且它会一直附着到进程结束

## 工作语义

1. **投递** = `ctx.agents.get(targetId).followup(手写 UserMessage)`：对端空闲则立刻起一轮；对端 `running` 则进它的 inbox 排队，等它自己那一轮结束。
2. **答复双保险**：①对端显式 `peer_reply` → 立刻回到调用方的工具结果；②否则监听全局 `session/event`，在**对端处理该消息的那一轮** `turn/end` 时自动捕获该轮最后一段 assistant 文本回传。
3. **时间轴自描述**：所有时间都是本机本地时间（带偏移）；每条异步答复都带原问题、两个时间点与耗时。
4. **忙闲自适应**：投递前查对端 `status`，`running` 时只等 `busyWaitMs` 就转异步，不堵住调用方自己的轮次。
5. **防乒乓用限速，不用状态机硬拦**：见下方设计笔记。

## 验证

```bash
npm test                 # 两个套件都跑
node test/smoke.mjs      # 宿主半：162 项
node test/client.mjs     # 浏览器半：46 项（不需要浏览器）
```

`test/smoke.mjs` 用一个假宿主（假 `ctx` / `agents` / `sessions` / `workspaceRegistry` / `sessionQuery` /
`sessionTitle` / `tools` / `timer` / `webServer`）跑 162 项检查，覆盖：工具注册与 **schema 子集**
（安装后最容易踩的加载期失败点）、投递、显式答复、兜底捕获、忙闲自适应、目标不存在、限速、撤回
（含撤回仍在等待中的提问）、超时后迟到答复注入、`peer_inbox` 时间线、投影单元契约（zod 的 `.parse` 冷读路径）、
以及三条只读路由的可信 200 / 不可信 403 / 非 `GET`/`HEAD` 405 / 缺参 400 / 未知会话 404、
目录字段白名单、未附着标题批量读取与 TTL 缓存。

`test/client.mjs` 在假 `window.__ModuleLoader__` / 假 React（**带 useState/useEffect 与重渲染**）/
假 Cordis ctx / 假 `fetch` 下加载 `lib/client.js`，跑 45 项检查：模块与插件形状、内置落点的注册
（**不再往输入框插按钮**）、内置版面板的分组与 `inputActions` 写入、better-sidebar 落点的 `registerTab`
（函数标题 / 单例 / 图标 / 晚到补注册）、
面板数据确实来自 `/session-bus/catalog` + `/session-bus/allow`（没有任何槽位 props） 、
「应用」确实走 `remote.commands.execute(sessionId, 命令行, [], signal)`、
`session/writer-held` 渲染成「会话正忙，稍后重试」、没有 `ctx.remote` 时如实报错。

真机验证（2026-09-28，DSH 0.1.7-rc.2 + dsh-better-sidebar 0.21.1）：

- 宿主两路由在真进程上 200：`catalog` 返回 2 个工作区 / 66 行会话 / 12.5KB（冷读 18ms、TTL 内 8ms），
  `allow` 返回 `{ids, unrestricted}`；围栏实测 非 loopback Host → 403、POST → 405、缺参 → 400。
- better-sidebar 落点的**真实渲染已在浏览器里确认**：侧栏标签栏出现「会话总线」标签，
  面板按工作区分组（`dsh 12 / Python 31 / 未分组 1`，= 目录 66 行 − 归档 22），
  底部有「刷新」键（只有宿主路由版才有）→ 走的是 `/session-bus/catalog` + `/session-bus/allow`。

改完**浏览器半**不需要重启 `dsh web`：用 plugin_manager 对 `include:session-bus` 做一次
「禁用 → 启用」重算组合，然后刷新页面即可。改**宿主半**通常要重启；但实测**安装/升级任何 bundle**
触发的整轮重算会连宿主模块一起重新 import —— 那次装 better-sidebar 之后，新的只读路由当场就 200 了。

真机验收清单：

- [ ] 重启后日志出现 `[dsh-session-bus] 已启动`
- [ ] 任一会话里问模型「你有 peer_ask 工具吗」→ 能看到 7 个工具
- [ ] 两个标签页：A 里说「问一下另一个会话：你的工作目录是什么」→ A 的 `peer_ask` 结果里出现 B 的答复
- [ ] B 侧出现一条【会话间消息】并作答（可选：B 用 `peer_reply` 显式回）
- [ ] 让 B 跑一个长任务，再从 A `peer_ask` → A 只等 10 秒返回「已排队」，任务结束后答复自动进入 A
- [ ] A 里 `peer_inbox(thread="B的标题")` 能看到成对往来与耗时
- [ ] 侧栏「+」菜单（better-sidebar）或「新标签页」（内置侧栏）→ 面板列出会话并分组；勾选 + 应用后 `peer_list` 显示 `✅允许`
- [ ] `curl -s 'http://127.0.0.1:3080/session-bus/allow?session=<会话id>'` 能看到刚应用的 ids

## 已知限制

- **单进程**：两个会话必须在同一个 `dsh` 进程里（同一台 `dsh web`）。
- **better-sidebar 落点不显示「相对时间」**：宿主目录路由只给 id/标题/running/归档，
  宁可不显示也不显示错的。
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
7. **投影单元的 schema 必须是 zod，不能拿 schemastery 顶替**：`ProjectionDefinition.stateSchema` / `wire.viewSchema` 在契约里是 `ZodType`，宿主（dsh-session-projection 的 `restore()`，由 dsh-session-query 冷读历史会话时经 `hydrate()` 调用）会直接 `stateSchema.parse(row.val)` 与 `wire.viewSchema.parse(state)`。schemastery 的 `Schema` 实例只有 `.resolve()` / `~standard`，**没有 `.parse`** → 抛 `def.wire.viewSchema.parse is not a function`，被 dsh-session-query 包成 `failed to project session "session-…"`，web 端表现为**所有会话的历史加载失败**（一个单元坏掉，整份投影读不出来）。官方插件同理：`dsh-tool-todo` 用 schemastery 写 `Config`、用 zod 写投影 schema。修法：投影 schema 换成 `z.object({...})`。
8. **面板数据别绑死在宿主槽位 props 上**：DSH 槽位给的 `useSessions` / `useWorkspaces` / `useProjection` / `inputActions` 只在内置 UI 里存在。一旦面板要搬到第三方侧栏（dsh-better-sidebar），取数就得改走**自己的只读路由**、写入改走 `ctx.remote.commands.execute` —— 否则「换个容器」会变成「重写面板」。本包的做法是：渲染只有一份（`PanelView`），取数/写入各两套，落点由 `ctx.get('betterSidebar')` 是否存在决定。
9. **`remote.commands.execute` 的调用形态**：客户端生成的方法有两种形态 —— 调用方 ctx 本身带 agent 身份时走 **scoped**（业务参数只有 `line` + 附件），否则走 **direct**（第一个业务参数是 session id）。DSH 自己的浏览器代码（`dsh-client-ui-commands`、`dsh-api-session-controller` 的 client 半）一律用 `execute(sessionId, line, attachments)`，本包照抄这一种；传错形态不会静默出错，客户端会直接抛参数个数/类型错误。
10. **面板块「刷新」的成本要自己管**：面板 3 秒轮询两条路由，宿主侧必须给「读历史日志」这类操作加 TTL 缓存（本包：标题 15s、持久化目录 10s），否则开着面板就等于每 3 秒把历史会话日志重读一遍。

## 更新记录

- **v0.3.5** — 面板与宿主 UI 解耦（方向 A）：
  - 宿主新增两条只读路由 `GET /session-bus/catalog`（工作区 + 会话目录，字段白名单）与
    `GET /session-bus/allow`（允许清单真值 `{ids, unrestricted}`）；未附着会话标题批量读 + TTL 缓存；
    `selectionOf(agent)` 拆出 `selectionOfSession(session, id)` 供路由复用。冒烟测试 135 → 162 项。
  - 浏览器半新增 **dsh-better-sidebar 适配**：装了就把面板注册成它的标签页，
    数据走上面两条路由、写入走 `remote.commands.execute`，**不再依赖 DSH 槽位 props**；
    没装则保持内置右侧栏实现。写入失败如实渲染（`session/writer-held` → 「会话正忙，稍后重试」）。
    客户端测试 18 → 46 项；随后按真包源码修正契约（`openTab` 收标签实例种子、函数标题/图标、单例）→ 49 项。
  - 真机验收：profile 装入 dsh-better-sidebar 0.21.1（0.22.1 被 pnpm 的 release-age 策略挡下，两版相关 API 一致），
    两条只读路由与标签页渲染均在真进程 / 真浏览器里确认（详见「验证」一节）。
- **v0.3.6** — 清掉迭代过程中留下的死代码：删掉输入框那一行的 🔗 入口按钮（面板已是常驻标签，
  那个按钮只是重复入口；连带删掉只服务它的 `OpenButton`/`openPanel`/CSS/`all` 文案，改动覆盖 4 项断言 →
  新增「不再往输入框插东西」的反向断言），并删掉投影 `wire.view` 里早已没人读的 `live` 存活表字段
  （v0.3.4 起面板就不显示存活标记，而视图每次 `turn/start` 都要重算 —— 等于每轮白走一遍 agents 注册表；
  需要「谁现在开着」仍可用只读诊断路由 `GET /session-bus/live`）。客户端测试 49 → 45 项。
- **v0.3.0 – v0.3.4** — 面板迭代：搬进右侧栏标签页（v0.3.2）、入口缩成纯图标按钮（v0.3.3，v0.3.6 已删）、
  修「标签不注册 —— 改用 `ctx.inject` 等服务出现」（v0.3.4）、会话按工作区分组可折叠、去掉存活标记与轮询；
  投递侧新增**按需唤醒**（`allowResume`，默认开）。
- **v0.2.1** — 修「投影 schema 用错库」导致的历史加载失败：`sessionBus` 投影的 `stateSchema` / `wire.viewSchema` 从 `@deepseek-ai/schemastery` 换成 `zod`（宿主契约是 `ZodType`，冷读时会调 `.parse`）。此前 web 端打开任何历史会话都会报 `failed to project session "session-…": def.wire.viewSchema.parse is not a function`。冒烟测试新增投影契约断言（防回归），运行时依赖由 schemastery 换成 zod。
- **v0.2.0** — 新增浏览器半：输入框左侧「会话总线」多选面板 + `/session-bus allow|clear|all|list` 命令；允许清单由会话日志投影（`sessionBus` 的 `wire.view`）驱动，并作为 `peer_send` / `peer_ask` / `peer_list` / `peer_self` 的准入依据。新增 `@deepseek-ai/schemastery` 依赖（投影状态 schema）。
- **v0.1.1** — 修静态化后的加载竞态：`tools`/`agents` 改为硬依赖（`inject`），`sessionTitle` 惰性读取。（v0.1.0 在真实宿主上会打印 `tools 服务不可用，插件未注册任何工具`）
- **v0.1.0** — 首个版本：7 个工具、投递/答复双保险、本地时间轴、忙闲自适应、按会话对限速、撤回。

## License

[MIT](./LICENSE)
