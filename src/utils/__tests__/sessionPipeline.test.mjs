import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * 四个阶段串起来跑一遍：session/turn 骨架 → 注入 → 工具输出裁剪 → 压缩。
 * 不碰网络、不碰 LLM——summarize 用桩替掉。
 */

import {
  createSession, beginTurn, endTurn, appendHistory, canInject, recordInjection,
  recordSend, sessionStats, latestSummary,
  BACKLOG_REMINDER_AT, shouldRemindBacklog, markBacklogReminded, REGISTER_SILENT,
} from '../social/sessionState.js';
import { prepareRequestItems, estimateItemsTokens } from '../social/compaction.js';
import { toProviderTurns, ensureUserLast, renderTurnNote } from '../social/sessionTurn.js';

let vite;
let socialTools;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  socialTools = await vite.ssrLoadModule('/src/utils/workspace/socialToolExecutor.js');
});
after(async () => { await vite?.close(); });

// ────────────────────────── turn_note 工具 ──────────────────────────

test('turn_note 走 sink，不落盘', async () => {
  const { executeTurnNoteTool } = socialTools;
  let got = null;
  const r = await executeTurnNoteTool('turn_note',
    { register: '观点', summary: '回了反代封号的问题' },
    { onTurnNote: (n) => { got = n; } });
  assert.equal(r.success, true);
  assert.deepEqual(got, { register: '观点', summary: '回了反代封号的问题', inferred: false });
});

test('turn_note 拒绝档位外的值 —— 原 write_intent_plan 线上就因为这个报过错', async () => {
  const { executeTurnNoteTool } = socialTools;
  const r = await executeTurnNoteTool('turn_note', { register: '瞎编的档位', summary: 'x' }, {});
  assert.ok(r.error);
  assert.match(r.error, /接梗/);
});

test('turn_note 允许「沉默」档 —— 不发言的轮次也要记', async () => {
  const { executeTurnNoteTool, TURN_NOTE_REGISTERS } = socialTools;
  assert.ok(TURN_NOTE_REGISTERS.includes('沉默'));
  const r = await executeTurnNoteTool('turn_note', { register: '沉默', summary: '群里在聊别的' }, {});
  assert.equal(r.success, true);
});

test('turn_note 要求 summary 非空', async () => {
  const { executeTurnNoteTool } = socialTools;
  const r = await executeTurnNoteTool('turn_note', { register: '闲扯', summary: '   ' }, {});
  assert.ok(r.error);
});

test('sink 抛异常时返回错误而不是把整轮炸掉', async () => {
  const { executeTurnNoteTool } = socialTools;
  const r = await executeTurnNoteTool('turn_note',
    { register: '闲扯', summary: 'x' },
    { onTurnNote: () => { throw new Error('boom'); } });
  assert.ok(r.error);
  assert.match(r.error, /boom/);
});

test('turn_note 的 schema 比 write_intent_plan 小一个数量级', () => {
  const { getTurnNoteToolDefinition, getIntentPlanToolDefinitions } = socialTools;
  const note = Buffer.byteLength(JSON.stringify(getTurnNoteToolDefinition()), 'utf8');
  const plan = Buffer.byteLength(JSON.stringify(getIntentPlanToolDefinitions()), 'utf8');
  assert.ok(note < plan / 3, `turn_note=${note}B 应远小于 write_intent_plan=${plan}B`);
});

// ────────────────────────── 四阶段串跑 ──────────────────────────

const msg = (who, text) => ({ role: who === 'me' ? 'assistant' : 'user', content: `${who}: ${text}` });

