const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, Tray } = require("electron");
const path = require('path');
// Node fetch is available in modern Electron/Node; fallback handled in helper.
const fs = require('fs');
const Pet = require('./models/pet');
const ModelConfig = require('./models/model_config');
const Assistant = require('./models/assistant');
const Conversation = require('./models/conversation.js');
const { sliceImageToFiles } = require('./models/image_processor.js');
const mammoth = require('mammoth');

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5173';

require('./ipcMainHandler');

// MCP 系统
const { initializeMCP, cleanupMCP } = require('./mcp/ipcHandlers');

// ------------------- 基础配置 ------------------- //

// 定义各窗口的基准尺寸（以 medium 为标准）
const baselineSizes = {
  character: { width: 200, height: 300 },
  chat: { width: 400, height: 350 },
  addCharacter: { width: 600, height: 600 },
  selectCharacter: { width: 500, height: 350 },
  settings: { width: 500, height: 700 },
  mcp: { width: 550, height: 650 }
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
let mcpWindow;
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
    const mimeMap = {
      // Images
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', 
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      // Video
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
      // Audio
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
      // Documents
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
      '.json': 'application/json', '.csv': 'text/csv',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('Read upload error:', err);
    throw err;
  }
});

// 提取文档文本（用于让 LLM 实际“读到”内容）
ipcMain.handle('extract-document-text', async (event, fileName) => {
  try {
    const documentsPath = app.getPath('documents');
    const filePath = path.join(documentsPath, 'PetGPT_Data', 'Uploads', fileName);
    if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);

    const ext = path.extname(fileName).toLowerCase();

    // Plain text / markdown / csv / json
    if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
      return fs.readFileSync(filePath, 'utf8');
    }

    // DOCX
    if (ext === '.docx') {
      const buffer = fs.readFileSync(filePath);
      const { value } = await mammoth.extractRawText({ buffer });
      return value || '';
    }

    // Not supported yet
    return '';
  } catch (err) {
    console.error('Extract document text error:', err);
    throw err;
  }
});

