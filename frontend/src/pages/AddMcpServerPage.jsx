import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiRefreshCw } from 'react-icons/fi';
import { PageLayout, Card, FormGroup, Input, Textarea, Button, Alert, Checkbox } from '../components/UI/ui';
import TitleBar from '../components/UI/TitleBar';
import { IconSelectorTrigger } from '../components/UI/IconSelector';
import { mcp as mcpBridge } from '../utils/bridge';

const AddMcpServerPage = () => {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  // Transport type: 'stdio' or 'http'
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

  // 构建配置对象
  const buildConfig = () => {
    const config = {
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
      console.log('[AddMcpServer] Testing config:', config);
      
      const result = await mcpBridge.testServer(config);
      console.log('[AddMcpServer] Test result:', result);
      
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
      console.error('[AddMcpServer] Test error:', err);
      const errorMessage = err.message || err.toString() || 'Test failed';
      setError(errorMessage);
      setTestResult({ success: false, message: errorMessage });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('[AddMcpServer] handleSubmit called');
    setError('');
    
    // 必须先测试成功才能添加
    if (!testResult?.success) {
      console.log('[AddMcpServer] Test not successful, testResult:', testResult);
      setError('Please test the server connection first');
      return;
    }
    
    try {
      const config = buildConfig();
      console.log('[AddMcpServer] Creating server with config:', config);
      
      const result = await mcpBridge.createServer(config);
      console.log('[AddMcpServer] Create result:', result);
      
      // 通知其他窗口（如 chatbox）更新 MCP 服务器列表
      await mcpBridge.emitServersUpdated({ action: 'created', serverName: config.name });
      
      // 显示成功提示
      alert(`MCP Server "${config.name}" added successfully!`);
      
      // 返回上一页
      navigate('/mcp');
    } catch (err) {
      console.error('[AddMcpServer] Create error:', err);
      setError(err.message || err.toString() || 'Unknown error');
    }
  };

  return (
    <PageLayout>
      <TitleBar 
        title="Add MCP Server" 
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
                onClick={() => navigate('/mcp')}
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
                disabled={!testResult?.success}
              >
                Add Server
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </PageLayout>
  );
};

export default AddMcpServerPage;