test('阶段1+2：turn 靠"群里安静了"收尾，不靠计数器切断', () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  const t = beginTurn(s, { trigger: 'newmsg' });
  appendHistory(s, { ...msg('张三', '这个反代会封号吗'), kind: 'message' });

  let rounds = 0;
  for (let round = 0; round < 30; round++) {
    if (!canInject(t, 2)) break;
    recordInjection(t, 2);
    rounds += 1;
    appendHistory(s, { role: 'user', kind: 'message', content: `李四: 追问 ${round}` });
    if (shouldRemindBacklog(t)) {
      markBacklogReminded(t);
      appendHistory(s, { role: 'user', kind: 'injection', content: `（⚠️ 积压 ${t.backlog} 条未回应）` });
    }
  }
  assert.equal(rounds, 30, '30 轮都跑完了——没有轮数或条数上限');
  assert.equal(t.injectedMessages, 60);
  // 唯一的终止条件
  assert.equal(canInject(t, 0), false, '群里安静了才停');

  endTurn(s, t, { note: { register: '观点', summary: '答了反代', inferred: false } });
  assert.equal(s.currentTurn, null, '结束后允许开下一个 turn');
});

test('阶段2：积压提醒进了 history，模型看得见', () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  const t = beginTurn(s);
  recordInjection(t, BACKLOG_REMINDER_AT);
  assert.equal(shouldRemindBacklog(t), true);
  markBacklogReminded(t);
  appendHistory(s, { role: 'user', kind: 'injection', content: `（⚠️ 你上次开口之后，群里已经堆了 ${t.backlog} 条你还没回应的消息。）` });
  const rendered = toProviderTurns(s.history).map(m => m.content).join('\n');
  assert.match(rendered, /堆了 20 条你还没回应/);
});

test('阶段1：连发不受限 —— 运行时三道闸已全部移除', () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  const t = beginTurn(s);
  for (let i = 0; i < 8; i++) recordSend(s, t);
  assert.equal(t.sends, 8, '限流窗口、开口前强制 check、表情冷却都没了');
  endTurn(s, t);
  const t2 = beginTurn(s);
  recordSend(s, t2);
  assert.equal(t2.sends, 1, '换 turn 计数归零，但那只是计数，不是额度');
});

test('阶段3：长工具输出被裁，对话消息完好', async () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  const t = beginTurn(s);
  appendHistory(s, { ...msg('张三', '帮我查下这个'), kind: 'message' });
  for (let i = 0; i < 6; i++) {
    appendHistory(s, { role: 'assistant', kind: 'tool_call', toolName: 'tavily_search', content: `{"q":"${i}"}` });
    appendHistory(s, { role: 'tool', kind: 'tool_result', toolName: 'tavily_search', content: 'r'.repeat(8000) });
  }
  endTurn(s, t);

  // 阈值要留得下"永远保留的最新 2 条"（2×8000 字符 ≈ 4000 token），
  // 否则裁剪注定不够，正确行为就是继续压缩——那是下一个测试的事。
  const r = await prepareRequestItems(s, { thresholdTokens: 8000, summarize: async () => '不该走到这' });
  assert.ok(r.trimmed.trimmedCount > 0, '应该裁到工具输出');
  assert.equal(r.compacted, null, '裁剪够用就不压缩');
  assert.equal(r.trimmed.trimmedCount, 4, '最新 2 条豁免，更旧的 4 条被裁');
  const userMsg = r.items.find(i => typeof i.content === 'string' && i.content.includes('张三'));
  assert.ok(userMsg, '群友消息必须完好无损');
});

test('阶段3→4：裁剪不足以达标时，继续走压缩', async () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  const t = beginTurn(s);
  for (let i = 0; i < 6; i++) {
    appendHistory(s, { role: 'tool', kind: 'tool_result', toolName: 'tavily_search', content: 'r'.repeat(8000) });
  }
  endTurn(s, t);
  let summarized = false;
  const r = await prepareRequestItems(s, {
    thresholdTokens: 3000,   // 光是豁免的最新 2 条就超了
    summarize: async () => { summarized = true; return '摘要：查了一堆东西'; },
  });
  assert.ok(r.trimmed.trimmedCount > 0, '先裁');
  assert.equal(summarized, true, '裁完还超，才压缩');
  assert.ok(r.compacted);
});

