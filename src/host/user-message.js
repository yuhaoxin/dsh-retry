/**
 * 构造一条 user 角色消息。
 *
 * 等价于 `@deepseek-ai/dsh-llm` 的 `createUserMessage`：`deepFreeze(structuredClone({
 * ...input, id: randomUUID(), role: 'user' }))`。这里不 import 该包是因为插件以
 * `link:` 形态安装时，运行时只把解析重定向到安装副本的前提是插件自己在
 * `peerDependencies` 里列出包名（`dsh-app-boot` 的 `routeLinked`）；本插件不声明
 * peer 以避免版本门禁阻断安装，而实测从插件目录解析 `@deepseek-ai/dsh-llm` 会
 * MODULE_NOT_FOUND。
 *
 * 会话层对 `user/message` 的校验只要求四个要素：非空字符串 `id`、
 * `role === 'user'`、非空 `source.kind`、数组 `content`
 * （`dsh-session/lib/index.js` 的 `assertMessageEventShape`），因此本地构造与官方
 * 构造器在运行时等价。
 *
 * @param {{content: object[], source: {kind: string}}} input 消息内容与来源。
 * @returns {object} 冻结的 user 消息。
 */
export function createUserMessage(input) {
  const message = structuredClone({
    ...input,
    id: globalThis.crypto.randomUUID(),
    role: 'user',
  });
  return deepFreeze(message);
}

/** 递归冻结，与 `@deepseek-ai/dsh-util-values` 的 `deepFreeze` 行为一致。 */
function deepFreeze(value) {
  const seen = new WeakSet();
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    for (const key of Object.keys(node)) pending.push(node[key]);
    Object.freeze(node);
  }
  return value;
}
