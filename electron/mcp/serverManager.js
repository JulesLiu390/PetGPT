/**
 * MCP Server Manager
 * 管理所有 MCP Server 的生命周期
 */

const { EventEmitter } = require("events");
const { MCPClient } = require("./client");
const mcpConfig = require("../models/mcp_config");

class MCPServerManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map(); // serverId -> MCPClient
    this.isInitialized = false;
  }

  /**
   * 初始化管理器，启动所有自动启动的服务器
   */
  async initialize() {
    if (this.isInitialized) {
      console.log("[MCPManager] Already initialized");
      return;
    }

    console.log("[MCPManager] Initializing...");

    try {
      const autoStartServers = await mcpConfig.getAutoStartServers();
      console.log(`[MCPManager] Found ${autoStartServers.length} auto-start servers`);

      for (const serverConfig of autoStartServers) {
        try {
          await this.startServer(serverConfig._id);
        } catch (error) {
          console.error(`[MCPManager] Failed to auto-start server ${serverConfig.name}:`, error);
        }
      }

      this.isInitialized = true;
      console.log("[MCPManager] Initialization complete");
    } catch (error) {
      console.error("[MCPManager] Initialization failed:", error);
      throw error;
    }
  }

  /**
   * 启动指定的 MCP Server
   * @param {string} serverId - Server ID
   */
  async startServer(serverId) {
    // 检查是否已经运行
    if (this.servers.has(serverId)) {
      const existing = this.servers.get(serverId);
      if (existing.isConnected) {
        console.log(`[MCPManager] Server ${serverId} already running`);
        return existing.getServerInfo();
      }
      // 如果存在但未连接，先清理
      this.servers.delete(serverId);
    }

    // 获取配置
    const config = await mcpConfig.getServerById(serverId);
    if (!config) {
      throw new Error(`Server config not found: ${serverId}`);
    }

    if (!config.enabled) {
      throw new Error(`Server ${config.name} is disabled`);
    }

    console.log(`[MCPManager] Starting server: ${config.name}`);

    // 创建客户端
    const client = new MCPClient(config);

    // 设置事件监听
    client.on("connected", (info) => {
      console.log(`[MCPManager] Server ${config.name} connected`);
      this.emit("serverConnected", { serverId, info });
    });

    client.on("disconnected", (info) => {
      console.log(`[MCPManager] Server ${config.name} disconnected`);
      this.servers.delete(serverId);
      this.emit("serverDisconnected", { serverId, info });
    });

    client.on("error", (error) => {
      console.error(`[MCPManager] Server ${config.name} error:`, error);
      this.emit("serverError", { serverId, error });
    });

    client.on("toolsUpdated", (tools) => {
      this.emit("toolsUpdated", { serverId, tools });
    });

    client.on("resourcesUpdated", (resources) => {
      this.emit("resourcesUpdated", { serverId, resources });
    });

    // 连接
    await client.connect();
    this.servers.set(serverId, client);

    return client.getServerInfo();
  }

  /**
   * 停止指定的 MCP Server
   * @param {string} serverId - Server ID
   */
  async stopServer(serverId) {
    const client = this.servers.get(serverId);
    if (!client) {
      console.log(`[MCPManager] Server ${serverId} not running`);
      return;
    }

    console.log(`[MCPManager] Stopping server: ${serverId}`);
    client.disconnect();
    this.servers.delete(serverId);
  }

  /**
   * 重启指定的 MCP Server
   * @param {string} serverId - Server ID
   */
  async restartServer(serverId) {
    await this.stopServer(serverId);
    await new Promise(resolve => setTimeout(resolve, 1000)); // 等待 1 秒
    return await this.startServer(serverId);
  }

  /**
   * 停止所有服务器
   */
  async stopAll() {
    console.log("[MCPManager] Stopping all servers...");
    const promises = [];
    for (const serverId of this.servers.keys()) {
      promises.push(this.stopServer(serverId));
    }
    await Promise.all(promises);
    console.log("[MCPManager] All servers stopped");
  }

  /**
   * 获取服务器状态
   * @param {string} serverId - Server ID
   */
  getServerStatus(serverId) {
    const client = this.servers.get(serverId);
    if (!client) {
      return { running: false };
    }
    return {
      running: true,
      ...client.getServerInfo(),
    };
  }

  /**
   * 获取所有正在运行的服务器状态
   */
  getAllServerStatus() {
    const status = {};
    for (const [serverId, client] of this.servers) {
      status[serverId] = {
        running: true,
        ...client.getServerInfo(),
      };
    }
    return status;
  }

  /**
   * 获取所有可用的工具（来自所有运行中的服务器）
   */
  getAllTools() {
    const allTools = [];
    for (const [serverId, client] of this.servers) {
      const tools = client.getTools();
      for (const tool of tools) {
        allTools.push({
          ...tool,
          serverId,
          serverName: client.serverConfig.name,
        });
      }
    }
    return allTools;
  }

  /**
   * 获取所有可用的资源（来自所有运行中的服务器）
   */
  getAllResources() {
    const allResources = [];
    for (const [serverId, client] of this.servers) {
      const resources = client.getResources();
      for (const resource of resources) {
        allResources.push({
          ...resource,
          serverId,
          serverName: client.serverConfig.name,
        });
      }
    }
    return allResources;
  }

  /**
   * 调用工具
   * @param {string} serverId - Server ID
   * @param {string} toolName - 工具名称
   * @param {Object} args - 工具参数
   */
  async callTool(serverId, toolName, args = {}) {
    const client = this.servers.get(serverId);
    if (!client) {
      throw new Error(`Server ${serverId} not running`);
    }
    return await client.callTool(toolName, args);
  }

  /**
   * 读取资源
   * @param {string} serverId - Server ID
   * @param {string} uri - 资源 URI
   */
  async readResource(serverId, uri) {
    const client = this.servers.get(serverId);
    if (!client) {
      throw new Error(`Server ${serverId} not running`);
    }
    return await client.readResource(uri);
  }

  /**
   * 根据工具名称查找并调用工具（自动路由到正确的服务器）
   * @param {string} toolName - 工具名称，格式可以是 "serverName__toolName" 或 "toolName"
   * @param {Object} args - 工具参数
   */
  async callToolByName(toolName, args = {}) {
    // 解析工具名称，支持 "serverName__toolName" 格式
    let targetServerName = null;
    let actualToolName = toolName;
    
    if (toolName.includes('__')) {
      const parts = toolName.split('__');
      targetServerName = parts[0];
      actualToolName = parts.slice(1).join('__'); // 处理工具名本身包含 __ 的情况
    }
    
    console.log(`[MCPManager] Looking for tool: ${actualToolName}${targetServerName ? ` from server: ${targetServerName}` : ''}`);
    
    // 查找包含该工具的服务器
    for (const [serverId, client] of this.servers) {
      // 如果指定了服务器名称，跳过不匹配的服务器
      if (targetServerName && client.serverConfig.name !== targetServerName) {
        continue;
      }
      
      const tools = client.getTools();
      const tool = tools.find(t => t.name === actualToolName);
      if (tool) {
        console.log(`[MCPManager] Found tool ${actualToolName} in server ${client.serverConfig.name}`);
        return await client.callTool(actualToolName, args);
      }
    }
    throw new Error(`Tool not found: ${toolName}`);
  }

  /**
   * 获取运行中的服务器数量
   */
  getRunningCount() {
    return this.servers.size;
  }

  /**
   * 检查指定服务器是否正在运行
   * @param {string} serverId - Server ID
   */
  isServerRunning(serverId) {
    const client = this.servers.get(serverId);
    return client?.isConnected || false;
  }

  /**
   * 测试 MCP 服务器配置（不保存到数据库）
   * @param {Object} config - 服务器配置
   * @returns {Object} 测试结果
   */
  async testServerConfig(config) {
    console.log(`[MCPManager] Testing server config: ${config.name}`);
    
    // 创建临时客户端
    const testConfig = {
      ...config,
      _id: `test_${Date.now()}`,
      enabled: true,
    };
    
    const client = new MCPClient(testConfig);
    
    try {
      // 尝试连接，设置超时
      const connectPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout (15s)')), 15000);
      });
      
      await Promise.race([connectPromise, timeoutPromise]);
      
      // 获取工具列表
      const tools = client.getTools();
      const resources = client.getResources();
      const serverInfo = client.getServerInfo();
      
      // 断开连接
      await client.disconnect();
      
      return {
        success: true,
        message: 'Connection successful',
        serverInfo,
        toolCount: tools.length,
        resourceCount: resources.length,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
      };
    } catch (error) {
      // 确保清理
      try {
        await client.disconnect();
      } catch (e) {
        // 忽略清理错误
      }
      
      return {
        success: false,
        message: error.message || 'Connection failed',
        error: error.toString(),
      };
    }
  }
}

// 单例模式
const serverManager = new MCPServerManager();

module.exports = { serverManager, MCPServerManager };
