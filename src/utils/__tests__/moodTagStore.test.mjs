import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMoodTagStore, parseStore, serializeStore, moodTagPath, MOOD_TAG_MAX_ENTRIES,
} from '../social/moodTagStore.js';

const tag = (act = 'question', at = 1000) => ({ act, tone: 'neutral', earnest: 2, aboutBot: 0, at });

const memIO = (initial = null) => {
  const store = { content: initial, writes: 0 };
  return {
    store,
    read: async () => store.content,
    write: async (_p, c) => { store.content = c; store.writes += 1; },
  };
};

test('路径按 target 类型分目录', () => {
  assert.equal(moodTagPath('902317662', 'group'), 'social/group/MOODTAG_902317662.json');
  assert.match(moodTagPath('123', 'private'), /MOODTAG_123\.json$/);
});

test('存了再读回来是同一个标签', async () => {
  const io = memIO();
  const s1 = createMoodTagStore('g1', 'group', io);
  await s1.load();
  s1.set('m1', tag('banter'));
  await s1.flush();

  const s2 = createMoodTagStore('g1', 'group', io);
  await s2.load();
  assert.equal(s2.get('m1').act, 'banter');
});

test('冻结语义：标过的消息 has() 为真，调用方据此跳过重标', async () => {
  const io = memIO();
  const s = createMoodTagStore('g1', 'group', io);
  await s.load();
  s.set('m1', tag());
  assert.equal(s.has('m1'), true);
  assert.equal(s.has('m2'), false);
  assert.equal(s.has(12345), false);
});

test('message_id 数字与字符串等价', async () => {
  const io = memIO();
  const s = createMoodTagStore('g1', 'group', io);
  await s.load();
  s.set(8842, tag());
  assert.ok(s.get('8842'));
  assert.ok(s.get(8842));
});

test('损坏的文件当成空，不抛', () => {
  assert.equal(parseStore('{不是 json').size, 0);
  assert.equal(parseStore('').size, 0);
  assert.equal(parseStore(null).size, 0);
  assert.equal(parseStore('{"version":999,"tags":{"a":{}}}').size, 0, '版本不符就丢弃');
  assert.equal(parseStore('[1,2,3]').size, 0);
});

test('读失败不影响使用', async () => {
  const s = createMoodTagStore('g1', 'group', {
    read: async () => { throw new Error('磁盘炸了'); },
    write: async () => {},
  });
  await s.load();
  assert.equal(s.size(), 0);
  s.set('m1', tag());
  assert.ok(s.get('m1'));
});

test('写失败保持 dirty，下次还会重试', async () => {
  let fail = true;
  const s = createMoodTagStore('g1', 'group', {
    read: async () => null,
    write: async () => { if (fail) throw new Error('只读'); },
  });
  await s.load();
  s.set('m1', tag());
  await s.flush();          // 失败
  fail = false;
  let wrote = false;
  const s2 = createMoodTagStore('g1', 'group', {
    read: async () => null, write: async () => { wrote = true; },
  });
  await s2.load(); s2.set('x', tag()); await s2.flush();
  assert.equal(wrote, true);
});

test('没有改动时 flush 不写盘', async () => {
  const io = memIO();
  const s = createMoodTagStore('g1', 'group', io);
  await s.load();
  await s.flush();
  await s.flush();
  assert.equal(io.store.writes, 0);
});

test('超出上限时按时间保留最新的', () => {
  const m = new Map();
  for (let i = 0; i < 20; i++) m.set(`m${i}`, tag('question', i));
  const out = JSON.parse(serializeStore(m, { max: 5 }));
  const keys = Object.keys(out.tags).sort((a, b) => out.tags[b].at - out.tags[a].at);
  assert.equal(keys.length, 5);
  assert.deepEqual(keys, ['m19', 'm18', 'm17', 'm16', 'm15']);
});

test('未超上限时一条不丢', () => {
  const m = new Map([['a', tag()], ['b', tag()]]);
  const out = JSON.parse(serializeStore(m));
  assert.equal(Object.keys(out.tags).length, 2);
});

test('set 自动补 at，方便裁剪排序', async () => {
  const io = memIO();
  const s = createMoodTagStore('g1', 'group', io);
  await s.load();
  const before = Date.now();
  s.set('m1', { act: 'inform', tone: 'neutral', earnest: 2, aboutBot: 0 });
  assert.ok(s.get('m1').at >= before);
});

test('set 忽略空值，不写垃圾进去', async () => {
  const io = memIO();
  const s = createMoodTagStore('g1', 'group', io);
  await s.load();
  s.set('', tag());
  s.set('m1', null);
  assert.equal(s.size(), 0);
});

test('debounce：多次 scheduleFlush 只落一次盘', async () => {
  const io = memIO();
  const s = createMoodTagStore('g1', 'group', io);
  await s.load();
  s.set('m1', tag());
  s.scheduleFlush(10);
  s.set('m2', tag());
  s.scheduleFlush(10);
  s.scheduleFlush(10);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(io.store.writes, 1);
  assert.equal(parseStore(io.store.content).size, 2);
});

test('dispose 会把未落盘的写掉并清掉计时器', async () => {
  const io = memIO();
  const s = createMoodTagStore('g1', 'group', io);
  await s.load();
  s.set('m1', tag());
  s.scheduleFlush(10_000);
  await s.dispose();
  assert.equal(io.store.writes, 1);
});

test('上限是 4000', () => {
  assert.equal(MOOD_TAG_MAX_ENTRIES, 4000);
});
