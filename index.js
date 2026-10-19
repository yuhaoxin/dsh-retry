/**
 * Host 半身入口：注册 `/retry` 命令与它依赖的 session projection。
 *
 * 命令处理逻辑与投影定义在 `src/host/retry.js`，消息构造在
 * `src/host/user-message.js`。本文件只负责运行期装配：注册投影、注册命令。
 *
 * 三个模块都不 import 任何 `@deepseek-ai/*` 包。插件以 `link:` 形态安装时，
 * 运行时把包解析重定向到安装副本的前提是插件自己在 `peerDependencies` 里列出
 * 包名（`dsh-app-boot` 的 `routeLinked`）；本插件不声明 peer 以避免版本门禁
 * 阻断安装，实测从插件目录解析 `@deepseek-ai/dsh-llm` 会 MODULE_NOT_FOUND。
 * 因此消息构造在本地按会话层校验契约实现，见 `src/host/user-message.js`。
 */

import { createRetryCommand, retryTurnBoundaryProjection } from './src/host/retry.js';
import { createUserMessage } from './src/host/user-message.js';

export const inject = ['commands', 'sessionProjections'];

/**
 * 注册重试投影与 `/retry` 命令。
 *
 * 两者的注册都挂在 `ctx.effect` 上，随插件 fiber 一起释放；投影必须先注册，
 * 命令 handler 才能在 `stateOf()` 读到它。
 *
 * @param {object} ctx Cordis 上下文，已注入 `commands` 与 `sessionProjections`。
 * @param {(input: object) => object} createMessage user 消息构造器。
 * @returns {void}
 */
export function installRetry(ctx, createMessage) {
  ctx.sessionProjections.register(retryTurnBoundaryProjection);
  ctx.commands.register(createRetryCommand(createMessage, ctx.sessionProjections));
}

/**
 * Cordis 插件入口：注册投影与 `/retry` 命令。
 *
 * @param {object} ctx Cordis 上下文，已注入 `commands` 与 `sessionProjections`。
 * @returns {void}
 */
export function apply(ctx) {
  installRetry(ctx, createUserMessage);
}
