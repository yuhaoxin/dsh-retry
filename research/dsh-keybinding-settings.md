# DSH 快捷键注册表、设置菜单承载面与重试能力

- 研究对象：DeepSeek Harness 0.2.1-rc.2，安装于 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
- 核查日期：2026-10-19
- 取证方法：asar 归档路径不是真实目录（bash/glob/grep 均报 `Not a directory`），只有 DSH 自带 `read` 工具可读。把 `dsh/node_modules/@deepseek-ai` 只读导出到临时目录后即可 grep；下文 `@deepseek-ai/<pkg>/<path>` 即该包内路径。
- 证据分级：**【服务契约】**= `cordis_inspect_query` 的 host Service/Event 目录；**【源码】**= 导出后的 `lib/*.js` 与随包生成的 `lib/typert.host.js`、`api-catalog.js`；**【文档】**= 包内 README / `references/`；**【真机未证】**= 见第 7 节

## 结论速览

| 问题 | 结论 |
| --- | --- |
| 有统一的快捷键注册表吗 | **有**，Client 侧 `ctx.shortcuts`（`@deepseek-ai/dsh-client-shortcuts`），插件用 `register()` 注册动作与默认键 |
| 键位存哪 | web：`localStorage["dsh.keybindings.v1"]`；desktop：Electron 桥 `window.dshDesktop.shortcuts`。两者互不回退 |
| 键位在 UI 哪里改 | DSH 自带快捷键面板（`shortcuts.open`，默认 `Cmd/Ctrl+\``），是**独立模态**，不是 `settings.section` 页面 |
| 冲突提示 | 注册表自带：`describeBinding()` 返回 `conflicts`，`edit()` 返回 `conflict`/`stale`/`unreadable` 等状态 |
| 插件配置如何进设置菜单 | 必须手写 `settings.section` 槽位组件；`Config` schema 的 `autoGenerate` **当前没有任何已发布客户端消费** |
| 配置落盘与生效 | profile 的 `cordis.patch.yml`（YAML），原子写、`applies: "live"` 热生效；被 home patch / 命令行 overlay 覆盖时拒绝写入 |
| DSH 有没有 `/retry` 或重放上一轮的接口 | **没有**。只有自动重试 `dsh-llm-retry`；slash 命令、UI 按钮、Host 重放接口都不存在 |
| 手动唤醒 agent 的公开入口 | 只有 `followup`/`steer`（都会落一条 surface `user/message`）与 `inject`（不唤醒）；surface 日志只追加、无删除 API |

---

## 1. 快捷键注册表：`ctx.shortcuts`

**【源码】** 服务定义 `@deepseek-ai/dsh-client-shortcuts/lib/client.js`：`ShortcutsService`（`static inject = ["locale"]`），构造时 `super(ctx, "shortcuts")`，插件里即 `ctx.shortcuts`。注册表类 `ShortcutRegistry`。

- `register(command)` → 返回幂等 disposer；`registerFixed(command)` 注册不可改键的固定绑定；`observeFixedInput(listener)`。
- `describeBinding(binding)` → `{ binding, keys, issue, conflicts }`。
- `edit(...args)` → `{ status, snapshot }`，`status ∈ saved | stale | conflict | unreadable | write-failed | not-ready`。
- 注册期硬校验会抛错：`Duplicate shortcut command`、`Unsupported Web shortcut`、`Reserved shortcut default`、`Conflicting shortcut defaults`、`Unsupported shortcut code`、`Shortcut keys must be distinct`。

**【源码】** 命令定义形状：

```js
ctx.shortcuts.register({
  id: "myplugin.retry",          // 必填；正则要求至少含一个点
  label: () => t("retry"),       // 必填，thunk 每次投影重读，跟随语言
  aliases: ["retry last turn"],  // 可选
  defaults: {                    // 可选；键必须是 `${runtime}:${platform}`
    "desktop:macos": { code: "KeyR", modifiers: ["alt"] },
    "web:macos": { code: "KeyR", modifiers: ["alt"] },
  },
  regions: ["page", "editable"], // 必填："page" | "editable" | "terminal"
  modals: [],                    // 必填；modal 不符即 blocked
  resolve: (context) => ({ status: "handled", run: () => {} }),
});
```

