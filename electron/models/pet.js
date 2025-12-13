const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

// 保存路径：Documents/pets.json
const filename = 'pets.json';
const filePath = path.join(app.getPath('documents') + '/PetGPT_Data', filename);

// 读取 JSON 数据
async function readData() {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// 写入 JSON 数据
async function writeData(data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

class Pet {
  constructor(
    _id,
    name,
    systemInstruction,
    appearance,
    imageName,
    modelProvider,
    modelName,
    modelApiKey,
    modelUrl,
    isAgent,
    apiFormat,
    hasMood
  ) {
    this._id = _id || uuidv4();
    this.name = name || '';
    this.systemInstruction = systemInstruction || ''; // 原 personality，改为 systemInstruction
    this.appearance = appearance || '';
    this.imageName = imageName || '';
    this.modelProvider = modelProvider || ''; // 保留旧字段以兼容
    this.apiFormat = apiFormat || ''; // 新字段：'openai_compatible' | 'gemini_official'
    this.modelName = modelName || '';
    this.modelApiKey = modelApiKey || '';
    this.modelUrl = modelUrl || 'default';
    this.isAgent = typeof isAgent === 'boolean' ? isAgent : false;
    // hasMood: 是否启用情绪表情，向后兼容：如果未设置则根据 !isAgent 判断
    this.hasMood = typeof hasMood === 'boolean' ? hasMood : !this.isAgent;
  }

  static async findAll() {
    return await readData();
  }

  static async findById(_id) {
    const pets = await readData();
    return pets.find(pet => pet._id === _id);
  }

  static async create(petData) {
    const pets = await readData();
    // 向后兼容：支持 personality 或 systemInstruction
    const sysInstr = petData.systemInstruction || petData.personality || '';
    const newPet = new Pet(
      null,
      petData.name,
      sysInstr,
      petData.appearance,
      petData.imageName,
      petData.modelProvider,
      petData.modelName,
      petData.modelApiKey,
      petData.modelUrl,
      petData.isAgent,
      petData.apiFormat,
      petData.hasMood
    );
    pets.push(newPet);
    await writeData(pets);
    return newPet;
  }

  static async update(_id, updatedPetData) {
    const pets = await readData();
    const index = pets.findIndex(p => p._id === _id);
    if (index === -1) return null;

    // 向后兼容：支持 personality 或 systemInstruction
    if (updatedPetData.personality && !updatedPetData.systemInstruction) {
      updatedPetData.systemInstruction = updatedPetData.personality;
      delete updatedPetData.personality;
    }
    // 如果 systemInstruction 是对象，则取其 description 属性
    if (updatedPetData.systemInstruction && typeof updatedPetData.systemInstruction === 'object') {
      updatedPetData.systemInstruction = updatedPetData.systemInstruction.description || '';
    }

    pets[index] = {
      ...pets[index],
      ...updatedPetData
    };

    await writeData(pets);
    return pets[index];
  }

  static async delete(_id) {
    const pets = await readData();
    const index = pets.findIndex(p => p._id === _id);
    if (index === -1) return null;

    const deleted = pets.splice(index, 1)[0];
    await writeData(pets);
    return deleted;
  }
}

module.exports = Pet;