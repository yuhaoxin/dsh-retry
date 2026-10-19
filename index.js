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

/**
 * 插件 Config：让本包在设置镜像里拥有一个 namespace。
 *
 * 配置页挂在 `plugins.bundle.config` 槽位上，该槽位按包名分发，而分发前提是设置镜像
 * 里存在本包的 namespace（`configForms.whileServed([ns], ...)` 据此判断）。没有 Config
 * 导出的插件不会出现在镜像里，配置页永远不会注册。
 *
 * 这里手写符合 Schemastery 原生协议的对象（`Symbol.for('schemastery')` 为真、`type`
 * 是字符串、`meta` 是对象），不引入 schemastery 依赖：插件以 `link:` 形态安装时解析
 * 不到 DSH 运行时包，静态 import 会让整包加载失败。
 *
 * 当前没有用户可配字段——快捷键偏好由 `ctx.shortcuts` 自己持久化，不属于插件配置。
 */
export const Config = {
  type: 'object',
  meta: { default: {}, description: '快捷键偏好由 DSH 的快捷键注册表保存，本插件没有额外配置项。' },
  [Symbol.for('schemastery')]: true,
  dict: {},
};
