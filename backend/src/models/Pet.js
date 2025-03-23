import { readData, writeData } from '../utils/jsonStorage.js';
import { v4 as uuidv4 } from 'uuid';

// 定义存储数据的 JSON 文件名
const filename = 'pets.json';

class Pet {
  /**
   * 创建一个 Pet（角色/宠物）实例
   * @param {string} _id - 唯一标识，如果为空则自动生成
   * @param {string} name - 角色名称
   * @param {string} personality - 人格描述（单一字符串）
   * @param {string} appearance - 外观描述
   * @param {string} imageName - 图片 URL
   * @param {string} modelName - 模型名称（例如 "OpenAI-GPT"）
   * @param {string} modelApiKey - 模型 API Key
   * @param {string} modelProvider - 模型提供商（例如 "OpenAI"）
   */
  constructor(_id, name, personality, appearance, imageName, modelName, modelApiKey, modelProvider) {
    this._id = _id || uuidv4();
    this.name = name || '';
    this.personality = personality || '';
    this.appearance = appearance || '';
    this.imageName = imageName || '';
    this.modelName = modelName || '';
    this.modelApiKey = modelApiKey || '';
    this.modelProvider = modelProvider || '';
  }

  /**
   * 获取所有角色/宠物
   * @returns {Promise<Array<Pet>>}
   */
  static async findAll() {
    return await readData(filename);
  }

  /**
   * 根据 ID 查找指定角色/宠物
   * @param {string} _id - 角色/宠物的 ID
   * @returns {Promise<Pet | undefined>}
   */
  static async findById(_id) {
    const pets = await readData(filename);
    return pets.find(pet => pet._id === _id);
  }

  /**
   * 创建一个新的角色/宠物
   * @param {object} petData - 包含 {name, personality, appearance, imageName, modelName, modelApiKey, modelProvider} 等字段
   * @returns {Promise<Pet>} 返回创建后的角色/宠物实例
   */
  static async create(petData) {
    const pets = await readData(filename);
    // 这里假设 petData.personality 已经是字符串
    const newPet = new Pet(
      null, 
      petData.name, 
      petData.personality, 
      petData.appearance, 
      petData.imageName,
      petData.modelName,
      petData.modelApiKey,
      petData.modelProvider
    );
    pets.push(newPet);
    await writeData(filename, pets);
    return newPet;
  }

  /**
   * 更新指定角色/宠物
   * @param {string} _id - 角色/宠物的 ID
   * @param {object} updatedPetData - 要更新的字段，如 {name, personality, appearance, imageName, modelName, modelApiKey, modelProvider} 等
   * @returns {Promise<Pet | null>} 返回更新后的角色/宠物，若未找到则返回 null
   */
  static async update(_id, updatedPetData) {
    let pets = await readData(filename);
    const petIndex = pets.findIndex(pet => pet._id === _id);
    if (petIndex !== -1) {
      // 如果 personality 是对象，则提取 description 字段
      if (updatedPetData.personality && typeof updatedPetData.personality === 'object') {
        updatedPetData.personality = updatedPetData.personality.description || '';
      }
      pets[petIndex] = { ...pets[petIndex], ...updatedPetData };
      await writeData(filename, pets);
      return pets[petIndex];
    }
    return null;
  }

  /**
   * 删除指定角色/宠物
   * @param {string} _id - 角色/宠物的 ID
   * @returns {Promise<Pet | null>} 返回被删除的角色/宠物，若未找到则返回 null
   */
  static async delete(_id) {
    let pets = await readData(filename);
    const petIndex = pets.findIndex(pet => pet._id === _id);
    if (petIndex !== -1) {
      const deletedPet = pets.splice(petIndex, 1)[0];
      await writeData(filename, pets);
      return deletedPet;
    }
    return null;
  }
}

export default Pet;
