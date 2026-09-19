import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MdClose,
  MdFolder,
  MdInsertDriveFile,
  MdTerminal,
  MdAutoAwesome,
  MdCode,
} from 'react-icons/md';
import { useI18n } from '../../i18n/context.js';
import * as tauri from '../../utils/tauri';
import {
  FILES_PANEL_WIDTH,
  FILES_PANE_ID,
  buildPaneTabs,
  closePane,
  isFilesPane,
  mergePanes,
  openPreview,
  paneForAgentId,
  paneForSessionId,
  paneKeyFor,
  pinPreview,
  resolveActivePane,
  revivePane,
  shouldDockFilesPanel,
} from '../../utils/projectPanes.js';
import SessionDot from './SessionDot';
import { runningSessionIds, sameIdSet, sessionStateIn } from '../../utils/sessionActivity.js';
import TerminalPane from './TerminalPane';
import FileTree from './FileTree';
import FilePreview from './FilePreview';

const AGENT_KINDS = [
  { kind: 'claude', label: 'Claude', Icon: MdAutoAwesome },
  { kind: 'codex', label: 'Codex', Icon: MdCode },
  { kind: 'shell', label: 'Terminal', Icon: MdTerminal },
];

const kindIcon = (kind) => AGENT_KINDS.find((a) => a.kind === kind)?.Icon || MdFolder;

/**
 * project 大标签的内容：顶部小标签栏 + 会话/预览面板 + Files。
 *
 * 布局随 main area 宽度切换（projectPanes.shouldDockFilesPanel）：
 *   宽 —— Files 常驻右侧，小标签栏只放会话和预览
 *   窄 —— Files 降级成小标签栏里钉在最左的一个页签，只显示当前页签内容
 *
 * 终端面板一律挂载、用 CSS 隐藏，切走再切回来不会丢滚动缓冲、也不会因为
 * 重新 fit() 触发多余的 SIGWINCH。
 */
