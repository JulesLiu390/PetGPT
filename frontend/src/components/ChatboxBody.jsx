import React, { useEffect, useState } from 'react';
import ChatboxTitleBar from './ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';
import ChatboxMessageArea from './ChatboxMessageArea';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { MdDelete } from 'react-icons/md';
import ChatboxTabBar from './ChatboxTabBar';

export const Chatbox = () => {
  const [{ userMessages, suggestText }, dispatch] = useStateValue();
  const [conversations, setConversations] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [characterMood, setCharacterMood] = useState("")

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const data = await window.electron.getConversations();
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
      // alert(string(chatbodyStatus))
    };
    window.electron?.onChatbodyStatusUpdated(moodUpdateHandler);

    // 如果需要在组件卸载时移除监听，可在此处调用 removeListener
    return () => {
      // window.electron?.removeMoodUpdated(moodUpdateHandler);
    };
  }, []);

  useEffect(() => {
    setIsThinking(true);
    // alert(characterMood);
  }, [characterMood]);

  const fetchConversationById = async (conversationId) => {
    try {
      return await window.electron.getConversationById(conversationId);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      throw error;
    }
  };

  const handleItemClick = async (conv) => {
    const conversation = await fetchConversationById(conv._id);
    window.electron?.sendMoodUpdate('normal');
    window.electron?.sendCharacterId(conversation.petId);
    window.electron?.sendConversationId(conv._id);
    dispatch({
      type: actionType.SET_MESSAGE,
      userMessages: conversation.history
    });
  };

  const handleDelete = async (conversationId) => {
    const confirmDelete = window.confirm("Are you sure you want to delete this conversation?");
    if (!confirmDelete) return;

    try {
      await window.electron.deleteConversation(conversationId);
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