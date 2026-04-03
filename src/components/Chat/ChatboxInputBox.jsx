import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useStateValue } from '../../context/StateProvider';
import { actionType } from '../../context/reducer';
import { FaArrowUp, FaShareNodes, FaFile, FaStop, FaBrain, FaCamera, FaRobot } from "react-icons/fa6";
import { AiOutlinePlus } from "react-icons/ai";
import { BsFillRecordCircleFill } from "react-icons/bs";
import { promptSuggestion, callOpenAILib, callOpenAILibStream } from '../../utils/openai';
import { buildSystemPrompt, getBuiltinToolDefinitions, migrateFromOldSystem } from '../../utils/promptBuilder';
import { MdOutlineCancel } from "react-icons/md";
import { SiQuicktype } from "react-icons/si";
import { useMcpTools } from '../../utils/mcp/useMcpTools';
import { callLLMStreamWithTools } from '../../utils/mcp/toolExecutor';
import McpToolbar from './McpToolbar';
import SubagentPanel from './SubagentPanel';
import { subagentRegistry, initSubagentListeners, onSubagentChange, getActiveCount } from '../../utils/subagentManager';
import { getSubagentToolDefinition } from '../../utils/workspace/socialToolExecutor';
import * as tauri from '../../utils/tauri';
import { shouldInjectTime, buildTimeContext } from '../../utils/timeInjection';
import { listen } from '@tauri-apps/api/event';

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

