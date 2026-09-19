import test from 'node:test';
import assert from 'node:assert/strict';

import { createStreamCoalescer } from '../streamCoalescer.js';

/** 手动驱动的调度器，让「下一帧」在测试里变成显式的一步 */
const manualScheduler = () => {
  let queued = null;
  let nextId = 1;
  return {
    schedule: (cb) => { queued = cb; return nextId++; },
    cancel: () => { queued = null; },
    tick() {
      const cb = queued;
      queued = null;
      if (cb) cb();
    },
    get armed() { return queued !== null; },
  };
};

test('一帧内的多个 token 合成一次回调', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  '你好世界'.split('').forEach((ch) => c.push(ch));
  assert.deepEqual(out, [], '还没到下一帧，不该有任何回调');

  s.tick();
  assert.deepEqual(out, ['你好世界'], '4 个 token 应合成 1 次回调');
});

test('慢速流不会被合并，每个 token 各自成帧', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  c.push('a'); s.tick();
  c.push('b'); s.tick();
  assert.deepEqual(out, ['a', 'b'], 'token 之间隔了整帧时不该被攒起来');
});

test('flush 冲掉尾巴，不必等下一帧', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  c.push('未完成的半句');
  c.flush();
  assert.deepEqual(out, ['未完成的半句']);
  assert.equal(s.armed, false, 'flush 之后不该再留着一个已排队的帧');
});

test('重复 flush 与空 flush 都不产生多余回调', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  c.flush();
  assert.deepEqual(out, [], '没有内容时 flush 不该回调');

  c.push('x');
  c.flush();
  c.flush();
  assert.deepEqual(out, ['x'], '尾巴只该被冲一次');
});

test('一个字都不会丢：合并后的拼接等于原始序列', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  const tokens = Array.from({ length: 500 }, (_, i) => `t${i}`);
  tokens.forEach((tok, i) => {
    c.push(tok);
    // 不规则地插入帧边界，模拟真实的 rAF 抖动
    if (i % 7 === 0) s.tick();
  });
  c.flush();

  assert.equal(out.join(''), tokens.join(''), '合并不能改变内容');
  assert.ok(out.length < tokens.length / 5, `应显著少于 ${tokens.length} 次，实际 ${out.length} 次`);
});

test('discard 丢掉未发送内容，事后不再冒出残影', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  c.push('已经清除了还冒出来的残影');
  c.discard();
  assert.equal(s.armed, false, 'discard 必须取消已排队的帧');
  s.tick();
  assert.deepEqual(out, [], 'discard 之后即使再走一帧也不该有回调');
});

test('discard 之后还能继续正常使用', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  c.push('旧的'); c.discard();
  c.push('新的'); s.tick();
  assert.deepEqual(out, ['新的']);
});

test('空串与非字符串被忽略，不会排帧', () => {
  const s = manualScheduler();
  const out = [];
  const c = createStreamCoalescer((t) => out.push(t), s);

  c.push('');
  c.push(undefined);
  c.push(null);
  assert.equal(s.armed, false, '无内容时不该排帧');
  c.flush();
  assert.deepEqual(out, []);
});

test('回调里再次 push 的内容进入下一批，不会丢', () => {
  const s = manualScheduler();
  const out = [];
  let reentered = false;
  const c = createStreamCoalescer((t) => {
    out.push(t);
    if (!reentered) { reentered = true; c.push('迟到的'); }
  }, s);

  c.push('第一批');
  s.tick();
  assert.deepEqual(out, ['第一批']);

  s.tick();
  assert.deepEqual(out, ['第一批', '迟到的'], '重入 push 的内容应出现在下一帧');
});
