/**
 * MCP Tool Executor
 * 
 * 负责执行 MCP 工具调用，并管理工具调用循环
 */

import { convertToOpenAITools, convertToGeminiTools } from './toolConverter.js';
import * as openaiAdapter from '../llm/adapters/openaiCompatible.js';
import * as geminiAdapter from '../llm/adapters/geminiOfficial.js';
import * as anthropicAdapter from '../llm/adapters/anthropicNative.js';

/** 根据 apiFormat 选择 adapter */
function pickAdapter(apiFormat) {
  if (apiFormat === 'gemini_official') return geminiAdapter;
  if (apiFormat === 'anthropic_native') return anthropicAdapter;
  return openaiAdapter;
}
import tauri from '../tauri';
import { downloadUrlAsBase64, llmProxyCall, llmProxyStream } from '../tauri';
import { isBuiltinTool, executeBuiltinTool } from '../workspace/builtinToolExecutor.js';
import { isSocialFileTool, executeSocialFileTool, isHistoryBuiltinTool, executeHistoryBuiltinTool, isGroupLogBuiltinTool, executeGroupLogBuiltinTool, isStickerBuiltinTool, executeStickerBuiltinTool, isBufferSearchTool, executeBufferSearchTool, isIntentPlanTool, executeIntentPlanTool, isSubagentTool, executeSubagentTool } from '../workspace/socialToolExecutor.js';
import { isSkillTool, executeSkillTool } from '../skills/index.js';
import { appendToolResultAnnotation } from './toolResultAnnotation.js';

/**
 * Normalize usage from different LLM adapters into a unified format.
 * Gemini:    { promptTokenCount, candidatesTokenCount, cachedContentTokenCount }
 * OpenAI:    { prompt_tokens, completion_tokens, prompt_tokens_details?: { cached_tokens } }
 * Anthropic: { prompt_tokens, completion_tokens, cache_read_input_tokens,
 *              prompt_tokens_details?: { cached_tokens } } (adapter shim)
 */
export const normalizeUsage = (usage) => {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  return {
    inputTokens: usage.promptTokenCount ?? usage.prompt_tokens ?? 0,
    outputTokens: usage.candidatesTokenCount ?? usage.completion_tokens ?? 0,
    cachedTokens:
      usage.cachedContentTokenCount                // Gemini
      ?? usage.prompt_tokens_details?.cached_tokens // OpenAI + Anthropic-via-shim
      ?? usage.cache_read_input_tokens             // Anthropic raw
      ?? 0,
  };
};

/**
 * Append a usage record to the daily usage log file.
 * File: social/usage/YYYY-MM-DD.jsonl
 */
export const appendUsageLog = async (petId, record) => {
  if (!petId) return;
  try {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const path = `social/usage/${date}.jsonl`;
    const line = JSON.stringify(record) + '\n';
    await tauri.workspaceAppend(petId, path, line);
  } catch (e) {
    console.warn('[Usage] Failed to append usage log:', e);
  }
};

// 默认最大工具调用轮次（当服务器没有配置时使用），防止无限循环
const DEFAULT_MAX_TOOL_ITERATIONS = 100;

// 缓存 MCP 服务器配置，用于获取每个服务器的 maxIterations
let cachedServerConfigs = new Map();

/**
 * 刷新服务器配置缓存
 */
export const refreshServerConfigsCache = async () => {
  try {
    const servers = await tauri.mcp.getServers();
    cachedServerConfigs = new Map();
    for (const server of servers || []) {
      cachedServerConfigs.set(server.name, server);
    }
    console.log('[MCP] Server configs cache refreshed:', cachedServerConfigs.size, 'servers');
  } catch (err) {
    console.warn('[MCP] Failed to refresh server configs cache:', err);
  }
};

/**
 * 获取服务器的最大迭代次数
 * @param {string} serverName - 服务器名称
 * @returns {number|null} 最大迭代次数，null 表示无限制
 */
export const getServerMaxIterations = (serverName) => {
  const config = cachedServerConfigs.get(serverName);
  if (!config) {
    console.log(`[MCP] Server config not found for ${serverName}, using default`);
    return DEFAULT_MAX_TOOL_ITERATIONS;
  }
  // null/undefined means unlimited
  return config.maxIterations;
};

// 初始化时加载服务器配置
refreshServerConfigsCache();

// 监听服务器更新事件
if (tauri.mcp?.onServersUpdated) {
  tauri.mcp.onServersUpdated(() => {
    refreshServerConfigsCache();
  });
}

// 工具执行超时配置 (毫秒)
const TOOL_EXECUTION_TIMEOUT_MS = 64000; // 64s for individual tool call
const DEFAULT_TOOL_TIMEOUT_MS = 60000; // 1 minute default

/**
 * Build the exact set of tool names exposed to the model for this turn.
 *
 * This is intentionally the only authorization source. Recognising a name as a
 * builtin/Skill merely selects its executor after authorization; it must never
 * grant permission by itself.
 */
const getDeclaredToolNames = (mcpTools) => new Set(
  (Array.isArray(mcpTools) ? mcpTools : [])
    .filter(tool => tool?.name)
    .map(tool => tool.serverName ? `${tool.serverName}__${tool.name}` : tool.name),
);

const undeclaredToolResult = (toolName) => ({
  error: `Tool "${toolName}" is not available in this turn. Only use the tools provided to you.`,
});

/**
 * 获取可用的 MCP 工具列表
 * 
 * @returns {Promise<Array>} MCP 工具数组
 */
export const getMcpTools = async () => {
  try {
    if (!tauri.mcp?.getAllTools) {
      console.log('[MCP] MCP API not available');
      return [];
    }
    
    const rawTools = await tauri.mcp.getAllTools();
    
    // 扁平化 Rust 返回的嵌套结构
    // Rust 返回: { serverId, serverName, tool: { name, description, inputSchema, annotations } }
    // 前端需要保留 annotations，供调用方根据 readOnlyHint 等元数据收窄工具权限。
    const tools = rawTools.map(item => ({
      serverId: item.serverId,
      serverName: item.serverName,
      name: item.tool?.name,
      description: item.tool?.description,
      inputSchema: item.tool?.inputSchema,
      annotations: item.tool?.annotations
    })).filter(tool => tool.name); // 过滤掉没有 name 的工具
    
    console.log('[MCP] Available tools:', tools.length);
    return tools;
  } catch (error) {
    console.error('[MCP] Failed to get tools:', error);
    return [];
  }
};

/**
 * 带超时的 Promise 包装器
 * 
 * @param {Promise} promise - 要包装的 Promise
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @param {string} operationName - 操作名称（用于错误消息）
 * @returns {Promise} 带超时的 Promise
 */
