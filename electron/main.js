const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, Tray } = require("electron");
const path = require('path');
const fs = require('fs');
const Pet = require('./models/pet');
const Conversation = require('./models/conversation.js');
const { sliceImageToFiles } = require('./models/image_processor.js');

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5173';

require('./ipcMainHandler');

// ------------------- 基础配置 ------------------- //

// 定义各窗口的基准尺寸（以 medium 为标准）
const baselineSizes = {
  character: { width: 200, height: 300 },
  chat: { width: 400, height: 350 },
  addCharacter: { width: 600, height: 600 },
  selectCharacter: { width: 500, height: 350 },
  settings: { width: 500, height: 700 }
};

// 定义比例因子： small、medium、large
const scaleFactors = {
  small: 0.8,
  medium: 1,
  large: 1.2
};

// 根据基准尺寸和预设计算实际尺寸
function getScaledSize(baseline, preset = 'medium') {
  const factor = scaleFactors[preset] || 1;
  return {
    width: Math.round(baseline.width * factor),
    height: Math.round(baseline.height * factor)
  };
}

// 辅助函数：确保窗口位置在屏幕内（用于非 chatWindow 窗口）
function clampPosition(x, y, winWidth, winHeight, screenWidth, screenHeight) {
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + winWidth > screenWidth) x = screenWidth - winWidth;
  if (y + winHeight > screenHeight) y = screenHeight - winHeight;
  return { x, y };
}

// ------------------- 全局变量 ------------------- //

let chatWindow;
let characterWindow;
let AddCharacterWindow;
let selectCharacterWindow;
let settingsWindow;
let screenHeight = 0;
let tray = null;

// 全局变量统一控制所有窗口的尺寸预设（例如 'small'、'medium'、'large'）
let currentSizePreset = 'small';

