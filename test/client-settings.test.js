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

const plugin = loaded.factory(() => {
  throw new Error('settings tests provide their own browser modules');
});
const internals = plugin.internals;

/** 词典替身：按键取 `zh` 或 `en` 下的文案，支持 `{name}` 占位。 */
function makeT(lang = 'zh') {
  const dictionaries = {
    zh: {
      'settings.nav': '重试快捷键',
      'settings.title': '重试快捷键',
      'settings.intro': '设置按键',
      'settings.modified': '已修改',
      'settings.unbound': '未绑定',
      'settings.conflict': '与「{commands}」冲突',
      'settings.record': '录制按键',
      'settings.recording': '按下组合键…',
      'settings.recordUnavailable': '按键录制不可用，请手动输入组合',
      'settings.manual': '输入组合',
      'settings.apply': '应用',
      'settings.invalidBinding': '无法识别这个组合',
      'settings.reset': '恢复默认',
      'settings.clear': '解除绑定',
      'settings.status.saved': '已保存',
      'settings.status.stale': '配置已变化，请重新操作',
      'settings.status.conflict': '与已有快捷键冲突：{commands}',
      'settings.status.write-failed': '保存失败，请重试',
      'settings.status.not-ready': '快捷键服务尚未就绪',
      'settings.status.loading': '正在读取快捷键配置…',
      'settings.status.unreadable': '快捷键配置无法读取',
      'settings.issue.reserved': '该组合被系统或编辑器占用',
    },
    en: {
      'settings.nav': 'Retry shortcuts',
      'settings.title': 'Retry shortcuts',
      'settings.intro': 'Choose the key',
      'settings.modified': 'Customized',
      'settings.unbound': 'No shortcut',
      'settings.conflict': 'Conflicts with “{commands}”',
      'settings.record': 'Record keys',
      'settings.recording': 'Press the combination…',
      'settings.recordUnavailable': 'Key recording is unavailable here. Type the combination instead.',
      'settings.manual': 'Type a combination',
      'settings.apply': 'Apply',
      'settings.invalidBinding': 'Unrecognized combination',
      'settings.reset': 'Restore default',
      'settings.clear': 'Remove',
      'settings.status.saved': 'Saved',
      'settings.status.stale': 'The configuration changed. Try again.',
      'settings.status.conflict': 'Already used by “{commands}”',
      'settings.status.write-failed': 'Could not save. Try again.',
      'settings.status.not-ready': 'Shortcuts are not ready yet.',
      'settings.status.loading': 'Loading shortcut configuration…',
      'settings.status.unreadable': 'Shortcut configuration cannot be read.',
      'settings.issue.reserved': 'This combination is reserved for system or editing actions.',
    },
  };
  return (key, params) => {
    const template = dictionaries[lang][key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/**
 * 最小 React 替身：hooks 存进槽位数组，渲染只产出可断言的元素树。
 * 不执行 useEffect，页面逻辑里的副作用由用例单独驱动。
 */
function makeReact() {
  const slots = [];
  let cursor = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      return getSnapshot();
    },
    useEffect() {},
    /** 渲染一次组件并返回元素树。 */
    render(component) {
      cursor = 0;
      return component();
    },
  };
}

/** 深度遍历元素树，收集指定 tag 的元素。 */
function findElements(node, tag, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (node.type === tag) found.push(node);
  for (const child of node.children) findElements(child, tag, found);
  return found;
}

/** 元素树的可见文本。 */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (node === null || node === undefined || typeof node !== 'object') return '';
  return node.children.map(textOf).join('');
}

/** 按文本找按钮。 */
function buttonByText(tree, label) {
  return findElements(tree, 'button').find((button) => textOf(button) === label);
}

/** 排空微任务队列，让页面里的 async 提交走完。 */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}


/**
 * 假客户端上下文：effect 立即执行，slots.inject 只记录回调，供测试手动触发。
 * @param {{ recording?: Function, edit?: Function, catalog?: object[], config?: object }} options
 *   快捷键服务替身。
 */
