import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useStateValue } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import { FaArrowUp, FaShareNodes, FaFile, FaStop, FaBrain, FaCamera, FaPaperclip, FaRobot } from "react-icons/fa6";
import { FiMoreHorizontal } from "react-icons/fi";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { promptSuggestion, callOpenAILib, callOpenAILibStream } from '../../utils/openai';
import { buildSystemPrompt, getBuiltinToolDefinitions, migrateFromOldSystem } from '../../utils/promptBuilder';
import { MdOutlineCancel } from "react-icons/md";
import { useMcpTools } from '../../utils/mcp/useMcpTools';
import { callLLMStreamWithTools } from '../../utils/mcp/toolExecutor';
import McpToolbar from './McpToolbar';
import SkillsToolbar from './SkillsToolbar';
import SubagentPanel from './SubagentPanel';
import CapabilityDrawer, { CapabilityTag, CapabilityToggleAction } from './CapabilityIsland';
import { buildActiveCapabilityTags, getCapabilityIslandMinWidth } from './capabilityIslandModel.js';
import { createQuickReplyRequestGate, getQuickReplySelectionAction, parseQuickReplyResponse } from './quickReplyModel.js';
import { subagentRegistry, initSubagentListeners, onSubagentChange, getActiveCount } from '../../utils/subagentManager';
import { getSubagentToolDefinition } from '../../utils/workspace/socialToolExecutor';
import * as tauri from '../../utils/tauri';
import { shouldInjectTime, buildTimeContext } from '../../utils/timeInjection';
import { listen } from '@tauri-apps/api/event';
import { normalizeApiProviders } from '../../utils/apiProviders';
import { buildSkillCatalogPrompt, createSkillToolContext, getEnabledSkills, getSkillToolDefinitions } from '../../utils/skills/index.js';
import {
  captureSubagentPermission,
  isSubagentEnabledForConversation,
  isSubagentPermissionCurrent,
  setSubagentEnabledForConversation,
} from '../../utils/subagentCapability.js';
import { shouldApplyComposerFocus } from '../../utils/chatFocusModel.js';

// ===== 模块级别全局变量 =====
// 存储 Preferences 中的默认值，所有组件实例共享
// 当 Preferences 更新时，这个值会被更新
// 新建的组件实例会读取这个值作为初始状态
let globalDefaultMemoryEnabled = true;

/**
 * 获取模型的 API 格式
 * 支持新的 apiFormat 字段和旧的 modelProvider 字段
 * @param {Object} model - 模型配置对象
 * @returns {string} - 'openai_compatible' | 'gemini_official'
 */
const getApiFormat = (model) => {
  if (!model) return 'openai_compatible';
  
  // 优先使用新字段
  if (model.apiFormat) return model.apiFormat;
  
  // 兼容旧的 modelProvider 字段
  const provider = model.modelProvider;
  if (provider === 'gemini') return 'gemini_official';
  
  // 所有其他 provider 都映射到 openai_compatible
  return 'openai_compatible';
};

/**
 * 从多 Key 字符串中轮询选取一个 Key（负载均衡）
 * 如果只有一个 Key 则直接返回。
 */
let _chatKeyRRCounter = 0;
const pickApiKey = (multiKeyStr) => {
  if (!multiKeyStr) return '';
  const keys = multiKeyStr.split('\n').map(k => k.trim()).filter(Boolean);
  if (keys.length <= 1) return keys[0] || multiKeyStr;
  const idx = (_chatKeyRRCounter++) % keys.length;
  return keys[idx];
};

/**
 * 处理历史消息中的图片路径，将文件路径转换为 base64 数据
 * 用于发送给 LLM API 之前的预处理
 * @param {Array} messages - 历史消息数组
 * @returns {Promise<Array>} - 处理后的消息数组
 */
const processMessagesForLLM = async (messages) => {
  const processedMessages = [];
  
  for (const msg of messages) {
    // 如果消息内容是字符串，直接使用
    if (typeof msg.content === 'string') {
      processedMessages.push(msg);
      continue;
    }
    
    // 如果消息内容是数组（多模态内容），需要处理每个部分
    if (Array.isArray(msg.content)) {
      const processedParts = [];
      
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          const url = part.image_url.url;
          
          // 如果已经是 base64 或 http URL，直接使用
          if (url.startsWith('data:') || url.startsWith('http')) {
            processedParts.push(part);
          } else {
            // 是文件路径，需要加载为 base64
            try {
              const fileName = url.split('/').pop();
              const base64Data = await tauri.readUpload(fileName);
              processedParts.push({
                ...part,
                image_url: { 
                  ...part.image_url,
                  url: base64Data 
                }
              });
            } catch (err) {
              console.error('[processMessagesForLLM] Failed to load image:', url, err);
              // 加载失败，转换为文本描述
              processedParts.push({
                type: 'text',
                text: `[Image could not be loaded: ${url}]`
              });
            }
          }
        } else if (part.type === 'file_url' && part.file_url?.url) {
          const url = part.file_url.url;
          
          // 如果已经是 base64 或 http URL，直接使用
          if (url.startsWith('data:') || url.startsWith('http')) {
            processedParts.push(part);
          } else {
            // 是文件路径，需要加载为 base64
            try {
              const fileName = url.split('/').pop();
              const base64Data = await tauri.readUpload(fileName);
              processedParts.push({
                ...part,
                file_url: { 
                  ...part.file_url,
                  url: base64Data 
                }
              });
            } catch (err) {
              console.error('[processMessagesForLLM] Failed to load file:', url, err);
              // 加载失败，保留原始路径（降级处理）
              processedParts.push({
                type: 'text',
                text: `[File: ${part.file_url.name || url}]`
              });
            }
          }
        } else {
          // 其他类型的 part，直接保留
          processedParts.push(part);
        }
      }
      
      processedMessages.push({
        ...msg,
        content: processedParts
      });
    } else {
      // 其他情况，直接使用
      processedMessages.push(msg);
    }
  }
  
  return processedMessages;
};

