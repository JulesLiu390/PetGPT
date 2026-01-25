import React, { useState } from 'react'

import ChatboxInputBox from './ChatboxInputBox'

export const ChatboxInputArea = ({ activePetId, sidebarOpen, autoFocus, activeTabId }) => {
  return (
    <div className='w-full'>
        <ChatboxInputBox activePetId={activePetId} sidebarOpen={sidebarOpen} autoFocus={autoFocus} activeTabId={activeTabId}></ChatboxInputBox>
    </div>
  )
}

export default ChatboxInputArea;