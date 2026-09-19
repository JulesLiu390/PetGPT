import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILES_PANEL_BREAKPOINT,
  FILES_PANE_ID,
  TERMINAL_USABLE_COLS,
  buildPaneTabs,
  closePane,
  mergePanes,
  openPreview,
  paneForAgentId,
  paneForSessionId,
  paneKeyFor,
  pinPreview,
  resolveActivePane,
  revivePane,
  shouldDockFilesPanel,
  terminalColsFor,
} from '../projectPanes.js';

const session = (id, kind = 'claude', alive = true) => ({ id, kind, alive, title: undefined });
const pane = (key, sessionId, { agentId = null, kind = 'claude', alive = true, title = null } = {}) =>
  ({ key, sessionId, agentId, kind, alive, title });

test('the Files panel docks only once the main area can hold 80 columns plus the tree', () => {
  // 80 列 ≈ 576px，加 200px 文件树
  assert.equal(FILES_PANEL_BREAKPOINT, 776);
  assert.equal(shouldDockFilesPanel(776), true);
  assert.equal(shouldDockFilesPanel(775), false);
  assert.equal(shouldDockFilesPanel(1200), true);
  assert.equal(shouldDockFilesPanel(244), false);
});

test('a missing or nonsense width never docks the panel', () => {
  assert.equal(shouldDockFilesPanel(undefined), false);
  assert.equal(shouldDockFilesPanel(NaN), false);
  assert.equal(shouldDockFilesPanel(0), false);
});

test('terminal columns come from the pixel width, with a floor matching the Rust clamp', () => {
  assert.equal(terminalColsFor(576), 80);
  assert.equal(terminalColsFor(432), 60);
  // Rust 侧 pty_resize 把 cols clamp 到 20，两边必须一致
  assert.equal(terminalColsFor(10), 20);
  assert.equal(terminalColsFor(0), TERMINAL_USABLE_COLS);
  assert.equal(terminalColsFor(undefined), TERMINAL_USABLE_COLS);
});

test('the Files tab appears in the strip only when the panel is not docked', () => {
  const panes = [pane('pty:s1', 's1')];
  const docked = buildPaneTabs({ panes, filesDocked: true });
  assert.deepEqual(docked.map((t) => t.id), ['pty:s1']);

  const undocked = buildPaneTabs({ panes, filesDocked: false });
  assert.deepEqual(undocked.map((t) => t.id), [FILES_PANE_ID, 'pty:s1']);
  // 窄布局里 Files 钉在最左且不可关闭，否则文件树会变得无法到达
  assert.equal(undocked[0].closable, false);
});

test('session tabs carry their kind label and alive flag', () => {
  const tabs = buildPaneTabs({
    panes: [
      pane('pty:s1', 's1', { kind: 'claude' }),
      pane('pty:s2', 's2', { kind: 'codex' }),
      pane('pty:s3', 's3', { kind: 'shell', alive: false }),
    ],
  });
  assert.deepEqual(tabs.map((t) => t.title), ['Claude', 'Codex', 'Terminal']);
  assert.deepEqual(tabs.map((t) => t.alive), [true, true, false]);
});

test('previews sit after sessions and keep their path', () => {
  const tabs = buildPaneTabs({
    panes: [pane('pty:s1', 's1')],
    previews: [{ id: 'p1', name: 'tauri.js', path: 'src/utils/tauri.js' }],
  });
  assert.deepEqual(tabs.map((t) => t.type), ['session', 'preview']);
  assert.equal(tabs[1].title, 'tauri.js');
  assert.equal(tabs[1].path, 'src/utils/tauri.js');
});

test('an unpinned preview is reused so ten clicks do not leave ten tabs', () => {
  let previews = [];
  ({ previews } = openPreview({ previews, file: { path: 'a.js', name: 'a.js' } }));
  ({ previews } = openPreview({ previews, file: { path: 'b.js', name: 'b.js' } }));
  ({ previews } = openPreview({ previews, file: { path: 'c.js', name: 'c.js' } }));
  assert.deepEqual(previews.map((p) => p.path), ['c.js']);
});

test('a pinned preview survives while the reusable slot keeps turning over', () => {
  let previews = [];
  ({ previews } = openPreview({ previews, file: { path: 'keep.js', name: 'keep.js' }, pinned: true }));
  ({ previews } = openPreview({ previews, file: { path: 'x.js', name: 'x.js' } }));
  ({ previews } = openPreview({ previews, file: { path: 'y.js', name: 'y.js' } }));
  assert.deepEqual(previews.map((p) => p.path), ['keep.js', 'y.js']);
});

test('reopening an already open file activates it instead of duplicating it', () => {
  let previews = [];
  let activeId;
  ({ previews } = openPreview({ previews, file: { path: 'a.js', name: 'a.js' }, pinned: true }));
  ({ previews, activeId } = openPreview({ previews, file: { path: 'a.js', name: 'a.js' } }));
  assert.equal(previews.length, 1);
  assert.equal(activeId, 'preview:a.js');
});

test('pinning promotes the reusable slot to a permanent tab', () => {
  let previews = [];
  ({ previews } = openPreview({ previews, file: { path: 'a.js', name: 'a.js' } }));
  previews = pinPreview(previews, 'preview:a.js');
  ({ previews } = openPreview({ previews, file: { path: 'b.js', name: 'b.js' } }));
  assert.deepEqual(previews.map((p) => p.path), ['a.js', 'b.js']);
});

