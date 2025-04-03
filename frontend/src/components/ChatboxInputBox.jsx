import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { FaCircleArrowUp, FaGlobe } from "react-icons/fa6";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { callOpenAILib, callCommand, longTimeMemory, processMemory } from '../utlis/openai';

export const ChatboxInputBox = () => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [agentActive, setAgentActive] = useState(false); // Agent 开关

  const toggleAgent = () => {
    setAgentActive(prev => !prev);
    console.log(!agentActive ? "Agent 已启动" : "Agent 已关闭");
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
              modelProvider, // 直接使用从pet获取的值
              modelApiKey,
              modelName,
              modelUrl
            );
            setUserMemory(getUserMemory);
            // alert(getUserMemory);
          } catch (memoryError) {
            console.error("加载用户记忆失败:", memoryError);
          }
        } else {
          // 如果找不到对应的宠物数据，将characterId设为null
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
        // 出错时将characterId设为null
        setCharacterId(null);
        // alert("Failed to load character info");
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
      inputRef.current.style.height = 'auto'; // 重置为初始高度
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
        const index = await longTimeMemory(userText, 
          petInfo.modelProvider,
          petInfo.modelApiKey,
          petInfo.modelName,
          petInfo.modelUrl
        )
        if(index.isImportant == true) {
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
          // alert(getUserMemory);
        }

        let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.personality}\n 
        关于用户的信息设定如下:\n${userMemory}\n`;
        if (petInfo.isAgent) {
          systemContent += "请在回答中保持角色特点和用户设定，生成回复内容。";
        } else {
          systemContent += "请在回答中保持角色特点和用户设定，同时生成回复内容和情绪(mood: angry, smile, normal)";
        }
        const systemPrompt = { role: "system", content: systemContent };
        fullMessages = [...userMessages, systemPrompt, { role: "user", content: userText }];
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
      )
      const commands = reply.excution || '';  // 你的多行命令

      // 转义要传给 Terminal 的 Shell 命令（在 do script "..." 里）:
      function escapeShellCommand(cmd) {
        // 移除多余的 Markdown 代码块标记
        let cleaned = cmd
          .replace(/^```(?:bash|shell)\n/, '')
          .replace(/\n```$/, '');

        // 仅转义反斜杠、双引号和反引号，不对美元符号进行转义
        cleaned = cleaned
          .replace(/\\/g, '\\\\')    // 反斜杠 -> 双反斜杠
          .replace(/"/g, '\\"')       // 双引号 -> \"
          .replace(/`/g, '\\`');      // 反引号 -> \\\`
        
        return cleaned;
      }

      // 转义 AppleScript 的外层字符串
      function escapeForAppleScript(str) {
        return str.replace(/'/g, "'\\''");
        // /'/g, "'\\''"
      }

      // 生成 AppleScript 命令
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
      {/* 主容器：包含输入框和 Agent 切换按钮 */}
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
        {/* 保留第一版的 Agent UI */}
        <div className="flex justify-between">
          <button
            onClick={toggleAgent}
            className="border-none flex items-center space-x-1 px-3 py-1 rounded-md border border-gray-300"
          >
            <FaGlobe className={`w-5 h-5 ${agentActive ? 'text-green-500' : 'text-gray-600'}`} />
            <span className="text-sm">{agentActive ? "Agent On" : "Agent Off"}</span>
          </button>
        </div>
      </div>

      {/* 发送按钮：采用后续给出的 UI，绝对定位于右下角 */}
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