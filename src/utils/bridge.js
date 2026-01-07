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
let tauriDialog = null;

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
  if (!tauriDialog) {
    const dialog = await import('@tauri-apps/plugin-dialog');
    tauriDialog = dialog;
  }
  
  return { invoke: tauriInvoke, listen: tauriListen, emit: tauriEmit, dialog: tauriDialog };
};

// 辅助函数：获取 Tauri Event API (用于 onSettingsUpdated)
const getTauriEventApi = async () => {
  if (!isTauri()) return null;
  if (!tauriListen) {
    const event = await import('@tauri-apps/api/event');
    tauriListen = event.listen;
    tauriEmit = event.emit;
  }
  return { listen: tauriListen, emit: tauriEmit };
};

// 导出 confirm 对话框
export const confirm = async (message, options = {}) => {
  if (isElectron()) {
    return window.confirm(message);
  }
  
  if (isTauri()) {
    try {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      return await ask(message, {
        title: options.title || 'PetGPT',
        kind: 'warning',
        okLabel: 'Yes',
        cancelLabel: 'No',
      });
    } catch (err) {
      console.error('[bridge.confirm] Dialog error:', err);
      return window.confirm(message);
    }
  }
  
  return window.confirm(message);
};

// ==================== Settings 接口 ====================

// 默认设置值
const DEFAULT_SETTINGS = {
  windowSize: 'medium',
  defaultAssistant: '',
  programHotkey: 'Shift + Space',
  dialogHotkey: 'Alt + Space',
  launchAtStartup: false,
  theme: 'light',
};

export const getSettings = async () => {
  let result = {};
  
  if (isElectron()) {
    result = await window.electron.getSettings() || {};
  } else if (isTauri()) {
    const { invoke } = await getTauriApi();
    const settings = await invoke('get_all_settings');
    // 将设置数组转换为对象
    result = settings.reduce((acc, s) => {
      try {
        acc[s.key] = JSON.parse(s.value);
      } catch {
        acc[s.key] = s.value;
      }
      return acc;
    }, {});
  }
  
  // 合并默认值（用户设置优先）
  return { ...DEFAULT_SETTINGS, ...result };
};

