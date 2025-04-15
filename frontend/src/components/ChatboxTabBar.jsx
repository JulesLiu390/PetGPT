import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AiFillChrome, AiOutlinePlus, AiOutlineClose } from 'react-icons/ai';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';

const ChatboxTabBar = () => {
  const [{ navBarChats }, dispatch] = useStateValue();
  const [isTabSwitching, setIsTabSwitching] = useState(false);
  const [tabs, setTabs] = useState([]);

  const fetchConversationById = async (conversationId) => {
    try {
      return await window.electron.getConversationById(conversationId);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      throw error;
    }
  };

  // 添加一个 bypassLock 参数，默认 false；
  // 当 bypassLock 为 true 时，不检查 isTabSwitching 状态
  const handleTabClick = async (clickedId, bypassLock = false) => {
    const activeTab = tabs.find(tab => tab.isActive);
    if (activeTab.id == clickedId) return;
    if (isTabSwitching && !bypassLock) return; // 若处于锁定状态，则直接返回

    setIsTabSwitching(true);
    const conversation = await fetchConversationById(clickedId);
    window.electron?.sendMoodUpdate('normal');
    window.electron?.sendConversationId(conversation._id);
    dispatch({
      type: actionType.SET_MESSAGE,
      userMessages: conversation.history,
    });

    // 使用函数式更新保证使用最新的 tabs
    setTabs((prevTabs) =>
      prevTabs.map((tab) => ({ ...tab, isActive: tab.id === clickedId }))
    );
    // 1秒后解除锁定
    setTimeout(() => setIsTabSwitching(false), 800);
  };

  const handleTabClickForce = async (clickedId) => {

    const conversation = await fetchConversationById(clickedId);
    window.electron?.sendMoodUpdate('normal');
    window.electron?.sendConversationId(conversation._id);
    dispatch({
      type: actionType.SET_MESSAGE,
      userMessages: conversation.history,
    });

    // 使用函数式更新保证使用最新的 tabs
    setTabs((prevTabs) =>
      prevTabs.map((tab) => ({ ...tab, isActive: tab.id === clickedId }))
    );

  };

  useEffect(() => {
    const handleCharacterId = (id) => {
      dispatch({
        type: actionType.SET_NAVBAR_CHAT,
        navBarChats: [...navBarChats, id],
      });
      const fetchCharacter = async () => {
        const pet = await window.electron.getPet(id);
        const newConversation = await window.electron.createConversation({
          petId: pet._id,
          title: `${pet.name}`,
          history: [],
        });
        window.electron.sendConversationId(newConversation._id);
        handleAddTab(newConversation._id, pet.name, pet._id);
        handleTabClickForce(newConversation._id)
      };
      fetchCharacter();
    };
    window.electron?.onCharacterId(handleCharacterId);
  }, []);

  const handleAddTab = (_id, label, petId) => {
    setTabs((prevTabs) => {
      // 避免重复添加相同 ID 的标签
      const exists = prevTabs.some((tab) => tab.id === _id);
      if (exists) {
        return prevTabs.map((tab) => ({ ...tab, isActive: tab.id === _id }));
      }
      const newTab = {
        id: _id,
        label: label,
        petId: petId,
        icon: AiFillChrome,
        isActive: true,
      };
      return [
        ...prevTabs.map((tab) => ({ ...tab, isActive: false })), // 取消所有激活
        newTab,
      ];
    });
  };

  const handleAddTabClick = () => {
    const activeTab = tabs.find(tab => tab.isActive);
    window.electron.sendCharacterId(activeTab.petId);
  }

  const handleCloseTab = (e, closedId) => {
    e.stopPropagation();

    // 使用函数式更新 tabs，确保使用最新的状态
    setTabs((prevTabs) => {
      // 找出要关闭的 tab 是否是激活状态
      const closedTab = prevTabs.find((tab) => tab.id === closedId);
      // 移除关闭的 tab
      const newTabs = prevTabs.filter((tab) => tab.id !== closedId);
      // 如果关闭的是激活 tab，并且还剩下其他 tab，就使第一项激活
      if (closedTab?.isActive && newTabs.length > 0) {
        newTabs[0].isActive = true;
        // 通过 setTimeout 放入下一轮事件循环，确保 newTabs 更新完成
        setTimeout(() => {
          // bypassLock 参数设为 true，防止被 isTabSwitching 锁住
          handleTabClick(newTabs[0].id, true);
        }, 0);
      }
      return newTabs;
    });
  };

  return (
    <div className="w-full h-5 flex items-center">
      <div className="flex-1 h-full flex flex-nowrap overflow-hidden">
        {tabs.map((tab) => (
          <motion.div
            key={tab.id}
            whileHover={{ scale: 1.03 }}
            onClick={() => handleTabClick(tab.id)}
            className={`group relative flex-1 min-w-0 flex items-center justify-center rounded-xs cursor-pointer text-sm px-2 whitespace-nowrap overflow-hidden truncate max-w-[6rem] ${
              tab.isActive ? 'bg-white text-black' : 'bg-gray-100 text-gray-600'
            }`}
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
        onClick={handleAddTabClick}
        className="flex-none ml-2 p-1 text-gray-500 hover:text-gray-700"
      >
        <AiOutlinePlus size={20} />
      </motion.button>
    </div>
  );
};

export default ChatboxTabBar;