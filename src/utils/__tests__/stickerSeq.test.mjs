import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextStickerSeq, missCount, backfillStickerSeq,
  markStickerUsed, initStickerSeq, evictionOrder,
} from '../social/stickerSeq.js';

const e = (id, opts = {}) => ({ id, meaning: `m${id}`, file: `f${id}`, ...opts });

// ───────── 计数器 ─────────

test('计数器从 max(last_used_seq) 推出来，不单独存', () => {
  assert.equal(nextStickerSeq([]), 1);
  assert.equal(nextStickerSeq([e(1, { last_used_seq: 5 }), e(2, { last_used_seq: 12 })]), 13);
  assert.equal(nextStickerSeq(null), 1);
});

test('反复发同一张也会推进计数器', () => {
  const list = [e(1, { last_used_seq: 1 }), e(2, { last_used_seq: 2 })];
  markStickerUsed(list[0], list);   // → 3
  assert.equal(list[0].last_used_seq, 3);
  markStickerUsed(list[0], list);   // → 4
  assert.equal(list[0].last_used_seq, 4);
  assert.equal(list[0].used, 2);
  assert.equal(nextStickerSeq(list), 5);
});

test('淘汰不会让计数器回退 —— 被删的总是 seq 最小的', () => {
  const list = [e(1, { last_used_seq: 1 }), e(2, { last_used_seq: 2 }), e(3, { last_used_seq: 99 })];
  const order = evictionOrder(list);
  assert.equal(order[0].id, 1, '错过最多的先删');
  assert.notEqual(order[0].last_used_seq, 99, '持有最大 seq 的永远排在最后');
});

// ───────── miss 计数 ─────────

test('miss = 最新序号 − 自己的序号', () => {
  const list = [e(1, { last_used_seq: 10 }), e(2, { last_used_seq: 3 })];
  assert.equal(missCount(list[0], list), 0, '最近刚用过');
  assert.equal(missCount(list[1], list), 7);
});

test('没有序号的当作从头错到尾', () => {
  const list = [e(1, { last_used_seq: 50 }), e(2)];
  assert.equal(missCount(list[1], list), 50);
});

// ───────── 存量迁移 ─────────

test('按 last_used 升序补伪序号，保持旧的相对顺序', () => {
  const list = [
    e(1, { last_used: '2026-09-01T00:00:00Z' }),
    e(2, { last_used: '2026-04-01T00:00:00Z' }),
    e(3, { last_used: '2026-06-01T00:00:00Z' }),
  ];
  assert.equal(backfillStickerSeq(list), 3);
  // 最久没用的拿最小序号 = 淘汰时排最前，和旧行为一致
  assert.ok(list[1].last_used_seq < list[2].last_used_seq);
  assert.ok(list[2].last_used_seq < list[0].last_used_seq);
});

test('⚠️ 从没发过的排最后，不会一进来就被删', () => {
  // 旧实现把 last_used 为空当时间戳 0，排最前必被淘汰
  const list = [
    e(1, { last_used: '2026-04-01T00:00:00Z', used: 21 }),
    e(2),   // 刚存进来，还没机会用
  ];
  backfillStickerSeq(list);
  assert.ok(list[1].last_used_seq > list[0].last_used_seq,
    '没用过的序号更大 = miss 更少 = 更安全');
  assert.equal(evictionOrder(list)[0].id, 1);
});

test('已有序号的不被覆盖', () => {
  const list = [e(1, { last_used_seq: 7 }), e(2, { last_used: '2026-01-01T00:00:00Z' })];
  backfillStickerSeq(list);
  assert.equal(list[0].last_used_seq, 7);
  assert.ok(list[1].last_used_seq > 7, '补的序号接在已有的之后，不撞车');
});

test('全都有序号时是 no-op', () => {
  const list = [e(1, { last_used_seq: 1 }), e(2, { last_used_seq: 2 })];
  assert.equal(backfillStickerSeq(list), 0);
});

test('坏时间戳不会炸', () => {
  const list = [e(1, { last_used: 'garbage' }), e(2, { last_used: '2026-01-01T00:00:00Z' })];
  backfillStickerSeq(list);
  assert.ok(Number.isFinite(list[0].last_used_seq));
  assert.ok(Number.isFinite(list[1].last_used_seq));
});

// ───────── 新入库 ─────────

test('新表情拿当前序号，等价于"刚用过"', () => {
  const list = [e(1, { last_used_seq: 10 }), e(2, { last_used_seq: 20 })];
  const fresh = e(3);
  initStickerSeq(fresh, list);
  list.push(fresh);
  assert.equal(missCount(fresh, list), 0);
  assert.equal(evictionOrder(list)[0].id, 1, '最该删的还是错过最多的那个');
});

// ───────── 真实数据的行为对照 ─────────

test('复现真实库：高频老将不再因为"久未使用"被优先淘汰', () => {
  // 取自真实 index.yaml 的形态
  const list = [
    e(154, { used: 21, last_used: '2026-04-05T00:00:00Z' }),
    e(314, { used: 2, last_used: '2026-04-30T00:00:00Z' }),
    e(88, { used: 216, last_used: '2026-09-17T00:00:00Z' }),
  ];
  backfillStickerSeq(list);
  // 迁移后仍按旧顺序（这是有意的：过渡期退化成旧行为）
  assert.equal(evictionOrder(list)[0].id, 154);

  // 但只要 #154 再被选中一次，它就立刻回到队尾
  markStickerUsed(list[0], list);
  assert.equal(missCount(list[0], list), 0);
  assert.equal(evictionOrder(list)[0].id, 314, '现在轮到真正没人用的那个了');
});

test('evictionOrder 不改原数组，且能排除指定 id', () => {
  const list = [e(1, { last_used_seq: 1 }), e(2, { last_used_seq: 2 })];
  const snapshot = list.map(x => x.id);
  const order = evictionOrder(list, { excludeId: 1 });
  assert.deepEqual(list.map(x => x.id), snapshot);
  assert.deepEqual(order.map(x => x.id), [2], '刚存的那张豁免');
});

test('空输入安全', () => {
  assert.deepEqual(evictionOrder([]), []);
  assert.deepEqual(evictionOrder(null), []);
  assert.equal(backfillStickerSeq([]), 0);
});
