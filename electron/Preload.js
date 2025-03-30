const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld('electron', {
  ping: () => 'pong',

  // getConversations: () => ipcRenderer.invoke('get-conversations'),

  // writeJSON: (data) => ipcRenderer.invoke('write-json', data),

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
  
    // ⚡ 其他事件发送
    sendCharacterId: (id) => ipcRenderer.send('send-character-id', id),
    // sendCharacterId: (id) => ipcRenderer.send('send-character-id', id),
    onCharacterId: (callback) => ipcRenderer.on('character-id', (event, id) => callback(id)),
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
  onCharacterId: (callback) => ipcRenderer.on('character-id', (event, id) => callback(id)),


  sendConversationId: (id) => ipcRenderer.send('conversation-id', id),
  onConversationId: (callback) => ipcRenderer.on('conversation-id', (event, id) => callback(id)),



  processImage: (base64Image, baseFilename) => ipcRenderer.invoke('process-image', base64Image),
  onProcessImageResult: (callback) => ipcRenderer.on('process-image-result', (event, filePaths) => callback(filePaths)),

  readPetImage: (fileName) => ipcRenderer.invoke('read-pet-image', fileName)
});