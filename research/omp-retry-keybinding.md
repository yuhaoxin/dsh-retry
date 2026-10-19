# omp 重试与键位配置的可移植语义

- 研究对象：oh-my-pi（`can1357/oh-my-pi`，Stencil Labs）
- 核查日期：2026-10-19
- 源码基线：`main` @ `9d5d4ac5b`（版本号 18.12.2）
- 证据分级：**【官方】**= 仓库文件/发布说明/issue/PR 原文；**【代码实证】**= clone 后读到的源码与测试；**【第三方】**= 非官方镜像或文档站

## 结论速览

| 问题 | 结论 |
| --- | --- |
| `/retry` 重放什么 | 上一条 `stopReason` 为 `error` 或 `aborted` 的助手回合；当尾巴恰好是一整批**全部失败**的工具调用时，退化为原地重放该批次 |
| 默认键位 | `app.retry` = `f5` + `alt+r`（两个都是默认；F5 是首选展示键） |
| `Ctrl+Y` | 只是 issue #2790 提议者的建议，**未被采纳**，且在 omp 里已属 `tui.editor.yank` |
| 手动重试次数上限 | 无上限；每次手动重试把自动重试计数器清零，等于获得一份新的自动重试预算 |
| 部分输出 | 手动重试从活动上下文删掉失败 assistant 消息及其合成 tool_result，不再发给模型；持久化 display transcript 里那条失败记录仍在 |
| 已渲染块清理 | 仅工具重放命中时重挂持久化分支（失败结果与 aborted 边界一并消失）；普通失败回合只改活动上下文 |
| 键位配置形态 | `~/.omp/agent/keybindings.yml`，YAML，动作 ID → 和弦或和弦数组；用户绑定**整体替换**默认值，`[]` 表示禁用 |
| 键位能否在 UI 改 | **不能**，只有配置文件；会话内 `/hotkeys` 只能查看 |
| 全局修饰键替换 | **未实现**，issue #7991 仍 open |
| 冲突处理 | 有 `getConflicts()` 但生产代码零调用，**没有用户可见的冲突警告** |
| 许可证 | MIT，允许复制与再分发（只需保留声明），只做行为对齐同样在许可范围内 |

---

## 1. `/retry` 与 `app.retry`

**【代码实证】** `/retry` 定义在 `packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:489`，描述为 `Retry the last failed agent turn`，无参数。进入处理体先判 `runtime.session.isStreaming`，是则回 `Wait for the current response to finish or abort it before retrying.`，否则调 `runtime.session.retry()`，成功输出 `Retrying the last failed turn.`，失败输出 `Nothing to retry.`。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/slash-commands/builtin-lifecycle.ts#L488-L509>

**【官方】** 文档表格：`app.retry` 默认 `F5`, `Alt+R`，含义 `Retry the last failed assistant turn`。
<https://github.com/can1357/oh-my-pi/blob/main/docs/keybindings.md>

**【代码实证】** `packages/tui/src/app-keybindings.ts:164-169` 的 `defaultKeys` 为 `["f5", "alt+r"]`，注释说明 F5 领衔是因为它在所有终端都能原样送达（修饰 Enter 组合会被终端吞掉或折叠成普通 Enter），且 TUI 的空闲提示行 `F5 to Retry` 也是按它展示的。
<https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/app-keybindings.ts#L164-L169>

**【代码实证】** 编辑器侧另有一份 `DEFAULT_ACTION_KEYS`（`packages/tui/src/prompt/custom-editor.ts:147`）同样是 `"app.retry": ["f5", "alt+r"]`，运行期被 `InputController` 用 `setActionKeys("app.retry", keybindings.getKeys("app.retry"))` 覆盖。
<https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/prompt/custom-editor.ts#L135-L151>

**【代码实证】** 两条入口汇合于 `InputController.handleRetry()`：collab 客座会话提示 `/retry is host-only during a collab session`；成功时清空编辑器草稿；失败显示 `Nothing to retry`。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/controllers/input-controller.ts#L1712-L1722>

