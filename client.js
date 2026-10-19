/**
 * Client 半身入口：包在 DeepSeek Harness 的模块加载器壳里，factory 返回 Cordis 插件对象。
 *
 * 注册可改键动作 retry.lastTurn（默认 Alt+R，只声明 desktop 三平台），触发 Host 命令 /retry。
 * 动作随快捷键目录出现在「设置」→「通用」→「快捷键」，改键、落盘与冲突提示都由
 * ctx.shortcuts 注册表负责。
 */

const NS = 'dsh-retry';

/** 运行期词典；包根 locale/*.json 只承载插件管理器读取的 meta。 */
const zh = {
  'shortcut.retryLastTurn': '重试上一回合',
  'shortcut.noSession': '当前没有主会话，无法重试',
};
const en = {
  'shortcut.retryLastTurn': 'Retry last turn',
  'shortcut.noSession': 'No main conversation to retry',
};

/**
 * sessionId 来源契约：取中央主视图持有的会话。
 *
 * `ctx.sessions.list` 是客户端会话目录快照；`retainedBy.mainView` 大于 0 的行即主视图正在
 * 显示的会话（ui-workspace、ui-open-in-app、ui-layout 等 shipped 插件按同一规则选择）。
 * 快捷键的 resolve(context) 只拿到 DOM 目标、不含会话 id，因此这里从会话目录反查；
 * Host 命令按这个 id 寻址对应 agent。
 *
 * @param {object} scope - 已注入 sessions 的客户端作用域。
 * @returns {string | undefined} 会话 id；没有主会话时为 undefined。
 */
function mainSessionId(scope) {
  const { byId } = scope.sessions.list.getSnapshot();
  return Object.values(byId).find((row) => (row.retainedBy.mainView ?? 0) > 0)?.id;
}

window.__ModuleLoader__.load({
  id: 'dsh-retry',
  factory() {
    return {
      inject: [],
      apply(ctx) {
        ctx.inject(['shortcuts', 'sessions', 'remote', 'remote.commands', 'locale'], (scope) => {
          scope.effect(() => scope.locale.register(NS, { zh, en }), 'dsh-retry: dictionaries');
          const t = scope.locale.bind(NS);

          /**
           * 触发 Host /retry。run 是 fire-and-forget，失败在控制台报告：
           * 命令未被 Host 注册、或调用被拒绝，都不会让按键处理器抛错。
           */
          const retryLastTurn = async (sessionId) => {
            const result = await scope.remote.commands.execute(sessionId, '/retry', []);
            if (!result.ok) throw new Error(`/retry rejected: ${result.error.code}: ${result.error.message}`);
            if (result.value === undefined) throw new Error('/retry is not registered by the Host half');
          };

          scope.effect(
            () =>
              scope.shortcuts.register({
                id: 'retry.lastTurn',
                label: () => t('shortcut.retryLastTurn'),
                aliases: ['retry'],
                // 只声明 desktop 三平台：web 的白名单没有 alt+r；无修饰键组合在 desktop:linux
                // 与全部 web 平台被 modifier-required 拒绝，而 register() 会逐个校验已声明平台。
                defaults: {
                  'desktop:macos': { code: 'KeyR', modifiers: ['alt'] },
                  'desktop:windows': { code: 'KeyR', modifiers: ['alt'] },
                  'desktop:linux': { code: 'KeyR', modifiers: ['alt'] },
                },
                // 终端区不抢键：注册表在 terminal 区放行 Ctrl+W、Ctrl+R 这类组合。
                regions: ['page', 'editable'],
                modals: [],
                resolve: () => {
                  const sessionId = mainSessionId(scope);
                  if (sessionId === undefined) {
                    return { status: 'blocked', reason: t('shortcut.noSession') };
                  }
                  return {
                    status: 'handled',
                    run: () => {
                      retryLastTurn(sessionId).catch((error) => {
                        console.warn('dsh-retry: /retry request failed:', error);
                      });
                    },
                  };
                },
              }),
            'dsh-retry: retry.lastTurn',
          );
        });
      },
    };
  },
});