// Auto-detect OpenAI-compatible endpoints
// 探测候选 URL 列表，找出哪个能响应
ipcMain.handle('probe-openai-compatible-endpoints', async (event, { apiKey, includeLocal = false }) => {
  // 候选端点列表
  const candidates = [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    { id: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  ];
  
  if (includeLocal) {
    candidates.push(
      { id: 'ollama', label: 'Ollama (Local)', baseUrl: 'http://localhost:11434/v1' },
      { id: 'lmstudio', label: 'LM Studio (Local)', baseUrl: 'http://localhost:1234/v1' }
    );
  }
  
  const results = [];
  
  for (const candidate of candidates) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
      
      const response = await fetch(`${candidate.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      results.push({
        ...candidate,
        status: response.status,
        ok: response.ok,
        // 200 = 完美匹配，401/403 = URL正确但key不对
        match: response.ok ? 'perfect' : (response.status === 401 || response.status === 403) ? 'auth_error' : 'no_match'
      });
    } catch (err) {
      results.push({
        ...candidate,
        status: 0,
        ok: false,
        match: 'error',
        error: err.message
      });
    }
  }
  
  // 选择最佳匹配
  // 优先 perfect (200)，其次 auth_error (401/403)
  let bestMatch = results.find(r => r.match === 'perfect');
  if (!bestMatch) {
    bestMatch = results.find(r => r.match === 'auth_error');
  }
  
  return {
    tried: results,
    bestMatch: bestMatch || null,
    matches: results.filter(r => r.match === 'perfect' || r.match === 'auth_error')
  };
});

// 用系统默认应用打开文件
ipcMain.handle('open-file-external', async (event, filePath) => {
  try {
    const { shell } = require('electron');
    await shell.openPath(filePath);
    return { success: true };
  } catch (err) {
    console.error('Open file error:', err);
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

// Pet 相关 (保留兼容旧数据)
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

// ModelConfig 相关 (新)
ipcMain.handle('get-model-configs', async () => await ModelConfig.findAll());
ipcMain.handle('create-model-config', async (event, data) => await ModelConfig.create(data));
ipcMain.handle('update-model-config', async (event, { id, updatedData }) => await ModelConfig.update(id, updatedData));
ipcMain.handle('delete-model-config', async (event, id) => await ModelConfig.delete(id));
ipcMain.handle('get-model-config-by-id', async (event, id) => await ModelConfig.findById(id));

// Assistant 相关 (新)
ipcMain.handle('get-assistants', async () => await Assistant.findAll());
ipcMain.handle('create-assistant', async (event, data) => await Assistant.create(data));
ipcMain.handle('update-assistant', async (event, { id, updatedData }) => await Assistant.update(id, updatedData));
ipcMain.handle('delete-assistant', async (event, id) => await Assistant.delete(id));
ipcMain.handle('get-assistant-by-id', async (event, id) => await Assistant.findById(id));

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

// Mood 更新 (支持按会话 ID 独立管理)
ipcMain.on('update-character-mood', (event, mood, conversationId) => {
  console.log("Received mood update:", mood, "for conversation:", conversationId);
  // 保存到共享状态
  if (!sharedState.characterMoods) sharedState.characterMoods = {};
  if (conversationId) {
    sharedState.characterMoods[conversationId] = mood;
  }
  sharedState.characterMood = mood; // 保持全局状态兼容
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('character-mood-updated', mood, conversationId));
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

// 隐藏 addCharacter 窗口（用于关闭按钮）
ipcMain.on("hide-addCharacter-window", () => {
  if (AddCharacterWindow && AddCharacterWindow.isVisible()) {
    AddCharacterWindow.hide();
  }
});

// 隐藏 selectCharacter 窗口（用于关闭按钮）
ipcMain.on("hide-selectCharacter-window", () => {
  if (selectCharacterWindow && selectCharacterWindow.isVisible()) {
    selectCharacterWindow.hide();
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

ipcMain.on("change-mcp-window", () => {
  if (!mcpWindow) return;
  if (mcpWindow.isVisible()) {
    mcpWindow.hide();
  } else {
    const size = getScaledSize(baselineSizes.mcp, currentSizePreset);
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    // MCP 窗口居中显示
    const x = Math.round((sw - size.width) / 2);
    const y = Math.round((sh - size.height) / 2);
    const { x: newX, y: newY } = clampPosition(x, y, size.width, size.height, sw, sh);
    mcpWindow.setBounds({ x: newX, y: newY, width: size.width, height: size.height });
    mcpWindow.show();
    mcpWindow.focus();
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
    const newX = charBounds.x - newSize.width - 50;
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

// 侧边栏展开/收起 - 窗口向左扩展
const SIDEBAR_WIDTH = 256; // 与前端 w-64 (256px) 一致
const BASE_MIN_WIDTH = 450; // 聊天区域的最小宽度
let sidebarExpanded = false;

ipcMain.on('toggle-sidebar', (event, open) => {
  if (!chatWindow || chatWindow.isDestroyed() || chatWindow.isMaximized()) return;
  
  const bounds = chatWindow.getBounds();
  
  if (open && !sidebarExpanded) {
    // 展开侧边栏：向左扩展窗口，更新最小宽度
    chatWindow.setMinimumSize(BASE_MIN_WIDTH + SIDEBAR_WIDTH, 320);
    chatWindow.setBounds({
      x: bounds.x - SIDEBAR_WIDTH,
      y: bounds.y,
      width: bounds.width + SIDEBAR_WIDTH,
      height: bounds.height,
    });
    sidebarExpanded = true;
    // 更新置顶状态：侧边栏展开时变为普通窗口
    chatWindow.setAlwaysOnTop(false);
    chatWindow.setVisibleOnAllWorkspaces(false);
  } else if (!open && sidebarExpanded) {
    // 收起侧边栏：向右收缩窗口，恢复最小宽度
    chatWindow.setMinimumSize(BASE_MIN_WIDTH, 320);
    chatWindow.setBounds({
      x: bounds.x + SIDEBAR_WIDTH,
      y: bounds.y,
      width: bounds.width - SIDEBAR_WIDTH,
      height: bounds.height,
    });
    sidebarExpanded = false;
    // 更新置顶状态：侧边栏关闭时恢复置顶
    chatWindow.setAlwaysOnTop(true, 'floating');
    chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }
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
    const newX = charBounds.x - newSize.width - 50;
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
  // 更新 mcpWindow：居中显示
  if (mcpWindow && !mcpWindow.isDestroyed()) {
    let newSize = getScaledSize(baselineSizes.mcp, currentSizePreset);
    if (newSize.width > sw) newSize.width = sw;
    if (newSize.height > sh) newSize.height = sh;
    const newX = Math.round((sw - newSize.width) / 2);
    const newY = Math.round((sh - newSize.height) / 2);
    mcpWindow.setBounds({ x: newX, y: newY, width: newSize.width, height: newSize.height });
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

  // 拦截关闭事件（Cmd+W / Ctrl+W），改为隐藏窗口而不是关闭
  characterWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      characterWindow.hide();
    }
  });

  characterWindow.on("closed", () => { characterWindow = null; });
};

const createChatWindow = () => {
  if (!characterWindow) return;
  const charBounds = characterWindow.getBounds();
  const chatSize = getScaledSize(baselineSizes.chat, currentSizePreset);
  let x = charBounds.x - chatSize.width - 50;
  let y = charBounds.y - chatSize.height + charBounds.height;
  // 对 chatWindow 不进行 clamping
  chatWindow = new BrowserWindow({
    x,
    y,
    width: chatSize.width,
    height: chatSize.height,
    minWidth: 450,
    minHeight: 320,
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
  
  // 根据侧边栏状态动态切换聊天窗口置顶
  // 侧边栏关闭且非全屏时：置顶
  // 侧边栏展开或全屏时：普通窗口层级
  const updateChatWindowOnTop = () => {
    if (!chatWindow || chatWindow.isDestroyed()) return;
    const isMaximized = chatWindow.isMaximized();
    const shouldChatBeOnTop = !sidebarExpanded && !isMaximized;
    
    // 聊天窗口：根据侧边栏和全屏状态切换
    chatWindow.setAlwaysOnTop(shouldChatBeOnTop, 'floating');
    chatWindow.setVisibleOnAllWorkspaces(shouldChatBeOnTop, { visibleOnFullScreen: false });
    
    // 角色窗口：始终置顶，除非聊天窗口全屏
    if (characterWindow && !characterWindow.isDestroyed()) {
      if (isMaximized) {
        // 聊天全屏时，隐藏角色窗口
        characterWindow.hide();
      } else {
        // 非全屏时，角色窗口始终置顶并显示
        characterWindow.show();
        characterWindow.setAlwaysOnTop(true, 'floating');
        characterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
      }
    }
  };
  
  // 开发模式自动打开控制台
  if (isDev) {
    chatWindow.webContents.openDevTools({ mode: 'detach' });
  }
  
  if (isDev) {
    chatWindow.loadURL(`${DEV_URL}`); // 默认路由是 /
  } else {
    chatWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  }

  chatWindow.on('maximize', () => {
    chatWindow.webContents.send('window-maximized');
    // 全屏时隐藏角色窗口，聊天窗口变为普通窗口
    chatWindow.setAlwaysOnTop(false);
    chatWindow.setVisibleOnAllWorkspaces(false);
    if (characterWindow && !characterWindow.isDestroyed()) {
      characterWindow.hide();
    }
  });

  chatWindow.on('unmaximize', () => {
    chatWindow.webContents.send('window-unmaximized');
    // 退出全屏时显示角色窗口并恢复置顶
    if (characterWindow && !characterWindow.isDestroyed()) {
      characterWindow.show();
      characterWindow.setAlwaysOnTop(true, 'floating');
      characterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    }
    // 根据侧边栏状态更新聊天窗口置顶
    if (!sidebarExpanded) {
      chatWindow.setAlwaysOnTop(true, 'floating');
      chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    }
  });

  // 拦截关闭事件（Cmd+W / Ctrl+W），改为隐藏窗口而不是关闭
  chatWindow.on('close', (event) => {
    // 如果不是应用正在退出，则阻止关闭，改为隐藏
    if (!app.isQuitting) {
      event.preventDefault();
      chatWindow.hide();
    }
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

  // 拦截关闭事件（Cmd+W / Ctrl+W），改为隐藏窗口而不是关闭
  AddCharacterWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      AddCharacterWindow.hide();
    }
  });

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

  // 拦截关闭事件（Cmd+W / Ctrl+W），改为隐藏窗口而不是关闭
  selectCharacterWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      selectCharacterWindow.hide();
    }
  });

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

  // 拦截关闭事件（Cmd+W / Ctrl+W），改为隐藏窗口而不是关闭
  settingsWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      settingsWindow.hide();
    }
  });

  settingsWindow.on("closed", () => { settingsWindow = null; });
};

const createMcpWindow = () => {
  const mcpSize = getScaledSize(baselineSizes.mcp, currentSizePreset);
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let width = mcpSize.width > sw ? sw : mcpSize.width;
  let height = mcpSize.height > sh ? sh : mcpSize.height;
  const x = Math.round((sw - width) / 2);
  const y = Math.round((sh - height) / 2);
  
  mcpWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
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
    mcpWindow.loadURL(`${DEV_URL}/#/mcp`);
  } else {
    mcpWindow.loadFile(path.join(__dirname, "../frontend/dist/index.html"), { hash: '#/mcp' });
  }

  mcpWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 拦截关闭事件（Cmd+W / Ctrl+W），改为隐藏窗口而不是关闭
  mcpWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mcpWindow.hide();
    }
  });

  mcpWindow.on("closed", () => { mcpWindow = null; });
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
  createMcpWindow();

  // 当 characterWindow 移动时，重新计算 chatWindow 的位置（保持相对位置，不 clamping）
  // 注意：侧边栏展开时不自动调整
  characterWindow.on('move', () => {
    if (!chatWindow || !characterWindow) return;
    // 如果侧边栏已展开，不自动跟随调整
    if (sidebarExpanded) return;
    
    const charBounds = characterWindow.getBounds();
    const newChatSize = getScaledSize(baselineSizes.chat, currentSizePreset);
    const newX = charBounds.x - newChatSize.width - 50;
    const newY = charBounds.y - newChatSize.height + charBounds.height;
    chatWindow.setBounds({
      x: newX,
      y: newY,
      width: newChatSize.width,
      height: newChatSize.height,
    });
  });
  setTimeout(createTrayIcon, 300);

  // 初始化 MCP 系统
  initializeMCP().catch(err => {
    console.error('[Main] Failed to initialize MCP:', err);
  });
});




app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on("will-quit", async () => {
  globalShortcut.unregisterAll();
  // 清理 MCP 系统
  await cleanupMCP();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createChatWindow();
});