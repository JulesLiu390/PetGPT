import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_TAB_STATE_STATUS,
  COMPACT_CHAT_VIEW,
  EMPTY_CHAT_PRESENTATION,
  EMPTY_CHAT_PRESENTATION_EVENT,
  createActiveTabStateGenerationGate,
  createActiveTabStateSession,
  createLoadingActiveTabState,
  createReadyActiveTabState,
  getCompactChatView,
  getCompactChatWindowHeight,
  nextEmptyChatPresentation,
  pickPetIdForNewChat,
  normalizeTabStateSnapshot,
  shouldUseCompactChat,
} from '../compactChatModel.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test('normalizes Rust and frontend TabState snapshot shapes', () => {
  assert.deepEqual(normalizeTabStateSnapshot({
    messages: [{ role: 'user', content: 'Hello' }],
    is_thinking: true,
  }), {
    messages: [{ role: 'user', content: 'Hello' }],
    isThinking: true,
  });
  assert.deepEqual(normalizeTabStateSnapshot({ messages: null, isThinking: false }), {
    messages: [],
    isThinking: false,
  });
});

test('classifies no-tab and loading without treating unknown data as empty', () => {
  assert.equal(getCompactChatView(), COMPACT_CHAT_VIEW.NO_TAB);
  assert.equal(getCompactChatView({
    activeTabId: 'chat-a',
    tabState: createLoadingActiveTabState('chat-a'),
  }), COMPACT_CHAT_VIEW.LOADING);
  assert.equal(getCompactChatView({
    activeTabId: 'chat-b',
    tabState: createReadyActiveTabState('chat-a', { messages: [] }),
  }), COMPACT_CHAT_VIEW.LOADING);
});

test('classifies only a settled inactive snapshot as empty', () => {
  const tabState = createReadyActiveTabState('chat-a', {
    messages: [],
    is_thinking: false,
  });
  assert.equal(tabState.status, ACTIVE_TAB_STATE_STATUS.READY);
  assert.equal(getCompactChatView({ activeTabId: 'chat-a', tabState }), COMPACT_CHAT_VIEW.EMPTY);
});

test('separates empty content from the current window presentation intent', () => {
  assert.equal(shouldUseCompactChat({
    view: COMPACT_CHAT_VIEW.EMPTY,
    presentation: EMPTY_CHAT_PRESENTATION.COMPACT,
  }), true);
  assert.equal(shouldUseCompactChat({
    view: COMPACT_CHAT_VIEW.EMPTY,
    presentation: EMPTY_CHAT_PRESENTATION.TAB,
  }), false);
  assert.equal(shouldUseCompactChat({
    view: COMPACT_CHAT_VIEW.POPULATED,
    presentation: EMPTY_CHAT_PRESENTATION.COMPACT,
  }), false);
});

test('new-tab activity stays full until the window is hidden again', () => {
  let presentation = EMPTY_CHAT_PRESENTATION.COMPACT;
  presentation = nextEmptyChatPresentation(
    presentation,
    EMPTY_CHAT_PRESENTATION_EVENT.USER_NAVIGATION,
  );
  assert.equal(presentation, EMPTY_CHAT_PRESENTATION.TAB);
  assert.equal(shouldUseCompactChat({
    view: COMPACT_CHAT_VIEW.EMPTY,
    presentation,
  }), false);

  presentation = nextEmptyChatPresentation(
    presentation,
    EMPTY_CHAT_PRESENTATION_EVENT.WINDOW_HIDDEN,
  );
  assert.equal(presentation, EMPTY_CHAT_PRESENTATION.COMPACT);
  assert.equal(shouldUseCompactChat({
    view: COMPACT_CHAT_VIEW.EMPTY,
    presentation,
  }), true);
});

test('active content locks the visible session to the tab presentation', () => {
  const presentation = nextEmptyChatPresentation(
    EMPTY_CHAT_PRESENTATION.COMPACT,
    EMPTY_CHAT_PRESENTATION_EVENT.CONTENT_ACTIVE,
  );
  assert.equal(presentation, EMPTY_CHAT_PRESENTATION.TAB);
  assert.equal(shouldUseCompactChat({
    view: COMPACT_CHAT_VIEW.EMPTY,
    presentation,
  }), false);
});

test('non-empty and unresolved views never use the compact native window', () => {
  for (const view of [
    COMPACT_CHAT_VIEW.NO_TAB,
    COMPACT_CHAT_VIEW.LOADING,
    COMPACT_CHAT_VIEW.POPULATED,
  ]) {
    assert.equal(shouldUseCompactChat({
      view,
      presentation: EMPTY_CHAT_PRESENTATION.COMPACT,
    }), false);
    assert.equal(shouldUseCompactChat({
      view,
      presentation: EMPTY_CHAT_PRESENTATION.TAB,
    }), false);
  }
});

