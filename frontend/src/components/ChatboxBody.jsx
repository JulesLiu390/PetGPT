import React, { useEffect, useRef } from 'react'
import ChatboxTitleBar from './ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';

import ChatboxMessageArea from './ChatboxMessageArea';
import { useStateValue } from '../content/StateProvider';

export const Chatbox = () => {
  const [{userMessages}, dispatch] = useStateValue()


  return (
    <div
    className='h-full flex flex-col justify-between'
    >
      <ChatboxTitleBar></ChatboxTitleBar>
      
        {userMessages.length > 0 && 
            (            
                        <ChatboxMessageArea/>
                        
          )
        }
        <ChatboxInputArea></ChatboxInputArea>

    </div>
  )
}

export default Chatbox;