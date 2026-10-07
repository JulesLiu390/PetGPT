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

test('工具调用和结果都降级成 user 侧的系统记录', () => {
  const out = toProviderTurns([
    { kind: 'tool_call', toolName: 'tavily_search', content: '{"q":"反代"}' },
    { kind: 'tool_result', toolName: 'tavily_search', content: '搜到三条' },
  ]);
  assert.equal(out.length, 1, '调用和结果相邻同为 user，合并成一条');
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /\[系统记录\] 你调用了 tavily_search/);
  assert.match(out[0].content, /\[tavily_search 的结果\]/);
  assert.match(out[0].content, /搜到三条/);
});

// 线上抓到的：模型照着历史里 assistant 角色的「（我调用了 …）」写了一段文字，
// 以为自己发了消息，其实群里什么都没收到。
test('assistant 角色里只剩真正发进群里的话——没有可以照抄的「调用工具」模板', () => {
  const out = toProviderTurns([
    { kind: 'message', role: 'user', content: '[00:15:49] Jules: 能看见这个图吗？' },
    { kind: 'unsent', role: 'assistant', content: '我先看看' },
    { kind: 'tool_call', role: 'assistant', toolName: 'Telegram__send_message', content: '{"content":"看到了"}' },
    { kind: 'tool_result', role: 'tool', toolName: 'Telegram__send_message', content: '{"success":true}' },
    { kind: 'message', role: 'assistant', content: '[00:16:01 我的回复] 看到了' },
    { kind: 'note', role: 'assistant', content: '（第 3 轮小结 [接梗] 回了图）' },
  ]);
  const assistantText = out.filter(m => m.role === 'assistant').map(m => m.content).join('\n');
  assert.equal(assistantText, '[00:16:01 我的回复] 看到了');
  assert.doesNotMatch(assistantText, /调用了|系统记录|小结/);
});

test('写了但没发出去的文字照实标出来：群里看不到', () => {
  const out = toProviderTurns([
    { kind: 'unsent', role: 'assistant', content: '（我调用了 Telegram__send_message：{"content":"…"}）' },
  ]);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /\[系统记录\] 你写了下面这段文字，但没有调用发送工具，群里看不到/);
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

test('turn_note 是 user 侧的系统记录', () => {
  const out = toProviderTurns([
    { kind: 'note', content: '（第 3 轮小结 [观点] 回了反代的问题）' },
  ]);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /^\[系统记录\]/);
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

// ── prependToLastUser：每轮现算的背景块不能把新消息顶掉 ──

import { prependToLastUser, classifyRoundOutput } from '../social/sessionTurn.js';

const BARO = '# 此刻群里的气压\n· 对话形态：多人热聊';

test('字符串内容：块在前，群友的话仍是模型最后读到的', () => {
  const out = prependToLastUser([
    { role: 'assistant', content: '[09:56:02 我的回复] 不信你试试' },
    { role: 'user', content: '[09:56:29 阿萨姆 →@你] 你是做题区吗宝宝' },
  ], BARO);
  assert.equal(out.length, 2, '并进去，不另起一条');
  assert.equal(out[1].role, 'user');
  assert.ok(out[1].content.startsWith(BARO));
  assert.ok(out[1].content.endsWith('你是做题区吗宝宝'), '最后一样东西必须是群友的话');
});

test('多模态内容：块成为第一个 text part，图片原样保留', () => {
  const img = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } };
  const txt = { type: 'text', text: '[12:04:25 海鲜] 看这个' };
  const out = prependToLastUser([{ role: 'user', content: [img, txt] }], BARO);
  assert.deepEqual(out[0].content, [{ type: 'text', text: BARO }, img, txt]);
});

test('不修改传入的数组和对象——history 里不能留下气压计', () => {
  const content = [{ type: 'text', text: 'hi' }];
  const turns = [{ role: 'user', content }];
  const snapshot = JSON.stringify(turns);
  prependToLastUser(turns, BARO);
  assert.equal(JSON.stringify(turns), snapshot);
  assert.equal(turns[0].content, content, '原数组引用也不能被替换');
  assert.equal(content.length, 1);
});

