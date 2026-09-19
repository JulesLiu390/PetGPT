import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { MdChevronRight, MdKeyboardArrowDown, MdRefresh, MdInsertDriveFile } from 'react-icons/md';
import { useI18n } from '../../i18n/context.js';
import * as tauri from '../../utils/tauri';
import { ROW_HEIGHT, flattenTree, visibleRange } from '../../utils/fileTreeRows.js';
import { decorateEntry } from '../../utils/gitDecorations.js';

/**
 * git 色调 → 行上的 class。
 *
 * 这个面板是浅色底（slate-50），所以用的不是 VSCode 深色主题那套值 ——
 * 直接搬过来的话 added 的 #81b88b 在白底上几乎看不见。
 */
const GIT_TONE_CLASS = Object.freeze({
  modified: 'text-amber-600',
  added: 'text-emerald-600',
  untracked: 'text-emerald-600',
  deleted: 'text-rose-500',
  renamed: 'text-sky-600',
  conflict: 'text-red-600 font-semibold',
  // 目录自身没改，只是子孙里有 —— 比文件本身的颜色淡一档
  dirty: 'text-amber-700/70',
});

/** 只加在文件名上的额外样式。删除线划掉名字有意义，划掉那个 `D` 徽标没有。 */
const GIT_TONE_NAME_EXTRA = Object.freeze({ deleted: 'line-through' });

/**
 * 按层懒加载 + 虚拟滚动的文件树。
 *
 * 两条互相独立的约束：
 *
 * 1. 不递归预取。这个仓库自己就有几万个文件的 node_modules 和 1.9G 的
 *    src-tauri/target，一次性遍历会直接冻住界面。每个目录只在被展开时拉一次。
 *
 * 2. 不按树形递归渲染 DOM。后端单目录上限是 2000 条，每条还带两个 SVG 图标，
 *    整棵铺开就是上万个节点。这里把树拍平成一维等高行（flattenTree），只渲染
 *    视口内的那几十行。
 */
