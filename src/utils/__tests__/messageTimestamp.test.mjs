import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * buffer_search 的时间戳处理。
 *
 * 这里曾经把 timestamp 当 Unix 秒（`ts * 1000`），但 buffer 里存的一律是
 * ISO 8601 字符串 —— 字符串乘数字得到 NaN，随后 toISOString() 抛
 * RangeError，工具每次调用都失败。线上日志里模型反复尝试搜索历史、反复
 * 拿到 `Error: Invalid Date`，只能退回依赖压缩摘要。
 */

let vite;
let socialTools;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  socialTools = await vite.ssrLoadModule('/src/utils/workspace/socialToolExecutor.js');
});

after(async () => {
  await vite?.close();
});

test('ISO 8601 字符串是 buffer 里的实际格式，必须解析正确', () => {
  const { messageTimestampMs } = socialTools;
  // qq-mcp 的 Message.to_dict 给的就是这个形状
  assert.equal(messageTimestampMs('2026-09-19T05:29:12+08:00'), Date.parse('2026-09-19T05:29:12+08:00'));
  // bot 自发消息走 new Date().toISOString()
  assert.equal(messageTimestampMs('2026-09-19T10:31:57.149Z'), Date.parse('2026-09-19T10:31:57.149Z'));
});

test('回归：ISO 字符串不再被当成 Unix 秒', () => {
  const { messageTimestampMs, formatMessageClock } = socialTools;
  const iso = '2026-09-19T05:29:12+08:00';
  // 旧实现等价于 new Date(iso * 1000) —— 直接 NaN
  assert.ok(Number.isNaN(Number(iso) * 1000), '前提：字符串乘数字确实是 NaN');
  // 新实现必须拿到有限值，且格式化不抛错
  assert.ok(Number.isFinite(messageTimestampMs(iso)));
  assert.notEqual(formatMessageClock(iso), '??:??:??');
});

test('格式化不会抛 RangeError —— 这正是线上报错的形态', () => {
  const { formatMessageClock } = socialTools;
  for (const bad of [undefined, null, '', 'not a date', NaN, Infinity, {}, []]) {
    assert.doesNotThrow(() => formatMessageClock(bad), `输入 ${JSON.stringify(bad)} 不该抛`);
  }
});

test('无法解析时退回占位符而不是崩掉', () => {
  const { formatMessageClock } = socialTools;
  assert.equal(formatMessageClock(undefined), '??:??:??');
  assert.equal(formatMessageClock('garbage'), '??:??:??');
  assert.equal(formatMessageClock(''), '??:??:??');
});

test('数字时间戳按位数区分秒与毫秒', () => {
  const { messageTimestampMs } = socialTools;
  const ms = 1789000000000;          // 13 位，毫秒
  const sec = 1789000000;            // 10 位，秒
  assert.equal(messageTimestampMs(ms), ms);
  assert.equal(messageTimestampMs(sec), sec * 1000);
  // 两者指向同一时刻，说明分界判断是对的
  assert.equal(messageTimestampMs(sec), messageTimestampMs(ms));
});

test('时钟用本地时区，与群聊消息里的时间同源', () => {
  const { formatMessageClock } = socialTools;
  const iso = '2026-09-19T05:29:12+08:00';
  // socialAgent 的 formatHMS 用的就是这个调用
  const expected = new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  assert.equal(formatMessageClock(iso), expected);
});

test('时间降序排序：ISO 字符串相减是 NaN，必须转毫秒再比', () => {
  const { messageTimestampMs } = socialTools;
  const older = '2026-09-19T05:00:00Z';
  const newer = '2026-09-19T06:00:00Z';
  // 旧实现的比较方式
  assert.ok(Number.isNaN(newer - older), '前提：字符串相减确实是 NaN');
  // 新实现
  assert.ok(messageTimestampMs(newer) - messageTimestampMs(older) > 0);
});
