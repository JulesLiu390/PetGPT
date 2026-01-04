/**
 * Bridge Layer - 统一 Electron 和 Tauri 的 API 接口
 * 
 * 这个模块提供了一个抽象层，使得前端代码可以同时兼容 Electron 和 Tauri。
 * 在 Electron 环境下，它使用 window.electron (通过 preload 暴露)
 * 在 Tauri 环境下，它使用 @tauri-apps/api 的 invoke 和 listen
 */

// 检测运行环境
export const isTauri = () => {
  return window.__TAURI_INTERNALS__ !== undefined;
};

export const isElectron = () => {
  return window.electron !== undefined;
};

// 懒加载 Tauri API
let tauriInvoke = null;
let tauriListen = null;
let tauriEmit = null;

const getTauriApi = async () => {
  if (!isTauri()) return null;
  
  if (!tauriInvoke) {
    const core = await import('@tauri-apps/api/core');
    tauriInvoke = core.invoke;
  }
  if (!tauriListen) {
    const event = await import('@tauri-apps/api/event');
    tauriListen = event.listen;
    tauriEmit = event.emit;
  }
  
  return { invoke: tauriInvoke, listen: tauriListen, emit: tauriEmit };
};

// ==================== Settings 接口 ====================

export const getSettings = async () => {
  if (isElectron()) {
    return window.electron.getSettings();
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const settings = await invoke('get_all_settings');
    // 将设置数组转换为对象
    return settings.reduce((acc, s) => {
      try {
        acc[s.key] = JSON.parse(s.value);
      } catch {
        acc[s.key] = s.value;
      }
      return acc;
    }, {});
  }
  
  return {};
};

export const updateSettings = async (data) => {
  if (isElectron()) {
    return window.electron.updateSettings(data);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    // 将每个设置项保存
    for (const [key, value] of Object.entries(data)) {
      const strValue = typeof value === 'string' ? value : JSON.stringify(value);
      await invoke('set_setting', { key, value: strValue });
    }
    return data;
  }
  
  return data;
};

// 监听设置更新事件
export const onSettingsUpdated = (callback) => {
  if (isElectron()) {
    // Electron: 使用 IPC 监听
    return window.electron?.onSettingsUpdated?.(callback) || (() => {});
  }
  
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('settings-updated', (event) => {
          console.log('[bridge.onSettingsUpdated] Event received:', event.payload);
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
    });
    
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }
  
  return () => {};
};

// ==================== Pet/Assistant 接口 ====================

export const getPets = async () => {
  if (isElectron()) {
    return window.electron.getPets();
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_pets');
  }
  
  return [];
};

