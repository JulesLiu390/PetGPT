/**
 * MCP IPC Handlers
 * 处理前端与 MCP 系统的通信
 */

const { ipcMain, BrowserWindow } = require("electron");
const { serverManager } = require("./serverManager");
const mcpConfig = require("../models/mcp_config");

/**
 * 广播 MCP 服务器更新事件到所有窗口
 */
function broadcastMcpServersUpdated() {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('mcp-servers-updated');
  });
}

/**
 * 注册所有 MCP 相关的 IPC handlers
 */
function registerMCPHandlers() {
  console.log("[MCP IPC] Registering handlers...");

  // ==================== Server Configuration CRUD ====================

  /**
   * 获取所有 MCP server 配置
   */
  ipcMain.handle("mcp:getServers", async () => {
    try {
      const servers = await mcpConfig.getAllServers();
      // 附加运行状态
      return servers.map(server => ({
        ...server,
        isRunning: serverManager.isServerRunning(server._id),
      }));
    } catch (error) {
      console.error("[MCP IPC] getServers error:", error);
      throw error;
    }
  });

  /**
   * 获取单个 MCP server 配置
   */
  ipcMain.handle("mcp:getServer", async (event, serverId) => {
    try {
      const server = await mcpConfig.getServerById(serverId);
      if (server) {
        server.isRunning = serverManager.isServerRunning(serverId);
      }
      return server;
    } catch (error) {
      console.error("[MCP IPC] getServer error:", error);
      throw error;
    }
  });

  /**
   * 创建新的 MCP server 配置
   */
  ipcMain.handle("mcp:createServer", async (event, config) => {
    try {
      const server = await mcpConfig.createServer(config);
      console.log("[MCP IPC] Created server:", server.name);
      broadcastMcpServersUpdated();
      return server;
    } catch (error) {
      console.error("[MCP IPC] createServer error:", error);
      throw error;
    }
  });

  /**
   * 更新 MCP server 配置
   */
  ipcMain.handle("mcp:updateServer", async (event, { serverId, updates }) => {
    try {
      // 如果服务器正在运行，先停止
      if (serverManager.isServerRunning(serverId)) {
        await serverManager.stopServer(serverId);
      }
      const server = await mcpConfig.updateServer(serverId, updates);
      console.log("[MCP IPC] Updated server:", server?.name);
      broadcastMcpServersUpdated();
      return server;
    } catch (error) {
      console.error("[MCP IPC] updateServer error:", error);
      throw error;
    }
  });

  /**
   * 删除 MCP server 配置
   */
  ipcMain.handle("mcp:deleteServer", async (event, serverId) => {
    try {
      // 先停止服务器
      if (serverManager.isServerRunning(serverId)) {
        await serverManager.stopServer(serverId);
      }
      const result = await mcpConfig.deleteServer(serverId);
      console.log("[MCP IPC] Deleted server:", serverId);
      broadcastMcpServersUpdated();
      return result;
    } catch (error) {
      console.error("[MCP IPC] deleteServer error:", error);
      throw error;
    }
  });
  
  /**
   * 根据名称更新 MCP server 配置 (用于工具栏)
   */
  ipcMain.handle("mcp:updateServerByName", async (event, { serverName, updates }) => {
    try {
      // 先查找服务器
      const existingServer = await mcpConfig.getServerByName(serverName);
      if (existingServer && serverManager.isServerRunning(existingServer._id)) {
        await serverManager.stopServer(existingServer._id);
      }
      const server = await mcpConfig.updateServerByName(serverName, updates);
      console.log("[MCP IPC] Updated server by name:", serverName, updates);
      broadcastMcpServersUpdated();
      return server;
    } catch (error) {
      console.error("[MCP IPC] updateServerByName error:", error);
      throw error;
    }
  });

  /**
   * 根据名称删除 MCP server 配置 (用于工具栏)
   */
  ipcMain.handle("mcp:deleteServerByName", async (event, serverName) => {
    try {
      // 先查找并停止服务器
      const existingServer = await mcpConfig.getServerByName(serverName);
      if (existingServer && serverManager.isServerRunning(existingServer._id)) {
        await serverManager.stopServer(existingServer._id);
      }
      const result = await mcpConfig.deleteServerByName(serverName);
      console.log("[MCP IPC] Deleted server by name:", serverName);
      broadcastMcpServersUpdated();
      return result;
    } catch (error) {
      console.error("[MCP IPC] deleteServerByName error:", error);
      throw error;
    }
  });

  /**
   * 切换 server 启用状态
   */
  ipcMain.handle("mcp:toggleServerEnabled", async (event, serverId) => {
    try {
      const server = await mcpConfig.toggleServerEnabled(serverId);
      // 如果禁用了正在运行的服务器，停止它
      if (!server.enabled && serverManager.isServerRunning(serverId)) {
        await serverManager.stopServer(serverId);
      }
      return server;
    } catch (error) {
      console.error("[MCP IPC] toggleServerEnabled error:", error);
      throw error;
    }
  });

  // ==================== Server Lifecycle Management ====================

  /**
   * 启动 MCP server
   */
  ipcMain.handle("mcp:startServer", async (event, serverId) => {
    try {
      const info = await serverManager.startServer(serverId);
      console.log("[MCP IPC] Started server:", serverId);
      return info;
    } catch (error) {
      console.error("[MCP IPC] startServer error:", error);
      throw error;
    }
  });

  /**
   * 停止 MCP server
   */
  ipcMain.handle("mcp:stopServer", async (event, serverId) => {
    try {
      await serverManager.stopServer(serverId);
      console.log("[MCP IPC] Stopped server:", serverId);
      return { success: true };
    } catch (error) {
      console.error("[MCP IPC] stopServer error:", error);
      throw error;
    }
  });

  /**
   * 重启 MCP server
   */
  ipcMain.handle("mcp:restartServer", async (event, serverId) => {
    try {
      const info = await serverManager.restartServer(serverId);
      console.log("[MCP IPC] Restarted server:", serverId);
      return info;
    } catch (error) {
      console.error("[MCP IPC] restartServer error:", error);
      throw error;
    }
  });

  /**
   * 获取服务器状态
   */
  ipcMain.handle("mcp:getServerStatus", async (event, serverId) => {
    try {
      return serverManager.getServerStatus(serverId);
    } catch (error) {
      console.error("[MCP IPC] getServerStatus error:", error);
      throw error;
    }
  });

  /**
   * 获取所有服务器状态
   */
  ipcMain.handle("mcp:getAllServerStatus", async () => {
    try {
      return serverManager.getAllServerStatus();
    } catch (error) {
      console.error("[MCP IPC] getAllServerStatus error:", error);
      throw error;
    }
  });

  // ==================== Tools & Resources ====================

  /**
   * 获取所有可用工具
   */
  ipcMain.handle("mcp:getAllTools", async () => {
    try {
      return serverManager.getAllTools();
    } catch (error) {
      console.error("[MCP IPC] getAllTools error:", error);
      throw error;
    }
  });

  /**
   * 获取所有可用资源
   */
  ipcMain.handle("mcp:getAllResources", async () => {
    try {
      return serverManager.getAllResources();
    } catch (error) {
      console.error("[MCP IPC] getAllResources error:", error);
      throw error;
    }
  });

  /**
   * 调用工具
   */
  ipcMain.handle("mcp:callTool", async (event, { serverId, toolName, args }) => {
    try {
      console.log("[MCP IPC] Calling tool:", toolName, "on server:", serverId);
      const result = await serverManager.callTool(serverId, toolName, args);
      return result;
    } catch (error) {
      console.error("[MCP IPC] callTool error:", error);
      throw error;
    }
  });

  /**
   * 根据工具名称调用工具（自动路由）
   */
  ipcMain.handle("mcp:callToolByName", async (event, { toolName, args }) => {
    try {
      console.log("[MCP IPC] Calling tool by name:", toolName);
      const result = await serverManager.callToolByName(toolName, args);
      return result;
    } catch (error) {
      console.error("[MCP IPC] callToolByName error:", error);
      throw error;
    }
  });

  /**
   * 读取资源
   */
  ipcMain.handle("mcp:readResource", async (event, { serverId, uri }) => {
    try {
      console.log("[MCP IPC] Reading resource:", uri, "from server:", serverId);
      const result = await serverManager.readResource(serverId, uri);
      return result;
    } catch (error) {
      console.error("[MCP IPC] readResource error:", error);
      throw error;
    }
  });

  // ==================== Manager Status ====================

  /**
   * 获取运行中的服务器数量
   */
  ipcMain.handle("mcp:getRunningCount", async () => {
    try {
      return serverManager.getRunningCount();
    } catch (error) {
      console.error("[MCP IPC] getRunningCount error:", error);
      throw error;
    }
  });

  /**
   * 测试 MCP 服务器配置（不保存，只验证连接）
   */
  ipcMain.handle("mcp:testServer", async (event, config) => {
    try {
      console.log("[MCP IPC] Testing server config:", config.name);
      const result = await serverManager.testServerConfig(config);
      console.log("[MCP IPC] Test result:", result);
      return result;
    } catch (error) {
      console.error("[MCP IPC] testServer error:", error);
      // 返回错误对象而不是抛出，确保前端能正确接收
      return {
        success: false,
        message: error.message || 'Connection failed',
        error: error.toString(),
      };
    }
  });

  console.log("[MCP IPC] All handlers registered");
}

/**
 * 初始化 MCP 系统
 */
async function initializeMCP() {
  console.log("[MCP] Initializing MCP system...");
  
  // 注册 IPC handlers
  registerMCPHandlers();
  
  // 初始化服务器管理器（启动自动启动的服务器）
  try {
    await serverManager.initialize();
    console.log("[MCP] MCP system initialized");
  } catch (error) {
    console.error("[MCP] Failed to initialize MCP system:", error);
  }
}

/**
 * 清理 MCP 系统（应用退出时调用）
 */
async function cleanupMCP() {
  console.log("[MCP] Cleaning up MCP system...");
  await serverManager.stopAll();
  console.log("[MCP] MCP system cleaned up");
}

module.exports = {
  registerMCPHandlers,
  initializeMCP,
  cleanupMCP,
};
