const { contextBridge, ipcRenderer, shell } = require("electron");
contextBridge.exposeInMainWorld('electron', {
  ping: () => 'pong',
  openExternal: (url) => shell.openExternal(url),
  // Expose settings interfaces
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (data) => ipcRenderer.invoke('update-settings', data),
  // 🐾 Pet 接口 (保留兼容)
  getPets: () => ipcRenderer.invoke('get-pets'),
  createPet: (data) => ipcRenderer.invoke('create-pet', data),
  updatePet: (id, updatedData) => ipcRenderer.invoke('update-pet', { id, updatedData }),
  deletePet: (id) => ipcRenderer.invoke('delete-pet', id),
  // getPetById: (id) => ipcRenderer.invoke('get-pet-by-id', id),
  getPet: (id) => ipcRenderer.invoke('get-pet-by-id', id),
  
  // 🔧 ModelConfig 接口 (新)
  getModelConfigs: () => ipcRenderer.invoke('get-model-configs'),
  createModelConfig: (data) => ipcRenderer.invoke('create-model-config', data),
  updateModelConfig: (id, updatedData) => ipcRenderer.invoke('update-model-config', { id, updatedData }),
  deleteModelConfig: (id) => ipcRenderer.invoke('delete-model-config', id),
  getModelConfig: (id) => ipcRenderer.invoke('get-model-config-by-id', id),
  
  // 🤖 Assistant 接口 (新)
  getAssistants: () => ipcRenderer.invoke('get-assistants'),
  createAssistant: (data) => ipcRenderer.invoke('create-assistant', data),
  updateAssistant: (id, updatedData) => ipcRenderer.invoke('update-assistant', { id, updatedData }),
  deleteAssistant: (id) => ipcRenderer.invoke('delete-assistant', id),
  getAssistant: (id) => ipcRenderer.invoke('get-assistant-by-id', id),
  // 💬 Conversation 接口
  getConversations: () => ipcRenderer.invoke('get-conversations'),
  createConversation: (data) => ipcRenderer.invoke('create-conversation', data),
  updateConversation: (id, updatedData) => ipcRenderer.invoke('update-conversation', { id, updatedData }),
  deleteConversation: (id) => ipcRenderer.invoke('delete-conversation', id),
  getConversationById: (id) => ipcRenderer.invoke('get-conversation-by-id', id),
  // 🧠 PetUserMemory 接口
  getPetUserMemory: (petId) => ipcRenderer.invoke('get-pet-user-memory', petId),
  setPetUserMemory: (petId, memoryData) => ipcRenderer.invoke('set-pet-user-memory', { petId, memoryData }),
  updatePetUserMemory: (petId, key, value) => ipcRenderer.invoke('update-pet-user-memory', { petId, key, value }),
  deletePetUserMemoryKey: (petId, key) => ipcRenderer.invoke('delete-pet-user-memory-key', { petId, key }),
  getPetUserMemoryValue: (petId, key) => ipcRenderer.invoke('get-pet-user-memory-value', { petId, key }),
  // ⚡ 其他事件发送
  // sendCharacterId: (id) => ipcRenderer.send('send-character-id', id),
  // onCharacterId: (callback) => ipcRenderer.on('character-id', (event, id) => callback(id)),
  sendConversationId: (id) => ipcRenderer.send('send-conversation-id', id),
  dragWindow: (deltaX, deltaY) => ipcRenderer.send('drag-window', { deltaX, deltaY }),
  hideChatWindow: () => ipcRenderer.send("hide-chat-window"),
  showChatWindow: () => ipcRenderer.send("show-chat-window"),
  changeChatWindow: () => ipcRenderer.send("change-chat-window"),
  changeAddCharacterWindow: () => ipcRenderer.send("change-addCharacter-window"),
  hideAddCharacterWindow: () => ipcRenderer.send("hide-addCharacter-window"),
  changeSelectCharacterWindow: () => ipcRenderer.send("change-selectCharacter-window"),
  hideSelectCharacterWindow: () => ipcRenderer.send("hide-selectCharacter-window"),
  sendMoodUpdate: (mood, conversationId) => ipcRenderer.send('update-character-mood', mood, conversationId),
  onMoodUpdated: (callback) => ipcRenderer.on('character-mood-updated', callback),
  sendPetsUpdate: (mood) => ipcRenderer.send('update-pets', mood),
  onPetsUpdated: (callback) => ipcRenderer.on('pets-updated', callback),
  maxmizeChatWindow: () => ipcRenderer.send("maximize-chat-window"),
  sendCharacterId: (id) => ipcRenderer.send('character-id', id),
  onCharacterId: (callback) => {
    const subscription = (event, id) => callback(id);
    ipcRenderer.on('character-id', subscription);
    return () => ipcRenderer.removeListener('character-id', subscription);
  },
  sendConversationId: (id) => ipcRenderer.send('conversation-id', id),
  onConversationId: (callback) => ipcRenderer.on('conversation-id', (event, id) => callback(id)),
  processImage: (base64Image, baseFilename) => ipcRenderer.invoke('process-image', base64Image),
  onProcessImageResult: (callback) => ipcRenderer.on('process-image-result', (event, filePaths) => callback(filePaths)),
  readPetImage: (fileName) => ipcRenderer.invoke('read-pet-image', fileName),
  saveFile: (data) => ipcRenderer.invoke('save-file', data),
  readUpload: (fileName) => ipcRenderer.invoke('read-upload', fileName),
  extractDocumentText: (fileName) => ipcRenderer.invoke('extract-document-text', fileName),
  openFileExternal: (filePath) => ipcRenderer.invoke('open-file-external', filePath),
  probeOpenAICompatibleEndpoints: (options) => ipcRenderer.invoke('probe-openai-compatible-endpoints', options),
  changeSettingsWindow: () => ipcRenderer.send("change-settings-window"),
  changeMcpWindow: () => ipcRenderer.send("change-mcp-window"),
  testOpen: (command) => ipcRenderer.send("say-hello", command),
  updateWindowSizePreset: async (preset) => ipcRenderer.invoke('update-window-size-preset', preset),
  updateShortcuts: (shortcut1, shortcut2) => ipcRenderer.invoke('update-shortcuts', { shortcut1, shortcut2 }),
  
  onChatbodyStatusUpdated: (callback) => {
    ipcRenderer.on('chatbody-status-updated', (event, status) => {
      callback(status);
    });
  },
  updateChatbodyStatus: (status) => {
    ipcRenderer.send('update-chatbody-status', status);
  },

  createNewChat: (chat) => ipcRenderer.send('new-chat', chat),
  onNewChatCreated: (callback) => {
    const subscription = (event, chat) => callback(chat);
    ipcRenderer.on('new-chat-created', subscription);
    return () => ipcRenderer.removeListener('new-chat-created', subscription);
  },
  onWindowMaximized: (callback) => ipcRenderer.on('window-maximized', callback),
  onWindowUnmaximized: (callback) => ipcRenderer.on('window-unmaximized', callback),
  
  // 侧边栏展开/收起 - 窗口向外扩展
  toggleSidebar: (open) => ipcRenderer.send('toggle-sidebar', open),

  // ==================== MCP (Model Context Protocol) 接口 ====================
  
  // Server 配置管理
  mcp: {
    // 获取所有 MCP server 配置
    getServers: () => ipcRenderer.invoke('mcp:getServers'),
    listServers: () => ipcRenderer.invoke('mcp:getServers'),  // 别名，用于工具栏
    // 获取单个 server 配置
    getServer: (serverId) => ipcRenderer.invoke('mcp:getServer', serverId),
    // 创建新的 server 配置
    createServer: (config) => ipcRenderer.invoke('mcp:createServer', config),
    // 更新 server 配置 (按 ID)
    updateServer: (serverId, updates) => ipcRenderer.invoke('mcp:updateServer', { serverId, updates }),
    // 更新 server 配置 (按名称，用于工具栏)
    updateServerByName: (serverName, updates) => ipcRenderer.invoke('mcp:updateServerByName', { serverName, updates }),
    // 删除 server 配置 (按 ID)
    deleteServer: (serverId) => ipcRenderer.invoke('mcp:deleteServer', serverId),
    // 删除 server 配置 (按名称，用于工具栏)
    deleteServerByName: (serverName) => ipcRenderer.invoke('mcp:deleteServerByName', serverName),
    // 切换 server 启用状态
    toggleServerEnabled: (serverId) => ipcRenderer.invoke('mcp:toggleServerEnabled', serverId),
    
    // Server 生命周期管理
    startServer: (serverId) => ipcRenderer.invoke('mcp:startServer', serverId),
    stopServer: (serverId) => ipcRenderer.invoke('mcp:stopServer', serverId),
    restartServer: (serverId) => ipcRenderer.invoke('mcp:restartServer', serverId),
    getServerStatus: (serverId) => ipcRenderer.invoke('mcp:getServerStatus', serverId),
    getAllServerStatus: () => ipcRenderer.invoke('mcp:getAllServerStatus'),
    getRunningCount: () => ipcRenderer.invoke('mcp:getRunningCount'),
    
    // 工具和资源
    getAllTools: () => ipcRenderer.invoke('mcp:getAllTools'),
    getAllResources: () => ipcRenderer.invoke('mcp:getAllResources'),
    callTool: (serverId, toolName, args) => ipcRenderer.invoke('mcp:callTool', { serverId, toolName, args }),
    callToolByName: (toolName, args) => ipcRenderer.invoke('mcp:callToolByName', { toolName, args }),
    readResource: (serverId, uri) => ipcRenderer.invoke('mcp:readResource', { serverId, uri }),
    
    // 测试服务器配置
    testServer: (config) => ipcRenderer.invoke('mcp:testServer', config),
    
    // 监听服务器列表更新事件
    onServersUpdated: (callback) => {
      const subscription = () => callback();
      ipcRenderer.on('mcp-servers-updated', subscription);
      return () => ipcRenderer.removeListener('mcp-servers-updated', subscription);
    },
  },
});