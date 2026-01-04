/**
 * MCP Server Configuration Model
 * 存储和管理 MCP server 配置
 * 使用 JSON 文件存储（与项目其他模型一致）
 */

const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

// 保存路径：Documents/PetGPT_Data/mcp_servers.json
const filename = 'mcp_servers.json';
const filePath = path.join(app.getPath('documents') + '/PetGPT_Data', filename);

/**
 * 读取 JSON 数据
 */
async function readData() {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * 写入 JSON 数据
 */
async function writeData(data) {
  // 确保目录存在
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // 目录已存在，忽略
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * MCP Server 配置结构
 * @typedef {Object} MCPServerConfig
 * @property {string} _id - 唯一标识符
 * @property {string} name - 服务器显示名称
 * @property {string} command - 启动命令 (如 "npx", "node", "python")
 * @property {string[]} args - 命令参数 (如 ["-y", "@modelcontextprotocol/server-filesystem"])
 * @property {Object} env - 环境变量
 * @property {boolean} enabled - 是否启用（发送给LLM）
 * @property {boolean} autoStart - 是否自动启动
 * @property {string} description - 描述
 * @property {string} icon - 图标 (emoji 或 react-icons 名称，如 "🔍" 或 "FaSearch")
 * @property {boolean} showInToolbar - 是否在工具栏显示
 * @property {number} toolbarOrder - 工具栏显示顺序
 * @property {Date} createdAt - 创建时间
 * @property {Date} updatedAt - 更新时间
 */

/**
 * 获取所有 MCP server 配置
 * @returns {Promise<MCPServerConfig[]>}
 */
async function getAllServers() {
  const servers = await readData();
  return servers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * 获取所有已启用的 MCP server 配置
 * @returns {Promise<MCPServerConfig[]>}
 */
async function getEnabledServers() {
  const servers = await readData();
  return servers
    .filter(s => s.enabled)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * 根据 ID 获取 MCP server 配置
 * @param {string} id
 * @returns {Promise<MCPServerConfig|null>}
 */
async function getServerById(id) {
  const servers = await readData();
  return servers.find(s => s._id === id) || null;
}

/**
 * 根据名称获取 MCP server 配置
 * @param {string} name
 * @returns {Promise<MCPServerConfig|null>}
 */
async function getServerByName(name) {
  const servers = await readData();
  return servers.find(s => s.name === name) || null;
}

/**
 * 创建新的 MCP server 配置
 * @param {Partial<MCPServerConfig>} config
 * @returns {Promise<MCPServerConfig>}
 */
async function createServer(config) {
  const servers = await readData();
  
  // 检查名称是否已存在
  if (servers.some(s => s.name === config.name)) {
    throw new Error(`Server with name "${config.name}" already exists`);
  }
  
  const now = new Date().toISOString();
  const newConfig = {
    _id: uuidv4(),
    name: config.name || "Unnamed Server",
    command: config.command || "",
    args: config.args || [],
    env: config.env || {},
    enabled: config.enabled !== false,
    autoStart: config.autoStart || false,
    description: config.description || "",
    icon: config.icon || "🔧",  // 默认图标
    showInToolbar: config.showInToolbar !== false,  // 默认显示在工具栏
    toolbarOrder: config.toolbarOrder ?? 0,  // 工具栏顺序
    createdAt: now,
    updatedAt: now,
  };
  
  servers.push(newConfig);
  await writeData(servers);
  return newConfig;
}

/**
 * 更新 MCP server 配置
 * @param {string} id
 * @param {Partial<MCPServerConfig>} updates
 * @returns {Promise<MCPServerConfig|null>}
 */
async function updateServer(id, updates) {
  const servers = await readData();
  const index = servers.findIndex(s => s._id === id);
  
  if (index === -1) return null;
  
  const updateData = {
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  delete updateData._id; // 不允许更新 _id
  delete updateData.createdAt; // 不允许更新创建时间
  
  servers[index] = { ...servers[index], ...updateData };
  await writeData(servers);
  return servers[index];
}

/**
 * 删除 MCP server 配置
 * @param {string} id
 * @returns {Promise<number>} 删除的文档数量
 */
async function deleteServer(id) {
  const servers = await readData();
  const initialLength = servers.length;
  const filtered = servers.filter(s => s._id !== id);
  
  if (filtered.length < initialLength) {
    await writeData(filtered);
    return 1;
  }
  return 0;
}

/**
 * 根据名称更新 MCP server 配置
 * @param {string} name
 * @param {Partial<MCPServerConfig>} updates
 * @returns {Promise<MCPServerConfig|null>}
 */
async function updateServerByName(name, updates) {
  const servers = await readData();
  const index = servers.findIndex(s => s.name === name);
  
  if (index === -1) return null;
  
  const updateData = {
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  delete updateData._id;
  delete updateData.createdAt;
  
  servers[index] = { ...servers[index], ...updateData };
  await writeData(servers);
  return servers[index];
}

/**
 * 根据名称删除 MCP server 配置
 * @param {string} name
 * @returns {Promise<number>} 删除的文档数量
 */
async function deleteServerByName(name) {
  const servers = await readData();
  const initialLength = servers.length;
  const filtered = servers.filter(s => s.name !== name);
  
  if (filtered.length < initialLength) {
    await writeData(filtered);
    return 1;
  }
  return 0;
}

/**
 * 切换 server 启用状态
 * @param {string} id
 * @returns {Promise<MCPServerConfig|null>}
 */
async function toggleServerEnabled(id) {
  const server = await getServerById(id);
  if (!server) return null;
  
  return await updateServer(id, { enabled: !server.enabled });
}

/**
 * 获取自动启动的 servers
 * @returns {Promise<MCPServerConfig[]>}
 */
async function getAutoStartServers() {
  const servers = await readData();
  return servers.filter(s => s.enabled && s.autoStart);
}

module.exports = {
  getAllServers,
  getEnabledServers,
  getServerById,
  getServerByName,
  createServer,
  updateServer,
  updateServerByName,
  deleteServer,
  deleteServerByName,
  toggleServerEnabled,
  getAutoStartServers,
};
