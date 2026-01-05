/**
 * MCP Tool Executor
 * 
 * 负责执行 MCP 工具调用，并管理工具调用循环
 */

import { convertToOpenAITools, convertToGeminiTools } from './toolConverter.js';
import * as openaiAdapter from '../llm/adapters/openaiCompatible.js';
import * as geminiAdapter from '../llm/adapters/geminiOfficial.js';
import bridge from '../bridge.js';

// 最大工具调用轮次，防止无限循环
const MAX_TOOL_ITERATIONS = 10;

// 工具执行超时配置 (毫秒)
const TOOL_EXECUTION_TIMEOUT_MS = 300000; // 5 minutes for individual tool call
const DEFAULT_TOOL_TIMEOUT_MS = 60000; // 1 minute default

/**
 * 获取所有可用的 MCP 工具
 * 
 * @returns {Promise<Array>} MCP 工具数组
 */
export const getMcpTools = async () => {
  try {
    if (!bridge.mcp?.getAllTools) {
      console.log('[MCP] MCP API not available');
      return [];
    }
    
    const tools = await bridge.mcp.getAllTools();
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
    if (!bridge.mcp?.callTool) {
      throw new Error('MCP API not available');
    }
    
    console.log(`[MCP] Executing tool: ${serverName}/${toolName} (timeout: ${timeout}ms)`, args);
    
    const result = await withTimeout(
      bridge.mcp.callTool(serverName, toolName, args),
      timeout,
      `Tool ${serverName}/${toolName}`
    );
    
    console.log(`[MCP] Tool result:`, result);
    return result;
  } catch (error) {
    console.error(`[MCP] Tool execution failed:`, error);
    return { error: error.message };
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
    if (!bridge.mcp?.callToolByName) {
      throw new Error('MCP API not available');
    }
    
    // 检查是否已取消
    if (options.abortSignal?.aborted) {
      throw new Error('Tool execution cancelled');
    }
    
    console.log(`[MCP] Executing tool by name: ${toolName} (timeout: ${timeout}ms)`, args);
    
    // 创建一个可以被取消的 Promise
    const toolPromise = bridge.mcp.callToolByName(toolName, args);
    
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
    return { error: error.message };
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
  
  // 如果有 error 字段
  if (result.error) {
    return `Error: ${result.error}`;
  }
  
  // 其他情况直接 JSON 序列化
  if (typeof result === 'string') {
    return result;
  }
  
  return JSON.stringify(result, null, 2);
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
  onToolResult
}) => {
  const adapter = apiFormat === 'gemini_official' ? geminiAdapter : openaiAdapter;
  const llmTools = convertToolsForLLM(mcpTools, apiFormat);
  
  let currentMessages = [...messages];
  const toolCallHistory = [];
  let iterations = 0;
  
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    console.log(`[MCP] Tool loop iteration ${iterations}`);
    
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
    
    // 发送请求
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
    const result = adapter.parseResponse(data);
    
    // 如果没有工具调用，返回结果
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        content: result.content,
        toolCallHistory
      };
    }
    
    // 执行工具调用
    console.log('[MCP] Tool calls detected:', result.toolCalls);
    
    for (const call of result.toolCalls) {
      const toolCallId = call.id || `${call.name}-${Date.now()}`;
      
      if (onToolCall) {
        onToolCall(call.name, call.arguments, toolCallId);
      }
      
      let isError = false;
      let toolResult;
      try {
        toolResult = await executeToolByName(call.name, call.arguments);
        if (toolResult && toolResult.error) {
          isError = true;
        }
      } catch (error) {
        isError = true;
        toolResult = { error: error.message };
      }
      
      const formattedResult = formatToolResult(toolResult);
      
      toolCallHistory.push({
        id: toolCallId,
        name: call.name,
        arguments: call.arguments,
        result: formattedResult
      });
      
      if (onToolResult) {
        onToolResult(call.name, formattedResult, toolCallId, isError);
      }
    }
    
    // 将工具调用和结果添加到消息中
    if (apiFormat === 'gemini_official') {
      // Gemini 格式：添加 model 的 functionCall，然后添加 user 的 functionResponse
      currentMessages.push(geminiAdapter.createModelFunctionCallMessage(result.toolCalls));
      currentMessages.push(geminiAdapter.createFunctionResponseMessage(
        result.toolCalls.map((call, i) => ({
          name: call.name,
          result: toolCallHistory[toolCallHistory.length - result.toolCalls.length + i].result
        }))
      ));
    } else {
      // OpenAI 格式：添加 assistant 的 tool_calls，然后添加 tool 消息
      currentMessages.push(openaiAdapter.createAssistantToolCallMessage(result.toolCalls));
      
      for (let i = 0; i < result.toolCalls.length; i++) {
        const call = result.toolCalls[i];
        const historyIndex = toolCallHistory.length - result.toolCalls.length + i;
        currentMessages.push(openaiAdapter.formatToolResultMessage(
          call.id,
          toolCallHistory[historyIndex].result
        ));
      }
    }
  }
  
  // 达到最大轮次
  console.warn('[MCP] Max tool iterations reached');
  return {
    content: '[Maximum tool call iterations reached]',
    toolCallHistory
  };
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
  abortSignal
}) => {
  const adapter = apiFormat === 'gemini_official' ? geminiAdapter : openaiAdapter;
  const llmTools = convertToolsForLLM(mcpTools, apiFormat);
  
  let currentMessages = [...messages];
  const toolCallHistory = [];
  let iterations = 0;
  let fullContent = '';
  
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    console.log(`[MCP] Stream tool loop iteration ${iterations}`);
    
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
    
    // 发送请求
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
    
    // 处理流式响应
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let iterationContent = '';
    
    // 收集流式工具调用
    const streamToolCalls = new Map(); // index -> {id, name, arguments}
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          
          const { deltaText, deltaToolCalls } = adapter.parseStreamChunk(jsonStr);
          
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
                  arguments: ''
                });
              }
              const existing = streamToolCalls.get(tc.index);
              if (tc.id) existing.id = tc.id;
              if (tc.name) existing.name = tc.name;
              if (tc.arguments) {
                existing.arguments += typeof tc.arguments === 'string' 
                  ? tc.arguments 
                  : JSON.stringify(tc.arguments);
              }
            }
          }
        }
      }
    }
    
    // 处理收集到的工具调用
    const collectedToolCalls = Array.from(streamToolCalls.values())
      .filter(tc => tc.name)
      .map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: typeof tc.arguments === 'string' 
          ? (tc.arguments ? JSON.parse(tc.arguments) : {})
          : tc.arguments
      }));
    
    // 如果没有工具调用，返回结果
    if (collectedToolCalls.length === 0) {
      return {
        content: fullContent,
        toolCallHistory
      };
    }
    
    // 执行工具调用
    console.log('[MCP] Stream collected tool calls:', collectedToolCalls);
    
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
      
      if (onToolCall) {
        onToolCall(call.name, call.arguments, toolCallId);
      }
      
      let isError = false;
      let toolResult;
      try {
        // 再次检查中断状态
        if (abortSignal?.aborted) {
          throw new Error('Tool execution cancelled');
        }
        toolResult = await executeToolByName(call.name, call.arguments);
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
      
      toolCallHistory.push({
        id: toolCallId,
        name: call.name,
        arguments: call.arguments,
        result: formattedResult
      });
      
      if (onToolResult) {
        onToolResult(call.name, formattedResult, toolCallId, isError);
      }
    }
    
    // 将工具调用和结果添加到消息中
    if (apiFormat === 'gemini_official') {
      currentMessages.push(geminiAdapter.createModelFunctionCallMessage(collectedToolCalls));
      currentMessages.push(geminiAdapter.createFunctionResponseMessage(
        collectedToolCalls.map((call, i) => ({
          name: call.name,
          result: toolCallHistory[toolCallHistory.length - collectedToolCalls.length + i].result
        }))
      ));
    } else {
      currentMessages.push(openaiAdapter.createAssistantToolCallMessage(collectedToolCalls));
      
      for (let i = 0; i < collectedToolCalls.length; i++) {
        const call = collectedToolCalls[i];
        const historyIndex = toolCallHistory.length - collectedToolCalls.length + i;
        currentMessages.push(openaiAdapter.formatToolResultMessage(
          call.id,
          toolCallHistory[historyIndex].result
        ));
      }
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
  convertToolsForLLM,
  executeToolCalls,
  callLLMWithTools,
  callLLMStreamWithTools
};
