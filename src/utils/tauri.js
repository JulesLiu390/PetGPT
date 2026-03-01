/**
 * Tauri API 直接调用层
 * 
 * 移除了 Electron 兼容代码，直接使用 @tauri-apps/api
 * 所有函数都是对 Rust 命令的直接封装
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { ask, open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { readTextFile } from '@tauri-apps/plugin-fs';

// ==================== Dialog ====================

export const confirm = async (message, options = {}) => {
  try {
    return await ask(message, {
      title: options.title || 'PetGPT',
      kind: 'warning',
      okLabel: 'Yes',
      cancelLabel: 'No',
    });
  } catch (err) {
    console.error('[tauri.confirm] Dialog error:', err);
    return window.confirm(message);
  }
};

/**
 * 打开文件选择对话框
 * @param {Object} options - 选项
 * @param {Array<{name: string, extensions: string[]}>} options.filters - 文件过滤器
 * @param {boolean} options.multiple - 是否允许多选
 * @param {boolean} options.directory - 是否选择目录
 * @returns {Promise<string|string[]|null>} 选择的文件路径
 */
export const selectFile = async (options = {}) => {
  try {
    const result = await dialogOpen({
      filters: options.filters,
      multiple: options.multiple || false,
      directory: options.directory || false,
    });
    return result;
  } catch (err) {
    console.error('[tauri.selectFile] Dialog error:', err);
    throw err;
  }
};

/**
 * 读取文本文件内容
 * @param {string} path - 文件路径
 * @returns {Promise<string>} 文件内容
 */
export const readFile = async (path) => {
  try {
    return await readTextFile(path);
  } catch (err) {
    console.error('[tauri.readFile] Read error:', err);
    throw err;
  }
};

/**
 * 选择目录
 * @returns {Promise<string|null>} 选择的目录路径
 */
export const selectDirectory = async () => {
  try {
    const result = await dialogOpen({
      directory: true,
      multiple: false,
    });
    return result;
  } catch (err) {
    console.error('[tauri.selectDirectory] Dialog error:', err);
    throw err;
  }
};

// ==================== Settings ====================

// 检测平台，决定默认修饰键
const isMacOS = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || 
                navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
const MOD_KEY = isMacOS ? 'Cmd' : 'Ctrl';

const DEFAULT_SETTINGS = {
  windowSize: 'medium',
  defaultAssistant: '',
  programHotkey: 'Shift + Space',
  dialogHotkey: 'Alt + Space',
  screenshotHotkey: 'Cmd + Shift + A',
  launchAtStartup: false,
  theme: 'light',
  moodResetDelay: 30,  // 表情恢复到 normal 的延迟时间（秒）
  // Chat Tab 快捷键（窗口内快捷键）- 根据平台自动选择 Ctrl/Cmd
  newTabHotkey: `${MOD_KEY} + N`,
  closeTabHotkey: `${MOD_KEY} + W`,
  switchTabPrefix: MOD_KEY,  // 切换标签页前缀，按下此键 + 数字(1-9)切换
  // 截图快捷 Prompt 配置
  screenshotPrompts: [
    { id: 'ocr', name: 'OCR 识别', prompt: '请识别图片中的所有文字，保持原有格式输出', icon: '🔍' },
    { id: 'describe', name: '描述图片', prompt: '请详细描述这张图片的内容', icon: '📝' },
    { id: 'code', name: '分析代码', prompt: '请分析这段代码截图，指出潜在问题并给出改进建议', icon: '💻' },
    { id: 'translate', name: '翻译文字', prompt: '请翻译图片中的文字为中文', icon: '🌐' },
  ],
  defaultScreenshotPrompt: null, // null = 显示选择器, 'id' = 直接使用该 prompt
};

export const getSettings = async () => {
  const settings = await invoke('get_all_settings');
  const result = settings.reduce((acc, s) => {
    try {
      acc[s.key] = JSON.parse(s.value);
    } catch {
      acc[s.key] = s.value;
    }
    return acc;
  }, {});
  return { ...DEFAULT_SETTINGS, ...result };
};

export const updateSettings = async (data) => {
  for (const [key, value] of Object.entries(data)) {
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    await invoke('set_setting', { key, value: strValue });
    await invoke('emit_to_all', { 
      event: 'settings-updated', 
      payload: { key, value } 
    });
  }
  return data;
};