const withTimeout = (promise, timeoutMs, operationName = 'Operation') => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    promise
      .then(result => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch(error => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
};

/**
 * 执行单个 MCP 工具调用（带超时）
 * 
 * @param {string} serverName - MCP 服务器名称
 * @param {string} toolName - 工具名称
 * @param {Object} args - 工具参数
 * @param {Object} options - 选项
 * @param {number} options.timeout - 超时时间（毫秒），默认 60 秒
 * @returns {Promise<*>} 工具执行结果
 */
export const executeMcpTool = async (serverName, toolName, args, options = {}) => {
  const timeout = options.timeout || DEFAULT_TOOL_TIMEOUT_MS;
  
  try {
    if (!tauri.mcp?.callTool) {
      throw new Error('MCP API not available');
    }
    
    console.log(`[MCP] Executing tool: ${serverName}/${toolName} (timeout: ${timeout}ms)`, args);
    
    const result = await withTimeout(
      tauri.mcp.callTool(serverName, toolName, args),
      timeout,
      `Tool ${serverName}/${toolName}`
    );
    
    console.log(`[MCP] Tool result:`, result);
    return result;
  } catch (error) {
    console.error(`[MCP] Tool execution failed:`, error);
    return { error: typeof error === 'string' ? error : (error?.message || String(error)) };
  }
};

/**
 * 根据工具名称查找对应的服务器和执行工具（带超时）
 * 
 * @param {string} toolName - 工具全名 (格式: serverName__toolName 或 toolName)
 * @param {Object} args - 工具参数
 * @param {Object} options - 选项
 * @param {number} options.timeout - 超时时间（毫秒），默认 5 分钟
 * @param {AbortSignal} options.abortSignal - 取消信号
 * @returns {Promise<*>} 执行结果
 */
export const executeToolByName = async (toolName, args, options = {}) => {
  const timeout = options.timeout || TOOL_EXECUTION_TIMEOUT_MS;
  
  try {
    if (!tauri.mcp?.callToolByName) {
      throw new Error('MCP API not available');
    }
    
    // 检查是否已取消
    if (options.abortSignal?.aborted) {
      throw new Error('Tool execution cancelled');
    }
    
    console.log(`[MCP] Executing tool by name: ${toolName} (timeout: ${timeout}ms)`, args);
    
    // 创建一个可以被取消的 Promise
    const toolPromise = tauri.mcp.callToolByName(toolName, args);
    
    // 如果有 abortSignal，监听取消事件
    if (options.abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          reject(new Error('Tool execution cancelled'));
        }, { once: true });
      });
      
      const result = await withTimeout(
        Promise.race([toolPromise, abortPromise]),
        timeout,
        `Tool ${toolName}`
      );
      console.log(`[MCP] Tool result:`, result);
      return result;
    }
    
    const result = await withTimeout(toolPromise, timeout, `Tool ${toolName}`);
    console.log(`[MCP] Tool result:`, result);
    return result;
  } catch (error) {
    console.error(`[MCP] Tool execution failed:`, error);
    return { error: typeof error === 'string' ? error : (error?.message || String(error)) };
  }
};

/**
 * 格式化工具结果为字符串
 * 
 * @param {*} result - MCP 工具返回的结果
 * @returns {string} 格式化后的字符串
 */
export const formatToolResult = (result) => {
  if (result === null || result === undefined) {
    return 'null';
  }

  // MCP implementations commonly use either `isError: true` or `success: false`.
  // Handle failures before the content-array branch so an empty content array cannot hide an error.
  if (result.error || result.isError === true || result.success === false) {
    const contentError = Array.isArray(result.content)
      ? result.content
        .filter(item => item?.type === 'text' && item.text)
        .map(item => item.text)
        .join('\n')
      : '';
    const detail = result.error || contentError || result.message || 'Tool execution failed';
    return `Error: ${detail}`;
  }

  // 如果是 MCP 标准响应格式
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map(item => {
        if (item.type === 'text') return item.text;
        if (item.type === 'image') return `[Image: ${item.data?.slice(0, 50)}...]`;
        if (item.type === 'resource') return `[Resource: ${item.resource?.uri}]`;
        return JSON.stringify(item);
      })
      .join('\n');
  }
  
  // 其他情况直接 JSON 序列化
  if (typeof result === 'string') {
    return result;
  }
  
  return JSON.stringify(result, null, 2);
};

/**
 * 从工具结果中提取媒体内容（图片等）
 * 
 * MCP 标准 image content: { type: "image", data: "base64...", mimeType: "image/png" }
 * 
 * @param {*} result - MCP 工具返回的原始结果
 * @returns {{ text: string, images: Array<{data: string, mimeType: string}> }}
 */
export const extractMediaFromToolResult = (result) => {
  const images = [];
  
  if (!result || !result.content || !Array.isArray(result.content)) {
    return { text: formatToolResult(result), images };
  }
  
  const textParts = [];
  for (const item of result.content) {
    if (item.type === 'text') {
      textParts.push(item.text);
    } else if (item.type === 'image') {
      if (item.data) {
        images.push({
          data: item.data,
          mimeType: item.mimeType || 'image/jpeg'
        });
        textParts.push('[Image]');
      }
    } else if (item.type === 'resource') {
      textParts.push(`[Resource: ${item.resource?.uri}]`);
    } else {
      textParts.push(JSON.stringify(item));
    }
  }
  
  return { text: textParts.join('\n'), images };
};

/**
 * 将图片数据转换为 Gemini inline_data 格式
 * 如果是 HTTP URL，尝试下载并转换为 base64
 * 
 * @param {string} data - base64 数据或 URL
 * @param {string} mimeType - MIME 类型
 * @returns {Promise<{ inline_data: { mime_type: string, data: string } } | null>}
 */
const toGeminiInlineData = async (data, mimeType) => {
  // raw base64 (most common for MCP image content)
  if (!data.startsWith('http://') && !data.startsWith('https://') && !data.startsWith('data:')) {
    return { inline_data: { mime_type: mimeType, data } };
  }
  
  // data URI → extract base64
  if (data.startsWith('data:')) {
    const match = data.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { inline_data: { mime_type: match[1], data: match[2] } };
    }
    return null;
  }
  
  // HTTP URL → download via Tauri backend (bypasses CORS)
  try {
    const result = await downloadUrlAsBase64(data);
    return { inline_data: { mime_type: result.mime_type || mimeType, data: result.data } };
  } catch (e) {
    console.warn('[MCP] Failed to download image for Gemini:', data, e);
    return null;
  }
};

/**
 * 将图片数组中的 URL 通过 Tauri 后端下载转换为 base64
 * 避免浏览器 CORS 限制（如 QQ 多媒体服务器）
 * 
 * @param {Array<{data: string, mimeType: string}>} images
 * @returns {Promise<Array<{data: string, mimeType: string}>>}
 */
/**
 * 验证 base64 数据是否为有效图片（magic bytes + 大小检查）
 * 防止 QQ CDN 返回 HTML 错误页被当作图片发给 LLM
 */
const isValidImageBase64 = (b64) => {
  if (!b64 || typeof b64 !== 'string') return false;
  if (b64.length > 20 * 1024 * 1024) return false; // > ~15MB raw 太大
  const magics = ['/9j/', 'iVBOR', 'R0lGOD', 'UklGR', 'Qk0']; // JPEG, PNG, GIF, WebP, BMP
  return magics.some(m => b64.startsWith(m));
};

