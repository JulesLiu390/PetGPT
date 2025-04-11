import React, { useRef, useEffect, useState } from 'react';
import { useStateValue } from '../content/StateProvider';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css'; // 引入暗色主题

// 自定义链接组件，自动添加 target="_blank"
const LinkRenderer = ({ href, children, ...props }) => {
  // 如果没有 href，则直接返回 span
  if (!href) {
    return <span {...props}>{children}</span>;
  }
  // 仅对以 http(s) 开头的外链做转换，其它保留默认
  if (href.startsWith('http')) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
        className={`text-blue-500 hover:text-blue-600 underline ${props.className || ''}`}
      >
        {children}
      </a>
    );
  }
  // 如果不是以 http 开头，则直接返回默认 a 标签
  return <a href={href} {...props}>{children}</a>;
};
// 自定义代码块组件，添加复制按钮并使用 Highlight.js 进行高亮
const CodeBlock = ({ inline, className, children, ...props }) => {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);
  const match = /language-(\w+)/.exec(className || '');
  const language = match && hljs.getLanguage(match[1]) ? match[1] : null;
  const codeString = String(children).replace(/\n$/, '');
  const isBlockButTooShort = !inline && !codeString.includes('\n') && codeString.length < 30;

  useEffect(() => {
    if (!inline && !isBlockButTooShort && codeRef.current) {
      const highlighted = language
        ? hljs.highlight(codeString, { language }).value
        : hljs.highlightAuto(codeString).value;
      codeRef.current.innerHTML = highlighted;
    }
  }, [inline, language, codeString, isBlockButTooShort]);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (inline || isBlockButTooShort) {
    return (
      <code className="bg-gray-800 text-gray-100 max-w-full rounded px-1 font-mono" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="relative my-2">
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 bg-gray-300 text-gray-800 px-2 py-1 text-xs rounded hover:bg-gray-400"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="rounded p-4 bg-black text-gray-100 overflow-x-auto max-w-full font-mono text-sm whitespace-pre-wrap break-words">
        <code ref={codeRef} className="w-full" {...props} />
      </pre>
    </div>
  );
};

const ChatboxMessageArea = () => {
  const [{ userMessages }] = useStateValue();
  const messageEndRef = useRef(null);
  const [isThinking, setIsThinking] = useState(false);
  const [firstTime, setFirstTime] = useState(true);
  const [Chatlength, setChatlength] = useState(0)

  // ✅ 添加思考状态监听
  useEffect(() => {
    const handler = (event, updatedMood) => {
      setIsThinking(updatedMood == 'thinking');
    };
    window.electron?.onMoodUpdated(handler);
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    if(firstTime) {
      setIsThinking(true);
      setFirstTime(false);
    } 
    if (messageEndRef.current) {
      messageEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
    setChatlength(userMessages.length)
  }, [userMessages, isThinking]);

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
                  components={{a: LinkRenderer, code: CodeBlock }}
                  className="prose prose-xs break-words w-full max-w-full"
                >
                  {msg.content}
                </ReactMarkdown>
              )}
            </div>
          </div>
        );
      })}
      

      {/* ✅ 额外渲染：不属于 userMessages，仅根据 isThinking */}
      {isThinking && Chatlength == userMessages.length && (
        <div className="flex mb-2 justify-start">
          <div className="rounded-2xl px-4 py-2 whitespace-pre-wrap shadow-sm bg-neutral-100 text-left text-xs animate-pulse italic text-gray-500">
            Thinking……
          </div>
        </div>
      )}

      <div ref={messageEndRef} />
    </div>
  );
};


export default ChatboxMessageArea;