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
 */
export const buildRequest = async ({ messages, apiFormat, apiKey, model, baseUrl, options = {} }) => {
  const url = getApiUrl(apiFormat, baseUrl);
  const convertedMessages = await convertMessages(messages);
  
  return {
    endpoint: `${url}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: {
      model,
      messages: convertedMessages,
      stream: options.stream || false,
      ...(options.temperature !== undefined && { temperature: options.temperature })
    }
  };
};

/**
 * 解析响应
 */
export const parseResponse = (responseJson) => {
  const content = responseJson.choices?.[0]?.message?.content || '';
  return {
    content,
    usage: responseJson.usage,
    raw: responseJson
  };
};

/**
 * 解析流式响应块
 */
export const parseStreamChunk = (chunk) => {
  // OpenAI SSE: data: {"choices":[{"delta":{"content":"..."}}]}
  if (!chunk || chunk === '[DONE]') {
    return { deltaText: '', done: true };
  }
  
  try {
    const data = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
    const deltaText = data.choices?.[0]?.delta?.content || '';
    const done = data.choices?.[0]?.finish_reason != null;
    return { deltaText, done };
  } catch (e) {
    return { deltaText: '', done: false };
  }
};

export default {
  capabilities,
  convertMessages,
  buildRequest,
  parseResponse,
  parseStreamChunk
};
