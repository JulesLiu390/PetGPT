import test from 'node:test';
import assert from 'node:assert/strict';

import { initialState } from '../initialState.js';
import { SLOW_FIELDS, FAST_FIELDS } from '../stateFields.js';

/**
 * StateProvider 用一份显式的字段清单来算 slowState 的 memo 依赖，好把高频的
 * streamingReplies 排除在外。代价是清单漏了字段不会报错 —— 那个字段的更新
 * 只是静默地不再传播给订阅者。
 *
 * 这里守住静态的那一半（initialState）。动态加进 state 的字段由 Provider 里
 * 的开发期断言兜住（`runFromHereTimestamp` 就属于这类，它只在 reducer 出现）。
 */

test('initialState 的每个字段都被某个 Context 覆盖', () => {
  const tracked = new Set([...SLOW_FIELDS, ...FAST_FIELDS]);
  const missing = Object.keys(initialState).filter((k) => !tracked.has(k));
  assert.deepEqual(
    missing, [],
    `这些字段没进 SLOW_FIELDS/FAST_FIELDS，它们的更新不会传播到订阅者：${missing.join(', ')}`,
  );
});

test('streamingReplies 必须留在快通道，不能混进 slowState', () => {
  // 它一旦进了 SLOW_FIELDS，memo 每帧都会失效，整个拆分就白做了
  assert.ok(!SLOW_FIELDS.includes('streamingReplies'));
  assert.ok(FAST_FIELDS.includes('streamingReplies'));
});

test('两份清单不重叠', () => {
  const overlap = SLOW_FIELDS.filter((f) => FAST_FIELDS.includes(f));
  assert.deepEqual(overlap, []);
});

test('清单内无重复项，依赖数组才不会白白变长', () => {
  assert.equal(new Set(SLOW_FIELDS).size, SLOW_FIELDS.length);
});

test('reducer 写入的动态字段也在清单里', () => {
  // runFromHereTimestamp 不在 initialState，但 reducer 会写、ChatboxInputBox 会读。
  // 漏掉它的话「从这里重跑」会拿到过期时间戳，静默失灵。
  assert.ok(
    SLOW_FIELDS.includes('runFromHereTimestamp'),
    'runFromHereTimestamp 被 reducer 写入且被消费，必须在清单里',
  );
});
