import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_IDLE_MS,
  SESSION_STATE,
  projectSessionList,
  runningSessionIds,
  sameIdSet,
  sessionStateIn,
  sessionStateOf,
} from '../sessionActivity.js';

const NOW = 1_800_000_000_000;

test('a session with recent output reads as running', () => {
  assert.equal(sessionStateOf({ alive: true }, NOW - 100, NOW), SESSION_STATE.RUNNING);
});

test('a live session that has gone quiet reads as idle', () => {
  assert.equal(
    sessionStateOf({ alive: true }, NOW - ACTIVITY_IDLE_MS - 1, NOW),
    SESSION_STATE.IDLE,
  );
});

test('a session that never produced output is idle, not running', () => {
  assert.equal(sessionStateOf({ alive: true }, 0, NOW), SESSION_STATE.IDLE);
  assert.equal(sessionStateOf({ alive: true }, undefined, NOW), SESSION_STATE.IDLE);
});

test('an exited session is exited regardless of past output', () => {
  assert.equal(sessionStateOf({ alive: false }, NOW, NOW), SESSION_STATE.EXITED);
  assert.equal(sessionStateOf(null, NOW, NOW), SESSION_STATE.EXITED);
});

test('a clock that moved backwards counts as just-had-output, not idle', () => {
  assert.equal(sessionStateOf({ alive: true }, NOW + 5_000, NOW), SESSION_STATE.RUNNING);
});

test('the running set only contains sessions inside the idle window', () => {
  const activity = {
    hot: NOW - 100,
    cold: NOW - ACTIVITY_IDLE_MS - 1,
    never: 0,
    junk: 'soon',
  };
  const running = runningSessionIds(activity, NOW);
  assert.deepEqual([...running], ['hot']);
});

test('set comparison decides whether a re-render is needed', () => {
  assert.equal(sameIdSet(new Set(['a']), new Set(['a'])), true);
  assert.equal(sameIdSet(new Set(['a']), new Set(['b'])), false);
  assert.equal(sameIdSet(new Set(['a']), new Set(['a', 'b'])), false);
  assert.equal(sameIdSet(new Set(), new Set()), true);
  assert.equal(sameIdSet(null, new Set()), false);
});

test('the set-based state agrees with the timestamp-based one', () => {
  // 这两条路径描述的是同一件事。UI 走集合那条是为了不用持有一个每帧都在
  // 变的 now —— 结论必须一致，否则指示器会跟着渲染路径变。
  const activity = { hot: NOW - 100, cold: NOW - ACTIVITY_IDLE_MS - 1 };
  const running = runningSessionIds(activity, NOW);
  for (const id of ['hot', 'cold']) {
    assert.equal(
      sessionStateIn({ alive: true }, running, id),
      sessionStateOf({ alive: true }, activity[id], NOW),
      id,
    );
  }
});

test('an exited session reads as exited even while it is in the running set', () => {
  // 进程退出和「最后一段输出还在 idle 窗口内」会同时成立：退出前那阵输出
  // 刚刚发生过。此时必须显示已退出，否则灰圈点不亮用户会去点一个死终端。
  const running = new Set(['gone']);
  assert.equal(sessionStateIn({ alive: false }, running, 'gone'), SESSION_STATE.EXITED);
});

test('a missing running set degrades to idle rather than throwing', () => {
  assert.equal(sessionStateIn({ alive: true }, undefined, 'x'), SESSION_STATE.IDLE);
  assert.equal(sessionStateIn(null, new Set(['x']), 'x'), SESSION_STATE.EXITED);
});

test('the same conversation appears exactly once, not split across two sections', () => {
  // 之前活跃区和历史区会各显示一次，用户看到两行同名会话分不清哪个是哪个
  const rows = projectSessionList({
    liveSessions: [{ id: 'pty-new', kind: 'claude', alive: true }],
    bound: [
      { id: 'pty-new', agentId: 'a-1', kind: 'claude', lastActiveAt: 900 },
      { id: 'pty-old', agentId: 'a-1', kind: 'claude', lastActiveAt: 400 },
    ],
    agentSessions: [{ agentId: 'a-1' }],
  });
  assert.equal(rows.length, 1, '同一个 agent 会话只能有一行');
  assert.equal(rows[0].sessionId, 'pty-new');
  assert.equal(rows[0].alive, true, '活着的记录要覆盖已退出的');
});

test('a live session shows up even before its agent id has been claimed', () => {
  // 两个 CLI 都是懒写入，刚起的会话还没有 agent id，但它就在眼前跑着
  const rows = projectSessionList({
    liveSessions: [{ id: 'pty-1', kind: 'claude', alive: true }],
    bound: [{ id: 'pty-1', agentId: null, kind: 'claude' }],
    agentSessions: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alive, true);
  assert.equal(rows[0].resumable, false, '还没有 id，点了无从 resume');
});

test('an exited session with no agent id is dropped instead of shown as a dead row', () => {
  const rows = projectSessionList({
    liveSessions: [],
    bound: [{ id: 'pty-1', agentId: null, kind: 'claude', lastActiveAt: 10 }],
    agentSessions: [],
  });
  assert.deepEqual(rows, []);
});

test('a terminal never persists once it has exited', () => {
  const live = projectSessionList({
    liveSessions: [{ id: 'sh-1', kind: 'shell', alive: true }],
    bound: [],
    agentSessions: [],
  });
  assert.equal(live.length, 1, '活着的时候要显示');

  const gone = projectSessionList({
    liveSessions: [],
    bound: [{ id: 'sh-1', agentId: 'a-1', kind: 'shell', lastActiveAt: 5 }],
    agentSessions: [{ agentId: 'a-1' }],
  });
  assert.deepEqual(gone, [], '退出后不留条目');
});

test('live sessions sort above exited ones, then by recency', () => {
  const rows = projectSessionList({
    liveSessions: [{ id: 'live', kind: 'claude', alive: true }],
    bound: [
      { id: 'live', agentId: 'a-live', kind: 'claude', lastActiveAt: 100 },
      { id: 'older', agentId: 'a-old', kind: 'codex', lastActiveAt: 200 },
      { id: 'newer', agentId: 'a-new', kind: 'codex', lastActiveAt: 800 },
    ],
    agentSessions: [{ agentId: 'a-live' }, { agentId: 'a-old' }, { agentId: 'a-new' }],
  });
  assert.deepEqual(rows.map((r) => r.sessionId), ['live', 'newer', 'older']);
});

test('a session whose CLI file is gone is listed but not resumable', () => {
  const rows = projectSessionList({
    liveSessions: [],
    bound: [{ id: 'pty-1', agentId: 'deleted', kind: 'claude', lastActiveAt: 1 }],
    agentSessions: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resumable, false, '文件已删，不该让用户点');
});

test('two genuinely different conversations stay as two rows', () => {
  const rows = projectSessionList({
    liveSessions: [
      { id: 'pty-1', kind: 'claude', alive: true },
      { id: 'pty-2', kind: 'claude', alive: true },
    ],
    bound: [
      { id: 'pty-1', agentId: 'a-1', kind: 'claude' },
      { id: 'pty-2', agentId: 'a-2', kind: 'claude' },
    ],
    agentSessions: [{ agentId: 'a-1' }, { agentId: 'a-2' }],
  });
  assert.equal(rows.length, 2, '多窗口并存要能区分');
});