- `id` 正则 `^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$`；DSH 现有 id 形如 `settings.open`、`sidebar.left.toggle`、`response.stop`，**没有 `app.*` 命名空间**。
- binding 形状 `{ code, modifiers, secondCode? }`；`code` 限 `Key[A-Z]` / `Digit[0-9]` / `F1..F24` 或 `Slash Comma Period Backslash Backquote Minus Equal BracketLeft BracketRight Semicolon Quote Enter Escape Space Tab Backspace Delete Arrow*`。
- `modifiers` 取 `primary|control|alt|shift|meta`；**`primary` 在 macOS 解析为 `meta`，其他平台为 `control`**（即 `primary` 就是"平台主修饰键"）。
- `resolve(context)` 返回 `{status:'pass'}` | `{status:'handled', run}` | `{status:'blocked', reason}`；`context` = `{ region, modal, target }`。

**【源码】** 输入路由 `installKeyboard(window, shortcuts, fixed, native)`：`window.addEventListener("keydown", capture, true)`；region 判定 `.xterm → terminal`、`input/textarea/select/[contenteditable] → editable`、其余 `page`；modal 取最上层 `modalSelector` 的 `dataset.shortcutModal`；IME 组合态与 AltGraph 被拦下。

**【源码】** 落盘文档格式（schemaVersion 2）：

```json
{ "schemaVersion": 2,
  "profiles": { "desktop:macos": { "settings.open": { "code": "Comma", "modifiers": ["primary"] }, "my.id": null } } }
```

值为 `null` 表示显式移除绑定；编辑操作 `{type:"set"|"reset"|"reset-all"}`；写入前重读 + 冲突复检 + revision 校验。

**【源码】** 保留键拒绝清单 `bindingIssue`：`modifier-required`（无修饰键或仅 shift）、`reserved`（`Escape Tab Space Backspace Delete Arrow*`、不带 alt 的 `Enter`、`primary+C/V/X/Z/Y/Q/H`、不带 shift 的 `primary+A`、非 mac 的 meta、mac 的 `Ctrl+Meta` 等）、`unsupported-key`、`unsupported-browser`（web 白名单只有 `primary+Slash`、`primary+shift+Comma`、`primary+shift+Period` 等少数组合）。

**【源码】** DSH 现有可改键动作：`sidebar.left.toggle`、`settings.open`、`shortcuts.open`、`sidebar.right.toggle`、`pane.split`、`pane.fullscreen.toggle`、`page.<kind>`、`terminal.new`、`browser.new`、`workspace.files`、`workspace.openLocal`。固定不可改：`response.stop`（`Esc Esc`）、`approval.allow/reject`、输入框固定序列（`fixed.send`/`newline`/`slash`/`mention`）。

**【源码】** **Host 侧没有键位注册表**：`@deepseek-ai/dsh-client-shortcuts/lib/index.js` 全文 23 行，只有 `Config = { stopSequenceMs }` 与一条 `webserver/index-inject` 注入 `__DSH_SHORTCUTS_CONFIG__`。

**【源码】** **已装第三方插件里没有一个注册键位**：在 profile 的 `node_modules` 下 grep `shortcuts.register|registerFixed` 零命中 —— 本插件会是第一个。

## 2. 设置菜单承载面

**【文档】** `@deepseek-ai/dsh-settings/README.md`：`Each form reports autoGenerate, enabled by default, for clients that build pages from the schema; **no shipped client does so yet**.` 想出现在设置页的插件必须自己注册页面（`configure({ auto: false }, ctx.fiber)`），官方 `settings` 服务的 `describe()` 会返回 `{ autoGenerate, ns, schema, revision, applies: "live", value, base, user }`。

**【源码】** 客户端**没有** JSON-Schema → 表单的通用渲染器（对 `JSONSchema|schemaToFields|SchemaForm|autoForm|ConfigField` 全树搜索无命中）。

**【服务契约】** 设置页槽位：

```
key: "settings.section", kind: "list", scope: "root",
registerOptions: id(required string) | order(optional number, 默认 0) | label(optional string | (() => string))
ownerProps: { close: () => void }
```

