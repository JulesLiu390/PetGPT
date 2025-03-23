import { readData, writeData } from '../utils/jsonStorage.js';
import { v4 as uuidv4 } from 'uuid';

const filename = 'conversations.json';

class Conversation {
  constructor(_id, petId, history = []) {
    this._id = _id || uuidv4();
    this.petId = petId;
    this.history = history.map(msg => ({
      message: msg.message,
      isUser: msg.isUser,
      timestamp: msg.timestamp || new Date().toISOString(),
      LLM: msg.LLM || 'gemini-1.5'
    }));
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
    const newConversation = new Conversation(null, conversationData.petId, conversationData.history);
    conversations.push(newConversation);
    await writeData(filename, conversations);
    return newConversation;
  }

  static async update(_id, updatedConversationData) {
    let conversations = await readData(filename);
    const convIndex = conversations.findIndex(conv => conv._id === _id);
    if (convIndex !== -1) {
      conversations[convIndex] = { ...conversations[convIndex], ...updatedConversationData };
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
