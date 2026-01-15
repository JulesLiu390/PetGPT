import React, { useState, useEffect } from 'react'
import { LuShare, LuPanelLeftOpen, LuPanelLeftClose } from "react-icons/lu";
import { HiOutlinePencilAlt } from "react-icons/hi";
import { MdClose } from "react-icons/md";
import { TbArrowsMaximize, TbArrowsMinimize } from "react-icons/tb";
import ChatboxTabBar from '../Chat/ChatboxTabBar';
import tauri from '../../utils/tauri';


export const ChatboxTitleBar = ({ activePetId, tabs, activeTabId, onTabClick, onCloseTab, onCloseAllTabs, onAddTab, onReorderTabs, onShare, sidebarOpen, isMouseOver, onToggleSidebar }) => {
  const [titleInfo, setTitleInfo] = useState({ name: "PetGPT", model: "3.0" });
  const [isLargeWindow, setIsLargeWindow] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  
  // 当侧边栏打开或鼠标悬停在窗口上时显示控制按钮
  const showControls = sidebarOpen || isMouseOver;

  useEffect(() => {
    const handleResize = () => {
        // Check if window width matches the 'lg' breakpoint (1024px) used for sidebar visibility
        if (window.innerWidth >= 1024) {
            setIsLargeWindow(true);
        } else {
            setIsLargeWindow(false);
        }
    };

    window.addEventListener('resize', handleResize);
    handleResize(); // Initial check

    return () => {
        window.removeEventListener('resize', handleResize);
    };
  }, []);

  // 监听窗口最大化/还原状态
  useEffect(() => {
    const handleMaximized = () => setIsMaximized(true);
    const handleUnmaximized = () => setIsMaximized(false);
    
    tauri.onWindowMaximized?.(handleMaximized);
    tauri.onWindowUnmaximized?.(handleUnmaximized);
    
    return () => {};
  }, []);

  useEffect(() => {
    const fetchPetInfo = async () => {
      if (!activePetId) return;
      try {
        // 优先尝试 getAssistant，失败则回退到 getPet
        let pet = null;
        try {
          pet = await tauri.getAssistant(activePetId);
        } catch (e) {
          // 忽略，尝试旧 API
        }
        if (!pet) {
          pet = await tauri.getPet(activePetId);
        }
        if (pet) {
          setTitleInfo({
            name: pet.name || "PetGPT",
            model: pet.modelName || "3.0"
          });
        }
      } catch (error) {
        console.error("Error fetching pet info for title bar:", error);
      }
    };

    fetchPetInfo();
  }, [activePetId]);

  // Title bar component
  const handleClose = () => {
    tauri.hideChatWindow?.();
  };
  const handleMax = () => {
    tauri.maxmizeChatWindow?.();
  };
  const handleNew = () => {
    tauri.createNewChat?.();
  };


  return (
    <div 
      className="draggable select-none cursor-default w-full h-9 flex items-center justify-between px-2 gap-2 relative z-30" 
      data-tauri-drag-region
    >
      {/* Left: Close Button (no-drag) + Title */}
      <div className="flex items-center gap-2 flex-shrink-0 z-20 relative">
        {/* Window Close Button - 圆形深灰色背景，侧边栏打开时隐藏 */}
        {!sidebarOpen && (
          <div 
              className="no-drag flex-shrink-0 w-4 h-4 flex items-center justify-center bg-gray-500 hover:bg-gray-600 rounded-full cursor-pointer transition-all duration-200"
              onClick={handleClose}
              title="Close Window"
          >
              <MdClose size={10} className="text-white" />
          </div>
        )}
        
        {/* Title / Model Info (Only visible when large window/sidebar visible) */}
        {isLargeWindow && (
          <div className="flex items-center gap-1 text-xs font-medium text-gray-600 cursor-default max-w-[100px]" data-tauri-drag-region>
              <span className="truncate">{titleInfo.name}</span>
              <span className="text-gray-300">|</span>
              <span className="text-gray-400 truncate">{titleInfo.model}</span>
          </div>
        )}
      </div>

      {/* Middle: Tabs */}
      <div className="flex-1 w-0 min-w-0 h-full flex items-end mx-1 z-0" data-tauri-drag-region>
        <ChatboxTabBar 
            tabs={tabs} 
            activeTabId={activeTabId} 
            onTabClick={onTabClick} 
            onCloseTab={onCloseTab} 
            onCloseAllTabs={onCloseAllTabs}
            onAddTab={onAddTab}
            onReorderTabs={onReorderTabs}
            compact={true}
        />
      </div>
      
      {/* Bottom line removed for transparent look */}

      {/* Right: Share and Sidebar Actions (no-drag for buttons only) */}
      <div className="flex items-center gap-1.5 text-gray-500 flex-shrink-0 z-20 relative pl-1" data-tauri-drag-region>
        <div className="no-drag">
          <HiOutlinePencilAlt
              onClick={onAddTab}
              className="cursor-pointer hover:text-gray-800 text-lg p-0.5"
              title="New Chat"
          />
        </div>
        <div className="no-drag">
          <LuShare 
              onClick={onShare}
              className="cursor-pointer hover:text-gray-800 text-lg p-0.5" 
              title="Share" 
          />
        </div>
        {/* 侧边栏切换按钮 - 全屏时不显示关闭侧边栏选项 */}
        {!isMaximized && (
          <div
            onClick={onToggleSidebar}
            className="no-drag cursor-pointer hover:text-gray-800 p-0.5"
            title={sidebarOpen ? "Close Sidebar" : "Open Sidebar"}
          >
            {sidebarOpen ? (
              <LuPanelLeftOpen className="text-lg" />
            ) : (
              <LuPanelLeftClose className="text-lg" />
            )}
          </div>
        )}
        {/* 最大化/还原按钮 */}
        <div
          onClick={handleMax}
          className="no-drag cursor-pointer hover:text-gray-800 p-0.5"
          title={isMaximized ? "Exit Full Screen" : "Full Screen"}
        >
          {isMaximized ? (
            <TbArrowsMinimize className="text-lg" />
          ) : (
            <TbArrowsMaximize className="text-lg" />
          )}
        </div>
      </div>
    </div>
  )
}

export default ChatboxTitleBar;