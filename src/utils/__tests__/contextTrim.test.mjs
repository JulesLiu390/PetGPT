import test from 'node:test';
import assert from 'node:assert/strict';

import {
  trimToolOutputs, toolOutputChars, totalChars,
  MIN_TRIMMABLE_CHARS, ALWAYS_KEEP_NEWEST, trimmedPlaceholder,
} from '../social/contextTrim.js';

const toolResult = (chars, toolName = 'tavily_search') => ({
  kind: 'tool_result', role: 'tool', toolName, content: 'x'.repeat(chars),
});
const msg = (role, content) => ({ kind: 'message', role, content });

test('预算够时一条都不裁', () => {
  const items = [msg('user', '在吗'), toolResult(1000), msg('assistant', '在')];
  const r = trimToolOutputs(items, { budgetChars: 10_000 });
  assert.equal(r.trimmedCount, 0);
  assert.deepEqual(r.items, items);
});

test('从最新往回保留，超预算的旧输出被换成占位符', () => {
  // 三条各 5000 字符，预算 12000：最新两条豁免，第三条（最旧）超预算被裁
  const items = [toolResult(5000, 'old'), toolResult(5000, 'mid'), toolResult(5000, 'new')];
  const r = trimToolOutputs(items, { budgetChars: 12_000, alwaysKeepNewest: 0 });
  assert.equal(r.trimmedCount, 1);
  assert.equal(r.items[0]._trimmed, true, '被裁的是最旧那条');
  assert.equal(r.items[1]._trimmed, undefined);
  assert.equal(r.items[2]._trimmed, undefined);
  assert.equal(r.savedChars, 5000);
});

test('最新 N 条无条件保留，哪怕预算为 0', () => {
  assert.equal(ALWAYS_KEEP_NEWEST, 2);
  const items = [toolResult(9000), toolResult(9000), toolResult(9000)];
  const r = trimToolOutputs(items, { budgetChars: 0 });
  assert.equal(r.trimmedCount, 1, '只有最旧那条被裁，最新两条豁免');
  assert.equal(r.items[1]._trimmed, undefined);
  assert.equal(r.items[2]._trimmed, undefined);
});

test('短输出不裁 —— 省不下多少，反而丢信息', () => {
  const short = MIN_TRIMMABLE_CHARS - 1;
  const items = [toolResult(short), toolResult(short), toolResult(short), toolResult(short)];
  const r = trimToolOutputs(items, { budgetChars: 0 });
  assert.equal(r.trimmedCount, 0);
});

test('对话消息一个字都不动 —— 那是连贯性的载体', () => {
  const longUser = msg('user', '啊'.repeat(50_000));
  const longAssistant = msg('assistant', '哦'.repeat(50_000));
  const items = [longUser, toolResult(9000), toolResult(100), longAssistant];
  const r = trimToolOutputs(items, { budgetChars: 0, alwaysKeepNewest: 0 });
  assert.equal(r.items[0], longUser);
  assert.equal(r.items[3], longAssistant);
  assert.equal(r.items[1]._trimmed, true, '只有长工具输出被裁');
});

test('占位符带上原长度和工具名', () => {
  const items = [toolResult(8888, 'webshot'), toolResult(10), toolResult(10)];
  const r = trimToolOutputs(items, { budgetChars: 0 });
  assert.equal(r.items[0].content, trimmedPlaceholder(8888, 'webshot'));
  assert.match(r.items[0].content, /webshot/);
  assert.match(r.items[0].content, /8888/);
  assert.equal(r.items[0]._originalChars, 8888);
});

test('原数组不被修改', () => {
  const items = [toolResult(9000), toolResult(10), toolResult(10)];
  const before = items[0].content;
  trimToolOutputs(items, { budgetChars: 0 });
  assert.equal(items[0].content, before);
  assert.equal(items[0]._trimmed, undefined);
});