/**
 * 从 base64 前缀推断图片 MIME type（用于修正 octet-stream）
 */
const detectMimeFromBase64Prefix = (b64) => {
  if (!b64) return null;
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return null;
};

export const resolveImageUrls = async (images) => {
  if (!images || images.length === 0) return images;
  
  const resolved = [];
  for (const img of images) {
    if (img.data.startsWith('http://') || img.data.startsWith('https://')) {
      try {
        const result = await downloadUrlAsBase64(img.data);
        // Plan A: 验证下载内容是否为真正的图片
        if (!isValidImageBase64(result.data)) {
          console.warn('[MCP] Downloaded data is not a valid image (bad magic bytes or too large), skipping:', img.data.substring(0, 80));
          continue; // 丢弃无效图片
        }
        const mime = result.mime_type || img.mimeType;
        resolved.push({ data: result.data, mimeType: (mime === 'application/octet-stream' ? detectMimeFromBase64Prefix(result.data) : mime) || mime });
        console.log('[MCP] Downloaded image via backend:', img.data.substring(0, 80) + '...');
      } catch (e) {
        console.warn('[MCP] Failed to download image via backend:', img.data.substring(0, 80), e);
        // 下载失败 → 丢弃（Gemini 不能用外部 URL，OpenAI 可能可以但不稳定）
        continue;
      }
    } else {
      resolved.push(img);
    }
  }
  return resolved;
};

/**
 * 将 MCP 工具转换为 LLM 格式
 * 
 * @param {Array} mcpTools - MCP 工具数组
 * @param {string} apiFormat - 'openai_compatible' | 'gemini_official'
 * @returns {Array} LLM 格式的工具数组
 */
export const convertToolsForLLM = (mcpTools, apiFormat) => {
  if (!mcpTools || mcpTools.length === 0) {
    return [];
  }
  
  // 为工具添加服务器前缀以确保唯一性
  const toolsWithPrefix = mcpTools.map(tool => ({
    ...tool,
    // 使用双下划线分隔服务器名和工具名
    name: tool.serverName ? `${tool.serverName}__${tool.name}` : tool.name
  }));
  
  if (apiFormat === 'gemini_official') {
    return convertToGeminiTools(toolsWithPrefix);
  }
  
  return convertToOpenAITools(toolsWithPrefix);
};

/**
 * 执行多个工具调用并返回结果
 * 
 * @param {Array} toolCalls - 工具调用数组 [{id, name, arguments}]
 * @returns {Promise<Array>} 结果数组 [{id, name, result}]
 */
export const executeToolCalls = async (toolCalls) => {
  const results = [];
  
  for (const call of toolCalls) {
    const result = await executeToolByName(call.name, call.arguments);
    results.push({
      id: call.id,
      name: call.name,
      result: formatToolResult(result)
    });
  }
  
  return results;
};

/**
 * 带工具调用循环的 LLM 调用
 * 
 * 这个函数会自动处理工具调用循环：
 * 1. 发送消息给 LLM
 * 2. 如果 LLM 返回工具调用，执行工具
 * 3. 将工具结果添加到消息中，再次调用 LLM
 * 4. 重复直到 LLM 返回文本响应或达到最大轮次
 * 
 * @param {Object} config
 * @param {Array} config.messages - 初始消息数组
 * @param {string} config.apiFormat - 'openai_compatible' | 'gemini_official'
 * @param {string} config.apiKey
 * @param {string} config.model
 * @param {string} config.baseUrl
 * @param {Array} config.mcpTools - MCP 工具数组
 * @param {Object} config.options
 * @param {Function} config.onToolCall - 工具调用回调 (toolName, args) => void
 * @param {Function} config.onToolResult - 工具结果回调 (toolName, result) => void
 * @param {Function} config.toolResultAnnotation - 同步返回仅追加到模型可见工具结果的运行时注释
 * @param {Function} config.llmTransport - 可选 LLM 传输实现（默认使用 Rust proxy，便于集成测试）
 * @param {Function} config.toolArgTransform - (name, args) => args — transform tool args before execution
 * @returns {Promise<{content: string, toolCallHistory: Array}>}
 */
