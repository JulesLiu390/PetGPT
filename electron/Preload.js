const { contextBridge, ipcRenderer, shell } = require("electron");
contextBridge.exposeInMainWorld('electron', {
  ping: () => 'pong',
  openExternal: (url) => shell.openExternal(url),
  // Expose settings interfaces
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (data) => ipcRenderer.invoke('update-settings', data),
  // 🐾 Pet 接口
  getPets: () => ipcRenderer.invoke('get-pets'),
  createPet: (data) => ipcRenderer.invoke('create-pet', data),
  updatePet: (id, updatedData) => ipcRenderer.invoke('update-pet', { id, updatedData }),
  deletePet: (id) => ipcRenderer.invoke('delete-pet', id),
  // getPetById: (id) => ipcRenderer.invoke('get-pet-by-id', id),
  getPet: (id) => ipcRenderer.invoke('get-pet-by-id', id),
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
  changeSelectCharacterWindow: () => ipcRenderer.send("change-selectCharacter-window"),
  sendMoodUpdate: (mood) => ipcRenderer.send('update-character-mood', mood),
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
  changeSettingsWindow: () => ipcRenderer.send("change-settings-window"),
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
});