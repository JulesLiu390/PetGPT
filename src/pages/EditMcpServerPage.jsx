import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FiRefreshCw } from 'react-icons/fi';
import { PageLayout, Card, FormGroup, Input, Textarea, Button, Alert, Checkbox } from '../components/UI/ui';
import TitleBar from '../components/UI/TitleBar';
import { IconSelectorTrigger } from '../components/UI/IconSelector';
import { mcp as mcpBridge } from '../utils/bridge';

const EditMcpServerPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const serverId = searchParams.get('id');
  
  const [loading, setLoading] = useState(true);
  const [originalServer, setOriginalServer] = useState(null);
  
  const [name, setName] = useState('');
  // Transport type
  const [transport, setTransport] = useState('stdio');
  // Stdio fields
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envVars, setEnvVars] = useState('');
  // HTTP fields
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  // Common fields
  const [autoStart, setAutoStart] = useState(false);
  const [icon, setIcon] = useState('🔧');
  const [showInToolbar, setShowInToolbar] = useState(true);
  
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // 加载服务器数据
  useEffect(() => {
    const loadServer = async () => {
      if (!serverId) {
        setError('No server ID provided');
        setLoading(false);
        return;
      }
      
      try {
        const servers = await mcpBridge.getServers();
        const server = servers?.find(s => s._id === serverId);
        
        if (server) {
          setOriginalServer(server);
          setName(server.name || '');
          setTransport(server.transport || 'stdio');
          setCommand(server.command || '');
          setArgs(server.args?.join(', ') || '');
          setAutoStart(server.autoStart || false);
          setIcon(server.icon || '🔧');
          setShowInToolbar(server.showInToolbar !== false);
          setEnvVars(
            server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
          );
          setUrl(server.url || '');
          setApiKey(server.apiKey || '');
        } else {
          setError('Server not found');
        }
      } catch (err) {
        console.error('Failed to load server:', err);
        setError('Failed to load server details');
      } finally {
        setLoading(false);
      }
    };
    
    loadServer();
  }, [serverId]);

  // 构建配置对象
  const buildConfig = () => {
    const config = {
      _id: serverId,
      name: name.trim(),
      transport,
      autoStart,
      icon,
      showInToolbar
    };
    
    if (transport === 'stdio') {
      const env = {};
      if (envVars.trim()) {
        envVars.split('\n').forEach(line => {
          const [key, ...valueParts] = line.split('=');
          if (key && valueParts.length > 0) {
            env[key.trim()] = valueParts.join('=').trim();
          }
        });
      }
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/,|\s+/).filter(Boolean) : [];
      config.env = env;
    } else {
      config.url = url.trim();
      if (apiKey.trim()) {
        config.apiKey = apiKey.trim();
      }
    }
    
    return config;
  };

  // 验证必填字段
  const isValid = () => {
    if (!name.trim()) return false;
    if (transport === 'stdio') {
      return !!command.trim();
    } else {
      return !!url.trim();
    }
  };

  // 测试服务器连接
  const handleTest = async () => {
    setError('');
    setTestResult(null);
    
    if (!isValid()) {
      setError(transport === 'stdio' 
        ? 'Name and command are required' 
        : 'Name and URL are required');
      return;
    }
    
    setTesting(true);
    
    try {
      const config = buildConfig();
      console.log('[EditMcpServer] Testing config:', config);
      
      const result = await mcpBridge.testServer(config);
      console.log('[EditMcpServer] Test result:', result);
      
      if (result) {
        // 兼容 Rust 返回的 ServerStatus 格式
        const formattedResult = {
          success: result.isRunning !== undefined ? result.isRunning : result.success,
          toolCount: result.tools?.length || result.toolCount || 0,
          resourceCount: result.resources?.length || result.resourceCount || 0,
          tools: result.tools || [],
          message: result.error || result.message,
        };
        setTestResult(formattedResult);
        if (!formattedResult.success) {
          setError(formattedResult.message || 'Test failed');
        }
      } else {
        setError('No response from server');
        setTestResult({ success: false, message: 'No response from server' });
      }
    } catch (err) {
      console.error('[EditMcpServer] Test error:', err);
      const errorMessage = err.message || err.toString() || 'Test failed';
      setError(errorMessage);
      setTestResult({ success: false, message: errorMessage });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!isValid()) {
      setError(transport === 'stdio' 
        ? 'Name and command are required' 
        : 'Name and URL are required');
      return;
    }
    
    // 检查配置是否变化
    const configChanged = checkConfigChanged();
    
    // 如果配置变了且没有测试成功，需要先测试
    if (configChanged && !testResult?.success) {
      setError('Configuration changed. Please test the connection first.');
      return;
    }
    
    try {
      const config = buildConfig();
      await mcpBridge.updateServer(config._id, config);
      
      // 通知其他窗口（如 chatbox）更新 MCP 服务器列表
      await mcpBridge.emitServersUpdated({ action: 'updated', serverName: config.name });
      
      // 显示成功提示
      alert(`MCP Server "${config.name}" updated successfully!`);
      
      // 返回管理页面
      navigate('/manage?tab=mcp');
    } catch (err) {
      setError(err.message);
    }
  };

  const checkConfigChanged = () => {
    if (!originalServer) return true;
    
    if (transport !== (originalServer.transport || 'stdio')) return true;
    if (name !== originalServer.name) return true;
    if (autoStart !== (originalServer.autoStart || false)) return true;
    
    if (transport === 'stdio') {
      if (command !== (originalServer.command || '')) return true;
      if (args !== (originalServer.args?.join(', ') || '')) return true;
      const originalEnvStr = originalServer.env 
        ? Object.entries(originalServer.env).map(([k, v]) => `${k}=${v}`).join('\n') 
        : '';
      if (envVars !== originalEnvStr) return true;
    } else {
      if (url !== (originalServer.url || '')) return true;
      if (apiKey !== (originalServer.apiKey || '')) return true;
    }
    
    return false;
  };

  if (loading) {
    return (
      <PageLayout className="bg-white/95">
        <div className="h-screen flex flex-col overflow-hidden">
          <div className="shrink-0">
            <TitleBar title="Edit MCP Server" backTo="/manage?tab=mcp" />
          </div>
          <div className="flex-1 flex items-center justify-center">
            <FiRefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout className="bg-white/95">
      <div className="h-screen flex flex-col overflow-hidden">
        <div className="shrink-0">
          <TitleBar 
            title="Edit MCP Server" 
            backTo="/manage?tab=mcp"
          />
        </div>
      
        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
        <Card>
          <form onSubmit={handleSubmit} className="space-y-6">
            <FormGroup label="Server Name *" help="A unique name for this server">
              <Input
                value={name}
                onChange={(e) => { setName(e.target.value); setTestResult(null); }}
                placeholder="e.g., tavily, filesystem"
                required
              />
            </FormGroup>
            
            <FormGroup label="Transport Type" help="How to connect to the MCP server">
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="transport"
                    value="stdio"
                    checked={transport === 'stdio'}
                    onChange={(e) => { setTransport(e.target.value); setTestResult(null); }}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span className="text-sm">
                    <span className="font-medium">Stdio</span>
                    <span className="text-gray-500 ml-1">(Local Process)</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="transport"
                    value="http"
                    checked={transport === 'http'}
                    onChange={(e) => { setTransport(e.target.value); setTestResult(null); }}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span className="text-sm">
                    <span className="font-medium">HTTP/SSE</span>
                    <span className="text-gray-500 ml-1">(Remote Server)</span>
                  </span>
                </label>
              </div>
            </FormGroup>
            
            {transport === 'stdio' ? (
              <>
                <FormGroup label="Command *" help="The executable to run (e.g., npx, uvx, python)">
                  <Input
                    value={command}
                    onChange={(e) => { setCommand(e.target.value); setTestResult(null); }}
                    placeholder="e.g., npx"
                    required
                  />
                </FormGroup>
                
                <FormGroup label="Arguments" help="Comma or space separated arguments">
                  <Input
                    value={args}
                    onChange={(e) => { setArgs(e.target.value); setTestResult(null); }}
                    placeholder="e.g., -y, @modelcontextprotocol/server-filesystem, /path/to/allowed/dir"
                  />
                </FormGroup>
                
                <FormGroup label="Environment Variables" help="One per line: KEY=value">
                  <Textarea
                    value={envVars}
                    onChange={(e) => { setEnvVars(e.target.value); setTestResult(null); }}
                    placeholder="TAVILY_API_KEY=tvly-xxxxxxxx&#10;ANOTHER_KEY=value"
                    rows={3}
                    className="font-mono text-sm"
                  />
                </FormGroup>
              </>
            ) : (
              <>
                <FormGroup label="Server URL *" help="The HTTP endpoint URL of the MCP server">
                  <Input
                    value={url}
                    onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
                    placeholder="e.g., https://api.example.com/mcp"
                    required
                  />
                </FormGroup>
                
                <FormGroup label="API Key" help="Optional authentication key">
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setTestResult(null); }}
                    placeholder="Your API key (optional)"
                  />
                </FormGroup>
              </>
            )}
            
            <FormGroup label="Icon" help="Select an icon for the toolbar">
              <div className="flex items-center gap-3">
                <IconSelectorTrigger value={icon} onChange={setIcon} />
                <span className="text-sm text-gray-500">
                  Click to select an icon
                </span>
              </div>
            </FormGroup>
            
            <div className="flex flex-col gap-3">
              <Checkbox
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
                label="Auto-start when PetGPT opens"
              />
              
              <Checkbox
                checked={showInToolbar}
                onChange={(e) => setShowInToolbar(e.target.checked)}
                label="Show in toolbar"
              />
            </div>
            
            {/* Test Result Display */}
            {(testResult || error) && (
              <div className="mt-4">
                {error && !testResult && (
                  <Alert type="error">{error}</Alert>
                )}
                {testResult && (
                  <div className={`p-4 rounded-lg border ${
                    testResult.success 
                      ? 'bg-green-50 border-green-200 text-green-800' 
                      : 'bg-red-50 border-red-200 text-red-800'
                  }`}>
                    <div className="font-medium flex items-center gap-2">
                      {testResult.success ? '✓ Connection Successful' : '✗ Connection Failed'}
                    </div>
                    
                    {testResult.success && (
                      <div className="mt-2 text-sm">
                        <p>Found {testResult.toolCount || 0} tool(s), {testResult.resourceCount || 0} resource(s)</p>
                        
                        {testResult.tools && testResult.tools.length > 0 && (
                          <div className="mt-2">
                            <div className="text-xs font-medium mb-1 opacity-75">Available Tools:</div>
                            <div className="flex flex-wrap gap-1">
                              {testResult.tools.slice(0, 5).map((tool, i) => (
                                <span key={i} className="px-2 py-0.5 bg-white/50 rounded text-xs border border-green-200">
                                  {tool.name}
                                </span>
                              ))}
                              {testResult.tools.length > 5 && (
                                <span className="px-2 py-0.5 bg-white/50 rounded text-xs border border-green-200">
                                  +{testResult.tools.length - 5} more
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {!testResult.success && testResult.message && (
                      <div className="mt-1 text-sm opacity-90">{testResult.message}</div>
                    )}
                  </div>
                )}
              </div>
            )}
            
            <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
              <Button
                variant="secondary"
                onClick={() => navigate('/manage?tab=mcp')}
                type="button"
              >
                Cancel
              </Button>
              
              <Button
                variant="warning"
                onClick={handleTest}
                disabled={testing || !isValid()}
                type="button"
              >
                {testing ? (
                  <span className="flex items-center gap-2">
                    <FiRefreshCw className="animate-spin" />
                    Testing...
                  </span>
                ) : 'Test Connection'}
              </Button>
              
              <Button
                variant="primary"
                type="submit"
                disabled={!testResult?.success && !originalServer} // 如果是编辑，允许直接保存（如果没改配置）
              >
                Save Changes
              </Button>
            </div>
          </form>
        </Card>
        </div>
      </div>
    </PageLayout>
  );
};

export default EditMcpServerPage;
