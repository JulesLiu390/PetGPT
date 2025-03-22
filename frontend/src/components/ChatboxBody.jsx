import React from 'react'
import ChatboxTitleBar from './ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';
import ChatboxMessageArea from './ChatboxMessageArea';

export const Chatbox = () => {
  return (
    <div
    className='h-full flex flex-col justify-between'
    >
      <ChatboxTitleBar></ChatboxTitleBar>
      <ChatboxMessageArea/>
      <ChatboxInputArea></ChatboxInputArea>
    </div>
  )
}

export default Chatbox;