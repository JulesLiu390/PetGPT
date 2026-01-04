import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FiRefreshCw } from 'react-icons/fi';
import { PageLayout, Card, FormGroup, Input, Textarea, Button, Alert, Checkbox } from '../components/UI/ui';
import TitleBar from '../components/UI/TitleBar';
import { IconSelectorTrigger } from '../components/UI/IconSelector';

const EditMcpServerPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const serverId = searchParams.get('id');
  
  const [loading, setLoading] = useState(true);
  const [originalServer, setOriginalServer] = useState(null);
  
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [envVars, setEnvVars] = useState('');
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
        const servers = await window.electron?.mcp?.getServers();
        const server = servers?.find(s => s._id === serverId);
        
        if (server) {
          setOriginalServer(server);
          setName(server.name || '');
          setCommand(server.command || '');
          setArgs(server.args?.join(', ') || '');
          setAutoStart(server.autoStart || false);
          setIcon(server.icon || '🔧');
          setShowInToolbar(server.showInToolbar !== false);
          setEnvVars(
            server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
          );
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
    const env = {};
    if (envVars.trim()) {
      envVars.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join('=').trim();
        }
      });
    }
    
    return {
      _id: serverId,
      name: name.trim(),
      command: command.trim(),
      args: args.trim() ? args.trim().split(/,|\s+/).filter(Boolean) : [],
      env,
      autoStart,
      icon,
      showInToolbar
    };
  };

  // 测试服务器连接
  const handleTest = async () => {
    setError('');
    setTestResult(null);
    
    if (!name.trim() || !command.trim()) {
      setError('Name and command are required');
      return;
    }
    
    setTesting(true);
    
    try {
      const config = buildConfig();
      console.log('[EditMcpServer] Testing config:', config);
      
      if (!window.electron?.mcp?.testServer) {
        throw new Error('Test API not available');
      }
      
      const result = await window.electron.mcp.testServer(config);
      console.log('[EditMcpServer] Test result:', result);
      
      if (result) {
        setTestResult(result);
        if (!result.success) {
          setError(result.message || result.error || 'Test failed');
        }
      } else {
        setError('No response from server');
        setTestResult({ success: false, message: 'No response from server' });
      }
    } catch (err) {
      console.error('[EditMcpServer] Test error:', err);
      const errorMessage = err.message || 'Test failed';
      setError(errorMessage);
      setTestResult({ success: false, message: errorMessage });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!name.trim() || !command.trim()) {
      setError('Name and command are required');
      return;
    }
    
    // 如果配置没有变化，直接保存
    const configChanged = 
      name !== originalServer.name ||
      command !== originalServer.command ||
      args !== (originalServer.args?.join(', ') || '') ||
      autoStart !== (originalServer.autoStart || false) ||
      envVars !== (originalServer.env ? Object.entries(originalServer.env).map(([k, v]) => `${k}=${v}`).join('\n') : '');
    
    // 如果配置变了且没有测试成功，需要先测试
    if (configChanged && !testResult?.success) {
      setError('Configuration changed. Please test the connection first.');
      return;
    }
    
    try {
      const config = buildConfig();
      await window.electron?.mcp?.updateServer(config._id, config);
      navigate('/mcp');
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <PageLayout>
        <TitleBar title="Edit MCP Server" onBack={() => navigate('/mcp')} />
        <div className="flex items-center justify-center h-64">
          <FiRefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <TitleBar 
        title="Edit MCP Server" 
        onBack={() => navigate('/mcp')} 
      />
      
      <div className="max-w-3xl mx-auto p-6">
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
                onClick={() => navigate('/mcp')}
                type="button"
              >
                Cancel
              </Button>
              
              <Button
                variant="warning"
                onClick={handleTest}
                disabled={testing || !name.trim() || !command.trim()}
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
    </PageLayout>
  );
};

export default EditMcpServerPage;
