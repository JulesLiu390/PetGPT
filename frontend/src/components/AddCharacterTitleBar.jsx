import React from 'react'
import { MdCancel } from "react-icons/md";

export const AddCharacterTitleBar = () => {

  const handleClose = () => {
    window.electron?.hideChatWindow();
  };


  return (
    <div
    className='draggable w-full h-16 flex justify-start p-3'
    >
      <MdCancel className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer'
      onClick={handleClose}
      ></MdCancel>
    </div>
  )
}

export default AddCharacterTitleBar;