import React, { useRef, useEffect } from 'react';
import { useStateValue } from '../content/StateProvider';

const ChatboxMessageArea = () => {
  // 从全局状态中获取 userMessages
  const [{ userMessages }] = useStateValue();
  const messageEndRef = useRef(null); // 用来滚动到底部

  // 当 userMessages 更新时，自动滚动到底部
  useEffect(() => {
    if (messageEndRef.current) {
      messageEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [userMessages]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2 max-h-[60vh]">
      {userMessages.map((msg, index) => {
        // 输出调试信息，确保消息数据正确
        console.log("Rendering message:", msg);
        return (
          <div
            key={index}
            className={`flex mb-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`rounded-2xl px-4 py-2 max-w-[70%] whitespace-pre-wrap shadow-sm ${
                msg.role === "user" ? "bg-green-100 text-right" : "bg-neutral-100 text-left"
              }`}
            >
              {msg.content}
            </div>
          </div>
        );
      })}

      {/* 占位元素用于滚动到底部 */}
      <div ref={messageEndRef} />
    </div>
  );
};

export default ChatboxMessageArea;