**【源码】** 真实插件最小示例（第三方 `dsh-plugin-shop`，已装）：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "shop", order: 17,
  label: () => ctx.locale.bind(NS)("title"), locale: NS, inject: injected,
}, ShopSection));
```

`dsh-notify-me` 同形，并额外用 `ctx.effect(() => ctx.locale.register(NS, { zh, en }))` 注册运行期词典。本仓库既有插件（`dsh-workspace-git-status`、`dsh-omp-stats`）都没有设置页。

**【服务契约】** Host `settings` 服务：`describe(options?)` / `update(ns, patch, expectedRevision?)` / `mutate(ns, ops, expectedRevision?)` / `replace(...)` / `prepareDocument()`；客户端侧 `ctx.configForms` + `ctx.remote.settings.mutate(ns, ops, revision)`。

**【源码】** Config schema 用 `@deepseek-ai/schemastery` 3.18.5：`string/number/boolean/any/const/bitset`、`array/dict/tuple/object/union/intersect/transform/lazy`、`natural/percent/date/regExp`，修饰 `.default/.required/.min/.max/.pattern/.role/.volatile/.hidden/...`。**`.volatile()` 是设置表单唯一会渲染的字段类别。**

**【源码】** i18n 两套互不相通：包根 `locale/<lang>.json` 只读 `{"meta":{"title","description"}}`（`dsh-app-boot` 的 `readPluginMeta`），支持语言只有 `zh`/`en`；组件词典必须内联在 client bundle 里用 `ctx.locale.register(NS, {zh, en})`。

**【源码】** 配置存放与生效：活动 profile 的 `cordis.patch.yml`（顶层 YAML 数组，`- id: <entry id>` → `config:`）。`dsh-config-editor` 用 `parseDocument` 定位/更新，保留注释与 `!!js`，`writeFileAtomic(mode 0o600)`，失败回滚后再 reconcile。被 home patch 或命令行 overlay 覆盖时**拒绝写入**并抛错。写盘后 `reconcileProfilePatches` 热组合，`applies: "live"`；与 HMR 用 `hmr.runExclusive` 串行。例外：替换已安装包需要重启才能加载新的 JS 生成（`references/host-plugin.md`）。

## 3. 客户端插件加载与打包

**【源码】** manifest（本仓库既有插件同形）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "platform": "web", "immediately": true, "inject": [] } }
```

`platform` 只有 `"web"` 被解析为 client 半身；声明了 `dsh.client` 就必须导出 `./client`，否则抛 `declares dsh.client but exports no "./client" bundle`。

**【源码】** `client.js` 是浏览器 bundle，壳固定为：

```js
window.__ModuleLoader__.load({ id: 'dsh-retry', factory(require) { /* 返回 { inject, apply } */ } });
```

**不强制构建**：`dsh-workspace-git-status` 手写 826+ 行 client.js 无构建脚本；`dsh-omp-stats` 用 bun 打 CJS 再套壳。

**【源码】** 宿主 `dsh-client-modules` 扫描 `dsh.client`、组装 boot graph，在 `/plugins` 路由下发，浏览器懒物化（注册只入 factory 队列，副作用在 materialize 时跑）。

**【源码】** Client HMR（`dsh-client-hmr`）按 mtime/size 轮询重写后的 bundle 并广播 `graph`/`rebuilt`，前提是组合挂了它（`dsh-web-app` 恒挂）**且有东西真的重写 `lib/client.js`**（即 `pnpm run dev:web` 之类的 watcher）。本仓库既有口径：改 `client.js` 刷页面；改 `index.js` 或 `src/host/**` 需重启 DSH 进程。

**【源码】** 命令面板：客户端 `dsh-client-ui-commands` 注册表 + Host `ctx.commands`（`CommandDefinition = { name, description, input?, recordInput?, handler }`），客户端用 `remote.commands.execute` 调用。

## 4. DSH 现有重试能力盘点

**【源码】** 唯一重试是自动重试 `@deepseek-ai/dsh-llm-retry`：挂在 `agent/request-error` waterfall 上；`Config = z.object({})`（本插件自身无配置，`retryPolicy` 属于各 provider 配置）。