function makeContext({ recording, edit, catalog = [], config = { revision: 'rev-1', status: 'ready' } } = {}) {
  const calls = { edit: [], recording: [] };
  const shortcuts = {
    register: () => () => {},
    catalog: { getSnapshot: () => catalog, subscribe: () => () => {} },
    config: { getSnapshot: () => config, subscribe: () => () => {} },
    edit: async (...args) => {
      calls.edit.push(args);
      return edit === undefined ? { status: 'saved', snapshot: { revision: 'rev-2' } } : edit(...args);
    },
    recording: async (active) => {
      calls.recording.push(active);
      if (recording !== undefined) return recording(active);
    },
  };
  const sections = [];
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
  const scoped = {
    shortcuts,
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    remote: { commands: { execute: async () => ({ ok: true, value: {} }) } },
    locale: { register: () => () => {}, bind: () => makeT() },
    slots,
    effect: (callback) => callback(),
    // 设置页走独立子注入，与真实 cordis 的 scope.inject 同形。
    inject(deps, callback) {
      callback({ slots });
    },
  };
  const ctx = {
    effect: (callback) => callback(),
    // slots 走可选读取：apply 时探测 ctx.get('slots')。
    get(name) {
      return name === 'slots' ? slots : undefined;
    },
    inject(deps, callback) {
      callback(scoped);
    },
  };
  return { ctx, sections, shortcuts, calls };
}

const CATALOG = [
  {
    id: 'retry.lastTurn',
    label: '重试上一回合',
    keys: ['⌥', 'R'],
    modified: true,
    issue: null,
    conflicts: ['open-in-app.open'],
  },
  {
    id: 'retry.lastTurn',
    label: '重试上一回合',
    keys: ['⌘', 'R'],
    modified: false,
    issue: 'reserved',
    conflicts: [],
  },
  { id: 'someone.else', label: '别的动作', keys: ['⌘', 'K'], modified: false, issue: null, conflicts: [] },
];

test('settings.section registration carries the page contract', () => {
  const { ctx, sections } = makeContext();
  const React = { createElement: () => null, useSyncExternalStore: () => undefined };
  const requested = [];
  loaded
    .factory((spec) => {
      requested.push(spec);
      if (spec === 'react') return React;
      throw new Error(`unexpected browser module: ${spec}`);
    })
    .apply(ctx);

  const injected = sections.find((entry) => entry.key === 'settings.section' && entry.callback !== undefined);
  assert.ok(injected, 'client must wait for the settings.section declaration');
  assert.deepEqual(requested, [], 'no browser module is resolved before the slot exists');

  injected.callback();

  const registration = sections.find((entry) => entry.options !== undefined);
  assert.ok(registration, 'settings.section must register a page');
  assert.equal(registration.options.name, 'settings.section');
  assert.equal(registration.options.id, 'dsh-retry');
  assert.equal(registration.options.order, 60);
  assert.equal(registration.options.locale, 'dsh-retry');
  assert.equal(registration.options.label(), '重试快捷键');
  assert.equal(typeof registration.component, 'function');
  // react 只在槽位声明出现后才解析，注册路径不依赖渲染层。
  assert.deepEqual(requested, ['react']);
});

test('rows keep only this plugin’s actions and carry conflicts plus issue state', () => {
  const rows = internals.shortcutRows(CATALOG);

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.id === 'retry.lastTurn'));

  assert.deepEqual(rows[0].keys, ['⌥', 'R']);
  assert.equal(rows[0].modified, true);
  assert.equal(rows[0].issue, null);
  assert.deepEqual(rows[0].conflicts, ['open-in-app.open']);
  // 冲突 id 换成同一份目录里的展示名。
  assert.deepEqual(rows[0].conflictLabels, ['open-in-app.open']);

  assert.equal(rows[1].issue, 'reserved');
  assert.deepEqual(rows[1].conflicts, []);
});

test('rows resolve conflict ids to labels from the same catalog', () => {
  const rows = internals.shortcutRows([
    ...CATALOG,
    { id: 'open-in-app.open', label: '在 App 中打开', keys: [], modified: false, issue: null, conflicts: [] },
  ]);
  assert.deepEqual(rows[0].conflictLabels, ['在 App 中打开']);
});

/**
 * 渲染一次设置页。
 *
 * @param {{ catalog?: object[], config?: object, recording?: Function, edit?: Function }} options - 服务替身。
 * @returns {{ tree: object, React: object, calls: object, render: Function }} 元素树与重渲染入口。
 */
function renderPage(options = {}) {
  const context = makeContext(options);
  const React = makeReact();
  const requested = [];
  loaded
    .factory((spec) => {
      requested.push(spec);
      if (spec === 'react') return React;
      throw new Error(`unexpected browser module: ${spec}`);
    })
    .apply(context.ctx);

  const injected = context.sections.find((entry) => entry.key === 'settings.section' && entry.callback !== undefined);
  injected.callback();
  const { component } = context.sections.find((entry) => entry.options !== undefined);
  return { tree: React.render(component), React, component, calls: context.calls, render: () => React.render(component) };
}

