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
    // 读取现有的所有会话数据
    let conversations = await readData(filename);
  
    // 查找目标会话的索引位置
    const convIndex = conversations.findIndex(conv => conv._id === _id);
    if (convIndex === -1) return null;
  
    const existingConversation = conversations[convIndex];
  
    // 构建更新后的 history，若传入的是有效数组则使用，否则保留原来的
    const updatedHistory = Array.isArray(updatedConversationData.history)
      ? updatedConversationData.history
      : existingConversation.history;
  
    // 合并更新后的数据，保留原有 _id 不变
    const updatedConversation = new Conversation(
      existingConversation._id,
      updatedConversationData.petId || existingConversation.petId,
      updatedConversationData.title || existingConversation.title,
      updatedHistory
    );
  
    // 替换原有的会话对象
    conversations[convIndex] = updatedConversation;
  
    // 写入文件
    await writeData(filename, conversations);
  
    return updatedConversation;
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