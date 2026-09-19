import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import ChatboxTitleBar from '../Layout/ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';
import ChatboxMessageArea from './ChatboxMessageArea';
import useActiveTabState from './useActiveTabState';
import {
  COMPACT_CHAT_VIEW,
  EMPTY_CHAT_PRESENTATION,
  EMPTY_CHAT_PRESENTATION_EVENT,
  getCompactChatView,
  getCompactChatWindowHeight,
  nextEmptyChatPresentation,
  pickPetIdForNewChat,
  shouldUseCompactChat,
} from './compactChatModel.js';
import { useStateValue, useStreamingReplies } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import * as tauri from '../../utils/tauri';
import { listen } from '@tauri-apps/api/event';
import { MdDelete, MdAdd, MdSearch, MdClose, MdWarning, MdKeyboardArrowDown, MdChevronRight, MdClear } from 'react-icons/md';
import { BsLayoutSidebar } from "react-icons/bs";
import { LuMaximize2 } from "react-icons/lu";
import { createChatFocusRequestGate } from '../../utils/chatFocusModel.js';
import { useI18n } from '../../i18n/context.js';
import {
  DEFAULT_MARKDOWN_TYPOGRAPHY,
  getMarkdownTypographyCssVariables,
  normalizeMarkdownTypography,
} from '../../utils/markdownTypography.js';
import UpdateBanner from './UpdateBanner';
import ProjectsSection from '../Project/ProjectsSection';
import ProjectView from '../Project/ProjectView';
import ProjectStatusBar from '../Project/ProjectStatusBar';
import { runningSessionIds, sameIdSet } from '../../utils/sessionActivity.js';
import {
  GIT_POLL_INTERVAL_MS,
  buildDeletedIndex,
  buildGitDecorations,
  gitStatusSignature,
} from '../../utils/gitDecorations.js';
import {
  UPDATE_CHECK_STARTUP_DELAY_MS,
  shouldCheckForUpdate,
  shouldShowUpdateBanner,
  updateSettingsPatchFor,
} from '../../utils/updateCheck.js';
// import { AiFillChrome } from 'react-icons/ai';
// import ChatboxTabBar from './ChatboxTabBar';

