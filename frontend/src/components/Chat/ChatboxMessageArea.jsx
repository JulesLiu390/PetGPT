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

import { MdDelete, MdEdit, MdCheck, MdClose, MdContentCopy, MdRefresh } from 'react-icons/md';
import { actionType } from '../../context/reducer';

// Render a single part (text, image, or file)
const MessagePartContent = ({ part, isUser }) => {
  const [imageSrc, setImageSrc] = useState(null);
  
  useEffect(() => {
    if (part.type === 'image_url') {
      const url = part.image_url.url;
      // If it's already base64 or http URL, use directly
      if (url.startsWith('data:') || url.startsWith('http')) {
        setImageSrc(url);
      } else {
        // It's a file path, need to load via Electron
        const fileName = url.split('/').pop();
        window.electron?.readUpload(fileName).then(data => {
          setImageSrc(data);
        }).catch(err => {
          console.error('Failed to load image:', err);
          // Fallback: try using file:// protocol
          setImageSrc(`file://${url}`);
        });
      }
    }
  }, [part]);

  if (part.type === 'text') {
    return isUser ? (
        <div className="bg-[#f4f4f4] rounded-2xl px-4 py-2">
            <span>{part.text}</span>
        </div>
    ) : (
        <div className="prose-sm prose-neutral break-words w-full max-w-full">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a: LinkRenderer, code: CodeBlock}}>
                {part.text}
            </ReactMarkdown>
        </div>
    );
  } else if (part.type === 'image_url') {
    if (!imageSrc) {
      return (
        <div className="rounded-lg overflow-hidden shadow-sm bg-gray-100 w-32 h-32 flex items-center justify-center">
          <span className="text-gray-400 text-sm">Loading...</span>
        </div>
      );
    }
    return (
        <div className="rounded-lg overflow-hidden shadow-sm">
            <img src={imageSrc} alt="content" className="max-w-xs max-h-64 object-contain rounded-lg" />
        </div>
    );
  } else if (part.type === 'file_url') {
    return (
        <div className="flex items-center gap-2 p-2 bg-gray-100 rounded-lg border border-gray-200">
            <span className="text-xs text-gray-500">📎</span>
            <span className="text-blue-500 truncate max-w-[200px] text-sm">
                {part.file_url.url.split('/').pop()}
            </span>
        </div>
    );
  }
  return null;
};

