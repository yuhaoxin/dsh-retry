# DSH：让已结束的回合重新跑一次模型请求

- 研究对象：DeepSeek Harness 0.2.1-rc.2
- 核查日期：2026-10-19
- 证据：静态源码读自导出的 asar 树（`@deepseek-ai/<pkg>/<path>`，`app.asar` 内同路径一致）；Host 契约用 `cordis_inspect_query` 核实。**Client inspect 两次 10s 超时**，客户端结论只基于随包生成清单与调用点源码。

## 结论速览

| 问题 | 结论 |
| --- | --- |
| 事后重跑一次请求的唯一原语 | 往 inbox 放一条 `UserMessage` 并唤醒 driver；只有 `Agent.followup` / `steer` / `send(..., true)` 会唤醒 |
| 存在"空唤醒"吗 | 不存在。`send` 必然先 `inbox.splice`，会按 `message.id` 查重 ⇒ 唤醒必然留下至少一条 `user/message` 且进 surface |
| 推荐通道 | 注册 Host 命令，handler 里 `invocation.agent.followup(createUserMessage({ content, source:{ kind: 'cordis-host-runner' } }))`；客户端用 `remote.commands.execute(sessionId, '/retry', [])` 触发 |
| 界面代价 | `source.kind !== 'user'` 的 user/message 渲染为 `context` 节点；若该批 claim 唤醒了回合则为 **turn-trigger 卡片**（不是用户气泡） |
| 完全不可见的唤醒 | 做不到。要可见就得有 inbox 消息，要么用户气泡、要么 turn-trigger 卡 |
| 中断留下的部分输出 | 重跑时**一定会**被 `deriveMessages()` 带上；排除只能"自备替换内容做 surface replace"或"fork 换会话" |
| 事后复用 `{kind:'retry'}` | 不可行作为唤醒手段；且无条件 retry 会因 step 内 `while(true)` 不重读 inbox 而空转 |

---

## 1. 唯一原语：inbox + 唤醒

**【源码】** `dsh-agent-loop/lib/index.js:800-814`：`followup(input){ this.send(input,"next-turn",true) }`、`steer(input){ this.send(input,"next-step",true) }`、`inject(input){ this.send(input,"next-step",false) }`。只有 `wakeup === true` 的两个会唤醒 driver。

**【源码】** 同文件 `:189-194`：`send` 先走 `inbox.splice`，splice 对每条插入按 `message.id` 查重 —— 因此不存在"只唤醒不带消息"的入口。

**【源码】** `ctx.agents.resume` **不产生请求**：`resumeWith` → `setupAndPublish` → `initializeAgent`（只被 `runMaintenance` 包住 setup）→ `publish`（只 enter/announce），全程没有 `wakeDriver`（`:1786-1804`、`:1915-1956`、`:1963-2019`）。它唯一写日志的副作用是给崩溃尾巴补 `interruptedTurnClosers`（`dsh-session/lib/types/repair.js:35-78`）。它的价值是"把冷会话变热"，不是重跑。

**【源码】** `agent.inject` 不唤醒（`wakeup=false`），空闲时只留一条 `agent/inbox/spliced`。用途是"在同一次唤醒里附带隐形载荷"。

**【源码】** loop 内部没有未公开的唤醒路径：`agent/pre-step` waterfall 只在 turn 已开后调用；`agent/request` waterfall 只改 config、不改 messages（`:1191`、`:1274-1288` 用的是 `session.deriveMessages()`）；`runMaintenance` 是唯一的"非 turn 的 LLM 请求"通道（官方 compaction 用它），但产物是 `compaction/*`，不进对话历史。

## 2. 推荐通道与各入口判定

**【源码】** 客户端 `remote.session.prompt({sessionId, mode:'queue'|'steer', content})` 也可行（`dsh-api-session-controller/lib/index.js:925-966`，`mode==='steer' ? agent.steer : agent.followup`），但它的 source 是 `kind:'user'`（`user-rpc` 条目的 kind 就是 `user`）⇒ **界面上与真人输入无法区分的用户气泡**。返回 `{accepted:true}`，`requestId` 幂等。

