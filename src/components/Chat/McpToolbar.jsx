/**
 * MCP 工具栏组件
 * 显示 MCP 服务器图标，支持单独启用/禁用每个服务器
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FiMoreHorizontal, FiCheck, FiEye, FiEyeOff, FiEdit2, FiTrash2, FiSettings, FiMenu } from 'react-icons/fi';
import * as FaIcons from 'react-icons/fa6';
import * as FiIcons from 'react-icons/fi';

/**
 * 根据图标名称或 emoji 渲染图标
 * @param {string} icon - emoji 字符或 react-icons 名称 (如 "FaRobot", "FiSearch")
 * @param {string} className - 额外的 CSS 类名
 */
const renderIcon = (icon, className = '') => {
  if (!icon) return <span className={className}>🔧</span>;
  
  // 检查是否是 emoji (非字母开头或长度为 1-2 的特殊字符)
  if (!/^[A-Z]/.test(icon) || icon.length <= 2) {
    return <span className={className}>{icon}</span>;
  }
  
  // 尝试从 react-icons 获取图标
  let IconComponent = null;
  
  if (icon.startsWith('Fa')) {
    IconComponent = FaIcons[icon];
  } else if (icon.startsWith('Fi')) {
    IconComponent = FiIcons[icon];
  }
  
  if (IconComponent) {
    return <IconComponent className={className} />;
  }
  
  // 默认返回 emoji
  return <span className={className}>{icon}</span>;
};

/**
 * 单个服务器图标按钮 - Google 风格
 */
const ServerIconButton = ({ server, isEnabled, onToggle, onContextMenu }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  
  return (
    <div className="relative">
      <button
        onClick={() => onToggle(server.name)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(server, e);
        }}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={`
          relative flex items-center gap-1.5 rounded-full
          transition-all duration-200 text-sm font-medium
          ${isEnabled 
            ? 'px-3 py-1.5 text-gray-700 bg-gray-300/80 border border-gray-400' 
            : 'p-2 text-gray-500 hover:bg-gray-300/50 border border-transparent'
          }
        `}
        title={server.name}
      >
        {renderIcon(server.icon, "text-base")}
        {/* 只有启用时显示文字，小屏幕隐藏 */}
        {isEnabled && (
          <span className="hidden sm:inline max-w-[60px] truncate">{server.name}</span>
        )}
        {/* 启用状态指示点 */}
        {isEnabled && (
          <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
        )}
      </button>
      
      {/* Tooltip - 未启用时显示 */}
      {showTooltip && !isEnabled && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 
                      bg-gray-800 text-white text-xs rounded whitespace-nowrap z-50
                      pointer-events-none shadow-lg">
          {server.name}
          <div className="absolute top-full left-1/2 -translate-x-1/2 
                        border-4 border-transparent border-t-gray-800" />
        </div>
      )}
    </div>
  );
};

/**
 * MCP 管理下拉菜单 - 管理所有服务器的启用状态、显示/隐藏、排序
 */
