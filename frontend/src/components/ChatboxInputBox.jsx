import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { FaCircleArrowUp, FaGlobe, FaShareNodes, FaFile } from "react-icons/fa6";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { callOpenAILib, callCommand, longTimeMemory, processMemory } from '../utlis/openai';

export const ChatboxInputBox = () => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [agentActive, setAgentActive] = useState(false); // Agent 开关
  // 新增记忆功能开关状态
  const [memoryEnabled, setMemoryEnabled] = useState(true);

  const toggleAgent = () => {
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
  const [{ userText, userMessages }, dispatch] = useStateValue();
  const [characterId, setCharacterId] = useState(null);
  const [petInfo, setPetInfo] = useState(null);
  const composingRef = useRef(false);
  const ignoreEnterRef = useRef(false);
  const conversationIdRef = useRef(null);
  const [userMemory, setUserMemory] = useState(null)

  // 启动时加载默认角色ID
  useEffect(() => {
    const loadDefaultCharacter = async () => {
      try {
        const settings = await window.electron.getSettings();
        if (settings && settings.defaultRoleId) {
          console.log("📚 Loading default character ID from settings:", settings.defaultRoleId);
          
          // 验证ID是否有效（是否能找到对应的pet数据）
          try {
            const pet = await window.electron.getPet(settings.defaultRoleId);
            if (pet) {
              setCharacterId(settings.defaultRoleId);
              console.log("Default character ID validated successfully");
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
    };
    
    loadDefaultCharacter();
  }, []); // 只在组件加载时执行一次

  // 监听角色 ID
  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("📩 Received character ID:", id);
      setCharacterId(id);
    };
    window.electron?.onCharacterId(handleCharacterId);
  }, []);

  // 加载角色信息，并清理或保留对话历史
  useEffect(() => {
    if (!characterId) return;

    const fetchPetInfo = async () => {
      try {
        const pet = await window.electron.getPet(characterId);
        if (pet) {
          const { _id, name, modelName, personality, modelApiKey, modelProvider, modelUrl } = pet;
          setPetInfo({ _id, name, modelName, personality, modelApiKey, modelProvider, modelUrl });
          try {
            const memoryJson = await window.electron.getPetUserMemory(characterId);
            const memory = JSON.stringify(memoryJson);
            const getUserMemory = await processMemory(
              memory,
              modelProvider,
              modelApiKey,
              modelName,
              modelUrl
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

  // 接收会话 ID
  useEffect(() => {
    const handleConversationId = (id) => {
      console.log("📥 Received conversation ID from Electron:", id);
      conversationIdRef.current = id;
    };

    if (window.electron?.onConversationId) {
      window.electron.onConversationId(handleConversationId);
    }
  }, []);

  const handleChange = (e) => {
    dispatch({
      type: actionType.SET_USER_TEXT,
      userText: e.target.value,
    });
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
    }, 150);
  };

  // 自动调整 textarea 高度（最大200px）
  const autoResize = () => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const newHeight = Math.min(inputRef.current.scrollHeight, 200);
      inputRef.current.style.height = newHeight + 'px';
    }
  };

  // 回车发送
  const handleKeyDown = (e) => {
    if (composingRef.current || ignoreEnterRef.current) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 发送消息
  const handleSend = async () => {
    if (!characterId) {
      alert("Please select a character first!");
      return;
    }
    setIsGenerating(true);
    if (!userText.trim()) return;

    window.electron?.sendMoodUpdate('thinking');

    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = 'auto';
    }

    // 判断是否为默认人格
    const isDefaultPersonality = petInfo?.personality &&
      (petInfo.personality.trim().toLowerCase() === "default model (english)" ||
       petInfo.personality.trim().toLowerCase() === "default");

    let fullMessages = [];
    if(agentActive) {
      fullMessages = [...userMessages, { role: "user", content: userText }];
    } else {
      if (!isDefaultPersonality) {
        // 当记忆功能开启时，调用更新记忆的逻辑；关闭时只构造角色设定
        if (memoryEnabled) {
          const index = await longTimeMemory(userText, 
            petInfo.modelProvider,
            petInfo.modelApiKey,
            petInfo.modelName,
            petInfo.modelUrl
          );
          if(index.isImportant === true) {
            await window.electron.updatePetUserMemory(petInfo._id, index.key, index.value);
            const memoryJson = await window.electron.getPetUserMemory(petInfo._id);
            const memory = JSON.stringify(memoryJson);
            const getUserMemory = await processMemory(
              memory,
              petInfo.modelProvider,
              petInfo.modelApiKey,
              petInfo.modelName,
              petInfo.modelUrl
            );
            await setUserMemory(getUserMemory);
          }
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.personality}\n关于用户的信息设定如下:\n${userMemory}\n`;
          if (petInfo.isAgent) {
            systemContent += "请在回答中保持角色特点和用户设定，生成回复内容。";
          } else {
            systemContent += "请在回答中保持角色特点和用户设定，同时生成回复内容和情绪(mood: angry, smile, normal)";
          }
          const systemPrompt = { role: "system", content: systemContent };
          fullMessages = [...userMessages, systemPrompt, { role: "user", content: userText }];
        } else {
          // 记忆关闭：既不调用更新记忆逻辑，也不包含用户记忆，仅保留角色设定
          let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.personality}\n`;
          if (petInfo.isAgent) {
            systemContent += "请在回答中保持角色特点，生成回复内容。";
          } else {
            systemContent += "请在回答中保持角色特点，同时生成回复内容和情绪(mood: angry, smile, normal)";
          }
          const systemPrompt = { role: "system", content: systemContent };
          fullMessages = [...userMessages, systemPrompt, { role: "user", content: userText }];
        }
      } else {
        fullMessages = [...userMessages, { role: "user", content: userText }];
      }
    }

    let reply = null;

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
      reply = await callOpenAILib(
        fullMessages,
        petInfo.modelProvider,
        petInfo.modelApiKey,
        petInfo.modelName,
        petInfo.modelUrl
      );
    }

    const botReply = { role: "assistant", content: reply.content };

    dispatch({ type: actionType.ADD_MESSAGE, message: { role: "user", content: userText } });
    dispatch({ type: actionType.ADD_MESSAGE, message: botReply });

    if (!conversationIdRef.current) {
      try {
        const newConversation = await window.electron.createConversation({
          petId: petInfo._id,
          title: `${userText} with ${petInfo.name}`,
          history: [...userMessages, { role: "user", content: userText }, botReply],
        });
        conversationIdRef.current = newConversation._id;
      } catch (error) {
        console.error("Failed to create conversation:", error);
      }
    }

    await window.electron.updateConversation(conversationIdRef.current, {
      petId: petInfo._id,
      title: `${userText} with ${petInfo.name}`,
      history: [...userMessages, { role: "user", content: userText }, botReply],
    });

    dispatch({ type: actionType.SET_USER_TEXT, userText: "" });
    window.electron?.sendMoodUpdate(reply.mood);
    setIsGenerating(false);
  };

  return (
    <div className="relative w-full">
      {/* 主容器：包含输入框和 Agent、Memory 及 Share Conversation 按钮 */}
      <div className="bg-[rgba(220,220,230,0.9)] border-gray-300 rounded-3xl border-2 p-3 text-gray-800">
        <textarea
          ref={inputRef}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={autoResize}
          placeholder="Message PetGPT"
          className="w-full bg-transparent outline-none resize-none"
          onChange={handleChange}
          style={{ height: 'auto', maxHeight: '200px', overflow: 'auto' }}
        />
        {/* 按钮区域：将 Agent、Memory 及 Share Conversation 按钮放在一起 */}
        <div className="flex justify-between">
          <div className="flex items-center space-x-2">
            <button
              onClick={toggleAgent}
              className="border-none flex items-center space-x-1 px-3 py-1 rounded-md border border-gray-300"
            >
              <FaGlobe className={`w-5 h-5 ${agentActive ? 'text-green-500' : 'text-gray-600'}`} />
              <span className="text-sm hidden [@media(min-width:300px)]:inline">
                {agentActive ? "Agent" : "Agent"}
              </span>
            </button>
            <button
              onClick={toggleMemory}
              className="border-none flex items-center space-x-1 px-3 py-1 rounded-md border border-gray-300"
            >
              <FaFile className={`w-5 h-5 ${memoryEnabled ? 'text-green-500' : 'text-gray-600'}`} />
              <span className="text-sm hidden [@media(min-width:300px)]:inline">
                {memoryEnabled ? "Memory" : "Memory"}
              </span>
            </button>
            <button
              onClick={handleShare}
              className="border-none flex items-center space-x-1 px-3 py-1 rounded-md border border-gray-300"
            >
              <FaShareNodes className="w-5 h-5 text-gray-600" />
              <span className="text-sm hidden [@media(min-width:300px)]:inline">Share</span>
            </button>
          </div>
        </div>
      </div>

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