**【代码实证】** TUI 的 `F5 to Retry` 提示行只在「非 streaming + 尾巴是**被中断的工具调用**」时挂载，键取 `keybindings.getKeys("app.retry")[0] ?? "f5"`。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/interactive-mode.ts#L7908-L7941>

## 2. 两层重放：普通回合 vs 工具批次原地重放

**【代码实证】** 可重试判定 `retryableAssistantTurnEnd`（`turn-recovery.ts:152`）只认尾部 assistant 的 `stopReason` 为 `"error"` 或 `"aborted"`。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/turn-recovery.ts#L152-L181>

**【代码实证】** `TurnRecovery.retry()`（`turn-recovery.ts:3198`）前置条件：`isStreaming()` / `isCompacting()` / `isRetrying` 任一为真即返回 false。随后若活动上下文有可重试尾巴：命中 `toolReplayStart` 则走工具重放，否则 `agent.replaceMessages([...slice(0, turnEnd-1), ...slice(conversationEnd)])` —— 从活动上下文删掉失败的 assistant 消息与它的合成 tool_result。活动上下文里没有可重试尾巴时（重启后的会话会主动把失败轮次剔出 provider 上下文），用持久化 display transcript 判定。最后 `#retryAttempt = 0`（注释：`Reset retry budget for a fresh attempt`），`scheduleAgentContinue({ source: "manual-retry", delayMs: 1 })`。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/turn-recovery.ts#L3190-L3232>

**【官方】** Release v18.0.10（2026-08-28）：
> Added in-place retry for interrupted or failed tool calls: use F5, Alt+R (`app.retry`), or `/retry` to replay an intact failed batch without an additional model round trip.
<https://github.com/can1357/oh-my-pi/releases/tag/v18.0.10>

**【代码实证】** 引入 F5 与原地重放的 commit 是 `423f76b9b2e592926cf65d2b043738e03bc4e855`（2026-08-28），其 diff 正式把 `app.retry.defaultKeys` 从 `"alt+r"` 改成 `["f5", "alt+r"]`。
<https://github.com/can1357/oh-my-pi/commit/423f76b9b2e592926cf65d2b043738e03bc4e855>

**【代码实证】** 工具批次重放的资格判定 `toolReplayStart`（`turn-recovery.ts:183`）的边界：
- 尾部必须是一整批**全部失败/中断**的工具结果，其锚点 assistant 以 `toolUse`/`stop` 结束且参数完整；可选跟一个自身无工具调用的 aborted 边界。
- **部分成功的批次永不命中**（重跑已完成的调用会重复副作用）。
- 合成占位尾巴永不命中（锚点是 aborted 轮次本身、参数可能被截断），这类改成走一次新的模型调用重新生成。
- 结果数量必须等于 assistant 的 toolCall 数，且每个 `toolCallId` 都在集合内、`isError === true`。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/turn-recovery.ts#L169-L209>

**【代码实证】** 「不额外走一次模型往返」的严格含义：测试 `re-executes the aborted tool call instead of re-issuing it via the model` 断言工具真的重跑（`executed === ["again"]`）、模型调用只有 1 次（用于消费新工具结果后的续写），消息序列变成 `user → assistant(toolCall) → toolResult(成功) → assistant`。省掉的是**重新发工具调用**那次往返，工具结果之后的续写调用仍然发生。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/test/agent-session-manual-retry.test.ts#L262-L356>

## 3. 与中断、自动续跑抑制的关系

**【官方】** PR #14831（merged 2026-10-15）说明：Esc 中断会置 `autoResumeSuppressed`，阻止 advisor note/aside 重启用户停下的 run，只有用户手动输入 prompt 才清除；`/retry` 经 `scheduleAgentContinue` 恢复、绕过了 `prompt()`，标志位残留会让此后 idle 的 aside 不再起 turn。修复是 `AgentSession.retry()` 在调度成功后清该标志。
<https://github.com/can1357/oh-my-pi/pull/14831>

**【代码实证】** 已合并进 main：`agent-session.ts:11302-11307` 的 `retry()` 注释写明「A manual retry is the user resuming the run they interrupted, so it lifts the interrupt's auto-resume suppression the same way a typed prompt does.」
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/agent-session.ts#L11300-L11307>

