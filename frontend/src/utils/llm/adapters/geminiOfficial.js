/**
 * Gemini Official API Adapter
 * 
 * 处理 Google Gemini 官方 REST API (非 OpenAI-compatible endpoint)
 * 
 * 能力:
 * - 图片: 支持 (inline_data)
 * - 视频: 支持 (inline_data，有大小限制)
 * - 音频: 支持 (inline_data)
 * - PDF: 支持 (inline_data)
 * - Office 文档 (docx/xlsx/pptx): 不支持 (降级为文本引用)
 */

import { normalizeMessages, expandDocumentPartsToText } from '../normalize.js';
import { readFileAsBase64, parseDataUri, isGeminiSupportedMime, getFileFallbackText, isFileTooLarge } from '../media.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * 能力描述
 */
export const capabilities = {
  supportsImage: true,
  supportsVideo: true,
  supportsAudio: true,
  supportsPdf: true,
  supportsDocx: false,  // Gemini 不直接支持 Office 文档
  supportsInlineData: true,
  maxInlineBytes: 20 * 1024 * 1024  // 20MB for inline_data
};

/**
 * 将内部格式消息转换为 Gemini API 格式
 * 
 * Gemini 格式:
 * {
 *   contents: [{ role: 'user'|'model', parts: [{ text: '...' }, { inline_data: { mime_type, data } }] }],
 *   system_instruction: { parts: [{ text: '...' }] }
 * }
 */
export const convertMessages = async (messages) => {
  // docx/txt 等文档先抽取成 text，Gemini 才能基于内容回答
  const expanded = await expandDocumentPartsToText(messages);
  const normalizedMessages = normalizeMessages(expanded);
  const contents = [];
  let systemInstruction = null;
  
  for (const msg of normalizedMessages) {
    // 处理 system 消息
    if (msg.role === 'system') {
      const systemText = msg.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
      
      systemInstruction = {
        parts: [{ text: systemText }]
      };
      continue;
    }
    
    // user / assistant
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    
    for (const part of msg.content) {
      if (part.type === 'text') {
        parts.push({ text: part.text });
        continue;
      }
      
      // 媒体类型 (image, video, audio, file)
      const mimeType = part.mime_type;
      const isSupported = isGeminiSupportedMime(mimeType);
      
      if (!isSupported) {
        // 不支持的类型，降级为文本
        parts.push({ text: getFileFallbackText(part) });
        continue;
      }
      
      // 尝试读取文件
      let dataUri = part.url;
      if (!dataUri?.startsWith('data:') && !dataUri?.startsWith('http')) {
        dataUri = await readFileAsBase64(part.url);
      }
      
      if (!dataUri) {
        parts.push({ text: getFileFallbackText(part) });
        continue;
      }
      
      // 解析 data URI
      const parsed = parseDataUri(dataUri);
      if (!parsed) {
        // 可能是 http URL，Gemini inline_data 不支持 URL，需要降级
        parts.push({ text: getFileFallbackText(part) });
        continue;
      }
      
      // 检查大小限制
      if (isFileTooLarge(parsed.data, capabilities.maxInlineBytes)) {
        parts.push({ text: `[File too large: ${part.name || part.url}]` });
        continue;
      }
      
      parts.push({
        inline_data: {
          mime_type: parsed.mimeType,
          data: parsed.data
        }
      });
    }
    
    // 确保至少有一个 part
    if (parts.length === 0) {
      parts.push({ text: '' });
    }
    
    contents.push({ role, parts });
  }
  
  return { contents, systemInstruction };
};

/**
 * 构建 API 请求
 */
export const buildRequest = async ({ messages, apiKey, model, options = {} }) => {
  const { contents, systemInstruction } = await convertMessages(messages);
  const isStream = options.stream || false;
  
  const endpoint = isStream
    ? `${GEMINI_BASE_URL}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    : `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`;
  
  const body = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.7
    }
  };
  
  if (systemInstruction) {
    body.system_instruction = systemInstruction;
  }
  
  return {
    endpoint,
    headers: {
      'Content-Type': 'application/json'
    },
    body
  };
};

/**
 * 解析响应
 */
export const parseResponse = (responseJson) => {
  const text = responseJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return {
    content: text,
    usage: responseJson.usageMetadata,
    raw: responseJson
  };
};

/**
 * 解析流式响应块 (SSE)
 */
export const parseStreamChunk = (chunk) => {
  // Gemini SSE: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
  if (!chunk) {
    return { deltaText: '', done: false };
  }
  
  try {
    const data = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
    const deltaText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const done = data.candidates?.[0]?.finishReason != null;
    return { deltaText, done };
  } catch (e) {
    return { deltaText: '', done: false };
  }
};

/**
 * 获取可用模型列表
 */
export const fetchModels = async (apiKey) => {
  const url = `${GEMINI_BASE_URL}/models?key=${apiKey}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Gemini API Error: ${response.statusText}`);
  }
  
  const data = await response.json();
  return (data.models || []).map(m => ({
    id: m.name.replace('models/', ''),
    ...m
  }));
};

export default {
  capabilities,
  convertMessages,
  buildRequest,
  parseResponse,
  parseStreamChunk,
  fetchModels
};
