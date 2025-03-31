import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { FaCircleArrowUp } from "react-icons/fa6";
import { callOpenAILib } from '../utlis/openai';

export const ChatboxInputBox = () => {
  const inputRef = useRef(null);
  const [{ userText, userMessages }, dispatch] = useStateValue();

  const [characterId, setCharacterId] = useState(null);
  const [petInfo, setPetInfo] = useState(null);
  // 用 ref 存储是否正在拼写或刚结束拼写
  const composingRef = useRef(false);
  // 标记拼写刚结束，短暂忽略 Enter
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

    return () => {
      // 如有需要，解绑监听
    };
  }, []);

  const handleChange = (e) => {
    dispatch({
      type: actionType.SET_USER_TEXT,
      userText: e.target.value,
    });
  };

  // 在输入框上添加 composition 事件监听
  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
    // 拼写结束后，暂时忽略 Enter 事件（例如 150 毫秒内）
    ignoreEnterRef.current = true;
    setTimeout(() => {
      ignoreEnterRef.current = false;
    }, 150);
  };

  const handleKeyDown = (e) => {
    // 如果正在拼写，则忽略回车
    if (composingRef.current) return;
    // 如果刚刚结束拼写，忽略当前 Enter 事件
    if (ignoreEnterRef.current) return;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    if (!characterId) {
      alert("Please select a character first!");
      return;
    }
    if (!userText.trim()) return;
  
    window.electron?.sendMoodUpdate('thinking');
  
    if (inputRef.current) inputRef.current.value = "";
  
    // 判断是否为默认人格
    const isDefaultPersonality = petInfo?.personality && 
      (petInfo.personality.trim().toLowerCase() === "default model (english)" ||
       petInfo.personality.trim().toLowerCase() === "default");
  
    let fullMessages = [];
    if (!isDefaultPersonality) {
      let systemContent = `你现在扮演的角色设定如下：\n${petInfo?.personality}\n`;
      if (petInfo.isAgent) {
        systemContent += "请在回答中保持角色特点，生成回复内容。";
      } else {
        systemContent += "请在回答中保持角色特点，同时生成回复内容和情绪(mood: angry, smile, normal)";
        // systemContent += "请在回答中保持角色特点，生成回复内容。";
      }
      const systemPrompt = { role: "system", content: systemContent };
      fullMessages = [...userMessages, systemPrompt, { role: "user", content: userText }];
    } else {
      fullMessages = [...userMessages, { role: "user", content: userText }];
    }
    // let reply = null;
    const reply = await callOpenAILib(
      fullMessages, 
      petInfo.modelProvider, 
      petInfo.modelApiKey, petInfo.modelName, petInfo.modelUrl);
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
  };

  return (
    <div className="relative w-full">
      <textarea
        ref={inputRef}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder="Message PetGPT"
        className="w-full bg-[rgba(220,220,230,0.9)] border-gray-300 h-24 rounded-3xl border-2 p-3 text-gray-800"
        onChange={handleChange}
      />
      <button
        onClick={handleSend}
        disabled={!String(userText).trim()}
        className="absolute bottom-4 right-4 rounded-full"
      >
        <FaCircleArrowUp
          className="w-9 h-9"
          style={{ color: !String(userText).trim() ? "#c1c1c1" : "#000000" }}
        />
      </button>
    </div>
  );
};

export default ChatboxInputBox;