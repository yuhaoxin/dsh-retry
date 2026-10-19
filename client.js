/**
 * Client 半身入口：包在 DeepSeek Harness 的模块加载器壳里，factory 返回 Cordis 插件对象。
 *
 * 注册可改键动作 retry.lastTurn（默认 Alt+R，只声明 desktop 三平台），触发 Host 命令 /retry。
 * 动作随快捷键目录出现在「设置」→「通用」→「快捷键」，改键、落盘与冲突提示都由
 * ctx.shortcuts 注册表负责。
 *
 * 另外注册 settings.section 页面「重试快捷键」：列出本插件动作的当前键位、修改标记、
 * 冲突与非法提示，并提供录制 / 手动输入 / 恢复默认 / 解除绑定。页面逻辑分两层：
 * 行数据、edit 参数、录制降级、状态文案都是纯函数，React 渲染只负责把结果画出来。
 *
 * 仓库没有构建步骤，client.js 以 classic script 形式由加载器执行，因此不能写 ESM export；
 * 纯逻辑挂在插件对象的 `internals` 上供 node:test 断言，浏览器加载器只读 `id` 与 `factory`。
 */

const NS = 'dsh-retry';

/**
 * 本插件注册的快捷键动作；设置页只列这些行。
 *
 * ponytail: 录制与手输都写第一个动作。当前只有一个动作够用；出现第二个可改键动作时，
 * 录制状态要带上目标行 id，不能再用下标。
 */
const SHORTCUT_IDS = ['retry.lastTurn'];

/** 运行期词典；包根 locale/*.json 只承载插件管理器读取的 meta。 */
const zh = {
  'shortcut.retryLastTurn': '重试上一回合',
  'shortcut.noSession': '当前没有主会话，无法重试',
  'settings.nav': '重试快捷键',
  'settings.title': '重试快捷键',
  'settings.intro': '设置「重试上一回合」的按键。桌面端直接按键录制，浏览器端手动输入组合。',
  'settings.modified': '已修改',
  'settings.unbound': '未绑定',
  'settings.conflict': '与「{commands}」冲突',
  'settings.separator': '、',
  'settings.issue.modifier-required': '组合键必须包含 Ctrl、Alt 或 Command',
  'settings.issue.reserved': '该组合被系统或编辑器占用',
  'settings.issue.unsupported-browser': '浏览器不支持该组合',
  'settings.issue.unsupported-key': '该按键不受支持',
  'settings.record': '录制按键',
  'settings.recording': '按下组合键…',
  'settings.recordUnavailable': '按键录制不可用，请手动输入组合',
  'settings.manual': '输入组合，如 Alt+R 或 Ctrl+Shift+R',
  'settings.apply': '应用',
  'settings.invalidBinding': '无法识别这个组合，试试 Alt+R、Ctrl+Shift+R',
  'settings.reset': '恢复默认',
  'settings.clear': '解除绑定',
  'settings.status.saved': '已保存',
  'settings.status.stale': '配置已变化，请重新操作',
  'settings.status.conflict': '与已有快捷键冲突：{commands}',
  'settings.status.unreadable': '快捷键配置无法读取',
  'settings.status.write-failed': '保存失败，请重试',
  'settings.status.not-ready': '快捷键服务尚未就绪',
  'settings.status.loading': '正在读取快捷键配置…',
};
const en = {
  'shortcut.retryLastTurn': 'Retry last turn',
  'shortcut.noSession': 'No main conversation to retry',
  'settings.nav': 'Retry shortcuts',
  'settings.title': 'Retry shortcuts',
  'settings.intro': 'Choose the key for “Retry last turn”. Desktop records the keys; in a browser type the combination.',
  'settings.modified': 'Customized',
  'settings.unbound': 'No shortcut',
  'settings.conflict': 'Conflicts with “{commands}”',
  'settings.separator': ', ',
  'settings.issue.modifier-required': 'Include Ctrl, Alt, or Command in the combination.',
  'settings.issue.reserved': 'This combination is reserved for system or editing actions.',
  'settings.issue.unsupported-browser': 'This browser does not support the combination.',
  'settings.issue.unsupported-key': 'This key is not supported.',
  'settings.record': 'Record keys',
  'settings.recording': 'Press the combination…',
  'settings.recordUnavailable': 'Key recording is unavailable here. Type the combination instead.',
  'settings.manual': 'Type a combination, e.g. Alt+R or Ctrl+Shift+R',
  'settings.apply': 'Apply',
  'settings.invalidBinding': 'Unrecognized combination. Try Alt+R or Ctrl+Shift+R.',
  'settings.reset': 'Restore default',
  'settings.clear': 'Remove',
  'settings.status.saved': 'Saved',
  'settings.status.stale': 'The configuration changed. Try again.',
  'settings.status.conflict': 'Already used by “{commands}”',
  'settings.status.unreadable': 'Shortcut configuration cannot be read.',
  'settings.status.write-failed': 'Could not save. Try again.',
  'settings.status.not-ready': 'Shortcuts are not ready yet.',
  'settings.status.loading': 'Loading shortcut configuration…',
};

