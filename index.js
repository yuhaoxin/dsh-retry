/**
 * Host 半身入口：注册 `/retry` 命令与它依赖的 session projection。
 *
 * 命令处理逻辑与投影定义在 `src/host/retry.js`，本文件只负责运行期装配：
 * 取 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 构造器、注册投影、注册命令。
 *
 * `@deepseek-ai/dsh-llm` 通过运行时动态 import 取得，而不是顶层静态 import：
 * 插件包本身不携带 DSH 运行时依赖，静态 import 会让插件在缺少该模块时整包
 * 加载失败（连 locale/icon 都读不到）。动态 import 失败时 apply 抛错，插件
 * 加载失败可见，不会留下「命令没注册、按键无反应」的半成品。
 */

import {
  createRetryCommand,
  retryTurnBoundaryProjection,
} from './src/host/retry.js';

export const inject = ['commands', 'sessionProjections'];

/**
 * 取得 `@deepseek-ai/dsh-llm` 导出的 `createUserMessage`。
 *
 * @param {() => Promise<{createUserMessage?: unknown}>} load 模块加载器；测试注入用。
 * @returns {Promise<(input: object) => object>} UserMessage 构造器。
 * @throws 当模块无法解析，或该模块没有导出 `createUserMessage` 时，错误信息指明缺失的模块。
 */
export async function loadUserMessageFactory(load = () => import('@deepseek-ai/dsh-llm')) {
  let module;
  try {
    module = await load();
  } catch (error) {
    throw new Error(
      'dsh-retry: 无法解析 @deepseek-ai/dsh-llm，/retry 命令未注册。请确认插件安装形态能解析 DSH 运行时包。',
      { cause: error },
    );
  }
  if (typeof module?.createUserMessage !== 'function') {
    throw new Error('dsh-retry: @deepseek-ai/dsh-llm 未导出 createUserMessage，/retry 命令未注册。');
  }
  return module.createUserMessage;
}

/**
 * 注册重试投影与 `/retry` 命令。
 *
 * 两者的注册都是 `ctx.effect` 上的 effect，随插件 fiber 一起释放；投影必须先
 * 注册，命令 handler 才能在 `stateOf()` 读到它。
 *
 * @param {object} ctx Cordis 上下文，已注入 `commands` 与 `sessionProjections`。
 * @param {(input: object) => object} createUserMessage UserMessage 构造器。
 * @returns {void}
 */
export function installRetry(ctx, createUserMessage) {
  ctx.sessionProjections.register(retryTurnBoundaryProjection);
  ctx.commands.register(createRetryCommand(createUserMessage, ctx.sessionProjections));
}

/**
 * Cordis 插件入口：注册投影与 `/retry` 命令。
 *
 * @param {object} ctx Cordis 上下文，已注入 `commands` 与 `sessionProjections`。
 * @returns {Promise<void>}
 */
export async function apply(ctx) {
  installRetry(ctx, await loadUserMessageFactory());
}
