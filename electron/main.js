const { app, BrowserWindow, globalShortcut } = require("electron");
const { screen } = require('electron');
const path = require("path");
const { ipcMain } = require("electron");

let sharedState = {
  characterMood: 'normal'
};

ipcMain.on('drag-window', (event, { deltaX, deltaY, mood }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const [x, y] = win.getPosition();
    win.setPosition(x + deltaX, y + deltaY);
  }

  // sharedState.characterMood = mood;
  // console.log('主进程更新 characterMood:', mood);
  // 向所有窗口广播最新状态
  // BrowserWindow.getAllWindows().forEach(win => {
  //   win.webContents.send('character-mood-updated', mood);
  // });
});


ipcMain.on("hide-chat-window", () => {
  if (chatWindow) {
    chatWindow.hide();
  }
});

ipcMain.on("show-chat-window", () => {
  if (chatWindow) {
    chatWindow.show();
  }
});

let chatWindow;
let secondWindow;

let screenHeight = 0;


const createChatWindow = () => {
  chatWindow = new BrowserWindow({
    width: 400,
    height: 350,
    x: secondWindow.getBounds().x - 420,
    y: secondWindow.getBounds().y - 350 + secondWindow.getBounds().height,
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: true,
    vibrancy: "ultra-dark",
    visualEffectState: "active",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  chatWindow.setAlwaysOnTop(true, "screen-saver");

  if (process.env.NODE_ENV === "development") {
    chatWindow.loadURL("http://localhost:5173");
  } else {
    chatWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  }

  chatWindow.on("closed", () => {
    chatWindow = null;
  });

  // ✅ 主窗口移动时更新第二窗口位置

};

const createSecondWindow = () => {
  secondWindow = new BrowserWindow({
    width: 200,
    height: 200,
    x: 800,
    y: screenHeight - 150,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (process.env.NODE_ENV === "development") {
    secondWindow.loadURL("http://localhost:5173/character");
    // chatWindow.loadURL("http://localhost:5173/");
  } else {
    secondWindow.loadFile(path.join(__dirname, "../frontend/dist/second.html"));
    // chatWindow.loadFile(path.join(__dirname, "../frontend/dist/chat.html"));
  }

  

  secondWindow.on("closed", () => {
    secondWindow = null;
  });
};

app.whenReady().then(() => {
  const primaryDisplay = screen.getPrimaryDisplay();
  screenHeight = primaryDisplay.workAreaSize.height;
  createSecondWindow();
  createChatWindow();
  

  // ✅ 注册全局快捷键隐藏/显示主窗口
  globalShortcut.register("CommandOrControl+Shift+X", () => {
    if (secondWindow) {
      secondWindow.isVisible() ? secondWindow.hide() : secondWindow.show();
      secondWindow.isVisible() ? chatWindow.show() : chatWindow.hide();
    }
  });

secondWindow.on('move', () => {
  if (!chatWindow || !secondWindow) return;

  const secondBounds = secondWindow.getBounds();
  const chatBounds = chatWindow.getBounds();
  const offsetX = chatWindow.getBounds().width + 20;

  chatWindow.setBounds({
    x: secondBounds.x - offsetX,
    y: secondBounds.y - chatBounds.height  + secondBounds.height,
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
<<<<<<< HEAD
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
=======
  if (BrowserWindow.getAllWindows().length === 0) createChatWindow();
});
>>>>>>> 029c6cb2a513ae23587f2aace2ce5bbd92b38de2
