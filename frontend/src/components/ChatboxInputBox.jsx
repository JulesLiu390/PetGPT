import React, { useRef, useState, useEffect } from 'react';
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { FaCircleArrowUp } from "react-icons/fa6";
import { callOpenAI } from '../utlis/openai';
// import { getPet, createConversation, updateConversation, getPetConversations } from '../utlis/api';  // 确保路径正确

export const ChatboxInputBox = () => {
  const inputRef = useRef(null);
  // 保留全局状态 userText、userMessages、characterMood
  const [{ userText, userMessages, characterMood }, dispatch] = useStateValue();
  // 本地状态：角色 ID 与 petInfo
  const [characterId, setCharacterId] = useState(null);
  const [petInfo, setPetInfo] = useState(null);
  // 使用 useRef 存储对话 ID，不会引起组件重渲染
  const conversationIdRef = useRef(null);

  let send_messages = userMessages;

  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("📩 Received character ID:", id);
      setCharacterId(id);
      // alert(id);
    };
    window.electron?.onCharacterId(handleCharacterId);
  }, []);

  // 监听来自 Electron 的角色 ID 信息，并更新本地 characterId
// ✅ 当 characterId 更新后，异步获取 pet 信息，并将所需字段存入 petInfo 状态
useEffect(() => {
  if (!characterId) return;

  const fetchPetInfo = async () => {
    try {
      const pet = await window.electron.getPet(characterId); // ✅ 替换为 Electron IPC 调用
      if (pet) {
        const { _id, name, modelName, personality, modelApiKey, modelProvider } = pet;
        const info = { _id, name, modelName, personality, modelApiKey, modelProvider };
        setPetInfo(info);
        // alert(JSON.stringify(info, null, 2));
        console.log("Fetched pet info:", info);
      }
      
    } catch (error) {
      alert("fails")
      console.error("Error fetching pet info:", error);
    }
  };

  fetchPetInfo();
}, [characterId]);

    const fetchConversationById = async (conversationId) => {
      try {
        return await getConversation(conversationId);
      } catch (error) {
        console.error("Error fetching conversation:", error);
        throw error;
      }
    };
  
    const handleItemClick = async (conv) => {
      
      console.log("Loaded conversation:", conversation);
      window.electron?.sendCharacterId(conversation.petId);
      window.electron?.sendConversationId(conv._id);
      dispatch({
        type: actionType.SET_USER_TEXT,
        userMessages: conversation.history
      });
    };

  useEffect(() => {
    const handleConversationId = (id) => {
      console.log("Received conversation ID from Electron:", id);
      conversationIdRef.current = id;
    };

    if (window.electron?.onConversationId) {
      window.electron.onConversationId(handleConversationId);
    }

    return () => {
      // 如果有提供移除接口，则调用：
      // window.electron.removeCharacterId(handleCharacterId);
    };
  }, []);

  // 当 characterId 更新后，异步获取 pet 信息，并将所需字段存入 petInfo 状态
  // useEffect(() => {
  //   if (characterId) {
  //     const fetchPetInfo = async () => {
  //       try {
  //         const pet = await getPet(characterId);
  //         // alert(characterId)
  //         if (pet) {
  //           // 提取 pet 的 name 以及其它需要的字段
  //           const { _id, name, modelName, personality, modelApiKey, modelProvider } = pet;
  //           const info = {_id, name, modelName, personality, modelApiKey, modelProvider };
  //           setPetInfo(info);
  //           console.log("Fetched pet info:", info);
  //         }
  //       } catch (error) {
  //         console.error("Error fetching pet info:", error);
  //       }
  //     };
  //     fetchPetInfo();
  //   }
  // }, [characterId]);

  const handleChange = (e) => {
    dispatch({
      type: actionType.SET_USER_TEXT,
      userText: e.target.value,
    });
  };

    useEffect(() => {
      send_messages = userMessages;
    }, [userMessages]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    if(characterId == null) {
      alert("Please Select Character First!")
      return;
    }
    if (!userText.trim()) return;
    window.electron?.sendMoodUpdate('thinking');
    // alert(petInfo.id)

    if (inputRef.current) inputRef.current.value = "";

    // 构造对话消息时，将 petInfo.name 替换进去
    const petName = petInfo?.name || "your pet";
    const asistantSettings = {
        role: "system", 
        content: `你现在扮演的角色设定如下：\n${petInfo?.personality}\n请在回答中保持角色特点， 同时生成回复内容和情绪(mood: angry, smile, normal)。当你认为你用户的内容冒犯到你的时候，哪怕很轻微， 请愤怒！ 除非提问带有明显的正面评价， 不然不要smile而是保持normal`
    }

    const userMessage = { 
      role: "user", 
      content: `${userText}` 
    };

    const originalUserMessage = { role: "user", content: userText };

    const newMessages = [...userMessages, asistantSettings, userMessage];

    const replyText = await callOpenAI(newMessages, petInfo.modelApiKey, petInfo.modelName);
    const botReply = { role: "assistant", content: replyText.content };

    dispatch({ type: actionType.ADD_MESSAGE, message: originalUserMessage });
    dispatch({ type: actionType.ADD_MESSAGE, message: botReply });
    // send_messages.push(originalUserMessage);
    // send_messages.push(botReply);

        // 如果对话 ID 为空，则新建会话（会话名称取 userText，petId 使用 characterId，历史消息取 userMessages）
        if (!conversationIdRef.current) {
          try {
            // const newConversation = await createConversation(petInfo._id, userText + " with " + petInfo.name, send_messages);
            const newConversation = await window.electron.createConversation({
              petId: petInfo._id,
              title: `${userText} with ${petInfo.name}`,
              history: send_messages
            });
            
            conversationIdRef.current = newConversation._id;
          } catch (error) {
            // alert("Error creating conversation: " + error.message);
          }
        }
        await window.electron.updateConversation(conversationIdRef.current, {
          petId: petInfo._id,
          title: `${userText} with ${petInfo.name}`,
          history: send_messages
        });
    dispatch({ type: actionType.SET_USER_TEXT, userText: "" });
    window.electron?.sendMoodUpdate(replyText.mood);
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