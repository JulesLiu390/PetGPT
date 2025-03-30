import React, { useRef, useEffect, useState } from 'react';
import { useStateValue } from '../content/StateProvider';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css'; // 引入暗色主题

// 自定义代码块组件，添加复制按钮并使用 Highlight.js 进行高亮
const CodeBlock = ({ inline, className, children, ...props }) => {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);

  // 取出语言，如 "language-js"
  const match = /language-(\w+)/.exec(className || '');
  // 提取语言名，比如 "js"
  const language = match && hljs.getLanguage(match[1]) ? match[1] : null;

  // 将 children 转为字符串，并移除末尾换行符
  const codeString = String(children).replace(/\n$/, '');

  // 如果是块级代码（非 inline），但只有一行且字符数很短（阈值可自行调整），就不当作代码块处理
  const isBlockButTooShort =
    !inline && !codeString.includes('\n') && codeString.length < 30;

  // 当组件挂载/更新后，对“真正的块级”代码执行高亮
  useEffect(() => {
    if (!inline && !isBlockButTooShort && codeRef.current) {
      if (language) {
        const highlighted = hljs.highlight(codeString, { language }).value;
        codeRef.current.innerHTML = highlighted;
      } else {
        const highlighted = hljs.highlightAuto(codeString).value;
        codeRef.current.innerHTML = highlighted;
      }
    }
  }, [inline, language, codeString, isBlockButTooShort]);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 1. 如果是行内代码
  if (inline) {
    return (
      <code
        className="bg-gray-800 text-gray-100 rounded px-1 font-mono"
        {...props}
      >
        {children}
      </code>
    );
  }

  // 2. 如果是块级代码但太短（单行且字符数少），当成行内处理
  if (isBlockButTooShort) {
    return (
      <code
        className="bg-gray-800 text-gray-100 rounded px-1 font-mono"
        {...props}
      >
        {children}
      </code>
    );
  }

  // 3. 否则，按块级代码高亮渲染，并带复制按钮
  return (
    <div className="relative my-2">
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 bg-gray-300 text-gray-800 px-2 py-1 text-xs rounded hover:bg-gray-400"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="rounded p-4 bg-black text-gray-100 overflow-x-auto font-mono text-sm">
        <code ref={codeRef} {...props} />
      </pre>
    </div>
  );
};

const ChatboxMessageArea = () => {
  const [{ userMessages }] = useStateValue();
  const messageEndRef = useRef(null);

  // 自动滚动到底部
  useEffect(() => {
    if (messageEndRef.current) {
      messageEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [userMessages]);

  return (
    <div className="flex-1 w-full max-w-full overflow-y-auto px-4 py-2 max-h-[80vh]">
      {userMessages.map((msg, index) => {
        const isUser = msg.role === 'user';
        return (
          <div
            key={index}
            className={`flex mb-2 ${isUser ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`rounded-2xl px-4 py-2 whitespace-pre-wrap shadow-sm ${
                isUser ? 'bg-green-100 text-right text-xs' : 'bg-neutral-100 text-left text-xs'
              }`}
              style={{ maxWidth: '100%' }}
            >
              {isUser ? (
                msg.content
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  // 指定自定义代码块组件
                  components={{ code: CodeBlock }}
                  className="prose prose-xs break-words max-w-none"
                >
                  {msg.content}
                </ReactMarkdown>
              )}
            </div>
          </div>
        );
      })}
      <div ref={messageEndRef} />
    </div>
  );
};

export default ChatboxMessageArea;