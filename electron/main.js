const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require("electron");
const path = require('path');
const fs = require('fs');
const Pet = require('./models/pet');
const Conversation = require('./models/conversation.js');


// IPC 处理：读取文档目录下 PetGPT_Data/Images 中的图片
ipcMain.handle('read-pet-image', async (event, fileName) => {
  try {
    // 获取用户文档目录
    const documentsPath = app.getPath('documents');
    const imagePath = path.join(documentsPath, 'PetGPT_Data', 'Images', fileName);

    if (!fs.existsSync(imagePath)) {
      throw new Error(`File does not exist: ${imagePath}`);
    }
    // 读取图片为 Buffer
    const buffer = fs.readFileSync(imagePath);
    // 转换为 Base64，并加上 MIME 前缀（此处假设图片为 PNG）
    const base64Image = `data:image/png;base64,${buffer.toString('base64')}`;
    return base64Image;
  } catch (err) {
    console.error('读取图片错误:', err);
    throw err;
  }
});


const { sliceImageToFiles } = require('./models/image_processor.js');

// 监听渲染进程的处理请求
ipcMain.handle('process-image', async (event, base64Image) => {
  try {
    const result = await sliceImageToFiles(base64Image);
    // result 形如 { uuid: 'xxx-xxx', paths: ['/path/to/uuid-normal.png', ...] }
    return result;
  } catch (err) {
    console.error('图片处理出错:', err);
    throw err;
  }
});

// ✅ Pet 相关
ipcMain.handle('get-pets', async () => {
  return await Pet.findAll();
});

ipcMain.handle('create-pet', async (event, petData) => {
  return await Pet.create(petData);
});

ipcMain.handle('update-pet', async (event, { id, updatedData }) => {
  return await Pet.update(id, updatedData);
});

ipcMain.handle('delete-pet', async (event, id) => {
  return await Pet.delete(id);
});

ipcMain.handle('get-pet-by-id', async (event, id) => {
  try {
    const pet = await Pet.findById(id);
    return pet;
  } catch (error) {
    console.error("Failed to get pet by id:", error);
    throw error;
  }
});

// ✅ Conversation 相关
ipcMain.handle('get-conversations', async () => {
  return await Conversation.findAll();
});

ipcMain.handle('create-conversation', async (event, convData) => {
  return await Conversation.create(convData);
});

ipcMain.handle('update-conversation', async (event, { id, updatedData }) => {
  return await Conversation.update(id, updatedData);
});

ipcMain.handle('delete-conversation', async (event, id) => {
  return await Conversation.delete(id);
});

ipcMain.handle('get-conversation-by-id', async (event, id) => {
  return await Conversation.findById(id);
});

// 可选：前端通知主进程设置当前选择
ipcMain.on('send-character-id', (event, id) => {
  console.log("Main received character ID:", id);
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('character-id', id); // ✅ 发给所有窗口
  });
});

ipcMain.on('send-conversation-id', (event, id) => {
  console.log('[主进程] 当前会话 ID:', id);
});

const isDev = !app.isPackaged;

let chatWindow;
let characterWindow;
let AddCharacterWindow;
let selectCharacterWindow;

let screenHeight = 0;

let sharedState = {
  characterMood: 'neutral'
};

ipcMain.on('update-character-mood', (event, mood) => {
  console.log("Received mood update from renderer:", mood);
  sharedState.characterMood = mood;
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('character-mood-updated', mood);
  });
});

ipcMain.on('update-pets', (event, data) => {
  console.log("Received pets update request from renderer.");
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('pets-updated', "pets updated");
  });
});

ipcMain.on('character-id', (event, characterId) => {
  console.log("Main received character ID:", characterId);
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('character-id', characterId);
  });
});

ipcMain.on('conversation-id', (event, conversationId) => {
  console.log("Main received conversation ID:", conversationId);
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('conversation-id', conversationId);
  });
});

// 拖拽事件
ipcMain.on('drag-window', (event, { deltaX, deltaY, mood }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const [x, y] = win.getPosition();
    win.setPosition(x + deltaX, y + deltaY);
  }
});

// 关闭/隐藏 chat 窗口
ipcMain.on("hide-chat-window", () => {
  if (chatWindow) {
    chatWindow.unmaximize();
    chatWindow.hide();
  }
});

