const { ipcMain, BrowserWindow } = require('electron');
const { exec } = require('child_process');
const { getSettings, updateSettings } = require('./models/settings');
const PetUserMemory = require('./models/pet_memory');
// const { ipcMain, BrowserWindow } = require('electron');

let sharedState = {
  characterMood: 'neutral',
  chatbodyStatus: ''
};

// 监听来自渲染进程的 "say-hello" 消息
ipcMain.on('say-hello', (event, command) => {
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`执行出错: ${error}`);
      return;
    }
    console.log(`输出: ${stdout}`);
  });
});

// 设置相关
ipcMain.handle('get-settings', async () => await getSettings());
ipcMain.handle('update-settings', async (event, data) => {
  console.log("Received update data:", data);
  const newSettings = await updateSettings(data);
  console.log("New settings:", newSettings);
  return newSettings;
});

// PetUserMemory 相关 - 获取宠物对用户的全部记忆
ipcMain.handle('get-pet-user-memory', async (event, petId) => {
  try {
    const memory = await PetUserMemory.findByPetId(petId);
    return memory;
  } catch (error) {
    console.error('Failed to get pet user memory:', error);
    throw error;
  }
});

// 设置宠物对用户的完整记忆
ipcMain.handle('set-pet-user-memory', async (event, { petId, memoryData }) => {
  try {
    const updatedMemory = await PetUserMemory.setMemory(petId, memoryData);
    return updatedMemory;
  } catch (error) {
    console.error('Failed to set pet user memory:', error);
    throw error;
  }
});

// 更新宠物对用户记忆中的特定信息
ipcMain.handle('update-pet-user-memory', async (event, { petId, key, value }) => {
  try {
    const updatedMemory = await PetUserMemory.updateMemory(petId, key, value);
    return updatedMemory;
  } catch (error) {
    console.error('Failed to update pet user memory:', error);
    throw error;
  }
});

// 删除宠物对用户记忆中的特定信息
ipcMain.handle('delete-pet-user-memory-key', async (event, { petId, key }) => {
  try {
    const updatedMemory = await PetUserMemory.deleteMemoryKey(petId, key);
    return updatedMemory;
  } catch (error) {
    console.error('Failed to delete pet user memory key:', error);
    throw error;
  }
});

// 获取宠物对用户的特定记忆信息
ipcMain.handle('get-pet-user-memory-value', async (event, { petId, key }) => {
  try {
    const value = await PetUserMemory.getMemoryValue(petId, key);
    return value;
  } catch (error) {
    console.error('Failed to get pet user memory value:', error);
    throw error;
  }
});

// chatbody更新
ipcMain.on('update-chatbody-status', (event, status) => {
  console.log("Received status update:", status);
  sharedState.chatbodyStatus = status;
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('chatbody-status-updated', status));
});