const McpManagerDropdown = ({ 
  servers, 
  enabledServers, 
  onToggle, 
  onToggleVisibility,
  onReorder,
  isOpen,
  onClose,
  dropdownRef,
  anchorRef
}) => {
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [position, setPosition] = useState({ bottom: 0, left: 0, maxHeight: 400 });

  useEffect(() => {
    if (isOpen && anchorRef?.current) {
      const updatePosition = () => {
        const rect = anchorRef.current.getBoundingClientRect();
        const dropdownWidth = 256; // w-64
        
        // 默认左对齐
        let left = rect.left;
        
        // 如果右侧溢出，则尝试右对齐
        if (left + dropdownWidth > window.innerWidth) {
          left = rect.right - dropdownWidth;
        }
        
        // 最后的安全检查：防止左侧溢出
        if (left < 8) left = 8;

        // 计算垂直位置和最大高度
        const spaceAbove = rect.top - 16; // 上方可用空间
        const spaceBelow = window.innerHeight - rect.bottom - 16; // 下方可用空间
        
        // 优先显示在上方，除非上方空间太小且下方空间更大
        let bottom, top, maxHeight;
        
        if (spaceAbove > 200 || spaceAbove > spaceBelow) {
            // 显示在上方
            bottom = window.innerHeight - rect.top + 8;
            top = 'auto';
            maxHeight = spaceAbove;
        } else {
            // 显示在下方
            top = rect.bottom + 8;
            bottom = 'auto';
            maxHeight = spaceBelow;
        }

        setPosition({ bottom, top, left, maxHeight });
      };
      
      updatePosition();
      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition, true);
      
      return () => {
        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
      };
    }
  }, [isOpen, anchorRef]);
  
  const handleDragStart = (e, index) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // 添加拖拽时的样式
    e.target.style.opacity = '0.5';
  };
  
  const handleDragEnd = (e) => {
    e.target.style.opacity = '1';
    
    if (draggedIndex !== null && dragOverIndex !== null && draggedIndex !== dragOverIndex) {
      // 执行重新排序
      const newOrder = [...servers];
      const [draggedItem] = newOrder.splice(draggedIndex, 1);
      newOrder.splice(dragOverIndex, 0, draggedItem);
      
      // 通知父组件更新顺序
      onReorder(newOrder.map((s, i) => ({ name: s.name, toolbarOrder: i })));
    }
    
    setDraggedIndex(null);
    setDragOverIndex(null);
  };
  
  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (draggedIndex !== index) {
      setDragOverIndex(index);
    }
  };
  
  const handleDragLeave = () => {
    setDragOverIndex(null);
  };
  
  if (!isOpen) return null;
  
  return createPortal(
    <div 
      ref={dropdownRef}
      style={{
        position: 'fixed',
        bottom: position.bottom !== 'auto' ? `${position.bottom}px` : 'auto',
        top: position.top !== 'auto' ? `${position.top}px` : 'auto',
        left: `${position.left}px`,
        maxHeight: `${position.maxHeight}px`,
        zIndex: 9999
      }}
      className="w-64 bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden flex flex-col"
    >
      <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100 font-medium flex items-center justify-between flex-shrink-0">
        <span>MCP Servers</span>
        <span className="text-gray-400">Drag to reorder</span>
      </div>
      
      {servers.length === 0 ? (
        <div className="px-3 py-4 text-sm text-gray-400 text-center flex-shrink-0">
          No MCP servers
        </div>
      ) : (
        <div className="overflow-y-auto flex-1 min-h-0">
          {servers.map((server, index) => (
            <div 
              key={server.name}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={handleDragLeave}
              className={`
                flex items-center px-3 py-2 
                hover:bg-gray-50 transition-colors group cursor-grab
                ${dragOverIndex === index ? 'border-t-2 border-blue-400' : ''}
                ${draggedIndex === index ? 'opacity-50' : ''}
              `}
            >
              {/* 拖拽手柄 */}
              <FiMenu className="text-gray-300 mr-2 flex-shrink-0 group-hover:text-gray-500" size={14} />
              
              {/* 图标和名称 - 点击切换启用状态 */}
              <button
                onClick={() => onToggle(server.name)}
                className="flex items-center gap-2 flex-1 text-left min-w-0"
              >
                <span className="text-lg flex-shrink-0">{renderIcon(server.icon)}</span>
                <span className={`text-sm truncate ${enabledServers.has(server.name) ? 'text-gray-900 font-medium' : 'text-gray-500'}`}>
                  {server.name}
                </span>
              </button>
              
              {/* 启用状态指示 */}
              {enabledServers.has(server.name) && (
                <FiCheck className="text-green-500 flex-shrink-0 mr-2" size={16} />
              )}
              
              {/* 显示/隐藏切换按钮 */}
              <button
                onClick={() => onToggleVisibility(server.name, server.showInToolbar !== false)}
                className={`
                  p-1.5 rounded-md transition-colors flex-shrink-0
                  ${server.showInToolbar !== false 
                    ? 'text-blue-500 hover:bg-blue-50' 
                    : 'text-gray-300 hover:bg-gray-100 hover:text-gray-500'
                  }
                `}
                title={server.showInToolbar !== false ? 'Hide from toolbar' : 'Show in toolbar'}
              >
                {server.showInToolbar !== false ? <FiEye size={14} /> : <FiEyeOff size={14} />}
              </button>
            </div>
          ))}
        </div>
      )}
      
      <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-400 flex-shrink-0">
        <span className="flex items-center gap-1">
          <FiCheck size={12} className="text-green-500" /> = Enabled
          <span className="mx-2">|</span>
          <FiEye size={12} className="text-blue-500" /> = Visible
        </span>
      </div>
    </div>,
    document.body
  );
};

/**
 * 右键菜单
 */
const ContextMenu = ({ server, position, onClose, onHide, onEditIcon, onDelete }) => {
  const menuRef = useRef(null);
  
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);
  
  if (!server) return null;
  
  return (
    <div 
      ref={menuRef}
      className="fixed bg-white rounded-xl shadow-xl border border-gray-200 
               overflow-hidden z-50 py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
    >
      <button
        onClick={() => { onHide(server.name); onClose(); }}
        className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 
                 hover:bg-gray-100 text-left"
      >
        <FiEyeOff size={14} className="text-gray-500" />
        Hide from toolbar
      </button>
      <button
        onClick={() => { onEditIcon(server); onClose(); }}
        className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 
                 hover:bg-gray-100 text-left"
      >
        <FiEdit2 size={14} className="text-gray-500" />
        Change icon
      </button>
      <div className="border-t border-gray-100 my-1" />
      <button
        onClick={() => { onDelete(server.name); onClose(); }}
        className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 
                 hover:bg-red-50 text-left"
      >
        <FiTrash2 size={14} />
        Delete server
      </button>
    </div>
  );
};

