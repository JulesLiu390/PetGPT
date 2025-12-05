import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AiOutlineClose, AiOutlineDown } from 'react-icons/ai';

const ChatboxTabBar = ({ tabs, activeTabId, onTabClick, onCloseTab, onAddTab, compact = false }) => {
  const [showDropdown, setShowDropdown] = useState(false);

  return (
    <div className={`draggable w-full h-full flex items-center px-1 gap-1 min-w-0 ${compact ? 'h-full' : 'h-8 mt-1'}`}>
      {/* Scrollable Tabs Area */}
      <div className="flex-1 w-0 min-w-0 h-full flex flex-nowrap overflow-x-auto scrollbar-hide gap-1 items-end mask-linear-fade">
        {tabs.map((tab) => (
          <motion.div
            key={tab.id}
            initial={false}
            onClick={() => onTabClick(tab.id)}
            className={`no-drag group relative flex-1 min-w-[50px] max-w-[140px] flex items-center justify-between rounded-t-md cursor-pointer text-[10px] px-2 transition-all duration-200 border-t border-x ${
              tab.id === activeTabId 
                ? 'bg-white text-gray-800 border-gray-200 shadow-sm z-10 h-full pt-1' 
                : 'bg-gray-50 text-gray-500 border-transparent hover:bg-gray-100 h-[80%] mb-0 pt-0.5'
            }`}
          >
            <span className="truncate flex-1 text-center">{tab.label}</span>
            <AiOutlineClose
              onClick={(e) => { e.stopPropagation(); onCloseTab(e, tab.id); }}
              className={`ml-1 text-gray-400 hover:text-red-500 cursor-pointer ${
                tab.id === activeTabId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              size={10}
            />
          </motion.div>
        ))}
      </div>

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
                    </motion.div>
                    </>
                )}
            </AnimatePresence>
         </div>
      </div>
    </div>
  );
};export default ChatboxTabBar;