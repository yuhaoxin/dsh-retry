/**
 * Host 半身的重试内核：用 session projection 记录「上一回合如何结束」，
 * 并据此把一次重试落成 `agent.followup()`。
 *
 * DSH 没有重放上一轮的接口，唤醒已结束回合的唯一公开入口是
 * `Agent.followup(UserMessage)`：它把消息放进 inbox 的 next-turn 并唤醒
 * driver，新回合会把这条消息作为 surface `user/message` 落进历史
 * （`source.kind !== 'user'` 时客户端把它渲染成 turn-trigger 卡片而不是用户
 * 气泡）。因此「重试」= 追加一条说明重试意图的 user 消息并唤醒，模型在新回合
 * 重新生成。
 *
 * 回合状态的读取走 `ctx.sessionProjections`：`Session.eventAt()` /
 * `snapshotEvents()` / `ownEvents()` 已被官方标记为弃用且禁止新的生产调用
 * （`dsh-session/README.md`），projection 是官方给出的替代读取面。
 *
 * 本模块不 import 任何 `@deepseek-ai/*` 包：投影定义与判定都是纯数据/纯函数，
 * 消息构造器由入口在运行时取得后注入，因此可以在没有 DSH 依赖树的仓库里单测。
 */

/** 投影键。与官方已注册的键（`inbox`、`turnBoundary`、`llmRetry` 等）无冲突。 */
export const RETRY_PROJECTION_KEY = 'retryTurnBoundary';

/** 可重试的 `turn/end` reason 取值。 */
const RETRYABLE_TURN_END_KINDS = new Set(['error', 'aborted', 'interrupted']);

/** 各结束原因在人类可读文案里的中文标签。 */
const TURN_END_LABELS = {
  error: '请求失败',
  aborted: '被中止',
  interrupted: '被中断',
};

/**
 * 投影状态：最后一回合怎么结束、以及它之后是否又开了新回合。
 *
 * @typedef {{lastTurnEndKind: string | null, openTurn: boolean}} RetryTurnBoundaryState
 */

/**
 * 投影状态校验器。
 *
 * `ctx.sessionProjections` 与 projection cache 对 `stateSchema` 的唯一用法是
 * `stateSchema.parse(storedValue)`（`dsh-session-projection/lib/index.js` 的
 * `restore()` 与 `viewCheckpoint()`），没有类型自省或 `safeParse` 调用，因此这里
 * 提供带 `parse` 的普通校验器即可，不必为此引入 zod/schemastery 依赖——本插件
 * 不携带 DSH 运行时依赖，link 安装形态下也解析不到这些包。
 *
 * @type {{parse(value: unknown): RetryTurnBoundaryState}}
 */
export const retryTurnBoundarySchema = {
  parse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('dsh-retry: retryTurnBoundary 投影状态必须是对象');
    }
    const { lastTurnEndKind, openTurn } = value;
    if (lastTurnEndKind !== null && typeof lastTurnEndKind !== 'string') {
      throw new TypeError('dsh-retry: retryTurnBoundary.lastTurnEndKind 必须是字符串或 null');
    }
    if (typeof openTurn !== 'boolean') {
      throw new TypeError('dsh-retry: retryTurnBoundary.openTurn 必须是布尔值');
    }
    return { lastTurnEndKind, openTurn };
  },
};

/**
 * `/retry` 使用的 session projection 定义。
 *
 * 折叠规则只看两种回合边界事件：
 * - `turn/start`：置 `openTurn: true`，保留上一次的结束原因。
 * - `turn/end`：记下 `reason.kind`，置 `openTurn: false`。
 * - 其它事件原样返回（同一个 state 引用，不触发变更通知）。
 *
 * `apply` 只读事件、不读会话，因此对实时事件流、冷恢复与 fork 继承前缀给出同一
 * 结果；返回新对象即表示状态变化，registry 依赖 `Object.is` 判断变化。
 *
 * @type {{
 *   key: string,
 *   stateVersion: number,
 *   stateSchema: {parse(value: unknown): RetryTurnBoundaryState},
 *   init: () => RetryTurnBoundaryState,
 *   apply: (state: RetryTurnBoundaryState, event: {type: string, data: object}) => RetryTurnBoundaryState,
 * }}
 */
export const retryTurnBoundaryProjection = {
  key: RETRY_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: retryTurnBoundarySchema,
  init: () => ({ lastTurnEndKind: null, openTurn: false }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return state.openTurn ? state : { ...state, openTurn: true };
      case 'turn/end':
        return { lastTurnEndKind: event.data.reason.kind, openTurn: false };
      default:
        return state;
    }
  },
};

