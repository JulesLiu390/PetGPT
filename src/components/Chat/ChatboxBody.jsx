import React, { useEffect, useState, useRef, useCallback } from 'react';
import ChatboxTitleBar from '../Layout/ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';
import ChatboxMessageArea from './ChatboxMessageArea';
import { useStateValue } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import * as tauri from '../../utils/tauri';
import { listen } from '@tauri-apps/api/event';
import { MdDelete, MdAdd, MdSearch, MdClose, MdWarning, MdKeyboardArrowDown } from 'react-icons/md';
import { BsLayoutSidebar } from "react-icons/bs";
import { LuMaximize2 } from "react-icons/lu";
// import { AiFillChrome } from 'react-icons/ai';
// import ChatboxTabBar from './ChatboxTabBar';

export const Chatbox = () => {
  // 方案 C: 使用 Rust 内存缓存管理消息
  const [{ navBarChats, updatedConversation, streamingReplies, characterMoods }, dispatch] = useStateValue();
  const [testCount, setTestCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMouseOver, setIsMouseOver] = useState(false);
  const [showTitleBar, setShowTitleBar] = useState(false); // 延迟隐藏用
  const [isTitleBarVisible, setIsTitleBarVisible] = useState(false); // 控制 opacity
  const [conversations, setConversations] = useState([]);
  const [orphanConversations, setOrphanConversations] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [selectedOrphanConv, setSelectedOrphanConv] = useState(null);
  const [availableAssistants, setAvailableAssistants] = useState([]);
  const [allAssistants, setAllAssistants] = useState([]); // 所有 assistants 列表
  const [showAssistantDropdown, setShowAssistantDropdown] = useState(false); // 底部 assistant 下拉菜单
  // Per-tab chatbody status for "Memory updating" display
  const [chatbodyStatuses, setChatbodyStatuses] = useState({}); // { conversationId: status }
  
  // Tab State - declare early so we can use activeTabId
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const activeTabIdRef = useRef(null);
  
  // chatbodyStatus is for "Memory updating" display - use activeTabId state for immediate reactivity
  const chatbodyStatus = activeTabId ? (chatbodyStatuses[activeTabId] || '') : '';
  
  // 切换侧边栏时调整窗口大小
  const handleToggleSidebar = () => {
    const newState = !sidebarOpen;
    setSidebarOpen(newState);
    tauri.toggleSidebar?.(newState);
  };

  // Track if default assistant has been loaded
  const defaultAssistantLoadedRef = useRef(false);
  
  // Keep a ref to the latest navBarChats for use in event handlers
  const navBarChatsRef = useRef(navBarChats);
  useEffect(() => {
    navBarChatsRef.current = navBarChats;
  }, [navBarChats]);

  // 将 fetchConversations 提取为可重用的函数
  const fetchConversations = useCallback(async () => {
    console.log('[ChatboxBody] fetchConversations called');
    try {
      const data = await tauri.getConversations();
      console.log('[ChatboxBody] getConversations returned:', data);
      if (Array.isArray(data)) {
          // Filter out empty conversations (no messages)
          const nonEmptyConversations = data.filter(conv => conv.messageCount > 0);
          setConversations(nonEmptyConversations);
          console.log('[ChatboxBody] setConversations with', nonEmptyConversations.length, 'non-empty items');
      } else {
          console.warn("getConversations returned non-array:", data);
          setConversations([]);
      }
      
      // Also fetch orphan conversations
      const orphans = await tauri.getOrphanConversations();
      if (Array.isArray(orphans)) {
          const nonEmptyOrphans = orphans.filter(conv => conv.messageCount > 0);
          setOrphanConversations(nonEmptyOrphans);
          console.log('[ChatboxBody] setOrphanConversations with', nonEmptyOrphans.length, 'items');
      }
    } catch (error) {
      console.error("Error fetching conversations:", error);
      setConversations([]);
      setOrphanConversations([]);
    }
  }, []);

  // 初始加载
  useEffect(() => {
    fetchConversations();
    // 加载所有 assistants
    tauri.getAssistants().then(assistants => {
      setAllAssistants(assistants || []);
    }).catch(console.error);
  }, [fetchConversations]);

  // 监听 Rust 端发送的鼠标悬停事件
  useEffect(() => {
    let unlisten;
    listen('mouse-over-chat', (event) => {
      setIsMouseOver(event.payload);
    }).then(fn => { unlisten = fn; });
    
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 标题栏显示/隐藏逻辑：淡入淡出都用延迟
  useEffect(() => {
    const shouldShow = sidebarOpen || isMouseOver;
    
    if (shouldShow) {
      // 立即挂载组件（opacity: 0）
      setShowTitleBar(true);
      // 下一帧设置 opacity 为 1（触发淡入动画）
      const timer = setTimeout(() => {
        setIsTitleBarVisible(true);
      }, 10); // 小延迟确保组件已挂载
      return () => clearTimeout(timer);
    } else {
      // 先设置 opacity 为 0（触发淡出动画）
      setIsTitleBarVisible(false);
      // 延迟后卸载组件
      const timer = setTimeout(() => {
        setShowTitleBar(false);
      }, 200); // 与 CSS transition 时间一致
      return () => clearTimeout(timer);
    }
  }, [sidebarOpen, isMouseOver]);

  // 监听后台更新的会话消息（处理非激活 Tab 的更新）
  useEffect(() => {
    if (updatedConversation) {
        // 新方案: 使用 Rust TabState 更新
        tauri.setTabStateMessages(updatedConversation.id, updatedConversation.messages);
        // 同时更新 tab label
        setTabs(prevTabs => prevTabs.map(tab => {
            if (tab.id === updatedConversation.id) {
                return { 
                    ...tab, 
                    label: updatedConversation.title ? updatedConversation.title : tab.label 
                };
            }
            return tab;
        }));
        // 刷新对话列表以显示更新
        fetchConversations();
    }
  }, [updatedConversation, fetchConversations]);

  useEffect(() => {
    // This handler is for "Memory updating" status, NOT mood
    const chatbodyStatusHandler = (status, conversationId) => {
      const targetId = conversationId || activeTabIdRef.current;
      if (targetId) {
        setChatbodyStatuses(prev => ({
          ...prev,
          [targetId]: status
        }));
      }
    };
    const cleanup = tauri.onChatbodyStatusUpdated?.(chatbodyStatusHandler);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  useEffect(() => {
    if (chatbodyStatus) {
      setIsThinking(true);
    } else {
      setIsThinking(false);
    }
  }, [chatbodyStatus]);

  // Handle New Tab from Character ID (moved from ChatboxTabBar)
  // This also handles auto-loading the default assistant on first mount
  // 追踪正在处理的 character-id，防止重复处理
  const processingCharacterIdsRef = useRef(new Set());

  useEffect(() => {
    console.log('[ChatboxBody] Setting up character-id listener');
    let unlisten = null;
    let isMounted = true;
    
    const handleCharacterId = async (id) => {
      console.log('[ChatboxBody] ★★★ Received character-id:', id);
      if (!isMounted) {
        console.log('[ChatboxBody] ★★★ Component not mounted, skipping');
        return;
      }
      
      // 防止重复处理同一个 id
      if (processingCharacterIdsRef.current.has(id)) {
        console.log('[ChatboxBody] ★★★ Already processing this id, skipping');
        return;
      }
      processingCharacterIdsRef.current.add(id);
      
      try {
        // 只有当 id 不在 navBarChats 中时才添加
        if (!navBarChatsRef.current?.includes(id)) {
          dispatch({
            type: actionType.SET_NAVBAR_CHAT,
            navBarChats: [...(navBarChatsRef.current || []), id],
          });
        }
        
        console.log('[ChatboxBody] ★★★ Fetching character for id:', id);
        // 优先尝试新的 Assistant API，失败则回退到旧的 Pet API
        let pet = null;
        try {
          pet = await tauri.getAssistant(id);
          console.log('[ChatboxBody] ★★★ Got assistant:', pet);
        } catch (e) {
          console.log('[ChatboxBody] ★★★ getAssistant failed:', e, ', trying getPet');
          // 回退到旧 API
        }
        if (!pet) {
          try {
            pet = await tauri.getPet(id);
            console.log('[ChatboxBody] ★★★ Got pet:', pet);
          } catch (e) {
            console.error('[ChatboxBody] ★★★ getPet also failed:', e);
          }
        }
        if (!pet) {
          console.error("[ChatboxBody] ★★★ Could not find assistant or pet with id:", id);
          return;
        }
        
        console.log('[ChatboxBody] ★★★ Creating conversation for pet:', pet._id);
        let newConversation;
        try {
          newConversation = await tauri.createConversation({
            petId: pet._id,
            title: "New Chat",
            history: [],
          });
          console.log('[ChatboxBody] ★★★ Created conversation:', newConversation);
        } catch (e) {
          console.error('[ChatboxBody] ★★★ Failed to create conversation:', e);
          return;
        }
        
        tauri.sendConversationId?.(newConversation._id);
        
        const newTab = {
            id: newConversation._id,
            label: "New Chat",
            petId: pet._id,
            messages: [],
            isActive: true
        };
        
        console.log('[ChatboxBody] ★★★ Initializing tab messages');
        // 新方案: 初始化 Rust TabState
        try {
          await tauri.initTabMessages(newConversation._id, []);
        } catch (e) {
          console.error('[ChatboxBody] ★★★ initTabMessages failed:', e);
        }
        
        // Initialize mood and suggestText for new conversation
        dispatch({
            type: actionType.SET_CHARACTER_MOOD,
            characterMood: '',
            conversationId: newConversation._id
        });
        dispatch({
            type: actionType.SET_SUGGEST_TEXT,
            suggestText: [],
            conversationId: newConversation._id
        });
        
        if (!isMounted) {
          console.log('[ChatboxBody] ★★★ Component unmounted during async, skipping setTabs');
          return;
        }
        
        console.log('[ChatboxBody] ★★★ Setting tabs with new tab:', newTab);
        setTabs(prev => {
            console.log('[ChatboxBody] ★★★ setTabs prev:', prev);
            if (prev.some(t => t.id === newTab.id)) {
              console.log('[ChatboxBody] ★★★ Tab already exists');
              return prev;
            }
            const newTabs = [...prev.map(t => ({...t, isActive: false})), newTab];
            console.log('[ChatboxBody] ★★★ setTabs newTabs:', newTabs);
            return newTabs;
        });
        
        console.log('[ChatboxBody] ★★★ Calling handleTabClick:', newConversation._id);
        handleTabClick(newConversation._id);
        
        // 刷新对话列表以显示新创建的对话
        fetchConversations();
      } finally {
        // 处理完成后移除标志
        processingCharacterIdsRef.current.delete(id);
      }
    };
    
    // 直接使用 Tauri listen API
    const setup = async () => {
      console.log('[ChatboxBody] Setting up listen for character-id...');
      unlisten = await listen('character-id', (event) => {
        console.log('[ChatboxBody] ★★★ Raw event received:', event);
        handleCharacterId(event.payload);
      });
      console.log('[ChatboxBody] ★★★ character-id listener is READY, unlisten:', unlisten);
      
      // 检查是否有待处理的 character-id (在 listener ready 之前发送的)
      try {
        const pendingId = await tauri.getPendingCharacterId();
        console.log('[ChatboxBody] ★★★ Checking pending character-id:', pendingId);
        if (pendingId && isMounted) {
          console.log('[ChatboxBody] ★★★ Found pending character-id, processing:', pendingId);
          handleCharacterId(pendingId);
          return; // 已经处理了待处理的 ID，不需要加载默认助手
        }
      } catch (error) {
        console.error('[ChatboxBody] Error checking pending character-id:', error);
      }
      
      // Auto-load default assistant after listener is ready
      // Only run once on first mount when no tabs exist
      // 使用 closure 变量而不是 ref，避免 StrictMode 重复渲染问题
      if (!isMounted) {
        console.log('[ChatboxBody] Component not mounted before default assistant load, skipping');
        return;
      }
      
      // 使用 ref 防止重复加载（即使在 StrictMode 下）
      if (defaultAssistantLoadedRef.current) {
        console.log('[ChatboxBody] Default assistant already loaded, skipping');
        return;
      }
      defaultAssistantLoadedRef.current = true;
      
      // Skip if tabs already exist
      // Note: tabs.length check here captures initial value, which should be 0
      try {
        const settings = await tauri.getSettings();
        console.log('[ChatboxBody] Settings loaded for default assistant:', settings?.defaultRoleId);
        let defaultAssistantId = settings?.defaultRoleId;
        
        // If no default assistant is set, use the first available assistant
        if (!defaultAssistantId) {
          const assistants = await tauri.getAssistants();
          if (assistants && assistants.length > 0) {
            defaultAssistantId = assistants[0]._id;
            console.log('[ChatboxBody] No default assistant set, using first available:', defaultAssistantId);
          }
        }
        
        if (defaultAssistantId && isMounted) {
          console.log('[ChatboxBody] Auto-loading default assistant:', defaultAssistantId);
          // 直接调用 handler，而不是通过事件系统
          handleCharacterId(defaultAssistantId);
        }
      } catch (error) {
        console.error('[ChatboxBody] Error loading default assistant:', error);
      }
    };
    
    setup();
    
    return () => {
      isMounted = false;
      // 在 StrictMode 下，组件卸载时重置 ref，允许重新挂载时重新加载
      defaultAssistantLoadedRef.current = false;
      if (unlisten) {
        console.log('[ChatboxBody] Cleaning up character-id listener');
        unlisten();
      }
    };
  }, []); // Run only once on mount

  const fetchConversationById = async (conversationId) => {
    try {
      return await tauri.getConversationWithHistory(conversationId);
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

    // 新方案: 检查 Rust TabState 是否有消息
    const tabState = await tauri.getTabState(clickedId);
    let messages = tabState.messages || [];

    // If messages empty, fetch from backend and initialize Rust TabState
    if (messages.length === 0) {
         try {
            const conversation = await fetchConversationById(clickedId);
            messages = conversation.history || [];
            // 新方案: 初始化 Rust TabState
            await tauri.initTabMessages(clickedId, messages);
         } catch (e) {
             console.error(e);
         }
    }

    // Sync global - send the mood of the clicked tab to update character display
    const tabMood = characterMoods[clickedId] || 'normal';
    tauri.sendMoodUpdate?.(tabMood, clickedId);
    tauri.sendConversationId?.(clickedId);
    
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
        // 方案 B: 不再需要清空全局消息
        dispatch({ type: actionType.SET_CURRENT_CONVERSATION_ID, id: null });
    }
  };

  const handleCloseAllTabs = () => {
    setTabs([]);
    setActiveTabId(null);
    activeTabIdRef.current = null;
    dispatch({ type: actionType.SET_CURRENT_CONVERSATION_ID, id: null });
  };

  // 处理标签页拖拽排序
  const handleReorderTabs = (newOrder) => {
    setTabs(newOrder);
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
    
    // 新方案: 初始化 Rust TabState
    await tauri.initTabMessages(conv._id, conversation.history);
    
    // Initialize mood and suggestText for new tab
    dispatch({
        type: actionType.SET_CHARACTER_MOOD,
        characterMood: '', // Reset to empty
        conversationId: conv._id
    });
    dispatch({
        type: actionType.SET_SUGGEST_TEXT,
        suggestText: [], // Reset to empty
        conversationId: conv._id
    });

    tauri.sendConversationId?.(conv._id);
    dispatch({
        type: actionType.SET_CURRENT_CONVERSATION_ID,
        id: conv._id,
    });
  };

  // 从某条消息处创建分支（复制该消息及之前的所有消息到新对话）
  const handleBranchFromMessage = async (sourceConvId, messageIndex) => {
    try {
      // 1. 获取源对话的 tab
      const sourceTab = tabs.find(t => t.id === sourceConvId);
      if (!sourceTab) {
        console.error('[Branch] Source tab not found:', sourceConvId);
        return;
      }

      // 2. 获取源对话的消息（从 TabState）
      const tabState = await tauri.getTabState(sourceConvId);
      const sourceMessages = tabState?.messages || [];
      if (!sourceMessages || sourceMessages.length === 0) {
        console.error('[Branch] No messages to branch from');
        return;
      }

      // 3. 复制从开始到 messageIndex 的所有消息
      const messagesToCopy = sourceMessages.slice(0, messageIndex + 1);
      
      // 4. 获取源对话标题
      let sourceTitle = "Chat";
      try {
        const sourceConv = await tauri.getConversationById(sourceConvId);
        if (sourceConv?.title) {
          sourceTitle = sourceConv.title;
        }
      } catch (e) {
        // 使用默认标题
      }

      // 5. 创建新对话
      const newConversation = await tauri.createConversation({
        petId: sourceTab.petId,
        title: `${sourceTitle} (Branch)`,
        history: messagesToCopy,
      });

      console.log('[Branch] Created new conversation:', newConversation._id);

      // 5.5 保存消息到数据库（这样 messageCount 才会正确）
      await tauri.updateConversation(newConversation._id, { history: messagesToCopy });

      // 6. 初始化新对话的 TabState
      await tauri.initTabMessages(newConversation._id, messagesToCopy);

      // 7. 创建新 Tab
      const newTab = {
        id: newConversation._id,
        label: `${sourceTitle} (Branch)`,
        petId: sourceTab.petId,
        messages: messagesToCopy,
        isActive: true
      };

      // 8. 添加 Tab 并切换
      setTabs(prev => [...prev.map(t => ({ ...t, isActive: false })), newTab]);
      handleTabClick(newConversation._id);
      
      // 9. 刷新对话列表
      fetchConversations();
    } catch (error) {
      console.error('[Branch] Failed to create branch:', error);
    }
  };

  const handleNewChat = () => {
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (activeTab) {
        // 如果有活跃的 Tab，使用其 petId 创建新对话
        tauri.sendCharacterId?.(activeTab.petId);
    } else if (tabs.length > 0) {
        // 如果有其他 Tab，使用第一个 Tab 的 petId
        tauri.sendCharacterId?.(tabs[0].petId);
    } else {
        // 没有任何 Tab，打开角色选择窗口
        tauri.changeSelectCharacterWindow?.();
    }
  };

  const handleShare = async () => {
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (!activeTab || !activeTab.messages || activeTab.messages.length === 0) {
      alert("No conversation to share.");
      return;
    }

    // 获取角色信息用于显示名称
    let petName = "Assistant";
    try {
      let pet = await tauri.getAssistant(activeTab.petId);
      if (!pet) {
        pet = await tauri.getPet(activeTab.petId);
      }
      if (pet && pet.name) {
        petName = pet.name;
      }
    } catch (e) {
      // 使用默认名称
    }

    const conversationText = activeTab.messages
      .map(msg => {
        if (msg.role === "assistant") {
          return `${petName}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`;
        } else if (msg.role === "user") {
          return `You: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`;
        }
        return `${msg.role}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`;
      })
      .join('\n\n');

    navigator.clipboard.writeText(conversationText)
      .then(() => {
        alert("Conversation copied to clipboard!");
      })
      .catch((err) => {
        console.error("Failed to copy conversation: ", err);
        alert("Failed to copy conversation.");
      });
  };

  const handleDelete = async (e, conversationId) => {
    e.stopPropagation();
    const confirmDelete = await tauri.confirm("Are you sure you want to delete this conversation?", {
      title: 'Delete Conversation'
    });
    if (!confirmDelete) return;

    try {
      await tauri.deleteConversation(conversationId);
      setConversations((prevConvs) => prevConvs.filter((conv) => conv._id !== conversationId));
      setOrphanConversations((prevConvs) => prevConvs.filter((conv) => conv._id !== conversationId));
      
      // Also close tab if open
      if (tabs.some(t => t.id === conversationId)) {
          handleCloseTab(e, conversationId);
      }

    } catch (error) {
      console.error("Error deleting conversation:", error);
      alert("Failed to delete conversation.");
    }
  };

  // Handle orphan conversation click - show transfer modal
  const handleOrphanClick = async (conv) => {
    setSelectedOrphanConv(conv);
    try {
      const assistants = await tauri.getAssistants();
      setAvailableAssistants(assistants || []);
      setShowTransferModal(true);
    } catch (error) {
      console.error("Error fetching assistants:", error);
      alert("Failed to load assistants.");
    }
  };

  // Handle transfer conversation to new assistant
  const handleTransfer = async (newPetId) => {
    if (!selectedOrphanConv || !newPetId) return;
    
    try {
      await tauri.transferConversation(selectedOrphanConv._id, newPetId);
      // Refresh conversations
      const data = await tauri.getConversations();
      if (Array.isArray(data)) {
        const nonEmptyConversations = data.filter(conv => conv.messageCount > 0);
        setConversations(nonEmptyConversations);
      }
      // Remove from orphans
      setOrphanConversations(prev => prev.filter(c => c._id !== selectedOrphanConv._id));
      setShowTransferModal(false);
      setSelectedOrphanConv(null);
      
      // Optionally open the transferred conversation
      const transferredConv = { ...selectedOrphanConv, petId: newPetId };
      handleItemClick(transferredConv);
    } catch (error) {
      console.error("Error transferring conversation:", error);
      alert("Failed to transfer conversation.");
    }
  };

  const handleClose = () => {
    tauri.hideChatWindow?.();
  };
  const handleMax = () => {
    tauri.maxmizeChatWindow?.();
  };

  return (
    <div className={`h-screen rounded-[16px] overflow-clip relative`}>
    {/* 白色遮罩层：侧边栏关闭时 80% 透明度，打开时 100% */}
    <div className={`absolute inset-0 bg-white transition-opacity duration-200 pointer-events-none ${sidebarOpen ? 'opacity-100' : 'opacity-80'}`} />
    <div className={`h-full flex group/chatwindow overflow-hidden relative`}>
      {/* Sidebar - 小窗口根据 sidebarOpen 状态显示，全屏时始终显示 */}
      <div className={`${sidebarOpen ? 'flex' : 'hidden'} lg:!flex flex-col w-64 bg-[#f9f9f9] border-r border-gray-200 h-full shrink-0`}>
        
        {/* Window Controls & Sidebar Toggle */}
        <div className="p-3 pt-4 draggable flex items-center justify-between" data-tauri-drag-region>
            <div className="flex items-center gap-2 no-drag px-2">
                {/* 红色：关闭 */}
                <div onClick={handleClose} className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 cursor-pointer flex items-center justify-center group">
                    <MdClose className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
                </div>
                {/* 黄色：最小化（隐藏窗口） */}
                <div onClick={handleClose} className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 cursor-pointer flex items-center justify-center group">
                    <span className="text-white text-[8px] font-bold opacity-0 group-hover:opacity-100">−</span>
                </div>
                {/* 绿色：最大化/还原 */}
                <div onClick={handleMax} className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 cursor-pointer flex items-center justify-center group">
                    <LuMaximize2 className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
                </div>
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
          
          {/* Orphan Conversations */}
          {orphanConversations.length > 0 && (
            <>
              <div className="px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1 mt-3 flex items-center gap-1">
                <MdWarning className="text-amber-500" />
                <span>Orphaned</span>
              </div>
              {orphanConversations.map((conv) => (
                <div
                  key={conv._id}
                  onClick={() => handleOrphanClick(conv)}
                  className="group flex items-center justify-between p-2 rounded-lg hover:bg-amber-50 cursor-pointer transition-colors text-sm text-gray-500 border-l-2 border-amber-400"
                >
                  <span className="truncate flex-1 pr-2">{conv.title}</span>
                  <MdDelete 
                    onClick={(e) => handleDelete(e, conv._id)}
                    className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity text-lg" 
                  />
                </div>
              ))}
            </>
          )}
        </div>

        {/* Quick New Chat - Assistant Dropdown */}
        <div className="p-3 border-t border-gray-200 relative">
            <div 
              onClick={() => setShowAssistantDropdown(!showAssistantDropdown)}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-200 cursor-pointer"
            >
                {(() => {
                  const currentPetId = tabs.find(t => t.id === activeTabId)?.petId;
                  const currentAssistant = allAssistants.find(a => a._id === currentPetId);
                  const name = currentAssistant?.name || 'Select Assistant';
                  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                  return (
                    <>
                      <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        {initials}
                      </div>
                      <div className="flex-1 text-sm font-medium text-gray-700 truncate">{name}</div>
                      <MdKeyboardArrowDown className={`text-gray-500 transition-transform flex-shrink-0 ${showAssistantDropdown ? 'rotate-180' : ''}`} />
                    </>
                  );
                })()}
            </div>
            
            {/* Assistant Dropdown Menu */}
            {showAssistantDropdown && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowAssistantDropdown(false)} />
                <div className="absolute bottom-full left-3 right-3 mb-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 max-h-48 overflow-y-auto">
                  {allAssistants.map(assistant => {
                    const initials = assistant.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                    return (
                      <div 
                        key={assistant._id}
                        onClick={() => {
                          tauri.sendCharacterId?.(assistant._id);
                          setShowAssistantDropdown(false);
                        }}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-100 cursor-pointer"
                      >
                        <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                          {initials}
                        </div>
                        <span className="text-sm text-gray-700 truncate">{assistant.name}</span>
                      </div>
                    );
                  })}
                  {allAssistants.length === 0 && (
                    <div className="px-3 py-2 text-sm text-gray-400">No assistants available</div>
                  )}
                </div>
              </>
            )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className={`h-full flex-1 flex flex-col justify-between relative`}>
        {/* Title Bar - 淡入淡出效果 */}
        {showTitleBar && (
          <div className={`flex-shrink-0 transition-opacity duration-200 ${isTitleBarVisible ? 'opacity-100' : 'opacity-0'}`}>
            <ChatboxTitleBar 
                activePetId={tabs.find(t => t.id === activeTabId)?.petId} 
                tabs={tabs} 
                activeTabId={activeTabId} 
                onTabClick={handleTabClick} 
                onCloseTab={handleCloseTab}
                onCloseAllTabs={handleCloseAllTabs}
                onAddTab={handleAddTabClick}
                onReorderTabs={handleReorderTabs}
                onShare={handleShare}
                sidebarOpen={sidebarOpen}
                isMouseOver={isMouseOver}
                onToggleSidebar={handleToggleSidebar}
            />
          </div>
        )}
        {chatbodyStatus != "" && (
          <div className="text-center text-sm text-gray-600 animate-pulse absolute top-10 left-0 right-0 z-10 pointer-events-none">
            Memory updating: {chatbodyStatus}
          </div>
        )}
        
        {/* 消息区域 - 始终从顶部开始，标题栏覆盖在上面 */}
        <div className="flex-1 overflow-hidden relative flex flex-col">
             {tabs.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-3">
                    <span>No active conversations</span>
                    <button 
                        onClick={() => tauri.changeSelectCharacterWindow?.()}
                        className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm"
                    >
                        Select an Assistant
                    </button>
                </div>
             ) : (
                tabs.map(tab => (
                    <div 
                        key={tab.id} 
                        style={{ display: tab.id === activeTabId ? 'flex' : 'none' }} 
                        className="flex-1 flex flex-col h-full"
                    >
                        <ChatboxMessageArea 
                            conversationId={tab.id}
                            streamingContent={streamingReplies ? streamingReplies[tab.id] : null} 
                            isActive={tab.id === activeTabId}
                            showTitleBar={showTitleBar}
                            onBranchFromMessage={handleBranchFromMessage}
                        />
                    </div>
                ))
             )}
        </div>
        
        <div className="w-full">
            <ChatboxInputArea 
                className="w-full" 
                activePetId={tabs.find(t => t.id === activeTabId)?.petId}
                sidebarOpen={sidebarOpen}
            />
        </div>
      </div>
      
      {/* Transfer Modal */}
      {showTransferModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-80 max-h-96 flex flex-col">
            <div className="p-4 border-b border-gray-200">
              <h3 className="font-semibold text-gray-800">Transfer Conversation</h3>
              <p className="text-sm text-gray-500 mt-1">
                Select an assistant to take over this conversation
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {availableAssistants.length === 0 ? (
                <div className="text-center text-gray-400 py-4">
                  No assistants available
                </div>
              ) : (
                availableAssistants.map((assistant) => (
                  <div
                    key={assistant._id}
                    onClick={() => handleTransfer(assistant._id)}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-100 cursor-pointer transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm overflow-hidden">
                      {assistant.icon ? (
                        <img src={assistant.icon} alt="" className="w-full h-full object-cover" />
                      ) : (
                        assistant.name?.charAt(0) || '?'
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-gray-800">{assistant.name}</div>
                      <div className="text-xs text-gray-500 truncate">{assistant.model_id}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="p-3 border-t border-gray-200">
              <button
                onClick={() => {
                  setShowTransferModal(false);
                  setSelectedOrphanConv(null);
                }}
                className="w-full py-2 text-gray-600 hover:text-gray-800 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
};

export default Chatbox;