/**
 * 把快捷键目录裁剪成设置页的行。
 *
 * catalog 行来自 `ctx.shortcuts.catalog.getSnapshot()`，包含全部已注册命令；设置页只保留
 * 本插件声明的动作。冲突 id 在同一份目录里换成可读名字，找不到时保留 id。
 *
 * @param {Array<{ id: string, label: string, keys: string[], modified: boolean, issue: string|null, conflicts: string[] }>} catalog
 *   快捷键目录快照。
 * @returns {Array<object>} 展示行：`{ id, label, keys, modified, issue, conflicts, conflictLabels }`。
 */
function shortcutRows(catalog) {
  const labels = new Map(catalog.map((row) => [row.id, row.label]));
  return catalog
    .filter((row) => SHORTCUT_IDS.includes(row.id))
    .map((row) => ({
      id: row.id,
      label: row.label,
      keys: row.keys,
      modified: row.modified,
      issue: row.issue,
      conflicts: row.conflicts,
      conflictLabels: row.conflicts.map((id) => labels.get(id) ?? id),
    }));
}

/**
 * 构造一次快捷键写入操作。
 *
 * 三种用户动作共用 `ctx.shortcuts.edit(edit, revision)` 的入参形状：
 * set 写入新组合，reset 恢复默认，clear 用 `binding: null` 解除绑定。
 *
 * @param {'set'|'reset'|'clear'} action - 用户动作。
 * @param {string} id - 命令 id。
 * @param {{ code: string, modifiers: string[] } | null} [binding] - set 时的新组合。
 * @returns {{ type: 'set', id: string, binding: object|null } | { type: 'reset', id: string }} edit 入参。
 */
function shortcutEdit(action, id, binding) {
  if (action === 'reset') return { type: 'reset', id };
  return { type: 'set', id, binding: action === 'clear' ? null : binding };
}

/**
 * 进入按键录制；录制桥不可用时报告降级。
 *
 * 桌面端 `recording(true)` 打开原生录制保护；web 端或缺少桌面桥时该调用会抛
 * `Desktop shortcuts bridge unavailable`，此时页面改用文本框手输，不能让异常冒到渲染层。
 *
 * @param {{ recording: (active: boolean) => Promise<void> }} shortcuts - ctx.shortcuts。
 * @returns {Promise<{ mode: 'recording' | 'manual', reason?: string }>} 录制结果或降级原因。
 */
