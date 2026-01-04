import React, { useEffect, useState } from 'react';
import ChatboxTitleBar from './ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';
import ChatboxMessageArea from './ChatboxMessageArea';
import { useStateValue } from '../context/StateProvider';
import { actionType } from '../context/reducer';
import { MdDelete } from 'react-icons/md';
import ChatboxTabBar from './ChatboxTabBar';
import * as bridge from '../utils/bridge';

export const Chatbox = () => {
  const [{ userMessages, suggestText }, dispatch] = useStateValue();
  const [conversations, setConversations] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [characterMood, setCharacterMood] = useState("")

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const data = await bridge.getConversations();
        setConversations(data);
      } catch (error) {
        console.error("Error fetching conversations:", error);
      }
    };
    fetchConversations();
  }, [userMessages]);

  // useEffect(() => {
  //   alert(suggestText)
  // }, [suggestText]);

  useEffect(() => {
    const moodUpdateHandler = (chatbodyStatus) => {
      setCharacterMood(chatbodyStatus);
    };
    const cleanup = bridge.onChatbodyStatusUpdated(moodUpdateHandler);

    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  useEffect(() => {
    setIsThinking(true);
    // alert(characterMood);
  }, [characterMood]);

  const fetchConversationById = async (conversationId) => {
    try {
      return await bridge.getConversationById(conversationId);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      throw error;
    }
  };

  const handleItemClick = async (conv) => {
    const conversation = await fetchConversationById(conv._id);
    bridge.sendMoodUpdate('normal');
    bridge.sendConversationId(conv._id);
    dispatch({
      type: actionType.SET_MESSAGE,
      userMessages: conversation.history
    });
  };

  const handleDelete = async (conversationId) => {
    const confirmDelete = await bridge.confirm("Are you sure you want to delete this conversation?", {
      title: 'Delete Conversation'
    });
    if (!confirmDelete) return;

    try {
      await bridge.deleteConversation(conversationId);
      setConversations((prevConvs) => prevConvs.filter((conv) => conv._id !== conversationId));
      
      dispatch({
        type: actionType.SET_MESSAGE,
        userMessages: []
      });

    } catch (error) {
      console.error("Error deleting conversation:", error);
      alert("Failed to delete conversation.");
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
              className="flex justify-between items-center hover:bg-gray-200 p-1 rounded cursor-pointer"
            >
              <span onClick={() => handleItemClick(conv)} className="flex-grow">
                {conv.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(conv._id);
                }}
                className="ml-2 flex items-center justify-center bg-gray-300 text-white py-1 px-2 rounded text-xs hover:bg-gray-400 transition-colors duration-200"
              >
                <MdDelete className="mr-1" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="h-full flex-1 flex flex-col justify-between">
        <ChatboxTitleBar />
        <ChatboxTabBar />
        {characterMood != "" && (
          <div className="text-center text-sm text-gray-600 animate-pulse">
            Memory updating: {characterMood}
          </div>
        )}
        {userMessages.length === 0 &&   
        <div className="flex-1 w-full max-w-full overflow-y-auto px-4 py-2 max-h-[80vh]">
          </div>}
        {userMessages.length > 0 && <ChatboxMessageArea />}
        <ChatboxInputArea className="w-full" />
      </div>
    </div>
  );
};

export default Chatbox;