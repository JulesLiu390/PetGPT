/**
 * MCP Tools React Hook
 * 
 * 提供在 React 组件中使用 MCP 工具的 hook
 * 支持每个服务器独立的启用状态
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getMcpTools, convertToolsForLLM, executeToolByName, formatToolResult } from './toolExecutor.js';
import tauri from '../tauri';

/**
 * 用于管理 MCP 工具状态的 React Hook
 * 
 * @param {Object} options
 * @param {Set<string>} options.enabledServers - 已启用的服务器名称集合
 * @param {string} options.apiFormat - LLM API 格式
 * @returns {Object} MCP 工具状态和方法
 */
export const useMcpTools = ({ enabledServers = new Set(), apiFormat = 'openai_compatible' } = {}) => {
  const [mcpServers, setMcpServers] = useState([]);  // 所有服务器配置
  const [mcpTools, setMcpTools] = useState([]);
  const [llmTools, setLlmTools] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toolCallHistory, setToolCallHistory] = useState([]);
  
  // 用于追踪上一次的 enabledServers 内容，避免引用变化导致不必要的重新加载
  const prevEnabledServersRef = useRef(null);
  const prevApiFormatRef = useRef(apiFormat);
  
  // 加载服务器列表
  const loadServers = useCallback(async () => {
    try {
      if (!tauri.mcp?.listServers) {
        console.warn('[useMcpTools] MCP API (listServers) not available');
        return [];
      }
      // console.log('[useMcpTools] Loading servers...');
      const servers = await tauri.mcp.listServers();
      // console.log('[useMcpTools] Loaded servers:', servers?.length, servers?.map(s => ({ name: s.name, id: s._id })));
      setMcpServers(servers || []);
      return servers || [];
    } catch (err) {
      console.error('[useMcpTools] Failed to load servers:', err);
      return [];
    }
  }, []);
  
  // 加载可用的 MCP 工具 (只从启用的服务器获取)
  const loadTools = useCallback(async () => {
    const hasEnabledServers = enabledServers.size > 0;
    
    if (!hasEnabledServers) {
      setMcpTools([]);
      setLlmTools([]);
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const tools = await getMcpTools();
      
      // console.log('[useMcpTools] Raw tools from backend:', tools.map(t => ({ name: t.name, serverName: t.serverName })));
      // console.log('[useMcpTools] enabledServers:', Array.from(enabledServers));
      
      // 过滤只保留已启用服务器的工具
      const filteredTools = tools.filter(tool => {
        // 使用 tool.serverName 字段进行过滤
        return enabledServers.has(tool.serverName);
      });
      
      // console.log('[useMcpTools] Filtered tools:', filteredTools.length);
      setMcpTools(filteredTools);
      
      // 转换为 LLM 格式
      const converted = convertToolsForLLM(filteredTools, apiFormat);
      setLlmTools(converted);
      
      console.log('[useMcpTools] Loaded tools:', filteredTools.length, 'from servers:', Array.from(enabledServers));
    } catch (err) {
      console.error('[useMcpTools] Failed to load tools:', err);
      setError(err.message);
      setMcpTools([]);
      setLlmTools([]);
    } finally {
      setLoading(false);
    }
  }, [enabledServers, apiFormat]);
  
  // 初始加载服务器列表（只执行一次）
  useEffect(() => {
    loadServers();
  }, []); // 移除 loadServers 依赖，只在挂载时执行一次
  
  // 当启用的服务器变化时，重新加载工具
  // 使用内容比较而不是引用比较
  useEffect(() => {
    // 将当前 Set 转换为排序后的数组字符串，用于比较
    const currentServersKey = Array.from(enabledServers).sort().join(',');
    const prevServersKey = prevEnabledServersRef.current;
    const currentApiFormat = apiFormat;
    const prevApiFormat = prevApiFormatRef.current;
    
    // 只有当内容真正改变时才重新加载
    if (currentServersKey !== prevServersKey || currentApiFormat !== prevApiFormat) {
      prevEnabledServersRef.current = currentServersKey;
      prevApiFormatRef.current = currentApiFormat;
      loadTools();
    }
  }, [enabledServers, apiFormat, loadTools]);
  
  // 监听 MCP 服务器更新事件
  useEffect(() => {
    if (!tauri.mcp?.onServersUpdated) return;
    
    const cleanup = tauri.mcp.onServersUpdated(() => {
      console.log('[useMcpTools] Received servers updated event, reloading...');
      loadServers();
    });
    
    return cleanup;
  }, [loadServers]);
  
  // 执行单个工具调用
  const executeTool = useCallback(async (toolName, args) => {
    try {
      console.log('[useMcpTools] Executing tool:', toolName, args);
      const result = await executeToolByName(toolName, args);
      const formatted = formatToolResult(result);
      
      // 记录到历史
      setToolCallHistory(prev => [...prev, {
        name: toolName,
        arguments: args,
        result: formatted,
        timestamp: Date.now()
      }]);
      
      return { success: true, result: formatted };
    } catch (err) {
      console.error('[useMcpTools] Tool execution failed:', err);
      return { success: false, error: err.message };
    }
  }, []);
  
  // 批量执行工具调用
  const executeToolCalls = useCallback(async (toolCalls) => {
    const results = [];
    
    for (const call of toolCalls) {
      const { success, result, error } = await executeTool(call.name, call.arguments);
      results.push({
        id: call.id,
        name: call.name,
        result: success ? result : `Error: ${error}`
      });
    }
    
    return results;
  }, [executeTool]);
  
  // 清除工具调用历史
  const clearHistory = useCallback(() => {
    setToolCallHistory([]);
  }, []);
  
  // 刷新工具列表
  const refresh = useCallback(async () => {
    await loadServers();
    await loadTools();
  }, [loadServers, loadTools]);
  
  // 刷新服务器列表
  const refreshServers = useCallback(() => {
    return loadServers();
  }, [loadServers]);
  
  return {
    // 状态
    mcpServers,         // 所有服务器配置列表
    mcpTools,           // 原始 MCP 工具列表
    llmTools,           // 转换后的 LLM 工具列表
    loading,            // 是否正在加载
    error,              // 错误信息
    toolCallHistory,    // 工具调用历史
    hasTools: llmTools.length > 0,  // 是否有可用工具
    
    // 方法
    executeTool,        // 执行单个工具
    executeToolCalls,   // 批量执行工具
    clearHistory,       // 清除历史
    refresh,            // 刷新所有
    refreshServers      // 刷新服务器列表
  };
};

export default useMcpTools;
