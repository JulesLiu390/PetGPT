import React, { useRef } from 'react'
import { useStateValue } from '../content/StateProvider';
import { actionType } from '../content/reducer';
import { FaCircleArrowUp } from "react-icons/fa6";
import { callOpenAI } from '../utlis/openai';


export const ChatboxInputBox = () => {
    const inputRef = useRef(null);
    const [{ userText, userMessages, characterMood }, dispatch] = useStateValue();


    const handleChange = (e) => {

        const value = e.target.value;

        dispatch({
          type: actionType.SET_USER_TEXT,
          userText: value,
        });
      
    };

    const handleKeyDown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();      
          handleSend();            
        }
      };

    const handleSend = async () => {
      window.electron?.sendMoodUpdate('thinking');

      if(inputRef.current) {
            inputRef.current.value = "";
          }



        const userMessage = {
            role: "user",
            content: userText,
          };
        const newMessages = [...userMessages, userMessage];

        const replyText = await callOpenAI(newMessages);
        const botReply = {
            role: "assistant",
            content: replyText,
          };

        dispatch({ type: actionType.ADD_MESSAGE, message: userMessage });
        dispatch({ type: actionType.ADD_MESSAGE, message: botReply });
        console.log(replyText);
        dispatch({
            type: actionType.SET_USER_TEXT,
            userText: "", // ✅ 清空输入框内容
          });
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
            <FaCircleArrowUp className="w-9 h-9" 
            style={{
                color: !String(userText).trim() ? "#c1c1c1" : "#000000",
            }}
            />
        </button>
      </div>
    )
}

export default ChatboxInputBox;