test('opening a file with no path is a no-op', () => {
  const result = openPreview({ previews: [], file: {} });
  assert.deepEqual(result.previews, []);
  assert.equal(result.activeId, null);
});

test('the active pane falls back to a session when the requested one is gone', () => {
  const tabs = buildPaneTabs({ panes: [pane('pty:s1', 's1'), pane('pty:s2', 's2')] });
  assert.equal(resolveActivePane({ requested: 'pty:s2', tabs }), 'pty:s2');
  // 会话被杀掉之后
  assert.equal(resolveActivePane({ requested: 'dead', tabs }), 'pty:s1');
});

test('docking the Files panel moves focus off the vanished Files tab', () => {
  // 窄布局时停在 Files 页签，窗口拉宽后该页签不存在了
  const tabs = buildPaneTabs({ panes: [pane('pty:s1', 's1')], filesDocked: true });
  assert.equal(resolveActivePane({ requested: FILES_PANE_ID, tabs, filesDocked: true }), 'pty:s1');
});

test('with no sessions the Files tab keeps focus in the narrow layout', () => {
  const tabs = buildPaneTabs({ panes: [], filesDocked: false });
  assert.equal(resolveActivePane({ requested: 'gone', tabs, filesDocked: false }), FILES_PANE_ID);
});

test('an empty strip resolves to nothing rather than a bogus id', () => {
  assert.equal(resolveActivePane({ requested: 's1', tabs: [] }), null);
});

test('closing a pane removes it from whichever collection it lived in', () => {
  const panes = [pane('pty:s1', 's1'), pane('pty:s2', 's2')];
  const previews = [{ id: 'p1', path: 'a.js', name: 'a.js' }];
  const afterSession = closePane({ panes, previews, id: 'pty:s1' });
  assert.deepEqual(afterSession.panes.map((p) => p.key), ['pty:s2']);
  assert.equal(afterSession.previews.length, 1);

  const afterPreview = closePane({ panes, previews, id: 'p1' });
  assert.equal(afterPreview.panes.length, 2);
  assert.deepEqual(afterPreview.previews, []);
});

// ==================== pane 身份模型 ====================

test('a resumed pane is identified by the conversation, not by the process', () => {
  // 进程换了，身份不变 —— 这才是「还是那个对话」
  assert.equal(paneKeyFor({ agentId: 'a-1', sessionId: 's9' }), 'agent:a-1');
  // 还没认领到对话 id 时只能用会话 id 兜底
  assert.equal(paneKeyFor({ agentId: null, sessionId: 's9' }), 'pty:s9');
});

test('reviving a pane swaps its process in place without adding a tab', () => {
  const before = [pane('agent:a-1', 'old-pty', { agentId: 'a-1', alive: false })];
  const after = revivePane(before, 'agent:a-1', session('new-pty'));
  assert.equal(after.length, 1, '不该多出 pane');
  assert.equal(after[0].key, 'agent:a-1', '身份键不变');
  assert.equal(after[0].sessionId, 'new-pty', '进程换成新的');
  assert.equal(after[0].alive, true);
});

test('panes can be located by process or by conversation', () => {
  const panes = [
    pane('agent:a-1', 's1', { agentId: 'a-1' }),
    pane('pty:s2', 's2'),
  ];
  assert.equal(paneForSessionId(panes, 's2')?.key, 'pty:s2');
  assert.equal(paneForAgentId(panes, 'a-1')?.key, 'agent:a-1');
  assert.equal(paneForSessionId(panes, 'nope'), null);
  assert.equal(paneForAgentId(panes, null), null, '没有对话 id 就不该乱匹配');
});

test('an existing pane keeps its key even after its conversation id is claimed', () => {
  // 认领成功时若身份键跟着变，React 会重挂 TerminalPane，屏幕会被清空
  const panes = [pane('pty:s1', 's1', { agentId: null })];
  const merged = mergePanes({
    panes,
    sessions: [session('s1')],
    boundBySessionId: { s1: { agentId: 'a-1' } },
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, 'pty:s1', '键必须保持不变');
  assert.equal(merged[0].agentId, 'a-1', '但对话 id 要记下来');
});

test('an exited pane with a conversation id stays in place, ready to revive', () => {
  const panes = [pane('agent:a-1', 's1', { agentId: 'a-1' })];
  // 后端已经不报这个会话了 —— 进程退出
  const merged = mergePanes({ panes, sessions: [] });
  assert.equal(merged.length, 1, '留在原位');
  assert.equal(merged[0].alive, false);
});

test('an exited terminal disappears because it has nothing to resume', () => {
  const panes = [pane('pty:sh1', 'sh1', { kind: 'shell', agentId: null })];
  const merged = mergePanes({ panes, sessions: [] });
  assert.deepEqual(merged, [], '纯终端没有可恢复的身份');
});

test('a session the backend newly reports becomes a fresh pane', () => {
  const merged = mergePanes({ panes: [], sessions: [session('s1', 'codex')] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, 'pty:s1');
  assert.equal(merged[0].kind, 'codex');
});
