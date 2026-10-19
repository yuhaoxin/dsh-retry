/**
 * Host 半身单测：`/retry` 的投影折叠、可重试判定与注册接线。
 *
 * 判定输入是 session projection 的状态（不是事件数组），所以用例直接折叠事件
 * 序列，不引入 DSH 运行时。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RETRY_PROJECTION_KEY,
  createRetryCommand,
  isRetryableTurnBoundary,
  retryTurnBoundaryProjection,
  retryTurnBoundarySchema,
  runRetry,
} from '../src/host/retry.js';
import { installRetry, loadUserMessageFactory } from '../index.js';

/** 造一条只带边界字段的会话事件。 */
function turnStart(turn) {
  return { type: 'turn/start', seq: 0, data: { turn } };
}

/** 造一条带结束原因的 turn/end。 */
function turnEnd(turn, reason) {
  return { type: 'turn/end', seq: 0, data: { turn, reason } };
}

/** 按投影自己的 init + apply 折叠事件序列，得到判定输入。 */
function fold(events) {
  return events.reduce(retryTurnBoundaryProjection.apply, retryTurnBoundaryProjection.init());
}

/** 造一个假的 UserMessage 构造器，记录它收到的入参。 */
function recordingFactory() {
  const calls = [];
  const factory = (input) => {
    const message = { id: `message-${calls.length}`, role: 'user', ...input };
    calls.push(message);
    return message;
  };
  return { factory, calls };
}

/** 造一个记录 followup 的假 invocation，以及返回固定投影状态的 sessionProjections。 */
function invocationWith(state) {
  const followed = [];
  return {
    followed,
    invocation: {
      commandId: 'cmd-test-1',
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
      agent: {
        id: 'session-test',
        session: { id: 'session-test' },
        followup: (message) => followed.push(message),
      },
    },
    sessionProjections: { stateOf: () => state },
  };
}

test('投影折叠 turn/start 与 turn/end：记录结束原因并跟踪回合开合', () => {
  assert.deepEqual(fold([]), { lastTurnEndKind: null, openTurn: false });

  const running = fold([turnStart(1)]);
  assert.deepEqual(running, { lastTurnEndKind: null, openTurn: true });

  const errored = fold([turnStart(1), turnEnd(1, { kind: 'error' })]);
  assert.deepEqual(errored, { lastTurnEndKind: 'error', openTurn: false });

  // 失败回合之后又开新回合：保留结束原因，但标记回合开着。
  const reopened = fold([turnStart(1), turnEnd(1, { kind: 'error' }), turnStart(2)]);
  assert.deepEqual(reopened, { lastTurnEndKind: 'error', openTurn: true });
});

test('投影 apply 对无关事件返回同一个 state 引用（不触发变更通知）', () => {
  const state = { lastTurnEndKind: 'aborted', openTurn: false };
  for (const type of ['step/start', 'step/end', 'assistant/message', 'user/message', 'tool/result']) {
    assert.equal(retryTurnBoundaryProjection.apply(state, { type, seq: 1, data: {} }), state, type);
  }
  // 已在开着的回合里再遇到 turn/start 也不产生新对象。
  const open = { lastTurnEndKind: null, openTurn: true };
  assert.equal(retryTurnBoundaryProjection.apply(open, turnStart(1)), open);
});

test('投影 stateSchema 接受自身 init/apply 的产物，拒绝形状错误的持久化值', () => {
  assert.deepEqual(retryTurnBoundarySchema.parse({ lastTurnEndKind: null, openTurn: false }), {
    lastTurnEndKind: null,
    openTurn: false,
  });
  assert.deepEqual(retryTurnBoundarySchema.parse({ lastTurnEndKind: 'error', openTurn: true }), {
    lastTurnEndKind: 'error',
    openTurn: true,
  });
  for (const bad of [null, [], 'error', {}, { lastTurnEndKind: 1, openTurn: false }, { lastTurnEndKind: null }]) {
    assert.throws(() => retryTurnBoundarySchema.parse(bad), TypeError);
  }
});

test('isRetryableTurnBoundary 只接受 error / aborted / interrupted 的已结束回合', () => {
  for (const kind of ['error', 'aborted', 'interrupted']) {
    assert.equal(isRetryableTurnBoundary({ lastTurnEndKind: kind, openTurn: false }), true, kind);
  }
  for (const kind of ['completed', 'blocked', 'max-tokens', 'forked', 'future-reason', null]) {
    assert.equal(isRetryableTurnBoundary({ lastTurnEndKind: kind, openTurn: false }), false, String(kind));
  }
  // 回合仍开着时不可重试，即使上一次结束原因是可重试的。
  assert.equal(isRetryableTurnBoundary({ lastTurnEndKind: 'error', openTurn: true }), false);
});

