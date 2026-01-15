import React, { useState } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { AiOutlineClose, AiOutlineDown } from 'react-icons/ai';

const ChatboxTabBar = ({ tabs, activeTabId, onTabClick, onCloseTab, onCloseAllTabs, onAddTab, onReorderTabs, compact = false }) => {
  const [showDropdown, setShowDropdown] = useState(false);

  // 处理拖拽排序
  const handleReorder = (newOrder) => {
    onReorderTabs?.(newOrder);
  };

  return (
    <div className={`draggable w-full h-full flex items-center px-1 gap-1 min-w-0 ${compact ? 'h-full' : 'h-8 mt-1'}`} data-tauri-drag-region>
      {/* Scrollable Tabs Area with Reorder */}
      <Reorder.Group
        axis="x"
        values={tabs}
        onReorder={handleReorder}
        className="flex-1 w-0 min-w-0 h-full flex flex-nowrap overflow-x-auto scrollbar-thin gap-1 items-center mask-linear-fade"
        data-tauri-drag-region
      >
        <AnimatePresence mode="popLayout">
          {tabs.map((tab) => (
            <Reorder.Item
              key={tab.id}
              value={tab}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ 
                layout: { duration: 0.2, ease: "easeOut" },
                opacity: { duration: 0.15 }
              }}
              whileDrag={{ 
                scale: 1.05, 
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                zIndex: 50,
                cursor: "grabbing"
              }}
              onClick={() => onTabClick(tab.id)}
              className={`no-drag group relative flex-1 min-w-[60px] max-w-[160px] flex items-center justify-between cursor-pointer text-[11px] px-3 py-1.5 rounded-full transition-colors duration-150 ${
                tab.id === activeTabId 
                  ? 'bg-white/70 text-gray-700 font-medium shadow-sm' 
                  : 'bg-transparent text-gray-500 hover:bg-white/40'
              }`}
            >
              <span className="truncate flex-1 text-center pointer-events-none">{tab.label}</span>
              <AiOutlineClose
                onClick={(e) => { e.stopPropagation(); onCloseTab(e, tab.id); }}
                className={`ml-1 text-gray-400 hover:text-red-500 cursor-pointer pointer-events-auto ${
                  tab.id === activeTabId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                size={10}
              />
            </Reorder.Item>
          ))}
        </AnimatePresence>
      </Reorder.Group>

      {/* Actions: Dropdown */}
      <div className="flex items-center gap-0.5 no-drag flex-shrink-0">
         <div className="relative">
            <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors"
            >
                <AiOutlineDown size={12} />
            </button>
            
            {/* Dropdown Menu */}
            <AnimatePresence>
                {showDropdown && (
                    <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
                    <motion.div
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 5 }}
                        className="absolute right-0 top-full mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-1 z-50 max-h-60 overflow-y-auto"
                    >
                        {tabs.map(tab => (
                            <div 
                                key={tab.id}
                                onClick={() => { onTabClick(tab.id); setShowDropdown(false); }}
                                className={`px-3 py-2 text-xs flex items-center justify-between hover:bg-gray-50 cursor-pointer ${
                                    tab.id === activeTabId ? 'text-blue-600 font-medium bg-blue-50' : 'text-gray-600'
                                }`}
                            >
                                <span className="truncate">{tab.label}</span>
                                <AiOutlineClose 
                                    onClick={(e) => { e.stopPropagation(); onCloseTab(e, tab.id); }}
                                    className="text-gray-400 hover:text-red-500"
                                />
                            </div>
                        ))}
                        {/* Close All Divider & Button */}
                        {tabs.length > 0 && (
                          <>
                            <div className="border-t border-gray-100 my-1" />
                            <div 
                                onClick={() => { onCloseAllTabs?.(); setShowDropdown(false); }}
                                className="px-3 py-2 text-xs text-red-500 hover:bg-red-50 cursor-pointer flex items-center gap-1"
                            >
                                <AiOutlineClose size={10} />
                                <span>Close All</span>
                            </div>
                          </>
                        )}
                    </motion.div>
                    </>
                )}
            </AnimatePresence>
         </div>
      </div>
    </div>
  );
};export default ChatboxTabBar;