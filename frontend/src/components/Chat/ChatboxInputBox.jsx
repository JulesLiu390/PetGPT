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
  const [{ userMessages, suggestText }, dispatch] = useStateValue();
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
          
          // 验证ID是否有效（是否能找到对应的pet数据）
          try {
            const pet = await window.electron.getPet(settings.defaultRoleId);
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
          
          // 验证ID是否有效（是否能找到对应的pet数据）
          try {
            const pet = await window.electron.getPet(settings.defaultModelId);
            if (pet) {
              setFounctionModel(settings.defaultModelId);
              console.log("Default character ID validated successfully");
              const { _id, name, modelName, personality, modelApiKey, modelProvider, modelUrl } = pet;
              setFunctionModelInfo({ _id, name, modelName, personality, modelApiKey, modelProvider, modelUrl });
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
            thisModel.modelProvider,
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
        const pet = await window.electron.getPet(characterId);
        if (pet) {
          const { _id, name, modelName, personality, modelApiKey, modelProvider, modelUrl } = pet;
          setPetInfo({ _id, name, modelName, personality, modelApiKey, modelProvider, modelUrl });
          thisModel = null;
          if(functionModelInfo == null) {
            thisModel = pet;
          } else {
            thisModel = functionModelInfo;
          }

          try {
            const memoryJson = await window.electron.getPetUserMemory(characterId);
            const memory = JSON.stringify(memoryJson);
            const getUserMemory = await processMemory(
              memory,
              thisModel.modelProvider,
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
    setIsGenerating(true);
    if (!userText.trim()) return;

    // 🔒 锁定当前对话 ID，防止在等待 AI 回复期间切换标签导致数据错乱
    let sendingConversationId = conversationIdRef.current;

    _userText = userText;
    
    setUserText("");
    dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [] });


    window.electron?.sendMoodUpdate('thinking');

    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = 'auto';
    }

    let fullMessages = [];
    const isDefaultPersonality = petInfo?.personality &&
      (petInfo.personality.trim().toLowerCase() === "default model (english)" ||
       petInfo.personality.trim().toLowerCase() === "default");
    thisModel = petInfo;

    if (agentActive) {
      // Agent 模式不改变原有逻辑
      fullMessages = [...userMessages, { role: "user", content: _userText }];
      // 仅当用户仍停留在当前对话时，才更新 UI
      if (sendingConversationId === conversationIdRef.current) {
        dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText } });
      }
    } else {

      let searchContent = "";
      thisModel = functionModelInfo == null ? petInfo : functionModelInfo;
      if(searchActive) {
        searchContent = await refinedSearchFromPrompt(
          _userText,
          thisModel.modelProvider,
          thisModel.modelApiKey,
          thisModel.modelName,
          thisModel.modelUrl
        )
        searchContent = await searchDuckDuckGo(searchContent);
        searchContent = "\n Combine the following information to answer the question, and list relevant links below (if they are related to the question, be sure to list them):\n" + searchContent + "根据问题使用恰当的语言回答（如英语、中文）";
      }
      // alert(userImage)

      if (!isDefaultPersonality) {
        if (memoryEnabled) {
          const index = await longTimeMemory(_userText, 
            thisModel.modelProvider,
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
              thisModel.modelProvider,
              thisModel.modelApiKey,
              thisModel.modelName,
              thisModel.modelUrl
            );
            setUserMemory(getUserMemory);
          }
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.personality}\n关于用户的信息设定如下:\n${userMemory}\n`;
          if (petInfo.isAgent) {
            systemContent += "请在回答中保持角色特点和用户设定，生成回复内容。";
          } else {
            systemContent += "请在回答中保持角色特点和用户设定，同时生成回复内容和情绪(mood: angry, smile, normal)";
          }
          const systemPrompt = { role: "system", content: systemContent };
          // 仅当用户仍停留在当前对话时，才更新 UI
          if (sendingConversationId === conversationIdRef.current) {
            dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          }
          let content = _userText + searchContent;
          if(userImage != null) {
            content = [{ type: "text", text: _userText + searchContent },
            {
                type: "image_url",
                image_url: {
                    url: `${userImage}`,
                },
            },]
            setUserImage(null);
          }
          fullMessages = [...userMessages, systemPrompt, { role: "user", content: content   }];
        } else {
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.personality}\n`;
          if (petInfo.isAgent) {
            systemContent += "请在回答中保持角色特点，生成回复内容。";
          } else {
            systemContent += "请在回答中保持角色特点，同时生成回复内容和情绪(mood: angry, smile, normal)";
          }
          const systemPrompt = { role: "system", content: systemContent };
          // 仅当用户仍停留在当前对话时，才更新 UI
          if (sendingConversationId === conversationIdRef.current) {
            dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          }
          let content = _userText + searchContent;
          if(userImage != null) {
            content = [{ type: "text", text: _userText + searchContent },
            {
                type: "image_url",
                image_url: {
                    url: `${userImage}`,
                },
            },]
            setUserImage(null);
          }
          fullMessages = [...userMessages, systemPrompt, { role: "user", content: content   }];
        }
      } else {
        thisModel = functionModelInfo == null ? petInfo : functionModelInfo;
        if (memoryEnabled) {
          const index = await longTimeMemory(_userText, 
            thisModel.modelProvider,
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
              thisModel.modelProvider,
              thisModel.modelApiKey,
              thisModel.modelName,
              thisModel.modelUrl
            );
            setUserMemory(getUserMemory);
          }
          let systemContent = `关于用户的信息设定如下, 请在需要使用的时候根据用户设定回答:\n${userMemory}\n`;
          systemContent += "You are a helpful assisatant";
          const systemPrompt = { role: "system", content: systemContent };
          // 仅当用户仍停留在当前对话时，才更新 UI
          if (sendingConversationId === conversationIdRef.current) {
            dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          }
          let content = _userText + searchContent;
          if(userImage != null) {
            content = [{ type: "text", text: _userText + searchContent },
            {
                type: "image_url",
                image_url: {
                    url: `${userImage}`,
                },
            },]
            setUserImage(null);
          }
          fullMessages = [...userMessages, systemPrompt, { role: "user", content: content   }];
        } else {
          let systemContent = `You are a helpful assisatant`;
          const systemPrompt = { role: "system", content: systemContent };
          // 仅当用户仍停留在当前对话时，才更新 UI
          if (sendingConversationId === conversationIdRef.current) {
            dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          }
          let content = _userText + searchContent;
          if(userImage != null) {
            content = [{ type: "text", text: _userText + searchContent },
            {
                type: "image_url",
                image_url: {
                    url: `${userImage}`,
                },
            },]
            setUserImage(null);
          }
          fullMessages = [...userMessages, systemPrompt, { role: "user", content: content   }];
        }
      }
    }

    reply = null;

    if(agentActive) {
      reply = await callCommand(
        fullMessages,
        petInfo.modelProvider,
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

      reply = await callOpenAILibStream(
        fullMessages,
        petInfo.modelProvider,
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
        controller.signal // Pass the signal
      );
      
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
          history: [...userMessages, { role: "user", content: _userText }, botReply],
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
        const newHistory = [...userMessages, { role: "user", content: _userText }, botReply];
        
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


// 处理粘贴事件，检测是否有图片数据
const handlePaste = (e) => {
  const items = e.clipboardData?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        const file = items[i].getAsFile();
        // 使用 FileReader 将图片转换成 Base64 data URL
        const reader = new FileReader();
        reader.onload = (evt) => {
          const imageUrl = evt.target.result;
          setUserImage(imageUrl);
        };
        reader.readAsDataURL(file);
        // 阻止默认粘贴行为，避免在 textarea 中出现乱码文本
        e.preventDefault();
        break; // 处理到图片后退出循环
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

  return (
    <div className="relative w-full max-w-3xl mx-auto px-4 pb-4">
      {/* 主输入框容器：模仿图2的紧凑风格 */}
      <div className="relative bg-[#f4f4f4] rounded-[26px] p-3 shadow-sm border border-transparent focus-within:border-gray-200 transition-all">
        <PastedImagePreview
            imageUrl={userImage}
            onRemove={() => setUserImage(null)}
        />
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
                <button className="p-2 text-gray-500 hover:bg-gray-200 rounded-full transition-colors">
                    <AiOutlinePlus className="w-5 h-5" />
                </button>
                
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
                    disabled={!String(userText).trim() && !isGenerating}
                    className={`p-2 rounded-full transition-all duration-200 ${
                        !String(userText).trim() && !isGenerating 
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