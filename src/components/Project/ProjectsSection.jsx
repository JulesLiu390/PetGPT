import React, { useState } from 'react';
import {
  MdChevronRight,
  MdKeyboardArrowDown,
  MdAdd,
  MdFolder,
  MdTerminal,
  MdMoreHoriz,
  MdAutoAwesome,
  MdCode,
  MdStopCircle,
  MdDeleteOutline,
} from 'react-icons/md';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { useI18n } from '../../i18n/context.js';
import * as tauri from '../../utils/tauri';
import SessionDot from './SessionDot';
import { PANE_KIND_LABELS } from '../../utils/projectPanes.js';
import { projectSessionList, sessionStateIn } from '../../utils/sessionActivity.js';

// 与 ProjectView 的小标签保持同一套图标，避免同一个会话在两处显示不同图标
const kindIcon = (kind) => {
  if (kind === 'claude') return MdAutoAwesome;
  if (kind === 'codex') return MdCode;
  if (kind === 'shell') return MdTerminal;
  return MdFolder;
};

/**
 * 侧边栏里与 Sessions 同级的 Projects 区块。
 *
 * 展开时 flex-1 并独立滚动，所以两个区块都展开就各分一半剩余高度，
 * 折起一个另一个自动吃满。默认展开。
 */
function ProjectsSection({
  projects,
  onReload,
  onOpenProject,
  sessionsByProject,
  onFocusSession,
  historyByProject,
  /** 正在输出的会话 id 集合。只在有会话跨越运行/空闲边界时才换引用 */
  runningSessions,
  onResumeSession,
  onEndSession,
  onDeleteSession,
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [openProjects, setOpenProjects] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleAdd = async () => {
    setBusy(true);
    setError('');
    try {
      const picked = await dialogOpen({ directory: true, multiple: false });
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      await tauri.projectsAdd(path);
      await onReload?.();
      setExpanded(true);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (event, project) => {
    event.stopPropagation();
    const ok = await tauri.confirm(
      'Remove this project from the list? Files on disk are not touched.',
      { title: 'Remove project' },
    ).catch(() => false);
    if (!ok) return;
    try {
      await tauri.ptyKillProject(project.id).catch(() => {});
      await tauri.projectsRemove(project.id);
      await onReload?.();
    } catch (err) {
      setError(String(err?.message || err));
    }
  };

  return (
    <div className={`flex min-h-0 flex-col border-t border-gray-200/70 ${expanded ? 'flex-1' : 'shrink-0'}`}>
      <div
        onClick={() => setExpanded((v) => !v)}
        className="group flex h-10 shrink-0 cursor-pointer items-center gap-1 px-2 hover:bg-gray-200/40"
      >
        {expanded
          ? <MdKeyboardArrowDown className="h-4 w-4 shrink-0 text-gray-400" />
          : <MdChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
        <span className="flex-1 text-[13px] font-semibold text-gray-500">
          {t('Projects')}
        </span>
        <MdAdd
          onClick={(e) => { e.stopPropagation(); handleAdd(); }}
          title={t('Add project')}
          className={`h-4 w-4 shrink-0 text-gray-400 hover:text-gray-700 ${busy ? 'opacity-40' : ''}`}
        />
      </div>

      {expanded && (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {error && (
            <div className="mx-1 mb-1 rounded bg-rose-50 px-2 py-1 text-[10px] text-rose-700">
              <span data-i18n-ignore>{t(error)}</span>
            </div>
          )}

          {projects.length === 0 ? (
            <div
              onClick={handleAdd}
              className="mx-1 cursor-pointer rounded px-2 py-2 text-[11px] text-gray-400 hover:bg-gray-200/50"
            >
              {t('Add project…')}
            </div>
          ) : (
            projects.map((project) => {
              const sessions = sessionsByProject?.[project.id] || [];
              const isOpen = openProjects[project.id];
              return (
                <div key={project.id}>
                  <div
                    onClick={() => onOpenProject?.(project)}
                    className="group flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-gray-700 hover:bg-[#ececec] cursor-pointer"
                    title={project.path}
                  >
                    {sessions.length > 0 || (historyByProject?.[project.id]?.bound?.length || 0) > 0 ? (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenProjects((prev) => ({ ...prev, [project.id]: !prev[project.id] }));
                        }}
                        className="shrink-0"
                      >
                        {isOpen
                          ? <MdKeyboardArrowDown className="h-3.5 w-3.5 text-gray-400" />
                          : <MdChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                      </span>
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <MdFolder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
                    <span data-i18n-ignore className="flex-1 truncate">{project.name}</span>
                    <MdMoreHoriz
                      onClick={(e) => handleRemove(e, project)}
                      title={t('Remove project')}
                      className="h-3.5 w-3.5 shrink-0 text-gray-400 opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100"
                    />
                  </div>

                  {isOpen && (() => {
                    // 单一列表：同一个对话永远只有一行，位置不变，
                    // 状态在 跑动 / 空闲 / 已退出 之间切换
                    const rows = projectSessionList({
                      liveSessions: sessions,
                      bound: historyByProject?.[project.id]?.bound || [],
                      agentSessions: historyByProject?.[project.id]?.agentSessions || [],
                    });
                    return rows.map((row) => {
                      const Icon = kindIcon(row.kind);
                      const clickable = row.alive || row.resumable;
                      return (
                        <div
                          key={row.key}
                          onClick={() => {
                            if (row.alive) onFocusSession?.(project, row);
                            else if (row.resumable) onResumeSession?.(project, row);
                          }}
                          title={row.alive
                            ? project.path
                            : row.resumable ? t('Resume this session') : t('Session file no longer exists')}
                          className={`group/sess flex items-center gap-1.5 rounded py-0.5 pl-7 pr-1.5 text-[11px] ${
                            clickable
                              ? 'cursor-pointer text-gray-600 hover:bg-[#ececec]'
                              : 'cursor-not-allowed text-gray-300'
                          }`}
                        >
                          <Icon className="h-3 w-3 shrink-0 opacity-60" />
                          <span
                            data-i18n-ignore
                            className="min-w-0 flex-1 truncate"
                            title={row.title || undefined}
                          >
                            {row.title || PANE_KIND_LABELS[row.kind] || row.kind}
                          </span>
                          <SessionDot
                            state={sessionStateIn(row, runningSessions, row.sessionId)}
                            title={row.alive ? t('Running') : t('Exited')}
                          />
                          {row.alive ? (
                            <MdStopCircle
                              onClick={(e) => { e.stopPropagation(); onEndSession?.(project, row); }}
                              title={t('End session')}
                              className="h-3 w-3 shrink-0 text-gray-400 opacity-0 transition-opacity hover:text-rose-500 group-hover/sess:opacity-100"
                            />
                          ) : (
                            <MdDeleteOutline
                              onClick={(e) => { e.stopPropagation(); onDeleteSession?.(project, row); }}
                              title={t('Remove from list')}
                              className="h-3 w-3 shrink-0 text-gray-400 opacity-0 transition-opacity hover:text-rose-500 group-hover/sess:opacity-100"
                            />
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// memo：侧边栏的项目/会话列表只跟着 projects、sessionsByProject、historyByProject
// 和 runningSessions 变。父组件 ChatboxBody 因为别的原因重渲染时不该连带重建
// 这里的整棵列表。
export default React.memo(ProjectsSection);
