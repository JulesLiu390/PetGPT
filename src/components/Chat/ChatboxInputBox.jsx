import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useStateValue } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import { FaArrowUp, FaShareNodes, FaFile, FaStop, FaBrain } from "react-icons/fa6";
import { AiOutlinePlus } from "react-icons/ai";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { promptSuggestion, callOpenAILib, callOpenAILibStream, longTimeMemory, processMemory } from '../../utils/openai';
import { MdOutlineCancel } from "react-icons/md";
import { SiQuicktype } from "react-icons/si";
import { useMcpTools } from '../../utils/mcp/useMcpTools';
import { callLLMStreamWithTools } from '../../utils/mcp/toolExecutor';
import McpToolbar from './McpToolbar';
import * as bridge from '../../utils/bridge';
import { shouldInjectTime, buildTimeContext } from '../../utils/timeInjection';

/**
 * 获取模型的 API 格式
 * 支持新的 apiFormat 字段和旧的 modelProvider 字段
 * @param {Object} model - 模型配置对象
 * @returns {string} - 'openai_compatible' | 'gemini_official'
 */
const getApiFormat = (model) => {
  if (!model) return 'openai_compatible';
  
  // 优先使用新字段
  if (model.apiFormat) return model.apiFormat;
  
  // 兼容旧的 modelProvider 字段
  const provider = model.modelProvider;
  if (provider === 'gemini') return 'gemini_official';
  
  // 所有其他 provider 都映射到 openai_compatible
  return 'openai_compatible';
};



// 预览粘贴图片组件（无边框，圆角矩形）
const PastedImagePreview = ({ imageUrl, onRemove }) => {
  if (!imageUrl) return null;

  return (
    <div className="relative inline-block rounded-md mt-2">
      <img
        src={imageUrl}
        alt="Pasted"
        className="max-w-full max-h-32 object-cover rounded-md"
      />
      <MdOutlineCancel className="absolute top-1 right-1 cursor-pointer z-10 text-gray-200 hover:text-white"
      onClick={onRemove}
      ></MdOutlineCancel>
    </div>
  );
};