async function beginRecording(shortcuts) {
  try {
    await shortcuts.recording(true);
    return { mode: 'recording' };
  } catch (error) {
    return { mode: 'manual', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 结束录制；失败只影响原生保护，不影响页面状态。
 *
 * 桌面桥缺失时 `recording(false)` 与进入录制时抛同一个错误，退出录制的清理路径不能因此中断。
 *
 * @param {{ recording: (active: boolean) => Promise<void> }} shortcuts - ctx.shortcuts。
 * @returns {void}
 */
function stopRecording(shortcuts) {
  Promise.resolve(shortcuts.recording(false)).catch(() => {});
}

/**
 * 把 edit 返回的 status 翻成用户可读反馈。
 *
 * `conflict` 优先展示非法原因（`issue`），否则列出占用该组合的命令名。
 *
 * @param {{ status: string, issue?: string|null, conflicts?: string[] }} result - edit 返回值。
 * @param {(key: string, params?: object) => string} t - 本插件词典。
 * @param {(id: string) => string} labelOf - 冲突 id 到展示名的映射。
 * @returns {{ text: string, error: boolean }} 反馈文案与是否为错误态。
 */
function feedbackFor(result, t, labelOf) {
  if (result.status === 'saved') return { text: t('settings.status.saved'), error: false };
  if (result.status === 'conflict') {
    if (result.issue) return { text: t(`settings.issue.${result.issue}`), error: true };
    const commands = (result.conflicts ?? []).map(labelOf).join('、');
    return { text: t('settings.status.conflict', { commands }), error: true };
  }
  return { text: t(`settings.status.${result.status}`), error: true };
}

/** 手动输入里的修饰键别名。 */
const MODIFIER_WORDS = {
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
};

/** 手动输入里的具名键。 */
const KEY_WORDS = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  slash: 'Slash',
  comma: 'Comma',
  period: 'Period',
  backslash: 'Backslash',
  backquote: 'Backquote',
  minus: 'Minus',
  equal: 'Equal',
};

/** 单字符标点对应的 KeyboardEvent.code。 */
const SYMBOL_CODES = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
};

/**
 * 解析一个 KeyboardEvent.code。
 *
 * @param {string} part - 已去空白的按键片段。
 * @returns {string|null} KeyboardEvent.code；不认识时为 null。
 */
function keyCodeOf(part) {
  const lower = part.toLowerCase();
  if (KEY_WORDS[lower] !== undefined) return KEY_WORDS[lower];
  if (/^[a-z]$/u.test(lower)) return `Key${lower.toUpperCase()}`;
  if (/^[0-9]$/u.test(lower)) return `Digit${lower}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/u.test(lower)) return lower.toUpperCase();
  return SYMBOL_CODES[part] ?? null;
}

/**
 * 把文本框里的组合解析成物理绑定。
 *
 * 只接受至少一个修饰键加一个主键，如 `Alt+R`、`Ctrl+Shift+R`、`Cmd+/`。返回值交给
 * `ctx.shortcuts.edit` 校验；非法组合（无修饰键、保留键）由 edit 返回 conflict + issue，
 * 这里只负责语法层面解析不了的输入。
 *
 * @param {string} text - 用户输入。
 * @returns {{ code: string, modifiers: string[] } | null} 物理绑定；解析失败为 null。
 */
function parseBindingText(text) {
  const parts = String(text)
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return null;

  const modifiers = [];
  let code;
  for (const part of parts) {
    const modifier = MODIFIER_WORDS[part.toLowerCase()];
    if (modifier !== undefined) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (code !== undefined) return null;
    code = keyCodeOf(part);
    if (code === null) return null;
  }
  if (code === undefined) return null;
  return { code, modifiers };
}

/** KeyboardEvent 修饰键标志位。 */
const MODIFIER_FLAGS = { control: 'ctrlKey', alt: 'altKey', shift: 'shiftKey', meta: 'metaKey' };

/**
 * 把录制到的按键事件转成可提交的物理绑定。
 *
 * 只按下修饰键时返回 null，由调用方忽略。`describeBinding` 会规范化修饰键顺序，也会对
 * 注册表不认识的物理键（如 `IntlBackslash`、小键盘键）抛错；这里吸收成 `unsupported-key`
 * 反馈，避免这个异常穿过 edit 变成误导性的「保存失败」。
 *
 * @param {{ describeBinding: Function }} shortcuts - ctx.shortcuts。
 * @param {KeyboardEvent} event - 页面收到的按键事件。
 * @returns {{ binding: { code: string, modifiers: string[] } } | { error: string } | null}
 *   规范化后的绑定、非法键位原因，或 null（只有修饰键）。
 */
function recordedBinding(shortcuts, event) {
  if (/^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(event.code)) return null;
  const raw = {
    code: event.code,
    modifiers: Object.keys(MODIFIER_FLAGS).filter((modifier) => event[MODIFIER_FLAGS[modifier]]),
  };
  try {
    return { binding: shortcuts.describeBinding(raw).binding };
  } catch (_error) {
    return { error: 'unsupported-key' };
  }
}

/**
 * 构建设置页 React 组件。
 *
 * 组件只做渲染与事件接线：目录、配置快照直接订阅 ctx.shortcuts 的两个 store，
 * 提交逻辑全部走上面的纯函数。
 *
 * @param {object} React - 平台注入的 react 实例。
 * @param {{ t: Function, shortcuts: object }} deps - 词典与快捷键服务。
 * @returns {Function} settings.section 组件。
 */
function createSettingsView(React, { t, shortcuts }) {
  const { createElement: h } = React;

  /**
   * 订阅一个快照 store。
   *
   * @param {{ subscribe: Function, getSnapshot: Function }} store - ctx.shortcuts 的 catalog 或 config。
   * @returns {object} 当前快照。
   */
  const useSnapshot = (store) => React.useSyncExternalStore(store.subscribe, store.getSnapshot);

  const sectionStyle = { padding: '8px 0' };
  const titleStyle = { margin: '0 0 4px', fontSize: 16, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' };
  const introStyle = { margin: '0 0 16px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
  const rowStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 0',
    borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
  };
  const lineStyle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: '22px' };
  const badgeStyle = {
    padding: '0 10px',
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-module-platform)',
    fontSize: 12,
    lineHeight: '14px',
    color: 'var(--dsw-alias-label-secondary)',
  };
  const hintStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
  const errorHintStyle = { ...hintStyle, color: 'var(--dsw-alias-state-warn-secondary)' };
  const controlsStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
  const inputStyle = {
    boxSizing: 'border-box',
    height: 30,
    minWidth: 220,
    padding: '0 10px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 12,
  };

  /**
   * 设置页内容：动作行 + 录制 / 手输 / 恢复默认 / 解除绑定。
   *
   * @returns {object} 页面元素。
   */
  return function ShortcutSettingsSection() {
    const catalog = useSnapshot(shortcuts.catalog);
    const config = useSnapshot(shortcuts.config);
    const [recording, setRecording] = React.useState(false);
    const [text, setText] = React.useState('');
    const [feedback, setFeedback] = React.useState(null);
    const [busy, setBusy] = React.useState(false);

    const rows = shortcutRows(catalog);
    // 冲突对象可能是别的插件的命令，名字要从整份目录取，不能只查本插件的行。
    const labelOf = (id) => catalog.find((row) => row.id === id)?.label ?? id;
    const disabled = busy || config.status !== 'ready';

    /**
     * 提交一次写盘并展示结果。
     *
     * @param {object} edit - shortcutEdit 产出的 edit 入参。
     * @returns {Promise<void>}
     */
    const save = async (edit) => {
      setBusy(true);
      const result = await shortcuts.edit(edit, config.revision);
      setBusy(false);
      setFeedback(feedbackFor(result, t, labelOf));
    };

    /**
     * 进入录制；桌面桥缺失时只提示并保留手输。
     *
     * @returns {Promise<void>}
     */
    const startRecording = async () => {
      const outcome = await beginRecording(shortcuts);
      if (outcome.mode === 'manual') {
        setFeedback({ text: t('settings.recordUnavailable'), error: true });
        return;
      }
      setRecording(true);
      setFeedback({ text: t('settings.recording'), error: false });
    };

    // 只随录制开关重挂监听：捕获时用进入录制那一刻的 revision 提交，
    // 期间配置若被改动，edit 返回 stale，而不是静默覆盖别人的修改。
    React.useEffect(() => {
      if (!recording) return undefined;
      const onKeyDown = (event) => {
        if (event.code === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          setRecording(false);
          setFeedback(null);
          return;
        }
        const recorded = recordedBinding(shortcuts, event);
        if (recorded === null) return;
        event.preventDefault();
        event.stopPropagation();
        setRecording(false);
        if (recorded.error !== undefined) {
          setFeedback({ text: t(`settings.issue.${recorded.error}`), error: true });
          return;
        }
        void save(shortcutEdit('set', SHORTCUT_IDS[0], recorded.binding));
      };
      document.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('keydown', onKeyDown, true);
        stopRecording(shortcuts);
      };
    }, [recording]);

    /**
     * 应用手输组合。
     *
     * @returns {void}
     */
    const applyText = () => {
      const binding = parseBindingText(text);
      if (binding === null) {
        setFeedback({ text: t('settings.invalidBinding'), error: true });
        return;
      }
      void save(shortcutEdit('set', SHORTCUT_IDS[0], binding));
    };

    /**
     * 渲染一行动作。
     *
     * @param {object} row - shortcutRows 的一行。
     * @returns {object} 列表项元素。
     */
    const renderRow = (row) =>
      h(
        'li',
        { key: row.id, style: rowStyle },
        h(
          'div',
          { style: lineStyle },
          h('span', null, row.label),
          h('span', { style: badgeStyle }, row.keys.length === 0 ? t('settings.unbound') : row.keys.join('')),
          row.modified ? h('span', { style: badgeStyle }, t('settings.modified')) : null,
        ),
        row.conflicts.length === 0
          ? null
          : h('p', { style: errorHintStyle }, t('settings.conflict', { commands: row.conflictLabels.join(t('settings.separator')) })),
        row.issue === null ? null : h('p', { style: errorHintStyle }, t(`settings.issue.${row.issue}`)),
        h(
          'div',
          { style: controlsStyle },
          h(
            'button',
            { type: 'button', disabled, onClick: () => void startRecording() },
            recording ? t('settings.recording') : t('settings.record'),
          ),
          h(
            'button',
            { type: 'button', disabled, onClick: () => void save(shortcutEdit('reset', row.id)) },
            t('settings.reset'),
          ),
          h(
            'button',
            { type: 'button', disabled, onClick: () => void save(shortcutEdit('clear', row.id)) },
            t('settings.clear'),
          ),
        ),
        h(
          'div',
          { style: controlsStyle },
          h('input', {
            type: 'text',
            style: inputStyle,
            value: text,
            placeholder: t('settings.manual'),
            'aria-label': t('settings.manual'),
            disabled,
            onChange: (event) => setText(event.target.value),
          }),
          h('button', { type: 'button', disabled, onClick: applyText }, t('settings.apply')),
        ),
      );

    const statusHint =
      config.status === 'ready'
        ? null
        : h('p', { style: hintStyle, role: 'status' }, t(`settings.status.${config.status === 'loading' ? 'loading' : 'unreadable'}`));

    return h(
      'section',
      { style: sectionStyle },
      h('h2', { style: titleStyle }, t('settings.title')),
      h('p', { style: introStyle }, t('settings.intro')),
      statusHint,
      h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, ...rows.map(renderRow)),
      feedback === null
        ? null
        : h(
            'p',
            {
              role: 'status',
              style: {
                ...hintStyle,
                color: feedback.error ? 'var(--dsw-alias-state-warn-secondary)' : 'var(--dsw-alias-state-success-secondary)',
              },
            },
            feedback.text,
          ),
    );
  };
}

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
  factory(require) {
    return {
      inject: [],
      /** 纯逻辑句柄：无构建步骤，node:test 从这里断言行数据、edit 参数与降级判断。 */
      internals: { shortcutRows, shortcutEdit, beginRecording, feedbackFor, parseBindingText, recordedBinding, SHORTCUT_IDS },
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

          // settings.section 由设置壳声明；声明出现后才注册页面。react 到这一步才解析：
          // 非 web 环境不加载渲染层，模块工厂也不会因缺少 react 而失败。
          //
          // 设置页走独立子注入而不是并入上面的主注入：cordis 的 inject 是硬门禁，把 slots
          // 放进主注入会让渲染层成为整个插件体的前置条件，没有渲染层的部署连 retry.lastTurn
          // 都不会注册。子注入缺失时只失去设置页，重试动作照常可用。
          scope.inject(['slots'], (slotScope) => {
            slotScope.slots.inject('settings.section', () => {
              const React = require('react');
              return slotScope.slots.register(
                {
                  name: 'settings.section',
                  id: 'dsh-retry',
                  order: 60,
                  label: () => t('settings.nav'),
                  locale: NS,
                },
                createSettingsView(React, { t, shortcuts: scope.shortcuts }),
              );
            });
          });
        });
      },
    };
  },
});