// 其他 show/hide 事件
ipcMain.on("show-chat-window", () => {
  if (chatWindow) {
    chatWindow.show();
  }
});

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
    const charBounds = characterWindow.getBounds();
    const newX = charBounds.x; 
    const newY = charBounds.y - 450; // 450 对应 AddCharacterWindow 的高度
    AddCharacterWindow.setBounds({
      x: newX,
      y: newY,
      width: 600,
      height: 450
    });
    AddCharacterWindow.show();
    AddCharacterWindow.focus();
  }
});

ipcMain.on("change-selectCharacter-window", () => {
  if (!selectCharacterWindow || !characterWindow) return;

  if (selectCharacterWindow.isVisible()) {
    selectCharacterWindow.hide();
  } else {
    const charBounds = characterWindow.getBounds();
    const newX = charBounds.x;
    const newY = charBounds.y - 400; // 假设 selectCharacterWindow 高度为 400
    selectCharacterWindow.setBounds({
      x: newX,
      y: newY,
      width: 500,
      height: 400
    });
    selectCharacterWindow.show();
    selectCharacterWindow.focus();
  }
});

// 最大化/恢复 chatWindow
ipcMain.on("maximize-chat-window", () => {
  if (chatWindow) {
    if (chatWindow.isMaximized()) {
      chatWindow.unmaximize();
      chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    } else {
      chatWindow.maximize();
      chatWindow.setVisibleOnAllWorkspaces(false);
    }
  }
});

// ============ 创建窗口函数们 ============ //

// 1. characterWindow
const createcharacterWindow = () => {
  characterWindow = new BrowserWindow({
    width: 200,
    height: 300,
    x: 800,
    y: screenHeight - 350,
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

  characterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), {
    hash: '#/character'
  });

  // 设置窗口在所有桌面显示（包括全屏模式下）
  characterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  characterWindow.on("closed", () => {
    characterWindow = null;
  });
};

// 2. chatWindow
const createChatWindow = () => {
  if (!characterWindow) {
    console.error("characterWindow is not created yet.");
    return;
  }
  const charBounds = characterWindow.getBounds();

  chatWindow = new BrowserWindow({
    x: charBounds.x - 400 + 20,
    y: charBounds.y - 350 + charBounds.height,
    width: 400,
    height: 350,
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: true,
    vibrancy: "ultra-dark",
    visualEffectState: "active",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "Preload.js"),
    },
  });

  chatWindow.setAlwaysOnTop(true, 'floating');
  // 设置窗口在所有桌面显示（包括全屏模式下）
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  chatWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  chatWindow.on("closed", () => {
    chatWindow = null;
  });
};

// 3. AddCharacterWindow
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

  AddCharacterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), {
    hash: '#/addCharacter'
  });

  // 设置窗口在所有桌面显示（包括全屏模式下）
  AddCharacterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  AddCharacterWindow.on("closed", () => {
    AddCharacterWindow = null;
  });
};

// 4. selectCharacterWindow
const createSelectCharacterWindow = () => {
  selectCharacterWindow = new BrowserWindow({
    show: false,
    x: 0,
    y: 0,
    width: 500,
    height: 400,
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

  selectCharacterWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), {
    hash: '#/selectCharacter'
  });

  // 设置窗口在所有桌面显示（包括全屏模式下）
  selectCharacterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  selectCharacterWindow.on("closed", () => {
    selectCharacterWindow = null;
  });
};

// ============ app lifecycle ============ //
app.whenReady().then(() => {
  // app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  screenHeight = primaryDisplay.workAreaSize.height;

  // 先创建 characterWindow，再创建其他窗口
  createcharacterWindow();
  createChatWindow();
  createAddCharacterWindow();
  createSelectCharacterWindow();
  
  // 注册全局快捷键隐藏/显示 character & chat
  globalShortcut.register("Shift+Space", () => {
    if (characterWindow) {
      characterWindow.isVisible() ? characterWindow.hide() : characterWindow.show();
      characterWindow.isVisible() ? chatWindow.show() : chatWindow.hide();
    }
  });

  // 当 characterWindow 移动时，更新 chatWindow 位置
  characterWindow.on('move', () => {
    if (!chatWindow || !characterWindow) return;
    const secondBounds = characterWindow.getBounds();
    const chatBounds = chatWindow.getBounds();
    const offsetX = chatBounds.width + 20;
    chatWindow.setBounds({
      x: secondBounds.x - offsetX,
      y: secondBounds.y - chatBounds.height + secondBounds.height,
      width: 400,
      height: 350,
    });
  });
});

// 关闭时解除快捷键注册
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// 仅 Windows 关闭窗口时退出
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// macOS 点击 Dock 图标时重新打开
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createChatWindow();
});