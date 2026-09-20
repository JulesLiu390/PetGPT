import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession, beginTurn, endTurn, appendHistory, canInject, recordInjection,
  recordSend, sealWindow, buildRequestItems, latestSummary,
  currentWindowId, itemsOfTurn, sessionStats,
  BACKLOG_REMINDER_AT, SEND_WINDOW_MAX, SEND_WINDOW_MS,
  canSendNow, sendWindowState, shouldRemindBacklog, markBacklogReminded, REGISTER_SILENT,
} from '../social/sessionState.js';

const mk = () => createSession({ targetId: '902317662', targetType: 'group', now: 1000 });

test('新 session 就有一个当前窗口', () => {
  const s = mk();
  assert.equal(s.windowIds.length, 1);
  assert.ok(currentWindowId(s));
  assert.equal(s.turnSeq, 0);
  assert.equal(s.currentTurn, null);
});

test('turn 串行：活跃 turn 未结束时不能再开', () => {
  const s = mk();
  beginTurn(s);
  assert.throws(() => beginTurn(s), /不能并发开启/);
});

test('结束后可以开下一个 turn，seq 递增', () => {
  const s = mk();
  const t1 = beginTurn(s);
  endTurn(s, t1);
  const t2 = beginTurn(s);
  assert.equal(t1.seq, 1);
  assert.equal(t2.seq, 2);
  assert.notEqual(t1.turnId, t2.turnId);
});

test('积压计数在发消息后清零 —— 累计会惩罚健康的多轮交互', () => {
  const s = mk();
  const t = beginTurn(s);
  recordInjection(t, 8);
  recordInjection(t, 7);
  assert.equal(t.backlog, 15);
  // 回了一句 → 账清了
  recordSend(s, t);
  assert.equal(t.backlog, 0, '"上次发消息以来"才是这个数的含义');
  assert.equal(t.injectedMessages, 15, '累计值保留，供遥测用');
  recordInjection(t, 3);
  assert.equal(t.backlog, 3);
  assert.equal(t.injectedMessages, 18);
});

test('积压到阈值时提醒，而不是切断 turn', () => {
  assert.equal(BACKLOG_REMINDER_AT, 20);
  const s = mk();
  const t = beginTurn(s);
  recordInjection(t, 19);
  assert.equal(shouldRemindBacklog(t), false);
  recordInjection(t, 1);
  assert.equal(shouldRemindBacklog(t), true);
  // 关键：提醒不影响继续注入。Codex 的 turn 也没有任何条数/轮数上限。
  assert.equal(canInject(t, 5), true, '提醒之后照样能继续');
});

test('一次积压只提醒一次，发过消息后重新计', () => {
  const s = mk();
  const t = beginTurn(s);
  recordInjection(t, 25);
  assert.equal(shouldRemindBacklog(t), true);
  markBacklogReminded(t);
  recordInjection(t, 10);
  assert.equal(shouldRemindBacklog(t), false, '同一次积压不重复唠叨');
  recordSend(s, t);
  recordInjection(t, 25);
  assert.equal(shouldRemindBacklog(t), true, '说过话之后重新开始计');
});

test('turn 完全不设上限：轮数、条数、时间都不限 —— 和 Codex 一致', () => {
  const s = mk();
  const t = beginTurn(s, { now: 1_000_000 });
  for (let i = 0; i < 500; i++) recordInjection(t, 5);
  assert.equal(t.injectedMessages, 2500);
  assert.equal(t.injections, 500);
  // 2500 条、500 轮、跑了一小时，照样能继续
  assert.equal(canInject(t, 1), true);
  assert.equal(canInject(t, 1, 1_000_000 + 60 * 60 * 1000), true, 'canInject 根本不看时间');
});

test('唯一的终止条件：没有新消息可注入', () => {
  const s = mk();
  const t = beginTurn(s);
  assert.equal(canInject(t, 1), true);
  assert.equal(canInject(t, 0), false);
  assert.equal(canInject(t, undefined), false);
  // 已结束的 turn 当然也不接受
  endTurn(s, t);
  assert.equal(canInject(t, 99), false);
});

test('history 条目自动带上 turnId 和 windowId', () => {
  const s = mk();
  const t = beginTurn(s);
  const e = appendHistory(s, { role: 'user', content: '在吗' });
  assert.equal(e.turnId, t.turnId);
  assert.equal(e.windowId, currentWindowId(s));
  assert.equal(e.kind, 'message');
  assert.deepEqual(itemsOfTurn(s, t.turnId).map(x => x.content), ['在吗']);
});

