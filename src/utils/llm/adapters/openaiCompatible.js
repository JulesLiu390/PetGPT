/**
 * OpenAI Compatible Adapter
 * 
 * 处理 OpenAI API 以及兼容的其他 provider (如 Grok, 自定义端点等)
 * 
 * 能力:
 * - 图片: 支持 (via vision)
 * - 视频/音频: 不支持 (降级为文本引用)
 * - 文档: 不支持 (降级为文本引用)
 */

import { normalizeMessages, extractTextFromContent, expandDocumentPartsToText } from '../normalize.js';
import { readFileAsBase64, parseDataUri, isOpenAISupportedMime, getFileFallbackText } from '../media.js';

// Provider 默认 URL 映射
const PROVIDER_URLS = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",  // OpenAI-compatible endpoint
  anthropic: "https://api.anthropic.com/v1",
  grok: "https://api.x.ai/v1"
};

/**
 * 能力描述
 */
export const capabilities = {
  supportsImage: true,
  supportsVideo: false,
  supportsAudio: false,
  supportsPdf: false,
  supportsDocx: false,
  supportsInlineData: true,
  maxInlineBytes: 20 * 1024 * 1024  // 20MB
};

/**
 * 获取完整的 API URL
 */
const getApiUrl = (apiFormat, baseUrl) => {
  if (baseUrl && baseUrl !== 'default') {
    let url = baseUrl;
    if (!url.endsWith('/v1') && !url.endsWith('/v1/')) {
      url = url.endsWith('/') ? url + 'v1' : url + '/v1';
    }
    return url;
  }
  // 兼容旧的 provider 值
  return PROVIDER_URLS[apiFormat] || PROVIDER_URLS.openai;
};

/**
 * 将内部格式消息转换为 OpenAI API 格式
 * 
 * @param {Array} messages - 内部格式的消息数组
 * @returns {Promise<Array>} OpenAI 格式的消息数组
 */
export const convertMessages = async (messages) => {
  // 先把 docx/txt 等文档内容展开成 text parts（让 OpenAI 真正“读到”）
  const expanded = await expandDocumentPartsToText(messages);
  const normalizedMessages = normalizeMessages(expanded);
  const result = [];
  
  for (const msg of normalizedMessages) {
    const convertedContent = [];
    
    for (const part of msg.content) {
      if (part.type === 'text') {
        convertedContent.push({ type: 'text', text: part.text });
        continue;
      }
      
      if (part.type === 'image') {
        // OpenAI 支持图片
        let imageUrl = part.url;
        
        // 如果是本地路径，需要读取为 base64
        if (!imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
          const base64Data = await readFileAsBase64(imageUrl);
          if (base64Data) {
            imageUrl = base64Data;
          } else {
            // 读取失败，降级为文本
            convertedContent.push({ type: 'text', text: getFileFallbackText(part) });
            continue;
          }
        }
        
        convertedContent.push({
          type: 'image_url',
          image_url: { url: imageUrl }
        });
        continue;
      }
      
      // 视频、音频、文件 - OpenAI 不支持，降级为文本
      if (['video', 'audio', 'file'].includes(part.type)) {
        convertedContent.push({ type: 'text', text: getFileFallbackText(part) });
        continue;
      }
    }
    
    // 如果只有一个文本 part，简化为字符串
    let finalContent;
    if (convertedContent.length === 1 && convertedContent[0].type === 'text') {
      finalContent = convertedContent[0].text;
    } else if (convertedContent.length === 0) {
      finalContent = '';
    } else {
      finalContent = convertedContent;
    }
    
    result.push({
      role: msg.role,
      content: finalContent
    });
  }
  
  return result;
};

/**
 * 构建 API 请求
 * 
 * @param {Object} config
 * @param {Array} config.messages - 消息数组
 * @param {string} config.apiFormat
 * @param {string} config.apiKey
 * @param {string} config.model
 * @param {string} config.baseUrl
 * @param {Object} config.options
 * @param {Array} config.options.tools - OpenAI 格式的工具数组 (可选)
 * @param {string} config.options.tool_choice - 工具选择策略: 'auto' | 'none' | 'required' (可选)
 */