**【源码】** 注册 Host 命令的链路：远端参数 0 是 `{source:'lookup', lookup:'agent'}`（`dsh-commands/lib/typert.host.js:64-131`），该 lookup 由 `dsh-api-session-controller/lib/index.js:189-193` 配成 `resolveAgent` → `resolve()`（`:221-244`），**冷会话会自动 resume**；handler 拿到 `invocation.agent`（`dsh-commands/lib/index.js:379-385`）。

| 入口 | 能否事后重跑 | 代价 |
| --- | --- | --- |
| `Agent.followup(msg)` | 能 | 必须带一条消息；非 `user` source 渲染为 turn-trigger 卡 |
| `Agent.steer(msg)` | 能 | 落 next-step，语义是"插到当前步骤前" |
| `Agent.inject(msg)` | 不能（不唤醒） | 只入 inbox |
| `ctx.agents.resume` | 不能 | 只把冷会话变热 |
| `remote.session.prompt` | 能 | 用户气泡，与真人输入无法区分 |
| `remote.commands.execute` → Host 命令 → `followup` | 能 | 需装插件；命令本身只保证 admission，模型请求异步跑 |
| `runMaintenance` | 不是对话请求 | 产物是 `compaction/*` |

**[host 契约]** `commands` 服务：`register(definition): () => void`、`list(agent)`、`find(agent,name)`、`@Remote execute(agent, line, attachments, signal): Promise<CommandExecution | undefined>`。

## 3. 注入消息的形态与渲染

**【源码】** 构造器在 `dsh-llm/lib/types/message.js`：`:34 createMessage`、`:45 createDeveloperMessage`、`:53 createUserMessage`、`:80 createSystemMessage(text)`（source 恒为 `{kind:'system-prompt'}`）。

**【源码】** 事件载荷（`dsh-api-session-controller/lib/typert.host.js:2807`，与 host inspect 一致）：`'user/message': UserMessage`（**不包 turn/step**）；`'developer/message': { turn, step, message, headerSeq? }`（**turn/step 必填**）；`'system/message': { turn, step, message }`；`'assistant/message': { …, interrupted?: true }`。

**【源码】** 运行时校验 `dsh-session/lib/index.js:1194-1219`：id 非空、role 与事件类型匹配、`source.kind` 非空字符串、content 是数组；`system/message` 的 source 只能是 `system-prompt`（`:1208-1211`）；`developer/message` 与 `role:'developer'` 必须同时出现，`headerSeq` 只在含 tool-addition 时合法（`dsh-session/lib/types/surface.js:123-147,265-291`）。

**【源码】** `source.kind` 完整清单 22 项（`dsh-api-session-controller/lib/typert.host.js:2567` 的 `MessageSourceMap`）：`user`、`model`、`tool`、`system-prompt`、`model-selection`、`runtime-context`、`working-directory`、`user-approval`、`ptc-mode`、`tool-registry`、`agent-message`、`subagent-settled`、`skill-invocation`、`compact-checkpoint`、`cordis-host-runner`、`team-message`、`user-question-reply`、`goal`、`plan-mode`、`schedule`、`session-reference`、`webhook`。注意 `user-rpc` 条目的 kind 是 `user`。

**【源码】** 客户端渲染（`dsh-client-ui-chat/lib/client.js`）：

- `:9844-9895`：`user/message` 且 `source.kind === 'user'` 且在 next-step claim 批次 → `steering`；否则 → `user` 气泡。`source.kind !== 'user'` → `context` 节点；若 `waking === true`（`:9865`，或 idleSteer 启发式 `:9862`）→ 改写为 **`turn-trigger` 卡片**。
- `turn-trigger` 标题按 kind（`:7024-7069`）：`goal` / `agent-message` / `team-message` / `subagent-settled` / `webhook` / `schedule` / `tool-jobs` / `cordis-host-runner`（显示为 plugin），默认 `message.trigger.request`。
- `context` 行是 `ContextInjectionRow`（`:4967-5031`）：图标 + producer 标签 + `notice` 摘要（`notice` 需要非空 `source.summary`，否则退化成 opaque）。
- **"不出现在界面上"的官方规则**：`:8200-8202 isVisibleChatNode` —— `context` 节点一律隐藏，除非 content 含 `tool-addition` / `tool-removal`。

