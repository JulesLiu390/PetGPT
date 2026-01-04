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
 * 
 * @param {Object} config
 * @param {Array} config.messages - 消息数组
 * @param {string} config.apiKey
 * @param {string} config.model
 * @param {Object} config.options
 * @param {boolean} config.options.enableSearch - 是否启用原生 Google Search grounding
 * @param {Array} config.options.tools - Gemini 格式的工具数组 (function declarations)
 * @param {string} config.options.tool_choice - 工具选择: 'auto' | 'none' | 'any'
 */
export const buildRequest = async ({ messages, apiKey, model, options = {} }) => {
  const { contents, systemInstruction } = await convertMessages(messages);
  const isStream = options.stream || false;
  const enableSearch = options.enableSearch || false;
  
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
  
  // 添加 MCP 工具支持 (function calling)
  if (options.tools && options.tools.length > 0) {
    body.tools = [{
      function_declarations: options.tools
    }];
    
    // 设置工具配置
    if (options.tool_choice) {
      const modeMap = {
        'auto': 'AUTO',
        'none': 'NONE',
        'any': 'ANY',
        'required': 'ANY'  // OpenAI 的 required 对应 Gemini 的 ANY
      };
      body.tool_config = {
        function_calling_config: {
          mode: modeMap[options.tool_choice] || 'AUTO'
        }
      };
    }
  }
  
  // 启用 Google Search grounding
  // TODO: Gemini google_search 工具支持因模型而异，暂时禁用
  // 用户选择 native 时会自动 fallback 到 DuckDuckGo 注入
  if (enableSearch) {
    console.log('[Gemini] google_search tool requested but disabled for now - falling back to injected search');
    // 暂时不添加 tools，让调用方 fallback
    // body.tools = [{ google_search: {} }];
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
 * 
 * @param {Object} responseJson - API 响应
 * @returns {Object} 解析结果，包含 content、toolCalls、usage、raw
 */
export const parseResponse = (responseJson) => {
  const parts = responseJson.candidates?.[0]?.content?.parts || [];
  
  // 提取文本内容
  const textParts = parts.filter(p => p.text);
  const text = textParts.map(p => p.text).join('');
  
  // 解析函数调用
  let toolCalls = null;
  const functionCallParts = parts.filter(p => p.functionCall);
  
  if (functionCallParts.length > 0) {
    toolCalls = functionCallParts.map((part, index) => ({
      id: `call_${index}_${Date.now()}`,
      name: part.functionCall.name,
      arguments: part.functionCall.args || {}
    }));
  }
  
  return {
    content: text,
    toolCalls,
    finishReason: responseJson.candidates?.[0]?.finishReason,
    usage: responseJson.usageMetadata,
    raw: responseJson
  };
};

/**
 * 解析流式响应块 (SSE)
 * 
 * @param {string|Object} chunk - SSE 数据块
 * @returns {Object} 解析结果，包含 deltaText、deltaToolCalls、done
 */
export const parseStreamChunk = (chunk) => {
  // Gemini SSE: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
  if (!chunk) {
    return { deltaText: '', deltaToolCalls: null, done: false };
  }
  
  try {
    const data = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
    const parts = data.candidates?.[0]?.content?.parts || [];
    
    // 提取文本
    const textParts = parts.filter(p => p.text);
    const deltaText = textParts.map(p => p.text).join('');
    
    // 提取函数调用
    let deltaToolCalls = null;
    const functionCallParts = parts.filter(p => p.functionCall);
    if (functionCallParts.length > 0) {
      deltaToolCalls = functionCallParts.map((part, index) => ({
        index,
        id: `call_${index}_${Date.now()}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {}
      }));
    }
    
    const done = data.candidates?.[0]?.finishReason != null;
    return { deltaText, deltaToolCalls, done, finishReason: data.candidates?.[0]?.finishReason };
  } catch (e) {
    return { deltaText: '', deltaToolCalls: null, done: false };
  }
};

/**
 * 格式化工具结果为 Gemini 消息格式
 * 
 * @param {string} name - 函数名
 * @param {*} result - 执行结果
 * @returns {Object} Gemini function response part
 */
export const formatToolResultPart = (name, result) => ({
  functionResponse: {
    name: name,
    response: {
      result: typeof result === 'string' ? result : JSON.stringify(result)
    }
  }
});

/**
 * 创建带有函数调用的 model 消息
 * 
 * @param {Array} toolCalls - 工具调用数组
 * @returns {Object} Gemini model message with function calls
 */
export const createModelFunctionCallMessage = (toolCalls) => ({
  role: 'model',
  parts: toolCalls.map(tc => ({
    functionCall: {
      name: tc.name,
      args: tc.arguments
    }
  }))
});

/**
 * 创建函数响应的 user 消息
 * 
 * @param {Array} results - [{name, result}] 数组
 * @returns {Object} Gemini user message with function responses
 */
export const createFunctionResponseMessage = (results) => ({
  role: 'user',
  parts: results.map(r => formatToolResultPart(r.name, r.result))
});

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
  fetchModels,
  formatToolResultPart,
  createModelFunctionCallMessage,
  createFunctionResponseMessage
};
