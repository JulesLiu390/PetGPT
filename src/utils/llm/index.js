/**
 * LLM 统一入口
 * 
 * 提供统一的 callLLM / callLLMStream 接口，
 * 根据 apiFormat 自动选择合适的 adapter
 * 
 * API Formats:
 * - openai_compatible: OpenAI / Grok / Ollama / 其他兼容服务
 * - gemini_official: Google Gemini 官方 REST API (支持更多多模态)
 */

import * as openaiAdapter from './adapters/openaiCompatible.js';
import * as geminiAdapter from './adapters/geminiOfficial.js';

/**
 * 根据 apiFormat 获取对应的 adapter
 * @param {string} apiFormat - 'openai_compatible' | 'gemini_official'
 */
const getAdapter = (apiFormat) => {
  if (apiFormat === 'gemini_official') {
    return geminiAdapter;
  }
  // 默认走 OpenAI-compatible (包括旧 provider 值的兼容)
  return openaiAdapter;
};

/**
 * 非流式调用 LLM
 * 
 * @param {Object} config
 * @param {Array} config.messages - 消息数组 (内部格式或外部格式均可)
 * @param {string} config.apiFormat - 'openai_compatible' | 'gemini_official'
 * @param {string} config.apiKey
 * @param {string} config.model
 * @param {string} [config.baseUrl] - 可选，自定义 API URL
 * @param {Object} [config.options] - 可选，其他参数如 temperature
 * @returns {Promise<{ content: string, usage?: Object, raw?: Object }>}
 */
export const callLLM = async ({ messages, apiFormat, apiKey, model, baseUrl, options = {} }) => {
  const adapter = getAdapter(apiFormat);
  
  // 对于 Gemini，清理历史中缺少 thought_signature 的工具调用消息
  let cleanedMessages = messages;
  if (apiFormat === 'gemini_official' && geminiAdapter.cleanHistoryForGemini) {
    cleanedMessages = geminiAdapter.cleanHistoryForGemini(messages, false);
  }
  
  try {
    const req = await adapter.buildRequest({
      messages: cleanedMessages,
      apiFormat,
      apiKey,
      model,
      baseUrl,
      options: { ...options, stream: false }
    });
    
    const response = await fetch(req.endpoint, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API Error: ${response.statusText}`);
    }
    
    const data = await response.json();
    return adapter.parseResponse(data);
    
  } catch (error) {
    console.error(`[LLM ${apiFormat}] Error:`, error);
    return {
      content: `Error: ${error.message}`,
      error: true
    };
  }
};

/**
 * 流式调用 LLM
 * 
 * @param {Object} config
 * @param {Array} config.messages
 * @param {string} config.apiFormat - 'openai_compatible' | 'gemini_official'
 * @param {string} config.apiKey
 * @param {string} config.model
 * @param {string} [config.baseUrl]
 * @param {Object} [config.options]
 * @param {Function} config.onChunk - (deltaText: string, fullText: string) => void
 * @param {AbortSignal} [config.abortSignal]
 * @returns {Promise<{ content: string, usage?: Object }>}
 */
export const callLLMStream = async ({ 
  messages, 
  apiFormat, 
  apiKey, 
  model, 
  baseUrl, 
  options = {},
  onChunk,
  abortSignal 
}) => {
  const adapter = getAdapter(apiFormat);
  
  // 对于 Gemini，清理历史中缺少 thought_signature 的工具调用消息
  let cleanedMessages = messages;
  if (apiFormat === 'gemini_official' && geminiAdapter.cleanHistoryForGemini) {
    cleanedMessages = geminiAdapter.cleanHistoryForGemini(messages, false);
  }
  
  try {
    const req = await adapter.buildRequest({
      messages: cleanedMessages,
      apiFormat,
      apiKey,
      model,
      baseUrl,
      options: { ...options, stream: true }
    });
    
    const response = await fetch(req.endpoint, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: abortSignal
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API Error: ${response.statusText}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // 处理 SSE 格式
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          
          const { deltaText } = adapter.parseStreamChunk(jsonStr);
          if (deltaText) {
            fullText += deltaText;
            if (onChunk) {
              onChunk(deltaText, fullText);
            }
          }
        }
      }
    }
    
    return { content: fullText };
    
  } catch (error) {
    if (error.name === 'AbortError') {
      return { content: 'Aborted', aborted: true };
    }
    console.error(`[LLM Stream ${apiFormat}] Error:`, error);
    return {
      content: `Error: ${error.message}`,
      error: true
    };
  }
};

/**
 * 获取 apiFormat 支持的能力
 */
export const getCapabilities = (apiFormat) => {
  const adapter = getAdapter(apiFormat);
  return adapter.capabilities;
};

/**
 * 获取可用模型列表
 */
export const fetchModels = async ({ apiFormat, apiKey, baseUrl }) => {
  if (apiFormat === 'gemini_official') {
    return geminiAdapter.fetchModels(apiKey);
  }
  
  // OpenAI-compatible: 需要传入 baseUrl
  let url = baseUrl;
  if (url === 'default' || !url) {
    url = 'https://api.openai.com/v1';
  } else if (!url.endsWith('/v1')) {
    url = url.endsWith('/') ? url + 'v1' : url + '/v1';
  }
  
  const response = await fetch(`${url}/models`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`API Error: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data || [];
};

export default {
  callLLM,
  callLLMStream,
  getCapabilities,
  fetchModels
};
