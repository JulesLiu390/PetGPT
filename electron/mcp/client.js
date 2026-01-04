/**
 * MCP Client - JSON-RPC 2.0 协议实现
 * 用于与 MCP Server 进行通信
 */

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const readline = require("readline");

/**
 * MCP Client 类
 * 实现 MCP 协议的 JSON-RPC 通信
 */
class MCPClient extends EventEmitter {
  constructor(serverConfig) {
    super();
    this.serverConfig = serverConfig;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timeout }
    this.serverCapabilities = null;
    this.serverInfo = null;
    this.isConnected = false;
    this.tools = [];
    this.resources = [];
    this.readlineInterface = null;
    this.outputBuffer = "";
  }

  /**
   * 启动 MCP Server 并建立连接
   */
  async connect() {
    if (this.isConnected) {
      console.log(`[MCP] Server ${this.serverConfig.name} already connected`);
      return;
    }

    const { command, args: rawArgs, env } = this.serverConfig;
    
    // 确保 args 是正确的数组格式
    // 如果 args 中的元素包含逗号或空格，需要再次拆分
    const args = (rawArgs || []).flatMap(arg => {
      // 如果参数包含逗号，按逗号拆分
      if (typeof arg === 'string' && arg.includes(',')) {
        return arg.split(',').map(s => s.trim()).filter(Boolean);
      }
      return arg;
    });

    console.log(`[MCP] Starting server: ${command} ${args.join(" ")}`);

    // 启动子进程
    this.process = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    // 处理 stdout - MCP 使用 JSON-RPC over stdio
    this.readlineInterface = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.readlineInterface.on("line", (line) => {
      this._handleLine(line);
    });

    // 处理 stderr - 用于日志
    this.process.stderr.on("data", (data) => {
      console.log(`[MCP][${this.serverConfig.name}][stderr] ${data.toString()}`);
    });

    // 处理进程错误
    this.process.on("error", (error) => {
      console.error(`[MCP] Process error:`, error);
      this.emit("error", error);
      this._cleanup();
    });

    // 处理进程退出
    this.process.on("exit", (code, signal) => {
      console.log(`[MCP] Process exited with code ${code}, signal ${signal}`);
      this.emit("disconnected", { code, signal });
      this._cleanup();
    });

    // 初始化 MCP 连接
    try {
      await this._initialize();
      this.isConnected = true;
      this.emit("connected", {
        serverInfo: this.serverInfo,
        capabilities: this.serverCapabilities,
      });
      console.log(`[MCP] Server ${this.serverConfig.name} connected successfully`);
    } catch (error) {
      console.error(`[MCP] Failed to initialize:`, error);
      this.disconnect();
      throw error;
    }
  }

  /**
   * 处理接收到的行数据
   */
  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const message = JSON.parse(trimmed);
      this._handleMessage(message);
    } catch (error) {
      console.error(`[MCP] Failed to parse message:`, trimmed, error);
    }
  }

  /**
   * 处理 JSON-RPC 消息
   */
  _handleMessage(message) {
    // 响应消息
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);
        
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // 通知消息 (no id, has method)
    if (message.method) {
      this._handleNotification(message);
    }
  }

  /**
   * 处理通知消息
   */
  _handleNotification(notification) {
    const { method, params } = notification;
    
    switch (method) {
      case "notifications/tools/list_changed":
        console.log(`[MCP] Tools list changed`);
        this._refreshTools();
        break;
      case "notifications/resources/list_changed":
        console.log(`[MCP] Resources list changed`);
        this._refreshResources();
        break;
      case "notifications/resources/updated":
        console.log(`[MCP] Resource updated:`, params);
        this.emit("resourceUpdated", params);
        break;
      default:
        console.log(`[MCP] Unknown notification:`, method);
    }
    
    this.emit("notification", notification);
  }

  /**
   * 发送 JSON-RPC 请求
   */
  async _sendRequest(method, params = {}) {
    if (!this.process || this.process.killed) {
      throw new Error("MCP Server not running");
    }

    const id = ++this.requestId;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000); // 30 秒超时

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message);
    });
  }

  /**
   * 发送通知 (无需响应)
   */
  _sendNotification(method, params = {}) {
    if (!this.process || this.process.killed) {
      console.error("[MCP] Cannot send notification - server not running");
      return;
    }

    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const message = JSON.stringify(notification) + "\n";
    this.process.stdin.write(message);
  }

  /**
   * MCP 初始化握手
   */
  async _initialize() {
    const result = await this._sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      clientInfo: {
        name: "PetGPT",
        version: "1.0.0",
      },
    });

    this.serverCapabilities = result.capabilities || {};
    this.serverInfo = result.serverInfo || {};

    // 发送 initialized 通知
    this._sendNotification("notifications/initialized");

    // 获取可用的工具和资源
    await this._refreshTools();
    await this._refreshResources();

    return result;
  }

  /**
   * 刷新工具列表
   */
  async _refreshTools() {
    if (!this.serverCapabilities.tools) {
      this.tools = [];
      return;
    }

    try {
      const result = await this._sendRequest("tools/list");
      this.tools = result.tools || [];
      this.emit("toolsUpdated", this.tools);
      console.log(`[MCP] Tools:`, this.tools.map(t => t.name));
    } catch (error) {
      console.error(`[MCP] Failed to list tools:`, error);
      this.tools = [];
    }
  }

  /**
   * 刷新资源列表
   */
  async _refreshResources() {
    if (!this.serverCapabilities.resources) {
      this.resources = [];
      return;
    }

    try {
      const result = await this._sendRequest("resources/list");
      this.resources = result.resources || [];
      this.emit("resourcesUpdated", this.resources);
      console.log(`[MCP] Resources:`, this.resources.map(r => r.uri));
    } catch (error) {
      console.error(`[MCP] Failed to list resources:`, error);
      this.resources = [];
    }
  }

  /**
   * 调用工具
   * @param {string} name - 工具名称
   * @param {Object} args - 工具参数
   * @returns {Promise<Object>} 工具执行结果
   */
  async callTool(name, args = {}) {
    if (!this.isConnected) {
      throw new Error("MCP Server not connected");
    }

    console.log(`[MCP] Calling tool: ${name}`, args);
    
    const result = await this._sendRequest("tools/call", {
      name,
      arguments: args,
    });

    console.log(`[MCP] Tool result:`, result);
    return result;
  }

  /**
   * 读取资源
   * @param {string} uri - 资源 URI
   * @returns {Promise<Object>} 资源内容
   */
  async readResource(uri) {
    if (!this.isConnected) {
      throw new Error("MCP Server not connected");
    }

    console.log(`[MCP] Reading resource: ${uri}`);
    
    const result = await this._sendRequest("resources/read", { uri });
    return result;
  }

  /**
   * 获取可用工具列表
   * @returns {Array} 工具列表
   */
  getTools() {
    return this.tools;
  }

  /**
   * 获取可用资源列表
   * @returns {Array} 资源列表
   */
  getResources() {
    return this.resources;
  }

  /**
   * 获取服务器信息
   */
  getServerInfo() {
    return {
      info: this.serverInfo,
      capabilities: this.serverCapabilities,
      isConnected: this.isConnected,
      tools: this.tools,
      resources: this.resources,
    };
  }

  /**
   * 断开连接
   */
  disconnect() {
    console.log(`[MCP] Disconnecting server: ${this.serverConfig.name}`);
    this._cleanup();
  }

  /**
   * 清理资源
   */
  _cleanup() {
    this.isConnected = false;
    
    // 清理所有待处理的请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    // 关闭 readline
    if (this.readlineInterface) {
      this.readlineInterface.close();
      this.readlineInterface = null;
    }

    // 终止进程
    if (this.process && !this.process.killed) {
      this.process.kill();
      this.process = null;
    }

    this.tools = [];
    this.resources = [];
  }
}

module.exports = { MCPClient };
