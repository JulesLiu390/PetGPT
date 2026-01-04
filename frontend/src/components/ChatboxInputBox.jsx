import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../context/StateProvider';
import bridge from '../utils/bridge';
import { actionType } from '../context/reducer';
import { FaCircleArrowUp, FaGlobe, FaShareNodes, FaFile } from "react-icons/fa6";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { promptSuggestion, callOpenAILib, callCommand, longTimeMemory, processMemory } from '../utils/openai';
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





export const ChatboxInputBox = () => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [agentActive, setAgentActive] = useState(false); // Agent 开关
  // 新增记忆功能开关状态
  const [memoryEnabled, setMemoryEnabled] = useState(true);

  const [userImage, setUserImage] = useState(null);
  const [stateReply, setStateReply] = useState(null);
  const [stateThisModel, setStateThisModel] = useState(null);
  const [stateUserText, setStateUserText] = useState(null);
  let reply = null;
  let thisModel = null;
  let _userText = null;

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
  const [userMemory, setUserMemory] = useState(null);
  const [founctionModel, setFounctionModel] = useState(null);
  const [system, setSystem] = useState(null);
  const [firstCharacter, setFirstCharacter] = useState(null)

  // 启动时加载默认角色ID
  useEffect(() => {
    setSystem(window.navigator.platform);
    const loadDefaultCharacter = async () => {
      const settings = await bridge.getSettings();
      try {
        if (settings && settings.defaultRoleId) {
          
          // console.log("📚 Loading default character ID from settings:", settings.defaultRoleId);
          
          // 验证ID是否有效（是否能找到对应的pet数据）
          try {
            const pet = await bridge.getPet(settings.defaultRoleId);
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
        const settings = await bridge.getSettings();
        if (settings && settings.defaultModelId) {
          // console.log("📚 Loading default character ID from settings:", settings.defaultModelId);
          
          // 验证ID是否有效（是否能找到对应的pet数据）
          try {
            const pet = await bridge.getPet(settings.defaultModelId);
            if (pet) {
              setFounctionModel(settings.defaultModelId);
              console.log("Default character ID validated successfully");
              const { _id, name, modelName, modelApiKey, modelProvider, modelUrl } = pet;
              const systemInstruction = pet.systemInstruction || pet.personality || '';
              setFunctionModelInfo({ _id, name, modelName, systemInstruction, modelApiKey, modelProvider, modelUrl });
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
      bridge.sendCharacterId?.(firstCharacter);
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
    bridge.onCharacterId?.(handleCharacterId);
  }, []);

  useEffect(() => {
    const updateSuggestion = async() => {
      // alert(thisModel)
      thisModel = stateThisModel;
      _userText = stateUserText;
      let suggestion = await promptSuggestion(
        {user:_userText, assistant:stateReply.content},
        thisModel.modelProvider,
        thisModel.modelApiKey,
        thisModel.modelName,
        thisModel.modelUrl
      )
      suggestion = suggestion.split("|")
      dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: suggestion });
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
        const pet = await bridge.getPet(characterId);
        if (pet) {
          const { _id, name, modelName, modelApiKey, modelProvider, modelUrl, hasMood, isAgent } = pet;
          const systemInstruction = pet.systemInstruction || pet.personality || '';
          // hasMood 向后兼容：如果没设置 hasMood，则根据 !isAgent 判断
          const computedHasMood = typeof hasMood === 'boolean' ? hasMood : !isAgent;
          setPetInfo({ _id, name, modelName, systemInstruction, modelApiKey, modelProvider, modelUrl, hasMood: computedHasMood });
          thisModel = null;
          if(functionModelInfo == null) {
            thisModel = pet;
          } else {
            thisModel = functionModelInfo;
          }

          try {
            const memoryJson = await bridge.getPetUserMemory(characterId);
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

        if (conversationIdRef.current) {
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
    if (bridge.onNewChatCreated) {
      bridge.onNewChatCreated(handleNewChat);
    }

    // 卸载时清理监听器，避免内存泄漏
    return () => {
      // cleanup handled by bridge
    };
  }, []);

  // 接收会话 ID
  useEffect(() => {
    const fetch = async (conversationId) => {
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
      await fetch(id);
      console.log("📥 Received conversation ID from Electron:", id);


      conversationIdRef.current = id;
    };

    if (bridge.onConversationId) {
      bridge.onConversationId(handleConversationId);
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
    bridge.onMoodUpdated?.(moodUpdateHandler);

    // 如果需要在组件卸载时移除监听，可在此处调用 removeListener
    return () => {
      // bridge.removeMoodUpdated?.(moodUpdateHandler);
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

    

    _userText = userText;
    
    setUserText("");
    dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [] });


    bridge.sendMoodUpdate?.('thinking');

    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = 'auto';
    }

    let fullMessages = [];
    const isDefaultPersonality = petInfo?.systemInstruction &&
      (petInfo.systemInstruction.trim().toLowerCase() === "default model (english)" ||
       petInfo.systemInstruction.trim().toLowerCase() === "default");
    thisModel = petInfo;

    if (agentActive) {
      // Agent 模式不改变原有逻辑
      fullMessages = [...userMessages, { role: "user", content: _userText }];
      dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText } });
    } else {

      thisModel = functionModelInfo == null ? petInfo : functionModelInfo;
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
            await bridge.updatePetUserMemory(petInfo._id, index.key, index.value);
            bridge.updateChatbodyStatus(index.key + ":" + index.value);
            const memoryJson = await bridge.getPetUserMemory(petInfo._id);
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
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.systemInstruction}\n关于用户的信息设定如下:\n${userMemory}\n`;
          systemContent += "请在回答中保持角色特点和用户设定，生成回复内容。";
          const systemPrompt = { role: "system", content: systemContent };
          dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          let content = _userText;
          if(userImage != null) {
            content = [{ type: "text", text: _userText },
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
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.systemInstruction}\n`;
          systemContent += "请在回答中保持角色特点，生成回复内容。";
          const systemPrompt = { role: "system", content: systemContent };
          dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          let content = _userText;
          if(userImage != null) {
            content = [{ type: "text", text: _userText },
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
            await bridge.updatePetUserMemory(petInfo._id, index.key, index.value);
            bridge.updateChatbodyStatus(index.key + ":" + index.value);
            const memoryJson = await bridge.getPetUserMemory(petInfo._id);
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
          dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          let content = _userText;
          if(userImage != null) {
            content = [{ type: "text", text: _userText },
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
          dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: _userText} });
          let content = _userText;
          if(userImage != null) {
            content = [{ type: "text", text: _userText },
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

      bridge.testOpen(osascriptCmd);

    } else {
      reply = await callOpenAILib(
        fullMessages,
        petInfo.modelProvider,
        petInfo.modelApiKey,
        petInfo.modelName,
        petInfo.modelUrl,
        { hasMood: petInfo.hasMood !== false } // 传递 hasMood 选项
      );
    }

    const botReply = { role: "assistant", content: reply.content };

    // 只在 AI 回复后插入机器人消息
    dispatch({ type: actionType.ADD_MESSAGE, message: botReply });

    if (!conversationIdRef.current) {
      try {
        const newConversation = await bridge.createConversation({
          petId: petInfo._id,
          title: `${_userText} with ${petInfo.name}`,
          history: [...userMessages, { role: "user", content: _userText }, botReply],
        });
        conversationIdRef.current = newConversation._id;
      } catch (error) {
        alert("Failed to create conversation:", error);
      }
    }

    await bridge.updateConversation(conversationIdRef.current, {
      petId: petInfo._id,
      title: `${_userText} with ${petInfo.name}`,
      history: [...userMessages, { role: "user", content: _userText }, botReply],
    });

    bridge.sendMoodUpdate(reply.mood);
    setIsGenerating(false);

    bridge.updateChatbodyStatus("");

    setStateReply(reply);
    setStateThisModel(thisModel);
    setStateUserText(_userText);
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


  return (
    <div className="relative w-full">
      {/* 主容器：包含输入框和 Agent、Memory 及 Share Conversation 按钮 */}
      <div className="bg-[rgba(220,220,230,0.9)] border-gray-300 rounded-3xl border-2 p-3 text-gray-800">
      <PastedImagePreview
        imageUrl={userImage}
        onRemove={() => setUserImage(null)}
      />
        <textarea
          ref={inputRef}
          value={userText}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}   // 添加 onPaste 事件监听
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={autoResize}
          placeholder="Message PetGPT"
          className="w-full bg-transparent outline-none resize-none"
          onChange={handleChange}
          style={{ height: 'auto', maxHeight: '200px', overflow: 'auto' }}
        />
        {/* 按钮区域：将 Agent、Memory、Share Conversation 及 Search 按钮放在一起 */}
        <div className="flex justify-between">
          
          <div className="flex items-center space-x-2">
            <button
              onClick={toggleAgent}
              className="border-none flex items-center space-x-1 px-1 py-1 hover:bg-gray-400 rounded-md border border-gray-300"
            >
              <FaGlobe className={`w-5 h-5 ${agentActive ? 'text-green-500' : 'text-gray-600'}`} />
              <span className="text-sm hidden [@media(min-width:420px)]:inline">
                {agentActive ? "Agent" : "Agent"}
              </span>
            </button>
            <button
              onClick={toggleMemory}
              className="border-none flex items-center space-x-1  py-1 hover:bg-gray-400 rounded-md border border-gray-300"
            >
              <FaFile className={`w-5 h-5 ${memoryEnabled ? 'text-green-500' : 'text-gray-600'}`} />
              <span className="text-sm hidden [@media(min-width:420px)]:inline">
                {memoryEnabled ? "Memory" : "Memory"}
              </span>
            </button>
            <button
              onClick={handleShare}
              className="border-none flex items-center space-x-1  py-1 hover:bg-gray-400 rounded-md border border-gray-300"
            >
              <FaShareNodes className="w-5 h-5 text-gray-600" />
              <span className="text-sm hidden [@media(min-width:420px)]:inline">Share</span>
            </button>
          </div>
        </div>
      </div>
      <button
            onClick={() => {}}
            className="absolute bottom-2 right-13 rounded-full"
            onMouseEnter={() => setShowReplyOptions(true)}
            onMouseLeave={() => setShowReplyOptions(false)}
          >
          <SiQuicktype
            className="w-9 h-9"
            style={{ color:(suggestText.length == 0) ? "#c1c1c1" : "#000000" }}
          />
      </button>
      {showReplyOptions && suggestText.length !== 0 && (
        <div 
          className="absolute bottom-11 right-9 bg-white border border-gray-200 rounded-lg shadow-lg p-2"
          onMouseEnter={() => setShowReplyOptions(true)}
          onMouseLeave={() => setShowReplyOptions(false)}
        >
        <div className="font-bold mb-1 text-xs">Quick reply</div>
        <ul>
          {suggestText.map((item, index) => (
            <li key={index} className="cursor-pointer hover:bg-gray-100 p-1 text-xs"
            onClick={() => setUserText(userText + suggestText[index])}>
              {item}
            </li>
          ))}
        </ul>
        </div>
      )}

      {/* 发送按钮：绝对定位于右下角 */}
      <button
        onClick={handleSend}
        disabled={!String(userText).trim() || isGenerating}
        className="absolute bottom-2 right-2 rounded-full"
      >
        {!isGenerating ? (
          <FaCircleArrowUp
            className="w-9 h-9"
            style={{ color: !String(userText).trim() ? "#c1c1c1" : "#000000" }}
          />
        ) : (
          <BsFillRecordCircleFill
            className="w-9 h-9"
            style={{ color: "#000000" }}
          />
        )}
      </button>
    </div>
  );
};

export default ChatboxInputBox;