export default function ProjectView({ project, active, onPanesChange, onSessionsChanged, resumeRequest, onResumeHandled, gitDecorations, deletedByDir, onRefreshGit }) {
  const { t } = useI18n();
  // pane 而不是「会话」：一个 pane 的身份是**对话**，它的 PTY 进程可以换
  // （退出后原地恢复），pane 本身不动。见 projectPanes.paneKeyFor。
  const [panes, setPanes] = useState([]);
  /** sessionId -> 绑定记录，提供对话 id 与标题 */
  const [boundBySessionId, setBoundBySessionId] = useState({});
  const [previews, setPreviews] = useState([]);
  const [requestedPane, setRequestedPane] = useState(null);
  const [rootPath, setRootPath] = useState('');
  // 存布尔值而不是像素宽度：宽度唯一的用途就是算这个阈值，而拖动窗口时
  // 像素每帧都在变，存宽度等于让整个 ProjectView 跟着每帧重渲染一次。
  // 存布尔值的话 React 在值没变时直接 bail out，只有真正跨过阈值那一帧才渲染。
  const [filesDocked, setFilesDocked] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef(null);
  const spawnSeq = useRef(0);
  // 等待认领 agent 会话 id 的窗口。串行处理：同一时刻只让队首去认领，
  // 否则同项目同时开两个同类会话时，两个新文件会分不清归属。
  const [claimTargets, setClaimTargets] = useState([]);
  // PTY 输出可能每秒几十次，时间戳记在 ref 里避免疯狂重渲染；
  // 另起一个低频 tick 把它折算成「正在跑的会话集合」。
  const activityRef = useRef({});
  const [runningSessions, setRunningSessions] = useState(() => new Set());

  // 上报给宿主时带上自己的 projectId，这样宿主那边可以是一个稳定的回调 ——
  // 宿主原先为了闭包捕获 project.id 写成了内联箭头，而这个函数在下面几个
  // useCallback / useEffect 的依赖里，每次换引用都会重建认领轮询。
  const notifySessionsChanged = useCallback(() => {
    onSessionsChanged?.(project?.id);
  }, [onSessionsChanged, project?.id]);

  const tabs = useMemo(
    () => buildPaneTabs({ panes, previews, filesDocked }),
    [panes, previews, filesDocked],
  );
  const activePane = resolveActivePane({ requested: requestedPane, tabs, filesDocked });

  // 容器宽度 → 决定 Files 是常驻还是收进页签
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return undefined;
    const measure = () => setFilesDocked(shouldDockFilesPanel(host.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 取项目根路径（PTY 要用它当 cwd），顺手更新最近打开时间
  useEffect(() => {
    if (!project?.id) return;
    tauri.projectsRootPath(project.id)
      .then(setRootPath)
      .catch((err) => setError(String(err?.message || err)));
    tauri.projectsTouch(project.id).catch(() => {});
  }, [project?.id]);

  // 恢复已存在的会话（切走再切回 project 标签时不该重开终端）
  useEffect(() => {
    if (!project?.id) return;
    Promise.all([
      tauri.ptyList(project.id).catch(() => []),
      tauri.projectsSessionHistory(project.id, 30).catch(() => ({ bound: [], agentSessions: [] })),
    ]).then(([list, history]) => {
      // 小标签的标题也用第一句 prompt，和侧边栏保持一致
      const prompts = new Map(
        (history?.agentSessions || [])
          .filter((r) => r?.agentId && r.firstPrompt)
          .map((r) => [r.agentId, r.firstPrompt]),
      );
      const bound = Object.fromEntries((history?.bound || []).map((e) => [
        e.id,
        { ...e, title: e.title || prompts.get(e.agentId) || null },
      ]));
      setBoundBySessionId(bound);
      setPanes((prev) => mergePanes({
        panes: prev,
        sessions: Array.isArray(list) ? list : [],
        boundBySessionId: bound,
      }));
    });
  }, [project?.id]);

  /**
   * 起一个新进程。
   *
   * `revivePaneKey` 存在时表示「原地复活」：不新增 pane，只把那个 pane 的
   * PTY 进程换成新的。这样恢复一个已退出的对话不会多出标签或行。
   */
  const spawnSession = useCallback(async (kind, { resumeId = null, revivePaneKey = null } = {}) => {
    if (!project?.id || !rootPath) return;
    spawnSeq.current += 1;
    const sessionId = `${project.id}:${kind}:${spawnSeq.current}:${Date.now()}`;
    try {
      const info = await tauri.ptySpawn({
        sessionId,
        projectId: project.id,
        cwd: rootPath,
        kind,
        resumeId,
      });

      if (revivePaneKey) {
        setPanes((prev) => revivePane(prev, revivePaneKey, info));
        setRequestedPane(revivePaneKey);
      } else {
        const key = paneKeyFor({ agentId: resumeId, sessionId: info.id });
        setPanes((prev) => [...prev, {
          key,
          sessionId: info.id,
          agentId: resumeId,
          kind,
          title: null,
          alive: true,
        }]);
        setRequestedPane(key);
      }
      setError('');

      // 登记这个窗口。恢复时 agent id 已知，直接绑定 —— 新会话与原对话
      // 同一身份，界面上不会多出一行。新建会话则等懒写入的文件落盘后认领。
      if (kind !== 'shell') {
        // 不要静默吞掉注册失败：注册不上就意味着这个会话没有身份，
        // 界面上会多出一条无主记录 —— 这正是之前那个「点一次多出一个」
        // 的病征被掩盖的原因。
        try {
          await tauri.projectsRegisterSession({
            sessionId,
            projectId: project.id,
            kind,
            title: null,
            agentId: resumeId,
          });
        } catch (err) {
          console.error('[ProjectView] Failed to register session:', err);
          setError(String(err?.message || err));
        }
        if (resumeId) {
          setBoundBySessionId((prev) => ({
            ...prev,
            [sessionId]: { id: sessionId, agentId: resumeId, kind },
          }));
        } else {
          const spawnedAt = await tauri.ptySpawnedAt(sessionId).catch(() => null);
          setClaimTargets((prev) => [
            ...prev,
            { sessionId, kind, spawnedAt: spawnedAt ?? Date.now() },
          ]);
        }
      }
      notifySessionsChanged();
    } catch (err) {
      setError(String(err?.message || err));
    }
  }, [project?.id, rootPath, notifySessionsChanged]);

  // 认领轮询。只处理队首，认到了就出队，超出认领窗口（后端 300s）也出队。
  useEffect(() => {
    if (claimTargets.length === 0 || !project?.id) return undefined;
    const target = claimTargets[0];
    let cancelled = false;

    const attempt = async () => {
      if (cancelled) return;
      try {
        const agentId = await tauri.projectsClaimSession({
          sessionId: target.sessionId,
          projectId: project.id,
          kind: target.kind,
          spawnedAt: target.spawnedAt,
        });
        if (cancelled) return;
        if (agentId) {
          setClaimTargets((prev) => prev.filter((t) => t.sessionId !== target.sessionId));
          // 认领到对话 id 之后记在 pane 上，这样它退出后还能被恢复。
          // 身份键刻意保持不变 —— 变了会重挂 TerminalPane 清空屏幕。
          setBoundBySessionId((prev) => ({
            ...prev,
            [target.sessionId]: { id: target.sessionId, agentId, kind: target.kind },
          }));
          setPanes((prev) => prev.map((pane) => (
            pane.sessionId === target.sessionId ? { ...pane, agentId } : pane
          )));
          notifySessionsChanged();
        }
      } catch {
        // 认领失败不该影响会话本身，静默重试到窗口过期
      }
    };

    const timer = setInterval(attempt, 2000);
    attempt();
    // 超过认领窗口就放弃，避免无限轮询
    const giveUp = setTimeout(() => {
      if (!cancelled) {
        setClaimTargets((prev) => prev.filter((t) => t.sessionId !== target.sessionId));
      }
    }, 300 * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [claimTargets, project?.id, notifySessionsChanged]);

  const handleOpenFile = useCallback((entry, { pinned = false } = {}) => {
    const { previews: next, activeId } = openPreview({
      previews,
      file: { path: entry.path, name: entry.name },
      pinned,
    });
    setPreviews(next);
    if (activeId) setRequestedPane(activeId);
  }, [previews]);

  const handleClosePane = useCallback(async (id) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (tab?.type === 'session') {
      // 进程还活着时确认一次，否则误点就断了 agent 会话。
      // tauri.confirm 自带 i18n 翻译，所以这里传英文原文而不是 t(...)。
      if (tab.alive) {
        const ok = await tauri.confirm(
          'This will end the running session. Continue?',
          { title: 'Close session' },
        ).catch(() => true);
        if (ok === false) return;
      }
      // 标签 id 是 pane 的稳定身份，要杀的是它当前那个 PTY 进程
      if (tab.sessionId) tauri.ptyKill(tab.sessionId).catch(() => {});
    }
    const next = closePane({ panes, previews, id });
    setPanes(next.panes);
    setPreviews(next.previews);
  }, [tabs, panes, previews]);

  // 同 ChatboxBody：集合没变就返回同一个引用，让 React 在没有会话状态翻转时
  // 直接 bail out，而不是每 400ms 把这棵树（含终端面板和 Files）重渲染一遍。
  useEffect(() => {
    const unlisten = tauri.onPtyOutput((payload) => {
      if (payload?.sessionId) activityRef.current[payload.sessionId] = Date.now();
    });
    const timer = setInterval(() => {
      setRunningSessions((prev) => {
        const next = runningSessionIds(activityRef.current);
        return sameIdSet(prev, next) ? prev : next;
      });
    }, 400);
    return () => {
      try { unlisten?.(); } catch { /* ignore */ }
      clearInterval(timer);
    };
  }, []);

  // 绑定记录变化时重新合并一次 pane，把新拿到的标题/对话 id 落到 pane 上
  useEffect(() => {
    setPanes((prev) => mergePanes({ panes: prev, sessions: prev.filter((p) => p.sessionId && p.alive).map((p) => ({ id: p.sessionId, kind: p.kind, alive: true })), boundBySessionId }));
  }, [boundBySessionId]);

  const handleSessionExit = useCallback((sessionId) => {
    // pane 留在原位标记为已退出，可就地恢复；不要移除它
    setPanes((prev) => prev.map((p) => (p.sessionId === sessionId ? { ...p, alive: false } : p)));
    tauri.projectsMarkSessionExited(sessionId).catch(() => {});
    notifySessionsChanged();
  }, [notifySessionsChanged]);

  // 把小标签的数量和关闭动作上报给宿主，Ctrl+W 据此决定关小标签还是关大标签。
  // 只上报可关闭的页签：Files 在窄布局下是钉住不可关的，不该算进去。
  const closablePaneCount = tabs.filter((tab) => tab.closable).length;
  useEffect(() => {
    if (!active) return undefined;
    onPanesChange?.({
      closablePaneCount,
      closeActivePane: () => {
        const target = tabs.find((tab) => tab.id === activePane && tab.closable);
        if (target) handleClosePane(target.id);
      },
    });
    return () => onPanesChange?.(null);
  }, [active, closablePaneCount, tabs, activePane, handleClosePane, onPanesChange]);

  // 侧边栏点了会话 → 用 CLI 自己的 resume 重开一个窗口。
  //
  // 处理完必须回调让宿主把请求清掉，不能只靠本地 ref 去重：ref 在组件
  // 卸载重挂时会回到初始值，而请求还留在宿主的 state 里，于是关掉 project
  // 标签再打开就会又 spawn 一次，反复开关能堆出一串会话。
  useEffect(() => {
    if (!active || !resumeRequest || !rootPath) return;
    const { kind, agentId, sessionId, focusOnly } = resumeRequest;
    onResumeHandled?.();

    // 先按进程、再按对话定位已有 pane
    const existing = paneForSessionId(panes, sessionId) || paneForAgentId(panes, agentId);

    if (focusOnly) {
      // 点的是活着的会话：只切到它那个 pane，什么都不新建
      if (existing) setRequestedPane(existing.key);
      return;
    }
    if (existing?.alive) {
      setRequestedPane(existing.key);
      return;
    }
    if (existing) {
      // 已退出的 pane：原地换个新进程，标签不增、位置不动
      spawnSession(kind, { resumeId: agentId, revivePaneKey: existing.key });
      return;
    }
    spawnSession(kind, { resumeId: agentId });
  }, [active, resumeRequest, rootPath, panes, spawnSession, onResumeHandled]);

  const activePreview = previews.find((p) => p.id === activePane);
  const showFilesPaneContent = !filesDocked && isFilesPane(activePane);

  return (
    <div ref={containerRef} className={`flex h-full flex-col ${active ? '' : 'hidden'}`}>
      {error && (
        <div className="shrink-0 bg-rose-50 px-3 py-1 text-[11px] text-rose-700">
          <span data-i18n-ignore>{t(error)}</span>
        </div>
      )}

      {/* 内容区：宽布局 = 内容列 | Files；窄布局 = 仅当前页签 */}
      <div className="flex min-h-0 flex-1">
        {/* 内容列。小标签条放在这一列内部，所以它和快速启动按钮都停在
            Files 面板的左边界，而不是横跨整个窗口盖在 Files 头部上方。 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{/* min-h-0 不能省：flex 子项的 min-height 默认是 auto，缺了它这一列
            无法收缩到低于内容高度 —— 终端一偏大整列就撑出容器，多出来的
            行画到窗口外被裁掉，而终端也永远收不到"该缩小"的信号。 */}
        {/* 小标签栏：仅 project 大标签打开时存在 */}
        <div className="flex h-7 shrink-0 items-center border-b border-gray-200/70 bg-slate-100/70 px-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.type === 'preview'
              ? MdInsertDriveFile
              : tab.type === 'files' ? MdFolder : kindIcon(tab.kind);
            const isActive = tab.id === activePane;
            return (
              <div
                key={tab.id}
                onClick={() => setRequestedPane(tab.id)}
                onDoubleClick={() => tab.type === 'preview' && setPreviews((prev) => pinPreview(prev, tab.id))}
                className={`group flex h-5.5 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                  isActive ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:bg-white/60'
                }`}
                title={tab.path || tab.title}
              >
                <Icon className="h-3 w-3 shrink-0 opacity-60" />
                <span
                  data-i18n-ignore
                  className={`max-w-[110px] truncate ${tab.type === 'preview' && !tab.pinned ? 'italic' : ''}`}
                >
                  {tab.title}
                </span>
                {tab.type === 'session' && (
                  <SessionDot
                    state={sessionStateIn({ alive: tab.alive }, runningSessions, tab.sessionId)}
                    title={tab.alive ? t('Running') : t('Exited')}
                  />
                )}
                {tab.closable && (
                  <MdClose
                    onClick={(e) => { e.stopPropagation(); handleClosePane(tab.id); }}
                    className="h-3 w-3 shrink-0 opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100"
                  />
                )}
              </div>
            );
          })}

          </div>

        {/* 快速启动：常驻在标签条右侧。放在标签的滚动容器之外，
            开了很多标签也不会被滚走。 */}
        <div className="ml-auto flex shrink-0 items-center gap-1 border-l border-gray-200/70 pl-1.5">
          {AGENT_KINDS.map(({ kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              onClick={() => spawnSession(kind)}
              title={`${t('New session')}: ${label}`}
              disabled={!rootPath}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-500 transition-colors hover:bg-white hover:text-gray-800 disabled:opacity-40"
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span data-i18n-ignore>{label}</span>
            </button>
          ))}
          </div>
      </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {showFilesPaneContent ? (
            <FileTree
              projectId={project.id}
              onOpenFile={handleOpenFile}
              activePath={activePreview?.path}
              gitDecorations={gitDecorations}
              deletedByDir={deletedByDir}
              onRefreshGit={onRefreshGit}
            />
          ) : (
            <>
              {panes.filter((pane) => pane.sessionId).map((pane) => (
                <TerminalPane
                  // React key 用 pane 的稳定身份：恢复后换了进程也不会重挂，
                  // TerminalPane 内部靠 session.id 变化自己重建终端
                  key={pane.key}
                  session={{ id: pane.sessionId, kind: pane.kind, alive: pane.alive }}
                  hidden={pane.key !== activePane}
                  onExit={handleSessionExit}
                />
              ))}
              {activePreview && (
                <FilePreview projectId={project.id} path={activePreview.path} />
              )}
              {tabs.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-4 text-gray-400">
                  <span className="text-sm">{t('No session yet')}</span>
                  <div className="flex flex-wrap justify-center gap-3">
                    {AGENT_KINDS.map(({ kind, label, Icon }) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => spawnSession(kind)}
                        disabled={!rootPath}
                        className="flex w-28 flex-col items-center gap-2 rounded-xl border border-gray-200 bg-white/70 px-4 py-4 text-gray-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:bg-white hover:shadow disabled:opacity-40 disabled:hover:translate-y-0"
                      >
                        <Icon className="h-6 w-6 text-gray-500" />
                        <span data-i18n-ignore className="text-sm font-medium">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        </div>

        {filesDocked && (
          <div
            className="shrink-0 border-l border-gray-200/70"
            style={{ width: FILES_PANEL_WIDTH }}
          >
            <FileTree
              projectId={project.id}
              onOpenFile={handleOpenFile}
              activePath={activePreview?.path}
              gitDecorations={gitDecorations}
              deletedByDir={deletedByDir}
              onRefreshGit={onRefreshGit}
            />
          </div>
        )}
      </div>
    </div>
  );
}