export const ChatboxInputBox = ({ activePetId, sidebarOpen, autoFocus = false, activeTabId }) => {
  // 会话 ID ref（需要先声明，供其他地方引用）
  const conversationIdRef = useRef(null);
  
  // 按会话管理生成状态，支持多会话并行
  const [generatingConversations, setGeneratingConversations] = useState(new Set());
  // 按会话管理 AbortController，支持独立取消
  const abortControllersRef = useRef(new Map()); // Map<conversationId, AbortController>
  
  // Per-Conversation 工具栏状态
  // 记忆功能开关状态 { [conversationId]: boolean }
  const [memoryEnabledByConversation, setMemoryEnabledByConversation] = useState({});
  // Subagent 状态
  const [showSubagentPanel, setShowSubagentPanel] = useState(false);
  const [activeSubagentCount, setActiveSubagentCount] = useState(0);
  // MCP 服务器启用状态 { [conversationId]: Set<string> }
  const [enabledMcpServersByConversation, setEnabledMcpServersByConversation] = useState({});
  // 追踪每个会话创建时的默认值（用于新 Tab 固化当时的默认值）
  // Key: conversationId, Value: 该会话创建时的默认值
  const conversationDefaultsRef = useRef({});
  
  // 获取当前会话的记忆状态
  const currentConvId = conversationIdRef.current || 'temp';
  
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
    const convId = conversationIdRef.current || 'temp';
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
    const convId = conversationIdRef.current || 'temp';
    setEnabledMcpServersByConversation(prev => ({
      ...prev,
      [convId]: typeof value === 'function' ? value(prev[convId] ?? new Set()) : value
    }));
  };

  const [stateReply, setStateReply] = useState(null);
  const [stateReplyConversationId, setStateReplyConversationId] = useState(null); // Track which conversation the reply belongs to
  const [stateThisModel, setStateThisModel] = useState(null);
  const [stateUserText, setStateUserText] = useState(null);
  let reply = null;
  let thisModel = null;
  let _userText = null;

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
  
  // 更新 MCP 服务器配置 (按名称)
  const updateMcpServer = useCallback(async (serverName, updates) => {
    try {
      if (!tauri.mcp.updateServer) {
        console.error('[MCP] updateServerByName API not available');
        return;
      }
      await tauri.mcp.updateServer(serverName, updates);
      await refreshServers();
      console.log(`[MCP] 服务器 "${serverName}" 配置已更新:`, updates);
    } catch (err) {
      console.error('[MCP] Failed to update server:', err);
    }
  }, [refreshServers]);
  
  // 批量更新 MCP 服务器顺序
  const batchUpdateMcpOrder = useCallback(async (orderList) => {
    // orderList: [{ name: 'xxx', toolbarOrder: 0 }, ...]
    try {
      for (const item of orderList) {
        if (tauri.mcp.updateServer) {
          await tauri.mcp.updateServer(item.name, { toolbarOrder: item.toolbarOrder });
        }
      }
      await refreshServers();
      console.log('[MCP] 服务器顺序已更新');
    } catch (err) {
      console.error('[MCP] Failed to batch update order:', err);
    }
  }, [refreshServers]);
  
  // 删除 MCP 服务器 (按名称)
  const deleteMcpServer = useCallback(async (serverName) => {
    try {
      if (!tauri.mcp.deleteServer) {
        console.error('[MCP] deleteServerByName API not available');
        return;
      }
      // 从启用列表中移除
      setEnabledMcpServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(serverName);
        return newSet;
      });
      await tauri.mcp.deleteServer(serverName);
      await refreshServers();
      console.log(`[MCP] 服务器 "${serverName}" 已删除`);
    } catch (err) {
      console.error('[MCP] Failed to delete server:', err);
    }
  }, [refreshServers]);
  
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
  const stateValue = useStateValue();
  const [state, dispatch] = stateValue || [{}, () => {}];
  // 新方案: 使用 Rust TabState
  const { suggestText: allSuggestTexts = {}, currentConversationId, runFromHereTimestamp, characterMoods = {}, lastTimeInjection = {}, apiProviders = [] } = state;
  
  // 兼容性：当前会话是否在生成
  // 使用 currentConversationId（来自 state）而不是 conversationIdRef.current
  // 这样当 Tab 切换时，isGenerating 会随着 currentConversationId 的变化而重新计算
  const isGenerating = generatingConversations.has(currentConversationId) || 
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
  const [userMessages, setUserMessages] = useState([]);
  
  const suggestText = allSuggestTexts[currentConversationId] || [];
  
  // 新方案: 使用 Rust TabState 订阅
  useEffect(() => {
    if (!currentConversationId) {
      setUserMessages([]);
      return;
    }
    
    let unlisten = null;
    let isMounted = true;
    
    const setup = async () => {
      // 获取初始状态
      const initialState = await tauri.getTabState(currentConversationId);
      
      // 如果 Rust 缓存为空，从数据库加载并初始化
      if (!initialState.messages || initialState.messages.length === 0) {
        console.log('[ChatboxInputBox] Cache empty, loading from database:', currentConversationId);
        const conversation = await tauri.getConversationWithHistory(currentConversationId);
        if (conversation && conversation.history && conversation.history.length > 0) {
          // 初始化 Rust TabState
          await tauri.initTabMessages(currentConversationId, conversation.history);
        } else if (isMounted) {
          setUserMessages([]);
        }
      } else if (isMounted) {
        setUserMessages(initialState.messages);
      }
      
      // 订阅状态更新
      unlisten = await tauri.subscribeTabState(currentConversationId, (newState) => {
        if (isMounted) {
          setUserMessages(newState.messages || []);
        }
      });
    };
    
    setup();
    
    return () => {
      isMounted = false;
      if (unlisten) unlisten();
    };
  }, [currentConversationId]);
  
  // 临时覆盖模型（仅当前会话有效，不保存到数据库）
  const [overrideModel, setOverrideModel] = useState(null);
  // 模型选择器菜单显示状态
  const [showModelSelector, setShowModelSelector] = useState(false);
  
  // 监听跨窗口的 API providers 更新事件
  useEffect(() => {
    const unlisten = tauri.onApiProvidersUpdated((updatedProviders) => {
      console.log('[ChatboxInputBox] Received api-providers-updated event:', updatedProviders);
      if (Array.isArray(updatedProviders) && dispatch) {
        dispatch({
          type: actionType.SET_API_PROVIDERS,
          apiProviders: updatedProviders
        });
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
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);
  
  // 计算可见模型列表（当 apiProviders 变化时自动更新）
  const visibleModelsByProvider = useMemo(() => {
    console.log('[ChatboxInputBox] Computing visibleModelsByProvider, apiProviders:', apiProviders);
    // 确保 apiProviders 是数组
    if (!Array.isArray(apiProviders)) {
      console.warn('[ChatboxInputBox] apiProviders is not an array:', apiProviders);
      return [];
    }
    return apiProviders.map(provider => {
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
  const [activeModelConfig, setActiveModelConfig] = useState(null);
  const [functionModelInfo, setFunctionModelInfo] = useState(null);
  const composingRef = useRef(false);
  const ignoreEnterRef = useRef(false);
  const [founctionModel, setFounctionModel] = useState(null);
  const [system, setSystem] = useState(null);
  const [firstCharacter, setFirstCharacter] = useState(null)

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
                setCharacterId(null);
              }
            }
          } catch (fallbackError) {
            console.error("Error loading fallback assistant:", fallbackError);
            setCharacterId(null);
          }
        }
      } catch (error) {
        console.error("Error loading default character ID from settings:", error);
        setCharacterId(null);
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
    if (firstCharacter != null) {
      // 直接设置本地状态，不发送事件避免循环
      setCharacterId(firstCharacter);
    }
  }, [firstCharacter]);
  

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

  useEffect(() => {
    // Use stateReplyConversationId to ensure suggestions go to the correct conversation
    const conversationId = stateReplyConversationId;
    const updateSuggestion = async() => {
      thisModel = stateThisModel;
      _userText = stateUserText;
      
      if (!thisModel || !stateReply || !conversationId) return;

      try {
        let suggestion = await promptSuggestion(
            {user:_userText, assistant:stateReply.content},
            getApiFormat(thisModel),
            pickApiKey(thisModel.modelApiKey),
            thisModel.modelName,
            thisModel.modelUrl
        )
        if (suggestion && typeof suggestion === 'string') {
            suggestion = suggestion.split("|")
            dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: suggestion, conversationId });
        } else {
            dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [], conversationId });
        }
      } catch (error) {
        console.error("Error getting suggestions:", error);
        dispatch({ type: actionType.SET_SUGGEST_TEXT, suggestText: [], conversationId });
      }
    };
    if(stateReply != null && stateReplyConversationId != null) {
      updateSuggestion();
    }
  }, [stateReply, stateReplyConversationId]);

  // 加载角色信息，并清理或保留对话历史
  useEffect(() => {
    if (!characterId) return;

    const fetchPetInfo = async () => {
      try {
        // 首先尝试从新的 Assistant API 获取
        let assistant = await tauri.getAssistant(characterId);
        let modelConfig = null;
        
        if (assistant && assistant.modelConfigId) {
          // 新数据模型：从关联的 ModelConfig 获取 API 配置
          modelConfig = await tauri.getModelConfig(assistant.modelConfigId);
        }

        setActiveModelConfig(modelConfig);
        
        // 如果新 API 没有数据，回退到旧的 Pet API（向后兼容）
        if (!assistant) {
          assistant = await tauri.getPet(characterId);
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
          
          thisModel = null;
          if(functionModelInfo == null) {
            thisModel = apiConfig;
          } else {
            thisModel = functionModelInfo;
          }

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
          setCharacterId(null);
          return;
        }

        // 注意：不再在此处清空 conversationIdRef.current
        // 原因：侧边栏切换 assistant 时，transferConversation 已更新数据库的 pet_id，
        // 但 fetchPetInfo 的异步操作可能与 transferConversation 产生竞态条件，
        // 导致 conversationIdRef.current 被错误清空，后续消息无法保存到正确的对话。
        // Tab 系统已通过 currentConversationId + sync effect 管理活跃对话 ID，
        // 无需在此处重复管理。
      } catch (error) {
        console.error("Error fetching pet info:", error);
        // 不要在错误时设置 characterId 为 null，这可能导致循环
        // setCharacterId(null);
      }
    };

    fetchPetInfo();
  }, [characterId]);

  // Completed subagent notifications (chat-source only)
  const [subagentNotifications, setSubagentNotifications] = useState([]);
  const [expandedNotification, setExpandedNotification] = useState(null);

  // Subscribe to subagent changes
  useEffect(() => {
    const unsub = onSubagentChange((eventType, payload) => {
      setActiveSubagentCount(getActiveCount());
      // When a chat-source subagent finishes, add notification
      if (payload?.entry?.source === 'chat' && (eventType === 'done' || eventType === 'timeout' || eventType === 'error')) {
        setSubagentNotifications(prev => [...prev, {
          taskId: payload.taskId,
          task: payload.entry.task,
          status: payload.entry.status,
          result: payload.entry.result || null,
          error: payload.entry.error || null,
          timestamp: Date.now(),
        }]);
      }
    });
    return unsub;
  }, []);

  // Initialize subagent listeners when petInfo is available
  useEffect(() => {
    if (petInfo?._id) {
      initSubagentListeners({ petId: petInfo._id, addLog: null, wakeIntent: null });
    }
  }, [petInfo]);

  // 监听助手更新事件，当当前助手被修改时重新加载 petInfo
  useEffect(() => {
    if (!characterId) return;

    const handlePetsUpdate = async (event) => {
      // event 结构: { action: 'update', type: 'assistant', id, data }
      console.log("[ChatboxInputBox] Received pets update:", event);
      
      // 如果更新的是当前正在使用的助手，重新加载其信息
      if (event && (event.id === characterId || event._id === characterId)) {
        console.log("[ChatboxInputBox] Current assistant updated, reloading petInfo...");
        
        try {
          let assistant = await tauri.getAssistant(characterId);
          let modelConfig = null;
          
          if (assistant && assistant.modelConfigId) {
            modelConfig = await tauri.getModelConfig(assistant.modelConfigId);
          }
          
          setActiveModelConfig(modelConfig);
          
          if (!assistant) {
            assistant = await tauri.getPet(characterId);
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
          console.error("[ChatboxInputBox] Error reloading petInfo:", error);
        }
      }
    };

    let cleanup;
    if (tauri.onPetsUpdated) {
      cleanup = tauri.onPetsUpdated(handlePetsUpdate);
    }

    return () => {
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

  // 接收会话 ID
  useEffect(() => {
    const fetchConv = async (conversationId) => {
      try {
        const conv = await tauri.getConversationById(conversationId);
        setCharacterId(conv.petId)
        // alert(conv.petID);
      } catch (error) {
        console.error("Error fetching conversation:", error);
        throw error;
      }
    };

    const handleConversationId = async(id) => {
      await fetchConv(id);
      console.log("📥 Received conversation ID from Electron:", id);


      conversationIdRef.current = id;
    };

    let cleanup;
    if (tauri.onConversationId) {
      cleanup = tauri.onConversationId(handleConversationId);
    }
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // Sync conversationIdRef with currentConversationId from global state
  useEffect(() => {
    conversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

  const handleChange = (e) => {
    setUserText(e.target.value);
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
  const currentMood = characterMoods?.[currentConversationId] || 'normal';

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
  const handleSend = async () => {
    if (!characterId) {
      alert("Please select a character first!");
      return;
    }
    
    // 重置 MCP 取消状态（开始新的对话）
    try {
      if (tauri.mcp?.resetCancellation) {
        await tauri.mcp.resetCancellation();
      }
    } catch (err) {
      console.warn('[handleSend] Failed to reset MCP cancellation:', err);
    }

    let isRunFromHere = false;
    let currentInputText = userText;
    let runFromHereContent = null; // Store original multimodal content for re-run

    // 检查是否有内容可发送（文字或附件）
    const hasText = currentInputText.trim().length > 0;
    const hasAttachments = attachments.length > 0;

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
    let sendingConversationId = conversationIdRef.current || 'temp';
    // 保存初始 ID 用于状态清理（因为 sendingConversationId 后面可能会变）
    const initialConversationId = sendingConversationId;
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
    } else if (attachments.length > 0) {
        // displayContent uses file paths (for persistence/display)
        displayContent = [{ type: "text", text: _userText }];
        // llmContent uses base64 data (for sending to LLM)
        llmContent = [{ type: "text", text: _userText }];
        
        attachments.forEach(att => {
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

    setUserText("");
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

    if (inputRef.current) {
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

      if (attachments.length > 0) {
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

      if (!isDefaultPersonality) {
        const systemContent = await buildSystemPrompt({
          petId: petInfo._id,
          memoryEnabled,
        });
        const systemPrompt = { role: "system", content: systemContent };
        fullMessages = [...timestampedHistory, systemPrompt, { role: "user", content: timestampedContent }];
      } else {
        let systemContent = '';
        if (memoryEnabled) {
          systemContent = await buildSystemPrompt({
            petId: petInfo._id,
            memoryEnabled: true,
          });
        }
        systemContent += '\nYou are a helpful assistant.';
        const systemPrompt = { role: "system", content: systemContent };
        fullMessages = [...timestampedHistory, systemPrompt, { role: "user", content: timestampedContent }];
      }
      
      if (attachments.length > 0) {
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
    const subagentDef = getSubagentToolDefinition();
    if (subagentDef) builtinTools.push(subagentDef);

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
            memoryEnabled,
            subagentRegistry,
            subagentConfig: { enabled: true, model: 'sonnet', timeoutSecs: 300 },
          }
        });
        
        reply = {
          content: toolResult.content,
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

    if (reply) {
      setStateReply(reply);
      setStateReplyConversationId(sendingConversationId); // Save the conversation ID with the reply
    }
    if (thisModel) setStateThisModel(thisModel);
    if (_userText) setStateUserText(_userText);
    
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

const [showReplyOptions, setShowReplyOptions] = useState(false);
const replyOptionsTimeoutRef = useRef(null);

// 延迟关闭 Quick Reply 菜单
const handleReplyOptionsLeave = () => {
  replyOptionsTimeoutRef.current = setTimeout(() => {
    setShowReplyOptions(false);
  }, 300); // 300ms 延迟，给用户时间移动到菜单
};

const handleReplyOptionsEnter = () => {
  if (replyOptionsTimeoutRef.current) {
    clearTimeout(replyOptionsTimeoutRef.current);
    replyOptionsTimeoutRef.current = null;
  }
  setShowReplyOptions(true);
};

const handleStop = async () => {
    console.log('[handleStop] Stopping generation and MCP tool calls');
    
    // 取消当前会话的请求
    const currentConvId = conversationIdRef.current || 'temp';
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
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  // 当窗口可见或切换 Tab 时，自动聚焦输入框
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      // 添加短暂延迟确保窗口完全显示和 DOM 更新完成
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        console.log('[ChatboxInputBox] Auto-focused input, autoFocus:', autoFocus, 'activeTabId:', activeTabId);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [autoFocus, activeTabId]);

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

  return (
    <div className="relative w-full max-w-3xl mx-auto px-4 pb-4 no-drag">
      {/* Subagent 完成通知条 */}
      {subagentNotifications.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {subagentNotifications.map(n => (
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
      {/* 主输入框容器：模仿图2的紧凑风格 */}
      <div 
        className={`relative rounded-[20px] p-3 shadow-sm border transition-all no-drag  ${
          isDragging 
            ? 'border-blue-400 bg-blue-50' 
            : sidebarOpen
              ? 'bg-[#e8e8e8] border-[#d0d0d0]'
              : 'bg-[#c5c5c5] border-[#b0b0b0]'
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-blue-100/80 rounded-[26px] z-10 pointer-events-none">
            <div className="text-blue-500 font-medium text-sm">
              Drop files here
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
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
        <textarea
          ref={inputRef}
          value={userText}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={autoResize}
          placeholder="Ask anything"
          rows={1}
          className="w-full bg-transparent outline-none text-gray-700 placeholder-gray-500 mb-8 no-drag resize-none overflow-y-auto" 
          style={{ maxHeight: '200px', minHeight: '24px' }}
          onChange={handleChange}
        />



        {/* 底部工具栏：左侧功能开关 + 右侧发送按钮 */}
        <div className="absolute bottom-2 left-3 right-2 flex items-center justify-between">
            {/* Left: Tools (Agent, Memory, Search) */}
            <div className="flex items-center gap-1">
                <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="p-2 text-gray-500 hover:bg-gray-400/50 rounded-full transition-colors"
                    title="Add Attachment"
                >
                    <AiOutlinePlus className="w-5 h-5" />
                </button>
                <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileSelect} 
                    className="hidden" 
                    multiple 
                />
                
                {/* 截图按钮 */}
                <button 
                    onClick={handleScreenshot}
                    className="p-2 text-gray-500 hover:bg-gray-400/50 rounded-full transition-colors"
                    title="Screenshot"
                >
                    <FaCamera className="w-4 h-4" />
                </button>

                {/* Subagent 按钮 */}
                <div className="relative">
                  <button
                    onClick={() => setShowSubagentPanel(!showSubagentPanel)}
                    className={`relative flex items-center gap-1.5 rounded-full transition-all duration-200 text-sm font-medium ${
                      activeSubagentCount > 0
                        ? 'px-3 py-1.5 text-blue-700 bg-blue-100 border border-blue-300'
                        : 'p-2 text-gray-500 hover:bg-gray-300/50 border border-transparent'
                    }`}
                    title={`CC Subagent (${activeSubagentCount} running)`}
                  >
                    <FaRobot className="w-4 h-4" />
                    {activeSubagentCount > 0 && (
                      <span className="text-xs">{activeSubagentCount}</span>
                    )}
                  </button>
                  <SubagentPanel
                    isOpen={showSubagentPanel}
                    onClose={() => setShowSubagentPanel(false)}
                  />
                </div>

                <button
                    onClick={toggleMemory}
                    className={`flex items-center gap-1.5 rounded-full transition-all duration-200 text-sm font-medium ${
                        memoryEnabled 
                            ? "px-3 py-1.5 text-gray-700 bg-gray-300/80 border border-gray-400" 
                            : "p-2 text-gray-500 hover:bg-gray-300/50 border border-transparent"
                    }`}
                    title="Memory"
                >
                    <FaBrain className="w-4 h-4" />
                    {memoryEnabled && <span className="hidden sm:inline">Memory</span>}
                </button>
                
                {/* MCP 工具栏 - 每个服务器单独的图标 */}
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

                {/* Model Info / Status with Custom Dropdown */}
                {petInfo && (
                    <div className="relative ml-2">
                        {/* Trigger Button */}
                        <div 
                            onClick={() => setShowModelSelector(prev => !prev)}
                            className={`px-2 py-1 rounded-md text-xs font-medium text-gray-500 flex flex-col justify-center select-none min-w-[60px] cursor-pointer transition-all duration-150 ${
                                showModelSelector 
                                    ? 'bg-gray-300/70 scale-[0.98]' 
                                    : 'bg-gray-200/50 hover:bg-gray-300/50'
                            }`}
                        >
                            <div className="font-bold text-gray-600 leading-tight truncate max-w-[100px] flex items-center gap-1">
                                {petInfo.name}
                                <svg className={`w-2.5 h-2.5 text-gray-400 transition-transform duration-200 ${showModelSelector ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                            </div>
                            <div className="text-[10px] text-gray-400 leading-tight truncate max-w-[100px] flex items-center gap-1">
                                {isGenerating ? (
                                    <span className="animate-pulse text-gray-500">Thinking...</span>
                                ) : (
                                    <span>{overrideModel ? overrideModel.modelName : (petInfo.modelName || "3.0")}</span>
                                )}
                            </div>
                        </div>

                        {/* Custom Popover Menu */}
                        {showModelSelector && (
                            <>
                                {/* Backdrop to close menu */}
                                <div 
                                    className="fixed inset-0 z-40" 
                                    onClick={() => setShowModelSelector(false)}
                                />
                                {/* Menu */}
                                <div className="absolute bottom-full right-0 mb-2 w-64 max-h-[min(320px,50vh)] overflow-y-auto bg-white/95 backdrop-blur-md border border-gray-100 rounded-xl shadow-xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                                    {/* Default Option */}
                                    <div className="p-1.5">
                                        <div
                                            onClick={() => {
                                                setOverrideModel(null);
                                                setShowModelSelector(false);
                                            }}
                                            className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                                                !overrideModel 
                                                    ? 'bg-blue-50 text-blue-600' 
                                                    : 'hover:bg-gray-50 text-gray-700'
                                            }`}
                                        >
                                            <span className="text-xs font-medium truncate">{petInfo.modelName || "Default"}</span>
                                            {!overrideModel && (
                                                <svg className="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                                </svg>
                                            )}
                                        </div>
                                    </div>

                                    {/* Divider */}
                                    {visibleModelsByProvider.length > 0 && <div className="border-t border-gray-100 mx-2" />}

                                    {/* Provider Groups */}
                                    {visibleModelsByProvider.map(provider => {
                                        return (
                                            <div key={provider._id || provider.name} className="p-1.5">
                                                <div className="text-[10px] text-gray-400 font-bold px-3 py-1 uppercase tracking-wide">
                                                    {provider.name}
                                                </div>
                                                {provider.visibleModels.map(model => {
                                                    const modelName = typeof model === 'string' ? model : model.name;
                                                    const isSelected = overrideModel && 
                                                        overrideModel._sourceId === provider._id && 
                                                        overrideModel.modelName === modelName;
                                                    return (
                                                        <div
                                                            key={`${provider._id}:${modelName}`}
                                                            onClick={() => {
                                                                setOverrideModel({
                                                                    modelName: modelName,
                                                                    modelUrl: provider.baseUrl,
                                                                    modelApiKey: provider.apiKey,
                                                                    apiFormat: provider.apiFormat || 'openai_compatible',
                                                                    modelProvider: provider.name,
                                                                    _sourceId: provider._id
                                                                });
                                                                setShowModelSelector(false);
                                                            }}
                                                            className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                                                                isSelected 
                                                                    ? 'bg-blue-50 text-blue-600' 
                                                                    : 'hover:bg-gray-50 text-gray-700'
                                                            }`}
                                                        >
                                                            <span className="text-xs font-medium truncate">{modelName}</span>
                                                            {isSelected && (
                                                                <svg className="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                                                </svg>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })}

                                    {/* Empty State */}
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
            </div>

            {/* Right: Quick Reply & Send */}
            <div className="flex items-center gap-2">
                {/* Quick Reply Button */}
                <div 
                    className="relative"
                    onMouseEnter={handleReplyOptionsEnter}
                    onMouseLeave={handleReplyOptionsLeave}
                >
                    <button
                        onClick={() => setShowReplyOptions(prev => !prev)}
                        className="p-2 rounded-full hover:bg-gray-300/50 transition-colors text-gray-400"
                    >
                        <SiQuicktype className="w-5 h-5" style={{ color:(suggestText.length == 0) ? "#c1c1c1" : "#555" }} />
                    </button>
                    
                    {showReplyOptions && suggestText.length !== 0 && (
                        <div 
                            className="absolute bottom-full right-0 mb-2 w-48 bg-white border border-gray-200 rounded-xl shadow-xl p-2 z-50"
                            onMouseEnter={handleReplyOptionsEnter}
                            onMouseLeave={handleReplyOptionsLeave}
                        >
                        <div className="font-bold mb-2 text-xs text-gray-400 px-1">Quick reply</div>
                        <ul className="space-y-1">
                            {suggestText.map((item, index) => (
                            <li key={index} className="cursor-pointer hover:bg-gray-100 p-2 rounded-lg text-xs text-gray-700 transition-colors"
                            onClick={() => {
                                setUserText(userText + suggestText[index]);
                                setShowReplyOptions(false);
                            }}>
                                {item}
                            </li>
                            ))}
                        </ul>
                        </div>
                    )}
                </div>

                {/* Send Button */}
                <button
                    onClick={isGenerating ? handleStop : handleSend}
                    disabled={!String(userText).trim() && !isGenerating && !(userMessages.length > 0 && userMessages[userMessages.length - 1].role === 'user')}
                    className={`p-2.5 rounded-full transition-all duration-100 transform ${
                        buttonAnimating ? 'scale-0' : 'scale-100'
                    } ${
                        !String(userText).trim() && !isGenerating && !(userMessages.length > 0 && userMessages[userMessages.length - 1].role === 'user')
                        ? "bg-gray-400 cursor-not-allowed" 
                        : "bg-black hover:bg-gray-900 shadow-lg"
                    }`}
                >
                    {!isGenerating ? (
                    <FaArrowUp className="w-4 h-4 text-white" />
                    ) : (
                    <FaStop className="w-4 h-4 text-white" />
                    )}
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};

export default ChatboxInputBox;