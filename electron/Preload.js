const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld('electron', {
  ping: () => 'pong',
  dragWindow: (deltaX, deltaY) => ipcRenderer.send('drag-window', { deltaX, deltaY }),
  hideChatWindow: () => ipcRenderer.send("hide-chat-window"),
  showChatWindow: () => ipcRenderer.send("show-chat-window"),
  changeChatWindow: () => ipcRenderer.send("change-chat-window"),

  changeAddCharacterWindow: () => ipcRenderer.send("change-addCharacter-window"),

  sendMoodUpdate: (mood) => ipcRenderer.send('update-character-mood', mood),
  onMoodUpdated: (callback) => ipcRenderer.on('character-mood-updated', callback),
});
