import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { useStateValue } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import * as tauri from '../../utils/tauri';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css'; // 引入暗色主题
import { LiveToolCalls, ToolCallHistory } from './ToolCallDisplay';

// 紧凑 Markdown 样式（行间距、段间距大幅缩小）
const CompactMarkdownStyles = () => (
  <style>{`
    .message-markdown p { margin: 0.1em 0 !important; }
    .message-markdown h1, 
    .message-markdown h2, 
    .message-markdown h3, 
    .message-markdown h4, 
    .message-markdown h5, 
    .message-markdown h6 { margin: 0.3em 0 0.1em 0 !important; }
    .message-markdown ul, 
    .message-markdown ol { margin: 0.1em 0 !important; padding-left: 1.25em; }
    .message-markdown li { margin: 0 !important; }
    .message-markdown li p { margin: 0 !important; }
    .message-markdown pre { margin: 0.1em 0 !important; }
    .message-markdown blockquote { margin: 0.1em 0 !important; }
    .message-markdown > *:first-child { margin-top: 0 !important; }
    .message-markdown > *:last-child { margin-bottom: 0 !important; }
    
    @keyframes cursor-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
  `}</style>
);

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

import { MdDelete, MdEdit, MdCheck, MdClose, MdContentCopy, MdRefresh, MdOpenInNew, MdPlayCircle, MdAudiotrack, MdInsertDriveFile, MdCallSplit, MdCameraAlt } from 'react-icons/md';
import { renderShareImage, copyImageToClipboard, saveImageToFile } from './ShareCardRenderer';

// Helper: get mime type from file extension
const getMimeTypeFromPath = (filePath) => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const mimeMap = {
    // Video
    'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska',
    // Audio
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4', 'flac': 'audio/flac', 'aac': 'audio/aac',
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain', 'md': 'text/markdown', 'json': 'application/json', 'csv': 'text/csv',
    // Images (fallback)
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
  };
  return mimeMap[ext] || 'application/octet-stream';
};

// Helper: get file icon based on mime type
const getFileIcon = (mimeType) => {
  if (mimeType?.startsWith('video/')) return <MdPlayCircle size={24} className="text-purple-500" />;
  if (mimeType?.startsWith('audio/')) return <MdAudiotrack size={24} className="text-green-500" />;
  if (mimeType === 'application/pdf') return <span className="text-red-500 text-lg">📄</span>;
  if (mimeType?.includes('word') || mimeType?.includes('document')) return <span className="text-blue-500 text-lg">📝</span>;
  if (mimeType?.includes('sheet') || mimeType?.includes('excel')) return <span className="text-green-600 text-lg">📊</span>;
  if (mimeType?.includes('presentation') || mimeType?.includes('powerpoint')) return <span className="text-orange-500 text-lg">📽️</span>;
  return <MdInsertDriveFile size={24} className="text-gray-500" />;
};

// Media Preview Modal
const MediaPreviewModal = ({ src, type, onClose }) => {
  if (!src) return null;
  
  return (
    <div 
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <button 
          onClick={onClose}
          className="absolute -top-10 right-0 text-white hover:text-gray-300 text-2xl"
        >
          <MdClose size={28} />
        </button>
        {type === 'video' ? (
          <video 
            controls 
            autoPlay 
            className="max-w-[90vw] max-h-[85vh] rounded-lg"
          >
            <source src={src} />
          </video>
        ) : (
          <img 
            src={src} 
            alt="preview" 
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg" 
          />
        )}
      </div>
    </div>
  );
};

