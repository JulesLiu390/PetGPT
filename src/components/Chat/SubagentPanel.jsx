/**
 * SubagentPanel.jsx — CC Subagent 状态面板
 */
import React, { useState, useEffect, useRef } from 'react';
import { subagentRegistry, onSubagentChange, getActiveCount } from '../../utils/subagentManager';

export default function SubagentPanel({ isOpen, onClose }) {
  const [, forceUpdate] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    const unsub = onSubagentChange(() => forceUpdate(n => n + 1));
    return unsub;
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const entries = [...subagentRegistry.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);

  const statusIcon = (status) => ({ running: '⏳', done: '✅', timeout: '⏰', failed: '❌' }[status] || '?');
  const statusColor = (status) => ({ running: 'text-blue-600', done: 'text-emerald-600', timeout: 'text-amber-600', failed: 'text-red-600' }[status] || 'text-gray-500');

  return (
    <div ref={ref} className="absolute bottom-full left-0 mb-2 w-80 max-h-96 overflow-y-auto bg-white rounded-xl shadow-xl border border-gray-200 z-50">
      <div className="sticky top-0 bg-white border-b px-3 py-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">🤖 CC Subagents</span>
        <span className="text-xs text-gray-400">{getActiveCount()} running</span>
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
    </div>
  );
}

function SubagentEntry({ taskId, entry, statusIcon, statusColor }) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span>{statusIcon(entry.status)}</span>
        <span className={`text-xs font-medium flex-1 truncate ${statusColor(entry.status)}`}>
          {entry.task?.substring(0, 60)}
        </span>
        <span className="text-[10px] text-gray-400">{elapsed}s</span>
        <span className="text-gray-300 text-xs">{expanded ? '▾' : '▸'}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="text-[9px] text-gray-300 font-mono">{taskId}</span>
        <span className="text-[9px] text-gray-300">from:{entry.source}</span>
      </div>
      {expanded && (
        <div className="mt-1.5 p-2 bg-gray-50 rounded text-[10px] text-gray-600 whitespace-pre-wrap">
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