test('page renders the action row with keys, modified badge, conflict and issue hints', () => {
  const { tree } = renderPage({ catalog: [CATALOG[0]] });

  const text = textOf(tree);
  assert.match(text, /重试快捷键/);
  assert.match(text, /重试上一回合/);
  assert.match(text, /⌥R/);
  assert.match(text, /已修改/);
  assert.match(text, /与「open-in-app.open」冲突/);
  assert.equal(findElements(tree, 'li').length, 1);
});

test('page renders the issue hint and the unbound state', () => {
  const { tree } = renderPage({
    catalog: [{ ...CATALOG[1], keys: [] }],
  });

  const text = textOf(tree);
  assert.match(text, /未绑定/);
  assert.match(text, /该组合被系统或编辑器占用/);
  assert.doesNotMatch(text, /已修改/);
});

test('page keeps a single action row for this plugin and ignores foreign catalog rows', () => {
  const { tree } = renderPage({ catalog: CATALOG });
  const rows = findElements(tree, 'li');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => textOf(row).includes('重试上一回合')));
  assert.doesNotMatch(textOf(tree), /别的动作/);
});

test('restore-default and remove buttons submit reset and binding:null against the current revision', async () => {
  const { tree, calls, render } = renderPage({ catalog: [CATALOG[0]] });

  buttonByText(tree, '恢复默认').props.onClick();
  await flush();
  buttonByText(render(), '解除绑定').props.onClick();
  await flush();

  assert.deepEqual(calls.edit, [
    [{ type: 'reset', id: 'retry.lastTurn' }, 'rev-1'],
    [{ type: 'set', id: 'retry.lastTurn', binding: null }, 'rev-1'],
  ]);
  assert.match(textOf(render()), /已保存/);
});

test('typing a combination submits a set edit with the parsed binding', async () => {
  const { tree, calls, render } = renderPage({ catalog: [CATALOG[0]] });

  const input = findElements(tree, 'input')[0];
  input.props.onChange({ target: { value: 'Ctrl+Shift+R' } });
  buttonByText(render(), '应用').props.onClick();
  await flush();

  assert.deepEqual(calls.edit, [
    [{ type: 'set', id: 'retry.lastTurn', binding: { code: 'KeyR', modifiers: ['control', 'shift'] } }, 'rev-1'],
  ]);
});

test('an unparsable manual entry reports the error and writes nothing', async () => {
  const { tree, calls, render } = renderPage({ catalog: [CATALOG[0]] });

  findElements(tree, 'input')[0].props.onChange({ target: { value: 'R' } });
  buttonByText(render(), '应用').props.onClick();
  await flush();

  assert.deepEqual(calls.edit, []);
  assert.match(textOf(render()), /无法识别这个组合/);
});

test('recording failure shows the manual-input hint instead of crashing the page', async () => {
  const { tree, render, calls } = renderPage({
    catalog: [CATALOG[0]],
    recording: async () => {
      throw new Error('Desktop shortcuts bridge unavailable');
    },
  });

  await buttonByText(tree, '录制按键').props.onClick();
  await flush();

  const text = textOf(render());
  assert.match(text, /按键录制不可用，请手动输入组合/);
  assert.deepEqual(calls.recording, [true]);
  // 页面仍在：动作行和手输框都还渲染着。
  assert.equal(findElements(render(), 'li').length, 1);
  assert.equal(findElements(render(), 'input').length, 1);
});

test('recording success switches the button into the recording state', async () => {
  const { tree, render, calls } = renderPage({ catalog: [CATALOG[0]] });

  await buttonByText(tree, '录制按键').props.onClick();
  await flush();

  assert.deepEqual(calls.recording, [true]);
  assert.match(textOf(render()), /按下组合键/);
});

test('a conflict status names the owning action', async () => {
  const { tree, render } = renderPage({
    catalog: [CATALOG[0]],
    edit: async () => ({ status: 'conflict', conflicts: ['retry.lastTurn'], snapshot: { revision: 'rev-1' } }),
  });

  buttonByText(tree, '恢复默认').props.onClick();
  await flush();

  assert.match(textOf(render()), /与已有快捷键冲突：重试上一回合/);
});

test('page shows the loading hint while the configuration is not ready', () => {
  const { tree } = renderPage({ catalog: [CATALOG[0]], config: { revision: 'rev-1', status: 'loading' } });

  assert.match(textOf(tree), /正在读取快捷键配置/);
  assert.ok(findElements(tree, 'button').every((button) => button.props.disabled === true));
});

test('shortcutEdit builds the three edit operations', () => {
  const binding = { code: 'KeyR', modifiers: ['control', 'shift'] };

  assert.deepEqual(internals.shortcutEdit('set', 'retry.lastTurn', binding), {
    type: 'set',
    id: 'retry.lastTurn',
    binding,
  });
  assert.deepEqual(internals.shortcutEdit('reset', 'retry.lastTurn'), { type: 'reset', id: 'retry.lastTurn' });
  assert.deepEqual(internals.shortcutEdit('clear', 'retry.lastTurn'), {
    type: 'set',
    id: 'retry.lastTurn',
    binding: null,
  });
});