let sharedState = {
  characterMood: 'neutral',
  chatbodyStatus: ''
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

// 保存上传文件
ipcMain.handle('save-file', async (event, { fileName, fileData }) => {
  try {
    const documentsPath = app.getPath('documents');
    const uploadsPath = path.join(documentsPath, 'PetGPT_Data', 'Uploads');
    if (!fs.existsSync(uploadsPath)) {
      fs.mkdirSync(uploadsPath, { recursive: true });
    }
    
    const uniqueFileName = `${Date.now()}_${fileName}`;
    const filePath = path.join(uploadsPath, uniqueFileName);
    
    // Remove header if present (e.g. "data:image/png;base64,")
    const base64Data = fileData.replace(/^data:.*;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    
    fs.writeFileSync(filePath, buffer);
    return { fileName: uniqueFileName, path: filePath };
  } catch (err) {
    console.error('Save file error:', err);
    throw err;
  }
});

// 读取上传文件
ipcMain.handle('read-upload', async (event, fileName) => {
  try {
    const documentsPath = app.getPath('documents');
    const filePath = path.join(documentsPath, 'PetGPT_Data', 'Uploads', fileName);
    if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
    const buffer = fs.readFileSync(filePath);
    
    const ext = path.extname(fileName).toLowerCase();
    let mimeType = 'application/octet-stream';
    if (['.png', '.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
    else if (['.gif'].includes(ext)) mimeType = 'image/gif';
    else if (['.webp'].includes(ext)) mimeType = 'image/webp';
    else if (['.txt'].includes(ext)) mimeType = 'text/plain';
    else if (['.pdf'].includes(ext)) mimeType = 'application/pdf';
    
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('Read upload error:', err);
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

// 对于 addCharacter、selectCharacter 和 settings 窗口，仅进行显示/隐藏切换，显示时按 currentSizePreset 设置大小
ipcMain.on("change-addCharacter-window", () => {
  if (!AddCharacterWindow) return;
  if (AddCharacterWindow.isVisible()) {
    AddCharacterWindow.hide();
  } else {
    const size = getScaledSize(baselineSizes.addCharacter, currentSizePreset);
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const newX = Math.round((sw - size.width) / 2);
    const newY = Math.round((sh - size.height) / 2);
    
    AddCharacterWindow.setBounds({ x: newX, y: newY, width: size.width, height: size.height });
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
    const size = getScaledSize(baselineSizes.selectCharacter, currentSizePreset);
    const { x: newX, y: newY } = clampPosition(x, y - size.height, size.width, size.height, screen.getPrimaryDisplay().workAreaSize.width, screenHeight);
    selectCharacterWindow.setBounds({ x: newX, y: newY, width: size.width, height: size.height });
    selectCharacterWindow.show();
    selectCharacterWindow.focus();
  }
});

ipcMain.on("change-settings-window", () => {
  if (!settingsWindow || !characterWindow) return;
  if (settingsWindow.isVisible()) {
    settingsWindow.hide();
  } else {
    const size = getScaledSize(baselineSizes.settings, currentSizePreset);
    // settings 固定在左上角，并且 clamped
    const { x: newX, y: newY } = clampPosition(0, 0, size.width, size.height, screen.getPrimaryDisplay().workAreaSize.width, screen.getPrimaryDisplay().workAreaSize.height);
    settingsWindow.setBounds({ x: newX, y: newY, width: size.width, height: size.height });
    settingsWindow.show();
    settingsWindow.focus();
  }
});

// 修改后的最大化/缩小 chat 窗口逻辑，恢复时使用 currentSizePreset
ipcMain.on("maximize-chat-window", () => {
  if (!chatWindow) return;
  if (chatWindow.isMaximized()) {
    chatWindow.unmaximize();
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    if (!chatWindow || !characterWindow) return;
    const charBounds = characterWindow.getBounds();
    const newSize = getScaledSize(baselineSizes.chat, currentSizePreset);
    // 对 chatWindow 位置不进行 clamping，只保持与 characterWindow 的相对位置
    const newX = charBounds.x - newSize.width - 20;
    const newY = charBounds.y - newSize.height + charBounds.height;
    chatWindow.setBounds({
      x: newX,
      y: newY,
      width: newSize.width,
      height: newSize.height,
    });
  } else {
    chatWindow.maximize();
    chatWindow.setVisibleOnAllWorkspaces(false);
  }
});

ipcMain.handle('update-window-size-preset', async (event, newPreset) => {
  currentSizePreset = newPreset;
  updateAllWindowsSizes(currentSizePreset);
});

// ============ 统一修改所有窗口尺寸及位置的函数 ============ //
function updateAllWindowsSizes(preset = currentSizePreset) {
  currentSizePreset = preset;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  // 更新 characterWindow：固定在屏幕右下角
  if (characterWindow && !characterWindow.isDestroyed()) {
    const newSize = getScaledSize(baselineSizes.character, currentSizePreset);
    const newX = sw - newSize.width - 20;
    const newY = sh - newSize.height - 10;
    characterWindow.setBounds({ x: newX, y: newY, width: newSize.width, height: newSize.height });
  }
  // 更新 chatWindow：相对于 characterWindow，不进行 clamping
  if (chatWindow && !chatWindow.isDestroyed() && characterWindow) {
    const newSize = getScaledSize(baselineSizes.chat, currentSizePreset);
    const charBounds = characterWindow.getBounds();
    const newX = charBounds.x - newSize.width - 20;
    const newY = charBounds.y - newSize.height + charBounds.height;
    chatWindow.setBounds({ x: newX, y: newY, width: newSize.width, height: newSize.height });
  }
  // 更新 AddCharacterWindow：保持在屏幕中央
  if (AddCharacterWindow && !AddCharacterWindow.isDestroyed()) {
    const newSize = getScaledSize(baselineSizes.addCharacter, currentSizePreset);
    const newX = Math.round((sw - newSize.width) / 2);
    const newY = Math.round((sh - newSize.height) / 2);
    AddCharacterWindow.setBounds({ x: newX, y: newY, width: newSize.width, height: newSize.height });
  }
  // 更新 selectCharacterWindow：相对于 characterWindow，进行 clamping
  if (selectCharacterWindow && !selectCharacterWindow.isDestroyed() && characterWindow) {
    const newSize = getScaledSize(baselineSizes.selectCharacter, currentSizePreset);
    const charBounds = characterWindow.getBounds();
    let newX = charBounds.x;
    let newY = charBounds.y - newSize.height;
    ({ x: newX, y: newY } = clampPosition(newX, newY, newSize.width, newSize.height, sw, sh));
    selectCharacterWindow.setBounds({ x: newX, y: newY, width: newSize.width, height: newSize.height });
  }
  // 更新 settingsWindow：固定在左上角，进行 clamping
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    let newSize = getScaledSize(baselineSizes.settings, currentSizePreset);
    if (newSize.width > sw) newSize.width = sw;
    if (newSize.height > sh) newSize.height = sh;
    settingsWindow.setBounds({ x: 0, y: 0, width: newSize.width, height: newSize.height });
  }
}

// ============ 创建窗口函数们 ============ //
const createcharacterWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const charSize = getScaledSize(baselineSizes.character, currentSizePreset);
  const x = width - charSize.width - 20;
  const y = height - charSize.height - 10;
  characterWindow = new BrowserWindow({
    width: charSize.width,
    height: charSize.height,
    x,
    y,
    icon: process.platform === 'win32' ? path.join(__dirname, 'assets', 'icon.ico') : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  if (isDev) {
    characterWindow.loadURL(`${DEV_URL}/#/character`);
    // characterWindow.webContents.openDevTools({ mode: 'detach' }); // 可选：开发模式自动打开控制台
  } else {
    characterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/character' });
  }
  
  characterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  characterWindow.on("closed", () => { characterWindow = null; });
};

const createChatWindow = () => {
  if (!characterWindow) return;
  const charBounds = characterWindow.getBounds();
  const chatSize = getScaledSize(baselineSizes.chat, currentSizePreset);
  let x = charBounds.x - chatSize.width - 20;
  let y = charBounds.y - chatSize.height + charBounds.height;
  // 对 chatWindow 不进行 clamping
  chatWindow = new BrowserWindow({
    x,
    y,
    width: chatSize.width,
    height: chatSize.height,
    icon: process.platform === 'win32' ? path.join(__dirname, 'assets', 'icon.ico') : undefined,
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
  
  if (isDev) {
    chatWindow.loadURL(`${DEV_URL}`); // 默认路由是 /
  } else {
    chatWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  }

  chatWindow.on('maximize', () => {
    chatWindow.webContents.send('window-maximized');
  });

  chatWindow.on('unmaximize', () => {
    chatWindow.webContents.send('window-unmaximized');
  });

  chatWindow.on("closed", () => { chatWindow = null; });
};

const createAddCharacterWindow = () => {
  const addCharSize = getScaledSize(baselineSizes.addCharacter, currentSizePreset);
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.round((screenWidth - addCharSize.width) / 2);
  const y = Math.round((screenHeight - addCharSize.height) / 2);

  AddCharacterWindow = new BrowserWindow({
    width: addCharSize.width,
    height: addCharSize.height,
    show: false,
    x,
    y,
    icon: process.platform === 'win32' ? path.join(__dirname, 'assets', 'icon.ico') : undefined,
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

  if (isDev) {
    AddCharacterWindow.loadURL(`${DEV_URL}/#/addCharacter`);
  } else {
    AddCharacterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/addCharacter' });
  }

  AddCharacterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  AddCharacterWindow.on("closed", () => { AddCharacterWindow = null; });
};

const createSelectCharacterWindow = () => {
  const selectCharSize = getScaledSize(baselineSizes.selectCharacter, currentSizePreset);
  let x = 500; // 初始位置可根据需求调整
  let y = screenHeight - selectCharSize.height - 250;
  ({ x, y } = clampPosition(x, y, selectCharSize.width, selectCharSize.height, screen.getPrimaryDisplay().workAreaSize.width, screenHeight));
  selectCharacterWindow = new BrowserWindow({
    width: selectCharSize.width,
    height: selectCharSize.height,
    show: false,
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: true,
    icon: process.platform === 'win32' ? path.join(__dirname, 'assets', 'icon.ico') : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  if (isDev) {
    selectCharacterWindow.loadURL(`${DEV_URL}/#/selectCharacter`);
  } else {
    selectCharacterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/selectCharacter' });
  }

  selectCharacterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  selectCharacterWindow.on("closed", () => { selectCharacterWindow = null; });
};

// 添加一个新的 IPC handler，用于更新快捷键
ipcMain.handle('update-shortcuts', async (event, { shortcut1, shortcut2 }) => {
  // 注销所有之前注册的快捷键
  globalShortcut.unregisterAll();

  // 注册第一个快捷键：例如用来切换 characterWindow 的显示状态
  globalShortcut.register(shortcut1, () => {
    if (characterWindow) {
      const visible = characterWindow.isVisible();
      visible ? characterWindow.hide() : characterWindow.show();
      // visible ? chatWindow.hide() : chatWindow.hide();
    }
  });

  // 注册第二个快捷键：例如用来切换 chatWindow 的显示状态
  globalShortcut.register(shortcut2, () => {
    if (characterWindow) {
      const visible = chatWindow.isVisible();
      // visible ? characterWindow.show() : characterWindow.show();
      visible ? chatWindow.hide() : chatWindow.show();
    }
  });

  return { success: true, shortcuts: { shortcut1, shortcut2 } };
});

const createSettingsWindow = () => {
  const settingsSize = getScaledSize(baselineSizes.settings, currentSizePreset);
  let x = 0, y = 0;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  if (settingsSize.width > sw) settingsSize.width = sw;
  if (settingsSize.height > sh) settingsSize.height = sh;
  settingsWindow = new BrowserWindow({
    width: settingsSize.width,
    height: settingsSize.height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: true,
    icon: process.platform === 'win32' ? path.join(__dirname, 'assets', 'icon.ico') : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  if (isDev) {
    settingsWindow.loadURL(`${DEV_URL}/#/settings`);
  } else {
    settingsWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/settings' });
  }

  settingsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  settingsWindow.on("closed", () => { settingsWindow = null; });
};

function createTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'iconT.png');
  if (!fs.existsSync(iconPath)) {
    console.error("托盘图标文件不存在！", iconPath);
    return;
  }

  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    // { label: '选项1', type: 'radio' },
    // { label: '选项2', type: 'radio' },
    { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setToolTip('这是我的应用。');
  tray.setContextMenu(contextMenu);
  console.log("托盘图标已创建");
  console.log("Tray icon absolute path:", iconPath);
}

// ============ App lifecycle ============ //
app.whenReady().then(() => {
  
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  } else if (process.platform === 'win32') {
    app.setAppUserModelId("com.petgpt.app");
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  screenHeight = primaryDisplay.workAreaSize.height;

  createcharacterWindow();
  createChatWindow();
  createAddCharacterWindow();
  createSelectCharacterWindow();
  createSettingsWindow();

  // 当 characterWindow 移动时，重新计算 chatWindow 的位置（保持相对位置，不 clamping）
  characterWindow.on('move', () => {
    if (!chatWindow || !characterWindow) return;
    const charBounds = characterWindow.getBounds();
    const newChatSize = getScaledSize(baselineSizes.chat, currentSizePreset);
    const newX = charBounds.x - newChatSize.width - 20;
    const newY = charBounds.y - newChatSize.height + charBounds.height;
    chatWindow.setBounds({
      x: newX,
      y: newY,
      width: newChatSize.width,
      height: newChatSize.height,
    });
  });
  setTimeout(createTrayIcon, 300);


});




app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createChatWindow();
});