// 关键词高亮组件
const HighlightText = ({ text, keyword }) => {
  if (!keyword || !text) return <>{text}</>;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === keyword.toLowerCase() ? (
          <mark key={i} className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
};

export const Chatbox = () => {
  const { t } = useI18n();
  // 方案 C: 使用 Rust 内存缓存管理消息
  const [{ navBarChats, updatedConversation, liveToolCalls = {}, characterMoods, suggestText = {} }, dispatch] = useStateValue();
  // 流式回复走独立 Context。它每帧都在变，留在 useStateValue 里会把这整棵
  // 树（含侧边栏、项目面板、终端）按帧重渲染；而且 StateContext 上挂的那份
  // streamingReplies 是刻意过期的，见 StateProvider。
  const streamingReplies = useStreamingReplies();
  const [testCount, setTestCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 侧边栏里两个同级区块的折叠状态。两个都展开时各分一半剩余高度、
  // 各自滚动；折起一个，另一个就吃满。
  const [chatsSectionOpen, setChatsSectionOpen] = useState(true);

  // 全 UI 模式 = 宽到侧边栏常驻显示的程度。用的就是侧边栏 lg:!flex 那条
  // 断点（Tailwind lg = 1024px），所以「侧边栏常驻」和「大标签常驻」
  // 永远同时成立，不会出现一个在一个不在。
  const [isFullUiWidth, setIsFullUiWidth] = useState(false);

  useEffect(() => {
    const measure = () => setIsFullUiWidth(window.innerWidth >= 1024);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // 当前激活的 project 标签上报的小标签信息。Ctrl+W 先关小标签，
  // 小标签全关完之后再关大标签。
  const projectPanesRef = useRef(null);
  const [windowVisible, setWindowVisible] = useState(false);
  const [focusRequest, setFocusRequest] = useState(null);
  const [emptyChatPresentation, setEmptyChatPresentation] = useState(
    EMPTY_CHAT_PRESENTATION.COMPACT,
  );
  const [compactContentHeight, setCompactContentHeight] = useState(104);
  const [composerOverlayOpen, setComposerOverlayOpen] = useState(false);
  const [isMouseOver, setIsMouseOver] = useState(false);
  const [showTitleBar, setShowTitleBar] = useState(false); // 延迟隐藏用
  const [isTitleBarVisible, setIsTitleBarVisible] = useState(false); // 控制 opacity
  const [conversations, setConversations] = useState([]);
  const [orphanConversations, setOrphanConversations] = useState([]);
  const [displayCount, setDisplayCount] = useState(50); // sidebar 分页：初始显示 50 条
  const [isThinking, setIsThinking] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [selectedOrphanConv, setSelectedOrphanConv] = useState(null);
  const [availableAssistants, setAvailableAssistants] = useState([]);
  const [allAssistants, setAllAssistants] = useState([]); // 所有 assistants 列表
  const [showAssistantDropdown, setShowAssistantDropdown] = useState(false); // 底部 assistant 下拉菜单
  // Stay disabled until persisted settings load, so an explicitly disabled
  // preference can never race an eager suggestion request at startup.
  const [quickReplyEnabled, setQuickReplyEnabled] = useState(false);
  const [markdownTypography, setMarkdownTypography] = useState(DEFAULT_MARKDOWN_TYPOGRAPHY);
  const [quickReplyRequest, setQuickReplyRequest] = useState(null);
  const quickReplyRequestIdRef = useRef(0);
  // Per-tab chatbody status for "Memory updating" display
  const [chatbodyStatuses, setChatbodyStatuses] = useState({}); // { conversationId: status }
  
  // Platform info from Rust backend for adaptive UI
  const [platformInfo, setPlatformInfo] = useState({
    platform: document.documentElement.dataset.platform || 'macos',
    has_vibrancy: document.documentElement.dataset.platform === 'macos' ? 'true' : 'false',
    has_cursor_tracking: 'true',
  });

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const searchInputRef = useRef(null);
  const searchTimerRef = useRef(null);
  
  // Tab State - declare early so we can use activeTabId
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const activeTabIdRef = useRef(null);
  const conversationSelectionGenerationRef = useRef(0);
  const focusRequestGateRef = useRef(null);
  const compactModeRequestRef = useRef('');
  // Seed with wall-clock time so a WebView reload cannot restart request ids
  // below the Rust process's last accepted generation.
  const compactModeGenerationRef = useRef(Date.now());
  if (focusRequestGateRef.current === null) {
    focusRequestGateRef.current = createChatFocusRequestGate();
  }

  const activeTabState = useActiveTabState(activeTabId);
  const activeStreamingContent = activeTabId ? (streamingReplies?.[activeTabId] ?? null) : null;
  const activeLiveToolCalls = activeTabId ? (liveToolCalls?.[activeTabId] ?? []) : [];
  const compactChatView = getCompactChatView({
    activeTabId,
    tabState: activeTabState,
    streamingContent: activeStreamingContent,
    liveToolCalls: activeLiveToolCalls,
  });
  const isCompactChat = shouldUseCompactChat({
    view: compactChatView,
    presentation: emptyChatPresentation,
  });
  const chatShellRef = useRef(null);
  const chatContentRef = useRef(null);
  const previousCompactChatRef = useRef(isCompactChat);
  const compactWindowHeight = getCompactChatWindowHeight(
    compactContentHeight,
    composerOverlayOpen,
  );
  
  // chatbodyStatus is for "Memory updating" display - use activeTabId state for immediate reactivity
  const chatbodyStatus = activeTabId ? (chatbodyStatuses[activeTabId] || '') : '';

  const handleQuickReplySelect = useCallback((text, conversationId) => {
    const reply = String(text || '').trim();
    if (!quickReplyEnabled || !reply || !conversationId) return;
    quickReplyRequestIdRef.current += 1;
    setQuickReplyRequest({
      id: quickReplyRequestIdRef.current,
      conversationId,
      text: reply,
    });
  }, [quickReplyEnabled]);

  const handleQuickReplyHandled = useCallback((requestId) => {
    setQuickReplyRequest(current => current?.id === requestId ? null : current);
  }, []);

  const lockTabPresentation = useCallback(() => {
    setEmptyChatPresentation(current => nextEmptyChatPresentation(
      current,
      EMPTY_CHAT_PRESENTATION_EVENT.USER_NAVIGATION,
    ));
  }, []);
  
  // 切换侧边栏时调整窗口大小
  const handleToggleSidebar = () => {
    const newState = !sidebarOpen;
    setSidebarOpen(newState);
    tauri.toggleSidebar?.(newState);
  };

  // Track if default assistant has been loaded
  const defaultAssistantLoadedRef = useRef(false);
  
  // Keep a ref to the latest navBarChats for use in event handlers
  const navBarChatsRef = useRef(navBarChats);
  useEffect(() => {
    navBarChatsRef.current = navBarChats;
  }, [navBarChats]);

  // 将 fetchConversations 提取为可重用的函数
  const fetchConversations = useCallback(async () => {
    console.log('[ChatboxBody] fetchConversations called');
    try {
      const data = await tauri.getConversations();
      console.log('[ChatboxBody] getConversations returned:', data?.length);
      if (Array.isArray(data)) {
          // SQL 已过滤空对话，直接使用
          setConversations(data);
          console.log('[ChatboxBody] setConversations with', data.length, 'items');
      } else {
          console.warn("getConversations returned non-array:", data);
          setConversations([]);
      }
      
      // Also fetch orphan conversations (SQL 已过滤空对话)
      const orphans = await tauri.getOrphanConversations();
      if (Array.isArray(orphans)) {
          setOrphanConversations(orphans);
          console.log('[ChatboxBody] setOrphanConversations with', orphans.length, 'items');
      }
    } catch (error) {
      console.error("Error fetching conversations:", error);
      setConversations([]);
      setOrphanConversations([]);
    }
  }, []);

  // 搜索对话（防抖 300ms）
  const handleSearchChange = useCallback((value) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await tauri.searchConversations(value);
        setSearchResults(results);
      } catch (err) {
        console.error('[Search] error:', err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, []);

  // 清除搜索
  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchActive(false);
    setIsSearching(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  // 点击搜索结果
  const handleSearchResultClick = useCallback((result) => {
    const conv = result.conversation;
    // 将搜索关键词存入 dispatch，方便 MessageArea 高亮
    if (result.matchType === 'content' && searchQuery.trim()) {
      dispatch({ type: actionType.SET_SEARCH_HIGHLIGHT, payload: searchQuery.trim() });
    }
    // handleItemClick is declared later; works because callback runs after render
    handleItemClickRef.current?.(conv);
    clearSearch();
  }, [searchQuery, dispatch, clearSearch]);

  // ============ Tab 快捷键设置 ============
  // 检测平台，决定默认修饰键
  const isMacOS = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || 
                  navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
  const MOD_KEY = isMacOS ? 'Cmd' : 'Ctrl';
  
  const [hotkeySettings, setHotkeySettings] = useState({
    newTabHotkey: `${MOD_KEY} + N`,
    closeTabHotkey: `${MOD_KEY} + W`,
    switchTabPrefix: MOD_KEY,
  });

  // ── Projects ──
  // project 标签与聊天标签共用同一个 tabs 数组，靠 tab.kind === 'project' 区分。
  const [projects, setProjects] = useState([]);
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [historyByProject, setHistoryByProject] = useState({});
  const [resumeRequest, setResumeRequest] = useState(null);
  // 当前 project 标签的 git 状态。侧边栏底部和文件树装饰共用这一份 ——
  // 拉两次就会出现「状态栏说 3 处改动、文件树标了 4 个」的错位。
  const [gitStatus, setGitStatus] = useState(null);
  // 会话活动时间戳记在 ref 里（PTY 输出频率很高，进 state 会疯狂重渲染），
  // 由一个低频 tick 折算成「正在跑的会话集合」再驱动侧边栏指示器。
  const sessionActivityRef = useRef({});
  const [runningSessions, setRunningSessions] = useState(() => new Set());

  const reloadHistory = useCallback(async (projectIds) => {
    const ids = projectIds || [];
    if (ids.length === 0) return;
    const entries = await Promise.all(ids.map(async (id) => {
      try {
        return [id, await tauri.projectsSessionHistory(id, 30)];
      } catch {
        // 项目目录被移走、CLI 换了存储布局等情况不该阻塞侧边栏
        return [id, { bound: [], agentSessions: [] }];
      }
    }));
    setHistoryByProject((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
  }, []);

  const reloadProjects = useCallback(async () => {
    try {
      const list = await tauri.projectsList();
      const rows = Array.isArray(list) ? list : [];
      setProjects(rows);
      void reloadHistory(rows.map((p) => p.id));
    } catch (error) {
      console.error('[ChatboxBody] Failed to load projects:', error);
    }
  }, [reloadHistory]);

  const reloadSessions = useCallback(async () => {
    try {
      const list = await tauri.ptyList(null);
      const grouped = {};
      for (const session of Array.isArray(list) ? list : []) {
        if (!grouped[session.projectId]) grouped[session.projectId] = [];
        grouped[session.projectId].push(session);
      }
      setSessionsByProject(grouped);
    } catch (error) {
      console.error('[ChatboxBody] Failed to load PTY sessions:', error);
    }
  }, []);

  useEffect(() => {
    reloadProjects();
    reloadSessions();
  }, [reloadProjects, reloadSessions]);

  // 下面这几个回调必须是稳定引用，不能写成 JSX 里的内联箭头。
  //
  // ProjectView 把它们放进了自己 useCallback / useEffect 的依赖里，每次
  // ChatboxBody 重渲染都换一个新函数的话，那边的「认领轮询」effect 会整个
  // 重建：clearInterval 掉还没到 2 秒的定时器，然后立刻再 attempt() 一次。
  // 于是本该 2 秒一次的 projects_claim_session 变成了跟着重渲染的节奏跑，
  // 而那个命令要扫 CLI 的会话存储，是几百毫秒的磁盘 I/O。
  const handleReloadProjectsAndSessions = useCallback(async () => {
    await reloadProjects();
    await reloadSessions();
  }, [reloadProjects, reloadSessions]);

  const handleProjectSessionsChanged = useCallback((projectId) => {
    void reloadSessions();
    if (projectId) void reloadHistory([projectId]);
  }, [reloadSessions, reloadHistory]);

  const handlePanesChange = useCallback((info) => {
    projectPanesRef.current = info;
  }, []);

  const handleResumeHandled = useCallback(() => setResumeRequest(null), []);

  // 进程退出时让侧边栏的存活点跟着灭掉，否则用户会点进一个死终端
  useEffect(() => {
    const unlisten = tauri.onPtyExit(() => { reloadSessions(); });
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, [reloadSessions]);

  // 输出时间戳只写 ref；每 400ms 折算一次「正在跑」的集合。
  //
  // 关键是集合没变就返回同一个引用让 React bail out —— 早先这里推进的是一个
  // 时间戳 state，于是不管有没有会话在跑，整棵 ChatboxBody（连带 ProjectView、
  // FileTree、终端面板）都被无条件重渲染，每秒两次半。
  useEffect(() => {
    const unlisten = tauri.onPtyOutput((payload) => {
      if (payload?.sessionId) sessionActivityRef.current[payload.sessionId] = Date.now();
    });
    const timer = setInterval(() => {
      setRunningSessions((prev) => {
        const next = runningSessionIds(sessionActivityRef.current);
        return sameIdSet(prev, next) ? prev : next;
      });
    }, 400);
    return () => {
      try { unlisten?.(); } catch { /* ignore */ }
      clearInterval(timer);
    };
  }, []);

  const handleResumeSession = useCallback((project, entry) => {
    handleOpenProjectRef.current?.(project);
    // 侧边栏传来的行用 sessionId 作标识（没有 id 字段）
    setResumeRequest({
      token: `resume:${entry.sessionId ?? entry.agentId}:${Date.now()}`,
      kind: entry.kind,
      agentId: entry.agentId,
      // 带上它，ProjectView 才能找到原来那个 pane 去原地复活，
      // 而不是新开一个
      sessionId: entry.sessionId ?? null,
    });
  }, []);

  // 从列表里删掉一条会话记录。
  // 只删 PetGPT 的索引 —— claude/codex 自己的会话文件一个都不动，
  // 所以这是可逆的：对话数据还在，只是不再列在这里。
  const handleDeleteSession = useCallback(async (project, row) => {
    const ok = await tauri.confirm(
      'Remove this session from the list? The conversation file itself is kept.',
      { title: 'Remove session' },
    ).catch(() => false);
    if (!ok) return;
    await tauri.projectsForgetSession(row.sessionId).catch(() => {});
    await reloadHistory([project.id]);
  }, [reloadHistory]);

  const handleEndSession = useCallback(async (project, session) => {
    const ok = await tauri.confirm(
      'End this session? The agent process will be terminated.',
      { title: 'End session' },
    ).catch(() => false);
    if (!ok) return;
    await tauri.ptyKill(session.id).catch(() => {});
    await tauri.projectsMarkSessionExited(session.id).catch(() => {});
    await reloadSessions();
    await reloadHistory([project.id]);
  }, [reloadSessions, reloadHistory]);

  const handleOpenProject = useCallback((project) => {
    const tabId = `project:${project.id}`;
    setTabs((prev) => {
      const exists = prev.some((tab) => tab.id === tabId);
      const deactivated = prev.map((tab) => ({ ...tab, isActive: false }));
      if (exists) {
        return deactivated.map((tab) => (tab.id === tabId ? { ...tab, isActive: true } : tab));
      }
      return [...deactivated, {
        id: tabId,
        label: project.name,
        kind: 'project',
        projectId: project.id,
        isActive: true,
      }];
    });
    setActiveTabId(tabId);
    activeTabIdRef.current = tabId;
    void reloadSessions();
  }, [reloadSessions]);

  const handleOpenProjectRef = useRef(null);
  handleOpenProjectRef.current = handleOpenProject;

  // 点侧边栏里活着的会话：打开项目标签**并切到它那个 pane**。
  // 以前这里丢掉了 session 参数，所以只是打开标签，落在哪个 pane 上
  // 由兜底逻辑决定 —— 看起来就像点错了。
  const handleFocusSession = useCallback((project, row) => {
    handleOpenProject(project);
    if (!row) return;
    setResumeRequest({
      token: `focus:${row.sessionId ?? row.agentId}:${Date.now()}`,
      focusOnly: true,
      kind: row.kind,
      agentId: row.agentId ?? null,
      sessionId: row.sessionId ?? null,
    });
  }, [handleOpenProject]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  // 空会话的欢迎态：有标签但里面还没有任何内容，且不在紧凑气泡、不在 project 标签。
  // compactChatView === EMPTY 已经涵盖「无消息 + 未思考 + 无流式输出」三个条件。
  const showEmptyGreeting = !isCompactChat
    && tabs.length > 0
    && compactChatView === COMPACT_CHAT_VIEW.EMPTY;
  const activeProjectTab = activeTab?.kind === 'project' ? activeTab : null;
  const activeProject = activeProjectTab
    ? projects.find((p) => p.id === activeProjectTab.projectId) || null
    : null;

  // ── git 状态轮询 ──
  //
  // 只在 project 标签真正处在前台时跑。切回聊天标签就停掉：后台标签的 git
  // 状态没人看，而这条路径每次都要起一个子进程。
  const gitSignatureRef = useRef('');
  // 文件树的刷新按钮推进它，强制插一次轮询
  const [gitRefreshToken, setGitRefreshToken] = useState(0);
  const refreshGitStatus = useCallback(() => setGitRefreshToken((n) => n + 1), []);

  // 换项目（或切走）先清空。留着上一个项目的分支名，会在新项目的第一次
  // 请求回来之前显示一段明确错误的信息。
  //
  // 单独一个 effect：跟下面的轮询合在一起的话，手动刷新也会把状态清空，
  // 界面要空白一下才填回来 —— 而那次刷新多半什么都没变。
  useEffect(() => {
    gitSignatureRef.current = '';
    setGitStatus(null);
  }, [activeProjectTab?.projectId]);

  useEffect(() => {
    const projectId = activeProjectTab?.projectId;
    if (!projectId) return undefined;

    let cancelled = false;
    let inflight = false;

    const tick = async () => {
      // 大仓库冷缓存时一次 status 可能跑几秒。上一次还没回来就跳过这一轮，
      // 否则请求会越堆越多，每个都占着一个 git 进程。
      if (inflight) return;
      inflight = true;
      try {
        const next = await tauri.projectsGitStatus(projectId);
        if (cancelled) return;
        // 绝大多数轮询结果与上一次完全相同。不比一下就 setState 的话，
        // 整棵虚拟滚动的文件树会跟着每 4 秒空转重建一次。
        const signature = gitStatusSignature(next);
        if (signature !== gitSignatureRef.current) {
          gitSignatureRef.current = signature;
          setGitStatus(next);
        }
      } catch (error) {
        // 项目目录被移走或删掉是常事，不值得打断界面
        if (!cancelled) console.warn('[ChatboxBody] git status failed:', error);
      } finally {
        inflight = false;
      }
    };

    void tick();
    const timer = setInterval(tick, GIT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeProjectTab?.projectId, gitRefreshToken]);

  // gitStatus 的引用只在内容真变化时才更新（见上面的签名比较），
  // 所以这里的缓存能一直命中，FileTree 的 memo 也就拦得住。
  const gitDecorations = useMemo(
    () => buildGitDecorations(gitStatus?.files),
    [gitStatus],
  );
  // 已删除的文件不在磁盘上，装饰救不了它们 —— 得作为额外的行补进树里
  const deletedByDir = useMemo(
    () => buildDeletedIndex(gitStatus?.files),
    [gitStatus],
  );

  // 助手下拉开着的时候切到 project 标签，它会连同整块一起被卸载，但 state
  // 留在 true —— 再切回聊天标签时菜单就自己弹开了。
  const inProjectTab = Boolean(activeProjectTab);
  useEffect(() => {
    if (inProjectTab) setShowAssistantDropdown(false);
  }, [inProjectTab]);

  // ── 更新检查 ──
  // 放在 chat 窗口而不是 character 窗口：提示条就在这里，不需要跨窗口传状态。
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateSettings, setUpdateSettings] = useState({});
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState('');

  useEffect(() => {
    let cancelled = false;

    const runUpdateCheck = async () => {
      try {
        const settings = await tauri.getSettings();
        if (cancelled) return;
        setUpdateSettings(settings || {});
        if (!shouldCheckForUpdate({ settings })) return;

        const info = await tauri.checkForUpdate();
        if (cancelled || !info) return;
        setUpdateInfo(info);
        // 记下检查时间并把结果告诉其它窗口（Management 的侧栏角标读这个）
        await tauri.updateSettings(updateSettingsPatchFor(info));
        if (!cancelled) {
          setUpdateSettings((prev) => ({ ...prev, ...updateSettingsPatchFor(info) }));
        }
      } catch (error) {
        // 网络不通、限流、GitHub 抖动都不该打扰用户，静默即可。
        console.warn('[ChatboxBody] Update check skipped:', error);
      }
    };

    const timer = setTimeout(runUpdateCheck, UPDATE_CHECK_STARTUP_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const handleSkipUpdateVersion = useCallback(async () => {
    const version = updateInfo?.latestVersion;
    setDismissedUpdateVersion(version || '');
    if (!version) return;
    try {
      await tauri.updateSettings({ skippedVersion: version });
      setUpdateSettings((prev) => ({ ...prev, skippedVersion: version }));
    } catch (error) {
      console.error('[ChatboxBody] Failed to persist skipped version:', error);
    }
  }, [updateInfo]);

  const showUpdateBanner = shouldShowUpdateBanner({
    info: updateInfo,
    settings: updateSettings,
    dismissedVersion: dismissedUpdateVersion,
  });

  // 加载聊天相关设置
  useEffect(() => {
    const loadChatSettings = async () => {
      try {
        const settings = await tauri.getSettings();
        setHotkeySettings({
          newTabHotkey: settings.newTabHotkey || `${MOD_KEY} + N`,
          closeTabHotkey: settings.closeTabHotkey || `${MOD_KEY} + W`,
          switchTabPrefix: settings.switchTabPrefix || MOD_KEY,
        });
        const enabled = settings.quickReplyEnabled !== false && settings.quickReplyEnabled !== 'false';
        setQuickReplyEnabled(enabled);
        setMarkdownTypography(normalizeMarkdownTypography(settings));
        if (!enabled) {
          setQuickReplyRequest(null);
          dispatch({ type: actionType.CLEAR_SUGGEST_TEXTS });
        }
      } catch (error) {
        console.error('[ChatboxBody] Error loading chat settings:', error);
      }
    };
    loadChatSettings();

    // 监听设置更新
    const cleanup = tauri.onSettingsUpdated?.((payload) => {
      if (
        payload?.key === 'quickReplyEnabled'
        || payload?.key?.includes('Hotkey')
        || payload?.key?.includes('switchTab')
        || payload?.key?.startsWith('markdown')
      ) {
        loadChatSettings();
      }
    });
    return () => { if (cleanup) cleanup(); };
  }, [dispatch, MOD_KEY]);

  // 初始加载
  useEffect(() => {
    fetchConversations();
    // 加载所有 assistants
    tauri.getAssistants().then(assistants => {
      setAllAssistants(assistants || []);
    }).catch(console.error);
  }, [fetchConversations]);

  // 修复：当 conversations 列表从 DB 刷新后，同步仍为 "New Chat" 的 tab 标签
  // 防止 updatedConversation 被后续 dispatch 覆盖导致标题丢失
  useEffect(() => {
    if (conversations.length === 0) return;
    setTabs(prevTabs => {
      let changed = false;
      const newTabs = prevTabs.map(tab => {
        if (tab.label === 'New Chat') {
          const conv = conversations.find(c => c._id === tab.id);
          if (conv && conv.title && conv.title !== 'New Chat') {
            changed = true;
            return { ...tab, label: conv.title };
          }
        }
        return tab;
      });
      return changed ? newTabs : prevTabs;
    });
  }, [conversations]);

  // 监听 Rust 端发送的鼠标悬停事件
  useEffect(() => {
    let unlisten;
    listen('mouse-over-chat', (event) => {
      setIsMouseOver(event.payload);
    }).then(fn => { unlisten = fn; });
    
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Listen for platform-info from Rust backend (capabilities like vibrancy, cursor tracking)
  useEffect(() => {
    let unlisten;
    listen('platform-info', (event) => {
      setPlatformInfo(event.payload);
    }).then(fn => { unlisten = fn; });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 标题栏显示/隐藏逻辑：淡入淡出都用延迟
  useEffect(() => {
    // 全 UI 模式下大标签常驻：这种尺寸下窗口是当作工作区在用的，
    // 标签跟着鼠标进出淡入淡出会让人找不到它。
    const shouldShow = isFullUiWidth || sidebarOpen || isMouseOver;
    
    if (shouldShow) {
      // 立即挂载组件（opacity: 0）
      setShowTitleBar(true);
      // 下一帧设置 opacity 为 1（触发淡入动画）
      const timer = setTimeout(() => {
        setIsTitleBarVisible(true);
      }, 10); // 小延迟确保组件已挂载
      return () => clearTimeout(timer);
    } else {
      // 先设置 opacity 为 0（触发淡出动画）
      setIsTitleBarVisible(false);
      // 延迟后卸载组件
      const timer = setTimeout(() => {
        setShowTitleBar(false);
      }, 200); // 与 CSS transition 时间一致
      return () => clearTimeout(timer);
    }
  }, [isFullUiWidth, sidebarOpen, isMouseOver]);

  // 监听后台更新的会话消息（处理非激活 Tab 的更新）
  useEffect(() => {
    if (updatedConversation) {
        // 新方案: 使用 Rust TabState 更新
        tauri.setTabStateMessages(updatedConversation.id, updatedConversation.messages);
        // 同时更新 tab label
        setTabs(prevTabs => prevTabs.map(tab => {
            if (tab.id === updatedConversation.id) {
                return { 
                    ...tab, 
                    label: updatedConversation.title ? updatedConversation.title : tab.label 
                };
            }
            return tab;
        }));
        // 刷新对话列表以显示更新
        fetchConversations();
    }
  }, [updatedConversation, fetchConversations]);

  useEffect(() => {
    // This handler is for "Memory updating" status, NOT mood
    const chatbodyStatusHandler = (status, conversationId) => {
      const targetId = conversationId || activeTabIdRef.current;
      if (targetId) {
        setChatbodyStatuses(prev => ({
          ...prev,
          [targetId]: status
        }));
      }
    };
    const cleanup = tauri.onChatbodyStatusUpdated?.(chatbodyStatusHandler);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  useEffect(() => {
    if (chatbodyStatus) {
      setIsThinking(true);
    } else {
      setIsThinking(false);
    }
  }, [chatbodyStatus]);

  const handleCompactHeightChange = useCallback((height) => {
    if (!Number.isFinite(height) || height <= 0) return;
    setCompactContentHeight(previous => (
      Math.abs(previous - height) <= 1 ? previous : height
    ));
  }, []);

  const handleComposerOverlayOpenChange = useCallback((open) => {
    setComposerOverlayOpen(Boolean(open));
  }, []);

  // Once a visible session starts showing conversational activity, keep that
  // session in the regular tab layout. This prevents a transient empty frame
  // between streaming and persisted history from shrinking the window again.
  useEffect(() => {
    if (!windowVisible || compactChatView !== COMPACT_CHAT_VIEW.POPULATED) return;
    setEmptyChatPresentation(current => nextEmptyChatPresentation(
      current,
      EMPTY_CHAT_PRESENTATION_EVENT.CONTENT_ACTIVE,
    ));
  }, [compactChatView, windowVisible]);

  // Keep the native window geometry synchronized even while it is hidden, so
  // the next summon appears directly in the correct mode without a resize jump.
  useEffect(() => {
    const height = isCompactChat ? compactWindowHeight : 0;
    const requestKey = `${isCompactChat ? 'compact' : 'full'}:${height}`;
    if (compactModeRequestRef.current === requestKey) return;
    compactModeRequestRef.current = requestKey;
    const requestId = ++compactModeGenerationRef.current;

    let disposed = false;
    let retryTimer = null;
    const syncMode = async (attempt = 0) => {
      try {
        await tauri.setChatCompactMode(isCompactChat, height, requestId);
      } catch (error) {
        if (disposed || compactModeRequestRef.current !== requestKey) return;
        console.error('[ChatboxBody] Failed to update compact chat mode:', error);
        if (attempt < 2) {
          retryTimer = setTimeout(() => syncMode(attempt + 1), 150 * (attempt + 1));
        } else {
          compactModeRequestRef.current = '';
        }
      }
    };
    syncMode();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [compactWindowHeight, isCompactChat]);

  // Native macOS animates the actual window frame. This matching content
  // transition hides the compact-to-full reflow and gives other platforms a
  // graceful visual fallback when their window manager resizes immediately.
  useLayoutEffect(() => {
    const wasCompact = previousCompactChatRef.current;
    previousCompactChatRef.current = isCompactChat;
    const shell = chatShellRef.current;
    const content = chatContentRef.current;
    if (!wasCompact || isCompactChat || !windowVisible || !shell || !content) return undefined;
    if (typeof shell.animate !== 'function' || typeof content.animate !== 'function') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;

    const shellAnimation = shell.animate(
      [
        { borderRadius: '24px' },
        { borderRadius: '16px' },
      ],
      {
        duration: 240,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'none',
      },
    );
    const contentAnimation = content.animate(
      [
        { opacity: 0.72, transform: 'translate3d(0, 5px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ],
      {
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'none',
      },
    );
    return () => {
      shellAnimation.cancel();
      contentAnimation.cancel();
    };
  }, [isCompactChat, windowVisible]);

  useEffect(() => {
    if (!isCompactChat || !sidebarOpen) return;
    setSidebarOpen(false);
    tauri.toggleSidebar?.(false);
  }, [isCompactChat, sidebarOpen]);

  // ============ 监听唤出意图 ============
  // 后端区分两个入口：点角色/点图标给完整对话框，全局快捷键给快捷提问气泡。
  // 这个事件在窗口显示之后到达，所以它会盖掉 WINDOW_HIDDEN 留下的 COMPACT。
  useEffect(() => {
    const unlisten = tauri.onChatOpenIntent?.((payload) => {
      const intent = payload?.intent;
      if (intent !== 'chat' && intent !== 'quick') return;
      setEmptyChatPresentation(current => nextEmptyChatPresentation(
        current,
        intent === 'quick'
          ? EMPTY_CHAT_PRESENTATION_EVENT.QUICK_ASK_SUMMON
          : EMPTY_CHAT_PRESENTATION_EVENT.CHAT_SUMMON,
      ));
    });
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);

  // ============ 监听窗口可见性变化 ============
  useEffect(() => {
    const handleVisibilityChange = (payload) => {
      if (payload && typeof payload.visible === 'boolean') {
        setWindowVisible(payload.visible);
        if (!payload.visible) {
          setEmptyChatPresentation(current => nextEmptyChatPresentation(
            current,
            EMPTY_CHAT_PRESENTATION_EVENT.WINDOW_HIDDEN,
          ));
        }
        console.log('[ChatboxBody] Window visibility changed:', payload.visible);
      }
    };

    let cleanup;
    if (tauri.onChatWindowVisibilityChanged) {
      cleanup = tauri.onChatWindowVisibilityChanged(handleVisibilityChange);
    }
    
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // Visibility alone cannot retrigger focus when a visible window is summoned
  // again. Native activation carries a monotonic request id for that purpose.
  useEffect(() => {
    const cleanup = tauri.onChatWindowActivated?.((payload) => {
      if (!focusRequestGateRef.current.accept(payload)) return;
      setWindowVisible(true);
      setFocusRequest({
        id: payload.focusRequestId,
        requestedAt: performance.now(),
      });
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // Handle New Tab from Character ID (moved from ChatboxTabBar)
  // This also handles auto-loading the default assistant on first mount
  // 追踪正在处理的 character-id，防止重复处理
  const processingCharacterIdsRef = useRef(new Set());
  // 标志位：是否正在切换 assistant（防止 character-id 事件创建新对话）
  const switchingAssistantRef = useRef(false);

  useEffect(() => {
    let unlisten = null;
    let isMounted = true;

    const handleCharacterId = async (id, { preserveCompactIntent = false } = {}) => {
      if (!isMounted) return;

      // 如果是切换 assistant 触发的，跳过创建新对话（只用于更新 character 窗口皮肤）
      // 不在此处重置 flag，由 dropdown click handler 的 setTimeout 负责重置
      if (switchingAssistantRef.current) {
        return;
      }

      // 防止重复处理同一个 id
      if (processingCharacterIdsRef.current.has(id)) {
        return;
      }
      processingCharacterIdsRef.current.add(id);

      try {
        // 只有当 id 不在 navBarChats 中时才添加
        if (!navBarChatsRef.current?.includes(id)) {
          dispatch({
            type: actionType.SET_NAVBAR_CHAT,
            navBarChats: [...(navBarChatsRef.current || []), id],
          });
        }

        // 优先尝试新的 Assistant API，失败则回退到旧的 Pet API
        let pet = null;
        try {
          pet = await tauri.getAssistant(id);
        } catch (e) {
          // 回退到旧 API
        }
        if (!pet) {
          try {
            pet = await tauri.getPet(id);
          } catch (e) {
            console.error('[ChatboxBody] getPet failed:', e);
          }
        }
        if (!pet) {
          console.error("[ChatboxBody] Could not find assistant or pet with id:", id);
          return;
        }

        let newConversation;
        try {
          newConversation = await tauri.createConversation({
            petId: pet._id,
            title: "New Chat",
            history: [],
          });
        } catch (e) {
          console.error('[ChatboxBody] Failed to create conversation:', e);
          return;
        }

        // sendConversationId 由 handleTabClick 统一发送，这里不再重复

        const newTab = {
            id: newConversation._id,
            label: "New Chat",
            petId: pet._id,
            messages: [],
            isActive: true
        };

        // 新方案: 初始化 Rust TabState
        try {
          await tauri.initTabMessages(newConversation._id, []);
        } catch (e) {
          console.error('[ChatboxBody] initTabMessages failed:', e);
        }

        // Initialize mood and suggestText for new conversation
        dispatch({
            type: actionType.SET_CHARACTER_MOOD,
            characterMood: '',
            conversationId: newConversation._id
        });
        dispatch({
            type: actionType.SET_SUGGEST_TEXT,
            suggestText: [],
            conversationId: newConversation._id
        });

        if (!isMounted) return;

        setTabs(prev => {
            if (prev.some(t => t.id === newTab.id)) {
              return prev;
            }
            return [...prev.map(t => ({...t, isActive: false})), newTab];
        });

        handleTabClick(newConversation._id, {
          skipFetch: true,
          preserveEmptyPresentation: preserveCompactIntent,
        });

        // 刷新对话列表以显示新创建的对话（fire-and-forget，不阻塞 UI）
        fetchConversations();
      } finally {
        // 处理完成后移除标志
        processingCharacterIdsRef.current.delete(id);
      }
    };

    // 直接使用 Tauri listen API
    const setup = async () => {
      unlisten = await listen('character-id', (event) => {
        handleCharacterId(event.payload);
      });
      
      // 检查是否有待处理的 character-id (在 listener ready 之前发送的)
      try {
        const pendingId = await tauri.getPendingCharacterId();
        console.log('[ChatboxBody] ★★★ Checking pending character-id:', pendingId);
        if (pendingId && isMounted) {
          console.log('[ChatboxBody] ★★★ Found pending character-id, processing:', pendingId);
          handleCharacterId(pendingId);
          return; // 已经处理了待处理的 ID，不需要加载默认助手
        }
      } catch (error) {
        console.error('[ChatboxBody] Error checking pending character-id:', error);
      }
      
      // Auto-load default assistant after listener is ready
      // Only run once on first mount when no tabs exist
      // 使用 closure 变量而不是 ref，避免 StrictMode 重复渲染问题
      if (!isMounted) {
        console.log('[ChatboxBody] Component not mounted before default assistant load, skipping');
        return;
      }
      
      // 使用 ref 防止重复加载（即使在 StrictMode 下）
      if (defaultAssistantLoadedRef.current) {
        console.log('[ChatboxBody] Default assistant already loaded, skipping');
        return;
      }
      defaultAssistantLoadedRef.current = true;
      
      // Skip if tabs already exist
      // Note: tabs.length check here captures initial value, which should be 0
      try {
        const settings = await tauri.getSettings();
        console.log('[ChatboxBody] Settings loaded for default assistant:', settings?.defaultRoleId);
        let defaultAssistantId = settings?.defaultRoleId;
        
        // If no default assistant is set, use the first available assistant
        if (!defaultAssistantId) {
          const assistants = await tauri.getAssistants();
          if (assistants && assistants.length > 0) {
            defaultAssistantId = assistants[0]._id;
            console.log('[ChatboxBody] No default assistant set, using first available:', defaultAssistantId);
          }
        }
        
        if (defaultAssistantId && isMounted) {
          console.log('[ChatboxBody] Auto-loading default assistant:', defaultAssistantId);
          // 直接调用 handler，而不是通过事件系统
          handleCharacterId(defaultAssistantId, { preserveCompactIntent: true });
        }
      } catch (error) {
        console.error('[ChatboxBody] Error loading default assistant:', error);
      }
    };
    
    setup();
    
    return () => {
      isMounted = false;
      // 在 StrictMode 下，组件卸载时重置 ref，允许重新挂载时重新加载
      defaultAssistantLoadedRef.current = false;
      if (unlisten) {
        console.log('[ChatboxBody] Cleaning up character-id listener');
        unlisten();
      }
    };
  }, []); // Run only once on mount

  const fetchConversationById = async (conversationId) => {
    try {
      return await tauri.getConversationWithHistory(conversationId);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      throw error;
    }
  };

  const handleTabClick = async (
    clickedId,
    { skipFetch = false, preserveEmptyPresentation = false } = {},
  ) => {
    if (!preserveEmptyPresentation) lockTabPresentation();
    conversationSelectionGenerationRef.current += 1;

    // project 标签没有会话可拉。走下面的聊天路径会让它去 fetch 一个
    // id 为 `project:<uuid>` 的对话，必然失败。
    const clickedTab = tabs.find((tab) => tab.id === clickedId);
    if (clickedTab?.kind === 'project') {
      setActiveTabId(clickedId);
      activeTabIdRef.current = clickedId;
      setTabs((prev) => prev.map((tab) => ({ ...tab, isActive: tab.id === clickedId })));
      return;
    }

    // Even if clicking active tab, we might want to ensure sync? 
    // Repair the shared context even when the visual tab is already active.
    if (activeTabId === clickedId) {
      activeTabIdRef.current = clickedId;
      dispatch({
        type: actionType.SET_CURRENT_CONVERSATION_ID,
        id: clickedId,
      });
      tauri.sendConversationId?.(clickedId);
      return;
    }
    
    setActiveTabId(clickedId);
    activeTabIdRef.current = clickedId;
    
    setTabs(prev => prev.map(t => ({...t, isActive: t.id === clickedId})));

    // Switch every active-conversation consumer before hydration. Keeping the
    // old context alive during the await window can send a focused Enter key to
    // the new tab with the previous Assistant's model and system prompt.
    dispatch({
      type: actionType.SET_CURRENT_CONVERSATION_ID,
      id: clickedId,
    });
    const tabMood = characterMoods[clickedId] || 'normal';
    tauri.sendMoodUpdate?.(tabMood, clickedId);
    tauri.sendConversationId?.(clickedId);

    // skipFetch=true 时跳过 DB 查询（新建的空对话已初始化过 TabState，无需再查）
    if (!skipFetch) {
      // 新方案: 检查 Rust TabState 是否有消息
      const tabState = await tauri.getTabState(clickedId);
      let messages = tabState.messages || [];

      // If messages empty, fetch from backend and initialize Rust TabState
      if (messages.length === 0) {
           try {
              const conversation = await fetchConversationById(clickedId);
              messages = conversation.history || [];
              // 新方案: 初始化 Rust TabState
              await tauri.initTabMessages(clickedId, messages);
           } catch (e) {
               console.error(e);
           }
      }
    }

  };

  const handleCloseTab = (e, closedId) => {
    conversationSelectionGenerationRef.current += 1;
    e.stopPropagation();

    // 关掉 project 标签只收起 UI，会话留在后台继续跑 —— 侧边栏的运动
    // 指示器会显示它们还在，用会话项上的「结束会话」才真正终止进程。
    
    let nextActiveId = activeTabId;
    
    setTabs((prevTabs) => {
      const closedTab = prevTabs.find((tab) => tab.id === closedId);
      const newTabs = prevTabs.filter((tab) => tab.id !== closedId);
      
      if (closedTab?.id === activeTabId && newTabs.length > 0) {
        nextActiveId = newTabs[0].id;
        newTabs[0].isActive = true;
      } else if (newTabs.length === 0) {
        nextActiveId = null;
      }
      return newTabs;
    });

    if (nextActiveId && nextActiveId !== activeTabId) {
        setTimeout(() => handleTabClick(nextActiveId), 0);
    } else if (!nextActiveId) {
        setActiveTabId(null);
        activeTabIdRef.current = null;
        // 方案 B: 不再需要清空全局消息
        dispatch({ type: actionType.SET_CURRENT_CONVERSATION_ID, id: null });
    }
  };

  const handleCloseAllTabs = () => {
    conversationSelectionGenerationRef.current += 1;
    setTabs([]);
    setActiveTabId(null);
    activeTabIdRef.current = null;
    dispatch({ type: actionType.SET_CURRENT_CONVERSATION_ID, id: null });
  };

  // 处理标签页拖拽排序
  const handleReorderTabs = (newOrder) => {
    setTabs(newOrder);
  };

  const handleAddTabClick = () => {
    handleNewChat();
  };

  const handleItemClick = async (conv) => {
    const existingTab = tabs.find(t => t.id === conv._id);
    if (existingTab) {
        handleTabClick(conv._id);
        return;
    }

    const selectionGeneration = ++conversationSelectionGenerationRef.current;
    const conversation = await fetchConversationById(conv._id);
    if (selectionGeneration !== conversationSelectionGenerationRef.current) return;
    const newTab = {
        id: conv._id,
        label: conv.title || "Chat",
        petId: conv.petId,
        messages: conversation.history,
        isActive: true
    };
    
    setTabs(prev => [...prev.map(t => ({...t, isActive: false})), newTab]);
    // Commit visual and shared selection together. Hydration is background-only
    // and can no longer overwrite a newer click when it completes.
    handleTabClick(conv._id, { skipFetch: true });

    void tauri.initTabMessages(conv._id, conversation.history).catch(error => {
      console.error('[ChatboxBody] Failed to initialize conversation history:', error);
    });
    
    // Initialize mood and suggestText for new tab
    dispatch({
        type: actionType.SET_CHARACTER_MOOD,
        characterMood: '', // Reset to empty
        conversationId: conv._id
    });
    dispatch({
        type: actionType.SET_SUGGEST_TEXT,
        suggestText: [], // Reset to empty
        conversationId: conv._id
    });

  };

  // Ref for search result click to avoid circular dependency
  const handleItemClickRef = useRef(handleItemClick);
  useEffect(() => { handleItemClickRef.current = handleItemClick; });

  // 从某条消息处创建分支（复制该消息及之前的所有消息到新对话）
  const handleBranchFromMessage = useCallback(async (sourceConvId, messageIndex) => {
    try {
      // 1. 获取源对话的 tab
      const sourceTab = tabs.find(t => t.id === sourceConvId);
      if (!sourceTab) {
        console.error('[Branch] Source tab not found:', sourceConvId);
        return;
      }

      // 2. 获取源对话的消息（从 TabState）
      const tabState = await tauri.getTabState(sourceConvId);
      const sourceMessages = tabState?.messages || [];
      if (!sourceMessages || sourceMessages.length === 0) {
        console.error('[Branch] No messages to branch from');
        return;
      }

      // 3. 复制从开始到 messageIndex 的所有消息
      const messagesToCopy = sourceMessages.slice(0, messageIndex + 1);
      
      // 4. 获取源对话标题
      let sourceTitle = "Chat";
      try {
        const sourceConv = await tauri.getConversationById(sourceConvId);
        if (sourceConv?.title) {
          sourceTitle = sourceConv.title;
        }
      } catch (e) {
        // 使用默认标题
      }

      // 5. 创建新对话
      const newConversation = await tauri.createConversation({
        petId: sourceTab.petId,
        title: `${sourceTitle} (Branch)`,
        history: messagesToCopy,
      });

      console.log('[Branch] Created new conversation:', newConversation._id);

      // 5.5 保存消息到数据库（这样 messageCount 才会正确）
      await tauri.updateConversation(newConversation._id, { history: messagesToCopy });

      // 6. 初始化新对话的 TabState
      await tauri.initTabMessages(newConversation._id, messagesToCopy);

      // 7. 创建新 Tab
      const newTab = {
        id: newConversation._id,
        label: `${sourceTitle} (Branch)`,
        petId: sourceTab.petId,
        messages: messagesToCopy,
        isActive: true
      };

      // 8. 添加 Tab 并切换
      setTabs(prev => [...prev.map(t => ({ ...t, isActive: false })), newTab]);
      handleTabClick(newConversation._id, { skipFetch: true });
      
      // 9. 刷新对话列表（fire-and-forget，不阻塞 UI）
      fetchConversations();
    } catch (error) {
      console.error('[Branch] Failed to create branch:', error);
    }
  }, [tabs, handleTabClick, fetchConversations]);

  const handleNewChat = () => {
    // New means "open an empty tab in this full chat session", not "summon
    // the desktop composer". Set this synchronously before the character-id
    // round trip creates and hydrates the conversation.
    lockTabPresentation();
    // 不能直接读当前标签的 petId：project 标签没有这个字段，
    // sendCharacterId(undefined) 不会有任何反应（按钮看着就是坏的）。
    const petId = pickPetIdForNewChat(tabs, activeTabId);
    if (petId) {
        tauri.sendCharacterId?.(petId);
    } else {
        // 一个聊天标签都没有（比如只开着 project 标签）：让用户先选助手
        tauri.changeSelectCharacterWindow?.();
    }
  };

  const handleShare = async () => {
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (!activeTab || !activeTab.messages || activeTab.messages.length === 0) {
      alert("No conversation to share.");
      return;
    }

    // 获取角色信息用于显示名称
    let petName = "Assistant";
    try {
      let pet = await tauri.getAssistant(activeTab.petId);
      if (!pet) {
        pet = await tauri.getPet(activeTab.petId);
      }
      if (pet && pet.name) {
        petName = pet.name;
      }
    } catch (e) {
      // 使用默认名称
    }

    const conversationText = activeTab.messages
      .map(msg => {
        if (msg.role === "assistant") {
          return `${petName}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`;
        } else if (msg.role === "user") {
          return `You: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`;
        }
        return `${msg.role}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`;
      })
      .join('\n\n');

    navigator.clipboard.writeText(conversationText)
      .then(() => {
        alert("Conversation copied to clipboard!");
      })
      .catch((err) => {
        console.error("Failed to copy conversation: ", err);
        alert("Failed to copy conversation.");
      });
  };

  const handleDelete = async (e, conversationId) => {
    e.stopPropagation();
    const confirmDelete = await tauri.confirm("Are you sure you want to delete this conversation?", {
      title: 'Delete Conversation'
    });
    if (!confirmDelete) return;

    try {
      await tauri.deleteConversation(conversationId);
      setConversations((prevConvs) => prevConvs.filter((conv) => conv._id !== conversationId));
      setOrphanConversations((prevConvs) => prevConvs.filter((conv) => conv._id !== conversationId));
      
      // Also close tab if open
      if (tabs.some(t => t.id === conversationId)) {
          handleCloseTab(e, conversationId);
      }

    } catch (error) {
      console.error("Error deleting conversation:", error);
      alert("Failed to delete conversation.");
    }
  };

  // Handle orphan conversation click - show transfer modal
  const handleOrphanClick = async (conv) => {
    setSelectedOrphanConv(conv);
    try {
      const assistants = await tauri.getAssistants();
      setAvailableAssistants(assistants || []);
      setShowTransferModal(true);
    } catch (error) {
      console.error("Error fetching assistants:", error);
      alert("Failed to load assistants.");
    }
  };

  // Handle transfer conversation to new assistant
  const handleTransfer = async (newPetId) => {
    if (!selectedOrphanConv || !newPetId) return;
    
    try {
      await tauri.transferConversation(selectedOrphanConv._id, newPetId);
      // Refresh conversations
      const data = await tauri.getConversations();
      if (Array.isArray(data)) {
        const nonEmptyConversations = data.filter(conv => conv.messageCount > 0);
        setConversations(nonEmptyConversations);
      }
      // Remove from orphans
      setOrphanConversations(prev => prev.filter(c => c._id !== selectedOrphanConv._id));
      setShowTransferModal(false);
      setSelectedOrphanConv(null);
      
      // Optionally open the transferred conversation
      const transferredConv = { ...selectedOrphanConv, petId: newPetId };
      handleItemClick(transferredConv);
    } catch (error) {
      console.error("Error transferring conversation:", error);
      alert("Failed to transfer conversation.");
    }
  };

  const handleClose = () => {
    tauri.hideChatWindow?.();
  };
  const handleMax = () => {
    tauri.maxmizeChatWindow?.();
  };

  // ============ Tab 快捷键监听 ============
  // 使用 ref 存储函数引用，避免 useEffect 依赖问题
  const handleNewChatRef = useRef(handleNewChat);
  const handleTabClickRef = useRef(handleTabClick);
  const handleCloseTabRef = useRef(handleCloseTab);
  
  useEffect(() => {
    handleNewChatRef.current = handleNewChat;
    handleTabClickRef.current = handleTabClick;
    handleCloseTabRef.current = handleCloseTab;
  });

  // 辅助函数：解析快捷键字符串
  const parseHotkey = useCallback((hotkeyStr) => {
    if (!hotkeyStr) return null;
    // 处理不同格式：'Ctrl+N', 'Ctrl + N', 'Meta + N' 等
    // 先移除所有空格，再按 + 分割
    const normalized = hotkeyStr.replace(/\s+/g, '').toLowerCase();
    const parts = normalized.split('+');
    return {
      ctrl: parts.includes('ctrl') || parts.includes('control'),
      meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('command'),
      alt: parts.includes('alt') || parts.includes('option'),
      shift: parts.includes('shift'),
      key: parts.filter(p => !['ctrl', 'control', 'meta', 'cmd', 'command', 'alt', 'option', 'shift'].includes(p))[0] || ''
    };
  }, []);

  // 辅助函数：检查按键事件是否匹配快捷键
  const matchesHotkey = useCallback((e, hotkey) => {
    if (!hotkey) return false;
    
    // 处理 Ctrl/Meta 修饰键
    // - 如果设置了 ctrl 或 meta，检查是否按下了对应的键
    // - Ctrl 和 Cmd(Meta) 互相兼容（跨平台支持）
    let ctrlMetaMatch;
    if (hotkey.ctrl || hotkey.meta) {
      // 设置了 Ctrl 或 Meta，要求按下 ctrlKey 或 metaKey
      ctrlMetaMatch = e.ctrlKey || e.metaKey;
    } else {
      // 没有设置修饰键，要求都不按
      ctrlMetaMatch = !e.ctrlKey && !e.metaKey;
    }
    
    const altMatch = hotkey.alt ? e.altKey : !e.altKey;
    const shiftMatch = hotkey.shift ? e.shiftKey : !e.shiftKey;
    
    const keyMatch = e.key.toLowerCase() === hotkey.key.toLowerCase() ||
                     e.key === hotkey.key;
    
    return ctrlMetaMatch && altMatch && shiftMatch && keyMatch;
  }, []);

  // 键盘事件处理
  useEffect(() => {
    const handleKeyDown = (e) => {
      // 忽略单独的修饰键
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) {
        return;
      }
      
      // 解析所有快捷键
      const newTabHotkey = parseHotkey(hotkeySettings.newTabHotkey);
      const closeTabHotkey = parseHotkey(hotkeySettings.closeTabHotkey);
      const switchPrefix = parseHotkey(hotkeySettings.switchTabPrefix);
      
      // 检查新建标签页快捷键
      if (matchesHotkey(e, newTabHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        console.log('[ChatboxBody] New tab hotkey triggered');
        handleNewChatRef.current();
        return;
      }
      
      // 检查关闭标签页快捷键
      if (matchesHotkey(e, closeTabHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        console.log('[ChatboxBody] Close tab hotkey triggered');
        // project 标签里还有小标签时，先关小标签
        const panes = projectPanesRef.current;
        if (panes && panes.closablePaneCount > 0) {
          panes.closeActivePane();
          return;
        }
        if (activeTabIdRef.current) {
          handleCloseTabRef.current({ stopPropagation: () => {} }, activeTabIdRef.current);
        }
        return;
      }
      
      // 检查切换标签页快捷键 (前缀 + 1-9)
      // 检查是否按下了正确的修饰键组合
      if (switchPrefix) {
        const modifiersMatch = 
          ((switchPrefix.ctrl || switchPrefix.meta) ? (e.ctrlKey || e.metaKey) : (!e.ctrlKey && !e.metaKey)) &&
          (switchPrefix.alt ? e.altKey : !e.altKey) &&
          (switchPrefix.shift ? e.shiftKey : !e.shiftKey);
        
        if (modifiersMatch) {
          // 检查是否按下了数字键 1-9
          const num = parseInt(e.key, 10);
          if (num >= 1 && num <= 9) {
            e.preventDefault();
            e.stopPropagation();
            console.log(`[ChatboxBody] Switch to tab ${num} hotkey triggered`);
            setTabs(currentTabs => {
              if (currentTabs.length >= num) {
                handleTabClickRef.current(currentTabs[num - 1].id);
              }
              return currentTabs;
            });
            return;
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hotkeySettings, parseHotkey, matchesHotkey]);

  return (
    <div 
      ref={chatShellRef}
      style={getMarkdownTypographyCssVariables(markdownTypography)}
      className={`h-screen overflow-clip relative ${isCompactChat
        ? 'rounded-[24px] bg-transparent'
        : 'rounded-[16px] bg-white/10 backdrop-blur-2xl'
      }`}
      {...(platformInfo.has_cursor_tracking === 'false' ? {
        onMouseEnter: () => setIsMouseOver(true),
        onMouseLeave: () => setIsMouseOver(false),
      } : {})}
    >
    {/* Keep both layouts translucent; this tint sits above the native material. */}
    <div className={`absolute inset-0 transition-colors duration-200 pointer-events-none ${
      isCompactChat
        ? 'bg-transparent'
        : platformInfo.has_vibrancy === 'false'
        ? 'bg-white/80'
        : sidebarOpen ? 'bg-white/75' : 'bg-white/65'
    }`} />
    <div
      ref={chatContentRef}
      className={`h-full flex group/chatwindow relative ${isCompactChat ? 'overflow-visible' : 'overflow-hidden'}`}
    >
      {/* Sidebar - 小窗口根据 sidebarOpen 状态显示，全屏时始终显示 */}
      <div className={`${isCompactChat ? 'hidden' : `${sidebarOpen ? 'flex' : 'hidden'} lg:!flex`} flex-col w-64 bg-slate-50/60 backdrop-blur-xl border-r border-white/55 h-full shrink-0`}>
        
        {/* Window Controls & Sidebar Toggle */}
        <div className="p-3 pt-4 draggable flex items-center justify-between" data-tauri-drag-region>
            <div className="flex items-center gap-2 no-drag px-2">
                {/* 红色：关闭 */}
                <div onClick={handleClose} className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 cursor-pointer flex items-center justify-center group">
                    <MdClose className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
                </div>
                {/* 黄色：最小化（隐藏窗口） */}
                <div onClick={handleClose} className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 cursor-pointer flex items-center justify-center group">
                    <span className="text-white text-[8px] font-bold opacity-0 group-hover:opacity-100">−</span>
                </div>
                {/* 绿色：最大化/还原 */}
                <div onClick={handleMax} className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 cursor-pointer flex items-center justify-center group">
                    <LuMaximize2 className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
                </div>
            </div>
            
            <div className="flex items-center gap-3 no-drag text-gray-500">
                <BsLayoutSidebar className="cursor-pointer hover:text-gray-800" title="Toggle Sidebar" />
                <MdAdd onClick={handleNewChat} className="text-xl cursor-pointer hover:text-gray-800" title="New Chat" />
            </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2 pt-2">
          {searchActive ? (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-md border border-blue-300 text-xs shadow-sm">
              <MdSearch className="text-sm text-blue-500 flex-shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') clearSearch(); }}
                placeholder="Search conversations..."
                className="flex-1 bg-transparent outline-none text-gray-700 placeholder-gray-400"
                autoFocus
              />
              {(searchQuery || isSearching) && (
                <MdClear
                  onClick={clearSearch}
                  className="text-sm text-gray-400 hover:text-gray-600 cursor-pointer flex-shrink-0"
                />
              )}
            </div>
          ) : (
            <div
              onClick={() => { setSearchActive(true); setTimeout(() => searchInputRef.current?.focus(), 50); }}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-200/50 rounded-md text-gray-500 text-xs cursor-pointer hover:bg-gray-200/80 transition-colors"
            >
              <MdSearch className="text-sm" />
              <span>Search</span>
            </div>
          )}
        </div>

        {/* Sessions（对话）— 与 Projects 同级的可折叠区块 */}
        <div className={`flex min-h-0 flex-col ${chatsSectionOpen ? 'flex-1' : 'shrink-0'}`}>
        <div
          onClick={() => setChatsSectionOpen((v) => !v)}
          className="flex h-10 shrink-0 cursor-pointer items-center gap-1 border-t border-gray-200/70 px-2 hover:bg-gray-200/40"
        >
          {chatsSectionOpen
            ? <MdKeyboardArrowDown className="h-4 w-4 shrink-0 text-gray-400" />
            : <MdChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
          <span className="flex-1 text-[13px] font-semibold text-gray-500">
            {t('Sessions')}
          </span>
          <MdAdd
            onClick={(e) => { e.stopPropagation(); handleNewChat(); }}
            title={t('New Chat')}
            className="h-4 w-4 shrink-0 text-gray-400 hover:text-gray-700"
          />
        </div>
        {chatsSectionOpen && (
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {searchActive && searchQuery.trim() ? (
            /* === 搜索结果 === */
            <>
              {isSearching ? (
                <div className="px-3 py-4 text-xs text-gray-400 text-center">Searching...</div>
              ) : searchResults.length === 0 ? (
                <div className="px-3 py-4 text-xs text-gray-400 text-center">No matching results</div>
              ) : (
                <>
                  {/* 标题匹配 */}
                  {searchResults.filter(r => r.matchType === 'title').length > 0 && (
                    <>
                      <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                        Title match
                      </div>
                      {searchResults.filter(r => r.matchType === 'title').map((result) => (
                        <div
                          key={`title-${result.conversation._id}`}
                          onClick={() => handleSearchResultClick(result)}
                          className="group flex flex-col p-2 rounded-lg hover:bg-blue-50 cursor-pointer transition-colors"
                        >
                          <span data-i18n-ignore className="text-sm text-[#0d0d0d] truncate">
                            <HighlightText text={result.conversation.title || t('Untitled')} keyword={searchQuery} />
                          </span>
                          <span data-i18n-ignore className="text-[10px] text-gray-400 mt-0.5">{result.conversation.petName}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {/* 内容匹配 */}
                  {searchResults.filter(r => r.matchType === 'content').length > 0 && (
                    <>
                      <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1 mt-2">
                        Message match
                      </div>
                      {searchResults.filter(r => r.matchType === 'content').map((result) => (
                        <div
                          key={`content-${result.conversation._id}`}
                          onClick={() => handleSearchResultClick(result)}
                          className="group flex flex-col p-2 rounded-lg hover:bg-blue-50 cursor-pointer transition-colors"
                        >
                          <span data-i18n-ignore className="text-sm text-[#0d0d0d] truncate">{result.conversation.title || t('Untitled')}</span>
                          <span data-i18n-ignore className="text-[10px] text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">
                            <HighlightText text={result.snippet || ''} keyword={searchQuery} />
                          </span>
                          <span data-i18n-ignore className="text-[10px] text-gray-400 mt-0.5">{result.conversation.petName}</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            /* === 正常对话列表 === */
            <>
          <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Recent
          </div>
          {conversations.slice(0, displayCount).map((conv) => (
            <div
              key={conv._id}
              onClick={() => handleItemClick(conv)}
              className="group flex items-center justify-between p-2 rounded-lg hover:bg-[#ececec] cursor-pointer transition-colors text-sm text-gray-700"
            >
              <span data-i18n-ignore className="truncate flex-1 pr-2 text-[#0d0d0d]">{conv.title}</span>
              <MdDelete 
                onClick={(e) => handleDelete(e, conv._id)}
                className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity text-lg" 
              />
            </div>
          ))}
          {conversations.length > displayCount && (
            <button
              onClick={() => setDisplayCount(prev => prev + 50)}
              className="w-full py-2 text-xs text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
            >
              Show more ({conversations.length - displayCount} remaining)
            </button>
          )}
          
          {/* Orphan Conversations */}
          {orphanConversations.length > 0 && (
            <>
              <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1 mt-3 flex items-center gap-1">
                <MdWarning className="text-amber-500" />
                <span>Orphaned</span>
              </div>
              {orphanConversations.map((conv) => (
                <div
                  key={conv._id}
                  onClick={() => handleOrphanClick(conv)}
                  className="group flex items-center justify-between p-2 rounded-lg hover:bg-amber-50 cursor-pointer transition-colors text-sm text-gray-500 border-l-2 border-amber-400"
                >
                  <span data-i18n-ignore className="truncate flex-1 pr-2">{conv.title}</span>
                  <MdDelete 
                    onClick={(e) => handleDelete(e, conv._id)}
                    className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity text-lg" 
                  />
                </div>
              ))}
            </>
          )}
          </>
          )}
        </div>
        )}
        </div>

        {/* Projects — 与 Sessions 同级 */}
        <ProjectsSection
          projects={projects}
          onReload={handleReloadProjectsAndSessions}
          onOpenProject={handleOpenProject}
          sessionsByProject={sessionsByProject}
          onFocusSession={handleFocusSession}
          historyByProject={historyByProject}
          runningSessions={runningSessions}
          onResumeSession={handleResumeSession}
          onEndSession={handleEndSession}
          onDeleteSession={handleDeleteSession}
        />

        {/* 侧边栏底部：当前标签的身份。
            project 标签下换成项目/分支/改动数 —— 「选择助手」在那里既没有
            对应的对话可切，点下去还会走 transferConversation 去改一个不存在
            的会话。 */}
        {activeProjectTab ? (
          <ProjectStatusBar project={activeProject} gitStatus={gitStatus} />
        ) : (
        <>
        {/* Quick New Chat - Assistant Dropdown */}
        <div className="p-3 border-t border-gray-200 relative">
            <div 
              onClick={() => setShowAssistantDropdown(!showAssistantDropdown)}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-200 cursor-pointer"
            >
                {(() => {
                  const currentPetId = tabs.find(t => t.id === activeTabId)?.petId;
                  const currentAssistant = allAssistants.find(a => a._id === currentPetId);
                  const name = currentAssistant?.name || t('Select Assistant');
                  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                  return (
                    <>
                      <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        {initials}
                      </div>
                      <div data-i18n-ignore className="flex-1 text-sm font-medium text-gray-700 truncate">{name}</div>
                      <MdKeyboardArrowDown className={`text-gray-500 transition-transform flex-shrink-0 ${showAssistantDropdown ? 'rotate-180' : ''}`} />
                    </>
                  );
                })()}
            </div>
            
            {/* Assistant Dropdown Menu */}
            {showAssistantDropdown && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowAssistantDropdown(false)} />
                <div className="absolute bottom-full left-3 right-3 mb-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 max-h-48 overflow-y-auto">
                  {allAssistants.map(assistant => {
                    const initials = assistant.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                    return (
                      <div
                        key={assistant._id}
                        onClick={async () => {
                          // 如果有活跃的对话，在当前对话中切换 assistant
                          if (activeTabId && activeTabId !== 'temp') {
                            try {
                              await tauri.transferConversation(activeTabId, assistant._id);
                              // 更新标签页的 petId
                              setTabs(prev => prev.map(t =>
                                t.id === activeTabId ? { ...t, petId: assistant._id } : t
                              ));
                              console.log(`[ChatboxBody] Switched conversation ${activeTabId} to assistant ${assistant._id}`);

                              // 重新发送 conversation-id 以确保 ChatboxInputBox 的 conversationIdRef 正确
                              tauri.sendConversationId?.(activeTabId);

                              // 通知 character 窗口切换皮肤
                              switchingAssistantRef.current = true;
                              await tauri.sendCharacterId?.(assistant._id);
                              // 延迟重置 flag，确保所有监听器（含 StrictMode 重复监听器）都已处理
                              setTimeout(() => { switchingAssistantRef.current = false; }, 200);
                            } catch (error) {
                              console.error('[ChatboxBody] Error switching assistant:', error);
                            }
                          } else {
                            // 没有活跃对话时，创建新对话
                            lockTabPresentation();
                            tauri.sendCharacterId?.(assistant._id);
                          }
                          setShowAssistantDropdown(false);
                        }}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-100 cursor-pointer"
                      >
                        <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                          {initials}
                        </div>
                        <span data-i18n-ignore className="text-sm text-gray-700 truncate">{assistant.name}</span>
                      </div>
                    );
                  })}
                  {allAssistants.length === 0 && (
                    <div className="px-3 py-2 text-sm text-gray-400">No assistants available</div>
                  )}
                </div>
              </>
            )}
        </div>
        </>
        )}
      </div>

      {/* Main Chat Area */}
      <div className="h-full min-w-0 flex-1 flex flex-col justify-end relative">
        <div className={`${isCompactChat ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
        {/* Title Bar - 淡入淡出效果 */}
        {showTitleBar && (
          <div className={`flex-shrink-0 transition-opacity duration-200 ${isTitleBarVisible ? 'opacity-100' : 'opacity-0'}`}>
            <ChatboxTitleBar 
                activePetId={tabs.find(t => t.id === activeTabId)?.petId} 
                tabs={tabs} 
                activeTabId={activeTabId} 
                onTabClick={handleTabClick} 
                onCloseTab={handleCloseTab}
                onCloseAllTabs={handleCloseAllTabs}
                onAddTab={handleAddTabClick}
                onReorderTabs={handleReorderTabs}
                onShare={handleShare}
                sidebarOpen={sidebarOpen}
                isMouseOver={isMouseOver}
                onToggleSidebar={handleToggleSidebar}
            />
          </div>
        )}
        {showUpdateBanner && (
          <UpdateBanner
            info={updateInfo}
            onDismiss={() => setDismissedUpdateVersion(updateInfo?.latestVersion || '')}
            onSkipVersion={handleSkipUpdateVersion}
          />
        )}
        {chatbodyStatus != "" && (
          <div className="text-center text-sm text-gray-600 animate-pulse absolute top-10 left-0 right-0 z-10 pointer-events-none">
            Memory updating: {chatbodyStatus}
          </div>
        )}
        
        {/* 消息区域 - 始终从顶部开始，标题栏覆盖在上面 */}
        <div className="flex-1 overflow-hidden relative flex flex-col">
             {tabs.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-3">
                    <span>No active conversations</span>
                    <button 
                        onClick={() => tauri.changeSelectCharacterWindow?.()}
                        className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm"
                    >
                        Select an Assistant
                    </button>
                </div>
             ) : (
                tabs.map(tab => {
                    if (tab.kind === 'project') {
                      const project = projects.find((p) => p.id === tab.projectId)
                        || { id: tab.projectId, name: tab.label };
                      return (
                        <div
                          key={tab.id}
                          style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
                          className="flex-1 flex flex-col h-full min-h-0"
                        >
                          <ProjectView
                            project={project}
                            active={tab.id === activeTabId}
                            onPanesChange={handlePanesChange}
                            onSessionsChanged={handleProjectSessionsChanged}
                            resumeRequest={tab.id === activeTabId ? resumeRequest : null}
                            onResumeHandled={handleResumeHandled}
                            // 只有前台标签在轮询 git，后台标签拿到的会是
                            // 别人的状态 —— 宁可不装饰，也不要标错
                            gitDecorations={tab.id === activeTabId ? gitDecorations : undefined}
                            deletedByDir={tab.id === activeTabId ? deletedByDir : undefined}
                            onRefreshGit={refreshGitStatus}
                          />
                        </div>
                      );
                    }
                    const streamContent = streamingReplies?.[tab.id] ?? null;
                    return (
                    <div 
                        key={tab.id} 
                        style={{ display: tab.id === activeTabId ? 'flex' : 'none' }} 
                        className="flex-1 flex flex-col h-full"
                    >
                        <ChatboxMessageArea 
                            conversationId={tab.id}
                            streamingContent={streamContent} 
                            isActive={tab.id === activeTabId}
                            showTitleBar={showTitleBar}
                            onBranchFromMessage={handleBranchFromMessage}
                            quickReplies={quickReplyEnabled ? (suggestText[tab.id] || []) : []}
                            quickReplyEnabled={quickReplyEnabled}
                            onQuickReplySelect={(text) => handleQuickReplySelect(text, tab.id)}
                        />
                    </div>
                    );
                })
             )}
        </div>
        </div>
        
        {/* 空会话时把标语和输入框一起抬到接近视觉中线的位置，
            而不是让输入框贴在窗口底部。 */}
        <div
          className={`w-full ${activeProjectTab ? 'hidden' : ''} ${
            showEmptyGreeting && !activeProjectTab ? 'mb-[22vh] transition-[margin] duration-200' : ''
          }`}
        >
            {showEmptyGreeting && !activeProjectTab && (
              <div className="px-6 pb-5 text-center">
                <h1
                  data-i18n-ignore
                  className="mx-auto max-w-2xl text-balance text-xl font-medium leading-snug tracking-tight text-gray-800 sm:text-2xl lg:text-[28px]"
                >
                  In this era, you can build anything, if you can pay the token.
                </h1>
              </div>
            )}
            <ChatboxInputArea 
                className="w-full" 
                activePetId={tabs.find(t => t.id === activeTabId)?.petId}
                sidebarOpen={sidebarOpen}
                autoFocus={windowVisible}
                focusRequest={focusRequest}
                compact={isCompactChat}
                activeTabId={activeTabId}
                quickReplyEnabled={quickReplyEnabled}
                quickReplyRequest={quickReplyRequest}
                onQuickReplyHandled={handleQuickReplyHandled}
                onHeightChange={handleCompactHeightChange}
                onOverlayOpenChange={handleComposerOverlayOpenChange}
            />
        </div>
      </div>
      
      {/* Transfer Modal */}
      {showTransferModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-80 max-h-96 flex flex-col">
            <div className="p-4 border-b border-gray-200">
              <h3 className="font-semibold text-gray-800">Transfer Conversation</h3>
              <p className="text-sm text-gray-500 mt-1">
                Select an assistant to take over this conversation
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {availableAssistants.length === 0 ? (
                <div className="text-center text-gray-400 py-4">
                  No assistants available
                </div>
              ) : (
                availableAssistants.map((assistant) => (
                  <div
                    key={assistant._id}
                    onClick={() => handleTransfer(assistant._id)}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-100 cursor-pointer transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm overflow-hidden">
                      {assistant.icon ? (
                        <img src={assistant.icon} alt="" className="w-full h-full object-cover" />
                      ) : (
                        assistant.name?.charAt(0) || '?'
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-gray-800">{assistant.name}</div>
                      <div className="text-xs text-gray-500 truncate">{assistant.model_id}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="p-3 border-t border-gray-200">
              <button
                onClick={() => {
                  setShowTransferModal(false);
                  setSelectedOrphanConv(null);
                }}
                className="w-full py-2 text-gray-600 hover:text-gray-800 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
};

export default Chatbox;
