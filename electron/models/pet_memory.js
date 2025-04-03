const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');

// 保存路径：Documents/PetGPT_Data/pet_user_memories.json
const filename = 'pet_user_memories.json';
const dirPath = path.join(app.getPath('documents'), 'PetGPT_Data');
const filePath = path.join(dirPath, filename);

// 确保目录存在的函数
async function ensureDirectoryExists() {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    console.error('Failed to create directory:', err);
    throw err; // 重新抛出错误以便上层捕获
  }
}

// 读取 JSON 数据
async function readData() {
  // 先确保目录存在
  await ensureDirectoryExists();
  
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 如果文件不存在，返回空对象（每个petId对应一个关于用户的记忆对象）
      return {};
    }
    throw error;
  }
}

// 写入 JSON 数据
async function writeData(data) {
  // 先确保目录存在
  await ensureDirectoryExists();
  
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

class PetUserMemory {
  /**
   * 查找指定宠物对用户的全部记忆
   * @param {string} petId 宠物ID
   * @returns {Object} 宠物对用户的记忆对象
   */
  static async findByPetId(petId) {
    const memories = await readData();
    return memories[petId] || {};
  }

  /**
   * 创建或更新宠物对用户的整个记忆对象
   * @param {string} petId 宠物ID
   * @param {Object} memoryData 完整的用户记忆数据对象
   * @returns {Object} 更新后的用户记忆对象
   */
  static async setMemory(petId, memoryData) {
    const memories = await readData();
    memories[petId] = memoryData;
    await writeData(memories);
    return memories[petId];
  }

  /**
   * 更新宠物对用户记忆中的特定信息
   * @param {string} petId 宠物ID
   * @param {string} key 要更新的记忆键（例如：用户名、爱好、喜欢的食物等）
   * @param {any} value 要设置的值
   * @returns {Object} 更新后的完整用户记忆对象
   */
  static async updateMemory(petId, key, value) {
    const memories = await readData();
    // 如果该宠物没有用户记忆数据，创建一个空对象
    if (!memories[petId]) {
      memories[petId] = {};
    }
    // 更新指定的用户记忆信息
    memories[petId][key] = value;
    await writeData(memories);
    return memories[petId];
  }

  /**
   * 删除宠物对用户记忆中的特定信息
   * @param {string} petId 宠物ID
   * @param {string} key 要删除的记忆键
   * @returns {Object} 更新后的完整用户记忆对象
   */
  static async deleteMemoryKey(petId, key) {
    const memories = await readData();
    // 如果该宠物没有用户记忆数据，返回空对象
    if (!memories[petId]) {
      return {};
    }
    // 删除指定的用户记忆信息
    if (memories[petId][key] !== undefined) {
      delete memories[petId][key];
    }
    await writeData(memories);
    return memories[petId];
  }

  /**
   * 获取宠物对用户的特定记忆信息
   * @param {string} petId 宠物ID
   * @param {string} key 记忆键（例如：用户名、生日、重要事件等）
   * @returns {any} 记忆值，如果不存在则返回undefined
   */
  static async getMemoryValue(petId, key) {
    const memories = await readData();
    if (!memories[petId]) {
      return undefined;
    }
    return memories[petId][key];
  }
}

module.exports = PetUserMemory;