export const onSettingsUpdated = (callback) => {
  let unlisten = null;
  listen('settings-updated', (event) => {
    callback(event.payload);
  }).then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

// ==================== Assistants/Pets ====================

export const getPets = () => invoke('get_pets');
export const getPet = (id) => invoke('get_pet', { id });
export const createPet = (data) => invoke('create_pet', { data });
export const updatePet = (id, data) => invoke('update_pet', { id, data });
export const deletePet = (id) => invoke('delete_pet', { id });

// Alias for consistency
export const getAssistants = getPets;
export const getAssistant = getPet;
export const createAssistant = createPet;
export const updateAssistant = updatePet;
export const deleteAssistant = deletePet;

// ==================== Conversations ====================

export const getConversations = async () => {
  const pets = await getPets();
  const allConversations = [];
  for (const pet of pets) {
    const convs = await invoke('get_conversations_by_pet', { petId: pet._id });
    allConversations.push(...convs.map(c => ({ ...c, petName: pet.name })));
  }
  // 全局按 updated_at 降序排列，确保最新对话始终在最前面
  allConversations.sort((a, b) => {
    const timeA = a.updatedAt || a.updated_at || '';
    const timeB = b.updatedAt || b.updated_at || '';
    return timeB.localeCompare(timeA);
  });
  return allConversations;
};

export const getConversationsByPet = (petId) => invoke('get_conversations_by_pet', { petId });
export const getConversationById = (id) => invoke('get_conversation', { id });

/**
 * 搜索对话（标题+消息内容）
 * @param {string} query - 搜索关键词
 * @returns {Promise<Array>} 搜索结果数组，每项含 conversation, matchType, snippet, messageRole
 */
export const searchConversations = async (query) => {
  if (!query || !query.trim()) return [];
  const results = await invoke('search_conversations', { query: query.trim() });
  // 为每个结果补充 petName
  const pets = await getPets();
  const petMap = Object.fromEntries(pets.map(p => [p._id, p.name]));
  return results.map(r => ({
    ...r,
    conversation: {
      ...r.conversation,
      petName: petMap[r.conversation.petId] || '未知角色',
    },
  }));
};

/**
 * 获取会话及其消息历史
 * @param {string} id - 会话 ID
 * @returns {Promise<Object>} 包含 history 字段的会话对象
 */
export const getConversationWithHistory = async (id) => {
  const conv = await invoke('get_conversation', { id });
  if (!conv) return null;
  
  const messages = await invoke('get_messages', { conversationId: id });
  // 解析消息内容 (如果是 JSON 字符串)
  const parsedMessages = (messages || []).map(msg => ({
    ...msg,
    content: typeof msg.content === 'string' && msg.content.startsWith('[') 
      ? JSON.parse(msg.content) 
      : msg.content,
    toolCallHistory: msg.toolCallHistory 
      ? (typeof msg.toolCallHistory === 'string' ? JSON.parse(msg.toolCallHistory) : msg.toolCallHistory)
      : undefined
  }));
  
  return { ...conv, history: parsedMessages };
};

export const createConversation = async (data) => {
  const conv = await invoke('create_conversation', { data });
  return conv;
};

export const updateConversation = async (id, data) => {
  console.log('[tauri.js updateConversation] ★★★ called with id=', id, 'title=', data.title, 'historyLength=', data.history?.length);
  // Handle title update
  if (data.title !== undefined) {
    console.log('[tauri.js updateConversation] updating title to:', data.title);
    await invoke('update_conversation_title', { id, title: data.title });
  }
  // Handle history update - save each message
  if (data.history) {
    console.log('[tauri.js updateConversation] clearing old messages for convId=', id);
    await invoke('clear_conversation_messages', { conversationId: id });
    console.log('[tauri.js updateConversation] saving', data.history.length, 'messages to convId=', id);
    for (let i = 0; i < data.history.length; i++) {
      const msg = data.history[i];
      const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      console.log(`[tauri.js updateConversation] saving msg[${i}] role=${msg.role} content_len=${contentStr.length} to convId=${id}`);
      await invoke('create_message', {
        data: {
          conversationId: id,
          role: msg.role,
          content: contentStr,
          toolCallHistory: msg.toolCallHistory ? JSON.stringify(msg.toolCallHistory) : null,
        }
      });
    }
    console.log('[tauri.js updateConversation] ✅ all', data.history.length, 'messages saved to convId=', id);
    // 🔍 保存后立即回读验证
    const verifyMessages = await invoke('get_messages', { conversationId: id });
    console.log(`[tauri.js updateConversation] 🔍 VERIFY: DB中实际有 ${verifyMessages.length} 条消息 (convId=${id})`);
    if (verifyMessages.length !== data.history.length) {
      console.error(`[tauri.js updateConversation] ❌ 数据不一致! 写入=${data.history.length} 读回=${verifyMessages.length}`);
    }
  } else {
    console.log('[tauri.js updateConversation] ⚠️ NO history provided, skipping message save');
  }
  const result = await invoke('get_conversation', { id });
  console.log('[tauri.js updateConversation] final conversation:', result?._id || result?.id, 'messageCount=', result?.messageCount);
  return result;
};

export const deleteConversation = (id) => invoke('delete_conversation', { id });
export const getOrphanConversations = () => invoke('get_orphan_conversations');
export const transferConversation = (conversationId, newPetId) => 
  invoke('transfer_conversation', { conversationId, newPetId });
export const transferAllConversations = (oldPetId, newPetId) => 
  invoke('transfer_all_conversations', { oldPetId, newPetId });

// ==================== Messages ====================

export const getMessages = (conversationId) => invoke('get_messages', { conversationId });

export const createMessage = (conversationId, role, content, toolCallHistory = null) => 
  invoke('create_message', {
    data: {
      conversationId,
      role,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      toolCallHistory: toolCallHistory ? JSON.stringify(toolCallHistory) : null,
    }
  });

// ==================== Tab State (Rust-owned) ====================

export const getTabState = (conversationId) => 
  invoke('get_tab_state', { conversationId });

export const initTabMessages = (conversationId, messages) => 
  invoke('init_tab_messages', { conversationId, messages });

export const setTabStateMessages = (conversationId, messages) => 
  invoke('set_tab_state_messages', { conversationId, messages });

export const pushTabMessage = (conversationId, message) => 
  invoke('push_tab_message', { conversationId, message });

export const updateTabStateMessage = (conversationId, index, message) => 
  invoke('update_tab_state_message', { conversationId, index, message });

export const deleteTabStateMessage = (conversationId, index) => 
  invoke('delete_tab_state_message', { conversationId, index });

export const setTabThinking = (conversationId, isThinking) => 
  invoke('set_tab_thinking', { conversationId, isThinking });

export const clearTabState = (conversationId) => 
  invoke('clear_tab_state', { conversationId });

export const subscribeTabState = async (conversationId, callback) => {
  const eventName = `tab-state:${conversationId}`;
  return listen(eventName, (event) => callback(event.payload));
};

// ==================== LLM ====================

/**
 * 非流式 LLM 调用
 * @param {Object} request - LLM 请求配置
 * @param {string} request.baseUrl - API 基础 URL
 * @param {string} request.apiKey - API 密钥
 * @param {string} request.model - 模型名称
 * @param {string} request.apiFormat - API 格式: 'openai_compatible' | 'gemini_official'
 * @param {Array} request.messages - 消息数组
 * @param {Array} [request.tools] - 可选的工具定义
 * @param {number} [request.temperature] - 可选温度参数
 * @param {number} [request.maxTokens] - 可选最大 token 数
 * @param {string} [request.systemPrompt] - 可选系统提示
 * @returns {Promise<Object>} LLM 响应
 */
export const llmCall = (request) => invoke('llm_call', { request });

/**
 * LLM HTTP 代理调用（social agent 专用）
 * 通过 Rust 侧 reqwest 发送，自带 90s 超时 + 并发控制（最多 2 个同时请求）
 * @param {string} endpoint - 完整 API URL
 * @param {Object} headers - HTTP 请求头
 * @param {Object} body - JSON 请求体（已由 JS adapter 构建好）
 * @returns {Promise<Object>} 原始 API JSON 响应
 */
export const llmProxyCall = (endpoint, headers, body) => {
  // JSON.stringify (ES2019) 会把孤立 surrogate 转义为字面文本 \ud83e，
  // serde_json 遇到 \uD800-\uDBFF 后找不到配对的 \uDC00-\uDFFF 就报
  // "unexpected end of hex escape" → 在 JSON 文本层面替换为 \ufffd
  const jsonStr = JSON.stringify(body)
    .replace(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/gi, '\\ufffd')
    .replace(/(?<!\\ud[89ab][0-9a-f]{2})\\ud[cdef][0-9a-f]{2}/gi, '\\ufffd');
  const bytes = new TextEncoder().encode(jsonStr);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const bodyB64 = btoa(binary);
  return invoke('llm_proxy_call', { endpoint, headers, bodyB64 });
};

/**
 * 流式 LLM 调用 - 通过事件推送响应块
 * @param {Object} request - LLM 请求配置 (同 llmCall)
 * @returns {Promise<Object>} 完整响应
 */
export const llmStream = (request) => invoke('llm_stream', { request });

/**
 * 取消指定会话的 LLM 流
 * @param {string} conversationId - 对话 ID
 */
export const llmCancelStream = (conversationId) => invoke('llm_cancel_stream', { conversationId });

/**
 * 取消所有 LLM 流
 */
export const llmCancelAllStreams = () => invoke('llm_cancel_all_streams');

/**
 * 重置指定会话的取消状态
 * @param {string} conversationId - 对话 ID
 */
export const llmResetCancellation = (conversationId) => invoke('llm_reset_cancellation', { conversationId });

/**
 * 订阅 LLM 流式响应
 * @param {string} conversationId - 对话 ID
 * @param {Function} callback - 回调函数，接收 StreamChunk
 * @returns {Promise<Function>} 取消订阅函数
 */
export const subscribeLlmStream = async (conversationId, callback) => {
  const eventName = `llm-chunk:${conversationId}`;
  return listen(eventName, (event) => callback(event.payload));
};

// ==================== API Providers ====================

export const getApiProviders = () => invoke('get_api_providers');
export const getApiProvider = (id) => invoke('get_api_provider', { id });
export const createApiProvider = (data) => invoke('create_api_provider', { data });
export const updateApiProvider = (id, data) => invoke('update_api_provider', { id, data });
export const deleteApiProvider = (id) => invoke('delete_api_provider', { id });

// ==================== Skins ====================

export const getSkins = () => invoke('get_skins');
export const getSkinsWithHidden = () => invoke('get_skins_with_hidden');
export const getSkin = (id) => invoke('get_skin', { id });
export const getSkinByName = (name) => invoke('get_skin_by_name', { name });
export const createSkin = (data) => invoke('create_skin', { data });
export const updateSkin = (id, data) => invoke('update_skin', { id, data });
export const deleteSkin = (id) => invoke('delete_skin', { id });
export const hideSkin = (id) => invoke('hide_skin', { id });
export const restoreSkin = (id) => invoke('restore_skin', { id });
export const importSkin = (jsonPath) => invoke('import_skin', { jsonPath });
export const validateSkinFolder = (folderPath) => invoke('validate_skin_folder', { folderPath });
export const importSkinFromFolder = (folderPath, skinName, author = null, description = null) => 
  invoke('import_skin_from_folder', { folderPath, skinName, author, description });
export const exportSkin = (skinId, exportDir) => invoke('export_skin', { skinId, exportDir });
export const readSkinImage = (skinId, mood) => invoke('read_skin_image', { skinId, mood });

// ==================== MCP Servers ====================

export const mcp = {
  getServers: () => invoke('get_mcp_servers'),
  listServers: () => invoke('get_mcp_servers'), // 别名，兼容 useMcpTools.js
  getServer: (id) => invoke('get_mcp_server', { id }),
  getServerByName: (name) => invoke('get_mcp_server_by_name', { name }),
  createServer: (data) => invoke('create_mcp_server', { data }),
  updateServer: (id, data) => invoke('update_mcp_server', { id, data }),
  deleteServer: (id) => invoke('delete_mcp_server', { id }),
  
  // Runtime
  startServer: (id) => invoke('mcp_start_server', { serverId: id }),
  stopServer: (id) => invoke('mcp_stop_server', { serverId: id }),
  restartServer: (id) => invoke('mcp_restart_server', { serverId: id }),
  getServerStatus: (id) => invoke('mcp_get_server_status', { serverId: id }),
  getAllStatuses: () => invoke('mcp_get_all_statuses'),
  getAllTools: () => invoke('mcp_get_all_tools'),
  callTool: (serverId, toolName, args) => 
    invoke('mcp_call_tool', { serverId, toolName, arguments: args }),
  // 通过完整工具名（格式：ServerName__tool_name）调用工具
  // 需要先查找 serverId
  callToolByName: async (fullToolName, args) => {
    console.log('[MCP] callToolByName:', fullToolName, args);
    const parts = fullToolName.split('__');
    if (parts.length < 2) {
      throw new Error(`Invalid tool name format: ${fullToolName}. Expected: ServerName__tool_name`);
    }
    const serverName = parts[0];
    const toolName = parts.slice(1).join('__'); // 工具名本身可能包含 __
    
    // 根据 serverName 查找 serverId
    console.log('[MCP] Looking up server by name:', serverName);
    const server = await invoke('get_mcp_server_by_name', { name: serverName });
    console.log('[MCP] Server lookup result:', server);
    if (!server) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    
    // 注意：Rust 端 id 字段序列化为 _id
    console.log('[MCP] Calling mcp_call_tool with serverId:', server._id, 'toolName:', toolName);
    return invoke('mcp_call_tool', { serverId: server._id, toolName, arguments: args });
  },
  isServerRunning: (id) => invoke('mcp_is_server_running', { serverId: id }),
  testServer: (config) => invoke('mcp_test_server', { 
    transport: config.transport || 'stdio',
    command: config.command || null,
    args: config.args || null,
    env: config.env || null,
    url: config.url || null,
    apiKey: config.apiKey || null,
  }),
  cancelAllToolCalls: () => invoke('mcp_cancel_all_tool_calls'),
  resetCancellation: () => invoke('mcp_reset_cancellation'),
  setSamplingConfig: (serverId, config) => invoke('mcp_set_sampling_config', { serverId, config }),
};

// ==================== File Operations ====================

export const saveFile = ({ fileName, fileData, mimeType }) => invoke('save_file', { fileName, fileData, mimeType });
export const readUpload = (fileName) => invoke('read_upload', { fileName });
export const getUploadsPath = () => invoke('get_uploads_path');

/**
 * 通过 Rust 后端下载 URL 并返回 base64（绕过浏览器 CORS 限制）
 * @param {string} url - 要下载的 URL
 * @returns {Promise<{data: string, mime_type: string}>} base64 数据和 MIME 类型
 */
export const downloadUrlAsBase64 = (url) => invoke('download_url_as_base64', { url });

/**
 * 通过 Rust image crate 将 GIF 转为 PNG（跨平台，无需 OffscreenCanvas）
 * @param {string} base64Data - 纯 base64 字符串（不带 data: 前缀）
 * @returns {Promise<{data: string, mime_type: string}>} PNG base64 数据
 */
export const convertGifToPng = (base64Data) => invoke('convert_gif_to_png', { base64Data });

// ==================== Screenshot ====================

/**
 * 打开截图选择窗口（全屏透明覆盖层）
 * 用户拖动选择区域后，需要调用 captureRegion 来实际截图
 */
export const takeScreenshot = () => invoke('take_screenshot');

/**
 * 截取指定区域的屏幕
 * @param {number} x - 区域左上角 X 坐标（逻辑坐标）
 * @param {number} y - 区域左上角 Y 坐标（逻辑坐标）
 * @param {number} width - 区域宽度
 * @param {number} height - 区域高度
 * @returns {Promise<{imageBase64: string, path: string, name: string}>} 截图结果
 */
export const captureRegion = (x, y, width, height) => 
  invoke('capture_region', { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });

// ==================== Window Management ====================

export const showChatWindow = () => invoke('show_chat_window');
export const hideChatWindow = () => invoke('hide_chat_window');
export const toggleChatWindow = () => invoke('toggle_chat_window');
export const maximizeChatWindow = () => invoke('maximize_chat_window');
export const toggleSidebar = (expanded) => invoke('toggle_sidebar', { expanded });

export const minimizeWindow = (label) => invoke('minimize_window', { label });
export const maximizeWindow = (label) => invoke('maximize_window', { label });
export const closeWindow = (label) => invoke('close_window', { label });

export const getWindowPosition = (label) => invoke('get_window_position', { label });
export const setWindowPosition = (label, x, y) => invoke('set_window_position', { label, x, y });
export const getWindowSize = (label) => invoke('get_window_size', { label });
export const setWindowSize = (label, width, height) => invoke('set_window_size', { label, width, height });
export const getScreenSize = () => invoke('get_screen_size');

// Page navigation
export const openPageInChat = (page) => invoke('open_page_in_chat', { page });
export const openSettingsWindow = () => invoke('open_settings_window');
export const openManageWindow = () => invoke('open_manage_window');
export const openManageWindowWithTab = (tab) => invoke('open_manage_window_with_tab', { tab });
export const hideManageWindow = () => invoke('hide_manage_window');
export const hideSettingsWindow = () => invoke('hide_settings_window');
export const openSocialWindow = () => invoke('open_social_window');
export const hideSocialWindow = () => invoke('hide_social_window');

/**
 * 隐藏指定窗口
 * @param {string} label - 窗口标签
 */
export const hideWindow = async (label) => {
  const { getCurrentWindow, Window } = await import('@tauri-apps/api/window');
  if (label) {
    const win = new Window(label);
    await win.hide();
  } else {
    await getCurrentWindow().hide();
  }
};

// Shortcuts
export const updateWindowSizePreset = (preset) => invoke('update_window_size_preset', { preset });
export const updateShortcuts = (programHotkey, dialogHotkey, screenshotHotkey = '') => 
  invoke('update_shortcuts', { shortcut1: programHotkey, shortcut2: dialogHotkey, shortcut3: screenshotHotkey });

// Preferences
export const updatePreferences = (preferences) => invoke('update_preferences', { preferences });

// ==================== Events ====================

export const sendCharacterId = (id) => 
  invoke('emit_to_all', { event: 'character-id', payload: id });

/**
 * 广播事件到所有窗口
 * @param {string} event - 事件名称
 * @param {any} payload - 事件数据
 */
export const emitToAll = (event, payload) => 
  invoke('emit_to_all', { event, payload });

// 获取待处理的 character-id（用于 chat 窗口启动时检查）
export const getPendingCharacterId = () => invoke('get_pending_character_id');

// 设置 vibrancy 效果（macOS）
export const setVibrancyEnabled = (enabled) => invoke('set_vibrancy_enabled', { enabled });

export const onCharacterId = (callback) => {
  let unlisten = null;
  const readyPromise = listen('character-id', (event) => callback(event.payload))
    .then(fn => { unlisten = fn; });
  const cleanup = () => { if (unlisten) unlisten(); };
  cleanup.ready = readyPromise;
  return cleanup;
};

export const sendConversationId = (id) => 
  invoke('emit_to_all', { event: 'conversation-id', payload: id });

export const onConversationId = (callback) => {
  let unlisten = null;
  const readyPromise = listen('conversation-id', (event) => callback(event.payload))
    .then(fn => { unlisten = fn; });
  const cleanup = () => { if (unlisten) unlisten(); };
  cleanup.ready = readyPromise;
  return cleanup;
};

export const sendMoodUpdate = async (mood, conversationId) => {
  await invoke('emit_to_all', {
    event: 'character-mood-updated',
    payload: { mood, conversationId }
  });
};

export const onMoodUpdated = (callback) => {
  let unlisten = null;
  listen('character-mood-updated', (event) => {
    const { mood, conversationId } = event.payload;
    callback(null, mood, conversationId);
  }).then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

export const sendPetsUpdate = (eventData = {}) => 
  invoke('emit_to_all', { event: 'pets-updated', payload: eventData });

export const onPetsUpdated = (callback) => {
  let unlisten = null;
  listen('pets-updated', (event) => callback(event.payload))
    .then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

export const sendApiProvidersUpdate = (eventData = {}) => 
  invoke('emit_to_all', { event: 'api-providers-updated', payload: eventData });

export const onApiProvidersUpdated = (callback) => {
  let unlisten = null;
  listen('api-providers-updated', (event) => callback(event.payload))
    .then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

export const onManageWindowVisibilityChanged = (callback) => {
  let unlisten = null;
  listen('manage-window-vis-change', (event) => callback(event.payload))
    .then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

export const onChatWindowVisibilityChanged = (callback) => {
  let unlisten = null;
  listen('chat-window-vis-change', (event) => callback(event.payload))
    .then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

export const onChatbodyStatusUpdated = (callback) => {
  let unlisten = null;
  listen('chatbody-status', (event) => {
    const { status, conversationId } = event.payload || {};
    callback(status, conversationId);
  }).then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

// ==================== External ====================

export const openExternal = (url) => shellOpen(url);
export const openFileExternal = (path) => shellOpen(`file://${path}`);

// ==================== Missing Functions (from bridge.js) ====================

// Pet Memory
export const getPetUserMemory = async (petId) => {
  const pet = await getPet(petId);
  // userMemory 存储为 JSON 字符串，解析为对象返回
  if (pet?.userMemory) {
    try {
      return JSON.parse(pet.userMemory);
    } catch {
      return {};
    }
  }
  return {};
};

export const updatePetUserMemory = async (petId, key, value) => {
  // 获取现有记忆
  const existingMemory = await getPetUserMemory(petId);
  // 合并新的键值对
  const updatedMemory = {
    ...existingMemory,
    [key]: value
  };
  // 将对象序列化为 JSON 字符串存储
  return updatePet(petId, { userMemory: JSON.stringify(updatedMemory) });
};

// ==================== Workspace (File-based Personality/Memory) ====================

export const workspaceRead = async (petId, path) => {
  return invoke('workspace_read', { petId, path });
};

export const workspaceWrite = async (petId, path, content) => {
  return invoke('workspace_write', { petId, path, content });
};

export const workspaceEdit = async (petId, path, oldText, newText) => {
  return invoke('workspace_edit', { petId, path, oldText, newText });
};

export const workspaceEnsureDefaultFiles = async (petId, petName) => {
  return invoke('workspace_ensure_default_files', { petId, petName });
};

export const workspaceFileExists = async (petId, path) => {
  return invoke('workspace_file_exists', { petId, path });
};

export const workspaceGetPath = async (petId, path, ensureExists = false) => {
  return invoke('workspace_get_path', { petId, path, ensureExists });
};

export const workspaceOpenFile = async (petId, path, defaultContent = '') => {
  return invoke('workspace_open_file', { petId, path, defaultContent });
};

// Model Configs (alias to pets with model type)
export const getModelConfigs = async () => {
  const pets = await getPets();
  return pets.filter(p => p.type === 'model' || (p.apiFormat && !p.modelConfigId));
};

export const getModelConfig = async (id) => {
  return getPet(id);
};

// Chatbody status
export const updateChatbodyStatus = async (status, conversationId) => {
  await invoke('emit_to_all', {
    event: 'chatbody-status',
    payload: { status, conversationId }
  });
};

// MCP Settings window
export const openMcpSettings = () => openManageWindowWithTab('mcp');

// Window mouse enter/leave events (works even when window is not focused)
export const onWindowMouseEnter = async (callback) => {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    return appWindow.onMouseEnter(callback);
  } catch (err) {
    console.error('[tauri.onWindowMouseEnter] Error:', err);
    return () => {};
  }
};

export const onWindowMouseLeave = async (callback) => {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    return appWindow.onMouseLeave(callback);
  } catch (err) {
    console.error('[tauri.onWindowMouseLeave] Error:', err);
    return () => {};
  }
};

// New chat created event
export const onNewChatCreated = (callback) => {
  let unlisten = null;
  listen('new-chat-created', (event) => callback(event.payload))
    .then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

// Skins events
export const sendSkinsUpdate = () => 
  invoke('emit_to_all', { event: 'skins-updated', payload: {} });

export const onSkinsUpdated = (callback) => {
  let unlisten = null;
  listen('skins-updated', () => callback())
    .then(fn => { unlisten = fn; });
  return () => { if (unlisten) unlisten(); };
};

// Pet Image reading
export const readPetImage = async (petId, imageType = 'normal') => {
  // Check if it's a built-in skin first
  const pet = await getPet(petId);
  if (pet?.skinId) {
    return readSkinImage(pet.skinId, imageType);
  }
  // Fallback to default
  return null;
};

// Character window dragging - use Tauri's window API
export const startDragging = async () => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const window = getCurrentWindow();
  return window.startDragging();
};

// Change manage window (alias)
export const changeManageWindow = openManageWindow;

// API providers object (for legacy compat)
export const apiProviders = {
  getAll: getApiProviders,
  get: getApiProvider,
  create: createApiProvider,
  update: updateApiProvider,
  delete: deleteApiProvider,
};

// Re-export listen for direct use
export { listen } from '@tauri-apps/api/event';

// ==================== Legacy Aliases (for gradual migration) ====================
// These will be removed after full migration

export const changeChatWindow = showChatWindow;
export const changeSelectCharacterWindow = () => openManageWindowWithTab('assistants');
export const changeSettingsWindow = () => openManageWindowWithTab('defaults');
export const changeMcpWindow = () => openManageWindowWithTab('mcp');
export const changeApiWindow = () => openManageWindowWithTab('api');
export const hideApiWindow = hideManageWindow;
export const hideSelectCharacterWindow = hideManageWindow;
export const hideMcpWindow = hideManageWindow;
export const maxmizeChatWindow = maximizeChatWindow; // Typo alias for backwards compat

// ==================== Default Export ====================

const tauri = {
  // Dialog
  confirm,
  selectFile,
  selectDirectory,
  readFile,
  
  // Settings
  getSettings,
  updateSettings,
  onSettingsUpdated,
  
  // Assistants
  getPets,
  getPet,
  createPet,
  updatePet,
  deletePet,
  getAssistants,
  getAssistant,
  createAssistant,
  updateAssistant,
  deleteAssistant,
  
  // Conversations
  getConversations,
  getConversationsByPet,
  getConversationById,
  getConversationWithHistory,
  createConversation,
  updateConversation,
  deleteConversation,
  getOrphanConversations,
  transferConversation,
  transferAllConversations,
  searchConversations,
  
  // Messages
  getMessages,
  createMessage,
  
  // Tab State
  getTabState,
  initTabMessages,
  setTabStateMessages,
  pushTabMessage,
  updateTabStateMessage,
  deleteTabStateMessage,
  setTabThinking,
  clearTabState,
  subscribeTabState,
  
  // LLM
  llmCall,
  llmStream,
  llmCancelStream,
  llmCancelAllStreams,
  llmResetCancellation,
  subscribeLlmStream,
  
  // API Providers
  getApiProviders,
  getApiProvider,
  createApiProvider,
  updateApiProvider,
  deleteApiProvider,
  
  // Skins
  getSkins,
  getSkinsWithHidden,
  getSkin,
  getSkinByName,
  createSkin,
  updateSkin,
  deleteSkin,
  hideSkin,
  restoreSkin,
  importSkin,
  validateSkinFolder,
  importSkinFromFolder,
  exportSkin,
  readSkinImage,
  
  // MCP
  mcp,
  
  // File Operations
  saveFile,
  readUpload,
  getUploadsPath,
  
  // Window Management
  showChatWindow,
  hideChatWindow,
  toggleChatWindow,
  maximizeChatWindow,
  toggleSidebar,
  minimizeWindow,
  maximizeWindow,
  closeWindow,
  getWindowPosition,
  setWindowPosition,
  getWindowSize,
  setWindowSize,
  getScreenSize,
  openPageInChat,
  openSettingsWindow,
  openManageWindow,
  openManageWindowWithTab,
  hideManageWindow,
  hideSettingsWindow,
  updateWindowSizePreset,
  updateShortcuts,
  updatePreferences,
  
  // Events
  sendCharacterId,
  getPendingCharacterId,
  setVibrancyEnabled,
  onCharacterId,
  sendConversationId,
  onConversationId,
  sendMoodUpdate,
  onMoodUpdated,
  sendPetsUpdate,
  onPetsUpdated,
  sendApiProvidersUpdate,
  onApiProvidersUpdated,
  onManageWindowVisibilityChanged,
  onChatWindowVisibilityChanged,
  onChatbodyStatusUpdated,
  
  // External
  openExternal,
  openFileExternal,
  
  // Pet Memory
  getPetUserMemory,
  updatePetUserMemory,
  
  // Model Configs
  getModelConfigs,
  getModelConfig,
  
  // Status
  updateChatbodyStatus,
  
  // MCP Settings
  openMcpSettings,
  
  // Window mouse events
  onWindowMouseEnter,
  onWindowMouseLeave,
  
  // New chat event
  onNewChatCreated,
  
  // Skins events
  sendSkinsUpdate,
  onSkinsUpdated,
  
  // Pet Image
  readPetImage,
  
  // Workspace (File-based Personality/Memory)
  workspaceRead,
  workspaceWrite,
  workspaceEdit,
  workspaceEnsureDefaultFiles,
  workspaceFileExists,
  workspaceGetPath,
  workspaceOpenFile,
  
  // Dragging
  startDragging,
  
  // API Providers object
  apiProviders,
  
  // Change manage window
  changeManageWindow,
  
  // Legacy aliases
  changeChatWindow,
  changeSelectCharacterWindow,
  changeSettingsWindow,
  changeMcpWindow,
  changeApiWindow,
  hideApiWindow,
  hideSelectCharacterWindow,
  hideMcpWindow,
  maxmizeChatWindow,
};

export default tauri;
