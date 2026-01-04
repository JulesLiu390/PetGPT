/**
 * 图标选择器组件
 * 支持选择 emoji 或 react-icons 图标
 */
import React, { useState, useRef, useEffect } from 'react';
import * as FaIcons from 'react-icons/fa6';
import * as FiIcons from 'react-icons/fi';

// 常用 emoji 列表 (工具相关)
const COMMON_EMOJIS = [
  '🔧', '🔨', '⚙️', '🛠️', '🔩', '🔌',
  '🔍', '🔎', '📊', '📈', '📉', '📋',
  '🌐', '🌍', '🌎', '🌏', '☁️', '💾',
  '📁', '📂', '📄', '📝', '✏️', '📌',
  '💡', '⚡', '🔥', '💫', '✨', '🎯',
  '🤖', '🧠', '💻', '🖥️', '📱', '⌨️',
  '🔒', '🔓', '🔑', '🛡️', '🔐', '🚀',
  '📡', '🎨', '🎵', '🎬', '📷', '🎮',
  '💬', '📧', '📨', '📩', '💌', '📮',
  '🏠', '🏢', '🏗️', '🗂️', '📚', '📖'
];

// 常用 react-icons (Feather Icons)
const FEATHER_ICONS = [
  'FiSearch', 'FiCode', 'FiDatabase', 'FiServer', 'FiCloud',
  'FiGlobe', 'FiTerminal', 'FiCpu', 'FiHardDrive', 'FiWifi',
  'FiSettings', 'FiTool', 'FiZap', 'FiActivity', 'FiLayers',
  'FiBox', 'FiPackage', 'FiFolder', 'FiFile', 'FiFileText',
  'FiGitBranch', 'FiGitCommit', 'FiGithub', 'FiLink', 'FiAnchor',
  'FiCompass', 'FiMap', 'FiNavigation', 'FiSend', 'FiShare2',
  'FiMail', 'FiMessageSquare', 'FiMessageCircle', 'FiEdit', 'FiEdit3',
  'FiCamera', 'FiImage', 'FiMusic', 'FiVideo', 'FiMic',
  'FiLock', 'FiUnlock', 'FiShield', 'FiKey', 'FiEye',
  'FiBookmark', 'FiStar', 'FiHeart', 'FiAward', 'FiFlag'
];

// 常用 react-icons (Font Awesome 6)
const FA6_ICONS = [
  'FaRobot', 'FaMicrochip', 'FaNetworkWired', 'FaServer', 'FaDatabase',
  'FaCode', 'FaTerminal', 'FaLaptopCode', 'FaGears', 'FaToolbox',
  'FaMagnifyingGlass', 'FaWandMagicSparkles', 'FaBolt', 'FaFire', 'FaRocket',
  'FaBrain', 'FaLightbulb', 'FaPuzzlePiece', 'FaCubes', 'FaCube',
  'FaGlobe', 'FaEarthAmericas', 'FaCloud', 'FaCloudArrowUp', 'FaCloudArrowDown',
  'FaFolder', 'FaFolderOpen', 'FaFile', 'FaFileCode', 'FaFileLines',
  'FaGithub', 'FaGitAlt', 'FaDocker', 'FaPython', 'FaJs',
  'FaEnvelope', 'FaComments', 'FaMessage', 'FaPaperPlane', 'FaShareNodes',
  'FaLock', 'FaUnlock', 'FaShield', 'FaKey', 'FaFingerprint',
  'FaChartLine', 'FaChartBar', 'FaChartPie', 'FaTableCells', 'FaList'
];

/**
 * 根据图标名称渲染图标
 */
const renderReactIcon = (iconName, className = '') => {
  let IconComponent = null;
  
  if (iconName.startsWith('Fi')) {
    IconComponent = FiIcons[iconName];
  } else if (iconName.startsWith('Fa')) {
    IconComponent = FaIcons[iconName];
  }
  
  if (IconComponent) {
    return <IconComponent className={className} />;
  }
  
  return null;
};

