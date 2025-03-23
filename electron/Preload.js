const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld('electron', {
  ping: () => 'pong',
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
});