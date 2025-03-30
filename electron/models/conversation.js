const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

// 定义数据存储文件夹：用户 Documents 下的 PetGPT_Data 文件夹
const dataFolderPath = path.join(app.getPath('documents'), 'PetGPT_Data');

// 检查数据存储文件夹是否存在，不存在则创建
async function ensureDataFolderExists() {
  try {
    await fs.access(dataFolderPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.mkdir(dataFolderPath, { recursive: true });
      console.log('文件夹已创建：', dataFolderPath);
    } else {
      throw error;
    }
  }
}

const filename = 'conversations.json';
// 拼接最终的文件路径
const filePath = path.join(dataFolderPath, filename);

/**
 * 读取 JSON 数据
 */
async function readData() {
  // 确保数据文件夹存在
  await ensureDataFolderExists();
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    // 如果文件不存在，则返回空数组
    if (err.code === 'ENOENT') {
      return [];
    } else {
      throw err;
    }
  }
}

/**
 * 写入 JSON 数据
 */
async function writeData(data) {
  // 确保数据文件夹存在
  await ensureDataFolderExists();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

class Conversation {
  constructor(_id, petId, title, history = []) {
    this._id = _id || uuidv4();
    this.petId = petId;
    this.title = title;
    this.history = history;
  }

  static async findAll() {
    return await readData();
  }

  static async findById(_id) {
    const conversations = await readData();
    return conversations.find(conv => conv._id === _id);
  }

  static async create(conversationData) {
    const conversations = await readData();
    const newConversation = new Conversation(
      null,
      conversationData.petId,
      conversationData.title,
      conversationData.history || []
    );
    conversations.push(newConversation);
    await writeData(conversations);
    return newConversation;
  }

  static async update(_id, updatedData) {
    const conversations = await readData();
    const index = conversations.findIndex(conv => conv._id === _id);
    if (index === -1) return null;

    const existing = conversations[index];
    const updated = new Conversation(
      existing._id,
      updatedData.petId || existing.petId,
      updatedData.title || existing.title,
      Array.isArray(updatedData.history) ? updatedData.history : existing.history
    );

    conversations[index] = updated;
    await writeData(conversations);
    return updated;
  }

  static async delete(_id) {
    const conversations = await readData();
    const index = conversations.findIndex(conv => conv._id === _id);
    if (index === -1) return null;

    const deleted = conversations.splice(index, 1)[0];
    await writeData(conversations);
    return deleted;
  }
}

module.exports = Conversation;