// Render a single part (text, image, or file)
const MessagePartContent = ({ part, isUser }) => {
  const [mediaSrc, setMediaSrc] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewType, setPreviewType] = useState('image');
  
  // Determine mime type
  const mimeType = part.file_url?.mime_type || part.mime_type || 
    (part.type === 'file_url' ? getMimeTypeFromPath(part.file_url?.url || '') : null);
  
  useEffect(() => {
    const loadMedia = async () => {
      let url = null;
      
      if (part.type === 'image_url') {
        url = part.image_url?.url;
      } else if (part.type === 'file_url') {
        url = part.file_url?.url;
      }
      
      if (!url) return;
      
      // If it's already base64 or http URL, use directly
      if (url.startsWith('data:') || url.startsWith('http')) {
        setMediaSrc(url);
        return;
      }
      
      // It's a file path, need to load via Electron
      setIsLoading(true);
      try {
        const fileName = url.split('/').pop();
        const data = await tauri.readUpload(fileName);
        setMediaSrc(data);
      } catch (err) {
        console.error('Failed to load media:', err);
        // Fallback: try using file:// protocol
        setMediaSrc(`file://${url}`);
      } finally {
        setIsLoading(false);
      }
    };
    
    // Only load for image_url or video/audio file_url
    if (part.type === 'image_url') {
      loadMedia();
    } else if (part.type === 'file_url') {
      const mime = mimeType;
      if (mime?.startsWith('video/') || mime?.startsWith('audio/')) {
        loadMedia();
      }
    }
  }, [part, mimeType]);

  // Handle opening file externally
  const handleOpenFile = () => {
    const url = part.file_url?.url;
    if (url) {
      tauri.openFileExternal?.(url) || tauri.openExternal?.(`file://${url}`);
    }
  };

  if (part.type === 'text') {
    return isUser ? (
        <div className="bg-[#f4f4f4] rounded-2xl px-4 py-2">
            <span>{part.text}</span>
        </div>
    ) : (
        <div 
          className="prose-sm prose-neutral break-words w-full max-w-full message-markdown"
          style={{ lineHeight: '1.3' }}
        >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a: LinkRenderer, code: CodeBlock}}>
                {part.text}
            </ReactMarkdown>
        </div>
    );
  } else if (part.type === 'image_url') {
    if (!mediaSrc || isLoading) {
      return (
        <div className="rounded-lg overflow-hidden shadow-sm bg-gray-100 w-20 h-20 flex items-center justify-center">
          <span className="text-gray-400 text-xs">Loading...</span>
        </div>
      );
    }
    return (
      <>
        <div 
          className="rounded-lg overflow-hidden shadow-sm cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => { setPreviewType('image'); setShowPreview(true); }}
        >
          <img 
            src={mediaSrc} 
            alt="content" 
            className="w-20 h-20 object-cover rounded-lg" 
          />
        </div>
        {showPreview && (
          <MediaPreviewModal 
            src={mediaSrc} 
            type="image" 
            onClose={() => setShowPreview(false)} 
          />
        )}
      </>
    );
  } else if (part.type === 'file_url') {
    const fileName = part.file_url?.url?.split('/').pop() || 'file';
    
    // Video - thumbnail with play button overlay
    if (mimeType?.startsWith('video/')) {
      return (
        <>
          <div 
            className="relative rounded-lg overflow-hidden shadow-sm bg-black w-24 h-24 cursor-pointer hover:opacity-90 transition-opacity group"
            onClick={() => { setPreviewType('video'); setShowPreview(true); }}
          >
            {mediaSrc ? (
              <>
                <video 
                  className="w-full h-full object-cover" 
                  preload="metadata"
                  muted
                >
                  <source src={mediaSrc} type={mimeType} />
                </video>
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                  <MdPlayCircle size={32} className="text-white/90" />
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full bg-gray-800">
                <MdPlayCircle size={24} className="text-gray-400" />
                <span className="text-gray-400 text-xs mt-1">{isLoading ? 'Loading...' : 'Video'}</span>
              </div>
            )}
          </div>
          {showPreview && mediaSrc && (
            <MediaPreviewModal 
              src={mediaSrc} 
              type="video" 
              onClose={() => setShowPreview(false)} 
            />
          )}
        </>
      );
    }
    
    // Audio
    if (mimeType?.startsWith('audio/')) {
      return (
        <div className="rounded-lg overflow-hidden shadow-sm bg-gray-100 max-w-sm">
          <div className="flex items-center gap-2 p-2 border-b border-gray-200">
            <MdAudiotrack size={20} className="text-green-500" />
            <span className="text-sm truncate flex-1">{fileName}</span>
            <button onClick={handleOpenFile} className="text-gray-500 hover:text-blue-500" title="Open externally">
              <MdOpenInNew size={14} />
            </button>
          </div>
          {mediaSrc ? (
            <audio controls className="w-full" preload="metadata">
              <source src={mediaSrc} type={mimeType} />
              Your browser does not support audio playback.
            </audio>
          ) : (
            <div className="flex items-center justify-center h-12 bg-gray-50">
              <span className="text-gray-400 text-sm">{isLoading ? 'Loading...' : 'Audio'}</span>
            </div>
          )}
        </div>
      );
    }
    
    // PDF / Documents / Other files - show card with open button
    return (
        <div 
          className="flex items-center gap-3 p-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 cursor-pointer transition-colors max-w-xs"
          onClick={handleOpenFile}
        >
            {getFileIcon(mimeType)}
            <div className="flex-1 min-w-0">
              <span className="text-sm text-gray-800 truncate block">{fileName}</span>
              <span className="text-xs text-gray-400">{mimeType?.split('/')[1]?.toUpperCase() || 'FILE'}</span>
            </div>
            <MdOpenInNew size={16} className="text-gray-400" />
        </div>
    );
  }
  return null;
};

