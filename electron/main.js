const { app, BrowserWindow, globalShortcut } = require("electron");
const { screen } = require('electron');
const path = require("path");
const { ipcMain } = require("electron");
const isDev = !app.isPackaged;

let sharedState = {
  characterMood: 'normal'
};

ipcMain.on('drag-window', (event, { deltaX, deltaY, mood }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const [x, y] = win.getPosition();
    win.setPosition(x + deltaX, y + deltaY);
  }

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

ipcMain.on("change-chat-window", () => {
  if (chatWindow.isVisible()) {
    chatWindow.hide();
  } else {
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
    x: secondWindow.getBounds().x - 520,
    y: secondWindow.getBounds().y - 550 + secondWindow.getBounds().height,
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

  // if (isDev) {
  //   chatWindow.loadURL("http://localhost:5173");
  // } else {
    // win.loadFile(path.join(__dirname, '../frontend/dist/index.html'));
    chatWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  // }

  chatWindow.on("closed", () => {
    chatWindow = null;
  });

  // ✅ 主窗口移动时更新第二窗口位置

// chatWindow.webContents.openDevTools(); // 加这一句看看报什么错

// chatWindow.webContents.on("did-fail-load", (e, errorCode, errorDesc, validatedURL) => {
//   console.error('💥 页面加载失败:', errorCode, errorDesc, validatedURL);
// });

};

const createSecondWindow = () => {
  secondWindow = new BrowserWindow({
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

  // if (isDev) {
  //   secondWindow.loadURL("http://localhost:5173/character");
  //   // chatWindow.loadURL("http://localhost:5173/");
  // } else {
    // secondWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
    secondWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), {
      hash: '#/character'
    });
  //   console.log('!!')
  //   // chatWindow.loadFile(path.join(__dirname, "../frontend/dist/chat.html"));
  // }

  

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
