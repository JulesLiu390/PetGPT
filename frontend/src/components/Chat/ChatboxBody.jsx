import React, { useEffect, useState, useRef } from 'react';
import ChatboxTitleBar from '../Layout/ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';
import ChatboxMessageArea from './ChatboxMessageArea';
import { useStateValue } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import { MdDelete, MdAdd, MdSearch, MdClose } from 'react-icons/md';
import { BsLayoutSidebar } from "react-icons/bs";
import { LuMaximize2 } from "react-icons/lu";
import { AiFillChrome } from 'react-icons/ai';
import ChatboxTabBar from './ChatboxTabBar';

export const Chatbox = () => {
  const [{ userMessages, suggestText, navBarChats, streamingReplies, updatedConversation }, dispatch] = useStateValue();
  const [conversations, setConversations] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [characterMood, setCharacterMood] = useState("")
  
  // Tab State
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const activeTabIdRef = useRef(null);

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const data = await window.electron.getConversations();
        if (Array.isArray(data)) {
            setConversations(data);
        } else {
            console.warn("getConversations returned non-array:", data);
            setConversations([]);
        }
      } catch (error) {
        console.error("Error fetching conversations:", error);
        setConversations([]);
      }
    };
    fetchConversations();
  }, [userMessages]); // Refresh list when messages change (e.g. new chat created)

  // Sync global userMessages to active tab
  useEffect(() => {
    if (activeTabId && userMessages) {
        setTabs(prevTabs => prevTabs.map(tab => {
            if (tab.id === activeTabId) {
                return { ...tab, messages: userMessages };
            }
            return tab;
        }));
    }
  }, [userMessages, activeTabId]);

  // 监听后台更新的会话消息（处理非激活 Tab 的更新）
  useEffect(() => {
    if (updatedConversation) {
        setTabs(prevTabs => prevTabs.map(tab => {
            if (tab.id === updatedConversation.id) {
                return { 
                    ...tab, 
                    messages: updatedConversation.messages,
                    label: updatedConversation.title ? updatedConversation.title : tab.label 
                };
            }
            return tab;
        }));
    }
  }, [updatedConversation]);

  useEffect(() => {
    const moodUpdateHandler = (chatbodyStatus) => {
      setCharacterMood(chatbodyStatus);
    };
    window.electron?.onChatbodyStatusUpdated(moodUpdateHandler);
    return () => {};
  }, []);

  useEffect(() => {
    setIsThinking(true);
  }, [characterMood]);

  // Handle New Tab from Character ID (moved from ChatboxTabBar)
  useEffect(() => {
    const handleCharacterId = (id) => {
      dispatch({
        type: actionType.SET_NAVBAR_CHAT,
        navBarChats: [...(navBarChats || []), id],
      });
      const fetchCharacter = async () => {
        const pet = await window.electron.getPet(id);
        const newConversation = await window.electron.createConversation({
          petId: pet._id,
          title: "New Chat",
          history: [],
        });
        window.electron.sendConversationId(newConversation._id);
        
        const newTab = {
            id: newConversation._id,
            label: "New Chat",
            petId: pet._id,
            messages: [],
            isActive: true
        };
        
        setTabs(prev => {
            if (prev.some(t => t.id === newTab.id)) return prev;
            return [...prev.map(t => ({...t, isActive: false})), newTab];
        });
        
        handleTabClick(newConversation._id);
      };
      fetchCharacter();
    };
    const cleanup = window.electron?.onCharacterId(handleCharacterId);
    return () => {
      if (cleanup) cleanup();
    };
  }, [navBarChats]); // Dependency on navBarChats might cause re-subscription, but it's acceptable

  const fetchConversationById = async (conversationId) => {
    try {
      return await window.electron.getConversationById(conversationId);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      throw error;
    }
  };

  const handleTabClick = async (clickedId) => {
    // Even if clicking active tab, we might want to ensure sync? 
    // But for performance, skip if same.
    if (activeTabId === clickedId) return;
    
    setActiveTabId(clickedId);
    activeTabIdRef.current = clickedId;
    
    setTabs(prev => prev.map(t => ({...t, isActive: t.id === clickedId})));

    // Find tab data
    const tab = tabs.find(t => t.id === clickedId);
    let messages = tab?.messages || [];

    // If messages empty, fetch
    if (messages.length === 0) {
         try {
            const conversation = await fetchConversationById(clickedId);
            messages = conversation.history;
            setTabs(prev => prev.map(t => t.id === clickedId ? { ...t, messages } : t));
         } catch (e) {
             console.error(e);
         }
    }

    // Sync global
    window.electron?.sendMoodUpdate('normal');
    window.electron?.sendConversationId(clickedId);
    
    dispatch({
      type: actionType.SET_MESSAGE,
      userMessages: messages,
    });
    dispatch({
        type: actionType.SET_CURRENT_CONVERSATION_ID,
        id: clickedId,
    });
  };

  const handleCloseTab = (e, closedId) => {
    e.stopPropagation();
    
    let nextActiveId = activeTabId;
    
    setTabs((prevTabs) => {
      const closedTab = prevTabs.find((tab) => tab.id === closedId);
      const newTabs = prevTabs.filter((tab) => tab.id !== closedId);
      
      if (closedTab?.id === activeTabId && newTabs.length > 0) {
        nextActiveId = newTabs[0].id;
        newTabs[0].isActive = true;
      } else if (newTabs.length === 0) {
        nextActiveId = null;
      }
      return newTabs;
    });

    if (nextActiveId && nextActiveId !== activeTabId) {
        setTimeout(() => handleTabClick(nextActiveId), 0);
    } else if (!nextActiveId) {
        setActiveTabId(null);
        activeTabIdRef.current = null;
        dispatch({ type: actionType.SET_MESSAGE, userMessages: [] });
        dispatch({ type: actionType.SET_CURRENT_CONVERSATION_ID, id: null });
    }
  };

  const handleAddTabClick = () => {
    handleNewChat();
  };

  const handleItemClick = async (conv) => {
    const existingTab = tabs.find(t => t.id === conv._id);
    if (existingTab) {
        handleTabClick(conv._id);
        return;
    }

    const conversation = await fetchConversationById(conv._id);
    const newTab = {
        id: conv._id,
        label: conv.title || "Chat",
        petId: conv.petId,
        messages: conversation.history,
        isActive: true
    };
    
    setTabs(prev => [...prev.map(t => ({...t, isActive: false})), newTab]);
    
    // Manually trigger switch logic
    setActiveTabId(conv._id);
    activeTabIdRef.current = conv._id;
    
    window.electron?.sendMoodUpdate('normal');
    window.electron?.sendConversationId(conv._id);
    dispatch({
      type: actionType.SET_MESSAGE,
      userMessages: conversation.history
    });
    dispatch({
        type: actionType.SET_CURRENT_CONVERSATION_ID,
        id: conv._id,
    });
  };

  const handleNewChat = () => {
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (activeTab) {
        window.electron.sendCharacterId(activeTab.petId);
    } else {
        window.electron?.changeSelectCharacterWindow();
    }
  };

  const handleShare = () => {
    // Placeholder for share functionality
    console.log("Share button clicked");
  };

  const handleDelete = async (e, conversationId) => {
    e.stopPropagation();
    const confirmDelete = window.confirm("Are you sure you want to delete this conversation?");
    if (!confirmDelete) return;

    try {
      await window.electron.deleteConversation(conversationId);
      setConversations((prevConvs) => prevConvs.filter((conv) => conv._id !== conversationId));
      
      // Also close tab if open
      if (tabs.some(t => t.id === conversationId)) {
          handleCloseTab(e, conversationId);
      }

    } catch (error) {
      console.error("Error deleting conversation:", error);
      alert("Failed to delete conversation.");
    }
  };

  const handleClose = () => {
    window.electron?.hideChatWindow();
  };
  const handleMax = () => {
    window.electron?.maxmizeChatWindow();
  };

  return (
    <div className="h-full flex bg-white">
      {/* Sidebar */}
      <div className="hidden lg:flex lg:flex-col lg:w-64 bg-[#f9f9f9] border-r border-gray-200 h-full">
        
        {/* Window Controls & Sidebar Toggle */}
        <div className="p-3 pt-4 draggable flex items-center justify-between">
            <div className="flex items-center gap-2 no-drag px-2">
                <div onClick={handleClose} className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 cursor-pointer flex items-center justify-center group">
                    <MdClose className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
                </div>
                <div onClick={handleMax} className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 cursor-pointer flex items-center justify-center group">
                    <LuMaximize2 className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
                </div>
                <div className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 cursor-pointer flex items-center justify-center group"></div>
            </div>
            
            <div className="flex items-center gap-3 no-drag text-gray-500">
                <BsLayoutSidebar className="cursor-pointer hover:text-gray-800" title="Toggle Sidebar" />
                <MdAdd onClick={handleNewChat} className="text-xl cursor-pointer hover:text-gray-800" title="New Chat" />
            </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2 pt-2">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-200/50 rounded-md text-gray-500 text-xs">
                <MdSearch className="text-sm" />
                <span>Search</span>
            </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Recent
          </div>
          {conversations.map((conv) => (
            <div
              key={conv._id}
              onClick={() => handleItemClick(conv)}
              className="group flex items-center justify-between p-2 rounded-lg hover:bg-[#ececec] cursor-pointer transition-colors text-sm text-gray-700"
            >
              <span className="truncate flex-1 pr-2 text-[#0d0d0d]">{conv.title}</span>
              <MdDelete 
                onClick={(e) => handleDelete(e, conv._id)}
                className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity text-lg" 
              />
            </div>
          ))}
        </div>

        {/* User Info */}
        <div className="p-3 border-t border-gray-200">
            <div className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-200 cursor-pointer">
                <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold">JL</div>
                <div className="text-sm font-medium text-gray-700">Jules Liu</div>
            </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="h-full flex-1 flex flex-col justify-between bg-white relative">
        <ChatboxTitleBar 
            activePetId={tabs.find(t => t.id === activeTabId)?.petId} 
            tabs={tabs} 
            activeTabId={activeTabId} 
            onTabClick={handleTabClick} 
            onCloseTab={handleCloseTab}
            onAddTab={handleAddTabClick}
            onShare={handleShare}
        />
        {characterMood != "" && (
          <div className="text-center text-sm text-gray-600 animate-pulse absolute top-10 left-0 right-0 z-10 pointer-events-none">
            Memory updating: {characterMood}
          </div>
        )}
        
        <div className="flex-1 overflow-hidden relative flex flex-col">
             {tabs.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-gray-300">
                    Start a new conversation...
                </div>
             ) : (
                tabs.map(tab => (
                    <div 
                        key={tab.id} 
                        style={{ display: tab.id === activeTabId ? 'flex' : 'none' }} 
                        className="flex-1 flex flex-col h-full"
                    >
                        <ChatboxMessageArea 
                            messages={tab.messages} 
                            streamingContent={streamingReplies ? streamingReplies[tab.id] : null} 
                            isActive={tab.id === activeTabId} 
                        />
                    </div>
                ))
             )}
        </div>
        
        <div className="w-full">
            <ChatboxInputArea 
                className="w-full" 
                activePetId={tabs.find(t => t.id === activeTabId)?.petId}
            />
        </div>
      </div>
    </div>
  );
};

export default Chatbox;