test('多模态 content 按 text part 计长', () => {
  const multi = {
    kind: 'tool_result', role: 'tool', toolName: 'image_list',
    content: [{ type: 'text', text: 'y'.repeat(600) }, { type: 'image_url', url: 'x' }],
  };
  const items = [multi, toolResult(10), toolResult(10)];
  const r = trimToolOutputs(items, { budgetChars: 0 });
  assert.equal(r.trimmedCount, 1);
  assert.equal(r.items[0]._originalChars, 600);
});

test('空输入与非法预算是安全的', () => {
  assert.equal(trimToolOutputs([], { budgetChars: 100 }).trimmedCount, 0);
  assert.equal(trimToolOutputs(null, { budgetChars: 100 }).trimmedCount, 0);
  const items = [toolResult(9000)];
  assert.equal(trimToolOutputs(items, { budgetChars: NaN }).trimmedCount, 0);
  assert.equal(trimToolOutputs(items, { budgetChars: -1 }).trimmedCount, 0);
});

test('toolOutputChars / totalChars 分别统计', () => {
  const items = [msg('user', 'abcde'), toolResult(1000), msg('assistant', 'xy')];
  assert.equal(toolOutputChars(items), 1000);
  assert.equal(totalChars(items), 1007);
});

test('role=tool 但没有 kind 也认得出来', () => {
  const items = [{ role: 'tool', content: 'z'.repeat(9000) }, toolResult(10), toolResult(10)];
  const r = trimToolOutputs(items, { budgetChars: 0 });
  assert.equal(r.trimmedCount, 1);
});

// ────────────── 图片回收（线上 500 之后补的） ──────────────

import { recycleSessionImages, IMAGE_PLACEHOLDER, IMAGE_KEEP_NEWEST } from '../social/contextTrim.js';

const imgMsg = (n) => ({
  kind: 'message', role: 'user',
  content: [{ type: 'text', text: `第 ${n} 条` }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }],
});

test('只保留最近 N 张图，更旧的换占位符', () => {
  const history = Array.from({ length: 20 }, (_, i) => imgMsg(i));
  const r = recycleSessionImages(history, { keepNewest: 5 });
  assert.equal(r.recycled, 15);
  assert.equal(r.kept, 5);
  // 最旧的被换掉
  assert.equal(history[0].content[1].text, IMAGE_PLACEHOLDER);
  // 最新 5 条原样
  for (let i = 15; i < 20; i++) {
    assert.equal(history[i].content[1].type, 'image_url', `第 ${i} 条该保留`);
  }
});

test('文字 part 一个都不动', () => {
  const history = [imgMsg(0), imgMsg(1)];
  recycleSessionImages(history, { keepNewest: 0 });
  assert.equal(history[0].content[0].text, '第 0 条');
  assert.equal(history[1].content[0].text, '第 1 条');
});

test('纯文本 history 不受影响', () => {
  const history = [{ kind: 'message', role: 'user', content: '纯文本' }];
  const r = recycleSessionImages(history);
  assert.equal(r.recycled, 0);
  assert.equal(history[0].content, '纯文本');
});

test('图片少于上限时不动', () => {
  const history = [imgMsg(0), imgMsg(1)];
  const r = recycleSessionImages(history);
  assert.equal(r.recycled, 0);
  assert.equal(history[0].content[1].type, 'image_url');
});

test('默认保留 12 张', () => {
  assert.equal(IMAGE_KEEP_NEWEST, 12);
  const history = Array.from({ length: 30 }, (_, i) => imgMsg(i));
  const r = recycleSessionImages(history);
  assert.equal(r.kept, 12);
  assert.equal(r.recycled, 18);
});

test('重复调用幂等，不会把占位符再数一遍', () => {
  const history = Array.from({ length: 20 }, (_, i) => imgMsg(i));
  recycleSessionImages(history, { keepNewest: 5 });
  const second = recycleSessionImages(history, { keepNewest: 5 });
  assert.equal(second.recycled, 0, '第二次没有新图可回收');
  assert.equal(second.kept, 5);
});

test('空输入安全', () => {
  assert.deepEqual(recycleSessionImages(null), { recycled: 0, kept: 0 });
  assert.deepEqual(recycleSessionImages([]), { recycled: 0, kept: 0 });
});