export const ChatboxInputBox = ({ activePetId }) => {
  // 会话 ID ref（需要先声明，供其他地方引用）
  const conversationIdRef = useRef(null);
  
  // 按会话管理生成状态，支持多会话并行
  const [generatingConversations, setGeneratingConversations] = useState(new Set());
  // 按会话管理 AbortController，支持独立取消
  const abortControllersRef = useRef(new Map()); // Map<conversationId, AbortController>
  
  // 兼容性：当前会话是否在生成
  const isGenerating = generatingConversations.has(conversationIdRef.current) || 
                       generatingConversations.has('temp');
  
  // 新增记忆功能开关状态
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  // MCP 服务器启用状态 (服务器名称集合)
  const [enabledMcpServers, setEnabledMcpServers] = useState(new Set());

  const [userImage, setUserImage] = useState(null);
  const [stateReply, setStateReply] = useState(null);
  const [stateReplyConversationId, setStateReplyConversationId] = useState(null); // Track which conversation the reply belongs to
  const [stateThisModel, setStateThisModel] = useState(null);
  const [stateUserText, setStateUserText] = useState(null);
  let reply = null;
  let thisModel = null;
  let _userText = null;

  // 获取当前模型的 API 格式
  const [currentApiFormat, setCurrentApiFormat] = useState('openai_compatible');
  
  // MCP 工具 Hook
  const { 
    mcpServers,
    mcpTools, 
    llmTools, 
    hasTools,
    executeToolCalls,
    toolCallHistory,
    refresh: refreshMcpTools,
    refreshServers 
  } = useMcpTools({ 
    enabledServers: enabledMcpServers, 
    apiFormat: currentApiFormat 
  });

  useEffect(() => {
    if (activePetId) {
      setCharacterId(activePetId);
    }
  }, [activePetId]);

  // 新增记忆功能切换函数
  const toggleMemory = () => {
    setMemoryEnabled(prev => !prev);
    console.log(!memoryEnabled ? "记忆功能开启" : "记忆功能关闭");
  };
  
  // MCP 服务器切换函数 - 启用时自动启动服务器
  const toggleMcpServer = useCallback(async (serverName) => {
    // 查找服务器信息
    const server = mcpServers.find(s => s.name === serverName);
    
    // 检查是否要启用
    const isCurrentlyEnabled = enabledMcpServers.has(serverName);
    
    if (!isCurrentlyEnabled && server) {
      // 启用服务器：如果未运行，先自动启动
      if (!server.isRunning && server._id) {
        try {
          console.log(`[MCP] 服务器 "${serverName}" 未运行，正在自动启动...`);
          await bridge.mcp.startServer(server._id);
          // 刷新服务器列表以获取最新状态
          await refreshServers();
          console.log(`[MCP] 服务器 "${serverName}" 已自动启动`);
        } catch (err) {
          console.error(`[MCP] 自动启动服务器 "${serverName}" 失败:`, err);
          // 启动失败，不添加到启用列表
          return;
        }
      }
    }
    
    setEnabledMcpServers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(serverName)) {
        newSet.delete(serverName);
        console.log(`[MCP] 服务器 "${serverName}" 已禁用`);
      } else {
        newSet.add(serverName);
        console.log(`[MCP] 服务器 "${serverName}" 已启用`);
      }
      return newSet;
    });
  }, [mcpServers, enabledMcpServers, refreshServers]);
  
  // 更新 MCP 服务器配置 (按名称)
  const updateMcpServer = useCallback(async (serverName, updates) => {
    try {
      if (!bridge.mcp.updateServer) {
        console.error('[MCP] updateServerByName API not available');
        return;
      }
      await bridge.mcp.updateServer(serverName, updates);
      await refreshServers();
      console.log(`[MCP] 服务器 "${serverName}" 配置已更新:`, updates);
    } catch (err) {
      console.error('[MCP] Failed to update server:', err);
    }
  }, [refreshServers]);
  
  // 批量更新 MCP 服务器顺序
  const batchUpdateMcpOrder = useCallback(async (orderList) => {
    // orderList: [{ name: 'xxx', toolbarOrder: 0 }, ...]
    try {
      for (const item of orderList) {
        if (bridge.mcp.updateServer) {
          await bridge.mcp.updateServer(item.name, { toolbarOrder: item.toolbarOrder });
        }
      }
      await refreshServers();
      console.log('[MCP] 服务器顺序已更新');
    } catch (err) {
      console.error('[MCP] Failed to batch update order:', err);
    }
  }, [refreshServers]);
  
  // 删除 MCP 服务器 (按名称)
  const deleteMcpServer = useCallback(async (serverName) => {
    try {
      if (!bridge.mcp.deleteServer) {
        console.error('[MCP] deleteServerByName API not available');
        return;
      }
      // 从启用列表中移除
      setEnabledMcpServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(serverName);
        return newSet;
      });
      await bridge.mcp.deleteServer(serverName);
      await refreshServers();
      console.log(`[MCP] 服务器 "${serverName}" 已删除`);
    } catch (err) {
      console.error('[MCP] Failed to delete server:', err);
    }
  }, [refreshServers]);
  
  // 编辑 MCP 服务器图标 (打开 MCP 设置窗口)
  const editMcpServerIcon = useCallback((server) => {
    // TODO: 打开图标选择器或跳转到设置页面
    console.log('[MCP] Edit icon for server:', server.name);
    // 可以通过 IPC 打开 MCP 设置窗口
    bridge.openMcpSettings();
  }, []);

  // 修改后的：点击按钮时复制对话内容
  const handleShare = () => {
    const conversationText = userMessages
      .map(msg =>
        msg.role === "assistant" && petInfo && petInfo.name
          ? `${petInfo.name}: ${msg.content}`
          : `${msg.role}: ${msg.content}`
      )
      .join('\n');
    navigator.clipboard.writeText(conversationText)
      .then(() => {
        alert("Conversation copied to clipboard");
      })
      .catch((err) => {
        console.error("Failed to copy conversation: ", err);
      });
  };

  const inputRef = useRef(null);
  const stateValue = useStateValue();
  console.log('[ChatboxInputBox] stateValue:', stateValue);
  const [state, dispatch] = stateValue || [{}, () => {}];
  console.log('[ChatboxInputBox] state:', state, 'dispatch:', dispatch);
  const { userMessages = [], suggestText: allSuggestTexts = {}, currentConversationId, runFromHereTimestamp, characterMoods = {}, lastTimeInjection = {} } = state;
  const suggestText = allSuggestTexts[currentConversationId] || [];
  console.log('[ChatboxInputBox] userMessages:', userMessages);
  // 将 userText 从全局状态中移除，改为本地状态管理
  const [userText, setUserText] = useState("");
  const [characterId, setCharacterId] = useState(null);
  const [petInfo, setPetInfo] = useState(null);
  const [activeModelConfig, setActiveModelConfig] = useState(null);
  const [functionModelInfo, setFunctionModelInfo] = useState(null);
  const composingRef = useRef(false);
  const ignoreEnterRef = useRef(false);
  const [userMemory, setUserMemory] = useState(null);
  const [founctionModel, setFounctionModel] = useState(null);
  const [system, setSystem] = useState(null);
  const [firstCharacter, setFirstCharacter] = useState(null)

  // 启动时加载默认角色ID
  useEffect(() => {
    setSystem(window.navigator.platform);
    const loadDefaultCharacter = async () => {
      const settings = await bridge.getSettings();
      let defaultAssistantFound = false;
      
      try {
        if (settings && settings.defaultRoleId) {
          // 验证ID是否有效（优先尝试 getAssistant，然后回退到 getPet）
          try {
            let pet = null;
            try {
              pet = await bridge.getAssistant(settings.defaultRoleId);
            } catch (e) {
              // 忽略，尝试旧 API
            }
            if (!pet) {
              pet = await bridge.getPet(settings.defaultRoleId);
            }
            if (pet) {
              setFirstCharacter(settings.defaultRoleId);
              defaultAssistantFound = true;
              console.log("[ChatboxInputBox] Default assistant loaded:", pet.name);
            } else {
              console.log("Default character ID not found in database, will use fallback");
            }
          } catch (petError) {
            console.error("Error finding pet with default ID:", petError);
          }
        }
        
        // 如果没有设置默认助手或者默认助手无效，使用第一个可用的助手
        if (!defaultAssistantFound) {
          try {
            const assistants = await bridge.getAssistants();
            if (assistants && assistants.length > 0) {
              const firstAssistant = assistants[0];
              setFirstCharacter(firstAssistant._id);
              console.log("[ChatboxInputBox] Fallback to first assistant:", firstAssistant.name);
            } else {
              // 尝试获取 pets 作为后备
              const pets = await bridge.getPets();
              if (pets && pets.length > 0) {
                const firstPet = pets[0];
                setFirstCharacter(firstPet._id);
                console.log("[ChatboxInputBox] Fallback to first pet:", firstPet.name);
              } else {
                console.log("[ChatboxInputBox] No assistants or pets available");
                setCharacterId(null);
              }
            }
          } catch (fallbackError) {
            console.error("Error loading fallback assistant:", fallbackError);
            setCharacterId(null);
          }
        }
      } catch (error) {
        console.error("Error loading default character ID from settings:", error);
        setCharacterId(null);
      }

      // 加载默认功能模型
      try {
        if (settings && settings.defaultModelId) {
          // 验证ID是否有效（优先尝试 getAssistant，然后回退到 getPet）
          try {
            let pet = null;
            try {
              pet = await bridge.getAssistant(settings.defaultModelId);
            } catch (e) {
              // 忽略，尝试旧 API
            }
            if (!pet) {
              pet = await bridge.getPet(settings.defaultModelId);
            }
            if (pet) {
              setFounctionModel(settings.defaultModelId);
              console.log("[ChatboxInputBox] Default function model loaded:", pet.name);
              const { _id, name, modelName, modelApiKey, modelProvider, modelUrl, apiFormat } = pet;
              const systemInstruction = pet.systemInstruction || pet.personality || '';
              setFunctionModelInfo({ _id, name, modelName, systemInstruction, modelApiKey, modelProvider, modelUrl, apiFormat });
            } else {
              console.log("Default model ID not found in database, using null");
              setFunctionModelInfo(null);
            }
          } catch (petError) {
            console.error("Error finding pet with default model ID:", petError);
            setFunctionModelInfo(null);
          }
        }
      } catch (error) {
        console.error("Error loading default model ID from settings:", error);
        setFunctionModelInfo(null);
      }
    };
      
    loadDefaultCharacter();
  }, []); // 只在组件加载时执行一次

  useEffect(() => {
    if(firstCharacter!=null) {
      bridge.sendCharacterId(firstCharacter);
    }
  
    // return () => {
    //   second
    // }
  }, [firstCharacter])
  

  // 监听角色 ID
  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("📩 Received character ID:", id);
      setCharacterId(id);
    };
    const cleanup = bridge.onCharacterId(handleCharacterId);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  useEffect(() => {
    // Use stateReplyConversationId to ensure suggestions go to the correct conversation
    const conversationId = stateReplyConversationId;
    const updateSuggestion = async() => {
      thisModel = stateThisModel;
      _userText = stateUserText;
      
      if (!thisModel || !stateReply || !conversationId) return;

      try {
        let suggestion = await promptSuggestion(
            {user:_userText, assistant:stateReply.content},
            getApiFormat(thisModel),
            thisModel.modelApiKey,
            thisModel.modelName,
            thisModel.modelUrl
        )
        if (suggestion && typeof suggestion === 'string') {
            suggestion = suggestion.split("|")
            dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: suggestion, conversationId });
        } else {
            dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [], conversationId });
        }
      } catch (error) {
        console.error("Error getting suggestions:", error);
        dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [], conversationId });
      }
    };
    if(stateReply != null && stateReplyConversationId != null) {
      updateSuggestion();
    }
  }, [stateReply, stateReplyConversationId]);

  // 加载角色信息，并清理或保留对话历史
  useEffect(() => {
    if (!characterId) return;

    const fetchPetInfo = async () => {
      try {
        // 首先尝试从新的 Assistant API 获取
        let assistant = await bridge.getAssistant(characterId);
        let modelConfig = null;
        
        if (assistant && assistant.modelConfigId) {
          // 新数据模型：从关联的 ModelConfig 获取 API 配置
          modelConfig = await bridge.getModelConfig(assistant.modelConfigId);
        }

        setActiveModelConfig(modelConfig);
        
        // 如果新 API 没有数据，回退到旧的 Pet API（向后兼容）
        if (!assistant) {
          assistant = await bridge.getPet(characterId);
        }
        
        if (assistant) {
          const { _id, name, hasMood, isAgent } = assistant;
          // 向后兼容：优先使用 systemInstruction，fallback 到 personality
          const systemInstruction = assistant.systemInstruction || assistant.personality || '';
          // hasMood 向后兼容：如果没设置 hasMood，则根据 !isAgent 判断
          const computedHasMood = typeof hasMood === 'boolean' ? hasMood : !isAgent;
          
          // 从 ModelConfig 获取 API 配置，如果没有则从 assistant 本身获取（兼容旧数据）
          const apiConfig = modelConfig || assistant;
          const { modelName, modelApiKey, modelUrl, apiFormat, modelProvider } = apiConfig;
          
          setPetInfo({ 
            _id, 
            name, 
            modelName, 
            systemInstruction, 
            modelApiKey, 
            modelProvider, 
            modelUrl, 
            apiFormat, 
            hasMood: computedHasMood 
          });
          
          // 更新当前 API 格式，用于 MCP 工具转换
          setCurrentApiFormat(getApiFormat(apiConfig));
          
          thisModel = null;
          if(functionModelInfo == null) {
            thisModel = apiConfig;
          } else {
            thisModel = functionModelInfo;
          }

          try {
            const memoryJson = await bridge.getPetUserMemory(characterId);
            const memory = JSON.stringify(memoryJson);
            const getUserMemory = await processMemory(
              memory,
              getApiFormat(thisModel),
              thisModel.modelApiKey,
              thisModel.modelName,
              thisModel.modelUrl
            );
            setUserMemory(getUserMemory);
          } catch (memoryError) {
            console.error("加载用户记忆失败:", memoryError);
          }
        } else {
          console.error("Pet not found for ID:", characterId);
          setCharacterId(null);
          return;
        }

        if (conversationIdRef.current && bridge) {
          const currentConv = await bridge.getConversationById(conversationIdRef.current);
          if (!currentConv || currentConv.petId !== characterId) {
            dispatch({ type: actionType.SET_MESSAGE, userMessages: [] });
            conversationIdRef.current = null;
          }
        } else {
          dispatch({ type: actionType.SET_MESSAGE, userMessages: [] });
        }
      } catch (error) {
        console.error("Error fetching pet info:", error);
        setCharacterId(null);
      }
    };

    fetchPetInfo();
  }, [characterId]);

  useEffect(() => {
    const handleNewChat = () => {
      dispatch({ type: actionType.SET_MESSAGE, userMessages: [] });
      conversationIdRef.current = null;
    };

    // 注册监听器
    let cleanup;
    if (bridge.onNewChatCreated) {
      cleanup = bridge.onNewChatCreated(handleNewChat);
    }

    // 卸载时清理监听器，避免内存泄漏
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 接收会话 ID
  useEffect(() => {
    const fetchConv = async (conversationId) => {
      try {
        const conv = await bridge.getConversationById(conversationId);
        setCharacterId(conv.petId)
        // alert(conv.petID);
      } catch (error) {
        console.error("Error fetching conversation:", error);
        throw error;
      }
    };

    const handleConversationId = async(id) => {
      await fetchConv(id);
      console.log("📥 Received conversation ID from Electron:", id);


      conversationIdRef.current = id;
    };

    let cleanup;
    if (bridge.onConversationId) {
      cleanup = bridge.onConversationId(handleConversationId);
    }
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // Sync conversationIdRef with currentConversationId from global state
  useEffect(() => {
    conversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  const handleChange = (e) => {
    setUserText(e.target.value);
  };

  // 中文/日文输入法事件
  const handleCompositionStart = () => {
    composingRef.current = true;
  };
  const handleCompositionEnd = () => {
    composingRef.current = false;
    ignoreEnterRef.current = true;
    setTimeout(() => {
      ignoreEnterRef.current = false;
    }, 50);
  };

  // 自动调整 textarea 高度（最大200px）
  const autoResize = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const newHeight = Math.min(inputRef.current.scrollHeight, 200);
      inputRef.current.style.height = newHeight + 'px';
    }
  }, []);

  // 当 userText 变化时自动调整高度（特别是清空时重置高度）
  useEffect(() => {
    autoResize();
  }, [userText, autoResize]);

  // 获取当前会话的表情 - 使用 currentConversationId 确保切换 tab 后立即更新
  const currentMood = characterMoods?.[currentConversationId] || 'normal';

  // 回车发送
  const handleKeyDown = (e) => {
    if (composingRef.current || ignoreEnterRef.current) return;
    if (e.key === "Enter" && !e.shiftKey && currentMood != "thinking" && String(userText).trim()) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    const moodUpdateHandler = (event, updatedMood, targetConversationId) => {
      console.log("Received updated mood:", updatedMood, "for conversation:", targetConversationId);
      // 更新全局状态中对应会话的表情
      dispatch({
        type: actionType.SET_CHARACTER_MOOD,
        characterMood: updatedMood,
        conversationId: targetConversationId || conversationIdRef.current || 'global'
      });
    };
    const cleanup = bridge.onMoodUpdated?.(moodUpdateHandler);

    // 组件卸载时移除监听
    return () => {
      if (cleanup) cleanup();
    };
  }, [dispatch]);

  

  // 发送消息
  const handleSend = async () => {
    if (!characterId) {
      alert("Please select a character first!");
      return;
    }
    
    // 重置 MCP 取消状态（开始新的对话）
    try {
      if (bridge.mcp?.resetCancellation) {
        await bridge.mcp.resetCancellation();
      }
    } catch (err) {
      console.warn('[handleSend] Failed to reset MCP cancellation:', err);
    }

    let isRunFromHere = false;
    let currentInputText = userText;
    let runFromHereContent = null; // Store original multimodal content for re-run

    // 检查是否有内容可发送（文字或附件）
    const hasText = currentInputText.trim().length > 0;
    const hasAttachments = attachments.length > 0 || userImage != null;

    if (!hasText && !hasAttachments) {
        // 没有文字也没有附件，检查是否是重新生成
        if (userMessages.length > 0 && userMessages[userMessages.length - 1].role === 'user') {
            isRunFromHere = true;
            const lastMsg = userMessages[userMessages.length - 1];
            // Preserve original content structure for multimodal
            runFromHereContent = lastMsg.content;
            // Extract text for _userText (used for memory/search)
            if (typeof lastMsg.content === 'string') {
                currentInputText = lastMsg.content;
            } else if (Array.isArray(lastMsg.content)) {
                currentInputText = lastMsg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
            } else {
                currentInputText = JSON.stringify(lastMsg.content);
            }
        } else {
            return;
        }
    }

    // 🔒 锁定当前对话 ID，防止在等待 AI 回复期间切换标签导致数据错乱
    let sendingConversationId = conversationIdRef.current || 'temp';
    // 保存初始 ID 用于状态清理（因为 sendingConversationId 后面可能会变）
    const initialConversationId = sendingConversationId;
    
    // 标记该会话正在生成
    setGeneratingConversations(prev => new Set(prev).add(initialConversationId));

    _userText = currentInputText;
    
    // Construct display content (User Text + Attachments)
    let displayContent;
    if (isRunFromHere) {
        // Use original content from history
        displayContent = runFromHereContent;
    } else if (userImage != null || attachments.length > 0) {
        displayContent = [{ type: "text", text: _userText }];
        if (userImage) {
            displayContent.push({ type: "image_url", image_url: { url: userImage } });
        }
        attachments.forEach(att => {
            if (att.type === 'image_url') {
                // Use saved file path instead of base64 for persistence
                displayContent.push({ 
                    type: 'image_url', 
                    image_url: { url: att.path },
                    mime_type: att.mime_type 
                });
            } else {
                // For video/audio/documents, include mime_type for proper rendering
                displayContent.push({ 
                    type: 'file_url', 
                    file_url: { 
                        url: att.path, 
                        mime_type: att.mime_type,
                        name: att.name 
                    }
                });
            }
        });
    } else {
        displayContent = _userText;
    }

    setUserText("");
    dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [], conversationId: sendingConversationId });

    // 更新 UI - 用户消息
    console.log('[ChatboxInputBox] About to dispatch ADD_MESSAGE', {
      isRunFromHere,
      sendingConversationId,
      conversationIdRef: conversationIdRef.current,
      displayContent
    });
    // 修复：当 conversationIdRef.current 为 null 时（新对话），也应该添加消息
    // 原条件 sendingConversationId === conversationIdRef.current 在新对话时会失败（"temp" !== null）
    if (!isRunFromHere) {
      console.log('[ChatboxInputBox] Dispatching ADD_MESSAGE');
      dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: displayContent} });
    } else {
      console.log('[ChatboxInputBox] Skipped ADD_MESSAGE dispatch (isRunFromHere)');
    }

    bridge.sendMoodUpdate('thinking', initialConversationId);

    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = 'auto';
    }

    try {
    let fullMessages = [];
    const isDefaultPersonality = petInfo?.systemInstruction &&
      (petInfo.systemInstruction.trim().toLowerCase() === "default model (english)" ||
       petInfo.systemInstruction.trim().toLowerCase() === "default");
    thisModel = petInfo;

    const historyMessages = isRunFromHere ? userMessages.slice(0, -1) : userMessages;

    thisModel = functionModelInfo == null ? petInfo : functionModelInfo;
      
      let content = displayContent;

      if (userImage || attachments.length > 0) {
          setUserImage(null);
          setAttachments([]);
      }

      // 检查是否需要注入时间信息
      const lastInjectionTimestamp = lastTimeInjection[sendingConversationId];
      const needTimeInjection = shouldInjectTime(lastInjectionTimestamp);
      const timeContext = needTimeInjection ? buildTimeContext() : '';
      
      // 如果注入了时间，更新时间戳
      if (needTimeInjection) {
        console.log('[ChatboxInputBox] Injecting time context:', timeContext);
        dispatch({
          type: actionType.UPDATE_TIME_INJECTION,
          conversationId: sendingConversationId,
          timestamp: Date.now()
        });
      }

      if (!isDefaultPersonality) {
        if (memoryEnabled) {
          const index = await longTimeMemory(_userText, 
            getApiFormat(thisModel),
            thisModel.modelApiKey,
            thisModel.modelName,
            thisModel.modelUrl
          );
          let getUserMemory = "";
          if (index.isImportant === true) {
            await bridge.updatePetUserMemory(petInfo._id, index.key, index.value);
            bridge.updateChatbodyStatus(index.key + ":" + index.value, sendingConversationId);
            const memoryJson = await bridge.getPetUserMemory(petInfo._id);
            const memory = JSON.stringify(memoryJson);
            getUserMemory = await processMemory(
              memory,
              getApiFormat(thisModel),
              thisModel.modelApiKey,
              thisModel.modelName,
              thisModel.modelUrl
            );
            setUserMemory(getUserMemory);
          }
          let systemContent = timeContext ? `${timeContext}\n\n` : '';
          systemContent += `你现在扮演的角色设定如下：\n${petInfo?.systemInstruction}\n关于用户的信息设定如下:\n${userMemory}\n`;
          systemContent += "请在回答中保持角色特点和用户设定。";
          const systemPrompt = { role: "system", content: systemContent };
          
          fullMessages = [...historyMessages, systemPrompt, { role: "user", content: content   }];
        } else {
          let systemContent = timeContext ? `${timeContext}\n\n` : '';
          systemContent += `你现在扮演的角色设定如下：\n${petInfo?.systemInstruction}\n`;
          systemContent += "请在回答中保持角色特点。";
          const systemPrompt = { role: "system", content: systemContent };
          
          fullMessages = [...historyMessages, systemPrompt, { role: "user", content: content   }];
        }
      } else {
        thisModel = functionModelInfo == null ? petInfo : functionModelInfo;
        if (memoryEnabled) {
          const index = await longTimeMemory(_userText, 
            getApiFormat(thisModel),
            thisModel.modelApiKey,
            thisModel.modelName,
            thisModel.modelUrl
          );
          let getUserMemory = "";
          if (index.isImportant === true) {
            await bridge.updatePetUserMemory(petInfo._id, index.key, index.value);
            bridge.updateChatbodyStatus(index.key + ":" + index.value, sendingConversationId);
            const memoryJson = await bridge.getPetUserMemory(petInfo._id);
            const memory = JSON.stringify(memoryJson);
            getUserMemory = await processMemory(
              memory,
              getApiFormat(thisModel),
              thisModel.modelApiKey,
              thisModel.modelName,
              thisModel.modelUrl
            );
            setUserMemory(getUserMemory);
          }
          let systemContent = timeContext ? `${timeContext}\n\n` : '';
          systemContent += `关于用户的信息设定如下, 请在需要使用的时候根据用户设定回答:\n${userMemory}\n`;
          systemContent += "You are a helpful assisatant";
          const systemPrompt = { role: "system", content: systemContent };
          
          fullMessages = [...historyMessages, systemPrompt, { role: "user", content: content   }];
        } else {
          let systemContent = timeContext ? `${timeContext}\n\n` : '';
          systemContent += `You are a helpful assisatant`;
          const systemPrompt = { role: "system", content: systemContent };
          
          fullMessages = [...historyMessages, systemPrompt, { role: "user", content: content   }];
        }
      }
      
      if (userImage || attachments.length > 0) {
          setUserImage(null);
          setAttachments([]);
      }

    reply = null;

    // Create new AbortController for this conversation's request
    const controller = new AbortController();
    abortControllersRef.current.set(initialConversationId, controller);

    // 检查是否启用了 MCP 工具
    const mcpEnabled = enabledMcpServers.size > 0;

    // 调试日志：检查 MCP 状态
    console.log('[ChatboxInputBox] MCP Debug:', {
      mcpEnabled,
      enabledMcpServersSize: enabledMcpServers.size,
      enabledMcpServers: Array.from(enabledMcpServers),
      hasTools,
      mcpToolsLength: mcpTools.length,
      mcpToolNames: mcpTools.map(t => t.name)
    });

    // 根据是否启用 MCP 工具选择不同的调用方式
    if (mcpEnabled && hasTools && mcpTools.length > 0) {
      console.log('[ChatboxInputBox] Calling LLM with MCP tools:', mcpTools.length, 'tools available');
      
      try {
        const mcpResult = await callLLMStreamWithTools({
          messages: fullMessages,
          apiFormat: getApiFormat(petInfo),
          apiKey: petInfo.modelApiKey,
          model: petInfo.modelName,
          baseUrl: petInfo.modelUrl,
          mcpTools: mcpTools,
          options: {},
          onChunk: (deltaText, fullText) => {
            dispatch({ 
              type: actionType.ADD_STREAMING_REPLY, 
              content: deltaText,
              id: sendingConversationId 
            });
          },
          onToolCall: (toolName, args, toolCallId) => {
            console.log('[MCP] Tool called:', toolName, args);
            // Dispatch to add tool call to live display
            dispatch({
              type: actionType.ADD_TOOL_CALL,
              conversationId: sendingConversationId || 'temp',
              toolCall: {
                id: toolCallId || `${toolName}-${Date.now()}`,
                toolName,
                args,
                status: 'running',
                startTime: Date.now()
              }
            });
          },
          onToolResult: (toolName, result, toolCallId, isError) => {
            console.log('[MCP] Tool result:', toolName, result?.slice?.(0, 100));
            // Update tool call status
            dispatch({
              type: actionType.UPDATE_TOOL_CALL,
              conversationId: sendingConversationId || 'temp',
              toolCallId: toolCallId || `${toolName}`,
              updates: {
                status: isError ? 'error' : 'success',
                result: result,
                endTime: Date.now()
              }
            });
          },
          abortSignal: controller.signal
        });
        
        reply = {
          content: mcpResult.content,
          mood: 'normal',  // MCP 模式暂不支持情绪检测
          toolCallHistory: mcpResult.toolCallHistory
        };
        
        console.log('[ChatboxInputBox] MCP call completed with', mcpResult.toolCallHistory?.length || 0, 'tool calls');
        
        // Clear live tool calls after a short delay to let user see final status
        setTimeout(() => {
          dispatch({
            type: actionType.CLEAR_TOOL_CALLS,
            conversationId: sendingConversationId || 'temp'
          });
        }, 2000);
      } catch (error) {
        console.error('[ChatboxInputBox] MCP call failed:', error);
        reply = { content: `Error: ${error.message}`, mood: 'normal' };
        
        // Clear tool calls on error too
        dispatch({
          type: actionType.CLEAR_TOOL_CALLS,
          conversationId: sendingConversationId || 'temp'
        });
      }
    } else {
      console.log('[ChatboxInputBox] Calling callOpenAILibStream with hasMood:', petInfo.hasMood, 'petInfo:', petInfo);

      reply = await callOpenAILibStream(
        fullMessages,
        getApiFormat(petInfo),
        petInfo.modelApiKey,
        petInfo.modelName,
        petInfo.modelUrl,
        (chunk) => {
            // 无论当前是否在同一个 tab，都更新对应 conversation 的流式内容
            dispatch({ 
                type: actionType.ADD_STREAMING_REPLY, 
                content: chunk,
                id: sendingConversationId 
            });
        },
        controller.signal, // Pass the signal
        { hasMood: petInfo.hasMood !== false } // 传递 hasMood 选项
      );
      
      console.log('[ChatboxInputBox] callOpenAILibStream returned:', reply);
    }
      
    // Clear this conversation's abort controller after completion
    abortControllersRef.current.delete(initialConversationId);

    // 清除流式输出内容，准备显示最终消息
    dispatch({ type: actionType.CLEAR_STREAMING_REPLY, id: sendingConversationId });

    if (!reply) {
        reply = { content: "Error: No response from AI.", mood: "normal" };
    }

    const botReply = { 
      role: "assistant", 
      content: reply.content || "Error: Empty response",
      // 保存 MCP 工具调用历史到消息中
      ...(reply.toolCallHistory && reply.toolCallHistory.length > 0 && { toolCallHistory: reply.toolCallHistory })
    };

    // 只在 AI 回复后插入机器人消息，且仅当用户仍停留在当前对话时
    if (sendingConversationId === conversationIdRef.current) {
      dispatch({ type: actionType.ADD_MESSAGE, message: botReply });
    }

    if (!sendingConversationId) {
      try {
        const newConversation = await bridge.createConversation({
          petId: petInfo._id,
          title: _userText,
          history: [...userMessages, { role: "user", content: displayContent }, botReply],
        });
        if (newConversation) {
            sendingConversationId = newConversation._id;
            // 如果用户还在当前页面，更新 ref
            if (!conversationIdRef.current) {
                conversationIdRef.current = newConversation._id;
            }
        }
      } catch (error) {
        console.error("Failed to create conversation:", error);
      }
    }

    // 使用 sendingConversationId 更新数据库，确保写入正确的对话
    if (sendingConversationId) {
        const newHistory = [...historyMessages, { role: "user", content: displayContent }, botReply];
        
        // Only update title if it's the first message
        const isFirstMessage = userMessages.length === 0;
        const newTitle = isFirstMessage ? _userText : undefined;

        const updatePayload = {
            petId: petInfo._id,
            history: newHistory,
        };
        if (newTitle) {
            updatePayload.title = newTitle;
        }

        await bridge.updateConversation(sendingConversationId, updatePayload);
        
        // 通知全局状态更新该会话的消息记录（无论是否当前激活）
        dispatch({
            type: actionType.UPDATE_CONVERSATION_MESSAGES,
            id: sendingConversationId,
            messages: newHistory,
            title: newTitle
        });
    }

    if (reply) {
      setStateReply(reply);
      setStateReplyConversationId(sendingConversationId); // Save the conversation ID with the reply
    }
    if (thisModel) setStateThisModel(thisModel);
    if (_userText) setStateUserText(_userText);
    
    } catch (error) {
      console.error('[handleSend] Error occurred:', error);
      // Ensure we have some reply object for the finally block
      if (!reply) {
        reply = { content: `Error: ${error.message}`, mood: 'normal' };
      }
    } finally {
      // ✅ 确保无论如何都会重置 thinking 状态，避免卡住
      bridge.sendMoodUpdate(reply?.mood || "normal", initialConversationId);
      // 从生成中会话集合中移除（使用初始 ID）
      setGeneratingConversations(prev => {
        const newSet = new Set(prev);
        newSet.delete(initialConversationId);
        return newSet;
      });
      // 清理 AbortController
      abortControllersRef.current.delete(initialConversationId);
      bridge.updateChatbodyStatus?.("", initialConversationId);
    }
  };


  // Listen for regeneration requests
  useEffect(() => {
    if (runFromHereTimestamp) {
        // Trigger send logic
        // We need to ensure we don't trigger this on initial load, but runFromHereTimestamp is only set by action
        handleSend();
    }
  }, [runFromHereTimestamp]);