test('有可重试回合时调用一次 followup 并返回 success', () => {
  const { factory, calls } = recordingFactory();
  const { invocation, followed, sessionProjections } = invocationWith({
    lastTurnEndKind: 'error',
    openTurn: false,
  });

  const result = runRetry(invocation, factory, sessionProjections);

  assert.equal(result.kind, 'success');
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length > 0);
  assert.equal(followed.length, 1);
  assert.equal(calls.length, 1);
  // 载荷必须来自 createUserMessage，且来源不是 user（客户端渲染为 turn-trigger 卡片）。
  assert.equal(followed[0], calls[0]);
  assert.equal(followed[0].role, 'user');
  assert.deepEqual(followed[0].source, { kind: 'cordis-host-runner' });
  assert.equal(followed[0].content.length, 1);
  assert.equal(followed[0].content[0].type, 'text');
  assert.ok(followed[0].content[0].text.includes('重试'));
});

test('被中断（aborted）与被恢复（interrupted）的回合同样可重试', () => {
  for (const kind of ['aborted', 'interrupted']) {
    const { factory } = recordingFactory();
    const { invocation, followed, sessionProjections } = invocationWith({
      lastTurnEndKind: kind,
      openTurn: false,
    });
    const result = runRetry(invocation, factory, sessionProjections);
    assert.equal(result.kind, 'success', kind);
    assert.equal(followed.length, 1, kind);
  }
});

test('无可重试回合时返回 error 且不调用 followup', () => {
  const { factory, calls } = recordingFactory();
  const { invocation, followed, sessionProjections } = invocationWith(fold([]));

  const result = runRetry(invocation, factory, sessionProjections);

  assert.deepEqual(result, { kind: 'error', text: 'Nothing to retry.' });
  assert.equal(followed.length, 0);
  assert.equal(calls.length, 0);
});

test('最后一条是 completed 时返回 error 且不调用 followup', () => {
  const { factory, calls } = recordingFactory();
  const { invocation, followed, sessionProjections } = invocationWith(
    fold([turnStart(1), turnEnd(1, { kind: 'completed' })]),
  );

  const result = runRetry(invocation, factory, sessionProjections);

  assert.deepEqual(result, { kind: 'error', text: 'Nothing to retry.' });
  assert.equal(followed.length, 0);
  assert.equal(calls.length, 0);
});

test('失败回合之后又开了新回合（回合仍打开）时不可重试', () => {
  const { factory } = recordingFactory();
  const { invocation, followed, sessionProjections } = invocationWith(
    fold([turnStart(1), turnEnd(1, { kind: 'error' }), turnStart(2)]),
  );

  const result = runRetry(invocation, factory, sessionProjections);

  assert.deepEqual(result, { kind: 'error', text: 'Nothing to retry.' });
  assert.equal(followed.length, 0);
});

test('投影未注册时抛出显式错误，不静默返回 Nothing to retry', () => {
  const { factory } = recordingFactory();
  const { invocation } = invocationWith(undefined);

  assert.throws(
    () => runRetry(invocation, factory, { stateOf: () => undefined }),
    /retryTurnBoundary/,
  );
});

test('createRetryCommand 的命令名与描述符合注册契约', () => {
  const { factory } = recordingFactory();
  const command = createRetryCommand(factory, { stateOf: () => undefined });

  assert.equal(command.name, 'retry');
  assert.match(command.name, /^[a-z][a-z0-9_-]*$/);
  assert.equal(typeof command.description, 'string');
  assert.ok(command.description.trim().length > 0);
  assert.equal(typeof command.handler, 'function');
});

test('loadUserMessageFactory 在模块解析失败时抛出指明模块的错误', async () => {
  await assert.rejects(
    loadUserMessageFactory(() => Promise.reject(new Error('MODULE_NOT_FOUND'))),
    /@deepseek-ai\/dsh-llm/,
  );
});

test('loadUserMessageFactory 在模块缺少 createUserMessage 时抛错', async () => {
  await assert.rejects(loadUserMessageFactory(() => Promise.resolve({})), /createUserMessage/);
});

test('installRetry 先注册投影再注册命令，且 handler 走同一套判定', () => {
  const { factory, calls } = recordingFactory();
  const registered = [];
  const projections = [];
  const state = { lastTurnEndKind: 'aborted', openTurn: false };
  const sessionProjections = {
    register: (definition) => projections.push(definition),
    stateOf: () => state,
  };
  const ctx = {
    sessionProjections,
    commands: { register: (definition) => registered.push(definition) },
  };

  installRetry(ctx, factory);

  assert.equal(projections.length, 1);
  assert.equal(projections[0], retryTurnBoundaryProjection);
  assert.equal(projections[0].key, RETRY_PROJECTION_KEY);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'retry');

  const { invocation, followed } = invocationWith(state);
  const result = registered[0].handler(invocation);

  assert.equal(result.kind, 'success');
  assert.equal(followed.length, 1);
  // 注册用的构造器就是 handler 用的构造器。
  assert.equal(calls.length, 1);
  assert.equal(followed[0], calls[0]);
});
