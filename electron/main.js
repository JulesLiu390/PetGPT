const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require("electron");
const path = require("path");
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
  // 更新共享状态（如果需要）
  sharedState.characterMood = mood;
  // 发送更新消息给发送该事件的渲染进程
  // event.sender.send('character-mood-updated', mood);
  
  // 或者广播给所有窗口：
  const { BrowserWindow } = require('electron');
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('character-mood-updated', mood);
  });
});

ipcMain.on('update-pets', (event, data) => {
  console.log("Received pets update request from renderer.");
  const { BrowserWindow } = require('electron');
  // 这里你可以根据需要从数据源重新获取 pets 数据，
  // 或者直接通知渲染进程去调用 API 刷新数据
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('pets-updated', "pets updated");
  });
});

ipcMain.on('character-id', (event, characterId) => {
  console.log("Main received character ID:", characterId);
  // 广播给所有窗口
  const { BrowserWindow } = require('electron');
  BrowserWindow.getAllWindows().forEach(win => {
    // 如果你不想让发送方再收到，可以加个判断
    // if (win.webContents.id !== event.sender.id) {
      win.webContents.send('character-id', characterId);
    // }
  });
});

ipcMain.on('conversation-id', (event, conversationId) => {
  console.log("Main received conversation ID:", conversationId);
  // 广播给所有窗口
  const { BrowserWindow } = require('electron');
  BrowserWindow.getAllWindows().forEach(win => {
    // 如果你不想让发送方再收到，可以加个判断
    // if (win.webContents.id !== event.sender.id) {
      win.webContents.send('conversation-id', conversationId);
    // }
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
  }
});

ipcMain.on("change-addCharacter-window", () => {
  // 若窗口或 characterWindow 未创建，直接返回
  if (!AddCharacterWindow || !characterWindow) return;

  if (AddCharacterWindow.isVisible()) {
    // 如果当前可见，则隐藏
    AddCharacterWindow.hide();
  } else {
    // 若不可见，先获取 characterWindow 的位置和大小
    const charBounds = characterWindow.getBounds();
    
    // 计算新坐标：x 保持与 characterWindow 一致，y 在其上方
    const newX = charBounds.x; 
    const newY = charBounds.y - 450; // 这里的 450 对应 addCharacterWindow 的高度，可按需调整
    
    // 更新 AddCharacterWindow 的位置和大小
    AddCharacterWindow.setBounds({
      x: newX,
      y: newY,
      width: 600,
      height: 450
    });
    
    // 显示并聚焦
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
    
    // 假设 selectCharacterWindow 高度为 400
    const newX = charBounds.x;
    const newY = charBounds.y - 400;
    
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
    } else {
      chatWindow.maximize();
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

  characterWindow.on("closed", () => {
    characterWindow = null;
  });
};

// 2. chatWindow
const createChatWindow = () => {
  // 确保 characterWindow 已创建
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

  chatWindow.setAlwaysOnTop(true, "screen-saver");

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
    show: false,  // 默认隐藏
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

  AddCharacterWindow.on("closed", () => {
    AddCharacterWindow = null;
  });


  // AddCharacterWindow.webContents.openDevTools();
};

// 4. selectCharacterWindow
const createSelectCharacterWindow = () => {
  // 同样默认隐藏
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

  selectCharacterWindow.on("closed", () => {
    selectCharacterWindow = null;
  });
};

// ============ app lifecycle ============ //
app.whenReady().then(() => {
  const primaryDisplay = screen.getPrimaryDisplay();
  screenHeight = primaryDisplay.workAreaSize.height;

  // 先创建 characterWindow，再创建其他窗口
  createcharacterWindow();
  createChatWindow();
  createAddCharacterWindow();
  createSelectCharacterWindow();
  
  // 注册全局快捷键隐藏/显示 character & chat
  globalShortcut.register("CommandOrControl+Shift+X", () => {
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