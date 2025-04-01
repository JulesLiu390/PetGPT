const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require("electron");
const path = require('path');
const fs = require('fs');
const Pet = require('./models/pet');
const Conversation = require('./models/conversation.js');
const { sliceImageToFiles } = require('./models/image_processor.js');

let chatWindow;
let characterWindow;
let AddCharacterWindow;
let selectCharacterWindow;
let settingsWindow;
let screenHeight = 0;

let sharedState = {
  characterMood: 'neutral'
};

// ============ IPC handlers ============ //

// 读取图片
ipcMain.handle('read-pet-image', async (event, fileName) => {
  try {
    const documentsPath = app.getPath('documents');
    const imagePath = path.join(documentsPath, 'PetGPT_Data', 'Images', fileName);
    if (!fs.existsSync(imagePath)) throw new Error(`File does not exist: ${imagePath}`);
    const buffer = fs.readFileSync(imagePath);
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('读取图片错误:', err);
    throw err;
  }
});

// 处理图片
ipcMain.handle('process-image', async (event, base64Image) => {
  try {
    return await sliceImageToFiles(base64Image);
  } catch (err) {
    console.error('图片处理出错:', err);
    throw err;
  }
});

// Pet 相关
ipcMain.handle('get-pets', async () => await Pet.findAll());
ipcMain.handle('create-pet', async (event, data) => await Pet.create(data));
ipcMain.handle('update-pet', async (event, { id, updatedData }) => await Pet.update(id, updatedData));
ipcMain.handle('delete-pet', async (event, id) => await Pet.delete(id));
ipcMain.handle('get-pet-by-id', async (event, id) => {
  try {
    return await Pet.findById(id);
  } catch (err) {
    console.error("Failed to get pet by id:", err);
    throw err;
  }
});

// Conversation 相关
ipcMain.handle('get-conversations', async () => await Conversation.findAll());
ipcMain.handle('create-conversation', async (event, data) => await Conversation.create(data));
ipcMain.handle('update-conversation', async (event, { id, updatedData }) => await Conversation.update(id, updatedData));
ipcMain.handle('delete-conversation', async (event, id) => await Conversation.delete(id));
ipcMain.handle('get-conversation-by-id', async (event, id) => await Conversation.findById(id));

// IPC 通信
ipcMain.on('send-character-id', (event, id) => {
  console.log("Main received character ID:", id);
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('character-id', id));
});

ipcMain.on('send-conversation-id', (event, id) => {
  console.log('[主进程] 当前会话 ID:', id);
});

// Mood 更新
ipcMain.on('update-character-mood', (event, mood) => {
  console.log("Received mood update:", mood);
  sharedState.characterMood = mood;
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('character-mood-updated', mood));
});

ipcMain.on('update-pets', () => {
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('pets-updated', "pets updated"));
});

ipcMain.on('character-id', (event, id) => {
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('character-id', id));
});

ipcMain.on('conversation-id', (event, id) => {
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('conversation-id', id));
});

// 拖拽移动窗口
ipcMain.on('drag-window', (event, { deltaX, deltaY }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const [x, y] = win.getPosition();
    win.setPosition(x + deltaX, y + deltaY);
  }
});

// 窗口显示/隐藏控制
ipcMain.on("hide-chat-window", () => chatWindow?.hide());
ipcMain.on("show-chat-window", () => chatWindow?.show());

ipcMain.on("change-chat-window", () => {
  if (!chatWindow) return;
  if (chatWindow.isVisible()) {
    chatWindow.unmaximize();
    chatWindow.hide();
  } else {
    chatWindow.show();
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }
});

ipcMain.on("change-addCharacter-window", () => {
  if (!AddCharacterWindow || !characterWindow) return;
  if (AddCharacterWindow.isVisible()) {
    AddCharacterWindow.hide();
  } else {
    const { x, y } = characterWindow.getBounds();
    AddCharacterWindow.setBounds({ x, y: y - 450, width: 600, height: 450 });
    AddCharacterWindow.show();
    AddCharacterWindow.focus();
  }
});