export const updateSettings = async (data) => {
  if (isElectron()) {
    return window.electron.updateSettings(data);
  }
  
  if (isTauri()) {
    const { invoke, emit } = await getTauriApi();
    // 将每个设置项保存并广播更新事件
    for (const [key, value] of Object.entries(data)) {
      const strValue = typeof value === 'string' ? value : JSON.stringify(value);
      await invoke('set_setting', { key, value: strValue });
      // 广播设置更新事件到所有窗口
      try {
        await invoke('emit_to_all', { 
          event: 'settings-updated', 
          payload: { key, value } 
        });
      } catch (e) {
        console.warn('[bridge.updateSettings] Failed to emit settings-updated:', e);
      }
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

// 监听 Manage 窗口可见性变化
export const onManageWindowVisibilityChanged = (callback) => {
  if (isElectron()) {
    // Electron specific implementation if needed
    return window.electron?.onManageWindowVisibilityChanged?.(callback) || (() => {});
  }
  
  if (isTauri()) {
    let unlisten = null;
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('manage-window-vis-change', (event) => {
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

import { getDetectionCandidates, GEMINI_OFFICIAL_PRESETS } from './llm/presets.js';

// Gemini 官方 API Base URL
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * 检测 API Key 对应的端点（支持 OpenAI 兼容和 Gemini 官方）
 * 通过依次尝试各个预设端点的 API 来验证
 */
export const probeOpenAICompatibleEndpoints = async (options) => {
  if (isElectron()) {
    return window.electron.probeOpenAICompatibleEndpoints(options);
  }
  
  // Tauri/Web 前端实现
  const { apiKey, includeLocal = false } = options || {};
  if (!apiKey) return null;
  
  const candidates = getDetectionCandidates(includeLocal);
  const allResults = [];
  
  // 1. 先测试 Gemini 官方 API（优先级高，因为它有独特的 API 格式）
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const geminiResponse = await fetch(`${GEMINI_BASE_URL}/models?key=${apiKey}`, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (geminiResponse.ok) {
      const data = await geminiResponse.json();
      if (data && Array.isArray(data.models) && data.models.length > 0) {
        // Gemini 官方 API 验证成功
        const geminiResult = {
          id: 'gemini_official',
          label: 'Google AI (Gemini Official)',
          baseUrl: GEMINI_OFFICIAL_PRESETS[0].baseUrl,
          apiFormat: 'gemini_official',
          success: true,
          modelCount: data.models.length
        };
        allResults.push(geminiResult);
        // 直接返回 Gemini 作为 bestMatch
        return {
          bestMatch: geminiResult,
          allResults: [geminiResult]
        };
      }
    }
    allResults.push({ id: 'gemini_official', label: 'Google AI (Gemini Official)', success: false });
  } catch (error) {
    allResults.push({ id: 'gemini_official', label: 'Google AI (Gemini Official)', success: false, error: error.message });
  }
  
  // 2. 并行测试所有 OpenAI 兼容端点（设置超时）
  const probePromises = candidates.map(async (candidate) => {
    const url = candidate.baseUrl.endsWith('/v1') 
      ? candidate.baseUrl 
      : (candidate.baseUrl.endsWith('/') ? candidate.baseUrl + 'v1' : candidate.baseUrl + '/v1');
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时
      
      const response = await fetch(`${url}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        // 验证返回的是有效的模型列表
        if (data && (Array.isArray(data.data) || Array.isArray(data))) {
          const modelCount = Array.isArray(data.data) ? data.data.length : data.length;
          
          // OpenRouter 特殊处理：/models 端点不验证 API Key，需要用 /chat/completions 验证
          if (candidate.id === 'openrouter') {
            try {
              const verifyController = new AbortController();
              const verifyTimeoutId = setTimeout(() => verifyController.abort(), 8000);
              
              const verifyResponse = await fetch(`${url}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: 'openai/gpt-3.5-turbo',
                  messages: [{ role: 'user', content: 'hi' }],
                  max_tokens: 1
                }),
                signal: verifyController.signal
              });
              
              clearTimeout(verifyTimeoutId);
              
              // 如果返回 401/403，说明 API Key 无效
              if (verifyResponse.status === 401 || verifyResponse.status === 403) {
                return { ...candidate, success: false, error: 'Invalid API Key' };
              }
              
              // 如果返回 200 或 4xx（如 402 余额不足、400 参数错误），说明 Key 有效
              // 只有 401/403 才是 Key 无效
            } catch (verifyError) {
              // 网络错误时跳过验证，仍然返回成功（可能是网络问题）
              console.warn('OpenRouter verification failed:', verifyError.message);
            }
          }
          
          return {
            ...candidate,
            apiFormat: 'openai_compatible',
            success: true,
            modelCount,
            responseTime: Date.now()
          };
        }
      }
      return { ...candidate, success: false };
    } catch (error) {
      // 超时或网络错误
      return { ...candidate, success: false, error: error.message };
    }
  });
  
  const probeResults = await Promise.all(probePromises);
  allResults.push(...probeResults);
  
  // 过滤出成功的端点
  const successfulEndpoints = probeResults.filter(r => r.success);
  
  if (successfulEndpoints.length === 0) {
    return { bestMatch: null, allResults };
  }
  
  // 返回第一个成功的作为 bestMatch（按预设顺序优先）
  return {
    bestMatch: successfulEndpoints[0],
    allResults
  };
};

/**
 * 探测模型的能力（是否支持视觉、函数调用等）
 */
