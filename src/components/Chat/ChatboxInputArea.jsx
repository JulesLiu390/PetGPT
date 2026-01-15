import React, { useState } from 'react'

import ChatboxInputBox from './ChatboxInputBox'

export const ChatboxInputArea = ({ activePetId, sidebarOpen }) => {
  return (
    <div className='w-full'>
        <ChatboxInputBox activePetId={activePetId} sidebarOpen={sidebarOpen}></ChatboxInputBox>
    </div>
  )
}

export default ChatboxInputArea;