test('messages, thinking, streaming, and live tools each force populated view', () => {
  const empty = createReadyActiveTabState('chat-a', { messages: [], is_thinking: false });
  const withMessage = createReadyActiveTabState('chat-a', {
    messages: [{ role: 'user', content: 'Hello' }],
  });
  const thinking = createReadyActiveTabState('chat-a', { messages: [], is_thinking: true });

  assert.equal(getCompactChatView({ activeTabId: 'chat-a', tabState: withMessage }), COMPACT_CHAT_VIEW.POPULATED);
  assert.equal(getCompactChatView({ activeTabId: 'chat-a', tabState: thinking }), COMPACT_CHAT_VIEW.POPULATED);
  assert.equal(getCompactChatView({
    activeTabId: 'chat-a',
    tabState: empty,
    streamingContent: 'partial',
  }), COMPACT_CHAT_VIEW.POPULATED);
  assert.equal(getCompactChatView({
    activeTabId: 'chat-a',
    tabState: empty,
    liveToolCalls: [{ id: 'tool-1' }],
  }), COMPACT_CHAT_VIEW.POPULATED);
});

test('compact height follows content and reserves upward room for overlays', () => {
  assert.equal(getCompactChatWindowHeight(0), 104);
  assert.equal(getCompactChatWindowHeight(137.2), 138);
  assert.equal(getCompactChatWindowHeight(138, true), 530);
  assert.equal(getCompactChatWindowHeight(1000, true), 720);
});

test('generation gate rejects old work and stale cancellation cannot cancel new work', () => {
  const gate = createActiveTabStateGenerationGate();
  const first = gate.begin('chat-a');
  const second = gate.begin('chat-b');

  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.cancel(first);
  assert.equal(gate.isCurrent(second), true);
  gate.cancel(second);
  assert.equal(gate.isCurrent(second), false);
});

test('session subscribes before reading its initial snapshot', async () => {
  const calls = [];
  const snapshots = [];
  const session = createActiveTabStateSession({
    conversationId: 'chat-a',
    gate: createActiveTabStateGenerationGate(),
    subscribe: async () => {
      calls.push('subscribe');
      return () => calls.push('unsubscribe');
    },
    readSnapshot: async () => {
      calls.push('read');
      return { messages: [], is_thinking: false };
    },
    onSnapshot: (snapshot, metadata) => snapshots.push({ snapshot, metadata }),
  });

  await session.ready;
  assert.deepEqual(calls, ['subscribe', 'read']);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].metadata.source, 'snapshot');
  session.cancel();
  assert.deepEqual(calls, ['subscribe', 'read', 'unsubscribe']);
});

test('an event received during the read wins over the older read result', async () => {
  let listener;
  const snapshots = [];
  const session = createActiveTabStateSession({
    conversationId: 'chat-a',
    gate: createActiveTabStateGenerationGate(),
    subscribe: async (_conversationId, callback) => {
      listener = callback;
      return () => {};
    },
    readSnapshot: async () => {
      listener({ messages: [{ role: 'user', content: 'new' }], is_thinking: true });
      return { messages: [], is_thinking: false };
    },
    onSnapshot: (snapshot, metadata) => snapshots.push({ snapshot, metadata }),
  });

  await session.ready;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].metadata.source, 'event');
  assert.equal(snapshots[0].snapshot.messages[0].content, 'new');
  assert.equal(snapshots[0].snapshot.isThinking, true);
});