// 处理粘贴事件，支持图片、视频、音频和其他文件
const handlePaste = async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  
  const filesToProcess = [];
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Check if item is a file (image, video, audio, etc.)
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        filesToProcess.push(file);
      }
    }
  }
  
  if (filesToProcess.length > 0) {
    e.preventDefault();
    
    for (const file of filesToProcess) {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments(prev => [...prev, attachment]);
      }
    }
  }
};

const [showReplyOptions, setShowReplyOptions] = useState(false);
const replyOptionsTimeoutRef = useRef(null);

// 延迟关闭 Quick Reply 菜单
const handleReplyOptionsLeave = () => {
  replyOptionsTimeoutRef.current = setTimeout(() => {
    setShowReplyOptions(false);
  }, 300); // 300ms 延迟，给用户时间移动到菜单
};

const handleReplyOptionsEnter = () => {
  if (replyOptionsTimeoutRef.current) {
    clearTimeout(replyOptionsTimeoutRef.current);
    replyOptionsTimeoutRef.current = null;
  }
  setShowReplyOptions(true);
};

const handleStop = async () => {
    console.log('[handleStop] Stopping generation and MCP tool calls');
    
    // 取消当前会话的请求
    const currentConvId = conversationIdRef.current || 'temp';
    const controller = abortControllersRef.current.get(currentConvId);
    
    // 取消 AbortController（如果存在）
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(currentConvId);
    }
    
    // 始终清除生成状态（即使 controller 不存在）
    setGeneratingConversations(prev => {
      const newSet = new Set(prev);
      newSet.delete(currentConvId);
      newSet.delete('temp'); // 同时清除 temp 状态
      return newSet;
    });
    
    // 清除该会话的工具调用状态
    dispatch({
      type: actionType.CLEAR_TOOL_CALLS,
      conversationId: currentConvId
    });
    
    // 重置心情状态为正常
    bridge.sendMoodUpdate('normal', currentConvId);
    
    // 清除聊天状态
    bridge.updateChatbodyStatus?.('', currentConvId);
    
    // 取消所有 MCP 工具调用
    try {
      if (bridge.mcp?.cancelAllToolCalls) {
        await bridge.mcp.cancelAllToolCalls();
        console.log('[handleStop] MCP tool calls cancelled');
      }
    } catch (err) {
      console.error('[handleStop] Failed to cancel MCP tool calls:', err);
    }
  };

  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  // Helper function to process a file and add to attachments
  const processFile = async (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64Data = event.target.result;
        try {
          // Save to Electron
          const result = await bridge.saveFile({
            fileName: file.name,
            fileData: base64Data,
            mimeType: file.type
          });
          
          if (!result || !result.path) {
            console.error('saveFile returned invalid result:', result);
            resolve(null);
            return;
          }
          
          // Determine type based on mime
          let type = 'file_url';
          if (file.type.startsWith('image/')) type = 'image_url';
          
          resolve({
            type,
            url: base64Data,
            path: result.path,
            name: file.name,
            mime_type: file.type,
            data: base64Data
          });
        } catch (err) {
          console.error('Failed to save file:', err);
          resolve(null);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments(prev => [...prev, attachment]);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Drag and drop handlers
  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if leaving the container (not entering a child)
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    
    for (const file of files) {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments(prev => [...prev, attachment]);
      }
    }
  };

  return (
    <div className="relative w-full max-w-3xl mx-auto px-4 pb-4 no-drag">
      {/* 主输入框容器：模仿图2的紧凑风格 */}
      <div 
        className={`relative bg-[#f4f4f4] rounded-[26px] p-3 shadow-sm border transition-all no-drag ${
          isDragging 
            ? 'border-blue-400 bg-blue-50' 
            : 'border-transparent focus-within:border-gray-200'
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-blue-100/80 rounded-[26px] z-10 pointer-events-none">
            <div className="text-blue-500 font-medium text-sm">
              Drop files here
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
            <PastedImagePreview imageUrl={userImage} onRemove={() => setUserImage(null)} />
            {attachments.map((att, index) => (
                <div key={index} className="relative inline-block rounded-md mt-2 bg-gray-100 border border-gray-200 overflow-hidden">
                    {att.type === 'image_url' ? (
                        <img src={att.url} alt="Attachment" className="w-20 h-20 object-cover" />
                    ) : att.mime_type?.startsWith('video/') ? (
                        <div className="w-20 h-20 bg-black flex items-center justify-center relative">
                            <video src={att.url} className="w-full h-full object-cover" muted />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                                <span className="text-white text-2xl">▶</span>
                            </div>
                        </div>
                    ) : att.mime_type?.startsWith('audio/') ? (
                        <div className="w-20 h-20 bg-gradient-to-br from-green-400 to-green-600 flex flex-col items-center justify-center p-1">
                            <span className="text-white text-2xl">🎵</span>
                            <span className="text-white text-[8px] truncate w-full text-center mt-1">{att.name}</span>
                        </div>
                    ) : (
                        <div className="w-20 h-20 flex flex-col items-center justify-center p-1">
                            <FaFile className="text-gray-500 text-xl" />
                            <span className="text-[8px] text-gray-600 truncate w-full text-center mt-1">{att.name}</span>
                        </div>
                    )}
                    <MdOutlineCancel 
                        className="absolute -top-2 -right-2 cursor-pointer z-10 text-gray-500 hover:text-red-500 bg-white rounded-full"
                        onClick={() => handleRemoveAttachment(index)}
                    />
                </div>
            ))}
        </div>
        <textarea
          ref={inputRef}
          value={userText}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={autoResize}
          placeholder="Ask anything"
          rows={1}
          className="w-full bg-transparent outline-none text-gray-800 placeholder-gray-500 mb-8 no-drag resize-none overflow-y-auto" 
          style={{ maxHeight: '200px', minHeight: '24px' }}
          onChange={handleChange}
        />



        {/* 底部工具栏：左侧功能开关 + 右侧发送按钮 */}
        <div className="absolute bottom-2 left-3 right-2 flex items-center justify-between">
            {/* Left: Tools (Agent, Memory, Search) */}
            <div className="flex items-center gap-1">
                <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="p-2 text-gray-500 hover:bg-gray-200 rounded-full transition-colors"
                    title="Add Attachment"
                >
                    <AiOutlinePlus className="w-5 h-5" />
                </button>
                <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileSelect} 
                    className="hidden" 
                    multiple 
                />
                
                <button
                    onClick={toggleMemory}
                    className={`p-2 rounded-full transition-colors ${
                        memoryEnabled ? "text-blue-600 bg-blue-100" : "text-gray-500 hover:bg-gray-200"
                    }`}
                    title="Memory"
                >
                    <FaBrain className="w-4 h-4" />
                </button>
                
                {/* MCP 工具栏 - 每个服务器单独的图标 */}
                <McpToolbar
                    servers={mcpServers}
                    enabledServers={enabledMcpServers}
                    onToggleServer={toggleMcpServer}
                    onUpdateServer={updateMcpServer}
                    onDeleteServer={deleteMcpServer}
                    onEditIcon={editMcpServerIcon}
                    onBatchUpdateOrder={batchUpdateMcpOrder}
                    maxVisible={5}
                />

                {/* Model Info / Status (Figure 2 style) */}
                {petInfo && (
                    <div className="ml-2 px-2 py-1 bg-gray-200/50 rounded-md text-xs font-medium text-gray-600 flex flex-col justify-center select-none min-w-[60px]">
                        <div className="font-bold text-gray-800 leading-tight truncate max-w-[100px]">
                            {petInfo.name}
                        </div>
                        <div className="text-[10px] text-gray-500 leading-tight truncate max-w-[100px] flex items-center gap-1">
                            {isGenerating ? (
                                <span className="animate-pulse text-blue-500">Thinking...</span>
                            ) : (
                                <span>{petInfo.modelName || "3.0"}</span>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Right: Quick Reply & Send */}
            <div className="flex items-center gap-2">
                {/* Quick Reply Button */}
                <div 
                    className="relative"
                    onMouseEnter={handleReplyOptionsEnter}
                    onMouseLeave={handleReplyOptionsLeave}
                >
                    <button
                        onClick={() => setShowReplyOptions(prev => !prev)}
                        className="p-2 rounded-full hover:bg-gray-200 transition-colors text-gray-500"
                    >
                        <SiQuicktype className="w-5 h-5" style={{ color:(suggestText.length == 0) ? "#c1c1c1" : "#555" }} />
                    </button>
                    
                    {showReplyOptions && suggestText.length !== 0 && (
                        <div 
                            className="absolute bottom-full right-0 mb-2 w-48 bg-white border border-gray-200 rounded-xl shadow-xl p-2 z-50"
                            onMouseEnter={handleReplyOptionsEnter}
                            onMouseLeave={handleReplyOptionsLeave}
                        >
                        <div className="font-bold mb-2 text-xs text-gray-400 px-1">Quick reply</div>
                        <ul className="space-y-1">
                            {suggestText.map((item, index) => (
                            <li key={index} className="cursor-pointer hover:bg-gray-100 p-2 rounded-lg text-xs text-gray-700 transition-colors"
                            onClick={() => {
                                setUserText(userText + suggestText[index]);
                                setShowReplyOptions(false);
                            }}>
                                {item}
                            </li>
                            ))}
                        </ul>
                        </div>
                    )}
                </div>

                {/* Send Button */}
                <button
                    onClick={isGenerating ? handleStop : handleSend}
                    disabled={!String(userText).trim() && !isGenerating && !(userMessages.length > 0 && userMessages[userMessages.length - 1].role === 'user')}
                    className={`p-2 rounded-full transition-all duration-200 ${
                        !String(userText).trim() && !isGenerating && !(userMessages.length > 0 && userMessages[userMessages.length - 1].role === 'user')
                        ? "bg-gray-300 cursor-not-allowed" 
                        : "bg-black hover:bg-gray-800 shadow-md"
                    }`}
                >
                    {!isGenerating ? (
                    <FaArrowUp className="w-4 h-4 text-white" />
                    ) : (
                    <FaStop className="w-4 h-4 text-white animate-pulse" />
                    )}
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};

export default ChatboxInputBox;