const { app, BrowserWindow, globalShortcut } = require("electron");
const path = require("path");

let mainWindow;

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 350,
    frame: false, // 让窗口无边框
    transparent: true, // ✅ 启用透明窗口（macOS 有效）
    roundedCorners: true, // ✅ 确保 macOS 上启用圆角
    hasShadow: true, // ✅ 添加窗口阴影
    vibrancy: "ultra-dark", // ✅ macOS 玻璃模糊效果（适用于 macOS）
    visualEffectState: "active", // ✅ macOS 窗口保持模糊
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");


  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173"); // Vite 默认端口
  } else {
    mainWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

app.whenReady().then(() => {
  createMainWindow();

  // ✅ 这里才注册全局快捷键
  globalShortcut.register("CommandOrControl+Shift+X", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide(); // 隐藏窗口
      } else {
        mainWindow.show(); // 显示窗口
      }
    }
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
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});