test('没有块时原样返回', () => {
  const turns = [{ role: 'user', content: 'x' }];
  assert.deepEqual(prependToLastUser(turns, ''), turns);
  assert.deepEqual(prependToLastUser(turns, null), turns);
});

test('最后一条不是 user（没调 ensureUserLast）：没有可顶掉的消息，单独追加', () => {
  const out = prependToLastUser([{ role: 'assistant', content: 'a' }], BARO);
  assert.deepEqual(out, [{ role: 'assistant', content: 'a' }, { role: 'user', content: BARO }]);
  assert.deepEqual(prependToLastUser([], BARO), [{ role: 'user', content: BARO }]);
});

test('空字符串内容不留多余分隔符', () => {
  const out = prependToLastUser([{ role: 'user', content: '' }], BARO);
  assert.equal(out[0].content, BARO);
});

test('和 toProviderTurns + ensureUserLast 串起来：最后一条是 user，且以新消息结尾', () => {
  const out = prependToLastUser(ensureUserLast(toProviderTurns([
    { kind: 'message', role: 'user', content: '[09:55:55 阿萨姆] 真的吗' },
    { kind: 'message', role: 'assistant', content: '[09:56:02 我的回复] 不信你试试' },
    { kind: 'message', role: 'user', content: '[09:56:29 阿萨姆 →@你] 你是做题区吗宝宝' },
  ])), BARO);
  const last = out[out.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.endsWith('你是做题区吗宝宝'));
  assert.equal(out.filter(m => m.role === 'user' && m.content === BARO).length, 0, '气压计不能单独成条');
});

// ── classifyRoundOutput：话有没有送进群里 ──

const isSend = (n) => /(send_message|sticker_send|image_send)/.test(n);

test('调了发送工具就是 sent，哪怕还带着文字旁白', () => {
  assert.equal(classifyRoundOutput({ toolNames: ['send_message'], text: '好的已回复', isSendTool: isSend }), 'sent');
  assert.equal(classifyRoundOutput({ toolNames: ['qq-3825478002__send_message'], isSendTool: isSend }), 'sent');
  assert.equal(classifyRoundOutput({ toolNames: ['group_log_read', 'sticker_send'], isSendTool: isSend }), 'sent');
});

test('调了 turn_note 就是明确收尾', () => {
  assert.equal(classifyRoundOutput({ toolNames: ['turn_note'], text: '这条不用回', isSendTool: isSend }), 'noted');
  assert.equal(classifyRoundOutput({ toolNames: ['x__turn_note'], isSendTool: isSend }), 'noted');
});

test('发送优先于收尾', () => {
  assert.equal(classifyRoundOutput({ toolNames: ['turn_note', 'send_message'], isSendTool: isSend }), 'sent');
});

test('没发送也没收尾但有文字——就是被吞掉的那种', () => {
  assert.equal(classifyRoundOutput({ toolNames: [], text: '中国时间是10月2号', isSendTool: isSend }), 'text_only');
  // 查完资料把回答写成了文字，同样没发出去
  assert.equal(classifyRoundOutput({ toolNames: ['group_log_read'], text: '查到了，是…', isSendTool: isSend }), 'text_only');
});

test('只查了东西没出声、也没文字', () => {
  assert.equal(classifyRoundOutput({ toolNames: ['group_log_read'], text: '', isSendTool: isSend }), 'tools_only');
});

test('什么都没有；纯空白按空处理', () => {
  assert.equal(classifyRoundOutput({ toolNames: [], text: '', isSendTool: isSend }), 'empty');
  assert.equal(classifyRoundOutput({ toolNames: [], text: '  \n ', isSendTool: isSend }), 'empty');
  assert.equal(classifyRoundOutput({}), 'empty');
});
