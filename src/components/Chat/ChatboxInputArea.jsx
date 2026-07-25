import React from 'react'

import ChatboxInputBox from './ChatboxInputBox'

export const ChatboxInputArea = ({
  activePetId,
  sidebarOpen,
  autoFocus,
  focusRequest,
  compact,
  activeTabId,
  quickReplyEnabled,
  quickReplyRequest,
  onQuickReplyHandled,
  onHeightChange,
  onOverlayOpenChange,
}) => {
  return (
    <div className='w-full'>
        <ChatboxInputBox
          activePetId={activePetId}
          sidebarOpen={sidebarOpen}
          autoFocus={autoFocus}
          focusRequest={focusRequest}
          compact={compact}
          activeTabId={activeTabId}
          quickReplyEnabled={quickReplyEnabled}
          quickReplyRequest={quickReplyRequest}
          onQuickReplyHandled={onQuickReplyHandled}
          onHeightChange={onHeightChange}
          onOverlayOpenChange={onOverlayOpenChange}
        />
    </div>
  )
}

export default ChatboxInputArea;