test('没调 turn_note 时按有没有发言兜底', () => {
  const s = mk();
  const silent = beginTurn(s);
  endTurn(s, silent);
  assert.equal(silent.note.register, REGISTER_SILENT);
  assert.equal(silent.note.inferred, true);

  const spoke = beginTurn(s);
  recordSend(s, spoke);
  endTurn(s, spoke);
  assert.equal(spoke.note.register, null, '发过言但没写 note，不硬套档位');
  assert.match(spoke.note.summary, /发送 1 条/);
});

test('turn_note 提供时原样保留', () => {
  const s = mk();
  const t = beginTurn(s);
  const note = { register: '观点', summary: '回答了反代封号的问题' };
  endTurn(s, t, { note });
  assert.deepEqual(t.note, note);
});

test('封窗后旧条目被摘要替换，新条目照常保留', () => {
  const s = mk();
  const t1 = beginTurn(s);
  appendHistory(s, { role: 'user', content: '老消息 A' });
  appendHistory(s, { role: 'assistant', content: '老回复 B' });
  endTurn(s, t1);

  sealWindow(s, '摘要：聊了 A 和 B');

  const t2 = beginTurn(s);
  appendHistory(s, { role: 'user', content: '新消息 C' });
  endTurn(s, t2);

  const items = buildRequestItems(s);
  assert.equal(items.length, 2, '一块摘要 + 一条新消息');
  assert.equal(items[0].kind, 'summary');
  assert.equal(items[0].content, '摘要：聊了 A 和 B');
  assert.equal(items[1].content, '新消息 C');
  assert.equal(s.history.length, 3, 'history 本身是 append-only，不删东西');
});

test('滚动摘要：压缩两次只发最后一份', () => {
  const s = mk();
  const t1 = beginTurn(s); appendHistory(s, { role: 'user', content: 'A' }); endTurn(s, t1);
  sealWindow(s, '摘要1');
  const t2 = beginTurn(s); appendHistory(s, { role: 'user', content: 'B' }); endTurn(s, t2);
  sealWindow(s, '摘要2（已包含摘要1）');
  const t3 = beginTurn(s); appendHistory(s, { role: 'user', content: 'C' }); endTurn(s, t3);

  const items = buildRequestItems(s);
  const summaries = items.filter(i => i.kind === 'summary');
  assert.equal(summaries.length, 1, '摘要不随 session 变长而堆积');
  assert.equal(summaries[0].content, '摘要2（已包含摘要1）');
  assert.equal(latestSummary(s), '摘要2（已包含摘要1）');
  assert.deepEqual(items.filter(i => i.kind !== 'summary').map(i => i.content), ['C']);
});

test('没压缩过时没有摘要块', () => {
  const s = mk();
  const t = beginTurn(s);
  appendHistory(s, { role: 'user', content: 'A' });
  endTurn(s, t);
  assert.equal(latestSummary(s), null);
  assert.equal(buildRequestItems(s).filter(i => i.kind === 'summary').length, 0);
});

test('sessionStats 区分总条目与未压缩条目', () => {
  const s = mk();
  const t1 = beginTurn(s); appendHistory(s, { role: 'user', content: 'A' }); endTurn(s, t1);
  sealWindow(s, 'sum');
  const t2 = beginTurn(s); appendHistory(s, { role: 'user', content: 'B' }); endTurn(s, t2);
  const st = sessionStats(s);
  assert.equal(st.turns, 2);
  assert.equal(st.historyItems, 2);
  assert.equal(st.liveItems, 1);
  assert.equal(st.windows, 2);
  assert.equal(st.sealedWindows, 1);
});

// ────────── 异常中断后必须能继续开 turn（否则该群永久停摆） ──────────

test('中途抛异常留下活跃 turn 时，补一次 endTurn 就能恢复', () => {
  const s = mk();
  const t1 = beginTurn(s);
  // 模拟 runSessionTurn 中途抛出：endTurn 没被调到
  assert.throws(() => beginTurn(s), /不能并发开启/, '这正是停摆的形态');

  // sessionLoop 的 catch 里做的补救
  endTurn(s, s.currentTurn, { note: { register: REGISTER_SILENT, summary: '异常中断', inferred: true } });

  const t2 = beginTurn(s);
  assert.equal(t2.seq, 2);
  assert.equal(t1.ended, true);
  assert.match(t1.note.summary, /异常中断/);
});

test('endTurn 幂等：重复调用不会把 seq 或 note 弄乱', () => {
  const s = mk();
  const t = beginTurn(s);
  endTurn(s, t, { note: { register: '观点', summary: '正常收尾', inferred: false } });
  const before = { ...t.note, endedAt: t.endedAt };
  endTurn(s, t, { note: { register: '沉默', summary: '不该覆盖', inferred: true } });
  assert.deepEqual(t.note, before.note ?? t.note);
  assert.equal(t.note.summary, '正常收尾', '已结束的 turn 不该被二次改写');
  assert.equal(s.turnSeq, 1);
});
