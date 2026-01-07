/**
 * MCP Settings Component
 * 
 * 允许用户管理 MCP 服务器配置
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import tauri from '../../utils/tauri';
import { FaPlus, FaTrash, FaChevronDown, FaChevronUp, FaPen } from 'react-icons/fa6';
import { FiRefreshCw } from 'react-icons/fi';

/**
 * 单个 MCP 服务器配置卡片
 */
const McpServerCard = ({ server, onDelete, onEdit, onUpdate }) => {
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState([]);
  const isRunning = server.isRunning || server.status === 'running';
  
  // 获取服务器工具列表
  const loadTools = useCallback(async () => {
    if (!isRunning) {
      setTools([]);
      return;
    }
    
    try {
      // 获取所有工具，然后筛选出属于此服务器的
      const allTools = await tauri.mcp.getAllTools();
      // 工具列表包含 serverId，筛选当前服务器的工具
      const serverTools = (allTools || []).filter(t => t.serverId === server._id);
      setTools(serverTools);
    } catch (error) {
      console.error('Failed to load tools:', error);
      setTools([]);
    }
  }, [server._id, isRunning]);
  
  useEffect(() => {
    loadTools();
  }, [loadTools]);
  
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <div className={`w-3 h-3 rounded-full ${isRunning ? 'bg-green-500' : 'bg-gray-300'}`} />
          
          <div>
            <h3 className="font-medium text-gray-900">{server.name}</h3>
            <p className="text-sm text-gray-500">{server.command}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {/* Edit button */}
          <button
            onClick={() => onEdit(server)}
            className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors"
            title="Edit Server"
          >
            <FaPen className="w-4 h-4" />
          </button>
          
          {/* Delete button */}
          <button
            onClick={() => onDelete(server._id)}
            className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-red-600 transition-colors"
            title="Delete Server"
          >
            <FaTrash className="w-4 h-4" />
          </button>
          
          {/* Expand button */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-2 rounded-md text-gray-500 hover:bg-gray-100 transition-colors"
          >
            {expanded ? <FaChevronUp className="w-4 h-4" /> : <FaChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>
      
      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-gray-100 p-4 bg-gray-50">
          {/* Server details */}
          <div className="space-y-2 text-sm">
            <div className="flex">
              <span className="w-24 text-gray-500">Command:</span>
              <code className="text-gray-700 bg-gray-100 px-2 py-0.5 rounded text-xs">
                {server.command} {server.args?.join(' ')}
              </code>
            </div>
            
            {server.env && Object.keys(server.env).length > 0 && (
              <div className="flex">
                <span className="w-24 text-gray-500">Env vars:</span>
                <span className="text-gray-700">{Object.keys(server.env).length} configured</span>
              </div>
            )}
            
            <div className="flex">
              <span className="w-24 text-gray-500">Auto-start:</span>
              <span className="text-gray-700">{server.autoStart ? 'Yes' : 'No'}</span>
            </div>
          </div>
          
          {/* Tools list */}
          {isRunning && tools.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                Available Tools ({tools.length})
              </h4>
              <div className="grid gap-2">
                {tools.map((tool, index) => (
                  <div key={index} className="bg-white rounded p-2 border border-gray-200">
                    <div className="font-medium text-gray-800 text-sm">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-gray-500 mt-1">{tool.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {isRunning && tools.length === 0 && (
            <div className="mt-4 text-sm text-gray-500">
              No tools available from this server.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * MCP Settings 主组件
 */
export const McpSettings = () => {
  const navigate = useNavigate();
  const [servers, setServers] = useState([]);
  const [serverStatuses, setServerStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // 加载服务器列表
  const loadServers = useCallback(async () => {
    try {
      const serverList = await tauri.mcp.getServers();
      setServers(serverList || []);
      
      // 获取状态
      const statuses = {};
      for (const server of serverList || []) {
        try {
          const status = await tauri.mcp.getServerStatus(server._id);
          statuses[server._id] = status;
        } catch {
          statuses[server._id] = 'unknown';
        }
      }
      setServerStatuses(statuses);
    } catch (err) {
      setError('Failed to load MCP servers');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);
  
  useEffect(() => {
    loadServers();
  }, [loadServers]);
  
  // 监听 MCP 服务器更新事件（从其他窗口触发的更新）
  useEffect(() => {
    if (!tauri.mcp.onServersUpdated) return;
    
    const cleanup = tauri.mcp.onServersUpdated(() => {
      console.log('[McpSettings] Received servers updated event, reloading...');
      loadServers();
    });
    
    return cleanup;
  }, [loadServers]);
  
  const handleDeleteServer = async (id) => {
    // 找到要删除的服务器名称用于提示
    const serverToDelete = servers.find(s => s._id === id);
    const serverName = serverToDelete?.name || 'Unknown';
    
    const confirmDelete = await tauri.confirm(`Are you sure you want to delete "${serverName}"?`, {
      title: 'Delete MCP Server'
    });
    if (!confirmDelete) return;
    
    try {
      await tauri.mcp.deleteServer(id);
      
      // 通知其他窗口（如 chatbox）更新 MCP 服务器列表
      await tauri.mcp.emitServersUpdated({ action: 'deleted', serverName });
      
      await loadServers();
      alert(`MCP Server "${serverName}" deleted successfully!`);
    } catch (err) {
      setError('Failed to delete server');
      console.error(err);
    }
  };
  
  const handleEditServer = (server) => {
    navigate(`/editMcpServer?id=${server._id}`);
  };
  
  if (!tauri.mcp) {
    return (
      <div className="p-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          MCP functionality is not available. Please update PetGPT.
        </div>
      </div>
    );
  }
  
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">MCP Servers</h2>
          <p className="text-sm text-gray-500">
            Manage Model Context Protocol servers for tool integration
          </p>
        </div>
        
        <button
          onClick={() => navigate('/addMcpServer')}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
        >
          <FaPlus className="w-4 h-4" />
          Add Server
        </button>
      </div>
      
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
          {error}
        </div>
      )}
      
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <FiRefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
        </div>
      ) : servers.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg">
          <p className="text-gray-500 mb-2">No MCP servers configured</p>
          <p className="text-sm text-gray-400">
            Add a server to enable tool integration
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map(server => (
            <McpServerCard
              key={server._id}
              server={{
                ...server,
                status: serverStatuses[server._id] || (server.isRunning ? 'running' : 'stopped')
              }}
              onDelete={handleDeleteServer}
              onEdit={handleEditServer}
              onUpdate={loadServers}
            />
          ))}
        </div>
      )}
      
      {/* Usage instructions */}
      <div className="mt-6 p-4 bg-blue-50 rounded-lg">
        <h3 className="font-medium text-blue-900 mb-2">Quick Start</h3>
        <div className="text-sm text-blue-800 space-y-2">
          <p>1. Add an MCP server (e.g., filesystem, web search)</p>
          <p>2. Click the server icon in the chat toolbar to enable it</p>
          <p>3. The server will auto-start and AI can use its tools</p>
        </div>
        
        <h4 className="font-medium text-blue-900 mt-4 mb-2">Example Servers</h4>
        <div className="text-sm text-blue-800 space-y-1 font-mono">
          <p>• Filesystem: <code className="bg-blue-100 px-1 rounded">npx -y @modelcontextprotocol/server-filesystem /path</code></p>
          <p>• GitHub: <code className="bg-blue-100 px-1 rounded">npx -y @modelcontextprotocol/server-github</code></p>
          <p>• Brave Search: <code className="bg-blue-100 px-1 rounded">npx -y @anthropic/mcp-server-brave-search</code></p>
        </div>
      </div>
    </div>
  );
};

export default McpSettings;
