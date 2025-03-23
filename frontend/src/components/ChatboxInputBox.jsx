import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { FaCircleArrowUp } from "react-icons/fa6";
import { callOpenAI } from '../utlis/openai';
import { getPet, createConversation } from '../utlis/api';  // 确保路径正确

export const ChatboxInputBox = () => {
  const inputRef = useRef(null);
  // 保留全局状态 userText、userMessages、characterMood
  const [{ userText, userMessages, characterMood }, dispatch] = useStateValue();
  // 本地状态：角色 ID 与 petInfo
  const [characterId, setCharacterId] = useState(null);
  const [petInfo, setPetInfo] = useState(null);
  // 使用 useRef 存储对话 ID，不会引起组件重渲染
  const conversationIdRef = useRef(null);

  let send_messages = [];

  // 监听来自 Electron 的角色 ID 信息，并更新本地 characterId
  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("Received character ID from Electron:", id);
      setCharacterId(id);
    };

    if (window.electron?.onCharacterId) {
      window.electron.onCharacterId(handleCharacterId);
    }

    return () => {
      // 如果有提供移除接口，则调用：
      // window.electron.removeCharacterId(handleCharacterId);
    };
  }, []);

  // 当 characterId 更新后，异步获取 pet 信息，并将所需字段存入 petInfo 状态
  useEffect(() => {
    if (characterId) {
      const fetchPetInfo = async () => {
        try {
          const pet = await getPet(characterId);
          if (pet) {
            // 提取 pet 的 name 以及其它需要的字段
            const { _id, name, modelName, personality, modelApiKey, modelProvider } = pet;
            const info = {_id, name, modelName, personality, modelApiKey, modelProvider };
            setPetInfo(info);
            console.log("Fetched pet info:", info);
          }
        } catch (error) {
          console.error("Error fetching pet info:", error);
        }
      };
      fetchPetInfo();
    }
  }, [characterId]);

  const handleChange = (e) => {
    dispatch({
      type: actionType.SET_USER_TEXT,
      userText: e.target.value,
    });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    if (!userText.trim()) return;
    window.electron?.sendMoodUpdate('thinking');

    if (inputRef.current) inputRef.current.value = "";

    // 构造对话消息时，将 petInfo.name 替换进去
    const petName = petInfo?.name || "your pet";
    const userMessage = { 
      role: "user", 
      content: `Your name is ${petName}, and your personality is ${petInfo?.personality || ""}. Talk with me as your role. Here is my text: ${userText}` 
    };
    const originalUserMessage = { role: "user", content: userText };



    const newMessages = [...userMessages, userMessage];

    const replyText = await callOpenAI(newMessages, import.meta.env.VITE_OPENAI_API, "gpt-3.5-turbo");
    const botReply = { role: "assistant", content: replyText };

    dispatch({ type: actionType.ADD_MESSAGE, message: originalUserMessage });
    dispatch({ type: actionType.ADD_MESSAGE, message: botReply });
    send_messages.push(originalUserMessage);
    send_messages.push(botReply);

        // 如果对话 ID 为空，则新建会话（会话名称取 userText，petId 使用 characterId，历史消息取 userMessages）
        if (!conversationIdRef.current) {
          try {
            alert("Creating conversation with: " + petInfo._id + ", " + userText + ", " + JSON.stringify(send_messages, null, 2));
            const newConversation = await createConversation(petInfo._id, userText, send_messages);
            conversationIdRef.current = newConversation._id;
            alert("Created new conversation: " + conversationIdRef.current);
          } catch (error) {
            alert("Error creating conversation: " + error.message);
          }
        }
    console.log(replyText);
    dispatch({ type: actionType.SET_USER_TEXT, userText: "" });
    window.electron?.sendMoodUpdate('normal');
  };

  return (
    <div className="relative w-full">
      <textarea
        ref={inputRef}
        onKeyDown={handleKeyDown}
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