/**
 * MCP 工具栏主组件
 * @param {Object} props
 * @param {Array} props.servers - 所有 MCP 服务器列表
 * @param {Set} props.enabledServers - 已启用的服务器名称集合
 * @param {Function} props.onToggleServer - 切换服务器启用状态的回调
 * @param {Function} props.onUpdateServer - 更新服务器配置的回调
 * @param {Function} props.onDeleteServer - 删除服务器的回调
 * @param {Function} props.onEditIcon - 编辑图标的回调 (打开图标选择器)
 * @param {Function} props.onBatchUpdateOrder - 批量更新服务器顺序的回调
 * @param {number} props.maxVisible - 最大可见图标数量，默认 5
 */
const McpToolbar = ({ 
  servers = [], 
  enabledServers = new Set(),
  onToggleServer,
  onUpdateServer,
  onDeleteServer,
  onEditIcon,
  onBatchUpdateOrder,
  maxVisible = 5 
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [contextMenu, setContextMenu] = useState({ server: null, position: { x: 0, y: 0 } });
  const dropdownRef = useRef(null);
  const buttonRef = useRef(null);
  
  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current && 
        !dropdownRef.current.contains(e.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    
    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown]);
  
  // 调试日志 (commented out to reduce noise)
  // console.log('[McpToolbar] servers received:', servers?.length, servers?.map(s => ({ name: s.name, showInToolbar: s.showInToolbar, _id: s._id })));
  
  // 按 toolbarOrder 排序
  const sortedServers = [...servers].sort((a, b) => (a.toolbarOrder || 0) - (b.toolbarOrder || 0));
  // 只显示标记为显示在工具栏的服务器
  const visibleServers = sortedServers.filter(s => s.showInToolbar !== false).slice(0, maxVisible);
  
  // console.log('[McpToolbar] visibleServers:', visibleServers.length);
  
  const handleContextMenu = (server, e) => {
    setContextMenu({
      server,
      position: { x: e.clientX, y: e.clientY }
    });
  };
  
  const handleHideFromToolbar = async (serverName) => {
    await onUpdateServer(serverName, { showInToolbar: false });
  };
  
  const handleToggleVisibility = async (serverName, currentlyVisible) => {
    await onUpdateServer(serverName, { showInToolbar: !currentlyVisible });
  };
  
  const handleReorder = async (newOrderList) => {
    // newOrderList: [{ name: 'xxx', toolbarOrder: 0 }, ...]
    if (onBatchUpdateOrder) {
      await onBatchUpdateOrder(newOrderList);
    } else {
      // 回退方案：逐个更新
      for (const item of newOrderList) {
        await onUpdateServer(item.name, { toolbarOrder: item.toolbarOrder });
      }
    }
  };
  
  // 计算有多少启用但被隐藏的服务器
  const hiddenEnabledCount = sortedServers.filter(
    s => s.showInToolbar === false && enabledServers.has(s.name)
  ).length;
  
  return (
    <div className="flex items-center gap-1 relative">
      {/* 可见的服务器图标 */}
      {visibleServers.map(server => (
        <ServerIconButton
          key={server.name}
          server={server}
          isEnabled={enabledServers.has(server.name)}
          onToggle={onToggleServer}
          onContextMenu={handleContextMenu}
        />
      ))}
      
      {/* MCP 管理按钮 - 始终显示 */}
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={() => setShowDropdown(!showDropdown)}
          className={`
            p-2 rounded-full flex items-center justify-center
            transition-colors duration-200
            ${showDropdown 
              ? 'bg-blue-100 text-blue-600' 
              : 'text-gray-500 hover:bg-gray-200'
            }
          `}
          title="MCP Management"
        >
          <FiSettings className="text-lg" />
          {/* 如果有隐藏的已启用服务器，显示数量 */}
          {hiddenEnabledCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] 
                           bg-blue-500 text-white text-[10px] font-bold 
                           rounded-full flex items-center justify-center
                           border-2 border-white">
              {hiddenEnabledCount}
            </span>
          )}
        </button>
        
        <McpManagerDropdown
          servers={sortedServers}
          enabledServers={enabledServers}
          onToggle={onToggleServer}
          onToggleVisibility={handleToggleVisibility}
          onReorder={handleReorder}
          isOpen={showDropdown}
          onClose={() => setShowDropdown(false)}
          dropdownRef={dropdownRef}
          anchorRef={buttonRef}
        />
      </div>
      
      {/* 右键菜单 */}
      <ContextMenu
        server={contextMenu.server}
        position={contextMenu.position}
        onClose={() => setContextMenu({ server: null, position: { x: 0, y: 0 } })}
        onHide={handleHideFromToolbar}
        onEditIcon={onEditIcon}
        onDelete={onDeleteServer}
      />
    </div>
  );
};

export default McpToolbar;
export { renderIcon };
