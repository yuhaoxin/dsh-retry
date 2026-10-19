import test from 'node:test';
import assert from 'node:assert/strict';

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

await import('../client.js');

const SESSION_ID = 'session-1';
const REQUIRED_SERVICES = ['shortcuts', 'sessions', 'remote', 'remote.commands', 'locale'];
/** apply 里用到的服务，连同 slots 一起声明在插件对象的 inject 上。 */

/**
 * 假客户端上下文：effect 立即执行回调；服务由插件级 inject 声明，直接挂在 ctx 上。
 * @param {{ hasSession?: boolean, execute?: Function }} options - 会话目录与 Remote 命令的替身。
 */
function makeContext({ hasSession = true, execute } = {}) {
  const sessionId = hasSession ? SESSION_ID : undefined;
  const registrations = [];
  const effects = [];
  const calls = [];
  const dictionaries = new Map();
  let activeLocale = 'zh';

  const shortcuts = {
    register(command) {
      registrations.push(command);
      return () => {};
    },
  };
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: sessionId === undefined ? [] : [sessionId],
        byId:
          sessionId === undefined
            ? {}
            : {
                [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } },
              },
        phase: 'ready',
        projectionsBySession: {},
      }),
    },
  };
  const remote = {
    commands: {
      async execute(...args) {
        calls.push(args);
        return execute === undefined
          ? { ok: true, value: { commandId: 'command-1', result: { kind: 'success' } } }
          : execute(...args);
      },
    },
  };
  const locale = {
    register(namespace, dicts) {
      dictionaries.set(namespace, dicts);
      return () => {};
    },
    bind(namespace) {
      return (key, params) => {
        const template = dictionaries.get(namespace)?.[activeLocale]?.[key] ?? key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      };
    },
  };
  const sections = [];
  // 真实的 slots.inject 只在设置壳声明槽位后才同步跑回调；替身只记录，测试里手动触发，
  // 这样默认的 factory(require) 仍可保持「不解析浏览器模块」。
  const slots = {
    inject(key, callback) {
      sections.push({ key, callback });
      return () => {};
    },
    register(options, component) {
      sections.push({ key: options.name, options, component });
      return () => {};
    },
  };
  const effect = (callback, label) => {
    effects.push(label);
    return callback();
  };
  const scoped = {
    shortcuts,
    sessions,
    remote,
    locale,
    effect,
    slots,
  };
  const ctx = {
    shortcuts,
    sessions,
    remote,
    locale,
    effect,
    slots,
    // 插件只声明 slots 与 locale，其余服务在 apply 里用 ctx.get 可选读取。
    get(name) {
      if (name === 'shortcuts') return shortcuts;
      if (name === 'sessions') return sessions;
      if (name === 'remote.commands') return remote.commands;
      return undefined;
    },
  };

  return {
    ctx,
    registrations,
    effects,
    calls,
    sections,
    shortcuts,
    setLocale(id) {
      activeLocale = id;
    },
  };
}

function makePlugin() {
  return loaded.factory(() => {
    throw new Error('dsh-retry client bundle requires no browser modules');
  });
}

test('client bundle only hard-requires the renderer and locale services', () => {
  assert.equal(loaded.id, 'dsh-retry');
  const plugin = makePlugin();
  // 只把 shipped 组合必然提供的两项列为硬依赖；shortcuts / sessions / remote.commands
  // 用 ctx.get 可选读取，缺一项只失去对应能力，不会让整个插件停在 pending。
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  assert.equal(typeof plugin.apply, 'function');
});

test('registers retry.lastTurn with desktop-only Alt+R defaults, page/editable regions, and no modals', () => {
  const { ctx, registrations, effects } = makeContext();
  makePlugin().apply(ctx);

  assert.deepEqual(effects, ['dsh-retry: dictionaries', 'dsh-retry: retry.lastTurn', 'dsh-retry: config page']);
  assert.equal(registrations.length, 1);

  const command = registrations[0];
  assert.equal(command.id, 'retry.lastTurn');
  assert.deepEqual(command.defaults, {
    'desktop:macos': { code: 'KeyR', modifiers: ['alt'] },
    'desktop:windows': { code: 'KeyR', modifiers: ['alt'] },
    'desktop:linux': { code: 'KeyR', modifiers: ['alt'] },
  });
  assert.deepEqual(Object.keys(command.defaults).sort(), ['desktop:linux', 'desktop:macos', 'desktop:windows']);
  assert.ok(Object.keys(command.defaults).every((profile) => profile.startsWith('desktop:')));
  assert.deepEqual(command.regions, ['page', 'editable']);
  assert.deepEqual(command.modals, []);
  assert.equal(typeof command.label, 'function');
  assert.equal(typeof command.resolve, 'function');
});

test('label reads the registered dictionaries instead of hardcoded copy', () => {
  const { ctx, registrations, setLocale } = makeContext();
  makePlugin().apply(ctx);

  const command = registrations[0];
  assert.equal(command.label(), '重试上一回合');
  setLocale('en');
  assert.equal(command.label(), 'Retry last turn');
});

test('resolve executes /retry against the main-view session', async () => {
  const { ctx, registrations, calls } = makeContext();
  makePlugin().apply(ctx);

  const resolution = registrations[0].resolve({ region: 'page', modal: null, target: null });
  assert.equal(resolution.status, 'handled');
  assert.equal(typeof resolution.run, 'function');

  resolution.run();
  await Promise.resolve();
  assert.deepEqual(calls, [[SESSION_ID, '/retry', []]]);
});

test('resolve is blocked without a main-view session and never calls the Host', () => {
  const { ctx, registrations, calls } = makeContext({ hasSession: false });
  makePlugin().apply(ctx);

  const resolution = registrations[0].resolve({ region: 'editable', modal: null, target: null });
  assert.equal(resolution.status, 'blocked');
  assert.equal(resolution.reason, '当前没有主会话，无法重试');
  assert.deepEqual(calls, []);
});