/**
 * 判断投影状态是否留下「可重试的上一回合」。
 *
 * 判定只取最后一条 `turn/end` 的 reason，不看 surface。三种结束原因留下可重试
 * 的回合：
 * - `error`：回合以异常结束。请求失败时失败的那次 attempt 只写非 surface 的
 *   `assistant/attempt`，历史里不会留下与它对应的助手消息。
 * - `aborted`：被用户、父级或钩子取消。流里已有内容时 loop 会补一条 surface
 *   `assistant/message { interrupted: true }`，重试会带着这半截输出重发。
 * - `interrupted`：崩溃恢复时 `interruptedTurnClosers()` 合成的结束原因。
 *
 * `completed`（正常完成）、`blocked`（pre-step 拒绝，没有发出模型请求）、
 * `max-tokens`（正常拿到了被截断的回复）、`forked`（fork 种子里的合成结束）
 * 都不留待重试的回合。`TurnEndReasonMap` 是可合并扩展的接口，未知 kind 一律按
 * 不可重试处理。
 *
 * 回合仍开着（`openTurn`）时不可重试：此时插队重试会和正在跑的回合争抢 inbox。
 *
 * @param {RetryTurnBoundaryState} state 投影状态。
 * @returns {boolean}
 */
export function isRetryableTurnBoundary(state) {
  if (state.openTurn) return false;
  return RETRYABLE_TURN_END_KINDS.has(state.lastTurnEndKind);
}

/** 人类可读的结束原因标签；未知 kind 回退到 kind 原文。 */
function turnEndLabel(kind) {
  return TURN_END_LABELS[kind] ?? kind;
}

/**
 * 生成发给模型的重试消息正文。消息会留在 surface 历史里，措辞要说明这是一次
 * 重试，避免模型把上一次的残缺输出当成待续写的内容。
 *
 * @param {string} kind 上一次回合的结束原因。
 * @returns {string}
 */
function retryPromptText(kind) {
  return `重试上一回合：上一条助手回复没有完成（${turnEndLabel(kind)}）。请重新生成这次回复，不要接着上一次的残缺输出继续写。`;
}

/**
 * 执行一次 `/retry`。
 *
 * 契约（`CommandResult`）：存在可重试的上一回合时调用一次
 * `invocation.agent.followup(...)` 并返回 `{kind: 'success', text}`；否则返回
 * `{kind: 'error', text: 'Nothing to retry.'}`，且不产生任何副作用（不写事件、
 * 不碰 inbox、不构造消息）。
 *
 * @param {{agent: {session: object, followup(message: object): void}}} invocation 命令调用。
 * @param {(input: {content: object[], source: {kind: string}}) => object} createUserMessage UserMessage 构造器。
 * @param {{stateOf(session: object, key: string): RetryTurnBoundaryState | undefined}} sessionProjections `ctx.sessionProjections`。
 * @returns {{kind: 'success', text: string} | {kind: 'error', text: string}}
 * @throws 当投影未注册时：投影与命令同属一个插件 fiber，缺失说明装配被破坏。
 */
export function runRetry(invocation, createUserMessage, sessionProjections) {
  const { agent } = invocation;
  const state = sessionProjections.stateOf(agent.session, RETRY_PROJECTION_KEY);
  if (state === undefined) {
    throw new Error(`dsh-retry: 会话投影 "${RETRY_PROJECTION_KEY}" 未注册，无法判定可重试回合`);
  }
  if (!isRetryableTurnBoundary(state)) return { kind: 'error', text: 'Nothing to retry.' };

  const reasonKind = state.lastTurnEndKind;
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: retryPromptText(reasonKind) }],
      // 非 user 来源：客户端把它渲染成 turn-trigger 卡片，而不是冒充真人输入的用户气泡。
      source: { kind: 'cordis-host-runner' },
    }),
  );
  return { kind: 'success', text: `已重新发起上一回合的模型请求（上次结束原因：${turnEndLabel(reasonKind)}）。` };
}

/**
 * 构造 `/retry` 的命令定义。
 *
 * 命令名必须匹配 `^[a-z][a-z0-9_-]*$`（`dsh-commands` 注册期校验）；description
 * 会出现在命令面板与斜杠列表里，不能为空。
 *
 * @param {(input: {content: object[], source: {kind: string}}) => object} createUserMessage UserMessage 构造器。
 * @param {{stateOf(session: object, key: string): RetryTurnBoundaryState | undefined}} sessionProjections `ctx.sessionProjections`。
 * @returns {{name: string, description: string, handler: (invocation: object) => object}}
 */
export function createRetryCommand(createUserMessage, sessionProjections) {
  return {
    name: 'retry',
    description: '重试上一条失败或被中断的助手回合',
    handler: (invocation) => runRetry(invocation, createUserMessage, sessionProjections),
  };
}
