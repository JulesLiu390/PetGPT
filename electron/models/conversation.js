const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

const filename = 'conversations.json';
// 保存路径：用户的 Documents 文件夹
const filePath = path.join(app.getPath('documents'), filename);

/**
 * 读取 JSON 数据
 */
async function readData() {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
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