test('阶段4：裁不动时压缩，之后 history 换成一块摘要', async () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  for (let turnNo = 0; turnNo < 3; turnNo++) {
    const t = beginTurn(s);
    appendHistory(s, { role: 'user', kind: 'message', content: '啊'.repeat(1500) });
    endTurn(s, t);
    appendHistory(s, { role: 'assistant', kind: 'note', turnId: t.turnId, content: renderTurnNote(t.note, t.seq) });
  }
  const before = estimateItemsTokens(s.history);
  const r = await prepareRequestItems(s, {
    thresholdTokens: 1000,
    summarize: async ({ items }) => `摘要：聊了 ${items.length} 条`,
  });
  assert.ok(r.compacted, '应该压缩');
  assert.ok(r.tokens < before, '压缩后确实变小了');
  assert.equal(r.items.filter(i => i.kind === 'summary').length, 1);
  assert.match(latestSummary(s), /^摘要：/);
});

test('压缩之后还能继续开 turn，新内容不受影响', async () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  const t1 = beginTurn(s);
  appendHistory(s, { role: 'user', kind: 'message', content: '啊'.repeat(2000) });
  endTurn(s, t1);
  await prepareRequestItems(s, { thresholdTokens: 500, summarize: async () => '旧事摘要' });

  const t2 = beginTurn(s);
  appendHistory(s, { role: 'user', kind: 'message', content: '王五: 新话题' });
  recordSend(t2);
  endTurn(s, t2, { note: { register: '闲扯', summary: '接了新话题', inferred: false } });

  const turns = ensureUserLast(toProviderTurns(await prepareRequestItems(s, { thresholdTokens: 999999 }).then(r => r.items)));
  const joined = turns.map(m => m.content).join('\n');
  assert.match(joined, /旧事摘要/, '摘要还在');
  assert.match(joined, /王五: 新话题/, '新消息也在');
  assert.equal(turns[turns.length - 1].role, 'user', '不能以 assistant 结尾');
});

test('沉默的 turn 也留下痕迹 —— 下一轮要靠它知道上次为什么没说话', () => {
  const s = createSession({ targetId: 'g1', targetType: 'group' });
  const t = beginTurn(s);
  appendHistory(s, { role: 'user', kind: 'message', content: '群友甲: 你们谁去吃饭' });
  endTurn(s, t);
  appendHistory(s, { role: 'assistant', kind: 'note', turnId: t.turnId, content: renderTurnNote(t.note, t.seq) });

  assert.equal(t.sends, 0);
  assert.equal(t.note.register, REGISTER_SILENT);
  const rendered = toProviderTurns(s.history).map(m => m.content).join('\n');
  assert.match(rendered, /沉默/);
});

test('多群互不干扰：各自独立的 session 与 turn 计数', () => {
  const a = createSession({ targetId: 'gA', targetType: 'group' });
  const b = createSession({ targetId: 'gB', targetType: 'group' });
  for (let i = 0; i < 3; i++) { const t = beginTurn(a); endTurn(a, t); }
  const t = beginTurn(b); endTurn(b, t);
  assert.equal(sessionStats(a).turns, 3);
  assert.equal(sessionStats(b).turns, 1);
  assert.notEqual(a.sessionId, b.sessionId);
});

// ────────────── check_new_messages（turn 内的实时感知通道） ──────────────

import { createCursor, advanceCursor } from '../social/messageCursor.js';

const bufMsg = (id, who, text, sec = 0) => ({
  message_id: String(id), sender_id: '111', sender_name: who,
  content: text, is_self: false, is_at_me: false,
  timestamp: `2026-09-20T05:${String(sec).padStart(2, '0')}:00+08:00`,
});

const ctxWith = (messages, cursor, onChecked) => ({
  petId: 'p1', targetId: 'g1', targetType: 'group',
  dataBuffer: new Map([['g1', { messages }]]),
  sessionCursor: { get: () => cursor, advance: (msgs) => advanceCursor(cursor, msgs) },
  onNewMessagesChecked: onChecked,
});

