import test from 'node:test';
import assert from 'node:assert/strict';

import {
  messageTimeMs, msgTime, createCursor, isCursorUnset,
  messagesAfter, advanceCursor, sortByTime,
} from '../social/messageCursor.js';

// qq-mcp 实际给的形状：datetime.isoformat() 带固定时区偏移
const m = (id, iso) => ({ message_id: String(id), timestamp: iso, content: `msg${id}` });
const T = (sec) => `2026-09-20T05:${String(sec).padStart(2, '0')}:00+08:00`;

// ───────── 时间解析 ─────────

test('ISO 8601 / Unix 秒 / Unix 毫秒 都认', () => {
  assert.equal(messageTimeMs('2026-09-20T05:29:12+08:00'), Date.parse('2026-09-20T05:29:12+08:00'));
  assert.equal(messageTimeMs(1789000000), 1789000000 * 1000, '10 位按秒');
  assert.equal(messageTimeMs(1789000000000), 1789000000000, '13 位按毫秒');
});

test('脏数据返回 NaN 而不是抛', () => {
  for (const bad of [null, undefined, '', 'garbage', NaN, Infinity]) {
    assert.ok(Number.isNaN(messageTimeMs(bad)), `${JSON.stringify(bad)} 该是 NaN`);
  }
});

// ───────── 游标推进与查询 ─────────

test('未起步的游标把所有消息都当新的', () => {
  const c = createCursor();
  assert.equal(isCursorUnset(c), true);
  assert.equal(messagesAfter([m(1, T(1)), m(2, T(2))], c).length, 2);
});

test('只返回游标之后的消息', () => {
  const msgs = [m(1, T(1)), m(2, T(2)), m(3, T(3))];
  const c = createCursor();
  advanceCursor(c, [msgs[0], msgs[1]]);
  assert.deepEqual(messagesAfter(msgs, c).map(x => x.message_id), ['3']);
});

test('同一秒多条：靠 id 集合消歧，不漏也不重', () => {
  // QQ 时间戳是秒粒度，一秒好几条是常态
  const a = m(1, T(5)), b = m(2, T(5)), d = m(3, T(5));
  const c = createCursor();
  advanceCursor(c, [a, b]);
  const fresh = messagesAfter([a, b, d], c);
  assert.deepEqual(fresh.map(x => x.message_id), ['3'], '同秒的 a/b 已消费，d 还没');
  advanceCursor(c, [d]);
  assert.equal(messagesAfter([a, b, d], c).length, 0);
});

test('⚠️ 核心：后台回填插进来的旧消息不会被当成"新消息"', () => {
  // 复现线上形态：qq-mcp 后台回填完成后，几十条历史对 PetGPT 是"没见过的"，
  // 被 appendToBuffer 追加到实时消息之后。
  const live1 = m(101, T(50)), live2 = m(102, T(51));
  const old1 = m(1, T(1)), old2 = m(2, T(2));
  const scrambled = [live1, live2, old1, old2];   // 数组顺序是乱的

  const c = createCursor();
  advanceCursor(c, [live1, live2]);               // 已经消费了两条实时的

  // 位置语义（indexOf + slice）会把 old1/old2 报成新消息，还是乱序的。
  // 时间语义知道它们比游标老 —— 那是历史，不是新消息。
  assert.deepEqual(messagesAfter(scrambled, c), [],
    '比游标老的是历史，不该以"新消息"的名义推给模型');

  // 而且游标没有被末尾那条旧消息拉回去（旧实现会 set 成数组最后一个的 id）
  assert.equal(c.ts, Date.parse(T(51)), '游标停在最新的那条上');

  // 真正的新消息照常识别
  const live3 = m(103, T(52));
  assert.deepEqual(messagesAfter([...scrambled, live3], c).map(x => x.message_id), ['103']);
});

test('游标只前进不后退', () => {
  const c = createCursor();
  advanceCursor(c, [m(1, T(30))]);
  const at30 = c.ts;
  advanceCursor(c, [m(2, T(5))]);   // 塞一条旧的
  assert.equal(c.ts, at30, '旧消息不会把游标拉回去');
});

test('时间戳解析不出来的当新消息 —— 宁可重复也不要静默丢', () => {
  const c = createCursor();
  advanceCursor(c, [m(1, T(10))]);
  const broken = { message_id: '99', timestamp: 'garbage' };
  assert.equal(messagesAfter([m(1, T(10)), broken], c).length, 1);
  assert.equal(messagesAfter([m(1, T(10)), broken], c)[0].message_id, '99');
});

test('推进时跳过坏时间戳，不污染游标', () => {
  const c = createCursor();
  advanceCursor(c, [m(1, T(10)), { message_id: 'x', timestamp: null }]);
  assert.equal(c.ts, Date.parse(T(10)));
});