export const buildRequest = async ({ messages, apiFormat, apiKey, model, baseUrl, options = {} }) => {
  const url = getApiUrl(apiFormat, baseUrl);
  const convertedMessages = await convertMessages(messages);
  
  const body = {
    model,
    messages: convertedMessages,
    stream: options.stream || false,
    ...(options.temperature !== undefined && { temperature: options.temperature })
  };
  
  // 添加工具支持
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }
  
  return {
    endpoint: `${url}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body
  };
};

/**
 * 解析响应
 * 
 * @param {Object} responseJson - API 响应
 * @returns {Object} 解析结果，包含 content、toolCalls、usage、raw
 */
export const parseResponse = (responseJson) => {
  const message = responseJson.choices?.[0]?.message;
  const content = message?.content || '';
  
  // 解析工具调用
  let toolCalls = null;
  if (message?.tool_calls && message.tool_calls.length > 0) {
    toolCalls = message.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}')
    }));
  }
  
  return {
    content,
    toolCalls,
    finishReason: responseJson.choices?.[0]?.finish_reason,
    usage: responseJson.usage,
    raw: responseJson
  };
};

/**
 * 解析流式响应块
 * 
 * @param {string|Object} chunk - SSE 数据块
 * @returns {Object} 解析结果，包含 deltaText、deltaToolCalls、done
 */
export const parseStreamChunk = (chunk) => {
  // OpenAI SSE: data: {"choices":[{"delta":{"content":"..."}}]}
  if (!chunk || chunk === '[DONE]') {
    return { deltaText: '', deltaToolCalls: null, done: true };
  }
  
  try {
    const data = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
    const delta = data.choices?.[0]?.delta;
    const deltaText = delta?.content || '';
    const done = data.choices?.[0]?.finish_reason != null;
    
    // 解析流式工具调用
    let deltaToolCalls = null;
    if (delta?.tool_calls) {
      deltaToolCalls = delta.tool_calls.map(tc => ({
        index: tc.index,
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments || ''
      }));
    }
    
    return { deltaText, deltaToolCalls, done, finishReason: data.choices?.[0]?.finish_reason };
  } catch (e) {
    return { deltaText: '', deltaToolCalls: null, done: false };
  }
};

/**
 * 格式化工具结果消息（支持多模态：图片等）
 * 
 * @param {string} toolCallId - 工具调用 ID
 * @param {*} result - 工具执行结果（文本）
 * @param {Array<{data: string, mimeType: string}>} images - 可选的图片数组
 * @returns {Object} OpenAI tool message
 */
export const formatToolResultMessage = (toolCallId, result, images = []) => {
  const textContent = typeof result === 'string' ? result : JSON.stringify(result);
  
  // 没有图片时，返回纯文本内容
  if (!images || images.length === 0) {
    return {
      role: "tool",
      tool_call_id: toolCallId,
      content: textContent
    };
  }
  
  // 有图片时，构建多模态内容数组 (text + image_url parts)
  const content = [{ type: "text", text: textContent }];
  
  for (const img of images) {
    let url;
    if (img.data.startsWith('http://') || img.data.startsWith('https://')) {
      url = img.data;
    } else if (img.data.startsWith('data:')) {
      url = img.data;
    } else {
      // raw base64 → data URI
      url = `data:${img.mimeType};base64,${img.data}`;
    }
    content.push({ type: "image_url", image_url: { url } });
  }
  
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content
  };
};

/**
 * 创建带有工具调用的 assistant 消息
 * 
 * @param {Array} toolCalls - 工具调用数组
 * @returns {Object} Assistant message
 */
export const createAssistantToolCallMessage = (toolCalls) => ({
  role: "assistant",
  content: null,
  tool_calls: toolCalls.map(tc => ({
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
    }
  }))
});

export default {
  capabilities,
  convertMessages,
  buildRequest,
  parseResponse,
  parseStreamChunk,
  formatToolResultMessage,
  createAssistantToolCallMessage
};