**【官方】** `omp --restore` 的续跑规则同源：每个被切断的调用批次会重跑，否则模型从 transcript 停下的地方继续；最后一轮已完成或失败或被用户中断时不续跑。
<https://github.com/can1357/oh-my-pi/blob/main/docs/session-operations-export-share-fork-resume.md>

## 4. 上限与部分输出

**【官方+代码实证】** 自动重试配置：`retry.enabled` 默认 true、`retry.maxRetries` 默认 10、`retry.baseDelayMs` 500、`retry.maxDelayMs` 300000。手动重试**不受这套上限约束**，且每次把 `#retryAttempt` 清零。另有几类终局续写各有独立 3 次上限（`UNEXPECTED_STOP_MAX_RETRIES`、`EMPTY_STOP_MAX_RETRIES`、`MALFORMED_FUNCTION_CALL_MAX_RETRIES`、`STREAM_STALL_CONTINUE_MAX_RETRIES`）。
<https://github.com/can1357/oh-my-pi/blob/main/docs/non-compaction-retry-policy.md>
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/turn-recovery.ts#L93-L101>

**【官方】** 自动重试有「replay safety 否决」：已提交的非空白可见文本、图片、工具调用通常**阻止**重放，只有 thinking-only 或纯空白 partial 可以安全丢弃；纯文本中途失败改为保留部分回合 + 追加 developer reminder，每 prompt 最多 3 次。手动 `/retry` 不走这套否决，直接从活动上下文删除该 assistant 消息。
<https://github.com/can1357/oh-my-pi/blob/main/docs/non-compaction-retry-policy.md>

**【代码实证】** 手动重试不写 `retryRecovery` 标记（该标记只由 `kind: "auto-retry"` 的自动重试写），因此不会出现自动重试那种「↻ Recovered after N retries」的折叠行；持久化 display transcript 里那条 error entry 仍在。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/turn-recovery.ts#L980-L1010>

**【代码实证】** 已渲染块清理分两条路：工具重放命中时 `#stripForToolReplay` 调 `sessionManager.branch(anchorEntry.id)` 重挂持久化分支叶子，失败的工具结果与 aborted 边界从持久化分支一起消失（理由：reload 后不应复现、重放时不能配对出重复 toolCallId）；未命中时只做 `agent.replaceMessages(...)`，没有对 TUI 已渲染块的裁剪调用。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/turn-recovery.ts#L3234-L3277>

## 5. 键位配置机制

**【官方】** 应用动作用 `app.*` 命名空间（编辑器/输入/选择器分别用 `tui.editor.*` / `tui.input.*` / `tui.select.*`），定义在 `packages/tui/src/keybindings.ts` 与 `packages/tui/src/app-keybindings.ts`。
<https://github.com/can1357/oh-my-pi/blob/main/docs/keybindings.md>

**【官方】** 用户覆盖写 `~/.omp/agent/keybindings.yml`：**YAML 映射**，键是动作 ID，值是一个和弦字符串或字符串数组；不从 `config.yml` 读，也没有嵌套 `keybindings` 对象；空数组 `[]` 禁用该动作；和弦名大小写不敏感（`Ctrl+P`、`Alt+Shift+P`、`Shift+Enter`、`Ctrl+Backspace`）。旧的 `keybindings.json` / `keybindings.yaml` 仍被接受并迁移为 YAML。
<https://github.com/can1357/oh-my-pi/blob/main/docs/keybindings.md>

**【代码实证】** 解析与写入与文档一致：文件名常量 `KEYBINDINGS_YML/YAML`、`LEGACY_KEYBINDINGS_JSON`；用户给了键就**整体替换**该动作默认值（`userKeys === undefined ? defaults : normalizeKeys(userKeys)`），不与默认合并；未被识别的动作 ID 静默忽略。
<https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/keybindings.ts#L281-L290>