test('空输入安全', () => {
  const c = createCursor();
  assert.deepEqual(messagesAfter([], c), []);
  assert.deepEqual(messagesAfter(null, c), []);
  assert.equal(advanceCursor(c, null), c);
  assert.equal(advanceCursor(null, []), null);
});

// ───────── 排序兜底 ─────────

test('sortByTime 就地按时间排好', () => {
  const arr = [m(3, T(3)), m(1, T(1)), m(2, T(2))];
  sortByTime(arr);
  assert.deepEqual(arr.map(x => x.message_id), ['1', '2', '3']);
});

test('复现线上形态：旧消息被追加到末尾后，排序能救回来', () => {
  const arr = [m(101, T(50)), m(102, T(51)), m(1, T(1)), m(2, T(2))];
  sortByTime(arr);
  assert.deepEqual(arr.map(x => x.message_id), ['1', '2', '101', '102']);
});

test('同一秒内保持到达顺序（稳定排序）', () => {
  const arr = [m(1, T(5)), m(2, T(5)), m(3, T(5))];
  sortByTime(arr);
  assert.deepEqual(arr.map(x => x.message_id), ['1', '2', '3']);
});

test('坏时间戳不被甩到一端，保持相对位置', () => {
  const arr = [m(1, T(1)), { message_id: 'bad', timestamp: 'x' }, m(2, T(2))];
  sortByTime(arr);
  assert.equal(arr.length, 3);
  assert.ok(arr.some(x => x.message_id === 'bad'), '坏数据没被丢掉');
});

test('0/1 条时不动', () => {
  assert.deepEqual(sortByTime([]), []);
  const one = [m(1, T(1))];
  assert.deepEqual(sortByTime(one), one);
  assert.deepEqual(sortByTime(null), null);
});

test('msgTime 从消息对象取时间', () => {
  assert.equal(msgTime(m(1, T(7))), Date.parse(T(7)));
  assert.ok(Number.isNaN(msgTime({})));
  assert.ok(Number.isNaN(msgTime(null)));
});

// ───────── bot 自己的消息不推进时间（本机时钟 ≠ 平台服务器时钟） ─────────

const self = (id, iso) => ({ ...m(id, iso), is_self: true });

test('⚠️ 本机时钟偏快时，紧跟在 bot 后面的群友消息不会被跳过', () => {
  // 线上形态（Telegram）：bot 那条是本机发送成功时记的微秒时间，群友那条是
  // Telegram 服务器给的整秒时间。本机快 2 秒，群友的回复就比 bot 那条「早」
  const c = createCursor();
  advanceCursor(c, [m(1, '2026-10-07T12:51:00+08:00')]);
  advanceCursor(c, [self(2, '2026-10-07T12:51:13.692761+08:00')]);
  const reply = m(3, '2026-10-07T12:51:12+08:00');
  assert.deepEqual(messagesAfter([reply], c).map(x => x.message_id), ['3'],
    '以前游标按 bot 的时间推过去，这句话会被当成已读');
});

test('已读的自发消息不会再被报成新消息', () => {
  const c = createCursor();
  advanceCursor(c, [m(1, T(1))]);
  const mine = self(2, T(5));
  advanceCursor(c, [mine]);
  assert.deepEqual(messagesAfter([mine], c), []);
  // 没读过的自发消息照常算新的
  assert.deepEqual(messagesAfter([self(3, T(6))], c).map(x => x.message_id), ['3']);
});

test('起步那批全是自发消息时退后一段起步，不拿本机时间直接起', () => {
  const c = createCursor();
  advanceCursor(c, [self(1, T(30))]);
  assert.ok(!isCursorUnset(c), '游标要起步，否则每轮都把整个窗口当新的');
  assert.deepEqual(messagesAfter([self(1, T(30))], c), []);
  assert.deepEqual(messagesAfter([m(2, T(29))], c).map(x => x.message_id), ['2'],
    '比 bot 本机时间略早的群友消息还在');
});

test('早于游标的自发消息记录会被清掉，不会无限增长', () => {
  const c = createCursor();
  advanceCursor(c, [m(1, T(1)), self(2, T(2)), self(3, T(3))]);
  assert.equal(c.selfSeen.size, 2);
  advanceCursor(c, [m(4, T(10))]);
  assert.equal(c.selfSeen.size, 0);
});

test('旧形状的游标（没有 selfSeen）也能用', () => {
  const c = { ts: 0, ids: new Set() };
  advanceCursor(c, [m(1, T(1)), self(2, T(2))]);
  assert.deepEqual(messagesAfter([self(2, T(2)), m(3, T(3))], c).map(x => x.message_id), ['3']);
});