**【源码】** 官方同款先例：`dsh-goal-round-driver/lib/index.js:149-164`（`source:{kind:'goal',goalId,revision,round}`）、`dsh-schedule/lib/types/runtime.js:114-121`（`source:{kind:'schedule'}`）。

两条配方：

1. **唤醒 + 提示卡（非气泡）**：`followup` + `source.kind !== 'user'` → turn-trigger 卡片。
2. **唤醒可见、载荷隐形**：`agent.inject(createUserMessage({ content:[载荷], source:{ kind:'cordis-host-runner' } }))` 紧跟一次 `followup(真人来源消息)`；两者同批 claim（`claim()` 先 next-step 再 next-turn，`dsh-agent-loop/lib/index.js:103-111`），`claimedHuman` 因 user 消息置真 ⇒ `idleSteer` 为 false ⇒ 载荷成为被隐藏的 `context`。

**【源码】** `developer/message` 恒渲染为隐藏的 `context`（`:9897-9909`），能进模型历史且界面不可见，但不经 inbox、不能唤醒；`system/message` 可走 `surfaceOp replace`，且是唯一被允许改写 surface node 0 的写入者（`surface.js:382-391`；官方用法见 `dsh-agent-loop/lib/index.js:283-295`）。

## 4. 中断留下的部分输出能否排除

**不能自动排除，重跑时一定会带上。** 中断时只要流里已有闭合块就写 `assistant/message { interrupted: true }` 且带 `surfaceOp:'append'`（`dsh-agent-loop/lib/index.js:1096-1112`）；完全空白才写非 surface 的 `assistant/attempt`（`:1113-1122`）。`deriveMessages()` 只遍历 surface 节点（`dsh-session/lib/index.js:1672-1687`），`deriveEventMessage` 对 assistant/message 只看 `content.length === 0`，**完全不看 `interrupted`**（`surface.js:91-97`）。

逐条评估：

- **`surfaceOp replace` + `sourceEventSeqs`：可行**（官方 compaction 同款，`dsh-compaction-basic/lib/index.js:650-661`）。硬约束：必须 cite 每个被覆盖节点（`surface.js:259-262`）；**`assistant/message` 永远不能携带 `sourceEventSeqs`**（`surface.js:232-234`）⇒ 不存在"assistant/message 型 replace"，只能换一种事件类型当写入者（官方只用 `user/message`）；不能"只删不填"（splice 至少塞 1 个新节点，`:436`）。人类 transcript 仍保留原文（replacements 是 model-only，`surface.js:40-52`）。
- **message projection：不是可用手段**。注册 API `ctx.sessions.registerMessageProjection`，`type` 全局唯一（`dsh-session/lib/index.js:1729-1737`）；投影语义是改写（`if (projected !== undefined) return projected`，`surface.js:76-78`），不能返回"丢弃"。而 `planSurfaceEvent` 的投影分支排在 surfaceOp 之前（`surface.js:399-412`）⇒ 给 `assistant/message` 注册投影会让**所有** assistant 消息都不再进 `nodes`。这是机制事实，不是可用方案。
- **`turn/end` reason 分支：无排除作用**。`TurnEndReasonMap = completed | aborted{reason} | blocked | error{error} | max-tokens | interrupted | forked`；`turn/end` 不是 surface 事件，reason 从不参与历史裁剪。
- **fork：有效**。`remote.session.fork({sessionId, atSeq?})`（`dsh-api-session-controller/lib/index.js:849-872`）：`boundary = atSeq ?? latestCompletedPrefixBoundary`，`seed = buildForkSeed`（`dsh-session/lib/types/fork.js:18-27`）。fork 到中断那条之前 ⇒ 新分支历史里没有它；中途切断会补 `{kind:'forked'}` 的 `turn/end` 与一条"工具结果未知"的合成 `tool/result`（`repair.js:20-23,143-173`）。代价：新 session id，后续事件不继承。