ipcMain.on("change-selectCharacter-window", () => {
  if (!selectCharacterWindow || !characterWindow) return;
  if (selectCharacterWindow.isVisible()) {
    selectCharacterWindow.hide();
  } else {
    const { x, y } = characterWindow.getBounds();
    selectCharacterWindow.setBounds({ x, y: y - 400, width: 500, height: 400 });
    selectCharacterWindow.show();
    selectCharacterWindow.focus();
  }
});

// ✅ 新增：切换 SettingsWindow
ipcMain.on("change-settings-window", () => {
  if (!settingsWindow || !characterWindow) return;
  if (settingsWindow.isVisible()) {
    settingsWindow.hide();
  } else {
    // const { x, y } = characterWindow.getBounds();
    settingsWindow.setBounds({ x:0, y:0, width: 600, height: 600 });
    settingsWindow.show();
    settingsWindow.focus();
  }
});

// 最大化 chat 窗口
ipcMain.on("maximize-chat-window", () => {
  if (!chatWindow) return;
  if (chatWindow.isMaximized()) {
    chatWindow.unmaximize();
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  } else {
    chatWindow.maximize();
    chatWindow.setVisibleOnAllWorkspaces(false);
  }
});

// ============ 创建窗口函数们 ============ //
const createcharacterWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  characterWindow = new BrowserWindow({
    width: 200,
    height: 300,
    x: width - 220,  // 500 是窗口宽度
    y: height - 310, // 400 是窗口高度
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  characterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/character' });
  characterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  characterWindow.on("closed", () => { characterWindow = null; });
};

const createChatWindow = () => {
  if (!characterWindow) return;
  const charBounds = characterWindow.getBounds();
  chatWindow = new BrowserWindow({
    x: charBounds.x - 400 - 20,
    y: charBounds.y - 350 + charBounds.height,
    width: 400,
    height: 350,
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: true,
    vibrancy: "ultra-dark",
    visualEffectState: "active",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  chatWindow.setAlwaysOnTop(true, 'floating');
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  chatWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  chatWindow.on("closed", () => { chatWindow = null; });
};

const createAddCharacterWindow = () => {
  AddCharacterWindow = new BrowserWindow({
    width: 600,
    height: 450,
    show: false,
    x: 500,
    y: screenHeight - 700,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  AddCharacterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/addCharacter' });
  AddCharacterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  AddCharacterWindow.on("closed", () => { AddCharacterWindow = null; });
};

const createSelectCharacterWindow = () => {
  selectCharacterWindow = new BrowserWindow({
    width: 500,
    height: 400,
    show: false,
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  selectCharacterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/selectCharacter' });
  selectCharacterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  selectCharacterWindow.on("closed", () => { selectCharacterWindow = null; });
};

// ✅ 新增：SettingsWindow
const createSettingsWindow = () => {
  settingsWindow = new BrowserWindow({
    width: 600,
    height: 800,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/settings' });
  settingsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  settingsWindow.on("closed", () => { settingsWindow = null; });
};

// ============ App lifecycle ============ //
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  screenHeight = primaryDisplay.workAreaSize.height;

  createcharacterWindow();
  createChatWindow();
  createAddCharacterWindow();
  createSelectCharacterWindow();
  createSettingsWindow();

  globalShortcut.register("Shift+Control+Space", () => {
    if (characterWindow) {
      const visible = characterWindow.isVisible();
      visible ? characterWindow.hide() : characterWindow.show();
      visible ? chatWindow.hide() : chatWindow.hide();
    }
  });

  globalShortcut.register("Shift+Space", () => {
    if (characterWindow) {
      const visible = chatWindow.isVisible();
      visible ? characterWindow.show():characterWindow.show();
      visible ? chatWindow.hide() : chatWindow.show();
    }
  });

  characterWindow.on('move', () => {
    if (!chatWindow || !characterWindow) return;
    const charBounds = characterWindow.getBounds();
    const chatBounds = chatWindow.getBounds();
    chatWindow.setBounds({
      x: charBounds.x - chatWindow.getBounds().width - 20,
      y: charBounds.y - chatWindow.getBounds().height + charBounds.height,
      width: chatBounds.width,
      height: chatBounds.height,
    });
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createChatWindow();
});