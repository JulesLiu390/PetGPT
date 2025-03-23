import { readData, writeData } from '../utils/jsonStorage.js';
import { v4 as uuidv4 } from 'uuid';

const filename = 'conversations.json';

class Conversation {
  /**
   * 创建一个 Conversation 实例
   * @param {string} _id - 唯一标识，若为空则自动生成
   * @param {string} petId - 对应宠物/角色的 ID
   * @param {string} title - 会话标题
   * @param {array} history - 对话历史消息数组
   */
  constructor(_id, petId, title, history = []) {
    this._id = _id || uuidv4();
    this.petId = petId;
    this.title = title;
    this.history = history;
  }

  static async findAll() {
    return await readData(filename);
  }

  static async findById(_id) {
    const conversations = await readData(filename);
    return conversations.find(conv => conv._id === _id);
  }

  static async create(conversationData) {
    const conversations = await readData(filename);
    const newConversation = new Conversation(
      null,
      conversationData.petId,
      conversationData.title,
      conversationData.history || []
    );
    conversations.push(newConversation);
    await writeData(filename, conversations);
    return newConversation;
  }

  static async update(_id, updatedConversationData) {
    let conversations = await readData(filename);
    const convIndex = conversations.findIndex(conv => conv._id === _id);
    if (convIndex !== -1) {
      // 如果 updatedConversationData.history 存在且是数组，就更新，否则保持原有
      const updatedHistory = Array.isArray(updatedConversationData.history)
        ? updatedConversationData.history
        : conversations[convIndex].history;

      conversations[convIndex] = {
        ...conversations[convIndex],
        ...updatedConversationData,
        history: updatedHistory
      };
      await writeData(filename, conversations);
      return conversations[convIndex];
    }
    return null;
  }

  static async delete(_id) {
    let conversations = await readData(filename);
    const convIndex = conversations.findIndex(conv => conv._id === _id);
    if (convIndex !== -1) {
      const deletedConv = conversations.splice(convIndex, 1)[0];
      await writeData(filename, conversations);
      return deletedConv;
    }
    return null;
  }
}

export default Conversation;