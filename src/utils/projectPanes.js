/**
 * project 标签内「小标签栏 + Files 面板」的纯布局逻辑。
 *
 * 不含 IO 和 React，方便直接测试。两个核心决策都在这里：
 *   1. Files 是右侧常驻面板，还是降级成小标签栏里的一个页签
 *   2. 小标签栏该显示哪些页签、哪个激活
 */

/** Files 面板固定宽度。低于 180px 文件名全是省略号，树就没用了。 */
export const FILES_PANEL_WIDTH = 200;
export const FILES_PANEL_MIN_WIDTH = 180;

/**
 * 终端列宽估算：12px 等宽字体的字符步进约 7.2px。
 * 80 列是舒适下限，60 列是能用下限。
 */
export const TERMINAL_CHAR_WIDTH = 7.2;
export const TERMINAL_COMFORTABLE_COLS = 80;
export const TERMINAL_USABLE_COLS = 60;

/** main area 宽度达到这个值，Files 才够资格常驻右侧（80 列 + 200px）。 */
export const FILES_PANEL_BREAKPOINT = Math.ceil(
  TERMINAL_COMFORTABLE_COLS * TERMINAL_CHAR_WIDTH + FILES_PANEL_WIDTH,
);

/** Files 面板的特殊页签 id。它在窄布局里钉在最左且不可关闭。 */
export const FILES_PANE_ID = '__files__';

/** 会话类型 → 小标签上的展示名。与 Rust 侧 default_title_for_kind 保持一致。 */
export const PANE_KIND_LABELS = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  shell: 'Terminal',
});

export const isFilesPane = (paneId) => paneId === FILES_PANE_ID;

/**
 * 一个 pane 的稳定身份。
 *
 * **不能用 PTY 会话 id 当身份**：进程退出后再 resume 会换一个新的 PTY 会话，
 * 若身份跟着变，界面上就会多出一个 pane / 一行，而用户的心智模型是「还是
 * 那个对话」。所以恢复出来的 pane 用 `agent:<对话 id>` 作身份。
 *
 * 新建的会话在认领到对话 id 之前只能用 `pty:<会话 id>` 兜底，而且**这个键
 * 一旦定下就不再改** —— 否则认领成功的那一刻键变了，React 会重挂
 * TerminalPane，屏幕内容会被清空。
 */
export const paneKeyFor = ({ agentId, sessionId }) => (
  agentId ? `agent:${agentId}` : `pty:${sessionId}`
);

/**
 * 一个 pane 在开一个新进程时的状态迁移。
 *
 * 已退出的 pane 被恢复时**原地换进程**：身份键不变，只把当前 PTY 会话换成
 * 新的。这样小标签不会多一个、位置也不动。
 */
export const revivePane = (panes = [], paneKey, session) => panes.map((pane) => (
  pane.key === paneKey
    ? { ...pane, sessionId: session.id, alive: session.alive !== false, kind: session.kind ?? pane.kind }
    : pane
));

/** 按当前 PTY 会话 id 找 pane。侧边栏点击时用它定位到具体 pane。 */
export const paneForSessionId = (panes = [], sessionId) => (
  panes.find((pane) => pane.sessionId === sessionId) || null
);

/** 按对话 id 找 pane。恢复时用它判断该原地复活还是新建。 */
export const paneForAgentId = (panes = [], agentId) => (
  agentId ? panes.find((pane) => pane.agentId === agentId) || null : null
);

/**
 * 把活着的 PTY 会话和已有 pane 合并。
 *
 * 已有 pane 的身份键保持不变（见 paneKeyFor 的说明）；后端新报上来的会话
 * 才会创建新 pane。进程退出的 pane 保留下来并标记 alive=false，这样它还在
 * 原位，可以就地恢复。
 */
export const mergePanes = ({ panes = [], sessions = [], boundBySessionId = {} } = {}) => {
  const bySessionId = new Map(panes.filter((p) => p.sessionId).map((p) => [p.sessionId, p]));
  const out = [];
  const seen = new Set();

  for (const session of sessions) {
    if (!session?.id) continue;
    const existing = bySessionId.get(session.id);
    const agentId = boundBySessionId[session.id]?.agentId ?? existing?.agentId ?? null;
    const key = existing?.key ?? paneKeyFor({ agentId, sessionId: session.id });
    seen.add(key);
    out.push({
      key,
      sessionId: session.id,
      agentId,
      kind: session.kind ?? existing?.kind,
      title: boundBySessionId[session.id]?.title ?? session.title ?? existing?.title ?? null,
      alive: session.alive !== false,
    });
  }

  // 后端已经不报的 pane：进程退出了。有对话 id 的留在原位等恢复，
  // 没有的（比如纯终端）直接消失 —— 它没有可恢复的身份。
  for (const pane of panes) {
    if (seen.has(pane.key)) continue;
    if (!pane.agentId) continue;
    out.push({ ...pane, alive: false });
  }
  return out;
};