const ChatboxMessageArea = ({ conversationId, streamingContent, isActive, showTitleBar = true, onBranchFromMessage }) => {
  const stateValue = useStateValue();
  const [state, dispatch] = stateValue || [{}, () => {}];
  const { currentConversationId, liveToolCalls = {}, searchHighlight } = state;
  
  // 新方案: 使用 Rust-owned TabState（包含 messages 和 is_thinking）
  const [tabState, setTabState] = useState({ messages: [], is_thinking: false });
  const messages = tabState.messages;
  const isThinking = tabState.is_thinking;
  
  // 使用传入的 conversationId 或回退到全局 currentConversationId
  const activeConvId = conversationId || currentConversationId;
  
  // Get tool calls for current conversation
  const activeToolCalls = liveToolCalls[activeConvId] || [];
  const messageEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const prevConversationIdRef = useRef(null);
  
  // ========== 新的滚动控制系统 ==========
  // 滚动模式：'auto' = 自动跟随到底部，'user' = 用户控制，保持当前位置
  const scrollModeRef = useRef('auto');
  const SCROLL_THRESHOLD = 60; // 距离底部多少像素内认为"在底部"
  
  // 滚动到底部的函数（强制版，忽略模式）
  const forceScrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      console.log('[SCROLL] forceScrollToBottom called, scrollHeight:', scrollContainerRef.current.scrollHeight);
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, []);
  
  // 滚动到底部的函数（受控版，尊重用户模式）
  const scrollToBottomIfAuto = useCallback(() => {
    console.log('[SCROLL] scrollToBottomIfAuto called, mode:', scrollModeRef.current);
    if (scrollModeRef.current === 'auto' && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, []);
  
  // 🔧 正在恢复滚动位置的标志，防止 handleScroll 干扰
  const isRestoringRef = useRef(false);
  
  // 🔧 用户模式下的滚动位置记录（实时更新）
  const userScrollPositionRef = useRef(0);
  
  // 处理用户滚动事件
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    
    // 如果正在恢复滚动位置，不要改变模式
    if (isRestoringRef.current) {
      console.log('[SCROLL] handleScroll skipped - restoration in progress');
      return;
    }
    
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    
    const prevMode = scrollModeRef.current;
    if (distanceFromBottom > SCROLL_THRESHOLD) {
      // 用户向上滚动，切换到用户控制模式
      scrollModeRef.current = 'user';
    } else if (distanceFromBottom < 10) {
      // 用户滚动到底部，切换回自动模式
      scrollModeRef.current = 'auto';
    }
    
    // 🔧 在 user 模式下实时记录滚动位置
    if (scrollModeRef.current === 'user') {
      userScrollPositionRef.current = scrollTop;
    }
    
    if (prevMode !== scrollModeRef.current) {
      console.log('[SCROLL] Mode changed:', prevMode, '->', scrollModeRef.current, 'distanceFromBottom:', distanceFromBottom);
    }
  }, []);
  
  // Tab 切换或新对话时，重置为自动模式并滚动到底部
  useEffect(() => {
    if (isActive && activeConvId !== prevConversationIdRef.current) {
      console.log('[SCROLL] Tab/Conv switch, resetting to auto');
      scrollModeRef.current = 'auto';
      prevConversationIdRef.current = activeConvId;
      // 延迟一帧确保内容已渲染
      requestAnimationFrame(forceScrollToBottom);
    }
  }, [isActive, activeConvId, forceScrollToBottom]);
  
  // 用户发送新消息时，重置为自动模式并滚动到底部
  useEffect(() => {
    if (messages?.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user') {
        console.log('[SCROLL] User sent message, resetting to auto');
        scrollModeRef.current = 'auto';
        requestAnimationFrame(forceScrollToBottom);
      }
    }
  }, [messages?.length, forceScrollToBottom]);
  
  // 流式内容更新时，自动滚动到底部（仅在 auto 模式）
  useEffect(() => {
    if (isActive && streamingContent) {
      scrollToBottomIfAuto();
    }
  }, [isActive, streamingContent, scrollToBottomIfAuto]);
  
  // 🔧 FIX: 流式内容结束时保护滚动位置
  const prevStreamingRef = useRef(streamingContent);
  const savedScrollTopRef = useRef(0);
  
  // 在渲染前保存滚动位置（仅用于 user 模式）
  if (scrollContainerRef.current && prevStreamingRef.current && !streamingContent) {
    savedScrollTopRef.current = scrollContainerRef.current.scrollTop;
    console.log('[SCROLL] Saving scroll position before streaming ends:', savedScrollTopRef.current);
  }
  
  useLayoutEffect(() => {
    const hadContent = !!prevStreamingRef.current;
    const hasContent = !!streamingContent;
    
    // 流式内容刚结束
    if (hadContent && !hasContent && isActive) {
      const container = scrollContainerRef.current;
      const mode = scrollModeRef.current;
      
      if (container) {
        if (mode === 'user') {
          // 用户模式：恢复到用户记录的滚动位置
          const userPosition = userScrollPositionRef.current;
          console.log('[SCROLL] Streaming ended (user mode), restoring to:', userPosition);
          isRestoringRef.current = true;
          
          // 立即恢复位置
          container.scrollTop = userPosition;
          
          // 多次尝试恢复位置（防止 DOM 变化导致跳转）
          requestAnimationFrame(() => {
            if (container) container.scrollTop = userPosition;
            requestAnimationFrame(() => {
              if (container) container.scrollTop = userPosition;
              setTimeout(() => {
                if (container) container.scrollTop = userPosition;
                isRestoringRef.current = false;
              }, 50);
            });
          });
        } else {
          // 自动模式：多次强制滚动到底部，确保不会跳回
          console.log('[SCROLL] Streaming ended (auto mode), force scrolling to bottom');
          isRestoringRef.current = true;
          
          // 立即滚动到底部
          container.scrollTop = container.scrollHeight;
          
          // 多次尝试确保滚动到底部（防止 DOM 变化导致跳回）
          requestAnimationFrame(() => {
            if (container) container.scrollTop = container.scrollHeight;
            requestAnimationFrame(() => {
              if (container) container.scrollTop = container.scrollHeight;
              // 再延迟一次确保
              setTimeout(() => {
                if (container) container.scrollTop = container.scrollHeight;
                isRestoringRef.current = false;
              }, 50);
            });
          });
        }
      }
    }
    
    prevStreamingRef.current = streamingContent;
  }, [streamingContent, isActive]);
  
  // 🔍 DEBUG: 监控 scrollTop 异常变化
  useEffect(() => {
    if (!scrollContainerRef.current || !isActive) return;
    
    let lastScrollTop = scrollContainerRef.current.scrollTop;
    const interval = setInterval(() => {
      if (scrollContainerRef.current) {
        const currentScrollTop = scrollContainerRef.current.scrollTop;
        // 检测大幅度向上跳转（可能是 bug）
        if (lastScrollTop - currentScrollTop > 100) {
          console.warn('[SCROLL] ⚠️ Unexpected jump UP detected:', {
            from: lastScrollTop,
            to: currentScrollTop,
            diff: currentScrollTop - lastScrollTop,
            mode: scrollModeRef.current,
            scrollHeight: scrollContainerRef.current.scrollHeight
          });
        }
        lastScrollTop = currentScrollTop;
      }
    }, 100);
    
    return () => clearInterval(interval);
  }, [isActive]);
  // ========== 滚动控制系统结束 ==========
  const [hoveredMessageIndex, setHoveredMessageIndex] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editingPartIndex, setEditingPartIndex] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [sharingIndex, setSharingIndex] = useState(null); // 正在生成分享图片的消息 index
  const [shareMenuIndex, setShareMenuIndex] = useState(null); // 显示分享菜单的消息 index

  // 新方案: 订阅 Rust TabState 更新
  useEffect(() => {
    if (!activeConvId) {
      setTabState({ messages: [], is_thinking: false });
      return;
    }
    
    let unlisten = null;
    let isMounted = true;
    
    const setup = async () => {
      // 1. 获取初始状态
      const initialState = await tauri.getTabState(activeConvId);
      
      // 2. 如果 Rust 缓存为空，从数据库加载并初始化
      if (!initialState.messages || initialState.messages.length === 0) {
        console.log('[ChatboxMessageArea] Cache empty, loading from database:', activeConvId);
        const conversation = await tauri.getConversationWithHistory(activeConvId);
        if (conversation && conversation.history && conversation.history.length > 0) {
          // 初始化 Rust 缓存（这会触发事件推送）
          await tauri.initTabMessages(activeConvId, conversation.history);
          // 初始状态会通过订阅事件更新，所以这里不需要手动设置
        } else {
          // 没有历史记录，设置空状态
          if (isMounted) {
            setTabState({ messages: [], is_thinking: false });
          }
        }
      } else {
        // 使用缓存状态
        if (isMounted) {
          setTabState(initialState);
        }
      }
      
      // 3. 订阅状态更新（Rust 会自动推送任何变化）
      unlisten = await tauri.subscribeTabState(activeConvId, (newState) => {
        if (isMounted) {
          setTabState(newState);
        }
      });
    };
    
    setup();
    
    return () => {
      isMounted = false;
      if (unlisten) unlisten();
    };
  }, [activeConvId]);
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

  // ========== 分享为图片 ==========
  const handleShareAsImage = async (msgIndex, action) => {
    setShareMenuIndex(null);
    setSharingIndex(msgIndex);
    try {
      const msg = messages[msgIndex];
      // 找到前面最近的一条 user 消息作为提问
      let questionMsg = null;
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
          questionMsg = messages[i];
          break;
        }
      }
      if (!questionMsg) {
        questionMsg = { role: 'user', content: '' };
      }

      const blob = await renderShareImage(questionMsg, msg);

      if (action === 'copy') {
        const ok = await copyImageToClipboard(blob);
        if (ok) console.log('[Share] Image copied to clipboard');
      } else if (action === 'save') {
        await saveImageToFile(blob);
      }
    } catch (err) {
      console.error('[Share] Failed to generate share image:', err);
    } finally {
      setSharingIndex(null);
    }
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

    const updatedMsg = { ...msg, content: newContent };
    const newMessages = [...messages];
    newMessages[msgIndex] = updatedMsg;

    // 新方案: 使用 Rust TabState 更新
    if (activeConvId) {
        try {
            await tauri.updateTabStateMessage(activeConvId, msgIndex, updatedMsg);
            await tauri.updateConversation(activeConvId, { history: newMessages });
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
        if (activeConvId) {
            try {
                // 新方案: 使用 Rust TabState 删除消息
                await tauri.deleteTabStateMessage(activeConvId, msgIndex);
                await tauri.updateConversation(activeConvId, { history: newMessages });
            } catch (error) {
                console.error("Failed to delete message:", error);
            }
        }
        return;
    }
    
    const newContent = parts.filter((_, i) => i !== partIndex);
    const newMessages = [...messages];
    newMessages[msgIndex] = { ...msg, content: newContent };

    // 新方案: 使用 Rust TabState 更新消息
    if (activeConvId) {
        try {
            await tauri.updateTabStateMessage(activeConvId, msgIndex, { ...msg, content: newContent });
            await tauri.updateConversation(activeConvId, { history: newMessages });
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
    
    if (activeConvId) {
        try {
            // 新方案: 更新 Rust TabState 和后端
            await tauri.setTabStateMessages(activeConvId, newMessages);
            await tauri.updateConversation(activeConvId, {
                history: newMessages
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
    // 新方案: 直接通过 Rust TabState 删除
    const newMessages = messages.filter((_, i) => i !== index);

    if (activeConvId) {
        try {
            // 新方案: 使用 Rust TabState 删除
            await tauri.deleteTabStateMessage(activeConvId, index);
            await tauri.updateConversation(activeConvId, {
                history: newMessages
            });
        } catch (error) {
            console.error("Failed to delete message:", error);
        }
    }
  };

  // 注意：思考状态(isThinking)现在通过 TabState 订阅自动更新，不再需要单独的 onMoodUpdated 监听

  useEffect(() => {
    const handleCharacterId = () => {
      // Reset thinking state via Rust when character changes
      if (activeConvId) {
        tauri.setTabThinking(activeConvId, false);
      }
    };
    const cleanup = tauri.onCharacterId?.(handleCharacterId);
    return () => {
      if (cleanup) cleanup();
    };
  }, [activeConvId]);

  // ========== 搜索高亮逻辑 ==========
  const highlightCleanupRef = useRef(null);
  
  // 清除高亮
  const clearHighlights = useCallback(() => {
    if (highlightCleanupRef.current) {
      highlightCleanupRef.current();
      highlightCleanupRef.current = null;
    }
  }, []);

  // 关闭搜索高亮
  const dismissSearchHighlight = useCallback(() => {
    clearHighlights();
    dispatch({ type: actionType.SET_SEARCH_HIGHLIGHT, payload: null });
  }, [dispatch, clearHighlights]);

  // 搜索高亮：DOM 标记 + 滚动到第一个匹配
  useEffect(() => {
    clearHighlights();
    if (!searchHighlight || !scrollContainerRef.current) return;

    // 延迟执行，等待 DOM 渲染完成
    const timer = setTimeout(() => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const keyword = searchHighlight.toLowerCase();
      const marks = [];

      // 遍历所有文本节点
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      const matchingNodes = [];
      
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent || '';
        if (text.toLowerCase().includes(keyword)) {
          matchingNodes.push(node);
        }
      }

      // 高亮匹配的文本节点
      for (const node of matchingNodes) {
        const text = node.textContent || '';
        const lowerText = text.toLowerCase();
        let lastIndex = 0;
        const fragments = [];

        let matchStart;
        while ((matchStart = lowerText.indexOf(keyword, lastIndex)) !== -1) {
          // 前段文本
          if (matchStart > lastIndex) {
            fragments.push(document.createTextNode(text.slice(lastIndex, matchStart)));
          }
          // 高亮部分
          const mark = document.createElement('mark');
          mark.className = 'search-highlight-mark';
          mark.style.backgroundColor = '#fef08a';
          mark.style.color = '#854d0e';
          mark.style.borderRadius = '2px';
          mark.style.padding = '0 1px';
          mark.textContent = text.slice(matchStart, matchStart + keyword.length);
          fragments.push(mark);
          marks.push(mark);
          lastIndex = matchStart + keyword.length;
        }

        // 剩余文本
        if (lastIndex < text.length) {
          fragments.push(document.createTextNode(text.slice(lastIndex)));
        }

        if (fragments.length > 0 && node.parentNode) {
          const wrapper = document.createDocumentFragment();
          fragments.forEach(f => wrapper.appendChild(f));
          node.parentNode.replaceChild(wrapper, node);
        }
      }

      // 滚动到第一个高亮
      if (marks.length > 0) {
        marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // 存储清理函数
      highlightCleanupRef.current = () => {
        // 把 mark 元素替换回纯文本
        const allMarks = container.querySelectorAll('mark.search-highlight-mark');
        allMarks.forEach(mark => {
          const textNode = document.createTextNode(mark.textContent || '');
          mark.parentNode?.replaceChild(textNode, mark);
        });
        // 合并相邻文本节点
        container.normalize();
      };
    }, 200);

    return () => clearTimeout(timer);
  }, [searchHighlight, messages, clearHighlights]);


  return (
    <div 
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onClick={() => { if (shareMenuIndex !== null) setShareMenuIndex(null); }}
        className={`flex-1 w-full max-w-full overflow-y-auto px-4 py-2 max-h-[80vh] ${!showTitleBar ? 'pt-11' : 'pt-2'} relative`}
    >
        <CompactMarkdownStyles />

        {/* 搜索高亮提示条 */}
        {searchHighlight && (
          <div className="sticky top-0 z-10 flex items-center justify-between bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-1.5 mb-2 text-xs shadow-sm">
            <span className="text-yellow-800">
              搜索: <strong>{searchHighlight}</strong>
            </span>
            <button
              onClick={dismissSearchHighlight}
              className="text-yellow-600 hover:text-yellow-800 ml-2 font-bold"
            >
              ✕
            </button>
          </div>
        )}

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
            className={`flex flex-col gap-2 mb-2 w-full ${isUser ? 'items-end' : 'items-start'}`}
          >
            {/* 显示工具调用历史 (仅 assistant 消息) */}
            {!isUser && msg.toolCallHistory && msg.toolCallHistory.length > 0 && (
              <ToolCallHistory toolCalls={msg.toolCallHistory} compact={true} />
            )}
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
                            onClick={() => onBranchFromMessage?.(conversationId, index)}
                            className="p-1 text-gray-400 hover:text-purple-500 transition-colors rounded"
                            title="Branch from here"
                        >
                            <MdCallSplit size={12} />
                        </button>
                        {/* Share as image — 仅对 assistant 消息显示 */}
                        {!isUser && partIndex === 0 && (
                          <div className="relative">
                            <button
                              onClick={() => setShareMenuIndex(shareMenuIndex === index ? null : index)}
                              className={`p-1 transition-colors rounded ${
                                sharingIndex === index
                                  ? 'text-orange-500 animate-pulse'
                                  : 'text-gray-400 hover:text-orange-500'
                              }`}
                              title="Share as image"
                              disabled={sharingIndex !== null}
                            >
                              <MdCameraAlt size={12} />
                            </button>
                            {shareMenuIndex === index && (
                              <div
                                className="absolute left-0 bottom-6 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 whitespace-nowrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  onClick={() => handleShareAsImage(index, 'copy')}
                                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 w-full text-left"
                                >
                                  <MdContentCopy size={12} /> Copy as image
                                </button>
                                <button
                                  onClick={() => handleShareAsImage(index, 'save')}
                                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 w-full text-left"
                                >
                                  <MdOpenInNew size={12} /> Save as image
                                </button>
                              </div>
                            )}
                          </div>
                        )}
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
      

      {/* ✅ Live Tool Calls Display */}
      {activeToolCalls.length > 0 && (
        <div className="mb-2">
          <LiveToolCalls toolCalls={activeToolCalls.map(tc => ({
            name: tc.toolName,
            arguments: tc.args,
            status: tc.status,
            result: tc.result,
            duration: tc.duration
          }))} />
        </div>
      )}

      {/* ✅ Streaming Reply Area */}
      {streamingContent && (
        <div className="flex mb-4 justify-start">
            <div className="whitespace-pre-wrap bg-transparent text-left text-sm" style={{ maxWidth: '100%' }}>
                <div 
                  className="prose-sm prose-neutral break-words w-full max-w-full message-markdown"
                  style={{ lineHeight: '1.3' }}
                >
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{a: LinkRenderer, code: CodeBlock}}
                    >
                        {streamingContent}
                    </ReactMarkdown>
                    {/* 闪烁光标 */}
                    <span 
                      className="inline-block w-0.5 h-4 bg-gray-600 ml-0.5 align-middle"
                      style={{ 
                        animation: 'cursor-blink 0.8s ease-in-out infinite',
                        verticalAlign: 'text-bottom'
                      }} 
                    />
                </div>
            </div>
        </div>
      )}

      {/* ✅ 额外渲染：不属于 userMessages，仅根据 isThinking */}
      {isThinking && !streamingContent && messages?.length > 0 && messages[messages.length - 1].role === "user" && (
        <div className="flex mb-4 justify-start">
          <div className="flex items-center justify-center px-2 py-2">
            <div className="w-3 h-3 bg-black rounded-full animate-thinking-pulse" />
          </div>
        </div>
      )}

      <div ref={messageEndRef} />
    </div>
  );
};


export default React.memo(ChatboxMessageArea);