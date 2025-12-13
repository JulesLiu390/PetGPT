import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import { FaArrowUp, FaGlobe, FaShareNodes, FaFile, FaMagnifyingGlass, FaStop } from "react-icons/fa6";
import { AiOutlinePlus } from "react-icons/ai";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { promptSuggestion, callOpenAILib, callOpenAILibStream, callCommand, longTimeMemory, processMemory, refinedSearchFromPrompt } from '../../utils/openai';
import { searchDuckDuckGo } from "../../utils/search"
import { MdOutlineCancel } from "react-icons/md";
import { SiQuicktype } from "react-icons/si";

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
  const [isGenerating, setIsGenerating] = useState(false);
  const [agentActive, setAgentActive] = useState(false); // Agent 开关
  // 新增记忆功能开关状态
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  // 新增搜索按钮高亮状态
  const [searchActive, setSearchActive] = useState(false);

  const [userImage, setUserImage] = useState(null);
  const [stateReply, setStateReply] = useState(null);
  const [stateThisModel, setStateThisModel] = useState(null);
  const [stateUserText, setStateUserText] = useState(null);
  let reply = null;
  let thisModel = null;
  let _userText = null;

  useEffect(() => {
    if (activePetId) {
      setCharacterId(activePetId);
    }
  }, [activePetId]);

  const toggleAgent = () => {
    // alert(system)
    if(!system.toLowerCase().includes("mac")) {
      alert("sorry, agent function is only supported on MacOS now.")
      return;
    }
    setAgentActive(prev => !prev);
    console.log(!agentActive ? "Agent 已启动" : "Agent 已关闭");
  };

  // 新增记忆功能切换函数
  const toggleMemory = () => {
    setMemoryEnabled(prev => !prev);
    console.log(!memoryEnabled ? "记忆功能开启" : "记忆功能关闭");
  };

  // 搜索按钮点击时仅切换高亮状态，不执行搜索逻辑
  const toggleSearch = () => {
    setSearchActive(prev => !prev);
    console.log(!searchActive ? "Search highlight turned on" : "Search highlight turned off");
  };

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
  const [{ userMessages, suggestText, runFromHereTimestamp }, dispatch] = useStateValue();
  // 将 userText 从全局状态中移除，改为本地状态管理
  const [userText, setUserText] = useState("");
  const [characterId, setCharacterId] = useState(null);
  const [petInfo, setPetInfo] = useState(null);
  const [functionModelInfo, setFunctionModelInfo] = useState(null);
  const composingRef = useRef(false);
  const ignoreEnterRef = useRef(false);
  const conversationIdRef = useRef(null);
  const abortControllerRef = useRef(null);
  const [userMemory, setUserMemory] = useState(null);
  const [founctionModel, setFounctionModel] = useState(null);
  const [system, setSystem] = useState(null);
  const [firstCharacter, setFirstCharacter] = useState(null)

  // 启动时加载默认角色ID
  useEffect(() => {
    setSystem(window.navigator.platform);
    const loadDefaultCharacter = async () => {
      const settings = await window.electron.getSettings();
      try {
        if (settings && settings.defaultRoleId) {
          
          // console.log("📚 Loading default character ID from settings:", settings.defaultRoleId);
          
          // 验证ID是否有效（优先尝试 getAssistant，然后回退到 getPet）
          try {
            let pet = null;
            try {
              pet = await window.electron.getAssistant(settings.defaultRoleId);
            } catch (e) {
              // 忽略，尝试旧 API
            }
            if (!pet) {
              pet = await window.electron.getPet(settings.defaultRoleId);
            }
            if (pet) {
              setFirstCharacter(settings.defaultRoleId);
              // console.log("Default character ID validated successfully111ß");
            } else {
              console.log("Default character ID not found in database, using null");
              setCharacterId(null);
            }
          } catch (petError) {
            console.error("Error finding pet with default ID:", petError);
            setCharacterId(null);
          }
        }
      } catch (error) {
        console.error("Error loading default character ID from settings:", error);
        setCharacterId(null);
      }

      try {
        const settings = await window.electron.getSettings();
        if (settings && settings.defaultModelId) {
          // console.log("📚 Loading default character ID from settings:", settings.defaultModelId);
          
          // 验证ID是否有效（优先尝试 getAssistant，然后回退到 getPet）
          try {
            let pet = null;
            try {
              pet = await window.electron.getAssistant(settings.defaultModelId);
            } catch (e) {
              // 忽略，尝试旧 API
            }
            if (!pet) {
              pet = await window.electron.getPet(settings.defaultModelId);
            }
            if (pet) {
              setFounctionModel(settings.defaultModelId);
              console.log("Default character ID validated successfully");
              const { _id, name, modelName, modelApiKey, modelProvider, modelUrl, apiFormat } = pet;
              const systemInstruction = pet.systemInstruction || pet.personality || '';
              setFunctionModelInfo({ _id, name, modelName, systemInstruction, modelApiKey, modelProvider, modelUrl, apiFormat });
            } else {
              console.log("Default character ID not found in database, using null");
              setFunctionModelInfo(null);
            }
          } catch (petError) {
            console.error("Error finding pet with default ID:", petError);
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
      window.electron?.sendCharacterId(firstCharacter);
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
    window.electron?.onCharacterId(handleCharacterId);
  }, []);

  useEffect(() => {
    const updateSuggestion = async() => {
      // alert(thisModel)
      thisModel = stateThisModel;
      _userText = stateUserText;
      
      if (!thisModel || !stateReply) return;

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
            dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: suggestion });
        } else {
            dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [] });
        }
      } catch (error) {
        console.error("Error getting suggestions:", error);
        dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [] });
      }
    };
    if(stateReply != null) {
      // alert(stateReply)
      updateSuggestion();
    }
  }, [stateReply]);

  // 加载角色信息，并清理或保留对话历史
  useEffect(() => {
    if (!characterId) return;

    const fetchPetInfo = async () => {
      try {
        // 首先尝试从新的 Assistant API 获取
        let assistant = await window.electron.getAssistant(characterId);
        let modelConfig = null;
        
        if (assistant && assistant.modelConfigId) {
          // 新数据模型：从关联的 ModelConfig 获取 API 配置
          modelConfig = await window.electron.getModelConfig(assistant.modelConfigId);
        }
        
        // 如果新 API 没有数据，回退到旧的 Pet API（向后兼容）
        if (!assistant) {
          assistant = await window.electron.getPet(characterId);
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
          thisModel = null;
          if(functionModelInfo == null) {
            thisModel = apiConfig;
          } else {
            thisModel = functionModelInfo;
          }

          try {
            const memoryJson = await window.electron.getPetUserMemory(characterId);
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

        if (conversationIdRef.current && window.electron) {
          const currentConv = await window.electron.getConversationById(conversationIdRef.current);
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
    if (window.electron && window.electron.onNewChatCreated) {
      cleanup = window.electron.onNewChatCreated(handleNewChat);
    }

    // 卸载时清理监听器，避免内存泄漏
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 接收会话 ID
  useEffect(() => {
    const fetch = async (conversationId) => {
      try {
        const conv = await window.electron.getConversationById(conversationId);
        setCharacterId(conv.petId)
        // alert(conv.petID);
      } catch (error) {
        console.error("Error fetching conversation:", error);
        throw error;
      }
    };

    const handleConversationId = async(id) => {
      await fetch(id);
      console.log("📥 Received conversation ID from Electron:", id);


      conversationIdRef.current = id;
    };

    if (window.electron?.onConversationId) {
      window.electron.onConversationId(handleConversationId);
    }
  }, []);

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
  const autoResize = () => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const newHeight = Math.min(inputRef.current.scrollHeight, 200);
      inputRef.current.style.height = newHeight + 'px';
    }
  };

  const [characterMood, setCharacterMood] = useState("normal");

  // 回车发送
  const handleKeyDown = (e) => {
    if (composingRef.current || ignoreEnterRef.current) return;
    if (e.key === "Enter" && !e.shiftKey && characterMood != "thinking" && String(userText).trim()) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    const moodUpdateHandler = (event, updatedMood) => {
      console.log("Received updated mood:", updatedMood);
      setCharacterMood(updatedMood);
    };
    window.electron?.onMoodUpdated(moodUpdateHandler);

    // 如果需要在组件卸载时移除监听，可在此处调用 removeListener
    return () => {
      // window.electron?.removeMoodUpdated(moodUpdateHandler);
    };
  }, []);

  

  // 发送消息
  const handleSend = async () => {
    if (!characterId) {
      alert("Please select a character first!");
      return;
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

    setIsGenerating(true);

    // 🔒 锁定当前对话 ID，防止在等待 AI 回复期间切换标签导致数据错乱
    let sendingConversationId = conversationIdRef.current;

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
    dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [] });

    // 仅当用户仍停留在当前对话时，才更新 UI
    if (!isRunFromHere && sendingConversationId === conversationIdRef.current) {
      dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: displayContent} });
    }

    window.electron?.sendMoodUpdate('thinking');

    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = 'auto';
    }

    let fullMessages = [];
    const isDefaultPersonality = petInfo?.systemInstruction &&
      (petInfo.systemInstruction.trim().toLowerCase() === "default model (english)" ||
       petInfo.systemInstruction.trim().toLowerCase() === "default");
    thisModel = petInfo;

    const historyMessages = isRunFromHere ? userMessages.slice(0, -1) : userMessages;

    if (agentActive) {
      // Agent 模式不改变原有逻辑
      fullMessages = [...historyMessages, { role: "user", content: _userText }];
    } else {

      let searchContent = "";
      thisModel = functionModelInfo == null ? petInfo : functionModelInfo;
      if(searchActive) {
        searchContent = await refinedSearchFromPrompt(
          _userText,
          getApiFormat(thisModel),
          thisModel.modelApiKey,
          thisModel.modelName,
          thisModel.modelUrl
        )
        searchContent = await searchDuckDuckGo(searchContent);
        searchContent = "\n Combine the following information to answer the question, and list relevant links below (if they are related to the question, be sure to list them):\n" + searchContent + "根据问题使用恰当的语言回答（如英语、中文）";
      }
      
      let content = displayContent;
      if (searchContent) {
          if (Array.isArray(content)) {
              // Clone to avoid modifying displayContent
              content = content.map(part => {
                  if (part.type === 'text') {
                      return { ...part, text: part.text + searchContent };
                  }
                  return part;
              });
          } else {
              content = content + searchContent;
          }
      }

      if (userImage || attachments.length > 0) {
          setUserImage(null);
          setAttachments([]);
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
            await window.electron.updatePetUserMemory(petInfo._id, index.key, index.value);
            window.electron.updateChatbodyStatus(index.key + ":" + index.value);
            const memoryJson = await window.electron.getPetUserMemory(petInfo._id);
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
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.systemInstruction}\n关于用户的信息设定如下:\n${userMemory}\n`;
          systemContent += "请在回答中保持角色特点和用户设定。";
          const systemPrompt = { role: "system", content: systemContent };
          
          fullMessages = [...historyMessages, systemPrompt, { role: "user", content: content   }];
        } else {
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.systemInstruction}\n`;
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
            await window.electron.updatePetUserMemory(petInfo._id, index.key, index.value);
            window.electron.updateChatbodyStatus(index.key + ":" + index.value);
            const memoryJson = await window.electron.getPetUserMemory(petInfo._id);
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
          let systemContent = `关于用户的信息设定如下, 请在需要使用的时候根据用户设定回答:\n${userMemory}\n`;
          systemContent += "You are a helpful assisatant";
          const systemPrompt = { role: "system", content: systemContent };
          
          fullMessages = [...historyMessages, systemPrompt, { role: "user", content: content   }];
        } else {
          let systemContent = `You are a helpful assisatant`;
          const systemPrompt = { role: "system", content: systemContent };
          
          fullMessages = [...historyMessages, systemPrompt, { role: "user", content: content   }];
        }
      }
      
      if (userImage || attachments.length > 0) {
          setUserImage(null);
          setAttachments([]);
      }
    }

    reply = null;

    if(agentActive) {
      reply = await callCommand(
        fullMessages,
        getApiFormat(petInfo),
        petInfo.modelApiKey,
        petInfo.modelName,
        petInfo.modelUrl
      );
      const commands = reply.excution || '';  // 你的多行命令

      function escapeShellCommand(cmd) {
        let cleaned = cmd
          .replace(/^```(?:bash|shell)\n/, '')
          .replace(/\n```$/, '');
        cleaned = cleaned
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/`/g, '\\`');
        return cleaned;
      }

      function escapeForAppleScript(str) {
        return str.replace(/'/g, "'\\''");
      }

      const shellCmdEscaped = escapeShellCommand(commands);
      const appleScriptCode = `
      tell application "Terminal"
        if (count of windows) = 0 then
          do script "${shellCmdEscaped}"
        else
          do script "${shellCmdEscaped}" in front window
        end if
      end tell
      `;
      const appleScriptEscaped = escapeForAppleScript(appleScriptCode);
      const osascriptCmd = `osascript -e '${appleScriptEscaped}'`;

      window.electron?.testOpen(osascriptCmd);

    } else {
      // Create new AbortController for this request
      const controller = new AbortController();
      abortControllerRef.current = controller;

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
      
      abortControllerRef.current = null; // Clear ref after completion
    }

    // 清除流式输出内容，准备显示最终消息
    dispatch({ type: actionType.CLEAR_STREAMING_REPLY, id: sendingConversationId });

    if (!reply) {
        reply = { content: "Error: No response from AI.", mood: "normal" };
    }

    const botReply = { role: "assistant", content: reply.content || "Error: Empty response" };

    // 只在 AI 回复后插入机器人消息，且仅当用户仍停留在当前对话时
    if (sendingConversationId === conversationIdRef.current) {
      dispatch({ type: actionType.ADD_MESSAGE, message: botReply });
    }

    if (!sendingConversationId) {
      try {
        const newConversation = await window.electron.createConversation({
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

        await window.electron.updateConversation(sendingConversationId, updatePayload);
        
        // 通知全局状态更新该会话的消息记录（无论是否当前激活）
        dispatch({
            type: actionType.UPDATE_CONVERSATION_MESSAGES,
            id: sendingConversationId,
            messages: newHistory,
            title: newTitle
        });
    }

    window.electron?.sendMoodUpdate(reply.mood || "normal");
    setIsGenerating(false);

    window.electron.updateChatbodyStatus("");

    if (reply) setStateReply(reply);
    if (thisModel) setStateThisModel(thisModel);
    if (_userText) setStateUserText(_userText);
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

const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
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
          const result = await window.electron.saveFile({
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
    <div className="relative w-full max-w-3xl mx-auto px-4 pb-4">
      {/* 主输入框容器：模仿图2的紧凑风格 */}
      <div 
        className={`relative bg-[#f4f4f4] rounded-[26px] p-3 shadow-sm border transition-all ${
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
          className="w-full bg-transparent outline-none resize-none text-gray-800 placeholder-gray-500 min-h-[24px] max-h-[200px] overflow-y-auto mb-8" 
          onChange={handleChange}
          style={{ height: 'auto' }}
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
                    onClick={toggleAgent}
                    className={`p-2 rounded-full transition-colors ${
                        agentActive ? "text-green-600 bg-green-100" : "text-gray-500 hover:bg-gray-200"
                    }`}
                    title="Agent Mode"
                >
                    <FaGlobe className="w-4 h-4" />
                </button>

                <button
                    onClick={toggleMemory}
                    className={`p-2 rounded-full transition-colors ${
                        memoryEnabled ? "text-blue-600 bg-blue-100" : "text-gray-500 hover:bg-gray-200"
                    }`}
                    title="Memory"
                >
                    <FaFile className="w-4 h-4" />
                </button>

                <button
                    onClick={toggleSearch}
                    className={`p-2 rounded-full transition-colors ${
                        searchActive ? "text-purple-600 bg-purple-100" : "text-gray-500 hover:bg-gray-200"
                    }`}
                    title="Search"
                >
                    <FaMagnifyingGlass className="w-4 h-4" />
                </button>

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
                <div className="relative">
                    <button
                        onClick={() => {}}
                        onMouseEnter={() => setShowReplyOptions(true)}
                        onMouseLeave={() => setShowReplyOptions(false)}
                        className="p-2 rounded-full hover:bg-gray-200 transition-colors text-gray-500"
                    >
                        <SiQuicktype className="w-5 h-5" style={{ color:(suggestText.length == 0) ? "#c1c1c1" : "#555" }} />
                    </button>
                    
                    {showReplyOptions && suggestText.length !== 0 && (
                        <div 
                        className="absolute bottom-full right-0 mb-2 w-48 bg-white border border-gray-200 rounded-xl shadow-xl p-2 z-50"
                        onMouseEnter={() => setShowReplyOptions(true)}
                        onMouseLeave={() => setShowReplyOptions(false)}
                        >
                        <div className="font-bold mb-2 text-xs text-gray-400 px-1">Quick reply</div>
                        <ul className="space-y-1">
                            {suggestText.map((item, index) => (
                            <li key={index} className="cursor-pointer hover:bg-gray-100 p-2 rounded-lg text-xs text-gray-700 transition-colors"
                            onClick={() => setUserText(userText + suggestText[index])}>
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