const ChatboxMessageArea = ({ messages, streamingContent, isActive }) => {
  const [{ currentConversationId, userMessages }, dispatch] = useStateValue();
  const messageEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const prevConversationIdRef = useRef(null);
  const [isThinking, setIsThinking] = useState(false);
  const [firstTime, setFirstTime] = useState(true);
  const [Chatlength, setChatlength] = useState(0)
  const [hoveredMessageIndex, setHoveredMessageIndex] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editingPartIndex, setEditingPartIndex] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [copiedIndex, setCopiedIndex] = useState(null);

  const handleCopyPart = (part, key) => {
    let text = "";
    if (part.type === 'text') {
        text = part.text;
    } else if (part.type === 'image_url') {
        text = part.image_url.url;
    } else if (part.type === 'file_url') {
        text = part.file_url.url;
    }
    navigator.clipboard.writeText(text);
    setCopiedIndex(key);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const startEditingPart = (msgIndex, partIndex, text) => {
    setEditingIndex(msgIndex);
    setEditingPartIndex(partIndex);
    setEditContent(text);
  };

  const cancelEditing = () => {
    setEditingIndex(null);
    setEditingPartIndex(null);
    setEditContent("");
  };

  const saveEditPart = async (msgIndex, partIndex) => {
    const msg = messages[msgIndex];
    let newContent;
    
    if (Array.isArray(msg.content)) {
        newContent = msg.content.map((part, i) => 
            i === partIndex ? { ...part, text: editContent } : part
        );
    } else {
        newContent = editContent;
    }

    dispatch({ type: actionType.UPDATE_MESSAGE, index: msgIndex, message: { content: newContent } });

    const newMessages = [...messages];
    newMessages[msgIndex] = { ...msg, content: newContent };

    if (currentConversationId) {
        try {
            await window.electron.updateConversation(currentConversationId, { history: newMessages });
        } catch (error) {
            console.error("Failed to save edit:", error);
        }
    }

    cancelEditing();
  };

  const handleDeletePart = async (msgIndex, partIndex) => {
    const msg = messages[msgIndex];
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    
    if (parts.length <= 1) {
        // If only one part, delete the whole message
        dispatch({ type: actionType.DELETE_MESSAGE, index: msgIndex });
        const newMessages = messages.filter((_, i) => i !== msgIndex);
        if (currentConversationId) {
            try {
                await window.electron.updateConversation(currentConversationId, { history: newMessages });
            } catch (error) {
                console.error("Failed to delete message:", error);
            }
        }
        return;
    }
    
    const newContent = parts.filter((_, i) => i !== partIndex);
    const newMessages = [...messages];
    newMessages[msgIndex] = { ...msg, content: newContent };

    dispatch({ type: actionType.UPDATE_MESSAGE, index: msgIndex, message: { content: newContent } });

    if (currentConversationId) {
        try {
            await window.electron.updateConversation(currentConversationId, { history: newMessages });
        } catch (error) {
            console.error("Failed to delete part:", error);
        }
    }
  };

  const handleRegeneratePart = async (msgIndex, partIndex) => {
    const msg = messages[msgIndex];
    
    // 重新生成逻辑：
    // - 点击 user 消息的任何 part：保留整个 user 消息，用它重新请求 AI
    // - 点击 assistant 消息：保留到前一条 user 消息，用它重新请求 AI
    
    let newMessages;
    
    if (msg.role === 'user') {
        // 点击的是 user 消息，保留整个 user 消息，移除之后的所有消息
        newMessages = messages.slice(0, msgIndex + 1);
    } else {
        // 点击的是 assistant 消息，保留到前一条 user 消息
        newMessages = messages.slice(0, msgIndex);
        
        // 确保最后一条是 user 消息
        if (newMessages.length === 0 || newMessages[newMessages.length - 1].role !== 'user') {
            console.error("Cannot regenerate: No valid user message found.");
            return;
        }
    }
    
    // 如果没有消息了，无法重新生成
    if (newMessages.length === 0) {
        console.error("Cannot regenerate: No messages to regenerate from.");
        return;
    }
    
    // 确保最后一条是 user 消息
    if (newMessages[newMessages.length - 1].role !== 'user') {
        console.error("Cannot regenerate: Last message is not a user message.");
        return;
    }
    
    if (currentConversationId) {
        try {
            await window.electron.updateConversation(currentConversationId, {
                history: newMessages
            });
            
            dispatch({
                type: actionType.SWITCH_CONVERSATION,
                id: currentConversationId,
                userMessages: newMessages
            });

            setTimeout(() => {
                dispatch({ type: actionType.TRIGGER_RUN_FROM_HERE });
            }, 50);
            
        } catch (error) {
            console.error("Failed to regenerate:", error);
        }
    }
  };

  const handleDelete = async (index) => {
    // 1. Update local state
    dispatch({ type: actionType.DELETE_MESSAGE, index });

    // 2. Calculate new messages array for backend update
    // Note: We use messages prop here, but for consistency we should filter the current messages
    const newMessages = messages.filter((_, i) => i !== index);

    // 3. Update backend
    if (currentConversationId) {
        try {
            await window.electron.updateConversation(currentConversationId, {
                history: newMessages
            });
        } catch (error) {
            console.error("Failed to delete message:", error);
            // Optionally revert state here if needed
        }
    }
  };

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
        
        // Flatten content into parts for rendering
        const parts = Array.isArray(msg.content) 
            ? msg.content 
            : [{ type: 'text', text: msg.content }];

        return (
          <div
            key={index}
            className={`flex flex-col gap-2 mb-2 w-full ${isUser ? 'items-end' : 'items-start'} ${index === 0 ? 'mt-4' : ''}`}
          >
            {parts.map((part, partIndex) => (
              <div
                key={`${index}-${partIndex}`}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                onMouseEnter={() => setHoveredMessageIndex(`${index}-${partIndex}`)}
                onMouseLeave={() => setHoveredMessageIndex(null)}
              >
                <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`} style={{ maxWidth: '100%' }}>
                    <div className={`whitespace-pre-wrap ${isUser ? 'text-gray-800 text-right text-sm' : 'bg-transparent text-left text-sm'}`}>
                      {editingIndex === index && editingPartIndex === partIndex ? (
                        <div className="flex flex-col gap-2 min-w-[200px]">
                            <textarea
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                className="w-full p-2 bg-white/50 rounded border border-gray-200 focus:outline-none focus:border-blue-400 text-sm min-h-[60px]"
                                autoFocus
                            />
                            <div className="flex justify-end gap-2">
                                <button onClick={cancelEditing} className="p-1 text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 rounded" title="Cancel">
                                    <MdClose size={16} />
                                </button>
                                <button onClick={() => saveEditPart(index, partIndex)} className="p-1 text-white bg-blue-500 hover:bg-blue-600 rounded" title="Save">
                                    <MdCheck size={16} />
                                </button>
                            </div>
                        </div>
                      ) : (
                        <MessagePartContent part={part} isUser={isUser} />
                      )}
                    </div>

                    {/* Action Buttons for each part */}
                    <div 
                        className={`flex items-center gap-0.5 mt-0.5 transition-opacity duration-200 ${
                            !isUser || hoveredMessageIndex === `${index}-${partIndex}`
                                ? 'opacity-100' 
                                : 'opacity-0 pointer-events-none'
                        }`}
                    >
                        <button
                            onClick={() => handleCopyPart(part, `${index}-${partIndex}`)}
                            className="p-1 text-gray-400 hover:text-gray-600 transition-colors rounded"
                            title="Copy"
                        >
                            {copiedIndex === `${index}-${partIndex}` ? <MdCheck size={12} /> : <MdContentCopy size={12} />}
                        </button>
                        {part.type === 'text' && (
                            <button
                                onClick={() => startEditingPart(index, partIndex, part.text)}
                                className="p-1 text-gray-400 hover:text-blue-500 transition-colors rounded"
                                title="Edit"
                            >
                                <MdEdit size={12} />
                            </button>
                        )}
                        <button
                            onClick={() => handleRegeneratePart(index, partIndex)}
                            className="p-1 text-gray-400 hover:text-green-500 transition-colors rounded"
                            title="Regenerate"
                        >
                            <MdRefresh size={12} />
                        </button>
                        <button
                            onClick={() => handleDeletePart(index, partIndex)}
                            className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded"
                            title="Delete"
                        >
                            <MdDelete size={12} />
                        </button>
                    </div>
                </div>
              </div>
            ))}
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