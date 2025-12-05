import React, { useRef, useEffect, useState } from 'react';
import { useStateValue } from '../../context/StateProvider';
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

const ChatboxMessageArea = ({ messages, streamingContent, isActive }) => {
  const [{ currentConversationId }] = useStateValue();
  const messageEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const prevConversationIdRef = useRef(null);
  const [isThinking, setIsThinking] = useState(false);
  const [firstTime, setFirstTime] = useState(true);
  const [Chatlength, setChatlength] = useState(0)

  // 监听滚动事件，判断用户是否手动向上滚动
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    // 如果距离底部小于 100px，则认为用户在底部，允许自动滚动
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    shouldAutoScrollRef.current = isAtBottom;
  };

  // ✅ 添加思考状态监听
  useEffect(() => {
    const handler = (event, updatedMood) => {
      setIsThinking(updatedMood == 'thinking');
    };
    window.electron?.onMoodUpdated(handler);
  }, []);

  useEffect(() => {
    const handleCharacterId = () => {
      setIsThinking(false);
      setFirstTime(false);
    };
    window.electron?.onCharacterId(handleCharacterId);
  }, []);

  // 处理 Tab 切换时的滚动 (瞬间到底)
  useEffect(() => {
    if (isActive && scrollContainerRef.current) {
        // 使用 setTimeout 确保渲染完成后执行
        setTimeout(() => {
            if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
            }
        }, 0);
    }
  }, [isActive]);

  // 处理消息更新时的滚动
  useEffect(() => {
    if (!isActive) return;

    if(firstTime) {
      setIsThinking(true);
      setFirstTime(false);
    } 

    if (messages?.length > 0) {
        const lastMsg = messages[messages.length - 1];
        // 只有当最新消息是用户发送的时，才自动滚动
        // AI 的回复由流式传输逻辑处理滚动，或者用户自己查看
        if (lastMsg.role === 'user') {
             messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
             shouldAutoScrollRef.current = true; 
        }
    }
    setChatlength(messages?.length || 0)
  }, [messages?.length]); 

  // 流式传输时的自动滚动
  useEffect(() => {
    if (!isActive) return;
    if (streamingContent && shouldAutoScrollRef.current && scrollContainerRef.current) {
        // 使用 requestAnimationFrame 确保在渲染后执行滚动
        requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
            }
        });
    }
  }, [streamingContent, isActive]);

  return (
    <div 
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 w-full max-w-full overflow-y-auto px-4 py-2 max-h-[80vh]"
    >
      {Array.isArray(messages) && messages.map((msg, index) => {
        if (!msg) return null; // Skip null/undefined messages
        const isUser = msg.role === 'user';
        return (
          <div
            key={index}
            className={`flex mb-4 ${isUser ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`rounded-2xl px-4 py-2 whitespace-pre-wrap ${
                isUser ? 'bg-[#f4f4f4] text-gray-800 text-right text-sm' : 'bg-transparent text-left text-sm'
              }`}
              style={{ maxWidth: '100%' }}
            >
              {isUser ? (
                typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
              ) : (
                <div className="prose-sm prose-neutral break-words w-full max-w-full">
                    <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{a: LinkRenderer, code: CodeBlock,
                    }}
                    >
                    {typeof msg.content === 'string' ? msg.content : (msg.content ? String(msg.content) : "")}
                    </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        );
      })}
      

      {/* ✅ Streaming Reply Area */}
      {streamingContent && (
        <div className="flex mb-4 justify-start">
            <div className="rounded-2xl px-4 py-2 whitespace-pre-wrap bg-transparent text-left text-sm" style={{ maxWidth: '100%' }}>
                <div className="prose-sm prose-neutral break-words w-full max-w-full">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{a: LinkRenderer, code: CodeBlock}}
                    >
                        {streamingContent}
                    </ReactMarkdown>
                </div>
            </div>
        </div>
      )}

      {/* ✅ 额外渲染：不属于 userMessages，仅根据 isThinking */}
      {isThinking && !streamingContent && messages?.length > 0 && Chatlength == messages.length && messages[messages.length - 1].role === "user" && (
        <div className="flex mb-4 justify-start">
          <div className="rounded-2xl px-4 py-2 whitespace-pre-wrap bg-transparent text-left text-sm animate-pulse italic text-gray-400">
            Thinking……
          </div>
        </div>
      )}

      <div ref={messageEndRef} />
    </div>
  );
};


export default ChatboxMessageArea;