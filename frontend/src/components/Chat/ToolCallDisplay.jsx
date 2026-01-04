/**
 * MCP Tool Call Display Component
 * 显示工具调用的实时状态和历史记录
 */
import React, { useState } from 'react';
import { FiTool, FiCheck, FiLoader, FiChevronDown, FiChevronRight, FiX, FiClock } from 'react-icons/fi';

/**
 * 单个工具调用状态显示
 */
const ToolCallItem = ({ call, isExpanded, onToggle }) => {
  const { name, arguments: args, result, status, duration } = call;
  
  // 从工具名中提取服务器名和工具名
  const [serverName, toolName] = name.includes('__') 
    ? name.split('__') 
    : ['', name];
  
  const statusIcon = {
    pending: <FiLoader className="animate-spin text-blue-500" size={14} />,
    running: <FiLoader className="animate-spin text-yellow-500" size={14} />,
    success: <FiCheck className="text-green-500" size={14} />,
    error: <FiX className="text-red-500" size={14} />
  }[status] || <FiTool className="text-gray-400" size={14} />;
  
  const statusColor = {
    pending: 'border-blue-200 bg-blue-50',
    running: 'border-yellow-200 bg-yellow-50',
    success: 'border-green-200 bg-green-50',
    error: 'border-red-200 bg-red-50'
  }[status] || 'border-gray-200 bg-gray-50';

  return (
    <div className={`rounded-lg border ${statusColor} overflow-hidden text-xs max-w-full`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-black/5 transition-colors"
      >
        {statusIcon}
        <span className="font-medium text-gray-700 truncate flex-1 text-left">
          {serverName && <span className="text-gray-400">{serverName}:</span>}
          {toolName}
        </span>
        {duration && (
          <span className="text-gray-400 flex items-center gap-1">
            <FiClock size={10} />
            {duration}ms
          </span>
        )}
        {isExpanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
      </button>
      
      {isExpanded && (
        <div className="px-3 py-2 border-t border-current/10 bg-white/50 space-y-2">
          {/* Arguments */}
          {args && Object.keys(args).length > 0 && (
            <div>
              <div className="text-gray-400 mb-1">Arguments:</div>
              <pre className="bg-gray-800 text-gray-100 rounded p-2 text-[10px] whitespace-pre-wrap break-all max-w-full">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          
          {/* Result */}
          {result && (
            <div>
              <div className="text-gray-400 mb-1">Result:</div>
              <pre className="bg-gray-800 text-gray-100 rounded p-2 text-[10px] max-h-60 overflow-y-auto whitespace-pre-wrap break-all max-w-full">
                {typeof result === 'string' 
                  ? result.slice(0, 2000) + (result.length > 2000 ? '...' : '')
                  : JSON.stringify(result, null, 2).slice(0, 2000)
                }
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * 实时工具调用状态显示 (在 Thinking 时显示)
 */
export const ToolCallStatus = ({ currentCall, pendingCalls = [] }) => {
  if (!currentCall && pendingCalls.length === 0) return null;
  
  return (
    <div className="flex items-center gap-2 text-sm text-gray-600 animate-pulse">
      <FiLoader className="animate-spin text-blue-500" size={16} />
      <span>
        {currentCall 
          ? `Calling ${currentCall.name.split('__').pop()}...`
          : `${pendingCalls.length} tool${pendingCalls.length > 1 ? 's' : ''} pending...`
        }
      </span>
    </div>
  );
};

/**
 * 工具调用历史记录显示 (在消息中显示)
 */
export const ToolCallHistory = ({ toolCalls = [], compact = true }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedItems, setExpandedItems] = useState(new Set());
  
  if (!toolCalls || toolCalls.length === 0) return null;
  
  const toggleItem = (index) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };
  
  if (compact && !isExpanded) {
    // 紧凑模式 - 只显示摘要
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full 
                   bg-blue-50 hover:bg-blue-100 text-blue-600 text-xs
                   border border-blue-200 transition-colors mb-2"
      >
        <FiTool size={12} />
        <span>Used {toolCalls.length} tool{toolCalls.length > 1 ? 's' : ''}</span>
        <FiChevronRight size={12} />
      </button>
    );
  }
  
  // 展开模式 - 显示详细列表
  return (
    <div className="mb-3 space-y-2">
      <button
        onClick={() => setIsExpanded(false)}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full 
                   bg-blue-50 hover:bg-blue-100 text-blue-600 text-xs
                   border border-blue-200 transition-colors"
      >
        <FiTool size={12} />
        <span>Used {toolCalls.length} tool{toolCalls.length > 1 ? 's' : ''}</span>
        <FiChevronDown size={12} />
      </button>
      
      <div className="space-y-1.5 pl-2 border-l-2 border-blue-200">
        {toolCalls.map((call, index) => (
          <ToolCallItem
            key={index}
            call={{ ...call, status: call.status || 'success' }}
            isExpanded={expandedItems.has(index)}
            onToggle={() => toggleItem(index)}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * 实时工具调用列表 (在 streaming 时显示)
 */
export const LiveToolCalls = ({ toolCalls = [] }) => {
  const [expandedItems, setExpandedItems] = useState(new Set());
  
  if (!toolCalls || toolCalls.length === 0) return null;
  
  const toggleItem = (index) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };
  
  return (
    <div className="mb-3 space-y-1.5">
      {toolCalls.map((call, index) => (
        <ToolCallItem
          key={index}
          call={call}
          isExpanded={expandedItems.has(index)}
          onToggle={() => toggleItem(index)}
        />
      ))}
    </div>
  );
};

export default ToolCallHistory;