/**
 * Files 面板是常驻右侧还是收进小标签。
 * 判断依据是 main area 的宽度而不是窗口宽度 —— 这样它与侧边栏自身的
 * 显示/隐藏自然组合，不需要知道侧边栏当前是什么状态。
 */
export const shouldDockFilesPanel = (mainAreaWidth, breakpoint = FILES_PANEL_BREAKPOINT) => (
  Number.isFinite(mainAreaWidth) && mainAreaWidth >= breakpoint
);

/**
 * 给定终端可用像素宽度，算出 xterm 该用多少列。
 * 下限 20 列与 Rust 侧 pty_resize 的 clamp 一致，避免两边打架。
 */
export const terminalColsFor = (pixelWidth, charWidth = TERMINAL_CHAR_WIDTH) => {
  if (!Number.isFinite(pixelWidth) || pixelWidth <= 0) return TERMINAL_USABLE_COLS;
  return Math.max(20, Math.floor(pixelWidth / charWidth));
};

/**
 * 构造小标签栏要渲染的页签列表。
 * docked 为 true 时 Files 是右侧面板，不出现在页签里。
 */
export const buildPaneTabs = ({ panes = [], previews = [], filesDocked = true } = {}) => {
  const tabs = [];
  if (!filesDocked) {
    tabs.push({ id: FILES_PANE_ID, type: 'files', title: 'Files', closable: false });
  }
  for (const pane of panes) {
    tabs.push({
      // 标签 id 用 pane 的稳定身份，不是 PTY 会话 id —— 恢复后换了进程，
      // 标签还是同一个
      id: pane.key,
      type: 'session',
      title: pane.title || PANE_KIND_LABELS[pane.kind] || 'Session',
      kind: pane.kind,
      alive: pane.alive !== false,
      sessionId: pane.sessionId,
      agentId: pane.agentId,
      closable: true,
    });
  }
  for (const preview of previews) {
    tabs.push({
      id: preview.id,
      type: 'preview',
      title: preview.name,
      path: preview.path,
      pinned: preview.pinned === true,
      closable: true,
    });
  }
  return tabs;
};

/**
 * 决定实际激活哪个页签。
 *
 * 处理三种失效：请求的页签不存在（会话被杀、预览被关）、布局切换导致
 * Files 页签消失（docked 之后）、以及一个页签都没有。
 */
export const resolveActivePane = ({ requested, tabs = [], filesDocked = true } = {}) => {
  if (tabs.length === 0) return null;
  const exists = tabs.some((tab) => tab.id === requested);
  if (exists) return requested;
  // Files 收进 docked 面板后，原先停在 Files 页签上的焦点要落到第一个会话
  const firstSession = tabs.find((tab) => tab.type === 'session');
  if (firstSession) return firstSession.id;
  if (!filesDocked) {
    const files = tabs.find((tab) => tab.type === 'files');
    if (files) return files.id;
  }
  return tabs[0].id;
};

/**
 * 预览页签的复用规则（照 VS Code：未钉住的预览只占一个槽位）。
 * 返回新的 previews 数组和应该激活的 pane id。
 */
export const openPreview = ({ previews = [], file, pinned = false } = {}) => {
  if (!file?.path) return { previews, activeId: null };
  const existing = previews.find((p) => p.path === file.path);
  if (existing) {
    return { previews, activeId: existing.id };
  }
  const entry = {
    id: `preview:${file.path}`,
    path: file.path,
    name: file.name || file.path.split('/').pop(),
    pinned,
  };
  if (pinned) {
    return { previews: [...previews, entry], activeId: entry.id };
  }
  // 顶掉上一个未钉住的预览，避免点十个文件堆十个页签
  const kept = previews.filter((p) => p.pinned);
  return { previews: [...kept, entry], activeId: entry.id };
};

export const pinPreview = (previews = [], id) => (
  previews.map((p) => (p.id === id ? { ...p, pinned: true } : p))
);

export const closePane = ({ panes = [], previews = [], id } = {}) => ({
  panes: panes.filter((pane) => pane.key !== id),
  previews: previews.filter((p) => p.id !== id),
});

export default {
  FILES_PANEL_WIDTH,
  FILES_PANEL_MIN_WIDTH,
  FILES_PANEL_BREAKPOINT,
  FILES_PANE_ID,
  PANE_KIND_LABELS,
  TERMINAL_COMFORTABLE_COLS,
  TERMINAL_USABLE_COLS,
  isFilesPane,
  paneKeyFor,
  revivePane,
  paneForSessionId,
  paneForAgentId,
  mergePanes,
  shouldDockFilesPanel,
  terminalColsFor,
  buildPaneTabs,
  resolveActivePane,
  openPreview,
  pinPreview,
  closePane,
};