**【代码实证】** 冲突处理：存在 `KeybindingsManager.getConflicts()`，只统计「用户绑定之间」同一和弦被 2 个以上动作声明的情况，**全仓库唯一调用者是单元测试**，生产代码零调用，也没有用户可见的冲突警告；它不检测「用户绑定 vs 别的动作默认键」，也不驱逐默认。实际冲突靠两套隐式优先级解决：fallback-key 剔除（只有 `app.message.followUp → ctrl+q`、`app.message.dequeue → shift+up` 两个动作有 fallback），以及 `handleInput` 的固定分发顺序（`app.retry` 排得很靠后，扩展与已注册 custom handler 优先于它，源码注释写明这是为了不抢占既有快捷键）。
<https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/keybindings.ts#L260-L319>
<https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/prompt/custom-editor.ts#L1722-L1860>

**【官方】** issue #7991「Make Alt-based keybindings configurable globally」仍 **open**：诉求是全局修饰键替换（例如 `keybindings.altReplacement: Ctrl` 把默认 `Alt+R` 变成 `Ctrl+R`）以及把 `/tree` 内部动作暴露成可重映射动作。协作者指出应用级动作已可逐个重映射，缺口在 `/tree` 仍硬编码 `alt+up/down` 与 `alt+d/t/u/l/a`。**【代码实证】** 全局修饰键替换**未实现**（全仓库 grep `altReplacement` 零命中）；2026-10-12 只新增了 `app.tree.previousBranch` / `app.tree.nextBranch` 两个可配置动作。
<https://github.com/can1357/oh-my-pi/issues/7991>

**【代码实证】** 键位**不能在 UI 里改**：`packages/coding-agent/src/modes/settings.ts`（`/settings` 的注册表）没有任何 keybinding 条目，`docs/settings.md` 也不提 keybindings；keybinding 写盘只发生在旧格式/旧动作名的迁移回写，`InteractiveMode.init` 启动时读盘一次；查看有效键位靠会话内 `/hotkeys`。
<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/settings.ts#L758-L790>

## 6. 与本次目标的差距（要点）

omp 的键位配置是**纯配置文件**形态，没有设置界面；冲突检测代码存在但未接线，用户看不到冲突提示；全局修饰键替换未实现。本次要做的「设置菜单里改键位 + 冲突显式提示」，在 omp 里**没有现成对应物**，属于超出 omp 的部分，需要按 DSH 自身承载面设计。

## 7. 许可证

**【官方】** 仓库根 `LICENSE` 为标准 MIT，版权行为 `Copyright (c) 2025 Mario Zechner`、`Copyright (c) 2025-2026 Can Bölük`、`Copyright (c) 2026 Stencil Labs, Inc.`。第三方与 vendored 代码另归各自上游许可，见 `THIRD-PARTY-NOTICES.txt`。MIT 允许复制与再分发（只需保留声明），只做行为对齐而不复制代码同样在许可范围内。
<https://github.com/can1357/oh-my-pi/blob/main/LICENSE>

## 8. 未证实

1. 手动重试后 TUI 里那条失败 assistant 块的最终呈现（代码上普通路径不写 `retryRecovery`，渲染层对 `error`/`aborted` 仍走完整错误框，未找到对应断言或文档）。
2. 手动重试的非重放路径是否会在 reload 后把那条部分文本重新送进 provider 上下文（`agent.replaceMessages` 不重挂持久化分支，上下文重建只在 `retryRecovery || isEmptyErrorTurn` 时排除 assistant entry；相关 PR #6357 正文未取到）。
3. `app.retry` 在 RPC/ACP/无头模式下的实际行为（只核对了 TUI 与 slash 命令两条路径）。
4. 手动重试是否有「次数用尽」提示（`Retry failed after N attempts` 属自动重试）。
5. `/hotkeys` 是否对两个动作共用同一和弦做标注。
6. omp 文档是否随 v18.0.10 同步更新了 `app.retry` 的 F5 行（未逐版核对文档历史）。
7. DeepWiki 的 TurnRecovery 页面（第三方自动生成）与源码方向一致，仅作交叉印证，结论一律以仓库源码为准。