test('拉到游标之后的新消息', async () => {
  const { executeCheckNewMessages } = socialTools;
  const msgs = [bufMsg(1, '张三', 'a', 1), bufMsg(2, '李四', 'b', 2), bufMsg(3, '王五', 'c', 3)];
  const cursor = createCursor();
  advanceCursor(cursor, [msgs[0]]);
  const r = await executeCheckNewMessages({}, ctxWith(msgs, cursor));
  const text = r.content[0].text;
  assert.match(text, /新到了 2 条/);
  assert.match(text, /李四/);
  assert.match(text, /王五/);
  assert.doesNotMatch(text, /张三/, '游标之前的不该再出现');
});

test('拉完推进游标 —— turn 边界不该把同一批再注入一遍', async () => {
  const { executeCheckNewMessages } = socialTools;
  const msgs = [bufMsg(1, '张三', 'a', 1), bufMsg(2, '李四', 'b', 2)];
  const cursor = createCursor();
  advanceCursor(cursor, [msgs[0]]);
  await executeCheckNewMessages({}, ctxWith(msgs, cursor));
  const again = await executeCheckNewMessages({}, ctxWith(msgs, cursor));
  assert.match(again.content[0].text, /没有新消息|没有更新的了/, '第二次就没有了');
});

test('没有新消息时明确说没有，不让模型卡住', async () => {
  const { executeCheckNewMessages } = socialTools;
  const msgs = [bufMsg(1, '张三', 'a', 1)];
  const cursor = createCursor();
  advanceCursor(cursor, msgs);
  const r = await executeCheckNewMessages({}, ctxWith(msgs, cursor));
  assert.match(r.content[0].text, /没有新消息/);
});

test('⚠️ 回填插进来的旧消息不会被报成"新消息"', async () => {
  const { executeCheckNewMessages } = socialTools;
  // 线上形态：后台回填完成后，历史被 appendToBuffer 追加到实时消息**之后**
  const live = [bufMsg(101, '张三', '实时1', 50), bufMsg(102, '李四', '实时2', 51)];
  const old = [bufMsg(1, '很久以前', '历史1', 1), bufMsg(2, '很久以前', '历史2', 2)];
  const scrambled = [...live, ...old];
  const cursor = createCursor();
  advanceCursor(cursor, live);

  const r = await executeCheckNewMessages({}, ctxWith(scrambled, cursor));
  assert.match(r.content[0].text, /没有新消息|没有更新的了/,
    '旧实现会把这两条历史当新消息报出去，而且顺序是乱的');

  // 真正的新消息照常识别，且渲染按时间排好
  const withNew = [...scrambled, bufMsg(103, '王五', '真的新消息', 52)];
  const r2 = await executeCheckNewMessages({}, ctxWith(withNew, cursor));
  assert.match(r2.content[0].text, /新到了 1 条/);
  assert.match(r2.content[0].text, /真的新消息/);
});

test('buffer 为空不报错', async () => {
  const { executeCheckNewMessages } = socialTools;
  const r = await executeCheckNewMessages({}, ctxWith([], createCursor()));
  assert.match(r.content[0].text, /没有新消息|没有更新的了/);
  assert.equal(r.error, undefined);
});

test('游标还没起步时只回最近几条，不倒整个 buffer', async () => {
  const { executeCheckNewMessages } = socialTools;
  const msgs = Array.from({ length: 50 }, (_, i) => bufMsg(i + 100, `人${i}`, `x${i}`, i % 60));
  const r = await executeCheckNewMessages({}, ctxWith(msgs, createCursor()));
  assert.match(r.content[0].text, /新到了 10 条/);
});

test('无论有没有新消息都回调 —— 发送闸门靠它放行', async () => {
  const { executeCheckNewMessages } = socialTools;
  const seen = [];
  const msgs = [bufMsg(1, '张三', 'a', 1)];
  const c1 = createCursor(); advanceCursor(c1, msgs);
  await executeCheckNewMessages({}, ctxWith(msgs, c1, (n) => seen.push(n)));
  await executeCheckNewMessages({}, ctxWith([], createCursor(), (n) => seen.push(n)));
  assert.deepEqual(seen, [0, 0], '没有新消息也要放行，否则模型永远发不出去');
});