export const probeModelCapabilities = async (options) => {
  if (isElectron()) {
    return window.electron.probeModelCapabilities(options);
  }
  
  // Tauri/Web 前端实现
  const { apiFormat, apiKey, modelName, baseUrl } = options || {};
  if (!apiKey || !modelName) return null;
  
  // 构建 URL
  let url = baseUrl;
  if (url === 'default' || !url) {
    url = 'https://api.openai.com/v1';
  } else if (!url.endsWith('/v1')) {
    url = url.endsWith('/') ? url + 'v1' : url + '/v1';
  }
  
  const capabilities = {
    vision: false,
    functionCalling: false,
    streaming: true, // 大多数 OpenAI 兼容端点都支持
    jsonMode: false
  };
  
  try {
    // 方法1：尝试获取模型详情（部分 API 支持）
    const modelResponse = await fetch(`${url}/models/${encodeURIComponent(modelName)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    
    if (modelResponse.ok) {
      const modelInfo = await modelResponse.json();
      // 根据模型名称或元数据推断能力
      const modelId = (modelInfo.id || modelName).toLowerCase();
      
      // 视觉能力检测
      if (modelId.includes('vision') || 
          modelId.includes('gpt-4o') || 
          modelId.includes('gpt-4-turbo') ||
          modelId.includes('claude-3') ||
          modelId.includes('gemini')) {
        capabilities.vision = true;
      }
      
      // 函数调用能力检测
      if (modelId.includes('gpt-4') || 
          modelId.includes('gpt-3.5-turbo') ||
          modelId.includes('claude-3') ||
          modelId.includes('gemini')) {
        capabilities.functionCalling = true;
      }
      
      // JSON 模式检测
      if (modelId.includes('gpt-4') || 
          modelId.includes('gpt-3.5-turbo-1106') ||
          modelId.includes('gpt-3.5-turbo-0125')) {
        capabilities.jsonMode = true;
      }
    }
    
    // 方法2：基于模型名称的启发式检测（作为后备）
    const modelLower = modelName.toLowerCase();
    
    if (!capabilities.vision) {
      capabilities.vision = modelLower.includes('vision') || 
                           modelLower.includes('gpt-4o') ||
                           modelLower.includes('gpt-4-turbo') ||
                           modelLower.includes('claude-3') ||
                           modelLower.includes('gemini-1.5') ||
                           modelLower.includes('gemini-2');
    }
    
    if (!capabilities.functionCalling) {
      capabilities.functionCalling = modelLower.includes('gpt-4') ||
                                    modelLower.includes('gpt-3.5') ||
                                    modelLower.includes('claude') ||
                                    modelLower.includes('gemini');
    }
    
    return capabilities;
  } catch (error) {
    console.warn('probeModelCapabilities error:', error);
    // 返回基于模型名称的基本推断
    const modelLower = modelName.toLowerCase();
    capabilities.vision = modelLower.includes('vision') || modelLower.includes('4o') || modelLower.includes('turbo');
    capabilities.functionCalling = modelLower.includes('gpt') || modelLower.includes('claude') || modelLower.includes('gemini');
    return capabilities;
  }
};

export const processImage = async (base64Image) => {
  if (isElectron()) {
    return window.electron.processImage(base64Image);
  }
  console.warn('processImage not yet implemented for Tauri');
  return null;
};

// ==================== 事件接口扩展 ====================
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

// ==================== API Providers 同步事件 ====================
// 用于跨窗口同步 API providers 的可见模型配置
const API_PROVIDERS_UPDATE_EVENT = 'petgpt-api-providers-updated';

export const sendApiProvidersUpdate = async (data) => {
  // 1. 发送本地事件（同窗口内组件同步）
  window.dispatchEvent(new CustomEvent(API_PROVIDERS_UPDATE_EVENT, { detail: data }));
  
  // 2. 发送跨窗口事件
  if (isElectron()) {
    window.electron?.sendApiProvidersUpdate?.(data);
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    if (invoke) {
      try {
        await invoke('emit_to_all', { event: 'api-providers-updated', payload: data });
      } catch (e) {
        console.warn('Failed to emit api-providers-updated:', e);
      }
    }
  }
};

export const onApiProvidersUpdated = (callback) => {
  // 1. 监听本地事件（同窗口内）
  const localHandler = (e) => callback(e.detail);
  window.addEventListener(API_PROVIDERS_UPDATE_EVENT, localHandler);
  
  // 2. 监听跨窗口事件
  let tauriUnlisten = null;
  let cancelled = false;
  
  if (isElectron()) {
    // Electron 暂未实现
  }
  if (isTauri()) {
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('api-providers-updated', (event) => {
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            tauriUnlisten = fn;
          }
        });
      }
    });
  }
  
  return () => {
    window.removeEventListener(API_PROVIDERS_UPDATE_EVENT, localHandler);
    cancelled = true;
    if (tauriUnlisten) tauriUnlisten();
  };
};

// ==================== Skins 同步事件 ====================
// 使用本地事件 + Tauri 事件双重机制，确保同窗口和跨窗口都能同步
const SKINS_UPDATE_EVENT = 'petgpt-skins-updated';

export const sendSkinsUpdate = async (data) => {
  // 1. 发送本地事件（同窗口内组件同步）
  window.dispatchEvent(new CustomEvent(SKINS_UPDATE_EVENT, { detail: data }));
  
  // 2. 发送跨窗口事件
  if (isElectron()) {
    window.electron?.sendSkinsUpdate?.(data);
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    if (invoke) {
      try {
        await invoke('emit_to_all', { event: 'skins-updated', payload: data });
      } catch (e) {
        console.warn('Failed to emit skins-updated:', e);
      }
    }
  }
};

export const onSkinsUpdated = (callback) => {
  // 1. 监听本地事件（同窗口内）
  const localHandler = (e) => callback(e.detail);
  window.addEventListener(SKINS_UPDATE_EVENT, localHandler);
  
  // 2. 监听跨窗口事件
  let tauriUnlisten = null;
  let electronUnlisten = null;
  
  if (isElectron()) {
    electronUnlisten = window.electron?.onSkinsUpdated?.(callback);
  }
  
  if (isTauri()) {
    let cancelled = false;
    
    getTauriEventApi().then(eventApi => {
      if (cancelled) return;
      if (eventApi) {
        eventApi.listen('skins-updated', (event) => {
          callback(event.payload);
        }).then(fn => {
          if (cancelled) {
            fn();
          } else {
            tauriUnlisten = fn;
          }
        });
      }
    });
  }
  
  // 返回清理函数
  return () => {
    window.removeEventListener(SKINS_UPDATE_EVENT, localHandler);
    if (tauriUnlisten) tauriUnlisten();
    if (electronUnlisten) electronUnlisten();
  };
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

// 获取孤儿对话（关联的 assistant 已被删除）
export const getOrphanConversations = async () => {
  if (isElectron()) {
    // Electron 不支持此功能
    return [];
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('get_orphan_conversations');
  }
  
  return [];
};

// 将对话转移给新的 assistant
export const transferConversation = async (conversationId, newPetId) => {
  if (isElectron()) {
    // Electron 不支持此功能
    return false;
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('transfer_conversation', { conversationId, newPetId });
  }
  
  return false;
};

// 批量转移对话
export const transferAllConversations = async (oldPetId, newPetId) => {
  if (isElectron()) {
    // Electron 不支持此功能
    return 0;
  }
  
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    return invoke('transfer_all_conversations', { oldPetId, newPetId });
  }
  
  return 0;
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

// ==================== API Provider 接口 ====================

export const getApiProviders = async () => {
  if (isElectron()) {
    // Electron 暂不支持，返回空数组
    return [];
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      const result = await invoke('get_api_providers');
      return result || [];
    } catch (err) {
      console.error('[bridge.getApiProviders] Error:', err);
      return [];
    }
  }
  
  return [];
};

export const getApiProvider = async (id) => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      return await invoke('get_api_provider', { id });
    } catch (err) {
      console.error('[bridge.getApiProvider] Error:', err);
      return null;
    }
  }
  
  return null;
};

export const createApiProvider = async (data) => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      const result = await invoke('create_api_provider', { data });
      return result;
    } catch (err) {
      console.error('[bridge.createApiProvider] Error:', err);
      throw err;
    }
  }
  
  return null;
};

export const updateApiProvider = async (id, data) => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      const result = await invoke('update_api_provider', { id, data });
      return result;
    } catch (err) {
      console.error('[bridge.updateApiProvider] Error:', err);
      throw err;
    }
  }
  
  return null;
};

export const deleteApiProvider = async (id) => {
  if (isElectron()) {
    return false;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      return await invoke('delete_api_provider', { id });
    } catch (err) {
      console.error('[bridge.deleteApiProvider] Error:', err);
      return false;
    }
  }
  
  return false;
};

export const updateApiProviderModels = async (id, models) => {
  if (isElectron()) {
    return false;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      // models 应该是 JSON 字符串
      const modelsStr = typeof models === 'string' ? models : JSON.stringify(models);
      return await invoke('update_api_provider_models', { id, models: modelsStr });
    } catch (err) {
      console.error('[bridge.updateApiProviderModels] Error:', err);
      return false;
    }
  }
  
  return false;
};

export const setApiProviderValidated = async (id, validated) => {
  if (isElectron()) {
    return false;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      return await invoke('set_api_provider_validated', { id, validated });
    } catch (err) {
      console.error('[bridge.setApiProviderValidated] Error:', err);
      return false;
    }
  }
  
  return false;
};

// API Provider 便捷对象
export const apiProviders = {
  getAll: getApiProviders,
  get: getApiProvider,
  create: createApiProvider,
  update: updateApiProvider,
  delete: deleteApiProvider,
  updateModels: updateApiProviderModels,
  setValidated: setApiProviderValidated,
};

// ==================== Skins 接口 ====================

export const getSkins = async () => {
  if (isElectron()) {
    return [];
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      const result = await invoke('get_skins');
      return result || [];
    } catch (err) {
      console.error('[bridge.getSkins] Error:', err);
      return [];
    }
  }
  
  return [];
};

export const getSkin = async (id) => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      return await invoke('get_skin', { id });
    } catch (err) {
      console.error('[bridge.getSkin] Error:', err);
      return null;
    }
  }
  
  return null;
};

export const importSkin = async (name, author, imageData) => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      const result = await invoke('import_skin', { name, author, imageData });
      return result;
    } catch (err) {
      console.error('[bridge.importSkin] Error:', err);
      throw err;
    }
  }
  
  return null;
};

export const deleteSkin = async (id) => {
  if (isElectron()) {
    return false;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      return await invoke('delete_skin_with_files', { id });
    } catch (err) {
      console.error('[bridge.deleteSkin] Error:', err);
      return false;
    }
  }
  
  return false;
};

export const getSkinImagePath = async (skinId, mood) => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      return await invoke('get_skin_image_path', { skinId, mood });
    } catch (err) {
      console.error('[bridge.getSkinImagePath] Error:', err);
      return null;
    }
  }
  
  return null;
};

// 获取皮肤图片的可显示 URL（使用 Tauri asset 协议）
export const getSkinImageUrl = async (skinId, mood = 'normal') => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      // 获取本地文件路径
      const filePath = await getSkinImagePath(skinId, mood);
      if (!filePath) return null;
      
      // 使用 Tauri 的 convertFileSrc 转换为可访问的 URL
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      return convertFileSrc(filePath);
    } catch (err) {
      console.error('[bridge.getSkinImageUrl] Error:', err);
      // 降级为 base64 方案
      return await readSkinImage(skinId, mood);
    }
  }
  
  return null;
};

// 读取皮肤图片（返回 base64 data URL，备用方案）
export const readSkinImage = async (skinId, mood) => {
  if (isElectron()) {
    return null;
  }
  
  if (isTauri()) {
    try {
      const { invoke } = await getTauriApi();
      return await invoke('read_skin_image', { skinId, mood });
    } catch (err) {
      console.error('[bridge.readSkinImage] Error:', err);
      return null;
    }
  }
  
  return null;
};

// Skins 便捷对象
export const skinsApi = {
  getAll: getSkins,
  get: getSkin,
  import: importSkin,
  delete: deleteSkin,
  readImage: readSkinImage,
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

// ==================== Manage Window (统一的管理窗口) ====================

export const changeManageWindow = async (tab = 'assistants') => {
  if (isElectron()) {
    // Electron 兼容：根据 tab 调用对应的旧函数
    if (tab === 'assistants') {
      window.electron?.changeSelectCharacterWindow?.();
    } else if (tab === 'api') {
      window.electron?.changeApiWindow?.();
    } else if (tab === 'mcp') {
      window.electron?.changeMcpWindow?.();
    } else if (tab === 'ui' || tab === 'models' || tab === 'hotkeys') {
      window.electron?.changeSettingsWindow?.();
    }
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('open_manage_window_with_tab', { tab });
  }
};

export const hideManageWindow = async () => {
  if (isElectron()) {
    // Electron 没有统一窗口，暂不处理
  }
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('hide_manage_window');
  }
};

// 兼容旧的设置窗口函数
export const changeSettingsWindow = async () => {
  await changeManageWindow('ui');
};

export const hideSettingsWindow = async () => {
  await hideManageWindow();
};

// 兼容旧的函数名
export const changeSelectCharacterWindow = async () => {
  await changeManageWindow('assistants');
};

export const changeMcpWindow = async () => {
  await changeManageWindow('mcp');
};

export const changeApiWindow = async () => {
  await changeManageWindow('api');
};

export const hideSelectCharacterWindow = async () => {
  await hideManageWindow();
};

export const hideApiWindow = async () => {
  await hideManageWindow();
};

export const hideMcpWindow = async () => {
  await hideManageWindow();
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

// 更新偏好设置到 Rust 后端
export const updatePreferences = async (preferences = {}) => {
  if (isTauri()) {
    const { invoke } = await getTauriApi();
    await invoke('update_preferences', {
      chatFollowsCharacter: preferences.chatFollowsCharacter
    });
  }
};

// Tauri 窗口控制扩展

// 开始拖动窗口 (用于自定义拖动区域)
export const startDragging = async (label = 'character') => {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      await win.startDragging();
    } catch (err) {
      console.error('[bridge.startDragging] Error:', err);
    }
  }
};

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
  
  // Dialog
  confirm,
  
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
  getOrphanConversations,
  transferConversation,
  transferAllConversations,
  
  // Messages
  getMessages,
  createMessage,
  
  // API Providers
  apiProviders,
  getApiProviders,
  getApiProvider,
  createApiProvider,
  updateApiProvider,
  deleteApiProvider,
  updateApiProviderModels,
  setApiProviderValidated,
  
  // Skins
  skinsApi,
  getSkins,
  getSkin,
  importSkin,
  deleteSkin,
  readSkinImage,
  
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
  changeApiWindow,
  hideApiWindow,
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
  sendApiProvidersUpdate,
  onApiProvidersUpdated,
  onManageWindowVisibilityChanged,
  updatePreferences,
};
export default bridge;
