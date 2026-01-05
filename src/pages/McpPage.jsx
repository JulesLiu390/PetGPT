import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { MdCancel } from "react-icons/md";
import { FaPlus, FaTrash, FaChevronDown, FaChevronUp, FaPen, FaServer } from 'react-icons/fa6';
import { FiRefreshCw } from 'react-icons/fi';
import TitleBar from "../components/UI/TitleBar";
import { PageLayout, Button, Badge } from "../components/UI/ui";
import bridge from "../utils/bridge";

/**
 * 单个 MCP 服务器卡片
 */
const McpServerCard = ({ server, onDelete, onEdit }) => {
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
      const allTools = await bridge.mcp.getAllTools();
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
    <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-3 flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-3">
        {/* Status indicator */}
        <div className={`mt-1.5 w-3 h-3 rounded-full shrink-0 ${isRunning ? 'bg-green-500' : 'bg-gray-300'}`} />
        
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 truncate">{server.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone={isRunning ? "green" : "gray"}>
                  {isRunning ? 'Running' : 'Stopped'}
                </Badge>
                {server.autoStart && <Badge tone="blue">Auto-start</Badge>}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1.5">
              <Button
                variant="secondary"
                onClick={() => onEdit(server)}
                title="Edit"
              >
                <FaPen className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="danger"
                onClick={() => onDelete(server._id)}
                title="Delete"
              >
                <FaTrash className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? <FaChevronUp className="w-3.5 h-3.5" /> : <FaChevronDown className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
          
          <div className="mt-2 text-sm text-slate-500 truncate">
            {server.command} {server.args?.join(' ')}
          </div>
        </div>
      </div>
      
      {/* Expanded content */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="space-y-2 text-sm">
            <div className="flex">
              <span className="w-24 text-slate-500">Command:</span>
              <code className="text-slate-700 bg-slate-100 px-2 py-0.5 rounded text-xs">
                {server.command} {server.args?.join(' ')}
              </code>
            </div>
            
            {server.env && Object.keys(server.env).length > 0 && (
              <div className="flex">
                <span className="w-24 text-slate-500">Env vars:</span>
                <span className="text-slate-700">{Object.keys(server.env).length} configured</span>
              </div>
            )}
          </div>
          
          {/* Tools list */}
          {isRunning && tools.length > 0 && (
            <div className="mt-3">
              <h4 className="text-sm font-medium text-slate-700 mb-2">
                Available Tools ({tools.length})
              </h4>
              <div className="grid gap-2">
                {tools.map((tool, index) => (
                  <div key={index} className="bg-slate-50 rounded p-2 border border-slate-200">
                    <div className="font-medium text-slate-800 text-sm">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-slate-500 mt-1">{tool.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {isRunning && tools.length === 0 && (
            <div className="mt-3 text-sm text-slate-500">
              No tools available from this server.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * MCP 服务器管理页面
 */
const McpPage = () => {
  const navigate = useNavigate();
  const [servers, setServers] = useState([]);
  const [serverStatuses, setServerStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  
  // 关闭窗口
  const handleClose = () => {
    bridge.hideMcpWindow?.();
  };
  
  // 加载服务器列表
  const loadServers = useCallback(async () => {
    try {
      const serverList = await bridge.mcp.getServers();
      setServers(serverList || []);
      
      // 获取状态
      const statuses = {};
      for (const server of serverList || []) {
        try {
          const status = await bridge.mcp.getServerStatus(server._id);
          statuses[server._id] = status;
        } catch {
          statuses[server._id] = 'unknown';
        }
      }
      setServerStatuses(statuses);
    } catch (err) {
      console.error('Failed to load MCP servers:', err);
    } finally {
      setLoading(false);
    }
  }, []);
  
  useEffect(() => {
    loadServers();
  }, [loadServers]);
  
  // 监听 MCP 服务器更新事件
  useEffect(() => {
    if (!bridge.mcp.onServersUpdated) return;
    
    const cleanup = bridge.mcp.onServersUpdated(() => {
      console.log('[McpPage] Received servers updated event, reloading...');
      loadServers();
    });
    
    return cleanup;
  }, [loadServers]);
  
  const handleDeleteServer = async (id) => {
    const serverToDelete = servers.find(s => s._id === id);
    const serverName = serverToDelete?.name || 'Unknown';
    
    const confirmDelete = await bridge.confirm(`Are you sure you want to delete "${serverName}"?`, {
      title: 'Delete MCP Server'
    });
    if (!confirmDelete) return;
    
    try {
      await bridge.mcp.deleteServer(id);
      await bridge.mcp.emitServersUpdated({ action: 'deleted', serverName });
      await loadServers();
    } catch (err) {
      console.error('Failed to delete server:', err);
      alert('Failed to delete server: ' + (err.message || err));
    }
  };
  
  const handleEditServer = (server) => {
    navigate(`/editMcpServer?id=${server._id}`);
  };

  return (
    <PageLayout className="bg-white/95">
      <div className="flex flex-col h-screen w-full">
        {/* Fixed header area */}
        <div className="shrink-0">
          <TitleBar
            title="MCP Servers"
            left={
              <button
                type="button"
                className="no-drag inline-flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                onClick={handleClose}
                title="Close"
              >
                <MdCancel className="w-5 h-5" />
              </button>
            }
            height="h-12"
          />
          {/* Title + New button */}
          <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
            <div className="text-base font-semibold text-slate-800">
              Servers ({servers.length})
            </div>
            <Button variant="primary" onClick={() => navigate('/addMcpServer')}>
              <FaPlus className="w-4 h-4" />
              New
            </Button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <FiRefreshCw className="w-8 h-8 animate-spin text-slate-300 mb-4" />
              <div className="text-slate-400 text-sm">Loading...</div>
            </div>
          ) : servers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <FaServer className="w-12 h-12 text-slate-300 mb-4" />
              <div className="text-slate-600 font-medium">No MCP servers yet</div>
              <div className="text-slate-400 text-sm mb-4">Add one to enable tool integration</div>
              <Button variant="primary" onClick={() => navigate('/addMcpServer')}>
                <FaPlus className="w-4 h-4" />
                Add Server
              </Button>
            </div>
          ) : (
            servers.map(server => (
              <McpServerCard
                key={server._id}
                server={{
                  ...server,
                  status: serverStatuses[server._id] || (server.isRunning ? 'running' : 'stopped')
                }}
                onDelete={handleDeleteServer}
                onEdit={handleEditServer}
              />
            ))
          )}
        </div>
      </div>
    </PageLayout>
  );
};

export default McpPage;