## 5. 客户端 → Host 命令接线

- **[host 契约]** `CommandDefinition = { definitionId?; name /* ^[a-z][a-z0-9_-]*$ */; description /* 非空 */; input?: {hint; attachments?}; recordInput?; handler }`；`CommandInvocation = { commandId; agent; rawInput; attachments; signal }`（frozen）；`CommandResult = {kind:'success'; text?; sourceEventSeq?} | {kind:'error'; text}`；`CommandExecution = { commandId; result }`。
- **【源码】** 落事件：`command/run {commandId,name,args?,source:{kind:'user'}}` → handler → `command/done {commandId,kind,text?,sourceEventSeq?}`；两者都是 log-only 的 `session.append`，**不开 turn、不进 surface**（`dsh-commands/lib/index.js:334-346`）。handler 抛错 → `command/done {kind:'error'}`（`:390-407`）。
- **【源码】** 客户端形态：`ctx.remote.commands.execute(sessionId, line, attachments)`，signal 由协议注入；客户端代理返回 `{ok:true, value: CommandExecution|undefined} | {ok:false, error}`，`value === undefined` 表示语法或名字没匹配（`dsh-client-ui-commands/lib/client.js:1717-1730`）。
- **【源码】** 注册需要 `inject: ["commands"]`（官方 `/goal` 用 `["commands","goals"]`）；handler 里 `invocation.agent` 已可用，session 走 `invocation.agent.session`。官方在 handler 内 followup 的先例：`dsh-command-goal/lib/index.js:98-107`。

## 6. 事后复用 `{kind:'retry'}` 的判定

**【源码】** 触发条件是某次 attempt 真的 `finish.kind === 'error' | 'aborted'`（`dsh-agent-loop/lib/index.js:1128-1146`），且 `:1144 signal.throwIfAborted()` 在检查之前 ⇒ aborted 的 attempt 不能 retry。

**【源码】** 想强制首个 attempt 失败：用 `llm/stream` waterfall 短路（`dsh-llm/lib/index.js:2396-2398`）返回只吐 `{type:'finish', reason:{kind:'error', failure}}` 的 iterable。官方先例 `dsh-compaction-image-offload/lib/index.js:139-145`：先写日志（改变派生历史）→ 成功才返回 `{kind:'retry'}`。

**【源码】** 副作用：retry 循环在 `step()` 内 `while(true)`，**不重跑 `preStep`、不重读 inbox**；`decision.messages` 只在 `firstAttempt` 落盘（`:1067-1074`）。无条件 retry 会让 step 永不结束、用户新消息不被消费，只能 `agent.cancel({kind:'user'},{keepInbox:true})` 打断。

结论：retry 通道的价值是"同一次唤醒里改写历史后立刻重发"，**不能用来事后唤醒**——唤醒那一步本身已经是一次完整请求。

## 7. 未证实

1. **Client inspect 在本轮两次都 10s 超时**：`remote.commands.execute` 的运行时签名、`ctx.shortcuts` 活契约、`conversation.chat.node` 活 Slot 树均未从活客户端核实，客户端结论只基于生成清单与调用点源码。
2. `agent/pre-step` 追加 messages 的 UI 归属是源码推断，未实测。
3. 配方 2（`inject` + `followup`）的隐藏效果未构造真实会话验证。
4. "给 `assistant/message` 注册 projection 会屏蔽全部 assistant 消息"是从 `planSurfaceEvent` 分支顺序推断的机制事实，未实测。
5. `remote.commands.execute` 在"进程重启后无 live agent"的会话上的端到端可用性：源码链（login/resume）已核实，未实际调用；依赖 `dsh-api-session-controller` 已装配且 lookup 未被其它 remote 插件覆盖。
6. **命令执行是否被审批/权限策略拦截未核实**（存在 `dsh-user-approval` / `dsh-permission-presets`）；若目标环境有审批策略，客户端命令调用可能被拦，会影响推荐通道的可用性。
7. `request/header` 在重跑时是否额外写 `reason:'series'` 未验证（只影响日志）。
