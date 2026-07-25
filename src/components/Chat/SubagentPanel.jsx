/**
 * SubagentPanel.jsx — CC Subagent 状态面板
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { subagentRegistry, onSubagentChange, matchesSubagentScope } from '../../utils/subagentManager';

const PANEL_WIDTH = 320;

export default function SubagentPanel({ isOpen, onClose, conversationId, anchorRef }) {
  const [, forceUpdate] = useState(0);
  const ref = useRef(null);
  const [position, setPosition] = useState({
    left: 8,
    bottom: 56,
    width: PANEL_WIDTH,
    maxHeight: 0,
  });

  const updatePosition = useCallback(() => {
    const rect = anchorRef?.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(240, Math.min(PANEL_WIDTH, window.innerWidth - 16));
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - rect.top + 8,
      width,
      maxHeight: Math.max(0, Math.min(384, rect.top - 16)),
    });
  }, [anchorRef]);

  useEffect(() => {
    const unsub = onSubagentChange(() => forceUpdate(n => n + 1));
    return unsub;
  }, []);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, updatePosition]);

  if (!isOpen) return null;

  const entries = [...subagentRegistry.entries()]
    .filter(([, entry]) => matchesSubagentScope(entry, { source: 'chat', conversationId }))
    .sort((a, b) => {
      const runningDelta = Number(b[1].status === 'running') - Number(a[1].status === 'running');
      return runningDelta || b[1].createdAt - a[1].createdAt;
    });
  const activeCount = entries.filter(([, entry]) => entry.status === 'running').length;

  const statusIcon = (status) => ({ running: '⏳', done: '✅', timeout: '⏰', failed: '❌' }[status] || '?');
  const statusColor = (status) => ({ running: 'text-blue-600', done: 'text-emerald-600', timeout: 'text-amber-600', failed: 'text-red-600' }[status] || 'text-gray-500');

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Subagent tasks for this chat"
      className="fixed z-[9999] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl"
      style={{
        left: `${position.left}px`,
        bottom: `${position.bottom}px`,
        width: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
      }}
    >
      <div className="sticky top-0 flex items-center justify-between border-b bg-white px-3 py-2">
        <span className="text-sm font-semibold text-gray-700">Subagents</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400" aria-live="polite">{activeCount} running</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Subagent tasks"
            className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            ×
          </button>
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-gray-400">No subagent tasks</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {entries.map(([taskId, entry]) => (
            <SubagentEntry key={taskId} taskId={taskId} entry={entry} statusIcon={statusIcon} statusColor={statusColor} />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function SubagentEntry({ taskId, entry, statusIcon, statusColor }) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
  const detailsId = `subagent-details-${taskId}`;

  return (
    <div className="px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={detailsId}
      >
        <span>{statusIcon(entry.status)}</span>
        <span className={`text-xs font-medium flex-1 truncate ${statusColor(entry.status)}`}>
          {entry.task?.substring(0, 60)}
        </span>
        <span className="text-[10px] text-gray-400">{elapsed}s</span>
        <span className="text-gray-300 text-xs">{expanded ? '▾' : '▸'}</span>
      </button>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="text-[9px] text-gray-300 font-mono">{taskId}</span>
        <span className="text-[9px] text-gray-300">from:{entry.source}</span>
      </div>
      {expanded && (
        <div id={detailsId} className="mt-1.5 whitespace-pre-wrap rounded bg-gray-50 p-2 text-[10px] text-gray-600">
          {entry.status === 'done' && entry.result
            ? entry.result.substring(0, 500) + (entry.result.length > 500 ? '...' : '')
            : entry.status === 'failed'
            ? `Error: ${entry.error}`
            : entry.status === 'timeout'
            ? 'Task timed out'
            : 'Running...'}
        </div>
      )}
    </div>
  );
}