test('feedbackFor reports every edit status and names conflict owners', () => {
  const t = makeT('zh');
  const labelOf = (id) => (id === 'open-in-app.open' ? '在 App 中打开' : id);

  assert.deepEqual(internals.feedbackFor({ status: 'saved' }, t, labelOf), { text: '已保存', error: false });
  assert.deepEqual(internals.feedbackFor({ status: 'stale' }, t, labelOf), { text: '配置已变化，请重新操作', error: true });
  assert.deepEqual(internals.feedbackFor({ status: 'write-failed' }, t, labelOf), { text: '保存失败，请重试', error: true });
  assert.deepEqual(internals.feedbackFor({ status: 'conflict', conflicts: ['open-in-app.open'] }, t, labelOf), {
    text: '与已有快捷键冲突：在 App 中打开',
    error: true,
  });
  // 非法键位比冲突更具体，优先展示 issue。
  assert.deepEqual(internals.feedbackFor({ status: 'conflict', issue: 'reserved', conflicts: ['x'] }, t, labelOf), {
    text: '该组合被系统或编辑器占用',
    error: true,
  });

  assert.equal(internals.feedbackFor({ status: 'saved' }, makeT('en'), labelOf).text, 'Saved');
});

test('beginRecording degrades to manual input when the desktop bridge throws', async () => {
  const bridgeError = new Error('Desktop shortcuts bridge unavailable');
  const shortcuts = {
    recording: async () => {
      throw bridgeError;
    },
  };

  const outcome = await internals.beginRecording(shortcuts);
  assert.equal(outcome.mode, 'manual');
  assert.equal(outcome.reason, 'Desktop shortcuts bridge unavailable');
});

test('beginRecording keeps recording mode when the bridge answers', async () => {
  const calls = [];
  const shortcuts = { recording: async (active) => calls.push(active) };

  assert.deepEqual(await internals.beginRecording(shortcuts), { mode: 'recording' });
  assert.deepEqual(calls, [true]);
});

test('parseBindingText reads modifier and key spellings', () => {
  assert.deepEqual(internals.parseBindingText('Alt+R'), { code: 'KeyR', modifiers: ['alt'] });
  assert.deepEqual(internals.parseBindingText('Ctrl+Shift+R'), { code: 'KeyR', modifiers: ['control', 'shift'] });
  assert.deepEqual(internals.parseBindingText(' cmd + option + / '), {
    code: 'Slash',
    modifiers: ['meta', 'alt'],
  });
  assert.deepEqual(internals.parseBindingText('Shift+F5'), { code: 'F5', modifiers: ['shift'] });
  assert.deepEqual(internals.parseBindingText('Ctrl+1'), { code: 'Digit1', modifiers: ['control'] });

  assert.equal(internals.parseBindingText('R'), null);
  assert.equal(internals.parseBindingText('Ctrl+Shift'), null);
  assert.equal(internals.parseBindingText('Ctrl+R+E'), null);
  assert.equal(internals.parseBindingText('Ctrl+Nope'), null);
  assert.equal(internals.parseBindingText(''), null);
});

test('recordedBinding ignores bare modifier presses and normalizes through describeBinding', () => {
  const shortcuts = {
    // 注册表替身：修饰键按 control→alt→shift→meta 排序，未知物理键抛错。
    describeBinding: ({ code, modifiers }) => {
      if (code === 'IntlBackslash') throw new Error('Unsupported shortcut code: IntlBackslash');
      return {
        binding: {
          code,
          modifiers: ['control', 'alt', 'shift', 'meta'].filter((modifier) => modifiers.includes(modifier)),
        },
        keys: [],
        issue: null,
        conflicts: [],
      };
    },
  };

  assert.equal(
    internals.recordedBinding(shortcuts, {
      code: 'AltLeft',
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    }),
    null,
  );

  assert.deepEqual(
    internals.recordedBinding(shortcuts, {
      code: 'KeyR',
      altKey: true,
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
    }),
    { binding: { code: 'KeyR', modifiers: ['control', 'alt', 'shift'] } },
  );

  // 注册表不认识的物理键走 issue 反馈，不让 describeBinding 的异常冒到渲染层。
  assert.deepEqual(
    internals.recordedBinding(shortcuts, {
      code: 'IntlBackslash',
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    }),
    { error: 'unsupported-key' },
  );
});
