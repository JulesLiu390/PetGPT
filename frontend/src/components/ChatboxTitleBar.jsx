import React from 'react'
import { MdCancel } from "react-icons/md";
import { LuMaximize2 } from "react-icons/lu";
import { BsPencilSquare } from "react-icons/bs";


export const ChatboxTitleBar = () => {

  const handleClose = () => {
    window.electron?.hideChatWindow();
  };
  const handleMax = () => {
    window.electron?.maxmizeChatWindow();
  };
  const handleNew = () => {
    window.electron?.createNewChat();
  };


  return (
    <div
    className='draggable w-full h-8 gap-3 flex justify-start p-3'
    >
      <MdCancel className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer'
      onClick={handleClose}
      ></MdCancel>
      <LuMaximize2 className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer' 
      onClick={handleMax}
      ></LuMaximize2>
      <BsPencilSquare className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer' 
      onClick={handleNew}
      ></BsPencilSquare>
    </div>
  )
}

export default ChatboxTitleBar;