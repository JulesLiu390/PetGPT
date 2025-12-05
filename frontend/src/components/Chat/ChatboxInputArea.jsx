import React, { useState } from 'react'

import ChatboxInputBox from './ChatboxInputBox'

export const ChatboxInputArea = ({ activePetId }) => {
  return (
    <div className='w-full'>
        <ChatboxInputBox activePetId={activePetId}></ChatboxInputBox>
    </div>
  )
}

export default ChatboxInputArea;