export const callLLMWithTools = async ({
  messages,
  apiFormat,
  apiKey,
  model,
  baseUrl,
  mcpTools,
  options = {},
  onToolCall,
  onToolResult,
  toolResultAnnotation, // ({ name, args, result, isError, toolCallId, iteration }) => string
  llmTransport = llmProxyCall,
  onLLMText,        // (text, iterationIndex) => void — called with LLM text each iteration (including intermediate rounds with tool calls)
  toolCallFilter,  // (name, args) => string|null — return error string to reject, null to allow
  toolArgTransform, // (name, args) => args — transform tool args before execution
  builtinToolContext,  // { petId, memoryEnabled } — for builtin tool execution
  stopAfterTool,    // optional string — stop the tool loop after this tool name is called (no further LLM turns)
  usageLabel,       // optional string label for usage logging (e.g. "Observer", "Intent:idle")
  usageTarget,      // optional string target id for usage logging
  usagePetId,       // optional petId for usage logging (falls back to builtinToolContext.petId)
  maxIterations,    // optional max iterations override (default 100)
  onUsageLogged,    // optional (record) => void — fires after appendUsageLog with the same record
  onTrace,          // optional (trace) => void — full trajectory, fires once on exit
}) => {
  const adapter = pickAdapter(apiFormat);
  const llmTools = convertToolsForLLM(mcpTools, apiFormat);
  const declaredToolNames = getDeclaredToolNames(mcpTools);

  // 对于 Gemini，清理历史消息中缺少 thought_signature 的工具调用
  let initialMessages = [...messages];
  if (apiFormat === 'gemini_official' && geminiAdapter.cleanHistoryForGemini) {
    initialMessages = geminiAdapter.cleanHistoryForGemini(messages, false);
    console.log('[MCP] Cleaned history messages for Gemini:', messages.length, '->', initialMessages.length);
  }

  let currentMessages = [...initialMessages];
  const toolCallHistory = [];

  // Usage accumulation
  const totalUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const usageStartTime = Date.now();

  // ── Trace collection (only when onTrace is set) ──
  const _trace = onTrace ? {
    systemPrompt: null,
    tools: null,
    initialUserMessage: null,
    iterations: [],
    toolResults: [],
    status: 'partial',          // overwritten before onTrace fires
    termination: 'unknown',
    error: null,
    durationMs: 0,
  } : null;

  if (_trace) {
    // Capture system + tools + initial user from initialMessages
    const sys = initialMessages.find(m => m.role === 'system');
    _trace.systemPrompt = sys ? (typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content)) : '';
    _trace.tools = Array.isArray(mcpTools) ? [...mcpTools] : mcpTools;   // raw provider-neutral tool schemas passed in
    const lastUser = [...initialMessages].reverse().find(m => m.role === 'user');
    _trace.initialUserMessage = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
  }

  const _fireTrace = (status, termination, error) => {
    if (!_trace || !onTrace) return;
    _trace.status = status;
    _trace.termination = termination;
    if (error) _trace.error = typeof error === 'string' ? error : (error?.message || String(error));
    _trace.durationMs = Date.now() - usageStartTime;
    try {
      const r = onTrace(_trace);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* ignore */ }
  };

  // 跟踪每个服务器的迭代次数
  const serverIterations = new Map();
  // 总迭代次数（防止无限循环的保险）
  let totalIterations = 0;
  const MAX_TOTAL_ITERATIONS = maxIterations ?? 100;
  let stopEarly = false; // set by stopAfterTool

  const _writeUsage = (record) => {
    const _petId = usagePetId || builtinToolContext?.petId;
    if (!_petId || !usageLabel) return;
    // appendUsageLog is async fire-and-forget; it swallows its own errors internally.
    appendUsageLog(_petId, record);
    if (typeof onUsageLogged === 'function') {
      try { onUsageLogged(record); } catch (_) { /* ignore callback errors */ }
    }
  };

  try {
    while (totalIterations < MAX_TOTAL_ITERATIONS) {
      totalIterations++;
      console.log(`[MCP] Tool loop iteration ${totalIterations}`);

      // 构建请求
      const req = await adapter.buildRequest({
        messages: currentMessages,
        apiFormat,
        apiKey,
        model,
        baseUrl,
        options: {
          ...options,
          stream: false,
          tools: llmTools.length > 0 ? llmTools : undefined
        }
      });

      // 发送请求（通过 Rust 代理：90s 超时 + 并发控制）
      let data;
      try {
        data = await llmTransport(req.endpoint, req.headers, req.body);
      } catch (proxyErr) {
        // Tauri invoke 抛的是 string，无法挂属性 → 包装成 Error 对象
        const err = typeof proxyErr === 'string' ? new Error(proxyErr) : (proxyErr instanceof Error ? proxyErr : new Error(String(proxyErr)));
        try {
          const bodyStr = JSON.stringify(req.body);
          // 从错误信息中提取 column 号，截取报错位置前后 200 字符
          const colMatch = (err.message || '').match(/column\s+(\d+)/);
          if (colMatch) {
            const col = parseInt(colMatch[1], 10);
            const start = Math.max(0, col - 200);
            const end = Math.min(bodyStr.length, col + 200);
            err._debugBody = `…col ${col}, context [${start}..${end}]:\n${bodyStr.substring(start, end)}`;
          } else {
            err._debugBody = bodyStr.substring(0, 2000) + (bodyStr.length > 2000 ? '…' : '');
          }
        } catch (_) { /* ignore */ }
        throw err;
      }
      const result = adapter.parseResponse(data);
      if (Array.isArray(result.toolCalls)) {
        result.toolCalls.forEach((call, index) => {
          if (!call.id) {
            call.id = `${call.name || 'tool'}-${Date.now()}-${totalIterations}-${index}`;
          }
        });
      }

      // Accumulate usage from this iteration
      const iterUsage = normalizeUsage(result.usage);
      totalUsage.inputTokens += iterUsage.inputTokens;
      totalUsage.outputTokens += iterUsage.outputTokens;
      totalUsage.cachedTokens += iterUsage.cachedTokens;

      // Emit LLM text for every iteration (including empty — caller decides what to show)
      if (onLLMText) {
        const toolNames = (result.toolCalls || []).map(tc => tc.name);
        onLLMText({
          content: result.content || '',
          reasoning: result.reasoningContent || '',
          iteration: totalIterations,
          toolNames,
        });
      }

      if (_trace) {
        // assistant turn for this iteration
        const toolCallsForTrace = (result.toolCalls || []).map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            // Keep args as JSON string for schema consistency (OpenAI-native shape).
            // Export script parses to object.
            arguments: typeof tc.arguments === 'string'
              ? tc.arguments
              : JSON.stringify(tc.arguments || {}),
          },
        }));
        _trace.iterations.push({
          content: result.content || null,
          reasoning_content: result.reasoningContent || undefined,
          tool_calls: toolCallsForTrace,
        });
      }

      // 如果没有工具调用，返回结果
      if (!result.toolCalls || result.toolCalls.length === 0) {
        // Write usage log
        _writeUsage({
          ts: new Date().toISOString(),
          label: usageLabel,
          target: usageTarget || '',
          model: model || '',
          apiFormat: apiFormat || '',
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          cachedTokens: totalUsage.cachedTokens,
          toolCalls: toolCallHistory.length,
          iterations: totalIterations,
          durationMs: Date.now() - usageStartTime,
        });
        _fireTrace('success', 'end_turn', null);
        return {
          content: result.content,
          reasoningContent: result.reasoningContent,
          toolCallHistory,
          usage: totalUsage,
        };
      }

      // 执行工具调用
      console.log('[MCP] Tool calls detected:', result.toolCalls);

      // 检查并执行每个工具调用
      let reachedLimit = false;
      let limitMessage = '';
      let batchExecutionCount = 0;
      let terminalToolName = '';
      const batchResults = [];
      const pushTraceToolResult = (entry) => {
        if (!_trace) return;
        _trace.toolResults.push({
          tool_call_id: entry.id,
          name: entry.name,
          content: typeof entry.modelResult === 'string'
            ? entry.modelResult
            : JSON.stringify(entry.modelResult),
        });
      };
      const addSkippedBatchResult = (call, message) => {
        const entry = {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          result: message,
          modelResult: message,
          annotation: '',
          images: [],
          isError: true,
          skipped: true,
        };
        batchResults.push(entry);
        pushTraceToolResult(entry);
      };

      for (const call of result.toolCalls) {
        const toolCallId = call.id;

        // stopAfterTool 表示本批已经到达终点。后续调用不再产生真实副作用，
        // 但仍为 provider 补齐一一对应的 synthetic tool result。
        if (stopEarly) {
          addSkippedBatchResult(
            call,
            `[Skipped: ${call.name} was not executed because terminal tool "${terminalToolName}" already completed.]`,
          );
          continue;
        }

        // Tool recognition is not authorization. Every executor — external,
        // builtin, social, Intent, subagent, sticker and Skill — is gated by
        // the exact tool list exposed for this turn, including when it is empty.
        const isDeclared = declaredToolNames.has(call.name);

        // 提取服务器名称（格式: serverName__toolName）
        const parts = call.name.split('__');
        const serverName = parts.length > 1 ? parts[0] : null;

        // 检查该服务器是否达到限制
        if (isDeclared && serverName) {
          const currentCount = serverIterations.get(serverName) || 0;
          const maxIterations = getServerMaxIterations(serverName);

          // maxIterations 为 null 表示无限制
          if (maxIterations !== null && currentCount >= maxIterations) {
            console.warn(`[MCP] Server ${serverName} reached max iterations (${maxIterations})`);
            reachedLimit = true;
            limitMessage = `Server "${serverName}" reached maximum tool call iterations (${maxIterations})`;
            addSkippedBatchResult(call, `[Skipped: ${limitMessage}]`);
            continue;
          }

          // 增加计数
          serverIterations.set(serverName, currentCount + 1);
          console.log(`[MCP] Server ${serverName} iteration: ${currentCount + 1}/${maxIterations ?? '∞'}`);
        }
        if (isDeclared) batchExecutionCount += 1;

        // Apply arg transform before onToolCall notification
        if (toolArgTransform) {
          call.arguments = toolArgTransform(call.name, call.arguments) ?? call.arguments;
        }

        if (onToolCall) {
          onToolCall(call.name, call.arguments, toolCallId);
        }

        let isError = false;
        let toolResult = null;
        try {
          if (!isDeclared) {
            console.warn(
              `[MCP] Rejected undeclared tool call: ${call.name} `
              + `(allowed: ${Array.from(declaredToolNames).join(', ') || 'none'})`,
            );
            isError = true;
            toolResult = undeclaredToolResult(call.name);
          }

          // Check toolCallFilter first (allows caller to reject specific calls)
          if (!toolResult && toolCallFilter) {
            const filterError = toolCallFilter(call.name, call.arguments);
            if (filterError) {
              console.log(`[MCP] Tool call filtered: ${call.name} — ${filterError}`);
              isError = true;
              toolResult = { error: filterError };
            }
          }

          if (!toolResult) {
            const isBuiltin = isBuiltinTool(call.name);
            const isSocialFile = isSocialFileTool(call.name);
            const isHistoryBuiltin = isHistoryBuiltinTool(call.name);
            const isGroupLogBuiltin = isGroupLogBuiltinTool(call.name);
            const isStickerTool = isStickerBuiltinTool(call.name);
            const isBufferSearch = isBufferSearchTool(call.name);
            const isIntentPlan = isIntentPlanTool(call.name);
            const isSubagent = isSubagentTool(call.name);
            const isSkill = isSkillTool(call.name);
            console.log(`[MCP] Tool validation: call="${call.name}" declared=true isBuiltin=${isBuiltin} isSocialFile=${isSocialFile} isHistory=${isHistoryBuiltin} isGroupLog=${isGroupLogBuiltin} isSticker=${isStickerTool} isBufferSearch=${isBufferSearch} isIntentPlan=${isIntentPlan} isSkill=${isSkill}`);
            if (isBuiltin && builtinToolContext) {
              toolResult = await executeBuiltinTool(call.name, call.arguments, builtinToolContext);
            } else if (isSkill) {
              toolResult = builtinToolContext
                ? await executeSkillTool(call.name, call.arguments, builtinToolContext)
                : { error: 'Skill runtime context is unavailable.' };
            } else if (isSocialFile && builtinToolContext) {
              toolResult = await executeSocialFileTool(call.name, call.arguments, builtinToolContext);
            } else if (isHistoryBuiltin && builtinToolContext) {
              toolResult = await executeHistoryBuiltinTool(call.name, call.arguments, builtinToolContext);
            } else if (isGroupLogBuiltin && builtinToolContext) {
              toolResult = await executeGroupLogBuiltinTool(call.name, call.arguments, builtinToolContext);
            } else if (isStickerTool && builtinToolContext) {
              toolResult = await executeStickerBuiltinTool(call.name, call.arguments, builtinToolContext);
            } else if (isBufferSearch && builtinToolContext) {
              toolResult = executeBufferSearchTool(call.name, call.arguments, builtinToolContext);
            } else if (isIntentPlan && builtinToolContext) {
              toolResult = await executeIntentPlanTool(call.name, call.arguments, builtinToolContext);
            } else if (isSubagent && builtinToolContext) {
              toolResult = await executeSubagentTool(call.name, call.arguments, builtinToolContext);
            } else {
              toolResult = await executeToolByName(call.name, call.arguments);
            }
          }
          if (toolResult && (
            toolResult.error
            || toolResult.isError === true
            || toolResult.success === false
          )) {
            isError = true;
          }
        } catch (error) {
          isError = true;
          toolResult = { error: error.message };
        }

        const formattedResult = formatToolResult(toolResult);
        let modelFacingResult = formattedResult;
        let annotation = '';
        if (typeof toolResultAnnotation === 'function') {
          try {
            annotation = toolResultAnnotation({
              name: call.name,
              args: call.arguments,
              result: formattedResult,
              isError,
              toolCallId,
              iteration: totalIterations,
            });
            modelFacingResult = appendToolResultAnnotation(formattedResult, annotation);
          } catch (annotationError) {
            console.warn('[MCP] toolResultAnnotation failed:', annotationError);
          }
        }
        const { images: rawImages } = extractMediaFromToolResult(toolResult);
        const toolImages = await resolveImageUrls(rawImages);

        const historyEntry = {
          id: toolCallId,
          name: call.name,
          arguments: call.arguments,
          result: formattedResult,
          images: toolImages
        };
        toolCallHistory.push(historyEntry);

        const batchEntry = {
          ...historyEntry,
          modelResult: modelFacingResult,
          annotation,
          isError,
          skipped: false,
        };
        batchResults.push(batchEntry);
        pushTraceToolResult(batchEntry);

        if (onToolResult) {
          try {
            onToolResult(call.name, formattedResult, toolCallId, isError);
          } catch (callbackError) {
            console.warn('[MCP] onToolResult callback failed:', callbackError);
          }
        }

        let stopAfterToolMatches = false;
        if (!isError && stopAfterTool) {
          try {
            stopAfterToolMatches = typeof stopAfterTool === 'function'
              ? stopAfterTool(call.name, formattedResult, call.arguments, {
                isError,
                toolCallId,
                iteration: totalIterations,
              })
              : call.name === stopAfterTool;
          } catch (callbackError) {
            console.warn('[MCP] stopAfterTool callback failed:', callbackError);
          }
        }
        if (stopAfterToolMatches) {
          stopEarly = true;
          terminalToolName = call.name;
        }
      }

      // 如果所有工具调用都被跳过（达到限制），返回
      if (reachedLimit && batchExecutionCount === 0) {
        _writeUsage({
          ts: new Date().toISOString(), label: usageLabel, target: usageTarget || '',
          model: model || '', apiFormat: apiFormat || '',
          inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens, cachedTokens: totalUsage.cachedTokens,
          toolCalls: toolCallHistory.length, iterations: totalIterations, durationMs: Date.now() - usageStartTime,
        });
        _fireTrace('partial', 'server_iteration_limit', null);
        return {
          content: `[${limitMessage}]`,
          toolCallHistory,
          usage: totalUsage,
        };
      }

      // 将工具调用和结果添加到消息中
      if (apiFormat === 'gemini_official') {
        // Gemini 格式：添加 model 的 functionCall，然后添加 user 的 functionResponse
        currentMessages.push(geminiAdapter.createModelFunctionCallMessage(result.toolCalls));
        const functionResponseMessage = geminiAdapter.createFunctionResponseMessage(
          batchResults.map(entry => ({
            name: entry.name,
            result: entry.result,
          })),
        );
        // 保持 Gemini functionResponse 的原始结构；账本作为同一 user turn 的额外文本注入。
        const annotations = batchResults
          .map(entry => entry.annotation)
          .filter(Boolean);
        if (annotations.length > 0) {
          functionResponseMessage.parts.push({ text: annotations.join('\n\n') });
        }
        currentMessages.push(functionResponseMessage);

        // Gemini: 工具结果中的图片需要作为额外的 user 消息注入 (functionResponse 不支持 inline_data)
        const allToolImages = [];
        for (const entry of batchResults) {
          if (entry?.images?.length > 0) {
            allToolImages.push(...entry.images);
          }
        }
        if (allToolImages.length > 0) {
          const imageParts = [{ text: '以下是上述工具返回的图片：' }];
          for (const img of allToolImages) {
            const inlinePart = await toGeminiInlineData(img.data, img.mimeType);
            if (inlinePart) {
              imageParts.push(inlinePart);
            } else {
              imageParts.push({ text: `[Image failed to load]` });
            }
          }
          if (imageParts.length > 1) {
            currentMessages.push({ role: 'user', parts: imageParts });
          }
        }
      } else {
        // OpenAI 格式：添加 assistant 的 tool_calls，然后添加 tool 消息（支持多模态）
        currentMessages.push(openaiAdapter.createAssistantToolCallMessage(result.toolCalls));

        for (const entry of batchResults) {
          currentMessages.push(openaiAdapter.formatToolResultMessage(
            entry.id,
            entry.modelResult,
            entry?.images
          ));
        }
      }

      // stopAfterTool was triggered — exit loop after adding tool results to history
      if (stopEarly) {
        _writeUsage({
          ts: new Date().toISOString(), label: usageLabel, target: usageTarget || '',
          model: model || '', apiFormat: apiFormat || '',
          inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens, cachedTokens: totalUsage.cachedTokens,
          toolCalls: toolCallHistory.length, iterations: totalIterations, durationMs: Date.now() - usageStartTime,
        });
        _fireTrace('success', typeof stopAfterTool === 'string' ? stopAfterTool : 'stopAfterTool', null);
        return { content: result.content || '', toolCallHistory, usage: totalUsage };
      }
    }

    // 达到最大轮次
    console.warn('[MCP] Max total iterations reached');
    _writeUsage({
      ts: new Date().toISOString(), label: usageLabel, target: usageTarget || '',
      model: model || '', apiFormat: apiFormat || '',
      inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens, cachedTokens: totalUsage.cachedTokens,
      toolCalls: toolCallHistory.length, iterations: totalIterations, durationMs: Date.now() - usageStartTime,
    });
    _fireTrace('partial', 'max_iterations', null);
    return {
      content: '[Maximum tool call iterations reached]',
      toolCallHistory,
      usage: totalUsage,
    };
  } catch (err) {
    _fireTrace('failed', 'error', err);
    throw err;
  }
};