/**
 * 图标选择器组件
 * @param {Object} props
 * @param {string} props.value - 当前选中的图标
 * @param {Function} props.onChange - 图标变更回调
 * @param {Function} props.onClose - 关闭选择器回调
 * @param {boolean} props.isOpen - 是否打开
 */
const IconSelector = ({ value, onChange, onClose, isOpen }) => {
  const [activeTab, setActiveTab] = useState('emoji');
  const [customInput, setCustomInput] = useState('');
  const containerRef = useRef(null);
  
  // 不再使用 mousedown 监听，改为在触发按钮中处理关闭逻辑
  // 这样可以避免点击内部元素时误关闭
  
  if (!isOpen) return null;
  
  const handleSelect = (icon) => {
    onChange(icon);
    onClose();
  };
  
  const handleCustomSubmit = () => {
    if (customInput.trim()) {
      onChange(customInput.trim());
      onClose();
    }
  };
  
  // 阻止点击事件冒泡，避免触发外部的 clickOutside 监听
  const stopPropagation = (e) => {
    e.stopPropagation();
  };
  
  return (
    <div 
      ref={containerRef}
      className="bg-white rounded-xl shadow-2xl border border-gray-200 
               w-80 max-h-96 overflow-hidden"
      onMouseDown={stopPropagation}
      onClick={stopPropagation}
    >
      {/* 标签页 */}
      <div className="flex border-b border-gray-200">
        <button
          type="button"
          onMouseDown={stopPropagation}
          onClick={(e) => { e.stopPropagation(); setActiveTab('emoji'); }}
          className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors
            ${activeTab === 'emoji' 
              ? 'text-blue-600 border-b-2 border-blue-600 -mb-px' 
              : 'text-gray-500 hover:text-gray-800'
            }`}
        >
          Emoji
        </button>
        <button
          type="button"
          onMouseDown={stopPropagation}
          onClick={(e) => { e.stopPropagation(); setActiveTab('feather'); }}
          className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors
            ${activeTab === 'feather' 
              ? 'text-blue-600 border-b-2 border-blue-600 -mb-px' 
              : 'text-gray-500 hover:text-gray-800'
            }`}
        >
          Feather
        </button>
        <button
          type="button"
          onMouseDown={stopPropagation}
          onClick={(e) => { e.stopPropagation(); setActiveTab('fa6'); }}
          className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors
            ${activeTab === 'fa6' 
              ? 'text-blue-600 border-b-2 border-blue-600 -mb-px' 
              : 'text-gray-500 hover:text-gray-800'
            }`}
        >
          FA6
        </button>
        <button
          type="button"
          onMouseDown={stopPropagation}
          onClick={(e) => { e.stopPropagation(); setActiveTab('custom'); }}
          className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors
            ${activeTab === 'custom' 
              ? 'text-blue-600 border-b-2 border-blue-600 -mb-px' 
              : 'text-gray-500 hover:text-gray-800'
            }`}
        >
          自定义
        </button>
      </div>
      
      {/* 内容区 */}
      <div className="p-3 overflow-y-auto max-h-72">
        {/* Emoji 标签页 */}
        {activeTab === 'emoji' && (
          <div className="grid grid-cols-8 gap-1">
            {COMMON_EMOJIS.map((emoji, index) => (
              <button
                key={index}
                onClick={() => handleSelect(emoji)}
                className={`w-8 h-8 flex items-center justify-center text-lg rounded-lg
                  transition-colors hover:bg-gray-100
                  ${value === emoji ? 'bg-blue-100 ring-1 ring-blue-500' : ''}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        
        {/* Feather Icons 标签页 */}
        {activeTab === 'feather' && (
          <div className="grid grid-cols-8 gap-1">
            {FEATHER_ICONS.map((iconName) => (
              <button
                key={iconName}
                onClick={() => handleSelect(iconName)}
                className={`w-8 h-8 flex items-center justify-center rounded-lg
                  transition-colors hover:bg-gray-100 text-gray-600
                  ${value === iconName ? 'bg-blue-100 ring-1 ring-blue-500 text-blue-600' : ''}`}
                title={iconName}
              >
                {renderReactIcon(iconName)}
              </button>
            ))}
          </div>
        )}
        
        {/* Font Awesome 6 标签页 */}
        {activeTab === 'fa6' && (
          <div className="grid grid-cols-8 gap-1">
            {FA6_ICONS.map((iconName) => (
              <button
                key={iconName}
                onClick={() => handleSelect(iconName)}
                className={`w-8 h-8 flex items-center justify-center rounded-lg
                  transition-colors hover:bg-gray-100 text-gray-600
                  ${value === iconName ? 'bg-blue-100 ring-1 ring-blue-500 text-blue-600' : ''}`}
                title={iconName}
              >
                {renderReactIcon(iconName)}
              </button>
            ))}
          </div>
        )}
        
        {/* 自定义输入标签页 */}
        {activeTab === 'custom' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              输入 emoji 字符或 react-icons 名称 (如 FiSearch, FaRobot)
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="🔧 或 FiSearch"
                className="flex-1 px-3 py-2 bg-white border border-gray-300 rounded-lg
                         text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 
                         focus:ring-blue-500 focus:border-transparent"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCustomSubmit();
                  }
                }}
              />
              <button
                onClick={handleCustomSubmit}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500
                         transition-colors"
              >
                确定
              </button>
            </div>
            
            {/* 预览 */}
            {customInput && (
              <div className="flex items-center gap-3 p-3 bg-gray-100 rounded-lg">
                <span className="text-sm text-gray-500">预览:</span>
                <span className="text-2xl">
                  {customInput.startsWith('Fi') || customInput.startsWith('Fa')
                    ? renderReactIcon(customInput, 'text-gray-800')
                    : customInput
                  }
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* 当前选中 */}
      <div className="px-3 py-2 border-t border-gray-200 flex items-center justify-between bg-gray-50">
        <span className="text-xs text-gray-500">当前:</span>
        <span className="text-lg">
          {value && (value.startsWith('Fi') || value.startsWith('Fa'))
            ? renderReactIcon(value, 'text-gray-800')
            : value || '🔧'
          }
        </span>
      </div>
    </div>
  );
};

/**
 * 图标选择器触发按钮 (带弹出面板)
 * @param {Object} props
 * @param {string} props.value - 当前选中的图标
 * @param {Function} props.onChange - 图标变更回调
 * @param {string} props.className - 额外的 CSS 类名
 */
const IconSelectorTrigger = ({ value, onChange, className = '' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  
  // 点击外部关闭 - 使用 click 事件而非 mousedown
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e) => {
      // 检查点击是否在触发按钮内
      if (triggerRef.current && triggerRef.current.contains(e.target)) {
        return;
      }
      // 检查点击是否在弹出层内
      if (popoverRef.current && popoverRef.current.contains(e.target)) {
        return;
      }
      setIsOpen(false);
    };
    
    // 延迟添加监听器，避免当前点击触发关闭
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside, true);
    }, 10);
    
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClickOutside, true);
    };
  }, [isOpen]);
  
  const renderCurrentIcon = () => {
    if (!value) return '🔧';
    
    if (value.startsWith('Fi') || value.startsWith('Fa')) {
      return renderReactIcon(value, 'text-xl');
    }
    
    return value;
  };
  
  const handleToggle = (e) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };
  
  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className="w-10 h-10 flex items-center justify-center text-xl
                 bg-white border border-gray-300 rounded-md
                 hover:border-gray-400 hover:bg-gray-50
                 transition-colors focus:outline-none focus:ring-2 
                 focus:ring-blue-500 focus:border-blue-500"
        title="选择图标"
      >
        {renderCurrentIcon()}
      </button>
      
      {isOpen && (
        <div ref={popoverRef} className="absolute top-full left-0 mt-2 z-50">
          <IconSelector
            value={value}
            onChange={onChange}
            onClose={() => setIsOpen(false)}
            isOpen={true}
          />
        </div>
      )}
    </div>
  );
};

export default IconSelector;
export { IconSelector, IconSelectorTrigger, renderReactIcon };
