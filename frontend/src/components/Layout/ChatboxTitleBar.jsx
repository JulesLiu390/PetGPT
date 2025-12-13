import React, { useState, useEffect } from 'react'
import { LuShare, LuPanelLeftOpen, LuPanelLeftClose } from "react-icons/lu";
import { HiOutlinePencilAlt } from "react-icons/hi";
import { MdClose } from "react-icons/md";
import { TbArrowsMaximize, TbArrowsMinimize } from "react-icons/tb";
import ChatboxTabBar from '../Chat/ChatboxTabBar';


export const ChatboxTitleBar = ({ activePetId, tabs, activeTabId, onTabClick, onCloseTab, onAddTab, onShare, sidebarOpen, onToggleSidebar }) => {
  const [titleInfo, setTitleInfo] = useState({ name: "PetGPT", model: "3.0" });
  const [isLargeWindow, setIsLargeWindow] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

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
    
    window.electron?.onWindowMaximized?.(handleMaximized);
    window.electron?.onWindowUnmaximized?.(handleUnmaximized);
    
    return () => {};
  }, []);

  useEffect(() => {
    const fetchPetInfo = async () => {
      if (!activePetId) return;
      try {
        // 优先尝试 getAssistant，失败则回退到 getPet
        let pet = null;
        try {
          pet = await window.electron.getAssistant(activePetId);
        } catch (e) {
          // 忽略，尝试旧 API
        }
        if (!pet) {
          pet = await window.electron.getPet(activePetId);
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
    window.electron?.hideChatWindow();
  };
  const handleMax = () => {
    window.electron?.maxmizeChatWindow();
  };
  const handleNew = () => {
    window.electron?.createNewChat();
  };


  return (
    <div className='draggable w-full h-9 flex items-center justify-between px-2 bg-slate-100 gap-2 relative z-30'>
      {/* Window Close Button (Only visible when NOT large window/sidebar hidden) */}
      {!isLargeWindow && (
        <div 
            className="no-drag flex-shrink-0 p-1 text-gray-400 hover:text-red-500 hover:bg-slate-200 rounded-md cursor-pointer transition-colors z-20 relative"
            onClick={handleClose}
            title="Close Window"
        >
            <MdClose size={14} />
        </div>
      )}

      {/* Left: Title / Model Info (Only visible when large window/sidebar visible) */}
      {isLargeWindow && (
        <div className="flex items-center gap-1 text-xs font-medium text-gray-600 cursor-default pl-1 flex-shrink-0 max-w-[100px] z-20 relative">
            <span className="truncate">{titleInfo.name}</span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-400 truncate">{titleInfo.model}</span>
        </div>
      )}

      {/* Middle: Tabs */}
      <div className="flex-1 w-0 min-w-0 h-full flex items-end mx-1 z-0">
        <ChatboxTabBar 
            tabs={tabs} 
            activeTabId={activeTabId} 
            onTabClick={onTabClick} 
            onCloseTab={onCloseTab} 
            onAddTab={onAddTab}
            compact={true}
        />
      </div>
      
      {/* Bottom white line that connects with active tab */}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white z-0"></div>

      {/* Right: Share and Sidebar Actions */}
      <div className="flex items-center gap-1.5 no-drag text-gray-500 flex-shrink-0 z-20 relative pl-1">
        <HiOutlinePencilAlt
            onClick={onAddTab}
            className="cursor-pointer hover:text-gray-800 text-lg p-0.5"
            title="New Chat"
        />
        <LuShare 
            onClick={onShare}
            className="cursor-pointer hover:text-gray-800 text-lg p-0.5" 
            title="Share" 
        />
        {/* 侧边栏切换按钮 - 全屏时不显示关闭侧边栏选项 */}
        {!isMaximized && (
          <div
            onClick={onToggleSidebar}
            className="cursor-pointer hover:text-gray-800 p-0.5"
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
          className="cursor-pointer hover:text-gray-800 p-0.5"
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