export const ChatboxInputBox = ({
  activePetId,
  autoFocus = false,
  focusRequest = null,
  compact = false,
  activeTabId,
  quickReplyEnabled = false,
  quickReplyRequest,
  onQuickReplyHandled,
  onHeightChange,
  onOverlayOpenChange,
}) => {
  const containerRef = useRef(null);
  const subagentAnchorRef = useRef(null);
  const lastPointerDownAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastHandledFocusRequestRef = useRef(0);
  // 会话 ID ref（需要先声明，供其他地方引用）
  const conversationIdRef = useRef(null);
  const quickReplyEnabledRef = useRef(Boolean(quickReplyEnabled));
  const quickReplyGateRef = useRef(null);
  const handleSendRef = useRef(null);
  const lastQuickReplyRequestIdRef = useRef(null);
  const stateValue = useStateValue();
  const [state, dispatch] = stateValue || [{}, () => {}];
  const {
    currentConversationId,
    runFromHereTimestamp,
    characterMoods = {},
    lastTimeInjection = {},
    apiProviders = [],
  } = state;
  if (quickReplyGateRef.current === null) {
    quickReplyGateRef.current = createQuickReplyRequestGate();
  }
  quickReplyEnabledRef.current = Boolean(quickReplyEnabled);

  // activeTabId is the render-time source of truth; global state catches up in
  // the same tab switch, while the ref serves only long-lived async callbacks.
  const authoritativeConversationId = activeTabId || null;
  conversationIdRef.current = authoritativeConversationId;
  
  // 按会话管理生成状态，支持多会话并行
  const [generatingConversations, setGeneratingConversations] = useState(new Set());
  // 按会话管理 AbortController，支持独立取消
  const abortControllersRef = useRef(new Map()); // Map<conversationId, AbortController>
  
  // Per-Conversation 工具栏状态
  // 记忆功能开关状态 { [conversationId]: boolean }
  const [memoryEnabledByConversation, setMemoryEnabledByConversation] = useState({});
  // Subagent 状态
  const [showSubagentPanel, setShowSubagentPanel] = useState(false);
  const [showSkillsPopover, setShowSkillsPopover] = useState(false);
  const [activeSubagentCount, setActiveSubagentCount] = useState(0);
  const [subagentEnabledByConversation, setSubagentEnabledByConversation] = useState({});
  const subagentEnabledByConversationRef = useRef({});
  const subagentCapabilityRevisionsRef = useRef({});
  const [showCapabilityDrawer, setShowCapabilityDrawer] = useState(false);
  // MCP 服务器启用状态 { [conversationId]: Set<string> }
  const [enabledMcpServersByConversation, setEnabledMcpServersByConversation] = useState({});
  // 追踪每个会话创建时的默认值（用于新 Tab 固化当时的默认值）
  // Key: conversationId, Value: 该会话创建时的默认值
  const conversationDefaultsRef = useRef({});
  
  // 获取当前会话的记忆状态
  const currentConvId = authoritativeConversationId || 'temp';
  const subagentConversationId = activeTabId || currentConvId;
  const subagentEnabled = isSubagentEnabledForConversation(
    subagentEnabledByConversation,
    subagentConversationId,
  );

  const setSubagentEnabled = (value) => {
    const conversationId = activeTabId || conversationIdRef.current || 'temp';
    const previous = subagentEnabledByConversationRef.current;
    const current = isSubagentEnabledForConversation(previous, conversationId);
    const next = typeof value === 'function' ? Boolean(value(current)) : Boolean(value);
    if (next === current) return;

    const updated = setSubagentEnabledForConversation(previous, conversationId, next);
    subagentEnabledByConversationRef.current = updated;
    const revisionKey = String(conversationId);
    subagentCapabilityRevisionsRef.current[revisionKey] =
      (subagentCapabilityRevisionsRef.current[revisionKey] || 0) + 1;
    setSubagentEnabledByConversation(updated);
  };
  
  // 获取当前会话的记忆状态
  // 逻辑：
  // 1. 如果会话有明确设置过的值（用户手动切换过），使用该值
  // 2. 否则，使用该会话创建时固化的默认值
  // 3. 如果是全新会话（没有固化过），先固化当前的全局默认值
  const getMemoryEnabledForConversation = (convId) => {
    // 如果用户明确设置过，使用设置的值
    if (convId in memoryEnabledByConversation) {
      return memoryEnabledByConversation[convId];
    }
    // 如果是已固化过默认值的会话，使用固化的值
    if (convId in conversationDefaultsRef.current) {
      return conversationDefaultsRef.current[convId];
    }
    // 全新会话：固化当前的全局默认值
    conversationDefaultsRef.current[convId] = globalDefaultMemoryEnabled;
    console.log(`[ChatboxInputBox] New conversation ${convId} initialized with memory default:`, globalDefaultMemoryEnabled);
    return globalDefaultMemoryEnabled;
  };
  
  const memoryEnabled = getMemoryEnabledForConversation(currentConvId);
  
  // 设置当前会话的记忆状态
  const setMemoryEnabled = (value) => {
    const convId = authoritativeConversationId || 'temp';
    const currentValue = getMemoryEnabledForConversation(convId);
    setMemoryEnabledByConversation(prev => ({
      ...prev,
      [convId]: typeof value === 'function' ? value(currentValue) : value
    }));
  };
  
  // 稳定的空 Set 引用，避免每次渲染创建新对象导致无限循环
  const emptySetRef = useRef(new Set());
  
  // 获取当前会话的 MCP 服务器启用状态
  // 使用 useMemo 来稳定引用
  const enabledMcpServers = useMemo(() => {
    return enabledMcpServersByConversation[currentConvId] ?? emptySetRef.current;
  }, [enabledMcpServersByConversation, currentConvId]);
  
  // 设置当前会话的 MCP 服务器启用状态
  const setEnabledMcpServers = (value) => {
    const convId = authoritativeConversationId || 'temp';
    setEnabledMcpServersByConversation(prev => ({
      ...prev,
      [convId]: typeof value === 'function' ? value(prev[convId] ?? new Set()) : value
    }));
  };

  // ============ 截图功能状态 ============
  // 截图功能现在使用独立窗口，不再需要本地选择器状态

  // 获取当前模型的 API 格式
  const [currentApiFormat, setCurrentApiFormat] = useState('openai_compatible');
  
  // MCP 工具 Hook
  const { 
    mcpServers,
    mcpTools, 
    llmTools, 
    hasTools,
    executeToolCalls,
    toolCallHistory,
    refresh: refreshMcpTools,
    refreshServers 
  } = useMcpTools({ 
    enabledServers: enabledMcpServers, 
    apiFormat: currentApiFormat 
  });

  useEffect(() => {
    if (activePetId) {
      setCharacterId(activePetId);
    }
  }, [activePetId]);

  // 新增记忆功能切换函数
  const toggleMemory = () => {
    setMemoryEnabled(prev => !prev);
    console.log(!memoryEnabled ? "记忆功能开启" : "记忆功能关闭");
  };
  
  // MCP 服务器切换函数 - 启用时自动启动服务器
  const toggleMcpServer = useCallback(async (serverName) => {
    // 查找服务器信息
    const server = mcpServers.find(s => s.name === serverName);
    
    // 检查是否要启用
    const isCurrentlyEnabled = enabledMcpServers.has(serverName);
    
    if (!isCurrentlyEnabled && server) {
      // 启用服务器：如果未运行，先自动启动
      if (!server.isRunning && server._id) {
        try {
          console.log(`[MCP] 服务器 "${serverName}" 未运行，正在自动启动...`);
          await tauri.mcp.startServer(server._id);
          // 刷新服务器列表以获取最新状态
          await refreshServers();
          console.log(`[MCP] 服务器 "${serverName}" 已自动启动`);
        } catch (err) {
          console.error(`[MCP] 自动启动服务器 "${serverName}" 失败:`, err);
          // 启动失败，不添加到启用列表
          return;
        }
      }
    }
    
    setEnabledMcpServers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(serverName)) {
        newSet.delete(serverName);
        console.log(`[MCP] 服务器 "${serverName}" 已禁用`);
      } else {
        newSet.add(serverName);
        console.log(`[MCP] 服务器 "${serverName}" 已启用`);
      }
      return newSet;
    });
  }, [mcpServers, enabledMcpServers, refreshServers]);
  
  // 按名称找到服务器记录（后端 API 需要 _id，工具栏组件只知道 name）
  const findMcpServerByName = useCallback((serverName) => {
    const server = mcpServers.find(s => s.name === serverName);
    if (!server?._id) {
      console.error(`[MCP] Server not found by name: "${serverName}"`);
      return null;
    }
    return server;
  }, [mcpServers]);

  // 更新 MCP 服务器配置 (按名称)
  const updateMcpServer = useCallback(async (serverName, updates) => {
    try {
      if (!tauri.mcp.updateServer) {
        console.error('[MCP] updateServer API not available');
        return;
      }
      const server = findMcpServerByName(serverName);
      if (!server) return;
      await tauri.mcp.updateServer(server._id, updates);
      await refreshServers();
      console.log(`[MCP] 服务器 "${serverName}" 配置已更新:`, updates);
    } catch (err) {
      console.error('[MCP] Failed to update server:', err);
    }
  }, [refreshServers, findMcpServerByName]);

  // 批量更新 MCP 服务器顺序
  const batchUpdateMcpOrder = useCallback(async (orderList) => {
    // orderList: [{ name: 'xxx', toolbarOrder: 0 }, ...]
    try {
      for (const item of orderList) {
        const server = findMcpServerByName(item.name);
        if (server && tauri.mcp.updateServer) {
          await tauri.mcp.updateServer(server._id, { toolbarOrder: item.toolbarOrder });
        }
      }
      await refreshServers();
      console.log('[MCP] 服务器顺序已更新');
    } catch (err) {
      console.error('[MCP] Failed to batch update order:', err);
    }
  }, [refreshServers, findMcpServerByName]);

  // 删除 MCP 服务器 (按名称)
  const deleteMcpServer = useCallback(async (serverName) => {
    try {
      if (!tauri.mcp.deleteServer) {
        console.error('[MCP] deleteServer API not available');
        return;
      }
      const server = findMcpServerByName(serverName);
      if (!server) return;
      // 从启用列表中移除
      setEnabledMcpServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(serverName);
        return newSet;
      });
      await tauri.mcp.deleteServer(server._id);
      await refreshServers();
      console.log(`[MCP] 服务器 "${serverName}" 已删除`);
    } catch (err) {
      console.error('[MCP] Failed to delete server:', err);
    }
  }, [refreshServers, findMcpServerByName]);
  
  // 编辑 MCP 服务器图标 (打开 MCP 设置窗口)
  const editMcpServerIcon = useCallback((server) => {
    // TODO: 打开图标选择器或跳转到设置页面
    console.log('[MCP] Edit icon for server:', server.name);
    // 可以通过 IPC 打开 MCP 设置窗口
    tauri.openMcpSettings();
  }, []);

  // ============ 截图功能 ============
  
  // 截图按钮点击处理 - 调用系统截图，Rust端会自动显示选择器窗口
  const handleScreenshot = useCallback(async () => {
    try {
      console.log('[Screenshot] Starting screenshot...');
      await tauri.takeScreenshot();
      // 截图完成后，Rust端会自动打开 screenshot-prompt 窗口
      // 用户选择后会通过 screenshot-with-prompt 事件发送结果
    } catch (err) {
      if (err.includes?.('cancelled') || err === 'Screenshot cancelled by user') {
        console.log('[Screenshot] Cancelled by user');
      } else {
        console.error('[Screenshot] Failed:', err);
      }
    }
  }, []);

  // 待注入的截图数据（用于 newTab 场景）
  const pendingScreenshotRef = useRef(null);

  // 当 activeTabId 变化时，检查是否有待注入的截图
  useEffect(() => {
    if (!activeTabId || !pendingScreenshotRef.current) return;
    
    const { screenshot, prompt } = pendingScreenshotRef.current;
    pendingScreenshotRef.current = null;
    
    // 延迟注入，确保新 Tab 已完全初始化
    setTimeout(() => {
      setAttachments(prev => [...prev, {
        type: 'image_url',
        url: screenshot.data,
        path: screenshot.path,
        name: screenshot.name,
        mime_type: 'image/png',
        data: screenshot.data
      }]);
      
      if (prompt) {
        setUserText(prompt);
        setTimeout(() => {
          if (inputRef.current) {
            const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
            inputRef.current.dispatchEvent(enterEvent);
          }
        }, 150);
      } else {
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    }, 300);
  }, [activeTabId]);

  // 监听截图选择结果事件
  useEffect(() => {
    let unlisten = null;
    let cancelled = false;
    
    const setup = async () => {
      const unlistenFn = await listen('screenshot-with-prompt', (event) => {
        const { prompt, promptName, screenshot, newTab } = event.payload;
        console.log('[Screenshot] Received selection:', promptName || 'Direct send', newTab ? '(new tab)' : '');
        
        if (!screenshot) return;
        
        if (newTab) {
          // 新 Tab 模式：存储待注入数据，然后触发新 Tab 创建
          pendingScreenshotRef.current = { screenshot, prompt };
          
          // 触发新 Tab 创建（复用当前 Tab 的 petId）
          const petId = activePetId;
          if (petId) {
            tauri.sendCharacterId(petId);
          }
          return;
        }
        
        // 当前 Tab 模式
        setAttachments(prev => [...prev, {
          type: 'image_url',
          url: screenshot.data,
          path: screenshot.path,
          name: screenshot.name,
          mime_type: 'image/png',
          data: screenshot.data
        }]);
        
        if (prompt) {
          setUserText(prompt);
          setTimeout(() => {
            if (inputRef.current) {
              const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
              inputRef.current.dispatchEvent(enterEvent);
            }
          }, 100);
        } else {
          setTimeout(() => {
            inputRef.current?.focus();
          }, 50);
        }
      });
      
      if (cancelled) {
        unlistenFn();
      } else {
        unlisten = unlistenFn;
      }
    };
    
    setup();
    
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activePetId]);

  // 修改后的：点击按钮时复制对话内容
  const handleShare = () => {
    const conversationText = userMessages
      .map(msg =>
        msg.role === "assistant" && petInfo && petInfo.name
          ? `${petInfo.name}: ${msg.content}`
          : `${msg.role}: ${msg.content}`
      )
      .join('\n');
    navigator.clipboard.writeText(conversationText)
      .then(() => {
        alert("Conversation copied to clipboard");
      })
      .catch((err) => {
        console.error("Failed to copy conversation: ", err);
      });
  };

  const inputRef = useRef(null);

  useEffect(() => {
    quickReplyGateRef.current.settingsChanged();
    if (!quickReplyEnabled) {
      dispatch({ type: actionType.CLEAR_SUGGEST_TEXTS });
    }
  }, [quickReplyEnabled, dispatch]);
  
  // 兼容性：当前会话是否在生成
  // 使用 currentConversationId（来自 state）而不是 conversationIdRef.current
  // 这样当 Tab 切换时，isGenerating 会随着 currentConversationId 的变化而重新计算
  const isGenerating = generatingConversations.has(authoritativeConversationId) ||
                       generatingConversations.has('temp');
  
  // 发送/暂停按钮切换动画状态
  const [buttonAnimating, setButtonAnimating] = useState(false);
  const prevIsGeneratingRef = useRef(isGenerating);
  
  // 监听 isGenerating 变化，触发动画
  useEffect(() => {
    if (prevIsGeneratingRef.current !== isGenerating) {
      setButtonAnimating(true);
      const timer = setTimeout(() => setButtonAnimating(false), 100);
      prevIsGeneratingRef.current = isGenerating;
      return () => clearTimeout(timer);
    }
  }, [isGenerating]);
  
  // 本地消息状态 - 从 Rust TabState 加载
  const [messageSnapshot, setMessageSnapshot] = useState({
    conversationId: null,
    messages: [],
  });
  const userMessages = messageSnapshot.conversationId === authoritativeConversationId
    ? messageSnapshot.messages
    : [];
  
  // 新方案: 使用 Rust TabState 订阅
  useEffect(() => {
    const targetConversationId = authoritativeConversationId;
    if (!targetConversationId) {
      setMessageSnapshot({ conversationId: null, messages: [] });
      return;
    }

    setMessageSnapshot({ conversationId: targetConversationId, messages: [] });
    let unlisten = null;
    let isMounted = true;
    let eventCount = 0;

    const setup = async () => {
      // Subscribe before reading so an update cannot fall into the gap.
      unlisten = await tauri.subscribeTabState(targetConversationId, (newState) => {
        eventCount += 1;
        if (isMounted) {
          setMessageSnapshot({
            conversationId: targetConversationId,
            messages: newState.messages || [],
          });
        }
      });
      if (!isMounted) {
        unlisten?.();
        unlisten = null;
        return;
      }

      // 获取初始状态
      const initialState = await tauri.getTabState(targetConversationId);
      
      // 如果 Rust 缓存为空，从数据库加载并初始化
      if (!initialState.messages || initialState.messages.length === 0) {
        console.log('[ChatboxInputBox] Cache empty, loading from database:', targetConversationId);
        const conversation = await tauri.getConversationWithHistory(targetConversationId);
        if (conversation && conversation.history && conversation.history.length > 0) {
          // 初始化 Rust TabState
          await tauri.initTabMessages(targetConversationId, conversation.history);
        } else if (isMounted && eventCount === 0) {
          setMessageSnapshot({ conversationId: targetConversationId, messages: [] });
        }
      } else if (isMounted && eventCount === 0) {
        setMessageSnapshot({
          conversationId: targetConversationId,
          messages: initialState.messages,
        });
      }
    };
    setup().catch(error => {
      if (!isMounted) return;
      console.error('[ChatboxInputBox] Failed to load active tab state:', error);
      setMessageSnapshot({ conversationId: targetConversationId, messages: [] });
    });
    
    return () => {
      isMounted = false;
      if (unlisten) unlisten();
    };
  }, [authoritativeConversationId]);
  
  // 临时覆盖模型（仅当前会话有效，不保存到数据库）
  const [overrideModel, setOverrideModel] = useState(null);
  // 模型选择器菜单显示状态
  const [showModelSelector, setShowModelSelector] = useState(false);
  
  // 监听跨窗口的 API providers 更新事件
  useEffect(() => {
    const unlisten = tauri.onApiProvidersUpdated(async (updatedProviders) => {
      console.log('[ChatboxInputBox] Received api-providers-updated event:', updatedProviders);
      if (!dispatch) return;
      try {
        const providers = Array.isArray(updatedProviders)
          ? updatedProviders
          : await tauri.getApiProviders();
        dispatch({
          type: actionType.SET_API_PROVIDERS,
          apiProviders: normalizeApiProviders(providers)
        });
      } catch (error) {
        console.error('[ChatboxInputBox] Failed to refresh API providers:', error);
      }
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [dispatch]);
  
  // 监听设置更新事件，当 Preferences 保存时更新默认值（仅影响之后新建的 Tab）
  useEffect(() => {
    const unlisten = tauri.onSettingsUpdated((payload) => {
      console.log('[ChatboxInputBox] Settings updated:', payload);
      if (payload?.key === 'memoryEnabledByDefault') {
        const newDefault = payload.value !== false && payload.value !== "false";
        // 更新模块级别全局变量，不触发当前组件重渲染
        // 只有之后新建的组件实例才会读取这个新值
        globalDefaultMemoryEnabled = newDefault;
        console.log('[ChatboxInputBox] Global default memory enabled updated to:', newDefault, '(only affects future tabs)');
      }
      if (payload?.key === 'chatFollowsCharacter') {
        const chatFollows = payload.value !== false && payload.value !== "false";
        tauri.updatePreferences({ chatFollowsCharacter: chatFollows });
      }
      if (payload?.key === 'quickReplyEnabled') {
        const enabled = payload.value !== false && payload.value !== "false";
        quickReplyEnabledRef.current = enabled;
        quickReplyGateRef.current.settingsChanged();
        if (!enabled) {
          dispatch({ type: actionType.CLEAR_SUGGEST_TEXTS });
        }
      }
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [dispatch]);
  
  // 计算可见模型列表（当 apiProviders 变化时自动更新）
  const visibleModelsByProvider = useMemo(() => {
    console.log('[ChatboxInputBox] Computing visibleModelsByProvider, apiProviders:', apiProviders);
    // 确保 apiProviders 是数组
    if (!Array.isArray(apiProviders)) {
      console.warn('[ChatboxInputBox] apiProviders is not an array:', apiProviders);
      return [];
    }
    return normalizeApiProviders(apiProviders).map(provider => {
      const models = provider.cachedModels || [];
      const hiddenModels = provider.hiddenModels || [];
      const visibleModels = models.filter(model => {
        const modelName = typeof model === 'string' ? model : model.name;
        return !hiddenModels.includes(modelName);
      }).sort((a, b) => {
        const na = typeof a === 'string' ? a : a.name;
        const nb = typeof b === 'string' ? b : b.name;
        return na.localeCompare(nb);
      });
      return {
        ...provider,
        visibleModels
      };
    }).filter(p => p.visibleModels.length > 0);
  }, [apiProviders]);

  // console.log('[ChatboxInputBox] userMessages:', userMessages);
  // 将 userText 从全局状态中移除，改为本地状态管理
  const [userText, setUserText] = useState("");
  const [characterId, setCharacterId] = useState(null);
  const [petInfo, setPetInfo] = useState(null);
  const capabilityPetId = activePetId || petInfo?._id;
  const assistantContextReady = Boolean(
    activePetId
    && petInfo?._id
    && String(activePetId) === String(petInfo._id)
  );
  const [activeModelConfig, setActiveModelConfig] = useState(null);
  const [functionModelInfo, setFunctionModelInfo] = useState(null);
  const [imageModelInfo, setImageModelInfo] = useState(null);
  const composingRef = useRef(false);
  const ignoreEnterRef = useRef(false);
  const [founctionModel, setFounctionModel] = useState(null);
  const [system, setSystem] = useState(null);
  const [firstCharacter, setFirstCharacter] = useState(null)

  // Reset transient popovers when the active Assistant changes. Skills now stay
  // mounted in the compact row and keep their own count synchronized.
  useEffect(() => {
    setShowCapabilityDrawer(false);
    setShowSubagentPanel(false);
    setShowModelSelector(false);
  }, [capabilityPetId]);

  // 启动时加载默认角色ID和偏好设置
  useEffect(() => {
    setSystem(window.navigator.platform);
    const loadDefaultCharacter = async () => {
      const settings = await tauri.getSettings();
      console.log("[ChatboxInputBox] All settings loaded:", settings);
      let defaultAssistantFound = false;
      
      // 加载记忆功能的默认设置
      if (settings) {
        // 明确检查是否为 false，其他情况（包括 undefined、true、"true"）都视为 true
        const memoryDefault = settings.memoryEnabledByDefault !== false && settings.memoryEnabledByDefault !== "false";
        // 更新模块级别全局变量
        globalDefaultMemoryEnabled = memoryDefault;
        console.log("[ChatboxInputBox] Memory default loaded from DB:", memoryDefault);
        
        // 同步 chatFollowsCharacter 到 Rust 后端
        const chatFollows = settings.chatFollowsCharacter !== false && settings.chatFollowsCharacter !== "false";
        tauri.updatePreferences({ chatFollowsCharacter: chatFollows });
      }
      
      try {
        if (settings && settings.defaultRoleId) {
          // 验证ID是否有效（优先尝试 getAssistant，然后回退到 getPet）
          try {
            let pet = null;
            try {
              pet = await tauri.getAssistant(settings.defaultRoleId);
            } catch (e) {
              // 忽略，尝试旧 API
            }
            if (!pet) {
              pet = await tauri.getPet(settings.defaultRoleId);
            }
            if (pet) {
              setFirstCharacter(settings.defaultRoleId);
              defaultAssistantFound = true;
              console.log("[ChatboxInputBox] Default assistant loaded:", pet.name);
            } else {
              console.log("Default character ID not found in database, will use fallback");
            }
          } catch (petError) {
            console.error("Error finding pet with default ID:", petError);
          }
        }
        
        // 如果没有设置默认助手或者默认助手无效，使用第一个可用的助手
        if (!defaultAssistantFound) {
          try {
            const assistants = await tauri.getAssistants();
            if (assistants && assistants.length > 0) {
              const firstAssistant = assistants[0];
              setFirstCharacter(firstAssistant._id);
              console.log("[ChatboxInputBox] Fallback to first assistant:", firstAssistant.name);
            } else {
              // 尝试获取 pets 作为后备
              const pets = await tauri.getPets();
              if (pets && pets.length > 0) {
                const firstPet = pets[0];
                setFirstCharacter(firstPet._id);
                console.log("[ChatboxInputBox] Fallback to first pet:", firstPet.name);
              } else {
                console.log("[ChatboxInputBox] No assistants or pets available");
              }
            }
          } catch (fallbackError) {
            console.error("Error loading fallback assistant:", fallbackError);
          }
        }
      } catch (error) {
        console.error("Error loading default character ID from settings:", error);
      }

      // 加载图像生成模型配置（generate_image 工具用）
      try {
        if (settings && settings.imageModelProviderId && settings.imageModelName) {
          const providers = await tauri.getApiProviders();
          if (Array.isArray(providers)) {
            const provider = providers.find(p => p._id === settings.imageModelProviderId);
            if (provider) {
              setImageModelInfo({
                modelName: settings.imageModelName,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
              });
            } else {
              setImageModelInfo(null);
            }
          }
        } else {
          setImageModelInfo(null);
        }
      } catch (e) {
        console.error('Error loading image model from settings:', e);
        setImageModelInfo(null);
      }

      // 加载默认功能模型
      try {
        if (settings && settings.functionModelProviderId && settings.functionModelName) {
          // 从 API providers 中获取配置
          const providers = await tauri.getApiProviders();
          if (Array.isArray(providers)) {
            const provider = providers.find(p => p._id === settings.functionModelProviderId);
            if (provider) {
              console.log("[ChatboxInputBox] Default function model loaded:", provider.name, settings.functionModelName);
              setFunctionModelInfo({
                modelName: settings.functionModelName,
                modelUrl: provider.baseUrl,
                modelApiKey: provider.apiKey,
                apiFormat: provider.apiFormat || 'openai_compatible',
                modelProvider: provider.name,
                _sourceId: provider._id
              });
            } else {
              console.log("Function model provider not found:", settings.functionModelProviderId);
              setFunctionModelInfo(null);
            }
          }
        } else if (settings && settings.defaultModelId) {
          // 向后兼容：如果使用旧的 defaultModelId 配置，仍然支持
          try {
            let pet = null;
            try {
              pet = await tauri.getAssistant(settings.defaultModelId);
            } catch (e) {
              // 忽略，尝试旧 API
            }
            if (!pet) {
              pet = await tauri.getPet(settings.defaultModelId);
            }
            if (pet) {
              setFounctionModel(settings.defaultModelId);
              console.log("[ChatboxInputBox] Default function model loaded (legacy):", pet.name);
              const { _id, name, modelName, modelApiKey, modelProvider, modelUrl, apiFormat } = pet;
              const systemInstruction = pet.systemInstruction || pet.personality || '';
              setFunctionModelInfo({ _id, name, modelName, systemInstruction, modelApiKey, modelProvider, modelUrl, apiFormat });
            } else {
              console.log("Default model ID not found in database, using null");
              setFunctionModelInfo(null);
            }
          } catch (petError) {
            console.error("Error finding pet with default model ID:", petError);
            setFunctionModelInfo(null);
          }
        }
      } catch (error) {
        console.error("Error loading default model from settings:", error);
        setFunctionModelInfo(null);
      }
    };
      
    loadDefaultCharacter();
  }, []); // 只在组件加载时执行一次

  // 当 firstCharacter 改变时，直接设置 characterId，不发送事件
  // 事件发送由 ChatboxBody 负责
  useEffect(() => {
    // The active tab owns Assistant selection once it exists. A slower default
    // Assistant lookup must never overwrite that live tab context.
    if (firstCharacter != null && !activePetId) {
      // 直接设置本地状态，不发送事件避免循环
      setCharacterId(firstCharacter);
    }
  }, [activePetId, firstCharacter]);
  

  // 监听角色 ID
  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("📩 Received character ID:", id);
      setCharacterId(id);
    };
    const cleanup = tauri.onCharacterId(handleCharacterId);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 加载角色信息，并清理或保留对话历史
  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;

    const fetchPetInfo = async () => {
      try {
        // 首先尝试从新的 Assistant API 获取
        let assistant = await tauri.getAssistant(characterId);
        if (cancelled) return;
        let modelConfig = null;
        
        if (assistant && assistant.modelConfigId) {
          // 新数据模型：从关联的 ModelConfig 获取 API 配置
          modelConfig = await tauri.getModelConfig(assistant.modelConfigId);
          if (cancelled) return;
        }

        setActiveModelConfig(modelConfig);
        
        // 如果新 API 没有数据，回退到旧的 Pet API（向后兼容）
        if (!assistant) {
          assistant = await tauri.getPet(characterId);
          if (cancelled) return;
        }
        
        if (assistant) {
          const { _id, name, hasMood, isAgent, imageName } = assistant;
          // 向后兼容：优先使用 systemInstruction，fallback 到 personality
          const systemInstruction = assistant.systemInstruction || assistant.personality || '';
          // hasMood 向后兼容：如果没设置 hasMood，则根据 !isAgent 判断
          const computedHasMood = typeof hasMood === 'boolean' ? hasMood : !isAgent;
          
          // 从 ModelConfig 获取 API 配置，如果没有则从 assistant 本身获取（兼容旧数据）
          const apiConfig = modelConfig || assistant;
          const { modelName, modelApiKey, modelUrl, apiFormat, modelProvider } = apiConfig;
          
          setPetInfo({ 
            _id, 
            name, 
            modelName, 
            systemInstruction, 
            modelApiKey, 
            modelProvider, 
            modelUrl, 
            apiFormat, 
            hasMood: computedHasMood
          });
          
          // 更新当前 API 格式，用于 MCP 工具转换
          setCurrentApiFormat(getApiFormat(apiConfig));
          
          // 确保工作区默认文件存在（SOUL.md, USER.md）并迁移旧数据
          try {
            await migrateFromOldSystem(
              assistant._id || characterId,
              assistant.name || 'Pet',
              assistant.systemInstruction || assistant.personality || '',
              assistant.userMemory || ''
            );
          } catch (wsError) {
            console.error("初始化工作区文件失败:", wsError);
          }
        } else {
          console.error("Pet not found for ID:", characterId);
          if (!cancelled) setCharacterId(null);
          return;
        }

        // 注意：不再在此处清空 conversationIdRef.current
        // 原因：侧边栏切换 assistant 时，transferConversation 已更新数据库的 pet_id，
        // 但 fetchPetInfo 的异步操作可能与 transferConversation 产生竞态条件，
        // 导致 conversationIdRef.current 被错误清空，后续消息无法保存到正确的对话。
        // Tab 系统已通过 currentConversationId + sync effect 管理活跃对话 ID，
        // 无需在此处重复管理。
      } catch (error) {
        if (cancelled) return;
        console.error("Error fetching pet info:", error);
        // 不要在错误时设置 characterId 为 null，这可能导致循环
        // setCharacterId(null);
      }
    };

    fetchPetInfo();
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  // Completed subagent notifications (chat-source only)
  const [subagentNotifications, setSubagentNotifications] = useState([]);
  const [expandedNotification, setExpandedNotification] = useState(null);

  // Subscribe to subagent changes
  useEffect(() => {
    const refreshActiveCount = () => {
      setActiveSubagentCount(activeTabId
        ? getActiveCount({ source: 'chat', conversationId: activeTabId })
        : 0);
    };
    refreshActiveCount();

    const unsub = onSubagentChange((eventType, payload) => {
      refreshActiveCount();
      // When a chat-source subagent finishes, add notification
      if (payload?.entry?.source === 'chat' && (eventType === 'done' || eventType === 'timeout' || eventType === 'error')) {
        setSubagentNotifications(prev => [...prev.filter(item => item.taskId !== payload.taskId), {
          taskId: payload.taskId,
          conversationId: payload.entry.conversationId || null,
          task: payload.entry.task,
          status: payload.entry.status,
          result: payload.entry.result || null,
          error: payload.entry.error || null,
          timestamp: Date.now(),
        }]);
      }
    });
    return unsub;
  }, [activeTabId]);

  // Initialize subagent listeners when petInfo is available
  useEffect(() => {
    if (petInfo?._id) {
      initSubagentListeners({ petId: petInfo._id, addLog: null, wakeIntent: null });
    }
  }, [petInfo]);

  // 监听助手更新事件，当当前助手被修改时重新加载 petInfo
  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    let requestGeneration = 0;

    const handlePetsUpdate = async (event) => {
      // event 结构: { action: 'update', type: 'assistant', id, data }
      console.log("[ChatboxInputBox] Received pets update:", event);
      
      // 如果更新的是当前正在使用的助手，重新加载其信息
      if (event && (event.id === characterId || event._id === characterId)) {
        console.log("[ChatboxInputBox] Current assistant updated, reloading petInfo...");
        const generation = ++requestGeneration;
        
        try {
          let assistant = await tauri.getAssistant(characterId);
          if (cancelled || generation !== requestGeneration) return;
          let modelConfig = null;
          
          if (assistant && assistant.modelConfigId) {
            modelConfig = await tauri.getModelConfig(assistant.modelConfigId);
            if (cancelled || generation !== requestGeneration) return;
          }
          
          setActiveModelConfig(modelConfig);
          
          if (!assistant) {
            assistant = await tauri.getPet(characterId);
            if (cancelled || generation !== requestGeneration) return;
          }
          
          if (assistant) {
            const { _id, name, hasMood, isAgent, imageName } = assistant;
            const systemInstruction = assistant.systemInstruction || assistant.personality || '';
            const computedHasMood = typeof hasMood === 'boolean' ? hasMood : !isAgent;
            
            const apiConfig = modelConfig || assistant;
            const { modelName, modelApiKey, modelUrl, apiFormat, modelProvider } = apiConfig;
            
            setPetInfo({ 
              _id, 
              name, 
              modelName, 
              systemInstruction, 
              modelApiKey, 
              modelProvider, 
              modelUrl, 
              apiFormat, 
              hasMood: computedHasMood
            });
            
            setCurrentApiFormat(getApiFormat(apiConfig));
            console.log("[ChatboxInputBox] petInfo reloaded with new modelName:", modelName);
          }
        } catch (error) {
          if (cancelled || generation !== requestGeneration) return;
          console.error("[ChatboxInputBox] Error reloading petInfo:", error);
        }
      }
    };

    let cleanup;
    if (tauri.onPetsUpdated) {
      cleanup = tauri.onPetsUpdated(handlePetsUpdate);
    }

    return () => {
      cancelled = true;
      requestGeneration += 1;
      if (cleanup) cleanup();
    };
  }, [characterId]);

  useEffect(() => {
    const handleNewChat = () => {
      dispatch({ type: actionType.SET_MESSAGE, userMessages: [] });
      conversationIdRef.current = null;
    };

    // 注册监听器
    let cleanup;
    if (tauri.onNewChatCreated) {
      cleanup = tauri.onNewChatCreated(handleNewChat);
    }

    // 卸载时清理监听器，避免内存泄漏
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const handleChange = (e) => {
    const nextText = e.target.value;
    if (!String(userText).trim() && String(nextText).trim() && authoritativeConversationId) {
      quickReplyGateRef.current.invalidateConversation(authoritativeConversationId);
      dispatch({
        type: actionType.SET_SUGGEST_TEXT,
        suggestText: [],
        conversationId: authoritativeConversationId,
      });
    }
    setUserText(nextText);
  };

  // 中文/日文输入法事件
  const handleCompositionStart = () => {
    composingRef.current = true;
  };
  const handleCompositionEnd = () => {
    composingRef.current = false;
    ignoreEnterRef.current = true;
    setTimeout(() => {
      ignoreEnterRef.current = false;
    }, 50);
  };

  // 自动调整 textarea 高度（最大200px）
  const autoResize = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const newHeight = Math.min(inputRef.current.scrollHeight, 200);
      inputRef.current.style.height = newHeight + 'px';
    }
  }, []);

  // 当 userText 变化时自动调整高度（特别是清空时重置高度）
  useEffect(() => {
    autoResize();
  }, [userText, autoResize]);

  // 获取当前会话的表情 - 使用 currentConversationId 确保切换 tab 后立即更新
  const currentMood = characterMoods?.[authoritativeConversationId] || 'normal';

  // 回车发送
  const handleKeyDown = (e) => {
    if (composingRef.current || ignoreEnterRef.current) return;
    if (e.key === "Enter" && !e.shiftKey && currentMood != "thinking" && String(userText).trim()) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    const moodUpdateHandler = (event, updatedMood, targetConversationId) => {
      console.log("Received updated mood:", updatedMood, "for conversation:", targetConversationId);
      // 更新全局状态中对应会话的表情
      dispatch({
        type: actionType.SET_CHARACTER_MOOD,
        characterMood: updatedMood,
        conversationId: targetConversationId || conversationIdRef.current || 'global'
      });
    };
    const cleanup = tauri.onMoodUpdated?.(moodUpdateHandler);

    // 组件卸载时移除监听
    return () => {
      if (cleanup) cleanup();
    };
  }, [dispatch]);

  

  // 注入 subagent 结果到对话
  const handleInjectSubagentResult = useCallback((notification) => {
    const resultText = notification.status === 'done' && notification.result
      ? notification.result
      : notification.status === 'timeout'
      ? `（后台任务超时：${notification.task}）`
      : `（后台任务失败：${notification.error || '未知错误'}）`;

    const injectMsg = `[后台研究结果] 任务：${notification.task}\n\n${resultText}`;
    setUserText(injectMsg);
    // Remove this notification
    setSubagentNotifications(prev => prev.filter(n => n.taskId !== notification.taskId));
    setExpandedNotification(null);
  }, []);

  const handleDismissNotification = useCallback((taskId) => {
    setSubagentNotifications(prev => prev.filter(n => n.taskId !== taskId));
    if (expandedNotification === taskId) setExpandedNotification(null);
  }, [expandedNotification]);

  // 发送消息
  const handleSend = async (
    textOverride = null,
    conversationIdOverride = null,
    { includeAttachments = true, clearComposer = true } = {},
  ) => {
    let reply = null;
    let thisModel = null;
    let _userText = null;
    const conversationContextReady = Boolean(
      authoritativeConversationId
      && String(currentConversationId || '') === String(authoritativeConversationId)
    );
    if (!characterId || !assistantContextReady || !conversationContextReady) {
      console.warn('[handleSend] Assistant context is still loading for the active tab.');
      return;
    }

    // Lock Subagent permission before the first await. A later off → on toggle
    // must not grant this already-started request a fresh capability token.
    const subagentConversationIdAtSend = conversationIdOverride || authoritativeConversationId || 'temp';
    const subagentPermission = captureSubagentPermission(
      subagentEnabledByConversationRef.current,
      subagentCapabilityRevisionsRef.current,
      subagentConversationIdAtSend,
    );
    
    // 重置 MCP 取消状态（开始新的对话）
    try {
      if (tauri.mcp?.resetCancellation) {
        await tauri.mcp.resetCancellation();
      }
    } catch (err) {
      console.warn('[handleSend] Failed to reset MCP cancellation:', err);
    }

    let isRunFromHere = false;
    let currentInputText = typeof textOverride === 'string' ? textOverride : userText;
    const messageAttachments = includeAttachments ? attachments : [];
    let runFromHereContent = null; // Store original multimodal content for re-run

    // 检查是否有内容可发送（文字或附件）
    const hasText = currentInputText.trim().length > 0;
    const hasAttachments = messageAttachments.length > 0;

    if (!hasText && !hasAttachments) {
        // 没有文字也没有附件，检查是否是重新生成
        if (userMessages.length > 0 && userMessages[userMessages.length - 1].role === 'user') {
            isRunFromHere = true;
            const lastMsg = userMessages[userMessages.length - 1];
            // Preserve original content structure for multimodal
            runFromHereContent = lastMsg.content;
            // Extract text for _userText (used for memory/search)
            if (typeof lastMsg.content === 'string') {
                currentInputText = lastMsg.content;
            } else if (Array.isArray(lastMsg.content)) {
                currentInputText = lastMsg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
            } else {
                currentInputText = JSON.stringify(lastMsg.content);
            }
        } else {
            return;
        }
    }

    // 🔒 锁定当前对话 ID，防止在等待 AI 回复期间切换标签导致数据错乱
    let sendingConversationId = subagentConversationIdAtSend;
    // 保存初始 ID 用于状态清理（因为 sendingConversationId 后面可能会变）
    const initialConversationId = sendingConversationId;
    quickReplyGateRef.current.invalidateConversation(sendingConversationId);
    console.log('[handleSend] ★ sendingConversationId:', sendingConversationId, 'conversationIdRef:', conversationIdRef.current, 'currentConversationId:', currentConversationId);
    
    // 标记该会话正在生成
    setGeneratingConversations(prev => new Set(prev).add(initialConversationId));

    _userText = currentInputText;
    
    // Construct display content (for saving to DB - uses file paths)
    // and LLM content (for sending to AI - uses base64 data)
    let displayContent;
    let llmContent;  // Content with base64 data for LLM
    
    if (isRunFromHere) {
        // Use original content from history
        displayContent = runFromHereContent;
        // RunFromHere content may contain file paths, need to process for LLM
        // We'll process it later with processMessagesForLLM
        llmContent = runFromHereContent;
    } else if (messageAttachments.length > 0) {
        // displayContent uses file paths (for persistence/display)
        displayContent = [{ type: "text", text: _userText }];
        // llmContent uses base64 data (for sending to LLM)
        llmContent = [{ type: "text", text: _userText }];
        
        messageAttachments.forEach(att => {
            if (att.type === 'image_url') {
                // Display: use saved file path for persistence
                displayContent.push({ 
                    type: 'image_url', 
                    image_url: { url: att.path },
                    mime_type: att.mime_type 
                });
                // LLM: use base64 data for actual content
                llmContent.push({ 
                    type: 'image_url', 
                    image_url: { url: att.data || att.url },
                    mime_type: att.mime_type 
                });
            } else {
                // For video/audio/documents
                // Display: use file path
                displayContent.push({ 
                    type: 'file_url', 
                    file_url: { 
                        url: att.path, 
                        mime_type: att.mime_type,
                        name: att.name 
                    }
                });
                // LLM: use base64 data
                llmContent.push({ 
                    type: 'file_url', 
                    file_url: { 
                        url: att.data || att.url,
                        mime_type: att.mime_type,
                        name: att.name 
                    }
                });
            }
        });
    } else {
        displayContent = _userText;
        llmContent = _userText;
    }

    if (clearComposer) setUserText("");
    dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [], conversationId: sendingConversationId });

    // 【重要】在添加用户消息之前，先记录当前消息数量
    // 这是因为后续 historyMessages 是从 Rust TabState 获取的，
    // 而那时用户消息已经被 pushTabMessage 添加进去了。
    // 所以我们需要在 pushTabMessage 之前保存消息数量，
    // 用于后续判断是否是对话的第一条消息（以便设置对话标题）。
    let messageCountBeforeUserMsg = 0;
    if (sendingConversationId) {
      const currentState = await tauri.getTabState(sendingConversationId);
      messageCountBeforeUserMsg = currentState.messages?.length || 0;
    }

    // 新方案: 使用 Rust TabState 添加用户消息
    const userMsg = { role: "user", content: displayContent, createdAt: new Date().toISOString() };
    if (!isRunFromHere && sendingConversationId) {
      console.log('[ChatboxInputBox] Adding user message to Rust TabState');
      await tauri.pushTabMessage(sendingConversationId, userMsg);
    }

    // 新方案: 使用 TabState 设置思考状态
    if (sendingConversationId) {
      await tauri.setTabThinking(sendingConversationId, true);
    }
    // 同时更新角色窗口的 mood 动画
    tauri.sendMoodUpdate('thinking', initialConversationId);

    if (clearComposer && inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = 'auto';
    }

    try {
    let fullMessages = [];
    const isDefaultPersonality = petInfo?.systemInstruction &&
      (petInfo.systemInstruction.trim().toLowerCase() === "default model (english)" ||
       petInfo.systemInstruction.trim().toLowerCase() === "default");

    // 新方案: 从 Rust TabState 获取最新消息
    const tabState = await tauri.getTabState(sendingConversationId);
    const latestMessages = tabState.messages || [];
    // 排除最后一条消息（当前用户消息，因为它使用的是 displayContent/文件路径）
    // 我们将用 llmContent（base64 数据）版本替代它
    const rawHistoryMessages = isRunFromHere 
        ? latestMessages.slice(0, -1)  // RunFromHere: 排除最后一条
        : latestMessages.slice(0, -1); // 普通发送: 也排除最后一条（刚添加的 displayContent 版本）
    
    // 处理历史消息中的图片路径，将文件路径转换为 base64 数据
    const historyMessages = await processMessagesForLLM(rawHistoryMessages);

    // 确定使用哪个模型：优先级 overrideModel > (isDefaultPersonality ? functionModelInfo : petInfo)
    if (overrideModel) {
      thisModel = overrideModel;
    } else if (isDefaultPersonality && functionModelInfo) {
      thisModel = functionModelInfo;
    } else {
      thisModel = petInfo;
    }

      // Use llmContent (with base64 data) for sending to LLM
      // If llmContent is an array (multimodal), process it to ensure all images are base64
      let content = llmContent;
      if (Array.isArray(content)) {
        // Process the current message content as well (for RunFromHere case)
        const processedContent = await processMessagesForLLM([{ role: 'user', content }]);
        content = processedContent[0]?.content || content;
      }

      if (messageAttachments.length > 0) {
          setAttachments([]);
      }

      // ── 每条 user 消息注入时间戳 ──
      // 历史消息：用 createdAt（来自 TabState / 数据库）
      // 当前消息：用 Date.now()
      const _fmtTime = (isoStr) => {
        try {
          const d = new Date(isoStr);
          if (isNaN(d.getTime())) return '';
          return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch { return ''; }
      };
      const _prependTimestamp = (msg) => {
        if (msg.role !== 'user') return msg;
        const ts = msg.createdAt ? _fmtTime(msg.createdAt) : '';
        if (!ts) return msg;
        // 文字消息：直接加前缀；多模态消息：只改第一个 text part
        if (typeof msg.content === 'string') {
          return { ...msg, content: `[${ts}]\n${msg.content}` };
        }
        if (Array.isArray(msg.content)) {
          const parts = [...msg.content];
          const textIdx = parts.findIndex(p => p.type === 'text');
          if (textIdx >= 0) {
            parts[textIdx] = { ...parts[textIdx], text: `[${ts}]\n${parts[textIdx].text}` };
          }
          return { ...msg, content: parts };
        }
        return msg;
      };

      const timestampedHistory = historyMessages.map(_prependTimestamp);
      const nowTs = _fmtTime(new Date().toISOString());
      const timestampedContent = typeof content === 'string'
        ? `[${nowTs}]\n${content}`
        : (() => {
            if (Array.isArray(content)) {
              const parts = [...content];
              const textIdx = parts.findIndex(p => p.type === 'text');
              if (textIdx >= 0) parts[textIdx] = { ...parts[textIdx], text: `[${nowTs}]\n${parts[textIdx].text}` };
              return parts;
            }
            return content;
          })();

      // Skills 采用渐进加载：system prompt 只放目录，完整内容通过 skill_load 按需读取。
      let enabledSkills = [];
      try {
        enabledSkills = await getEnabledSkills(petInfo._id, 'chat');
      } catch (error) {
        // Skills 不可用不应阻断普通聊天（例如旧后端尚未注册 commands）。
        console.warn('[Skills] Failed to load enabled skills:', error);
      }

      if (!isDefaultPersonality) {
        const systemContent = await buildSystemPrompt({
          petId: petInfo._id,
          memoryEnabled,
          skills: enabledSkills,
        });
        const systemPrompt = { role: "system", content: systemContent };
        fullMessages = [...timestampedHistory, systemPrompt, { role: "user", content: timestampedContent }];
      } else {
        let systemContent = '';
        if (memoryEnabled) {
          systemContent = await buildSystemPrompt({
            petId: petInfo._id,
            memoryEnabled: true,
            skills: enabledSkills,
          });
        } else if (enabledSkills.length > 0) {
          // Default personality with memory disabled should not accidentally
          // re-introduce SOUL.md merely because Skills are enabled.
          systemContent = buildSkillCatalogPrompt(enabledSkills);
        }
        systemContent += '\nYou are a helpful assistant.';
        const systemPrompt = { role: "system", content: systemContent };
        fullMessages = [...timestampedHistory, systemPrompt, { role: "user", content: timestampedContent }];
      }
      
      if (messageAttachments.length > 0) {
          setAttachments([]);
      }

    reply = null;

    // Create new AbortController for this conversation's request
    const controller = new AbortController();
    abortControllersRef.current.set(initialConversationId, controller);

    // 检查是否启用了 MCP 工具
    const mcpEnabled = enabledMcpServers.size > 0;

    // 获取内置工具定义（read/write/edit）
    const builtinTools = getBuiltinToolDefinitions(memoryEnabled);
    const exposeSubagentForSend = isSubagentPermissionCurrent(
      subagentPermission,
      subagentEnabledByConversationRef.current,
      subagentCapabilityRevisionsRef.current,
    );
    const subagentDef = exposeSubagentForSend ? getSubagentToolDefinition() : null;
    if (subagentDef) builtinTools.push(subagentDef);
    if (enabledSkills.length > 0) {
      builtinTools.push(...getSkillToolDefinitions());
    }

    // 合并 MCP 工具和内置工具
    const allMcpTools = [...(mcpEnabled && hasTools ? mcpTools : [])];
    const allToolsForLLM = allMcpTools.length > 0 || builtinTools.length > 0;

    // 添加工具使用指导到 system prompt
    if (allToolsForLLM) {
      const toolGuidance = `

## Tool Usage Guidelines
When using tools, please follow these guidelines:
1. Read the tool's parameter descriptions carefully and use only the valid values specified in the schema.
2. If a tool call returns an error, analyze the error message and retry with corrected parameters.
3. If you already have successful results from previous tool calls, use those results to answer the user's question instead of giving up.
4. Do not invent parameter values - only use values that are explicitly documented in the tool schema.
5. If unsure about a parameter value, try the most common/default option first, or omit optional parameters.
`;
      
      // 在 fullMessages 的 system 消息中追加工具指导
      const systemMsgIndex = fullMessages.findIndex(m => m.role === 'system');
      if (systemMsgIndex !== -1) {
        fullMessages[systemMsgIndex] = {
          ...fullMessages[systemMsgIndex],
          content: fullMessages[systemMsgIndex].content + toolGuidance
        };
      } else {
        fullMessages.unshift({
          role: 'system',
          content: toolGuidance.trim()
        });
      }
    }

    // 调试日志
    console.log('[ChatboxInputBox] Tools Debug:', {
      mcpEnabled,
      builtinToolCount: builtinTools.length,
      mcpToolCount: allMcpTools.length,
      allToolsForLLM,
      memoryEnabled
    });

    // 使用工具调用模式（内置工具始终可用 + 可选 MCP 工具）
    if (allToolsForLLM) {
      // 合并工具列表：MCP 工具 + 内置工具（内置工具作为已转换的 OpenAI 格式直接追加）
      const combinedTools = [...allMcpTools];
      // 内置工具以 "raw" 形式添加，toolConverter 会处理格式转换
      // 但由于内置工具已经是 function 定义格式，我们需要将它们也作为 mcpTools 传入
      // 创建虚拟的 MCP 工具格式供 convertToolsForLLM 处理
      const builtinAsMcpTools = builtinTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        inputSchema: t.function.parameters,
        serverName: null  // 无服务器前缀，标记为内置工具
      }));
      const allToolsArray = [...combinedTools, ...builtinAsMcpTools];

      console.log('[ChatboxInputBox] Calling LLM with tools:', allToolsArray.length, 'tools available');
      
      try {
        const toolResult = await callLLMStreamWithTools({
          messages: fullMessages,
          apiFormat: getApiFormat(thisModel),
          apiKey: pickApiKey(thisModel.modelApiKey),
          model: thisModel.modelName,
          baseUrl: thisModel.modelUrl,
          mcpTools: allToolsArray,
          options: {},
          onChunk: (deltaText, fullText) => {
            dispatch({ 
              type: actionType.ADD_STREAMING_REPLY, 
              content: deltaText,
              id: sendingConversationId 
            });
          },
          onToolCall: (toolName, args, toolCallId) => {
            console.log('[Tools] Tool called:', toolName, args);
            dispatch({
              type: actionType.ADD_TOOL_CALL,
              conversationId: sendingConversationId || 'temp',
              toolCall: {
                id: toolCallId || `${toolName}-${Date.now()}`,
                toolName,
                args,
                status: 'running',
                startTime: Date.now()
              }
            });
          },
          onToolResult: (toolName, result, toolCallId, isError) => {
            console.log('[Tools] Tool result:', toolName, result?.slice?.(0, 100));
            dispatch({
              type: actionType.UPDATE_TOOL_CALL,
              conversationId: sendingConversationId || 'temp',
              toolCallId: toolCallId || `${toolName}`,
              updates: {
                status: isError ? 'error' : 'success',
                result: result,
                endTime: Date.now()
              }
            });
          },
          abortSignal: controller.signal,
          builtinToolContext: {
            petId: petInfo._id,
            conversationId: subagentConversationIdAtSend,
            memoryEnabled,
            ...createSkillToolContext(petInfo._id, enabledSkills),
            subagentRegistry,
            subagentConfig: {
              enabled: exposeSubagentForSend,
              model: 'sonnet',
              timeoutSecs: 300,
              isEnabled: () => isSubagentPermissionCurrent(
                subagentPermission,
                subagentEnabledByConversationRef.current,
                subagentCapabilityRevisionsRef.current,
              ),
            },
            imageModel: imageModelInfo,
          }
        });

        // 桥接：扫 toolCallHistory 里 generate_image 成功结果，把 base64 图片塞进 reply.content
        const generatedImageParts = [];
        for (const entry of (toolResult.toolCallHistory || [])) {
          if (entry?.name !== 'generate_image' || !Array.isArray(entry.images)) continue;
          for (const img of entry.images) {
            if (!img?.data) continue;
            const url = img.data.startsWith('data:') || img.data.startsWith('http')
              ? img.data
              : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
            generatedImageParts.push({ type: 'image_url', image_url: { url } });
          }
        }
        const replyContent = generatedImageParts.length > 0
          ? [
              { type: 'text', text: toolResult.content || '' },
              ...generatedImageParts,
            ]
          : toolResult.content;

        reply = {
          content: replyContent,
          mood: 'normal',
          toolCallHistory: toolResult.toolCallHistory
        };
        
        console.log('[ChatboxInputBox] Tool call completed with', toolResult.toolCallHistory?.length || 0, 'tool calls');
        
        setTimeout(() => {
          dispatch({
            type: actionType.CLEAR_TOOL_CALLS,
            conversationId: sendingConversationId || 'temp'
          });
        }, 2000);
      } catch (error) {
        console.error('[ChatboxInputBox] Tool call failed:', error);
        reply = { content: `Error: ${error.message}`, mood: 'normal' };
        
        dispatch({
          type: actionType.CLEAR_TOOL_CALLS,
          conversationId: sendingConversationId || 'temp'
        });
      }
    } else {
      console.log('[ChatboxInputBox] Calling callOpenAILibStream with hasMood:', petInfo.hasMood, 'petInfo:', petInfo);

      reply = await callOpenAILibStream(
        fullMessages,
        getApiFormat(thisModel),
        pickApiKey(thisModel.modelApiKey),
        thisModel.modelName,
        thisModel.modelUrl,
        (chunk) => {
            // 无论当前是否在同一个 tab，都更新对应 conversation 的流式内容
            dispatch({ 
                type: actionType.ADD_STREAMING_REPLY, 
                content: chunk,
                id: sendingConversationId 
            });
        },
        controller.signal, // Pass the signal
                { 
          hasMood: petInfo.hasMood !== false, 
          conversationId: sendingConversationId
        }
      );
      
      console.log('[ChatboxInputBox] callOpenAILibStream returned:', reply);
    }
      
    // Clear this conversation's abort controller after completion
    abortControllersRef.current.delete(initialConversationId);

    // 清除流式输出内容，准备显示最终消息
    dispatch({ type: actionType.CLEAR_STREAMING_REPLY, id: sendingConversationId });

    if (!reply) {
        reply = { content: "Error: No response from AI.", mood: "normal" };
    }

    const botReply = {
      role: "assistant",
      content: reply.content || "Error: Empty response",
      createdAt: new Date().toISOString(),
      // 保存 MCP 工具调用历史到消息中
      ...(reply.toolCallHistory && reply.toolCallHistory.length > 0 && { toolCallHistory: reply.toolCallHistory })
    };

    // 新方案: 无论用户是否在当前 tab，都要将 bot 回复添加到 Rust TabState
    // 这样即使用户切换了 tab，消息也会被正确保存到数据库
    if (sendingConversationId) {
      await tauri.pushTabMessage(sendingConversationId, botReply);
    }
    
    // 新方案: 清除思考状态
    if (sendingConversationId && sendingConversationId !== 'temp') {
      await tauri.setTabThinking(sendingConversationId, false);
    }

    // 如果是新对话（没有真实的 conversationId），创建新对话
    console.log('[handleSend] ★★★ 新对话判断: sendingConversationId=', sendingConversationId);
    if (!sendingConversationId || sendingConversationId === 'temp') {
      console.log('[handleSend] ★★★ 创建新对话 (sendingConversationId is temp/null)');
      try {
        // 新方案: 新对话时从 Rust TabState 获取最新消息
        const currentState = await tauri.getTabState(sendingConversationId || 'temp');
        const currentMsgs = currentState.messages || [];
        console.log('[handleSend] ★★★ temp TabState messages:', currentMsgs.length);
        // 新对话始终归属当前 pet（overrideModel 只影响 LLM 调用，不影响对话归属）
        const actualPetId = petInfo._id;
        const newConversation = await tauri.createConversation({
          petId: actualPetId,
          title: _userText,
          history: [...currentMsgs, botReply],
        });
        console.log('[handleSend] ★★★ 新对话创建完成: id=', newConversation?._id);
        if (newConversation) {
            sendingConversationId = newConversation._id;
            // 初始化 Rust TabState
            await tauri.setTabStateMessages(sendingConversationId, [...currentMsgs, botReply]);
            // 如果用户还在当前页面，更新 ref
            if (!conversationIdRef.current) {
                conversationIdRef.current = newConversation._id;
            }
        }
      } catch (error) {
        console.error("Failed to create conversation:", error);
      }
    } else {
      console.log('[handleSend] ★★★ 已有对话，不需要创建新的, convId=', sendingConversationId);
    }

    // 使用 sendingConversationId 更新数据库，确保写入正确的对话
    // 只有当 conversationId 是有效的（不是 'temp'）时才更新数据库
    console.log('[handleSend] ★★★ 保存判断: sendingConversationId=', sendingConversationId, 'type=', typeof sendingConversationId);
    if (sendingConversationId && sendingConversationId !== 'temp') {
        console.log('[handleSend] ★★★ 进入保存流程, convId=', sendingConversationId);
        // overrideModel._sourceId 是 API provider ID（非 pet ID），不能用于 transferConversation
        // 模型切换只影响 LLM 调用，对话归属不变

        // 新方案: 从 Rust TabState 获取最新完整历史
        const finalState = await tauri.getTabState(sendingConversationId);
        const newHistory = finalState.messages || [];
        console.log('[handleSend] ★★★ getTabState 返回: convId=', sendingConversationId, 'historyLength=', newHistory.length, 'messages=', newHistory.map(m => `${m.role}:${typeof m.content === 'string' ? m.content.substring(0, 30) : '[complex]'}`));

        // Only update title if it's the first message
        // 使用在 pushTabMessage 之前保存的消息数量来判断
        // （不能用 historyMessages.length，因为它已经包含了刚发送的用户消息）
        const isFirstMessage = messageCountBeforeUserMsg === 0;
        const newTitle = isFirstMessage ? _userText : undefined;

        const updatePayload = {
            petId: petInfo._id,
            history: newHistory,
        };
        if (newTitle) {
            updatePayload.title = newTitle;
        }
        console.log('[handleSend] ★★★ 调用 updateConversation, payload.history.length=', updatePayload.history.length, 'title=', updatePayload.title);

        await tauri.updateConversation(sendingConversationId, updatePayload);
        console.log('[handleSend] ★★★ updateConversation 完成!');
        
        // 通知全局状态更新该会话的消息记录（用于侧边栏等）
        dispatch({
            type: actionType.UPDATE_CONVERSATION_MESSAGES,
            id: sendingConversationId,
            messages: newHistory,
            title: newTitle
        });
    }

    if (
      quickReplyEnabledRef.current
      && reply?.content
      && thisModel
      && _userText
      && sendingConversationId
      && sendingConversationId !== 'temp'
    ) {
      const conversationIdSnapshot = sendingConversationId;
      const requestToken = quickReplyGateRef.current.begin(conversationIdSnapshot);
      const userTextSnapshot = String(_userText);
      const assistantTextSnapshot = Array.isArray(reply.content)
        ? reply.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
        : String(reply.content);
      const suggestionConfig = {
        apiFormat: getApiFormat(thisModel),
        apiKey: pickApiKey(thisModel.modelApiKey),
        model: thisModel.modelName,
        baseUrl: thisModel.modelUrl,
      };

      void promptSuggestion(
        { user: userTextSnapshot, assistant: assistantTextSnapshot },
        suggestionConfig.apiFormat,
        suggestionConfig.apiKey,
        suggestionConfig.model,
        suggestionConfig.baseUrl,
      ).then((suggestion) => {
        if (
          !quickReplyEnabledRef.current
          || !quickReplyGateRef.current.isCurrent(requestToken)
        ) return;
        const replies = parseQuickReplyResponse(suggestion);
        dispatch({
          type: actionType.SET_SUGGEST_TEXT,
          suggestText: replies,
          conversationId: conversationIdSnapshot,
        });
      }).catch((error) => {
        console.error('Error getting Quick Reply suggestions:', error);
        if (
          quickReplyEnabledRef.current
          && quickReplyGateRef.current.isCurrent(requestToken)
        ) {
          dispatch({
            type: actionType.SET_SUGGEST_TEXT,
            suggestText: [],
            conversationId: conversationIdSnapshot,
          });
        }
      });
    }
    
    } catch (error) {
      console.error('[handleSend] Error occurred:', error);
      // Ensure we have some reply object for the finally block
      if (!reply) {
        reply = { content: `Error: ${error.message}`, mood: 'normal' };
      }
    } finally {
      // ✅ 确保无论如何都会重置 thinking 状态，避免卡住
      // 更新 TabState 的 thinking 状态
      if (initialConversationId) {
        tauri.setTabThinking(initialConversationId, false);
      }
      // 更新角色窗口的 mood 动画
      tauri.sendMoodUpdate(reply?.mood || "normal", initialConversationId);
      // 从生成中会话集合中移除（使用初始 ID）
      setGeneratingConversations(prev => {
        const newSet = new Set(prev);
        newSet.delete(initialConversationId);
        return newSet;
      });
      // 清理 AbortController
      abortControllersRef.current.delete(initialConversationId);
      tauri.updateChatbodyStatus?.("", initialConversationId);
    }
  };

  handleSendRef.current = handleSend;

  useEffect(() => {
    if (!quickReplyRequest || lastQuickReplyRequestIdRef.current === quickReplyRequest.id) return;
    lastQuickReplyRequestIdRef.current = quickReplyRequest.id;

    const action = getQuickReplySelectionAction({
      enabled: quickReplyEnabled,
      request: quickReplyRequest,
      currentConversationId: authoritativeConversationId,
      isGenerating,
      draft: userText,
      attachmentCount: attachmentsRef.current.length,
    });
    onQuickReplyHandled?.(quickReplyRequest.id);
    if (action === 'ignore') return;

    quickReplyGateRef.current.invalidateConversation(quickReplyRequest.conversationId);
    dispatch({
      type: actionType.SET_SUGGEST_TEXT,
      suggestText: [],
      conversationId: quickReplyRequest.conversationId,
    });

    if (action === 'draft') {
      setUserText(current => current.trim()
        ? `${current.trim()}\n${quickReplyRequest.text}`
        : quickReplyRequest.text);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    void handleSendRef.current?.(
      quickReplyRequest.text,
      quickReplyRequest.conversationId,
      { includeAttachments: false, clearComposer: false },
    );
  }, [
    quickReplyRequest,
    quickReplyEnabled,
    authoritativeConversationId,
    isGenerating,
    userText,
    onQuickReplyHandled,
    dispatch,
  ]);


  // Listen for regeneration requests
  useEffect(() => {
    if (runFromHereTimestamp) {
        // Trigger send logic
        // We need to ensure we don't trigger this on initial load, but runFromHereTimestamp is only set by action
        handleSend();
    }
  }, [runFromHereTimestamp]);


// 处理粘贴事件，支持图片、视频、音频和其他文件
const handlePaste = async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  
  const filesToProcess = [];
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Check if item is a file (image, video, audio, etc.)
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        filesToProcess.push(file);
      }
    }
  }
  
  if (filesToProcess.length > 0) {
    e.preventDefault();
    
    for (const file of filesToProcess) {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments(prev => [...prev, attachment]);
      }
    }
  }
};

