import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { AiFillChrome, AiOutlinePlus, AiOutlineClose } from 'react-icons/ai';

const ChatboxTabBar = () => {
  const [tabs, setTabs] = useState([
    { id: 1, label: 'Tab', icon: AiFillChrome, isActive: true },
  ]);

  const handleTabClick = (clickedId) => {
    setTabs(tabs.map((tab) => ({ ...tab, isActive: tab.id === clickedId })));
  };

  const handleAddTab = () => {
    const newTab = {
      id: Date.now(),
      label: 'Tab',
      icon: AiFillChrome,
      isActive: false,
    };
    // 设置所有现有 tab 为非激活，并添加新 tab 作为激活状态
    setTabs([...tabs.map((tab) => ({ ...tab, isActive: false })), { ...newTab, isActive: true }]);
  };

  const handleCloseTab = (e, closedId) => {
    e.stopPropagation();
    const remainingTabs = tabs.filter((tab) => tab.id !== closedId);
    // 如果关闭的 tab 是激活状态，则让第一个剩余的 tab 成为激活状态
    if (!remainingTabs.some((tab) => tab.isActive) && remainingTabs.length > 0) {
      remainingTabs[0].isActive = true;
    }
    setTabs(remainingTabs);
  };

  return (
    <div className="w-full h-5 flex items-center">
      <div className="flex-1 h-full flex flex-nowrap overflow-hidden">
        {tabs.map((tab) => (
          <motion.div
            key={tab.id}
            whileHover={{ scale: 1.03 }}
            onClick={() => handleTabClick(tab.id)}
            // 使用条件渲染 Tailwind 类设置背景及文字颜色，最大宽度设置为 max-w-[6rem]（即 24 的 tailwind 尺寸）
            className={`group relative flex-1 min-w-0 flex items-center justify-center rounded-xs cursor-pointer text-sm px-2 whitespace-nowrap overflow-hidden truncate max-w-[6rem] ${tab.isActive ? 'bg-white text-black' : 'bg-gray-100 text-gray-600'}`}
          >
            <span>{tab.label}</span>
            <AiOutlineClose
              onClick={(e) => handleCloseTab(e, tab.id)}
              className="absolute right-1 text-gray-400 hover:text-gray-600 hidden group-hover:block cursor-pointer"
            />
          </motion.div>
        ))}
      </div>
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        onClick={handleAddTab}
        className="flex-none ml-2 p-1 text-gray-500 hover:text-gray-700"
      >
        <AiOutlinePlus size={20} />
      </motion.button>
    </div>
  );
};

export default ChatboxTabBar;