- 判定只看 `failure.code` 字符串，不看 `failure.status`；默认可重试码 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`。
- 默认 `maxRetries = 5`，`initialDelayMs = 500`，`maxDelayMs = 10000`，`jitterRatio = 0.1`；指数退避封顶 1024 次幂。计数只对同一 `[provider, policyKey]` 连续。
- `mode: "always"` 时无次数上限地重试任何失败（含 auth/quota 这类永久失败），只在下游返回 `{kind:'retry'}` 时跟随。
- 恢复成功时 append `llm/retry`、`llm/retry-started` 事件并返回 `{kind:'retry'}`。

**【源码】** **不存在** `/retry` 之类的 slash 命令、UI 按钮或 Host 重放接口：Host 命令注册点只有 `compact/feedback/goal/permission/plan/export`；全树搜 `重新生成|重新发送|重放` 零命中；`grep retry` 命中的唯一 UI 是**只读**状态行（`dsh-client-ui-chat` 的 `ModelRetryItem`，由 `llm/retry` 事件构造，无 onClick）。

**【服务契约】** 可用的 Agent 接口（`dsh-api-session-controller/lib/typert.host.js`）：

```ts
interface Agent {
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
  send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void;
  followup(message: UserMessage): void;   // next-turn + 唤醒
  steer(message: UserMessage): void;      // next-step + 唤醒
  inject(message: UserMessage): void;     // next-step，不唤醒
}
```

`dsh-agent/README.md`：`cancel()` 默认清空 inbox；**没有"只中止 step、保留 turn"的接口**。

**【源码】** Session 面只有 `append`（只追加）、`surface.nodes`、`deriveMessages()`、`eventAt/snapshotEvents`、`toolHistory()`；**没有删改历史的 API**。surface 事件类型只有 `system/developer/user/assistant/message` 与 `tool/result`；失败或被重试的尝试写成 `assistant/attempt`，**不进模型历史**（`dsh-session/README.md`）。

因此：**请求失败那一轮在 DSH 里本来就不留 surface 痕迹**；而**被中断那一轮会写 `assistant/message {interrupted:true}` 并留在上下文里**（先前研究已实测）。

**【服务契约】** `agent/request-error`（waterfall）：

```ts
'agent/request-error'(this: Scoped<Agent>, payload: {
  agent; turn; step; provider; failure: LlmFailure;
  retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal
}, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
// RequestErrorAction = { kind: 'retry' } | undefined
```

loop 调用点逐字：`const action = await this.dispatch.waterfall("agent/request-error", {...}, () => Promise.resolve(void 0)); signal.throwIfAborted(); if (action?.kind !== "retry") throw new LlmError(...); continue;` —— 任何不是 `{kind:'retry'}` 的返回都是终局。

**【服务契约】** `llm/stream`（waterfall）：`(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>`；监听器可 `next()` 取 adapter 流，或自己 yield chunk 短路。

**【源码】** **没有任何 Host 服务重放上一轮助手回复**：`ctx.compaction.compactRegion` 是把一段 surface 节点替换成 summary，不重发请求；`ctx.sessions.fork(source, boundary, childSessionId)` 把事件复制进新子会话，不重跑；全系统唯一重新执行路径是 loop 收到 `{kind:'retry'}` 后的 `continue`。

## 5. 与本次目标的直接冲突

1. 「重放上一条失败/被中断的助手回合」在 DSH **没有现成承载面**：既不能删掉/替换中断留下的那条 `assistant/message`（surface 只追加），也没有"不新增消息就继续"的唤醒入口（`followup`/`steer` 都会落一条 surface `user/message`，`inject` 不唤醒）。
2. 想不新增用户消息，就只能依赖自动重试那条路（`agent/request-error` 返回 `{kind:'retry'}`），而它只在**失败的 attempt 正在跑**时存在，对"回合已经结束、用户事后想重来"无效。
3. 「快捷键在设置菜单里改」与 DSH 现状有两处落差：键位编辑在**独立模态**（`shortcuts.open`）而不是设置页；设置页要出现插件自己的内容必须手写 `settings.section` 组件（`autoGenerate` 无消费者）。

## 6. 版本兼容与打包约束

**【源码】** 运行时版本 `0.2.1-rc.2`（预发布）。兼容判定只看 `engines.dsh`（semver range，含预发布）：**存在则单独决定，peerDependencies 被忽略**；否则逐个检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peerDependencies（`workspace:^|~|*` 视为当前运行时）。不满足即阻断安装/激活，可用精确版本豁免绕过。已装第三方插件里**没有一个用 `engines.dsh`**，DSH 自带包全用 peerDependencies 钉版本。

## 7. 真机未证

1. **Client inspect 在子代理会话全部超时**（Lead 会话已重跑成功，见文末补充节）；结论来自随包生成的目录（`dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API`，100 条）与真实插件源码。
2. asar 内 `lib/types/*.d.ts` 不存在；TS 签名取自生成的 `typert.host.js` / `api-catalog.js`，未与上游源码交叉校验。
3. `settings.section` 的 `label` thunk 重读时机、第三方 section 在设置导航里拿到的图标（id 闭集，第三方只得通用齿轮）未真机验证。
4. `autoGenerate` 无消费者属**否定性结论**（README 原文 + 全树搜不到渲染器），未在运行实例上确认 `settings.describe()` 对第三方 entry 的实际返回。
5. `pnpm run dev:web` 的确切定义不在 asar 内；Client HMR"必须有重建 watcher"只有文档级证据。
6. **Desktop 键位落盘路径未证实**：desktop 走 Electron 预加载桥，磁盘位置在 asar 外；只确证 web 用 `localStorage["dsh.keybindings.v1"]`。
7. 重试是否有 loop 侧第二道上限未证实（只确证 `dsh-llm-retry` 侧默认 5）。
8. 客户端除 `remote.session.prompt` 外是否还有别的触发模型请求的路径未穷尽（PTC `run_code`、subagent prompt 都绕过 session 面）。
9. DSH 是否给"重放上一轮"留了隐藏入口未证实（`ChatNodeOwnerProps.forkAt` 与 `message.branch` 是"新开分支"，不是重放）。

## 补充：Lead 会话的 live inspect 复核（2026-10-19）

子代理会话里 Client inspect 全部超时；在 Lead 会话重跑成功，以下为 live 结论，修正上文第 7 节第 1 条。

- `settings.section`（list, root）契约与生成目录一致；实时占用者：`account`(-10)、`general`(0)、`models`(10)、`plugins`(15)、`agent-presets`(20)、`dsh-notify-me`(45)、`better-sidebar`(100)。
- **`settings.general.item` 里已经有 shipped 的 `shortcuts` 行（order 16）**，由 `ui-settings-general` 注册并喂 `ctx.shortcuts.catalog`：该包 `lib/client.js:1070` 注入 `"shortcuts"`、`:1135` 传 `shortcuts: ctx.shortcuts.catalog`。因此注册到 `ctx.shortcuts` 的动作会自动出现在「设置」→「通用」→「快捷键」，**不需要自写设置页**。
- Client Service 目录（inspect）**不含 `shortcuts`**（查询报 `no catalogued Service named "shortcuts"`），但源码与 shipped 插件用法证实它可用：`ctx.inject(["shortcuts"], (scope) => scope.shortcuts.register(...))`，见 `ui-settings-general:1070/1187`、`ui-shortcuts:1095`、`ui-theme:1955`、`ui-conversation:19609`、`ui-approval:320`、`sidebar-browser:1547`、`sidebar-files:948`。inspect 目录只覆盖有生成契约的 Service，`shortcuts` 不在其中。
- 键位校验边界（`register()` 对 6 个 profile 逐个校验）：`bindingIssue` 在 desktop macos/windows 直接返回 null；`F5` 这类无修饰键绑定在 `desktop:linux` 与全部 web profile 上被 `modifier-required` 拒绝；web 只允许 `primary+Slash`、`primary+shift+Comma`、`primary+shift+Period`（win/mac 另允许 3–4 修饰键、含 `primary` 的两修饰键组合）。`defaults` 是每个 profile **一个** binding，不支持一个动作多默认键。
- `alt+r` 与现有 shipped 默认不冲突：唯一含 `KeyR` 的是 `sidebar.right.toggle` 的 `primary+alt+KeyR`，修饰键集合不同，`overlappingBindings` 判定不重叠。