test('缺 targetId 时报错而不是静默通过', async () => {
  const { executeCheckNewMessages } = socialTools;
  const r = await executeCheckNewMessages({}, { dataBuffer: new Map() });
  assert.ok(r.error);
});

test('工具 schema 是空参数的 —— 不给模型编造的机会', () => {
  const { getCheckNewMessagesToolDefinition } = socialTools;
  const def = getCheckNewMessagesToolDefinition();
  assert.equal(def.function.name, 'check_new_messages');
  assert.deepEqual(def.function.parameters.properties, {});
  assert.match(def.function.description, /必须先调/);
});

// ── check_new_messages 查到的消息要进 history（图片只有那条路会被下载、拼多模态） ──

test('⚠️ 查到的新消息交给 ingestNewMessages 进 history，图片不能只剩占位符', async () => {
  const { executeCheckNewMessages } = socialTools;
  // 线上形态：turn 中途到了一张图，模型开口前按要求调了本工具。以前只回一段文字
  // 「[图片] [图片x1]」并推进游标，turn 边界再也不碰这条，图就永久丢了
  const photo = { ...bufMsg(2, '李四', '[图片]', 2), image_urls: ['https://x/photos/file_8.jpg'] };
  const msgs = [bufMsg(1, '张三', 'a', 1), photo];
  const cursor = createCursor();
  advanceCursor(cursor, [msgs[0]]);

  const ingested = [];
  const ctx = {
    ...ctxWith(msgs, cursor),
    ingestNewMessages: async (fresh) => {
      ingested.push(...fresh.map(m => m.message_id));
      advanceCursor(cursor, fresh);           // 真实实现（appendNewMessages）自己推游标
      return { added: fresh.length, images: 1 };
    },
  };
  const r = await executeCheckNewMessages({}, ctx);
  assert.deepEqual(ingested, ['2']);
  assert.match(r.content[0].text, /新到了 1 条/);
  assert.match(r.content[0].text, /1 张图片/, '要告诉模型图在下一步给它看，别对着占位符回答');

  const again = await executeCheckNewMessages({}, ctx);
  assert.match(again.content[0].text, /没有新消息|没有更新的了/);
  assert.deepEqual(ingested, ['2'], '没有新消息时不该再并入');
});

test('没图的新消息照常回全文，不提图片', async () => {
  const { executeCheckNewMessages } = socialTools;
  const msgs = [bufMsg(1, '张三', 'a', 1), bufMsg(2, '李四', '在吗', 2)];
  const cursor = createCursor();
  advanceCursor(cursor, [msgs[0]]);
  const r = await executeCheckNewMessages({}, {
    ...ctxWith(msgs, cursor),
    ingestNewMessages: async (fresh) => { advanceCursor(cursor, fresh); return { added: fresh.length, images: 0 }; },
  });
  assert.match(r.content[0].text, /在吗/);
  assert.doesNotMatch(r.content[0].text, /张图片/);
  assert.match(r.content[0].text, /纳入判断/);
});

test('并入失败时退回自己推游标，不让同一批在 turn 边界再注入一遍', async () => {
  const { executeCheckNewMessages } = socialTools;
  const msgs = [bufMsg(1, '张三', 'a', 1), bufMsg(2, '李四', 'b', 2)];
  const cursor = createCursor();
  advanceCursor(cursor, [msgs[0]]);
  const logs = [];
  const ctx = {
    ...ctxWith(msgs, cursor),
    addLog: (level, message) => logs.push([level, message]),
    ingestNewMessages: async () => { throw new Error('boom'); },
  };
  const r = await executeCheckNewMessages({}, ctx);
  assert.match(r.content[0].text, /李四/, '模型当下还是要看到内容');
  assert.equal(logs[0]?.[0], 'warn');
  const again = await executeCheckNewMessages({}, ctx);
  assert.match(again.content[0].text, /没有新消息|没有更新的了/);
});