/**
 * 带工具调用的流式 LLM 调用
 * 
 * 注意：流式模式下工具调用更复杂，需要收集完整的工具调用后才能执行
 * 
 * @param {Object} config - 同 callLLMWithTools
 * @param {Function} config.onChunk - 文本块回调
 * @param {AbortSignal} config.abortSignal
 * @returns {Promise<{content: string, toolCallHistory: Array}>}
 */
export const callLLMStreamWithTools = async ({
  messages,
  apiFormat,
  apiKey,
  model,
  baseUrl,
  mcpTools,
  options = {},
  onChunk,
  onToolCall,
  onToolResult,
  toolResultAnnotation, // same model-only annotation hook as callLLMWithTools
  toolCallFilter,  // (name, args) => string|null — return error string to reject, null to allow
  toolArgTransform, // (name, args) => args — transform tool args before execution
  abortSignal,
  builtinToolContext,  // { petId, memoryEnabled } — for builtin tool execution
  stopAfterTool, // optional string/function — stop after a successful terminal tool
  streamTransport = llmProxyStream, // injectable for integration tests
}) => {
  const adapter = pickAdapter(apiFormat);
  const llmTools = convertToolsForLLM(mcpTools, apiFormat);
  const declaredToolNames = getDeclaredToolNames(mcpTools);
  
  // 对于 Gemini，清理历史消息中缺少 thought_signature 的工具调用
  // 这些消息来自数据库历史，没有签名会导致 API 报错
  let initialMessages = [...messages];
  if (apiFormat === 'gemini_official' && geminiAdapter.cleanHistoryForGemini) {
    initialMessages = geminiAdapter.cleanHistoryForGemini(messages, false);
    console.log('[MCP] Cleaned history messages for Gemini:', messages.length, '->', initialMessages.length);
  }
  
  let currentMessages = [...initialMessages];
  const toolCallHistory = [];
  let fullContent = '';
  
  // 跟踪每个服务器的迭代次数
  const serverIterations = new Map();
  // 总迭代次数（防止无限循环的保险）
  let totalIterations = 0;
  const MAX_TOTAL_ITERATIONS = 100;
  
  while (totalIterations < MAX_TOTAL_ITERATIONS) {
    totalIterations++;
    console.log(`[MCP] Stream tool loop iteration ${totalIterations}`);
    
    // 构建请求
    const req = await adapter.buildRequest({
      messages: currentMessages,
      apiFormat,
      apiKey,
      model,
      baseUrl,
      options: {
        ...options,
        stream: true,
        tools: llmTools.length > 0 ? llmTools : undefined
      }
    });
    
    // 处理流式响应。HTTP 请求走 Rust 代理，避免 WKWebView 在局域网/反代下抛 Load failed。
    let buffer = '';
    let iterationContent = '';
    
    // 收集流式工具调用
    const streamToolCalls = new Map(); // index -> {id, name, arguments}

    const processStreamText = (chunkText) => {
      buffer += chunkText;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        // 跳过空行
        if (!line.trim()) continue;
        
        // 处理 SSE 格式
        let jsonStr = line;
        if (line.startsWith('data: ')) {
          jsonStr = line.slice(6).trim();
        } else if (line.startsWith(':')) {
          // SSE 注释行，跳过
          continue;
        }
        
        if (jsonStr === '[DONE]' || jsonStr === '') continue;
        
        const parseResult = adapter.parseStreamChunk(jsonStr);
        const { deltaText, deltaToolCalls, rawFunctionCallParts, error } = parseResult;
        
        // 如果有错误，记录但继续处理
        if (error) {
          console.warn('[toolExecutor] Stream chunk error:', error);
        }
        
        if (deltaText) {
          iterationContent += deltaText;
          fullContent += deltaText;
          if (onChunk) {
            onChunk(deltaText, fullContent);
          }
        }
        
        // 收集工具调用片段
        if (deltaToolCalls) {
          for (const tc of deltaToolCalls) {
            if (!streamToolCalls.has(tc.index)) {
              streamToolCalls.set(tc.index, {
                id: tc.id || `call_${tc.index}`,
                name: tc.name || '',
                arguments: null,  // 初始为 null，区分未设置和空字符串
                _rawPart: null    // 保留原始 part 用于 thought_signature
              });
            }
            const existing = streamToolCalls.get(tc.index);
            if (tc.id) existing.id = tc.id;
            if (tc.name) existing.name = tc.name;
            // 保留原始 part（包含 thought_signature）
            // 只在当前没有 _rawPart，或新的 part 包含 thought_signature 时更新
            // 避免被后续不含签名的 chunk 覆盖（Gemini 流式模式可能在后续 chunk 中省略签名）
            if (tc._rawPart) {
              if (!existing._rawPart || tc._rawPart.thought_signature) {
                existing._rawPart = tc._rawPart;
              }
            }
            if (tc.arguments !== undefined && tc.arguments !== null) {
              // Gemini 返回的是对象，OpenAI 流式返回的是字符串片段
              if (typeof tc.arguments === 'object') {
                // Gemini: 直接存储对象（通常是完整的）
                existing.arguments = tc.arguments;
              } else if (typeof tc.arguments === 'string') {
                // OpenAI: 累积字符串
                if (typeof existing.arguments === 'string') {
                  existing.arguments += tc.arguments;
                } else {
                  existing.arguments = tc.arguments;
                }
              }
            }
          }
        }
      }
    };

    await streamTransport(req.endpoint, req.headers, req.body, processStreamText);
    if (buffer.trim()) {
      processStreamText('\n');
    }
    
    // 处理收集到的工具调用
    const collectedToolCalls = Array.from(streamToolCalls.values())
      .filter(tc => tc.name)
      .map(tc => {
        let parsedArgs = {};
        
        if (typeof tc.arguments === 'object' && tc.arguments !== null) {
          // 已经是对象（Gemini 格式）
          parsedArgs = tc.arguments;
        } else if (typeof tc.arguments === 'string' && tc.arguments.trim()) {
          // 字符串需要解析（OpenAI 格式）
          try {
            parsedArgs = JSON.parse(tc.arguments);
          } catch (e) {
            console.error('[MCP] Failed to parse tool arguments:', tc.arguments, e);
            parsedArgs = { _raw: tc.arguments, _parseError: e.message };
          }
        }
        
        return {
          id: tc.id,
          name: tc.name,
          arguments: parsedArgs,
          // 保留原始 part（包含 thought_signature）用于 Gemini
          _rawPart: tc._rawPart
        };
      });
    
    // 如果没有工具调用，返回结果
    if (collectedToolCalls.length === 0) {
      return {
        content: fullContent,
        toolCallHistory
      };
    }
    
    // 执行工具调用
    console.log('[MCP] Stream collected tool calls:', collectedToolCalls);
    
    // 检查并执行每个工具调用
    let reachedLimit = false;
    let limitMessage = '';
    let batchExecutionCount = 0;
    let stopEarly = false;
    let terminalToolName = '';
    const batchResults = [];

    const addBatchResult = ({
      call,
      result,
      modelResult = result,
      annotation = '',
      images = [],
      isError = false,
      skipped = false,
    }) => {
      const entry = {
        id: call.id || `${call.name}-${Date.now()}`,
        name: call.name,
        arguments: call.arguments,
        result,
        modelResult,
        annotation,
        images,
        isError,
        skipped,
      };
      batchResults.push(entry);
      if (!skipped) {
        toolCallHistory.push({
          id: entry.id,
          name: entry.name,
          arguments: entry.arguments,
          result: entry.result,
          images: entry.images,
        });
      }
      return entry;
    };
    
    for (const call of collectedToolCalls) {
      // 检查是否已中断
      if (abortSignal?.aborted) {
        console.log('[MCP] Tool execution aborted by user');
        return {
          content: fullContent,
          toolCallHistory,
          aborted: true
        };
      }
      
      const toolCallId = call.id || `${call.name}-${Date.now()}`;

      // A provider requires one function result for every call in the batch.
      // Once a terminal tool succeeds, synthesize results for the remaining
      // calls without allowing any further side effects.
      if (stopEarly) {
        addBatchResult({
          call: { ...call, id: toolCallId },
          result: `[Skipped: ${call.name} was not executed because terminal tool "${terminalToolName}" already completed.]`,
          isError: true,
          skipped: true,
        });
        continue;
      }

      const isDeclared = declaredToolNames.has(call.name);
      
      // 提取服务器名称（格式: serverName__toolName）
      const parts = call.name.split('__');
      const serverName = parts.length > 1 ? parts[0] : null;
      
      // 检查该服务器是否达到限制
      if (isDeclared && serverName) {
        const currentCount = serverIterations.get(serverName) || 0;
        const maxIterations = getServerMaxIterations(serverName);
        
        // maxIterations 为 null 表示无限制
        if (maxIterations !== null && currentCount >= maxIterations) {
          console.warn(`[MCP] Server ${serverName} reached max iterations (${maxIterations})`);
          reachedLimit = true;
          limitMessage = `Server "${serverName}" reached maximum tool call iterations (${maxIterations})`;
          
          addBatchResult({
            call: { ...call, id: toolCallId },
            result: `[Skipped: ${limitMessage}]`,
            isError: true,
            skipped: true,
          });
          
          if (onToolResult) {
            onToolResult(call.name, `[Skipped: ${limitMessage}]`, toolCallId, true);
          }
          continue; // 跳过这个工具调用
        }
        
        // 增加计数
        serverIterations.set(serverName, currentCount + 1);
        console.log(`[MCP] Server ${serverName} iteration: ${currentCount + 1}/${maxIterations ?? '∞'}`);
      }
      if (isDeclared) batchExecutionCount += 1;
      
      // Apply arg transform before onToolCall notification
      if (toolArgTransform) {
        call.arguments = toolArgTransform(call.name, call.arguments) ?? call.arguments;
      }
      
      if (onToolCall) {
        onToolCall(call.name, call.arguments, toolCallId);
      }
      
      let isError = false;
      let toolResult = null;
      try {
        // 再次检查中断状态
        if (abortSignal?.aborted) {
          throw new Error('Tool execution cancelled');
        }
        
        if (!isDeclared) {
          console.warn(
            `[MCP] Rejected undeclared stream tool call: ${call.name} `
            + `(allowed: ${Array.from(declaredToolNames).join(', ') || 'none'})`,
          );
          isError = true;
          toolResult = undeclaredToolResult(call.name);
        }

        // Check toolCallFilter first (allows caller to reject specific calls)
        if (!toolResult && toolCallFilter) {
          const filterError = toolCallFilter(call.name, call.arguments);
          if (filterError) {
            console.log(`[MCP] Tool call filtered: ${call.name} — ${filterError}`);
            isError = true;
            toolResult = { error: filterError };
          }
        }
        
        if (!toolResult) {
          const isBuiltin = isBuiltinTool(call.name);
          const isSocialFile = isSocialFileTool(call.name);
          const isHistoryBuiltin = isHistoryBuiltinTool(call.name);
          const isGroupLogBuiltin = isGroupLogBuiltinTool(call.name);
          const isStickerTool = isStickerBuiltinTool(call.name);
          const isBufferSearch = isBufferSearchTool(call.name);
          const isIntentPlan = isIntentPlanTool(call.name);
          const isSubagent = isSubagentTool(call.name);
          const isSkill = isSkillTool(call.name);
          if (isBuiltin && builtinToolContext) {
            toolResult = await executeBuiltinTool(call.name, call.arguments, builtinToolContext);
          } else if (isSkill) {
            toolResult = builtinToolContext
              ? await executeSkillTool(call.name, call.arguments, builtinToolContext)
              : { error: 'Skill runtime context is unavailable.' };
          } else if (isSocialFile && builtinToolContext) {
            toolResult = await executeSocialFileTool(call.name, call.arguments, builtinToolContext);
          } else if (isHistoryBuiltin && builtinToolContext) {
            toolResult = await executeHistoryBuiltinTool(call.name, call.arguments, builtinToolContext);
          } else if (isGroupLogBuiltin && builtinToolContext) {
            toolResult = await executeGroupLogBuiltinTool(call.name, call.arguments, builtinToolContext);
          } else if (isStickerTool && builtinToolContext) {
            toolResult = await executeStickerBuiltinTool(call.name, call.arguments, builtinToolContext);
          } else if (isBufferSearch && builtinToolContext) {
            toolResult = executeBufferSearchTool(call.name, call.arguments, builtinToolContext);
          } else if (isIntentPlan && builtinToolContext) {
            toolResult = await executeIntentPlanTool(call.name, call.arguments, builtinToolContext);
          } else if (isSubagent && builtinToolContext) {
            toolResult = await executeSubagentTool(call.name, call.arguments, builtinToolContext);
          } else {
            toolResult = await executeToolByName(call.name, call.arguments);
          }
        }

        if (toolResult && toolResult.error) {
          isError = true;
        }
      } catch (error) {
        // 如果是中断导致的错误，直接返回
        if (abortSignal?.aborted || error.message === 'Tool execution cancelled') {
          console.log('[MCP] Tool execution cancelled');
          if (onToolResult) {
            onToolResult(call.name, 'Cancelled by user', toolCallId, true);
          }
          return {
            content: fullContent,
            toolCallHistory,
            aborted: true
          };
        }
        isError = true;
        toolResult = { error: error.message };
      }
      
      const formattedResult = formatToolResult(toolResult);
      let modelFacingResult = formattedResult;
      let annotation = '';
      if (typeof toolResultAnnotation === 'function') {
        try {
          annotation = toolResultAnnotation({
            name: call.name,
            args: call.arguments,
            result: formattedResult,
            isError,
            toolCallId,
            iteration: totalIterations,
          });
          modelFacingResult = appendToolResultAnnotation(formattedResult, annotation);
        } catch (annotationError) {
          console.warn('[MCP] stream toolResultAnnotation failed:', annotationError);
        }
      }
      const { images: rawImages } = extractMediaFromToolResult(toolResult);
      const toolImages = await resolveImageUrls(rawImages);
      
      addBatchResult({
        call: { ...call, id: toolCallId },
        result: formattedResult,
        modelResult: modelFacingResult,
        annotation,
        images: toolImages,
        isError,
      });
      
      if (onToolResult) {
        onToolResult(call.name, formattedResult, toolCallId, isError);
      }

      let stopAfterToolMatches = false;
      if (!isError && stopAfterTool) {
        try {
          stopAfterToolMatches = typeof stopAfterTool === 'function'
            ? stopAfterTool(call.name, formattedResult, call.arguments, {
              isError,
              toolCallId,
              iteration: totalIterations,
            })
            : call.name === stopAfterTool;
        } catch (callbackError) {
          console.warn('[MCP] stream stopAfterTool callback failed:', callbackError);
        }
      }
      if (stopAfterToolMatches) {
        stopEarly = true;
        terminalToolName = call.name;
      }
    }

    if (reachedLimit && batchExecutionCount === 0) {
      return {
        content: fullContent + `[${limitMessage}]`,
        toolCallHistory,
      };
    }
    
    // 将工具调用和结果添加到消息中
    if (apiFormat === 'gemini_official') {
      const modelMessage = geminiAdapter.createModelFunctionCallMessage(collectedToolCalls);
      const responseMessage = geminiAdapter.createFunctionResponseMessage(
        batchResults.map(entry => ({
          name: entry.name,
          result: entry.result,
        }))
      );

      const annotations = batchResults
        .map(entry => entry.annotation)
        .filter(Boolean);
      if (annotations.length > 0) {
        responseMessage.parts.push({ text: annotations.join('\n\n') });
      }
      
      console.log('[MCP] Gemini model message:', JSON.stringify(modelMessage, null, 2));
      console.log('[MCP] Gemini response message:', JSON.stringify(responseMessage, null, 2));
      
      currentMessages.push(modelMessage);
      currentMessages.push(responseMessage);
      
      // Gemini: 工具结果中的图片需要作为额外的 user 消息注入 (functionResponse 不支持 inline_data)
      const allToolImages = [];
      for (const entry of batchResults) {
        if (entry?.images?.length > 0) {
          allToolImages.push(...entry.images);
        }
      }
      if (allToolImages.length > 0) {
        const imageParts = [{ text: '以下是上述工具返回的图片：' }];
        for (const img of allToolImages) {
          const inlinePart = await toGeminiInlineData(img.data, img.mimeType);
          if (inlinePart) {
            imageParts.push(inlinePart);
          } else {
            imageParts.push({ text: `[Image failed to load]` });
          }
        }
        if (imageParts.length > 1) {
          currentMessages.push({ role: 'user', parts: imageParts });
        }
      }
    } else {
      // OpenAI 格式：支持多模态 tool 消息（图片作为 image_url parts）
      currentMessages.push(openaiAdapter.createAssistantToolCallMessage(collectedToolCalls));
      
      for (const entry of batchResults) {
        currentMessages.push(openaiAdapter.formatToolResultMessage(
          entry.id,
          entry.modelResult,
          entry.images
        ));
      }
    }

    if (stopEarly) {
      return { content: fullContent, toolCallHistory };
    }
  }
  
  // 达到最大轮次
  console.warn('[MCP] Max stream tool iterations reached');
  return {
    content: fullContent + '\n[Maximum tool call iterations reached]',
    toolCallHistory
  };
};

export default {
  getMcpTools,
  executeMcpTool,
  executeToolByName,
  formatToolResult,
  extractMediaFromToolResult,
  resolveImageUrls,
  convertToolsForLLM,
  executeToolCalls,
  callLLMWithTools,
  callLLMStreamWithTools
};
