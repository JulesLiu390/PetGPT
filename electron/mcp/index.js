/**
 * MCP Module Entry Point
 * 导出所有 MCP 相关模块
 */

const { MCPClient } = require('./client');
const { serverManager, MCPServerManager } = require('./serverManager');
const { registerMCPHandlers, initializeMCP, cleanupMCP } = require('./ipcHandlers');

module.exports = {
  // Client
  MCPClient,
  
  // Server Manager
  serverManager,
  MCPServerManager,
  
  // IPC Handlers
  registerMCPHandlers,
  initializeMCP,
  cleanupMCP,
};
