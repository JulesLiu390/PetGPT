import test from 'node:test';
import assert from 'node:assert/strict';

import { toProviderTurns, ensureUserLast, renderToolCall, renderToolResult, renderTurnNote } from '../social/sessionTurn.js';

test('普通消息按原 role 输出', () => {
  const out = toProviderTurns([
    { kind: 'message', role: 'user', content: '在吗' },
    { kind: 'message', role: 'assistant', content: '在' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在' },
  ]);
});

test('连续同 role 被合并 —— Gemini 不接受连续同 role', () => {
  const out = toProviderTurns([
    { kind: 'message', role: 'user', content: 'A' },
    { kind: 'message', role: 'user', content: 'B' },
    { kind: 'message', role: 'assistant', content: 'C' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'A\n\nB');
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i].role, out[i - 1].role);
});

test('工具调用降级成 assistant 自述，结果降级成 user 文本', () => {
  const out = toProviderTurns([
    { kind: 'tool_call', toolName: 'tavily_search', content: '{"q":"反代"}' },
    { kind: 'tool_result', toolName: 'tavily_search', content: '搜到三条' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.match(out[0].content, /我调用了 tavily_search/);
  assert.equal(out[1].role, 'user');
  assert.match(out[1].content, /\[tavily_search 的结果\]/);
  assert.match(out[1].content, /搜到三条/);
});

test('降级后不会出现孤立的 tool_call —— 这正是原生格式最容易 400 的地方', () => {
  // 结果被压缩掉，只剩调用
  const out = toProviderTurns([
    { kind: 'message', role: 'user', content: '查一下' },
    { kind: 'tool_call', toolName: 'fetch', content: '{}' },
  ]);
  // 没有任何 tool_call_id 需要配对，纯文本，谁都能收
  assert.ok(out.every(m => typeof m.content === 'string' || Array.isArray(m.content)));
  assert.ok(out.every(m => m.role === 'user' || m.role === 'assistant'));
});

test('超长工具参数被截断', () => {
  const item = { kind: 'tool_call', toolName: 'fetch', content: 'x'.repeat(500) };
  const rendered = renderToolCall(item, { maxArgChars: 50 });
  assert.ok(rendered.length < 100);
  assert.match(rendered, /…/);
});

test('摘要作为 user 背景材料，带标记', () => {
  const out = toProviderTurns([{ kind: 'summary', content: '之前聊了 A B C' }]);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /\[历史摘要\]/);
});

test('注入的新消息是 user', () => {
  const out = toProviderTurns([
    { kind: 'message', role: 'assistant', content: '我先查查' },
    { kind: 'injection', content: '张三: 等等，我搞定了' },
  ]);
  assert.equal(out[1].role, 'user');
  assert.equal(out[1].content, '张三: 等等，我搞定了');
});

test('turn_note 是 assistant 的自述', () => {
  const out = toProviderTurns([
    { kind: 'note', content: '（第 3 轮小结 [观点] 回了反代的问题）' },
  ]);
  assert.equal(out[0].role, 'assistant');
  assert.match(out[0].content, /第 3 轮小结/);
});

test('renderTurnNote 标出系统补记的情况', () => {
  assert.match(renderTurnNote({ register: '沉默', summary: '未发言', inferred: true }, 2), /系统据实补的/);
  assert.equal(renderTurnNote({ register: '观点', summary: '答了', inferred: false }, 5), '（第 5 轮小结 [观点] 答了）');
  assert.equal(renderTurnNote(null, 1), '');
});

test('多模态内容原样透传 —— 图片不能被拍扁成文本', () => {
  const parts = [{ type: 'text', text: '看这张' }, { type: 'image_url', image_url: { url: 'data:...' } }];
  const out = toProviderTurns([{ kind: 'message', role: 'user', content: parts }]);
  assert.ok(Array.isArray(out[0].content));
  assert.equal(out[0].content.length, 2);
  assert.equal(out[0].content[1].type, 'image_url');
});

test('多模态与文本同 role 相邻时合并进同一个 part 数组', () => {
  const parts = [{ type: 'image_url', image_url: { url: 'x' } }];
  const out = toProviderTurns([
    { kind: 'message', role: 'user', content: '前面的话' },
    { kind: 'message', role: 'user', content: parts },
    { kind: 'message', role: 'user', content: '后面的话' },
  ]);
  assert.equal(out.length, 1);
  assert.ok(Array.isArray(out[0].content));
  const texts = out[0].content.filter(p => p.type === 'text').map(p => p.text);
  assert.deepEqual(texts, ['前面的话', '后面的话']);
  assert.equal(out[0].content.filter(p => p.type === 'image_url').length, 1);
});

test('空内容条目被跳过', () => {
  const out = toProviderTurns([
    { kind: 'message', role: 'user', content: '' },
    { kind: 'message', role: 'user', content: null },
    { kind: 'message', role: 'user', content: '有内容' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, '有内容');
});

test('ensureUserLast：不以 assistant 结尾', () => {
  const t = [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }];
  const out = ensureUserLast(t);
  assert.equal(out.length, 3);
  assert.equal(out[2].role, 'user');
  // 原数组不动
  assert.equal(t.length, 2);
});

test('ensureUserLast：空数组给一条兜底 user', () => {
  const out = ensureUserLast([]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

test('ensureUserLast：已以 user 结尾则不动', () => {
  const t = [{ role: 'assistant', content: 'A' }, { role: 'user', content: 'B' }];
  assert.deepEqual(ensureUserLast(t), t);
});

test('renderToolResult 处理多模态结果', () => {
  const r = renderToolResult({ toolName: 'image_list', content: [{ type: 'text', text: '三张图' }] });
  assert.match(r, /三张图/);
});

// ────── 自发消息格式（线上「回 yesname：」那个 bug 之后加的） ──────

import { formatSelfMessage } from '../social/sessionTurn.js';

test('自发消息带时间戳前缀 —— prompt 里承诺了这个格式', () => {
  assert.equal(formatSelfMessage({ text: '在呀', time: '19:19:54' }), '[19:19:54 我的回复] 在呀');
});

test('带引用时标出被引用的消息 ID —— 模型要看得见自己的引用生效了', () => {
  assert.equal(
    formatSelfMessage({ text: '就是气压计', time: '19:19:55', replyTo: '8842' }),
    '[19:19:55 我的回复 →#8842] 就是气压计',
  );
});

test('没有时间戳时不留空洞', () => {
  assert.equal(formatSelfMessage({ text: 'x' }), '[我的回复] x');
  assert.equal(formatSelfMessage({}), '[我的回复] ');
});

test('连发两条合并后边界仍然可辨 —— 这正是之前丢掉的信息', () => {
  const a = formatSelfMessage({ text: '实时气压计UI都搓出来了！', time: '19:19:54', replyTo: '8842' });
  const b = formatSelfMessage({ text: '就是群聊情绪气压计', time: '19:19:55' });
  const out = toProviderTurns([
    { kind: 'message', role: 'assistant', content: a },
    { kind: 'message', role: 'assistant', content: b },
  ]);
  assert.equal(out.length, 1, 'Gemini 不允许连续同 role，必须合并');
  // 但合并后两条依然分得清，而且能看出第一条带了引用
  assert.match(out[0].content, /\[19:19:54 我的回复 →#8842\]/);
  assert.match(out[0].content, /\[19:19:55 我的回复\]/);
  assert.equal((out[0].content.match(/我的回复/g) || []).length, 2);
});
