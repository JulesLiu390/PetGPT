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
      const commands = reply.excution;

      const escapeShellCommand = (cmd) => {
        if (typeof cmd !== 'string') {
          throw new Error('Command must be a string');
        }
      
        let cleanedCmd = cmd
          .replace(/^```(bash|shell)\n/, '')
          .replace(/\n```$/, '');
      
        // 按行分割命令
        const lines = cleanedCmd.split('\n');
        let inHeredoc = false;
        let heredocStartLine = -1;
        let heredocEndLine = -1;
      
        // 找到 <<EOF 和对应的 EOF
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('<<EOF')) {
            heredocStartLine = i;
            inHeredoc = true;
          } else if (inHeredoc && lines[i].trim() === 'EOF') {
            heredocEndLine = i;
            inHeredoc = false;
            break;
          }
        }
      
        if (heredocStartLine === -1 || heredocEndLine === -1) {
          // 如果没有 heredoc，直接转义整个命令
          return cleanedCmd
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/'/g, '\\\'')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$');
        }
      
        // 分割命令为三部分：heredoc 前、heredoc 内容、heredoc 后
        const beforeHeredocLines = lines.slice(0, heredocStartLine + 1); // 包括 <<EOF 行
        const heredocContentLines = lines.slice(heredocStartLine + 1, heredocEndLine); // heredoc 内容（不包括 EOF 行）
        const afterHeredocLines = lines.slice(heredocEndLine + 1); // heredoc 后的内容（不包括 EOF 行）
      
        // 转义 heredoc 前后的部分
        const escapePart = (part) =>
          part
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/'/g, '\\\'')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$');
      
        // 重新构造命令
        const beforeHeredoc = beforeHeredocLines.join('\n');
        const heredocContent = heredocContentLines.join('\n');
        const afterHeredoc = afterHeredocLines.join('\n');
      
        // 拼接命令，确保 heredoc 内容不被转义，heredoc 前后部分被转义
        let result = escapePart(beforeHeredoc);
        if (heredocContent) {
          result += '\n' + heredocContent;
        }
        result += '\nEOF'; // 强行加入 EOF 标记
        if (afterHeredoc) {
          result += '\n' + escapePart(afterHeredoc);
        }
      
        return result;
      };      

      const doScriptCmd = [
        'tell application "Terminal"',
        'if (count of windows) = 0 then',
        `    do script "${escapeShellCommand(commands)}"`,
        'else',
        `    do script "${escapeShellCommand(commands)}" in front window`,
        'end if',
        'end tell'
      ].join('\n');
      
      const osascriptCmd = `osascript -e '${doScriptCmd}'`;      
      
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