import React from 'react'

import ChatboxInputBox from './ChatboxInputBox'

export const ChatboxInputArea = ({
  activePetId,
  sidebarOpen,
  autoFocus,
  activeTabId,
  quickReplyEnabled,
  quickReplyRequest,
  onQuickReplyHandled,
}) => {
  return (
    <div className='w-full'>
        <ChatboxInputBox
          activePetId={activePetId}
          sidebarOpen={sidebarOpen}
          autoFocus={autoFocus}
          activeTabId={activeTabId}
          quickReplyEnabled={quickReplyEnabled}
          quickReplyRequest={quickReplyRequest}
          onQuickReplyHandled={onQuickReplyHandled}
        />
    </div>
  )
}

export default ChatboxInputArea;
