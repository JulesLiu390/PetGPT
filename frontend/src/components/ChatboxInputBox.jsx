import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { FaCircleArrowUp, FaGlobe } from "react-icons/fa6";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { callOpenAILib, callCommand } from '../utlis/openai';

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
        alert("Failed to load character info");
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

    // const commands = "";
    // // 使用 JSON.stringify 将 pythonCmd 自动用双引号包裹
    // const doScriptCmd = `tell application "Terminal" to do script ${JSON.stringify(commands)}`;
    // // 同样，使用 JSON.stringify 包裹整个 AppleScript 命令，构造最终命令
    // const osascriptCmd = `osascript -e ${JSON.stringify(doScriptCmd)}`;
    //     window.electron?.testOpen(osascriptCmd);



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
        let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.personality}\n`;
        if (petInfo.isAgent) {
          systemContent += "请在回答中保持角色特点，生成回复内容。";
        } else {
          systemContent += "请在回答中保持角色特点，同时生成回复内容和情绪(mood: angry, smile, normal)";
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
    .replace(/^```(bash|shell)\n/, '')
    .replace(/\n```$/, '');

  // 将反斜杠、双引号、单引号、反引号和美元符号转义，
  // 以便安全地放进 "..." 中
  cleaned = cleaned
    .replace(/\\/g, '\\\\')    // 反斜杠 -> 双反斜杠
    .replace(/"/g, '\\"')       // 双引号 -> \"
    .replace(/'/g, "'\\''")      // 单引号 -> \'
    .replace(/`/g, '\\`')       // 反引号 -> \\\`
    .replace(/\$/g, '\\$');     // 美元符号 -> \$

  return cleaned;
}

// 转义 AppleScript 的外层字符串（在 osascript -e '...' 里）:
function escapeForAppleScript(str) {
  // AppleScript 整体是用单引号括起来的，所以要转义内部的单引号
  return str.replace(/'/g, "\\'");
}


// 1) 先转义传给 Terminal 的命令
const shellCmdEscaped = escapeShellCommand(commands);

// 2) 写出完整的 AppleScript，注意内部使用双引号包裹 Shell 命令
const appleScriptCode = `
tell application "Terminal"
  if (count of windows) = 0 then
    do script "${shellCmdEscaped}"
  else
    do script "${shellCmdEscaped}" in front window
  end if
end tell
`;

// 3) 再对 AppleScript 自身做转义（防止内部单引号破坏外层引号）
const appleScriptEscaped = escapeForAppleScript(appleScriptCode);

// 4) 拼出最终要传给 Electron 执行的命令
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