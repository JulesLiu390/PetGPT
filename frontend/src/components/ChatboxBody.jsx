import React, { useEffect, useRef } from 'react'
import ChatboxTitleBar from './ChatboxTitleBar';
import ChatboxInputArea from './ChatboxInputArea';

import ChatboxMessageArea from './ChatboxMessageArea';
import { useStateValue } from '../content/StateProvider';

// 示例 JSON 数据，可根据需要替换或从外部引入
const chatItems = [
  { id: 1, title: '项目评分与反馈' },
  { id: 2, title: 'Final Project Requirements Guide' },
  { id: 3, title: '无法打开应用修复' },
  { id: 4, title: 'Stakeholder Definition Explained' },
  { id: 5, title: 'Electron Syntax Error Fix' },
  { id: 6, title: 'Code Debugging Request' },
];

export const Chatbox = () => {
  const [{userMessages}, dispatch] = useStateValue()

  const handleItemClick = (item) => {
    alert(`Clicked item: ${item.title}`);
    // 这里可以编写读取或处理 item 的逻辑，比如：
    // - 显示 item 的详情
    // - 切换聊天窗口内容
    // - 发 IPC 消息给主进程
    // ...
  };

  return (
    <div className='h-full flex'>



      {/* <div className="hidden lg:block lg:w-60 bg-gray-100 border-r overflow-y-auto p-3">

      </div> */}

      <div className="hidden lg:block lg:w-60 bg-gray-100 p-3 border-r overflow-y-auto text-sm">
      <div className="font-bold mb-2">Chats</div>
      <ul className="space-y-2">
        {chatItems.map((item) => (
          <li
            key={item.id}
            onClick={() => handleItemClick(item)}
            className="hover:bg-gray-200 p-1 rounded cursor-pointer"
          >
            {item.title}
          </li>
        ))}
      </ul>
    </div>
      <div
      className='h-full w-full flex flex-col justify-between'
      >
        <ChatboxTitleBar></ChatboxTitleBar>
        
          {userMessages.length > 0 && 
              (            
                          <ChatboxMessageArea/>
                          
            )
          }
          <ChatboxInputArea className='w-full'></ChatboxInputArea>

      </div>
      </div>
  )
}

export default Chatbox;