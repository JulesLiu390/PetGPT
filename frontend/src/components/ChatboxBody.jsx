import React, { useEffect, useState } from 'react';
import ChatboxTitleBar from './ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';
import ChatboxMessageArea from './ChatboxMessageArea';
import { useStateValue } from '../content/StateProvider';
import { getRecentConversations, getConversation } from '../utlis/api';

export const Chatbox = () => {
  const [{ userMessages }, dispatch] = useStateValue();
  const [conversations, setConversations] = useState([]);

  // 加载最近会话列表
  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const data = await getRecentConversations();
        setConversations(data);
      } catch (error) {
        console.error("Error fetching conversations:", error);
      }
    };
    fetchConversations();
  }, []);

  // 点击会话后自动加载该会话详细消息（history），同时将角色ID传递给 Electron
  const handleItemClick = async (conv) => {
    try {
      const conversation = await getConversation(conv._id);
      console.log("Loaded conversation:", conversation);
      window.electron?.sendCharacterId(conversation.petId);
      // 更新全局状态中的消息历史
      dispatch({
        type: 'SET_USER_MESSAGES',
        userMessages: conversation.history || []
      });
      // 如果 conversation.petId 存在，则传给 Electron
      if (conversation.petId) {
        window.electron?.sendCharacterId(conversation.petId);
      }
    } catch (error) {
      console.error("Error loading conversation:", error);
      alert("Error loading conversation: " + error.message);
    }
  };

  return (
    <div className="h-full flex">
      <div className="hidden lg:block lg:w-60 bg-gray-100 p-3 border-r overflow-y-auto text-sm">
        <div className="font-bold mb-2">Conversations</div>
        <ul className="space-y-2">
          {conversations.map((conv) => (
            <li
              key={conv._id}
              onClick={() => handleItemClick(conv)}
              className="hover:bg-gray-200 p-1 rounded cursor-pointer"
            >
              {conv.title}
            </li>
          ))}
        </ul>
      </div>
      <div className="h-full w-full flex flex-col justify-between">
        <ChatboxTitleBar />
        {userMessages.length > 0 && <ChatboxMessageArea />}
        <ChatboxInputArea className="w-full" />
      </div>
    </div>
  );
};

export default Chatbox;