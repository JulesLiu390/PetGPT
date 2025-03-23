import React from 'react'
import { MdCancel } from "react-icons/md";
import { LuMaximize2 } from "react-icons/lu";

export const ChatboxTitleBar = () => {

  const handleClose = () => {
    window.electron?.hideChatWindow();
  };
  const handleMax = () => {
    window.electron?.maxmizeChatWindow();
  };

  return (
    <div
    className='draggable w-full h-16 gap-3 flex justify-start p-3'
    >
      <MdCancel className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer'
      onClick={handleClose}
      ></MdCancel>
      <LuMaximize2 className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer' 
      onClick={handleMax}
      ></LuMaximize2>
    </div>
  )
}

export default ChatboxTitleBar;