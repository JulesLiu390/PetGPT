import React from 'react'
import ChatboxTitleBar from './ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';

export const Chatbox = () => {
  return (
    <div
    className='h-full flex flex-col justify-between'
    >
      <ChatboxTitleBar></ChatboxTitleBar>
      <ChatboxInputArea></ChatboxInputArea>
    </div>
  )
}

export default Chatbox;