const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');

// 保存路径：Documents/PetGPT_Data/settings.json
const filename = 'settings.json';
const filePath = path.join(app.getPath('documents') + '/PetGPT_Data', filename);

// 默认设置
const defaultSettings = {
  defaultRoleId: "",
  defaultModelId: "",
  windowSize: "medium",
  programHotkey: "shift+space",
  dialogHotkey: "shift+ctrl+space"
};

// 创建（初始化）设置文件
async function createSettings(settingsData = defaultSettings) {
  // 如果目录不存在则创建目录
  const dirPath = path.dirname(filePath);
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    console.error('Failed to create directory:', err);
    throw err;
  }
  // 写入设置数据
  await fs.writeFile(filePath, JSON.stringify(settingsData, null, 2), 'utf8');
  return settingsData;
}

// 更新设置文件：合并当前数据与更新内容，如果文件不存在则先创建
async function updateSettings(updatedData) {
  let currentSettings = {};
  try {
    const content = await fs.readFile(filePath, 'utf8');
    currentSettings = JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 文件不存在，先创建一个默认设置文件
      await createSettings();
      currentSettings = defaultSettings;
    } else {
      throw error;
    }
  }
  const newSettings = { ...currentSettings, ...updatedData };
  await fs.writeFile(filePath, JSON.stringify(newSettings, null, 2), 'utf8');
  return newSettings;
}

// 获取设置，每次直接读取整个 JSON 文件，如果不存在则自动创建
async function getSettings() {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 文件不存在，先创建并返回默认设置
      const settings = await createSettings();
      return settings;
    }
    throw error;
  }
}

module.exports = { createSettings, updateSettings, getSettings };