const handleStop = async () => {
    console.log('[handleStop] Stopping generation and MCP tool calls');
    
    // 取消当前会话的请求
    const currentConvId = authoritativeConversationId || 'temp';
    const controller = abortControllersRef.current.get(currentConvId);
    
    // 取消 AbortController（如果存在 - 用于 JS fetch 请求）
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(currentConvId);
    }
    
    // 取消 Rust 端的 LLM 流
    try {
      if (tauri.llmCancelStream) {
        await tauri.llmCancelStream(currentConvId);
        console.log('[handleStop] Rust LLM stream cancelled');
      }
    } catch (err) {
      console.error('[handleStop] Failed to cancel Rust LLM stream:', err);
    }
    
    // 始终清除生成状态（即使 controller 不存在）
    setGeneratingConversations(prev => {
      const newSet = new Set(prev);
      newSet.delete(currentConvId);
      newSet.delete('temp'); // 同时清除 temp 状态
      return newSet;
    });
    
    // 清除该会话的工具调用状态
    dispatch({
      type: actionType.CLEAR_TOOL_CALLS,
      conversationId: currentConvId
    });
    
    // 重置 TabState 的 thinking 状态
    if (currentConvId) {
      tauri.setTabThinking(currentConvId, false);
    }
    // 重置心情状态为正常（角色窗口动画）
    tauri.sendMoodUpdate('normal', currentConvId);
    
    // 清除聊天状态
    tauri.updateChatbodyStatus?.('', currentConvId);
    
    // 取消所有 MCP 工具调用
    try {
      if (tauri.mcp?.cancelAllToolCalls) {
        await tauri.mcp.cancelAllToolCalls();
        console.log('[handleStop] MCP tool calls cancelled');
      }
    } catch (err) {
      console.error('[handleStop] Failed to cancel MCP tool calls:', err);
    }
  };

  const [attachments, setAttachments] = useState([]);
  const attachmentsRef = useRef(attachments);
  const previousAttachmentCountRef = useRef(attachments.length);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const previousCount = previousAttachmentCountRef.current;
    previousAttachmentCountRef.current = attachments.length;
    if (attachments.length <= previousCount || !authoritativeConversationId) return;
    quickReplyGateRef.current.invalidateConversation(authoritativeConversationId);
    dispatch({
      type: actionType.SET_SUGGEST_TEXT,
      suggestText: [],
      conversationId: authoritativeConversationId,
    });
  }, [attachments.length, authoritativeConversationId, dispatch]);

  // The persistent action row is designed to fit the 460px window floor. Keep
  // that minimum stable so status tags, Skills counts, and sidebar changes can
  // never make the native window jump wider.
  useEffect(() => {
    let disposed = false;
    const reportMinimum = async () => {
      try {
        const settings = await tauri.getSettings();
        if (disposed) return;
        await tauri.reportChatMinWidth(
          getCapabilityIslandMinWidth(0),
          settings?.windowSize || 'medium',
        );
      } catch { /* Non-Tauri previews do not report native window constraints. */ }
    };
    reportMinimum();
    return () => {
      disposed = true;
    };
  }, []);

  // Report the in-flow composer height so the native compact window can stay
  // tightly wrapped around drafts, attachments, and notifications.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || !onHeightChange) return undefined;

    let frameId = null;
    const report = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = null;
        onHeightChange(Math.ceil(element.getBoundingClientRect().height));
      });
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [compact, onHeightChange]);

  const hasOpenComposerOverlay = showCapabilityDrawer
    || showSubagentPanel
    || showModelSelector
    || showSkillsPopover;

  useEffect(() => {
    onOverlayOpenChange?.(hasOpenComposerOverlay);
  }, [hasOpenComposerOverlay, onOverlayOpenChange]);

  useEffect(() => {
    const recordPointerDown = () => {
      lastPointerDownAtRef.current = performance.now();
    };
    document.addEventListener('pointerdown', recordPointerDown, true);
    return () => document.removeEventListener('pointerdown', recordPointerDown, true);
  }, []);

  // Every native activation is a fresh, explicit request to type. Retry for a
  // short bounded interval while the WebView receives OS focus. A pointerdown
  // after the activation wins, so a real user click is never stolen back.
  useEffect(() => {
    const requestId = Number(focusRequest?.id);
    const requestedAt = Number(focusRequest?.requestedAt);
    if (!Number.isSafeInteger(requestId) || requestId <= 0 || !Number.isFinite(requestedAt)) {
      return undefined;
    }
    if (requestId <= lastHandledFocusRequestRef.current) return undefined;

    // Explicit summon returns the composer to its typing state.
    setShowCapabilityDrawer(false);
    setShowSubagentPanel(false);
    setShowModelSelector(false);

    let cancelled = false;
    let frameId = null;
    let attempts = 0;
    const tryFocus = () => {
      if (cancelled || requestId !== Number(focusRequest?.id)) return;
      const input = inputRef.current;
      if (!input || lastPointerDownAtRef.current > requestedAt) {
        lastHandledFocusRequestRef.current = requestId;
        return;
      }

      const activeElement = document.activeElement;
      const activeElementSafe = !activeElement
        || activeElement === document.body
        || activeElement === document.documentElement
        || activeElement === input;
      if (shouldApplyComposerFocus({
        documentFocused: document.hasFocus(),
        explicitRequest: true,
        activeElementSafe,
        requestStartedAt: requestedAt,
        lastPointerDownAt: lastPointerDownAtRef.current,
      })) {
        input.focus({ preventScroll: true });
        lastHandledFocusRequestRef.current = requestId;
        return;
      }

      attempts += 1;
      if (attempts < 12) {
        frameId = requestAnimationFrame(tryFocus);
      } else {
        lastHandledFocusRequestRef.current = requestId;
      }
    };
    frameId = requestAnimationFrame(tryFocus);
    return () => {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [focusRequest]);

  // Legacy visibility events do not carry an activation id. Keep a narrow
  // fallback for those events without overriding focus on another control.
  useEffect(() => {
    if (!autoFocus || focusRequest || !inputRef.current || hasOpenComposerOverlay) return;
    const input = inputRef.current;
    const activeElement = document.activeElement;
    const activeElementSafe = !activeElement
      || activeElement === document.body
      || activeElement === document.documentElement
      || activeElement === input;
    if (shouldApplyComposerFocus({
      documentFocused: document.hasFocus(),
      explicitRequest: false,
      activeElementSafe,
    })) {
      input.focus({ preventScroll: true });
    }
  }, [autoFocus, focusRequest, hasOpenComposerOverlay]);

  // Helper function to process a file and add to attachments
  const processFile = async (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64Data = event.target.result;
        try {
          // Save to Electron
          const result = await tauri.saveFile({
            fileName: file.name,
            fileData: base64Data,
            mimeType: file.type
          });
          
          if (!result || !result.path) {
            console.error('saveFile returned invalid result:', result);
            resolve(null);
            return;
          }
          
          // Determine type based on mime
          let type = 'file_url';
          if (file.type.startsWith('image/')) type = 'image_url';
          
          resolve({
            type,
            url: base64Data,
            path: result.path,
            name: file.name,
            mime_type: file.type,
            data: base64Data
          });
        } catch (err) {
          console.error('Failed to save file:', err);
          resolve(null);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments(prev => [...prev, attachment]);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Drag and drop handlers
  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if leaving the container (not entering a child)
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    
    for (const file of files) {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments(prev => [...prev, attachment]);
      }
    }
  };

  const activeCapabilityTags = useMemo(() => buildActiveCapabilityTags({
    enabledMcpServers,
    activeSubagentCount,
  }), [enabledMcpServers, activeSubagentCount]);

  const visibleSubagentNotifications = useMemo(() => subagentNotifications.filter(notification => (
    String(notification.conversationId || '') === String(subagentConversationId || '')
  )), [subagentNotifications, subagentConversationId]);

  const conversationContextReady = Boolean(
    authoritativeConversationId
    && String(currentConversationId || '') === String(authoritativeConversationId)
  );
  const sendDisabled = ((!assistantContextReady || !conversationContextReady) && !isGenerating) || (
    !String(userText).trim()
    && !isGenerating
    && !(userMessages.length > 0 && userMessages[userMessages.length - 1].role === 'user')
  );

  const showAssistantIdentity = assistantContextReady;

  const closeCapabilityDrawer = useCallback(() => {
    setShowCapabilityDrawer(false);
  }, []);

  const handleCapabilityToggle = useCallback(() => {
    setShowModelSelector(false);
    setShowSubagentPanel(false);
    setShowCapabilityDrawer(open => !open);
  }, []);

  const openCapabilityDrawer = useCallback(() => {
    setShowModelSelector(false);
    setShowSubagentPanel(false);
    setShowCapabilityDrawer(true);
  }, []);

  const openSubagentPanel = useCallback(() => {
    setShowModelSelector(false);
    setShowCapabilityDrawer(false);
    setShowSubagentPanel(true);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative mx-auto w-full max-w-[32rem] no-drag ${compact ? 'px-2 pb-2' : 'px-4 pb-4'}`}
    >
      {/* Subagent 完成通知条 */}
      {visibleSubagentNotifications.length > 0 && (
        <div className={`mb-2 space-y-1.5 ${compact ? 'max-h-40 overflow-y-auto pr-1' : ''}`}>
          {visibleSubagentNotifications.map(n => (
            <div key={n.taskId} className={`rounded-xl border px-3 py-2 text-xs shadow-sm transition-all ${
              n.status === 'done' ? 'bg-emerald-50 border-emerald-200' :
              n.status === 'timeout' ? 'bg-amber-50 border-amber-200' :
              'bg-red-50 border-red-200'
            }`}>
              <div className="flex items-center gap-2">
                <span>{n.status === 'done' ? '✅' : n.status === 'timeout' ? '⏰' : '❌'}</span>
                <span className="flex-1 font-medium text-gray-700 truncate">
                  {n.task?.substring(0, 60)}
                </span>
                <button
                  onClick={() => setExpandedNotification(expandedNotification === n.taskId ? null : n.taskId)}
                  className="text-[10px] text-gray-500 hover:text-gray-700 px-1.5 py-0.5 rounded hover:bg-black/5"
                >
                  {expandedNotification === n.taskId ? '收起' : '查看'}
                </button>
                <button
                  onClick={() => handleInjectSubagentResult(n)}
                  className="text-[10px] text-blue-600 hover:text-blue-800 px-1.5 py-0.5 rounded hover:bg-blue-50 font-medium"
                >
                  注入对话
                </button>
                <button
                  onClick={() => handleDismissNotification(n.taskId)}
                  className="text-gray-400 hover:text-gray-600 text-sm leading-none"
                >
                  ×
                </button>
              </div>
              {expandedNotification === n.taskId && (
                <div className="mt-1.5 p-2 rounded bg-white/80 border border-gray-100 text-[10px] text-gray-600 whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {n.status === 'done' && n.result
                    ? n.result
                    : n.error || '(无内容)'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Compact translucent input panel. */}
      <div 
        className={`relative rounded-[20px] border p-2.5 shadow-[0_10px_28px_rgba(15,23,42,0.09)] backdrop-blur-xl transition-all no-drag ${
          isDragging 
            ? 'border-blue-300 bg-blue-50/90'
            : 'border-white/80 bg-white/75'
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-blue-100/80 rounded-[20px] z-10 pointer-events-none">
            <div className="text-blue-500 font-medium text-sm">
              Drop files here
            </div>
          </div>
        )}
        <div className={`flex flex-wrap gap-2 ${compact ? 'max-h-40 overflow-y-auto' : ''}`}>
            {attachments.map((att, index) => (
                <div key={index} className="relative inline-block mt-2">
                    <div className="rounded-md bg-gray-100 border border-gray-200 overflow-hidden">
                        {att.type === 'image_url' ? (
                            <img src={att.url} alt="Attachment" className="w-20 h-20 object-cover" />
                        ) : att.mime_type?.startsWith('video/') ? (
                            <div className="w-20 h-20 bg-black flex items-center justify-center relative">
                                <video src={att.url} className="w-full h-full object-cover" muted />
                                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                                    <span className="text-white text-2xl">▶</span>
                                </div>
                            </div>
                        ) : att.mime_type?.startsWith('audio/') ? (
                            <div className="w-20 h-20 bg-gradient-to-br from-green-400 to-green-600 flex flex-col items-center justify-center p-1">
                                <span className="text-white text-2xl">🎵</span>
                                <span className="text-white text-[8px] truncate w-full text-center mt-1">{att.name}</span>
                            </div>
                        ) : (
                            <div className="w-20 h-20 flex flex-col items-center justify-center p-1">
                                <FaFile className="text-gray-500 text-xl" />
                                <span className="text-[8px] text-gray-600 truncate w-full text-center mt-1">{att.name}</span>
                            </div>
                        )}
                    </div>
                    <MdOutlineCancel 
                        className="absolute -top-1.5 -right-1.5 cursor-pointer z-10 text-gray-500 hover:text-red-500 bg-white rounded-full text-lg"
                        onClick={() => handleRemoveAttachment(index)}
                    />
                </div>
            ))}
        </div>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          className="hidden"
          multiple
        />

        <textarea
          ref={inputRef}
          value={userText}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={autoResize}
          onFocus={closeCapabilityDrawer}
          placeholder="Ask anything"
          rows={1}
          className="mb-0 mt-1 w-full resize-none overflow-y-auto bg-transparent text-sm text-gray-700 outline-none placeholder-gray-400 no-drag"
          style={{ maxHeight: '200px', minHeight: '24px' }}
          onChange={handleChange}
        />

        <CapabilityDrawer
          id="chat-capabilities-drawer"
          isOpen={showCapabilityDrawer}
          onClose={closeCapabilityDrawer}
        >
          <div className="grid grid-cols-1 gap-2">
            <CapabilityToggleAction
              icon={<FaRobot className="h-4 w-4" />}
              label="CC Subagents"
              description="Allow delegated background research"
              checked={subagentEnabled}
              runningCount={activeSubagentCount}
              onChange={setSubagentEnabled}
              onView={openSubagentPanel}
            />
          </div>

          <div className="mt-2 rounded-xl border border-white/70 bg-white/60 p-2">
            <div className="flex items-center justify-between px-1">
              <div>
                <div className="text-xs font-semibold text-slate-600">MCP tools</div>
                <div className="text-[10px] text-slate-400">External capability servers</div>
              </div>
              <span className="rounded-full bg-blue-50 px-2 py-1 text-[9px] font-semibold text-blue-600">
                {enabledMcpServers.size} enabled
              </span>
            </div>
            <div className="mt-1 overflow-x-auto">
              <McpToolbar
                servers={mcpServers}
                enabledServers={enabledMcpServers}
                onToggleServer={toggleMcpServer}
                onUpdateServer={updateMcpServer}
                onDeleteServer={deleteMcpServer}
                onEditIcon={editMcpServerIcon}
                onBatchUpdateOrder={batchUpdateMcpOrder}
                maxVisible={5}
              />
            </div>
          </div>
        </CapabilityDrawer>

        {/* Compact bottom line: capabilities and send blend into the input panel. */}
        <div
          className="mt-1.5 flex items-center gap-2 px-0.5 pb-0.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              title="Attach files"
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent text-slate-500 transition-colors hover:bg-white/80 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
            >
              <FaPaperclip className="h-4 w-4" />
              {attachments.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-white bg-amber-500 px-1 text-[9px] font-bold leading-none text-white">
                  {attachments.length > 99 ? '99+' : attachments.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                closeCapabilityDrawer();
                handleScreenshot();
              }}
              aria-label="Take screenshot"
              title="Take screenshot"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent text-slate-500 transition-colors hover:bg-white/80 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
            >
              <FaCamera className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={toggleMemory}
              aria-label={memoryEnabled ? 'Disable Memory' : 'Enable Memory'}
              aria-pressed={memoryEnabled}
              title={memoryEnabled ? 'Memory enabled' : 'Memory disabled'}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${memoryEnabled
                ? 'border-slate-200 bg-slate-200 text-slate-700'
                : 'border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-700'
              }`}
            >
              <FaBrain className="h-4 w-4" />
            </button>

            <div className="shrink-0" onPointerDown={closeCapabilityDrawer}>
              <SkillsToolbar
                petId={capabilityPetId}
                onOpenChange={setShowSkillsPopover}
                closeRequestId={focusRequest?.id}
              />
            </div>

            <div className="relative shrink-0">
              <button
                ref={subagentAnchorRef}
                type="button"
                onClick={handleCapabilityToggle}
                aria-label={showCapabilityDrawer ? 'Close more capabilities' : 'Open more capabilities'}
                aria-expanded={showCapabilityDrawer}
                aria-controls="chat-capabilities-drawer"
                title="More capabilities"
                className={`flex h-8 w-8 items-center justify-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${showCapabilityDrawer
                  ? 'border-violet-200 bg-violet-100 text-violet-600'
                  : 'border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-700'
                }`}
              >
                <FiMoreHorizontal className="h-5 w-5" />
              </button>
              <SubagentPanel
                isOpen={showSubagentPanel}
                onClose={() => setShowSubagentPanel(false)}
                conversationId={subagentConversationId}
                anchorRef={subagentAnchorRef}
              />
            </div>

            {activeCapabilityTags.length > 0 && (
              <div
                className="ml-0.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                aria-label="Enabled chat capabilities"
                aria-live="polite"
              >
                {activeCapabilityTags.map(tag => (
                  <CapabilityTag
                    key={tag.id}
                    tag={tag}
                    onClick={tag.id === 'subagents' ? openSubagentPanel : openCapabilityDrawer}
                    actionLabel={tag.id === 'subagents' ? 'Open Subagent tasks' : undefined}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {showAssistantIdentity && (
              <div className="relative z-30 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    closeCapabilityDrawer();
                    setShowSubagentPanel(false);
                    setShowModelSelector(open => !open);
                  }}
                  aria-label={`Assistant ${petInfo.name}; model ${overrideModel ? overrideModel.modelName : (petInfo.modelName || '3.0')}`}
                  aria-expanded={showModelSelector}
                  aria-haspopup="listbox"
                  title={`${petInfo.name} · ${overrideModel ? overrideModel.modelName : (petInfo.modelName || '3.0')}`}
                  className={`flex h-8 max-w-[104px] select-none items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/75 px-2.5 text-left text-[11px] font-medium text-gray-500 shadow-sm backdrop-blur-md transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${showModelSelector
                    ? 'scale-[0.98] border-blue-200'
                    : 'hover:border-slate-300 hover:bg-white'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${isGenerating
                      ? 'animate-pulse bg-amber-400'
                      : overrideModel ? 'bg-blue-400' : 'bg-violet-400'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-600">
                    {petInfo.name}
                  </span>
                  <svg className={`h-2.5 w-2.5 shrink-0 text-gray-400 transition-transform duration-200 ${showModelSelector ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showModelSelector && (
                  <>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Close model selector"
                      className="fixed inset-0 z-40 cursor-default"
                      onClick={() => setShowModelSelector(false)}
                    />
                    <div
                      role="listbox"
                      aria-label="Choose chat model"
                      className="absolute bottom-full right-0 z-50 mb-2 max-h-[min(320px,50vh)] w-64 overflow-y-auto rounded-xl border border-gray-100 bg-white/95 shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150"
                    >
                      <div className="p-1.5">
                        <button
                          type="button"
                          role="option"
                          aria-selected={!overrideModel}
                          onClick={() => {
                            setOverrideModel(null);
                            setShowModelSelector(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${!overrideModel
                            ? 'bg-blue-50 text-blue-600'
                            : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          <span className="truncate text-xs font-medium">{petInfo.modelName || 'Default'}</span>
                          {!overrideModel && (
                            <svg className="h-4 w-4 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      </div>

                      {visibleModelsByProvider.length > 0 && <div className="mx-2 border-t border-gray-100" />}

                      {visibleModelsByProvider.map(provider => (
                        <div key={provider._id || provider.name} className="p-1.5">
                          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                            {provider.name}
                          </div>
                          {provider.visibleModels.map(model => {
                            const modelName = typeof model === 'string' ? model : model.name;
                            const isSelected = overrideModel
                              && overrideModel._sourceId === provider._id
                              && overrideModel.modelName === modelName;
                            return (
                              <button
                                type="button"
                                role="option"
                                aria-selected={Boolean(isSelected)}
                                key={`${provider._id}:${modelName}`}
                                onClick={() => {
                                  setOverrideModel({
                                    modelName,
                                    modelUrl: provider.baseUrl,
                                    modelApiKey: provider.apiKey,
                                    apiFormat: provider.apiFormat || 'openai_compatible',
                                    modelProvider: provider.name,
                                    _sourceId: provider._id,
                                  });
                                  setShowModelSelector(false);
                                }}
                                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${isSelected
                                  ? 'bg-blue-50 text-blue-600'
                                  : 'text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                <span className="truncate text-xs font-medium">{modelName}</span>
                                {isSelected && (
                                  <svg className="h-4 w-4 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ))}

                      {apiProviders.every(p => !Array.isArray(p.cachedModels) || p.cachedModels.length === 0) && (
                        <div className="p-3 text-center text-xs text-gray-400">
                          No models available. Add API providers in Settings.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                closeCapabilityDrawer();
                setShowSubagentPanel(false);
                if (isGenerating) handleStop();
                else handleSend();
              }}
              disabled={sendDisabled}
              aria-label={isGenerating ? 'Stop generating' : 'Send message'}
              title={isGenerating ? 'Stop generating' : 'Send message'}
              className={`rounded-full p-2.5 transition-all duration-100 transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${buttonAnimating ? 'scale-0' : 'scale-100'} ${sendDisabled
                ? 'cursor-not-allowed bg-gray-400'
                : 'bg-black shadow-lg hover:bg-gray-900 focus-visible:ring-gray-800'
              }`}
            >
              {!isGenerating
                ? <FaArrowUp className="h-4 w-4 text-white" />
                : <FaStop className="h-4 w-4 text-white" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatboxInputBox;