export const getPet = async (id) => {
  if (isElectron()) {
    return window.electron.getPet(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_pet', { id });
  }
  
  return null;
};

export const createPet = async (data) => {
  if (isElectron()) {
    return window.electron.createPet(data);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('create_pet', { data });
  }
  
  return null;
};

export const updatePet = async (id, updatedData) => {
  if (isElectron()) {
    return window.electron.updatePet(id, updatedData);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('update_pet', { id, data: updatedData });
  }
  
  return null;
};

export const deletePet = async (id) => {
  if (isElectron()) {
    return window.electron.deletePet(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('delete_pet', { id });
  }
  
  return false;
};

// ==================== ModelConfig 接口 ====================

export const getModelConfigs = async () => {
  if (isElectron()) {
    return window.electron.getModelConfigs();
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    // Tauri 目前将 ModelConfig 存储为 pet 类型
    // type === 'model' 或者没有 modelConfigId 且有 apiFormat 的是 model
    const pets = await invoke('get_pets');
    return pets.filter(p => p.type === 'model' || (p.apiFormat && !p.modelConfigId));
  }
  
  return [];
};

export const getModelConfig = async (id) => {
  if (isElectron()) {
    return window.electron.getModelConfig(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_pet', { id });
  }
  
  return null;
};

export const createModelConfig = async (data) => {
  if (isElectron()) {
    return window.electron.createModelConfig(data);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('create_pet', { data: { ...data, type: 'model' } });
    // 触发更新事件
    await sendPetsUpdate({ action: 'create', type: 'model', data: result });
    return result;
  }
  
  return null;
};

export const updateModelConfig = async (id, updatedData) => {
  if (isElectron()) {
    return window.electron.updateModelConfig(id, updatedData);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('update_pet', { id, data: updatedData });
    // 触发更新事件
    await sendPetsUpdate({ action: 'update', type: 'model', id, data: result });
    return result;
  }
  
  return null;
};

export const deleteModelConfig = async (id) => {
  if (isElectron()) {
    return window.electron.deleteModelConfig(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('delete_pet', { id });
    // 触发更新事件
    await sendPetsUpdate({ action: 'delete', type: 'model', id });
    return result;
  }
  
  return false;
};

// ==================== Assistant 接口 ====================

export const getAssistants = async () => {
  if (isElectron()) {
    return window.electron.getAssistants();
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    // Tauri 目前将 Assistant 存储为 type === 'assistant' 的 pet
    // 或者有 modelConfigId 的是 assistant
    const pets = await invoke('get_pets');
    return pets.filter(p => p.type === 'assistant' || p.modelConfigId);
  }
  
  return [];
};

export const getAssistant = async (id) => {
  if (isElectron()) {
    return window.electron.getAssistant(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_pet', { id });
  }
  
  return null;
};

export const createAssistant = async (data) => {
  if (isElectron()) {
    return window.electron.createAssistant(data);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('create_pet', { data: { ...data, type: 'assistant' } });
    // 触发更新事件
    await sendPetsUpdate({ action: 'create', type: 'assistant', data: result });
    return result;
  }
  
  return null;
};

export const updateAssistant = async (id, updatedData) => {
  if (isElectron()) {
    return window.electron.updateAssistant(id, updatedData);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('update_pet', { id, data: updatedData });
    // 触发更新事件
    await sendPetsUpdate({ action: 'update', type: 'assistant', id, data: result });
    return result;
  }
  
  return null;
};

export const deleteAssistant = async (id) => {
  if (isElectron()) {
    return window.electron.deleteAssistant(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('delete_pet', { id });
    // 触发更新事件
    await sendPetsUpdate({ action: 'delete', type: 'assistant', id });
    return result;
  }
  
  return false;
};

// ==================== 文件操作接口 ====================

export const readPetImage = async (filename) => {
  if (isElectron()) {
    return window.electron.readPetImage(filename);
  }
  
  if (isTauri()) {
    // Tauri 读取图片待实现
    console.warn('readPetImage not yet implemented for Tauri');
    return null;
  }
  
  return null;
};

export const saveFile = async (options) => {
  if (isElectron()) {
    return window.electron.saveFile(options);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    try {
      // options: { fileName, fileData (base64), mimeType }
      const result = await invoke('save_file', {
        fileName: options.fileName,
        fileData: options.fileData,
        mimeType: options.mimeType
      });
      console.log('[bridge] saveFile result:', result);
      return result; // { path, name }
    } catch (e) {
      console.error('[bridge] saveFile error:', e);
      return null;
    }
  }
  
  return null;
};

export const readUpload = async (filename) => {
  if (isElectron()) {
    return window.electron.readUpload(filename);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    try {
      // 返回 base64 编码的文件数据
      const base64Data = await invoke('read_upload', { fileName: filename });
      console.log('[bridge] readUpload success for:', filename);
      return base64Data;
    } catch (e) {
      console.error('[bridge] readUpload error:', e);
      return null;
    }
  }
  
  return null;
};

// ==================== Pet Memory 接口 ====================

export const getPetUserMemory = async (petId) => {
  if (isElectron()) {
    return window.electron.getPetUserMemory(petId);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    try {
      // 使用 settings 表存储 pet memory，key 格式为 pet_memory_{petId}
      const settingKey = `pet_memory_${petId}`;
      const value = await invoke('get_setting', { key: settingKey });
      if (value) {
        return JSON.parse(value);
      }
      return {};
    } catch (e) {
      console.warn('Failed to get pet memory:', e);
      return {};
    }
  }
  
  return {};
};

export const updatePetUserMemory = async (petId, key, value) => {
  if (isElectron()) {
    return window.electron.updatePetUserMemory(petId, key, value);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    try {
      // 获取现有记忆
      const settingKey = `pet_memory_${petId}`;
      let memory = {};
      const existing = await invoke('get_setting', { key: settingKey });
      if (existing) {
        memory = JSON.parse(existing);
      }
      
      // 更新记忆
      memory[key] = value;
      
      // 保存回去
      await invoke('set_setting', { key: settingKey, value: JSON.stringify(memory) });
      return memory;
    } catch (e) {
      console.warn('Failed to update pet memory:', e);
      return null;
    }
  }
  
  return null;
};

// ==================== 窗口 & 快捷键接口 ====================

export const updateWindowSizePreset = async (size) => {
  if (isElectron()) {
    return window.electron.updateWindowSizePreset(size);
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('update_window_size_preset', { preset: size });
  }
};

export const updateShortcuts = async (programHotkey, dialogHotkey) => {
  if (isElectron()) {
    return window.electron.updateShortcuts(programHotkey, dialogHotkey);
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('update_shortcuts', { shortcut1: programHotkey, shortcut2: dialogHotkey });
  }
};

export const openExternal = (url) => {
  if (isElectron()) {
    return window.electron.openExternal?.(url) || window.electron.openFileExternal?.(url);
  }
  if (isTauri()) {
    // 使用 Tauri shell API
    import('@tauri-apps/plugin-shell').then(({ open }) => open(url));
  }
};

// ==================== 其他 Electron 特定接口 ====================

export const probeOpenAICompatibleEndpoints = async (options) => {
  if (isElectron()) {
    return window.electron.probeOpenAICompatibleEndpoints(options);
  }
  // Tauri 需要前端直接实现或通过 command
  console.warn('probeOpenAICompatibleEndpoints not yet implemented for Tauri');
  return null;
};

export const probeModelCapabilities = async (options) => {
  if (isElectron()) {
    return window.electron.probeModelCapabilities(options);
  }
  console.warn('probeModelCapabilities not yet implemented for Tauri');
  return null;
};

export const processImage = async (base64Image) => {
  if (isElectron()) {
    return window.electron.processImage(base64Image);
  }
  console.warn('processImage not yet implemented for Tauri');
  return null;
};

// ==================== 事件接口扩展 ====================

// Tauri 事件监听器存储
const tauriEventListeners = new Map();

// 获取 Tauri 事件 API
const getTauriEventApi = async () => {
  if (isTauri()) {
    try {
      const eventModule = await import('@tauri-apps/api/event');
      return eventModule;
    } catch (e) {
      console.warn('Failed to load Tauri event API:', e);
    }
  }
  return null;
};

export const sendPetsUpdate = async (data) => {
  if (isElectron()) {
    window.electron?.sendPetsUpdate(data);
  }
  if (isTauri()) {
    // 使用 Rust 后端来广播事件到所有窗口
    const { invoke } = await getTauriApi();
    if (invoke) {
      try {
        await invoke('emit_to_all', { event: 'pets-updated', payload: data });
      } catch (e) {
        console.warn('Failed to emit pets-updated:', e);
      }
    }
  }
};

export const onPetsUpdated = (callback) => {
  if (isElectron()) {
    return window.electron?.onPetsUpdated(callback);
  }
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('pets-updated', (event) => {
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }
  return () => {};
};

export const sendMcpUpdate = async (data) => {
  if (isElectron()) {
    // Electron 可能没有这个，但为了一致性保留
  }
  if (isTauri()) {
    // 使用 Rust 后端来广播事件到所有窗口
    const { invoke } = await getTauriApi();
    if (invoke) {
      try {
        await invoke('emit_to_all', { event: 'mcp-updated', payload: data });
      } catch (e) {
        console.warn('Failed to emit mcp-updated:', e);
      }
    }
  }
};

export const onMcpUpdated = (callback) => {
  if (isElectron()) {
    return () => {};
  }
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('mcp-updated', (event) => {
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }
  return () => {};
};

export const onNewChatCreated = (callback) => {
  if (isElectron()) {
    return window.electron?.onNewChatCreated(callback);
  }
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('new-chat-created', (event) => {
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }
  return () => {};
};

export const onChatbodyStatusUpdated = (callback) => {
  if (isElectron()) {
    return window.electron?.onChatbodyStatusUpdated(callback);
  }
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('chatbody-status-updated', (event) => {
          // Support both old format (string) and new format ({ status, conversationId })
          const payload = event.payload;
          if (typeof payload === 'object' && payload !== null) {
            callback(payload.status, payload.conversationId);
          } else {
            callback(payload, null);
          }
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }
  return () => {};
};

export const updateChatbodyStatus = async (status, conversationId = null) => {
  if (isElectron()) {
    return window.electron?.updateChatbodyStatus(status, conversationId);
  }
  if (isTauri()) {
    const eventApi = await getTauriEventApi();
    if (eventApi) {
      eventApi.emit('chatbody-status-updated', { status, conversationId });
    }
  }
};

export const openMcpSettings = () => {
  if (isElectron()) {
    window.electron?.openMcpSettings?.();
  }
};

// ==================== Conversation 接口 ====================

export const getConversations = async (petId) => {
  if (isElectron()) {
    const conversations = await window.electron.getConversations();
    // 如果提供了 petId，过滤结果
    return petId ? conversations.filter(c => c.petId === petId) : conversations;
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    if (!petId) {
      // 获取所有 pets，然后获取所有对话
      const pets = await invoke('get_pets');
      console.log('[bridge] getConversations - got pets:', pets);
      const allConversations = [];
      for (const pet of pets) {
        const petIdToUse = pet._id || pet.id;
        console.log('[bridge] getConversations - fetching for pet:', petIdToUse);
        try {
          const convs = await invoke('get_conversations_by_pet', { petId: petIdToUse });
          console.log('[bridge] getConversations - got convs:', convs);
          allConversations.push(...convs.map(c => ({
            ...c,
            _id: c._id || c.id,
            petId: c.petId || c.pet_id
          })));
        } catch (e) {
          console.error('[bridge] getConversations - error for pet', petIdToUse, e);
        }
      }
      console.log('[bridge] getConversations - returning:', allConversations);
      return allConversations;
    }
    
    const conversations = await invoke('get_conversations_by_pet', { petId: petId });
    return conversations.map(c => ({
      ...c,
      _id: c._id || c.id,
      petId: c.petId || c.pet_id
    }));
  }
  
  return [];
};

export const getConversationsByPet = async (petId) => {
  if (isElectron()) {
    // Electron 没有这个特定方法，使用通用方法
    const conversations = await window.electron.getConversations();
    return conversations.filter(c => c.petId === petId);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_conversations_by_pet', { pet_id: petId });
  }
  
  return [];
};

export const getConversationById = async (id) => {
  if (isElectron()) {
    return window.electron.getConversationById(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    // 获取对话信息
    const conversation = await invoke('get_conversation', { id });
    if (!conversation) return null;
    
    // 获取该对话的消息列表，并转换为 history 格式（与 Electron 兼容）
    // 注意：Tauri 自动将 Rust 的 snake_case 参数转换为 camelCase
    const messages = await invoke('get_messages', { conversationId: id });
    const history = messages.map(msg => {
      // 解析 content：如果是 JSON 字符串（多模态消息），需要解析回对象
      let content = msg.content;
      if (typeof content === 'string') {
        try {
          // 尝试解析为 JSON（可能是数组或对象）
          const parsed = JSON.parse(content);
          // 如果解析成功且是数组或对象，使用解析后的值
          if (Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null)) {
            content = parsed;
          }
        } catch {
          // 解析失败，说明是普通字符串，保持原样
        }
      }
      
      return {
        role: msg.role,
        content,
        ...(msg.toolCallHistory && { toolCallHistory: JSON.parse(msg.toolCallHistory) })
      };
    });
    
    return {
      ...conversation,
      _id: conversation._id || conversation.id,
      petId: conversation.petId || conversation.pet_id,
      history
    };
  }
  
  return null;
};

export const createConversation = async (data) => {
  if (isElectron()) {
    return window.electron.createConversation(data);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const conversation = await invoke('create_conversation', { 
      data: {
        pet_id: data.petId,
        title: data.title
      }
    });
    
    // 如果提供了初始 history，保存消息
    if (data.history && Array.isArray(data.history) && conversation) {
      for (const msg of data.history) {
        await invoke('create_message', {
          data: {
            conversationId: conversation._id || conversation.id,
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            toolCallHistory: msg.toolCallHistory ? JSON.stringify(msg.toolCallHistory) : null
          }
        });
      }
    }
    
    // 返回兼容格式（确保有 _id 字段）
    return conversation ? {
      ...conversation,
      _id: conversation._id || conversation.id,
      petId: conversation.petId || conversation.pet_id,
      history: data.history || []
    } : null;
  }
  
  return null;
};

export const updateConversation = async (id, updatedData) => {
  if (isElectron()) {
    return window.electron.updateConversation(id, updatedData);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    
    // 更新标题（如果提供）
    if (updatedData.title !== undefined) {
      await invoke('update_conversation_title', { id, title: updatedData.title });
    }
    
    // 处理 history 更新 - 在 Tauri 中需要同步消息到数据库
    if (updatedData.history && Array.isArray(updatedData.history)) {
      // 获取当前已保存的消息
      const existingMessages = await invoke('get_messages', { conversationId: id });
      const existingCount = existingMessages.length;
      const newHistory = updatedData.history;
      
      // 只保存新增的消息（假设消息只会追加，不会修改）
      if (newHistory.length > existingCount) {
        const newMessages = newHistory.slice(existingCount);
        for (const msg of newMessages) {
          await invoke('create_message', {
            data: {
              conversationId: id,
              role: msg.role,
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              toolCallHistory: msg.toolCallHistory ? JSON.stringify(msg.toolCallHistory) : null
            }
          });
        }
      }
    }
    
    return true;
  }
  
  return null;
};

export const deleteConversation = async (id) => {
  if (isElectron()) {
    return window.electron.deleteConversation(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('delete_conversation', { id });
  }
  
  return false;
};

// ==================== Message 接口 ====================

export const getMessages = async (conversationId) => {
  if (isElectron()) {
    const conv = await window.electron.getConversationById(conversationId);
    return conv?.history || [];
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_messages', { conversationId: conversationId });
  }
  
  return [];
};

export const createMessage = async (data) => {
  if (isElectron()) {
    // Electron 使用 updateConversation 来保存消息
    console.warn('createMessage in Electron should use updateConversation');
    return null;
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('create_message', {
      data: {
        conversationId: data.conversationId,
        role: data.role,
        content: data.content,
        toolCallHistory: data.toolCallHistory ? JSON.stringify(data.toolCallHistory) : null
      }
    });
  }
  
  return null;
};

// ==================== MCP Server 接口 ====================

export const getMcpServers = async () => {
  if (isElectron()) {
    return window.electron?.mcp?.getServers() || [];
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      console.log('[bridge.getMcpServers] Invoking get_mcp_servers...');
      const result = await invoke('get_mcp_servers');
      console.log('[bridge.getMcpServers] Result:', result?.length, 'servers');
      return result || [];
    } catch (err) {
      console.error('[bridge.getMcpServers] Error:', err);
      return [];
    }
  }
  
  return [];
};

export const getMcpServer = async (id) => {
  if (isElectron()) {
    return window.electron?.mcp?.getServer(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_mcp_server', { id });
  }
  
  return null;
};

export const createMcpServer = async (data) => {
  if (isElectron()) {
    return window.electron?.mcp?.createServer(data);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('create_mcp_server', { data });
    // 触发更新事件
    mcp.emitServersUpdated?.({ action: 'create', data: result });
    return result;
  }
  
  return null;
};

export const updateMcpServer = async (id, updates) => {
  if (isElectron()) {
    return window.electron?.mcp?.updateServer(id, updates);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('update_mcp_server', { id, data: updates });
    // 触发更新事件
    mcp.emitServersUpdated?.({ action: 'update', id, data: result });
    return result;
  }
  
  return null;
};

export const deleteMcpServer = async (id) => {
  if (isElectron()) {
    return window.electron?.mcp?.deleteServer(id);
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    const result = await invoke('delete_mcp_server', { id });
    // 触发更新事件
    mcp.emitServersUpdated?.({ action: 'delete', id });
    return result;
  }
  
  return false;
};

// ==================== MCP Runtime 接口 (仅 Electron/将来迁移到前端) ====================
// 这些接口在 Tauri 中将由前端直接处理

export const mcp = {
  getServers: getMcpServers,
  getServer: getMcpServer,
  createServer: createMcpServer,
  updateServer: updateMcpServer,
  deleteServer: deleteMcpServer,
  
  // MCP 运行时方法 - 支持 Electron 和 Tauri
  startServer: async (serverId) => {
    if (isElectron()) {
      return window.electron?.mcp?.startServer(serverId);
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_start_server', { serverId });
    }
    return null;
  },
  
  stopServer: async (serverId) => {
    if (isElectron()) {
      return window.electron?.mcp?.stopServer(serverId);
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_stop_server', { serverId });
    }
    return null;
  },
  
  restartServer: async (serverId) => {
    if (isElectron()) {
      return window.electron?.mcp?.restartServer?.(serverId);
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_restart_server', { serverId });
    }
    return null;
  },
  
  getServerStatus: async (serverId) => {
    if (isElectron()) {
      return window.electron?.mcp?.getServerStatus(serverId);
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      const status = await invoke('mcp_get_server_status', { serverId });
      return status || { isRunning: false };
    }
    return { isRunning: false };
  },
  
  getAllStatuses: async () => {
    if (isElectron()) {
      return window.electron?.mcp?.getAllStatuses?.() || [];
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_get_all_statuses');
    }
    return [];
  },
  
  getAllTools: async () => {
    if (isElectron()) {
      return window.electron?.mcp?.getAllTools() || [];
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      const tools = await invoke('mcp_get_all_tools');
      // 转换为与 Electron 兼容的格式
      return tools.map(t => ({
        serverId: t.serverId,
        serverName: t.serverName,
        name: t.tool.name,
        description: t.tool.description,
        inputSchema: t.tool.inputSchema,
      }));
    }
    return [];
  },
  
  callTool: async (serverId, toolName, args) => {
    if (isElectron()) {
      return window.electron?.mcp?.callTool(serverId, toolName, args);
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      const result = await invoke('mcp_call_tool', { 
        serverId, 
        toolName, 
        arguments: args ? JSON.parse(JSON.stringify(args)) : null 
      });
      // 转换内容格式
      if (result.content) {
        return {
          success: result.success,
          content: result.content.map(c => {
            if (c.type === 'text' || c.Text) {
              return { type: 'text', text: c.text || c.Text?.text };
            }
            if (c.type === 'image' || c.Image) {
              return { type: 'image', data: c.data || c.Image?.data, mimeType: c.mimeType || c.Image?.mimeType };
            }
            return c;
          }),
          error: result.error,
        };
      }
      return result;
    }
    throw new Error('MCP callTool not supported');
  },
  
  // 根据工具全名调用工具（格式: ServerName__toolName）
  callToolByName: async (fullToolName, args) => {
    console.log('[bridge.mcp.callToolByName] Called with:', fullToolName, args);
    
    // 解析工具名：格式为 "ServerName__toolName"
    const parts = fullToolName.split('__');
    if (parts.length !== 2) {
      throw new Error(`Invalid tool name format: ${fullToolName}. Expected format: ServerName__toolName`);
    }
    
    const [serverName, toolName] = parts;
    console.log('[bridge.mcp.callToolByName] Parsed:', { serverName, toolName });
    
    // 获取所有服务器，找到对应的服务器
    const servers = await getMcpServers();
    const server = servers.find(s => s.name === serverName);
    
    if (!server) {
      throw new Error(`Server "${serverName}" not found`);
    }
    
    console.log('[bridge.mcp.callToolByName] Found server:', server._id, server.name);
    
    // 检查服务器是否运行，如果没有则先启动
    const isRunning = await mcp.isServerRunning(server._id);
    console.log('[bridge.mcp.callToolByName] Server running:', isRunning);
    
    if (!isRunning) {
      console.log('[bridge.mcp.callToolByName] Starting server...');
      await mcp.startServer(server._id);
      console.log('[bridge.mcp.callToolByName] Server started');
    }
    
    // 调用 callTool
    return mcp.callTool(server._id, toolName, args);
  },
  
  isServerRunning: async (serverId) => {
    if (isElectron()) {
      const status = await window.electron?.mcp?.getServerStatus(serverId);
      return status?.isRunning || false;
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_is_server_running', { serverId });
    }
    return false;
  },
  
  // 取消所有正在进行的工具调用
  cancelAllToolCalls: async () => {
    console.log('[bridge.mcp.cancelAllToolCalls] Cancelling all tool calls');
    if (isElectron()) {
      return window.electron?.mcp?.cancelAllToolCalls?.();
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_cancel_all_tool_calls');
    }
  },
  
  // 重置取消状态（在新的对话开始前调用）
  resetCancellation: async () => {
    console.log('[bridge.mcp.resetCancellation] Resetting cancellation');
    if (isElectron()) {
      return window.electron?.mcp?.resetCancellation?.();
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_reset_cancellation');
    }
  },
  
  testServer: async (config) => {
    if (isElectron()) {
      return window.electron?.mcp?.testServer(config);
    }
    if (isTauri()) {
      const { invoke } = await getTauriApi();
      return invoke('mcp_test_server', { 
        transport: config.transport || 'stdio',
        command: config.command || null,
        args: config.args || null,
        env: config.env || null,
        url: config.url || null,
        apiKey: config.apiKey || null,
      });
    }
    throw new Error('MCP testServer not supported');
  },
  
  listServers: getMcpServers,
  
  onServersUpdated: (callback) => {
    console.log('[bridge.mcp.onServersUpdated] Setting up listener');
    if (isElectron()) {
      return window.electron?.mcp?.onServersUpdated(callback);
    }
    // Tauri 使用事件系统
    if (isTauri()) {
      let unlisten = null;
      let cancelled = false;
      
      getTauriEventApi().then(eventApi => {
        if (cancelled) {
          console.log('[bridge.mcp.onServersUpdated] Cancelled before setup');
          return;
        }
        if (eventApi) {
          console.log('[bridge.mcp.onServersUpdated] Registering event listener');
          eventApi.listen('mcp-servers-updated', (event) => {
            console.log('[bridge.mcp.onServersUpdated] Event received:', event);
            callback(event.payload);
          }).then(fn => {
            if (cancelled) {
              console.log('[bridge.mcp.onServersUpdated] Cancelled after setup, cleaning up');
              fn();
            } else {
              console.log('[bridge.mcp.onServersUpdated] Listener registered successfully');
              unlisten = fn;
            }
          });
        } else {
          console.warn('[bridge.mcp.onServersUpdated] No event API available');
        }
      });
      return () => {
        console.log('[bridge.mcp.onServersUpdated] Cleanup called');
        cancelled = true;
        if (unlisten) unlisten();
      };
    }
    console.warn('[bridge.mcp.onServersUpdated] Not Electron or Tauri, returning no-op');
    return () => {};
  },
  
  // 发送 MCP 服务器更新事件
  emitServersUpdated: async (data) => {
    console.log('[bridge.mcp.emitServersUpdated] Called with data:', data);
    if (isTauri()) {
      // 使用 Rust 后端来广播事件到所有窗口
      const { invoke } = await getTauriApi();
      if (invoke) {
        try {
          console.log('[bridge.mcp.emitServersUpdated] Invoking emit_to_all...');
          await invoke('emit_to_all', { event: 'mcp-servers-updated', payload: data });
          console.log('[bridge.mcp.emitServersUpdated] Event emitted successfully');
        } catch (e) {
          console.warn('[bridge.mcp.emitServersUpdated] Failed to emit:', e);
        }
      } else {
        console.warn('[bridge.mcp.emitServersUpdated] No invoke available');
      }
    } else {
      console.warn('[bridge.mcp.emitServersUpdated] Not Tauri');
    }
  },
};

// ==================== Window 控制接口 ====================

export const changeChatWindow = async () => {
  if (isElectron()) {
    window.electron?.changeChatWindow();
  }
  if (isTauri()) {
    console.log('Tauri: toggle_chat_window');
    const { invoke } = await getTauriApi();
    await invoke('toggle_chat_window');
  }
};

export const showChatWindow = async () => {
  if (isElectron()) {
    window.electron?.changeChatWindow();
  }
  if (isTauri()) {
    console.log('Tauri: show_chat_window');
    const { invoke } = await getTauriApi();
    await invoke('show_chat_window');
  }
};

export const hideChatWindow = async () => {
  if (isElectron()) {
    // Electron 没有单独的 hide，用 toggle
    window.electron?.changeChatWindow();
  }
  if (isTauri()) {
    console.log('Tauri: hide_chat_window');
    const { invoke } = await getTauriApi();
    await invoke('hide_chat_window');
  }
};

export const changeSelectCharacterWindow = async () => {
  if (isElectron()) {
    window.electron?.changeSelectCharacterWindow();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('open_select_character_window');
  }
};

export const changeSettingsWindow = async () => {
  if (isElectron()) {
    window.electron?.changeSettingsWindow();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('open_settings_window');
  }
};

export const changeMcpWindow = async () => {
  if (isElectron()) {
    window.electron?.changeMcpWindow();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('open_mcp_window');
  }
};

export const changeAddCharacterWindow = async () => {
  if (isElectron()) {
    window.electron?.changeAddCharacterWindow();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('open_add_character_window');
  }
};

export const changeAddModelWindow = async () => {
  if (isElectron()) {
    window.electron?.changeAddModelWindow?.();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('open_add_model_window');
  }
};

export const hideAddCharacterWindow = async () => {
  if (isElectron()) {
    window.electron?.hideAddCharacterWindow();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('hide_add_character_window');
  }
};

export const hideAddModelWindow = async () => {
  if (isElectron()) {
    window.electron?.hideAddModelWindow?.();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('hide_add_model_window');
  }
};

export const hideSelectCharacterWindow = async () => {
  if (isElectron()) {
    window.electron?.hideSelectCharacterWindow();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('hide_select_character_window');
  }
};

export const hideSettingsWindow = async () => {
  if (isElectron()) {
    window.electron?.changeSettingsWindow?.(); // Electron 用 toggle
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('hide_settings_window');
  }
};

export const hideMcpWindow = async () => {
  if (isElectron()) {
    window.electron?.changeMcpWindow?.(); // Electron 用 toggle
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('hide_mcp_window');
  }
};

export const maximizeChatWindow = async () => {
  if (isElectron()) {
    window.electron?.maxmizeChatWindow?.();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('maximize_chat_window');
  }
};

// Alias for backwards compatibility (typo in original Electron code)
export const maxmizeChatWindow = maximizeChatWindow;

export const toggleSidebar = async (open) => {
  if (isElectron()) {
    // Electron preload 暴露了 toggleSidebar，用于通知主进程调整窗口大小
    window.electron?.toggleSidebar?.(open);
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('toggle_sidebar', { open });
  }
};

// Tauri 窗口控制扩展

export const minimizeWindow = async (label = 'chat') => {
  if (isElectron()) {
    window.electron?.minimizeWindow?.();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('minimize_window', { label });
  }
};

export const maximizeWindow = async (label = 'chat') => {
  if (isElectron()) {
    window.electron?.maximizeWindow?.();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('maximize_window', { label });
  }
};

export const closeWindow = async (label = 'chat') => {
  if (isElectron()) {
    window.electron?.closeWindow?.();
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('close_window', { label });
  }
};

export const isWindowMaximized = async (label = 'chat') => {
  if (isElectron()) {
    return window.electron?.isMaximized?.() ?? false;
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('is_window_maximized', { label });
  }
  return false;
};

export const getWindowPosition = async (label) => {
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_window_position', { label });
  }
  return [0, 0];
};

export const setWindowPosition = async (label, x, y) => {
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('set_window_position', { label, x, y });
  }
};

export const getWindowSize = async (label) => {
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_window_size', { label });
  }
  return [0, 0];
};

export const setWindowSize = async (label, width, height) => {
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('set_window_size', { label, width, height });
  }
};

export const getScreenSize = async () => {
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_screen_size');
  }
  return [window.screen.width, window.screen.height];
};

// ==================== 事件接口 ====================

export const sendCharacterId = async (id) => {
  console.log('[bridge] sendCharacterId called with:', id);
  if (isElectron()) {
    window.electron?.sendCharacterId(id);
  }
  if (isTauri()) {
    // 使用 Rust 后端广播到所有窗口
    const { invoke } = await getTauriApi();
    if (invoke) {
      try {
        console.log('[bridge] Emitting character-id via Rust backend');
        await invoke('emit_to_all', { event: 'character-id', payload: id });
        console.log('[bridge] character-id emitted successfully');
      } catch (e) {
        console.warn('Failed to emit character-id:', e);
      }
    }
  }
};

export const onCharacterId = (callback) => {
  if (isElectron()) {
    return window.electron?.onCharacterId(callback);
  }
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return; // 如果已经取消则不设置监听器
      if (eventApi) {
        console.log('[bridge] Setting up character-id listener');
        eventApi.listen('character-id', (event) => {
          console.log('[bridge] Received character-id event:', event.payload);
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn(); // 如果已取消，立即解除监听
          } else {
            unlisten = fn;
          }
        });
      }
    });
    
    return () => {
      cancelled = true;
      if (unlisten) {
        console.log('[bridge] Cleaning up character-id listener');
        unlisten();
      }
    };
  }
  return () => {};
};

export const sendConversationId = async (id) => {
  if (isElectron()) {
    window.electron?.sendConversationId(id);
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    if (invoke) {
      try {
        await invoke('emit_to_all', { event: 'conversation-id', payload: id });
      } catch (e) {
        console.warn('Failed to emit conversation-id:', e);
      }
    }
  }
};

export const onConversationId = (callback) => {
  if (isElectron()) {
    return window.electron?.onConversationId(callback);
  }
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('conversation-id', (event) => {
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }
  return () => {};
};

export const sendMoodUpdate = async (mood, conversationId) => {
  if (isElectron()) {
    window.electron?.sendMoodUpdate(mood, conversationId);
    return;
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    try {
      // 使用 emit_to_all 广播 mood 更新事件
      await invoke('emit_to_all', {
        event: 'character-mood-updated',
        payload: { mood, conversationId }
      });
    } catch (e) {
      console.error('[bridge] sendMoodUpdate error:', e);
    }
  }
};

export const onMoodUpdated = (callback) => {
  if (isElectron()) {
    return window.electron?.onMoodUpdated(callback);
  }
  
  if (isTauri()) {
    // Tauri 使用事件系统监听 mood 更新
    let unlisten = null;
    getTauriApi().then(({ listen }) => {
      listen('character-mood-updated', (event) => {
        const { mood, conversationId } = event.payload;
        // Electron callback 格式: (event, mood, conversationId)
        callback(null, mood, conversationId);
      }).then(fn => {
        unlisten = fn;
      });
    });
    return () => {
      if (unlisten) unlisten();
    };
  }
  
  return () => {};
};

// ==================== 导出默认 bridge 对象 ====================
// 这个对象可以直接替代 window.electron

const bridge = {
  // 环境检测
  isTauri,
  isElectron,
  
  // Settings
  getSettings,
  updateSettings,
  onSettingsUpdated,
  
  // Pets/Assistants  
  getPets,
  getPet,
  createPet,
  updatePet,
  deletePet,
  
  // ModelConfigs
  getModelConfigs,
  getModelConfig,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  
  // Assistants
  getAssistants,
  getAssistant,
  createAssistant,
  updateAssistant,
  deleteAssistant,
  
  // Conversations
  getConversations,
  getConversationsByPet,
  getConversationById,
  createConversation,
  updateConversation,
  deleteConversation,
  
  // Messages
  getMessages,
  createMessage,
  
  // MCP
  mcp,
  
  // 文件操作
  readPetImage,
  saveFile,
  readUpload,
  
  // Pet Memory
  getPetUserMemory,
  updatePetUserMemory,
  
  // Window
  changeChatWindow,
  showChatWindow,
  hideChatWindow,
  changeSelectCharacterWindow,
  changeSettingsWindow,
  changeMcpWindow,
  changeAddCharacterWindow,
  hideAddCharacterWindow,
  hideAddModelWindow,
  hideSelectCharacterWindow,
  hideSettingsWindow,
  hideMcpWindow,
  maximizeChatWindow,
  maxmizeChatWindow, // Alias with typo for backwards compatibility
  toggleSidebar,
  openMcpSettings,
  updateWindowSizePreset,
  updateShortcuts,
  openExternal,
  minimizeWindow,
  maximizeWindow,
  closeWindow,
  isWindowMaximized,
  getWindowPosition,
  setWindowPosition,
  getWindowSize,
  setWindowSize,
  getScreenSize,
  
  // 探测接口
  probeOpenAICompatibleEndpoints,
  probeModelCapabilities,
  processImage,
  
  // Events
  sendCharacterId,
  onCharacterId,
  sendConversationId,
  onConversationId,
  sendMoodUpdate,
  onMoodUpdated,
  sendPetsUpdate,
  onPetsUpdated,
  onNewChatCreated,
  onChatbodyStatusUpdated,
  updateChatbodyStatus,
  
  // 兼容层 - 如果是 Electron，直接透传原始 API
  get electron() {
    return isElectron() ? window.electron : null;
  }
};

export default bridge;