test('switching generation disposes a late subscription and blocks its read', async () => {
  const lateSubscription = deferred();
  const gate = createActiveTabStateGenerationGate();
  const snapshots = [];
  let staleReadCount = 0;
  let staleDisposeCount = 0;

  const staleSession = createActiveTabStateSession({
    conversationId: 'chat-a',
    gate,
    subscribe: () => lateSubscription.promise,
    readSnapshot: async () => {
      staleReadCount += 1;
      return { messages: [{ role: 'user', content: 'stale' }] };
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  const currentSession = createActiveTabStateSession({
    conversationId: 'chat-b',
    gate,
    subscribe: async () => () => {},
    readSnapshot: async () => ({ messages: [{ role: 'user', content: 'current' }] }),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  lateSubscription.resolve(() => { staleDisposeCount += 1; });
  await Promise.all([staleSession.ready, currentSession.ready]);

  assert.equal(staleDisposeCount, 1);
  assert.equal(staleReadCount, 0);
  assert.deepEqual(snapshots.map(snapshot => snapshot.messages[0].content), ['current']);
});

test('cancelling during a read blocks late state and removes the listener', async () => {
  const read = deferred();
  const snapshots = [];
  let disposeCount = 0;
  const session = createActiveTabStateSession({
    conversationId: 'chat-a',
    gate: createActiveTabStateGenerationGate(),
    subscribe: async () => () => { disposeCount += 1; },
    readSnapshot: () => read.promise,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  await Promise.resolve();
  session.cancel();
  read.resolve({ messages: [{ role: 'user', content: 'late' }] });
  await session.ready;

  assert.equal(disposeCount, 1);
  assert.deepEqual(snapshots, []);
});

test('summoning from the character opens the full dialog, not the quick-ask bubble', () => {
  // 点角色 / 点聊天图标：直接进常规布局
  assert.equal(
    nextEmptyChatPresentation(
      EMPTY_CHAT_PRESENTATION.COMPACT,
      EMPTY_CHAT_PRESENTATION_EVENT.CHAT_SUMMON,
    ),
    EMPTY_CHAT_PRESENTATION.TAB,
  );
});

test('summoning from the shortcut key opens the quick-ask bubble', () => {
  // 快捷键是唯一进紧凑气泡的入口，即使上一次停在常规布局
  assert.equal(
    nextEmptyChatPresentation(
      EMPTY_CHAT_PRESENTATION.TAB,
      EMPTY_CHAT_PRESENTATION_EVENT.QUICK_ASK_SUMMON,
    ),
    EMPTY_CHAT_PRESENTATION.COMPACT,
  );
});

test('a quick-ask bubble still expands to the regular layout once content arrives', () => {
  // 提问之后要变成常规小窗（能显示回复），而不是留在只有输入框的气泡里
  let presentation = nextEmptyChatPresentation(
    EMPTY_CHAT_PRESENTATION.TAB,
    EMPTY_CHAT_PRESENTATION_EVENT.QUICK_ASK_SUMMON,
  );
  assert.equal(presentation, EMPTY_CHAT_PRESENTATION.COMPACT);
  presentation = nextEmptyChatPresentation(
    presentation,
    EMPTY_CHAT_PRESENTATION_EVENT.CONTENT_ACTIVE,
  );
  assert.equal(presentation, EMPTY_CHAT_PRESENTATION.TAB);
});

// ==================== 新建对话挑哪个助手 ====================
// project 标签与聊天标签同处一个 tabs 数组，但它没有 petId。

const chatTab = (id, petId) => ({ id, petId, label: id });
const projectTab = (id) => ({ id, kind: 'project', projectId: id.slice(8), label: id });

test('当前是聊天标签时用它自己的助手', () => {
  const tabs = [chatTab('c1', 'pet-a'), chatTab('c2', 'pet-b')];
  assert.equal(pickPetIdForNewChat(tabs, 'c2'), 'pet-b');
});

test('当前是 project 标签时退回到还开着的聊天标签', () => {
  // 这正是「+ 号点了没反应」的场景：project 标签没有 petId
  const tabs = [chatTab('c1', 'pet-a'), projectTab('project:p1')];
  assert.equal(pickPetIdForNewChat(tabs, 'project:p1'), 'pet-a');
});

test('project 标签排在前面也不会被选中', () => {
  const tabs = [projectTab('project:p1'), chatTab('c1', 'pet-a')];
  assert.equal(pickPetIdForNewChat(tabs, 'project:p1'), 'pet-a');
  // activeTabId 对不上任何标签时同样跳过 project 标签
  assert.equal(pickPetIdForNewChat(tabs, 'gone'), 'pet-a');
});

test('只剩 project 标签时返回 null，由调用方去让用户选助手', () => {
  assert.equal(pickPetIdForNewChat([projectTab('project:p1')], 'project:p1'), null);
});

test('空列表和脏输入都返回 null 而不是抛错', () => {
  assert.equal(pickPetIdForNewChat([], 'anything'), null);
  assert.equal(pickPetIdForNewChat(null, 'anything'), null);
  assert.equal(pickPetIdForNewChat(undefined, undefined), null);
  assert.equal(pickPetIdForNewChat([null, undefined], 'x'), null);
});

test('petId 为空串的标签不算数', () => {
  const tabs = [chatTab('c1', ''), chatTab('c2', 'pet-b')];
  assert.equal(pickPetIdForNewChat(tabs, 'c1'), 'pet-b');
});
