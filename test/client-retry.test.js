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
/** 设置页走独立子注入，slots 不在主注入里。 */

/**
 * 假客户端上下文：effect 立即执行回调，ctx.inject 立即把所需服务交给插件体。
 * @param {{ hasSession?: boolean, execute?: Function }} options - 会话目录与 Remote 命令的替身。
 */
function makeContext({ hasSession = true, execute } = {}) {
  const sessionId = hasSession ? SESSION_ID : undefined;
  const injections = [];
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
    // 设置页走独立子注入：把 slots 交给回调，与真实 cordis 的 scope.inject 同形。
    inject(deps, callback) {
      injections.push(deps);
      callback({ slots });
    },
  };
  const ctx = {
    effect,
    // slots 走可选读取：apply 时探测 ctx.get('slots')。
    get(name) {
      return name === 'slots' ? slots : undefined;
    },
    inject(deps, callback) {
      injections.push(deps);
      callback(scoped);
    },
  };

  return {
    ctx,
    injections,
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

test('client bundle registers under the package name with no eager service injection', () => {
  assert.equal(loaded.id, 'dsh-retry');
  const plugin = makePlugin();
  assert.deepEqual(plugin.inject, []);
  assert.equal(typeof plugin.apply, 'function');
});

test('registers retry.lastTurn with desktop-only Alt+R defaults, page/editable regions, and no modals', () => {
  const { ctx, injections, registrations, effects } = makeContext();
  makePlugin().apply(ctx);

  assert.equal(injections.length, 1);
  for (const service of REQUIRED_SERVICES) {
    assert.ok(injections[0].includes(service), `ctx.inject must request ${service}`);
  }
  // slots 必须走可选读取：列为必需会让没有渲染层的部署连 retry.lastTurn 都不注册。
  assert.ok(!injections[0].includes('slots'), 'main injection must not require slots');
  assert.deepEqual(effects, ['dsh-retry: dictionaries', 'dsh-retry: retry.lastTurn']);
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