function FileTree({ projectId, onOpenFile, activePath, gitDecorations, deletedByDir, onRefreshGit }) {
  const { t } = useI18n();
  const [listings, setListings] = useState({});
  const [expanded, setExpanded] = useState({ '': true });
  const [loading, setLoading] = useState({});
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  // 过滤要重算整棵拍平结果。输入框保持即时响应，重算让给低优先级渲染。
  const deferredFilter = useDeferredValue(filter);

  const scrollerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // 「这个目录拉过没有」只在回调里读，不该进依赖数组：放进去的话每次
  // setListings 都会换一个新的 loadDir，把下面那个 effect 也一起带着重跑。
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  const loadDir = useCallback(async (path, { force = false } = {}) => {
    if (!projectId) return;
    if (!force && listingsRef.current[path]) return;
    setLoading((prev) => ({ ...prev, [path]: true }));
    try {
      const listing = await tauri.projectsListDir(projectId, path);
      setListings((prev) => ({ ...prev, [path]: listing }));
      setError('');
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading((prev) => ({ ...prev, [path]: false }));
    }
  }, [projectId]);

  useEffect(() => {
    setListings({});
    setExpanded({ '': true });
    setError('');
    // 换项目要回到顶部，否则新树会停在上一棵的滚动位置
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [projectId]);

  useEffect(() => {
    if (projectId && !listings['']) loadDir('');
  }, [projectId, listings, loadDir]);

  // 视口高度：面板可以被拖动改变宽高，要跟着量
  useEffect(() => {
    const host = scrollerRef.current;
    if (!host) return undefined;
    const measure = () => setViewportHeight(host.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(
    () => flattenTree({ listings, expanded, loading, filter: deferredFilter, deletedByDir }),
    [listings, expanded, loading, deferredFilter, deletedByDir],
  );

  const { start, end } = visibleRange({ scrollTop, viewportHeight, rowCount: rows.length });
  const visibleRows = rows.slice(start, end);

  const toggleDir = (path) => {
    const next = !expanded[path];
    setExpanded((prev) => ({ ...prev, [path]: next }));
    if (next) loadDir(path);
  };

  const refresh = () => {
    const open = Object.keys(expanded).filter((p) => expanded[p]);
    setListings({});
    open.forEach((p) => loadDir(p, { force: true }));
    // git 状态是独立轮询的。不一起刷的话，用户刚 git add 完点刷新，
    // 目录内容更新了而标记要再等一个轮询周期才变。
    onRefreshGit?.();
  };

  const renderRow = (row) => {
    const indent = row.depth * 12 + 4;

    if (row.kind === 'loading') {
      return (
        <div style={{ height: ROW_HEIGHT, paddingLeft: indent + 4 }}
             className="flex items-center text-[11px] text-gray-400">
          {t('Loading…')}
        </div>
      );
    }
    if (row.kind === 'truncated') {
      return (
        <div style={{ height: ROW_HEIGHT, paddingLeft: indent + 4 }}
             className="flex items-center text-[11px] text-amber-600">
          {t('Too many entries to list')}
        </div>
      );
    }
    // 已删除的文件：磁盘上没有，点不开，只是让「删了什么」在树上看得见
    if (row.kind === 'deleted') {
      return (
        <div
          style={{ height: ROW_HEIGHT, paddingLeft: indent }}
          className="flex items-center gap-1 pr-2 text-[12px] text-rose-500/80 cursor-default"
          title={row.entry.path}
        >
          <MdInsertDriveFile className="w-3 h-3 shrink-0 text-rose-200 ml-0.5" />
          <span className="truncate flex-1 line-through">{row.entry.name}</span>
          <span className="shrink-0 font-mono text-[10px] leading-none">D</span>
        </div>
      );
    }

    const { entry } = row;
    const isOpen = expanded[entry.path];
    const isActive = !entry.isDir && entry.path === activePath;
    const decoration = decorateEntry(entry.path, entry.isDir, gitDecorations);
    // 颜色加在文件名上而不是整行：选中行要保住自己的蓝底，
    // 同时 git 状态也不该因为「正好选中了它」就消失。
    const toneClass = decoration ? GIT_TONE_CLASS[decoration.tone] || '' : '';
    const nameClass = decoration
      ? `${toneClass} ${GIT_TONE_NAME_EXTRA[decoration.tone] || ''}`
      : '';
    return (
      <div
        onClick={() => (entry.isDir ? toggleDir(entry.path) : onOpenFile?.(entry))}
        onDoubleClick={() => (!entry.isDir ? onOpenFile?.(entry, { pinned: true }) : undefined)}
        style={{ height: ROW_HEIGHT, paddingLeft: indent }}
        className={`group flex items-center gap-1 pr-2 rounded cursor-pointer text-[12px] transition-colors ${
          isActive ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-200/70 text-gray-700'
        } ${entry.noisy ? 'opacity-50' : ''}`}
        title={entry.path}
      >
        {entry.isDir ? (
          isOpen
            ? <MdKeyboardArrowDown className="w-3.5 h-3.5 shrink-0 text-gray-400" />
            : <MdChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-400" />
        ) : (
          <MdInsertDriveFile className="w-3 h-3 shrink-0 text-gray-300 ml-0.5" />
        )}
        <span className={`truncate flex-1 ${nameClass}`}>{entry.name}</span>
        {decoration?.letter && (
          <span className={`shrink-0 font-mono text-[10px] leading-none ${toneClass}`}>
            {decoration.letter}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-slate-50/70">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200/70">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider flex-1">
          {t('Files')}
        </span>
        <MdRefresh
          onClick={refresh}
          title={t('Refresh')}
          className="w-3.5 h-3.5 cursor-pointer text-gray-400 hover:text-gray-700"
        />
      </div>
      <div className="px-2 py-1.5">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('Filter')}
          className="w-full rounded bg-white/80 border border-gray-200 px-2 py-1 text-[11px] outline-none focus:border-blue-300"
        />
      </div>
      {error && (
        <div className="mx-2 mb-1 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
          <span data-i18n-ignore>{t(error)}</span>
        </div>
      )}
      {/* 整棵树对 i18n 关闭。这里的文本全是文件名和路径，本来就不该被翻译，
          而每行还带一个 title={entry.path} —— 属性也在翻译器的扫描范围里。
          标在容器上让 DomLocalizer 在根节点就掉头，省掉整棵子树的遍历。
          （"Loading…" 之类的提示已经在 React 层用 t() 翻过了。） */}
      <div
        ref={scrollerRef}
        data-i18n-ignore
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="flex-1 overflow-auto px-1 pb-2"
      >
        {/* 撑出总高度，让滚动条长度反映真实行数 */}
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {/* 用 translateY 把渲染出来的那一段推到正确位置 */}
          <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
            {visibleRows.map((row) => (
              <React.Fragment key={row.key}>{renderRow(row)}</React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// memo：父组件 ProjectView 因为终端活动、标签切换等原因重渲染时，文件树
// 不该跟着重建。
export default React.memo(FileTree);
