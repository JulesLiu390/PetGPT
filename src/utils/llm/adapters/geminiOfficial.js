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
 * 清理历史消息中缺少 thought_signature 的工具调用
 * 
 * Gemini API 要求 functionCall parts 必须包含 thought_signature，
 * 但从数据库加载的历史消息不包含这个签名。
 * 此函数将历史中的工具调用轮次压缩为纯文本消息。
 * 
 * @param {Array} messages - 消息数组
 * @param {boolean} isCurrentToolLoop - 是否在当前工具调用循环中（内部消息保留签名）
 * @returns {Array} 清理后的消息数组
 */
export const cleanHistoryForGemini = (messages, isCurrentToolLoop = false) => {
  if (isCurrentToolLoop) {
    // 当前工具循环中的消息，保留原样（它们有 _rawPart 和签名）
    return messages;
  }
  
  const cleaned = [];
  
  for (const msg of messages) {
    // 检查是否是带有 functionCall/functionResponse 的 Gemini 格式消息
    if (msg.parts && Array.isArray(msg.parts)) {
      const hasFunctionPart = msg.parts.some(p => p.functionCall || p.functionResponse);
      
      if (hasFunctionPart) {
        // 检查是否有 thought_signature（当前轮次的消息会有）
        const hasSignature = msg.parts.some(p => p.thought_signature);
        
        if (!hasSignature) {
          // 没有签名的工具调用消息 - 跳过（来自历史）
          // 这些消息的内容已经被总结在后续的 assistant 回复中了
          console.log('[Gemini] Skipping history message with functionCall/functionResponse (no signature)');
          continue;
        }
      }
    }
    
    // 检查内部格式的消息是否有 toolCallHistory（来自数据库的历史消息标记）
    // 这些消息的 content 已经是工具调用后的总结文本，可以直接使用
    if (msg.toolCallHistory && msg.role === 'assistant') {
      // 只保留文本内容，移除 toolCallHistory 标记（它只用于 UI 显示）
      cleaned.push({
        role: msg.role,
        content: msg.content
      });
      continue;
    }
    
    cleaned.push(msg);
  }
  
  return cleaned;
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
  // 先分离出已经是 Gemini 格式的消息（来自工具调用循环）
  // 这些消息不应该经过 normalizeMessages，否则会丢失 parts 字段
  const geminiFormatMessages = [];
  const regularMessages = [];
  
  for (const msg of messages) {
    // 检查是否已经是 Gemini 格式（带有 functionCall 或 functionResponse 的 parts）
    if ((msg.role === 'model' || msg.role === 'user') && msg.parts && Array.isArray(msg.parts)) {
      const hasFunctionPart = msg.parts.some(p => p.functionCall || p.functionResponse);
      if (hasFunctionPart) {
        geminiFormatMessages.push({ index: messages.indexOf(msg), msg });
        continue;
      }
    }
    regularMessages.push(msg);
  }
  
  // docx/txt 等文档先抽取成 text，Gemini 才能基于内容回答
  const expanded = await expandDocumentPartsToText(regularMessages);
  const normalizedMessages = normalizeMessages(expanded);
  const contents = [];
  let systemInstruction = null;
  
  // 建立原始索引到处理后索引的映射
  let regularIndex = 0;
  
  for (let i = 0; i < messages.length; i++) {
    // 检查这个位置是否有 Gemini 格式的消息
    const geminiMsg = geminiFormatMessages.find(g => g.index === i);
    if (geminiMsg) {
      // 直接添加 Gemini 格式的消息
      contents.push({
        role: geminiMsg.msg.role,
        parts: geminiMsg.msg.parts
      });
      continue;
    }
    
    // 处理普通消息
    if (regularIndex >= normalizedMessages.length) continue;
    const msg = normalizedMessages[regularIndex];
    regularIndex++;
    
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
 * @returns {Object} 解析结果，包含 content、toolCalls、usage、raw、rawFunctionCallParts
 */
export const parseResponse = (responseJson) => {
  const parts = responseJson.candidates?.[0]?.content?.parts || [];
  
  // 提取文本内容
  const textParts = parts.filter(p => p.text);
  const text = textParts.map(p => p.text).join('');
  
  // 解析函数调用，保留原始 parts 以便保留 thought_signature
  let toolCalls = null;
  let rawFunctionCallParts = null;
  const functionCallParts = parts.filter(p => p.functionCall);
  
  if (functionCallParts.length > 0) {
    // 保存原始的 function call parts（包含 thought_signature）
    rawFunctionCallParts = functionCallParts;
    
    toolCalls = functionCallParts.map((part, index) => ({
      id: `call_${index}_${Date.now()}`,
      name: part.functionCall.name,
      arguments: part.functionCall.args || {},
      // 保留原始 part 用于后续构建请求时携带 thought_signature
      _rawPart: part
    }));
  }
  
  return {
    content: text,
    toolCalls,
    rawFunctionCallParts, // 原始的 function call parts，包含 thought_signature
    finishReason: responseJson.candidates?.[0]?.finishReason,
    usage: responseJson.usageMetadata,
    raw: responseJson
  };
};

/**
 * 解析流式响应块 (SSE)
 * 
 * @param {string|Object} chunk - SSE 数据块
 * @returns {Object} 解析结果，包含 deltaText、deltaToolCalls、done、error
 */
export const parseStreamChunk = (chunk) => {
  // Gemini SSE: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
  if (!chunk || chunk.trim() === '') {
    return { deltaText: '', deltaToolCalls: null, done: false };
  }
  
  // 跳过 Gemini 的非 JSON 行（如空行或注释）
  const trimmed = chunk.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    // 可能是错误消息或其他非 JSON 内容
    if (trimmed.length > 0 && trimmed !== '[DONE]') {
      console.warn('[Gemini] Non-JSON chunk received:', trimmed.substring(0, 100));
    }
    return { deltaText: '', deltaToolCalls: null, done: false };
  }
  
  try {
    const data = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
    
    // 检查是否有 API 错误
    if (data.error) {
      console.error('[Gemini] API error in stream:', data.error);
      return { 
        deltaText: '', 
        deltaToolCalls: null, 
        done: true, 
        error: data.error.message || JSON.stringify(data.error)
      };
    }
    
    // 检查安全过滤 (promptFeedback)
    if (data.promptFeedback?.blockReason) {
      const reason = data.promptFeedback.blockReason;
      console.warn('[Gemini] Content blocked by safety filter:', reason);
      return { 
        deltaText: `[Content blocked: ${reason}]`, 
        deltaToolCalls: null, 
        done: true,
        error: `Safety filter: ${reason}`
      };
    }
    
    // 检查 candidates
    if (!data.candidates || data.candidates.length === 0) {
      // 可能是 usageMetadata 等中间响应，不是错误
      if (data.usageMetadata) {
        return { deltaText: '', deltaToolCalls: null, done: true };
      }
      return { deltaText: '', deltaToolCalls: null, done: false };
    }
    
    const candidate = data.candidates[0];
    
    // 检查候选是否被安全过滤
    if (candidate.finishReason === 'SAFETY') {
      console.warn('[Gemini] Response blocked by safety filter');
      return { 
        deltaText: '[Response blocked by safety filter]', 
        deltaToolCalls: null, 
        done: true,
        error: 'Safety filter blocked response'
      };
    }
    
    const parts = candidate.content?.parts || [];
    
    // 提取文本
    const textParts = parts.filter(p => p.text);
    const deltaText = textParts.map(p => p.text).join('');
    
    // 提取函数调用，保留原始 part 以便携带 thought_signature
    let deltaToolCalls = null;
    let rawFunctionCallParts = null;
    const functionCallParts = parts.filter(p => p.functionCall);
    if (functionCallParts.length > 0) {
      // 保存原始的 function call parts（包含 thought_signature）
      rawFunctionCallParts = functionCallParts;
      
      deltaToolCalls = functionCallParts.map((part, index) => ({
        index,
        id: `call_${index}_${Date.now()}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {},
        // 保留原始 part 用于后续构建请求时携带 thought_signature
        _rawPart: part
      }));
    }
    
    const done = candidate.finishReason != null;
    return { deltaText, deltaToolCalls, rawFunctionCallParts, done, finishReason: candidate.finishReason };
  } catch (e) {
    // JSON 解析失败 - 记录详细日志以便调试
    console.error('[Gemini] Failed to parse stream chunk:', e.message);
    console.error('[Gemini] Raw chunk (first 200 chars):', chunk.substring?.(0, 200) || chunk);
    return { deltaText: '', deltaToolCalls: null, done: false, parseError: e.message };
  }
};

/**
 * 格式化工具结果为 Gemini 消息格式
 * 
 * @param {string} name - 函数名
 * @param {*} result - 执行结果
 * @returns {Object} Gemini function response part
 */
export const formatToolResultPart = (name, result) => {
  // Gemini functionResponse.response 应该是一个对象
  // 将结果包装成对象格式
  let responseObj;
  
  if (typeof result === 'string') {
    // 尝试解析 JSON 字符串
    try {
      responseObj = JSON.parse(result);
    } catch {
      // 不是 JSON，包装成对象
      responseObj = { output: result };
    }
  } else if (result === null || result === undefined) {
    responseObj = { output: 'null' };
  } else if (typeof result === 'object') {
    responseObj = result;
  } else {
    responseObj = { output: String(result) };
  }
  
  return {
    functionResponse: {
      name: name,
      response: responseObj
    }
  };
};

/**
 * 创建带有函数调用的 model 消息
 * 
 * @param {Array} toolCalls - 工具调用数组（可能包含 _rawPart）
 * @returns {Object} Gemini model message with function calls
 */
export const createModelFunctionCallMessage = (toolCalls) => ({
  role: 'model',
  parts: toolCalls.map(tc => {
    // 如果有原始 part（包含 thought_signature），直接使用它
    if (tc._rawPart) {
      return tc._rawPart;
    }
    // 否则构建新的 part（向后兼容）
    return {
      functionCall: {
        name: tc.name,
        args: tc.arguments
      }
    };
  })
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
  cleanHistoryForGemini,
  convertMessages,
  buildRequest,
  parseResponse,
  parseStreamChunk,
  fetchModels,
  formatToolResultPart,
  createModelFunctionCallMessage,
  createFunctionResponseMessage
};
