const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

// 保存路径：Documents/pets.json
const filename = 'pets.json';
const filePath = path.join(app.getPath('documents'), filename);

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

  static async findAll() {
    return await readData();
  }

  static async findById(_id) {
    const pets = await readData();
    return pets.find(pet => pet._id === _id);
  }

  static async create(petData) {
    const pets = await readData();
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
    await writeData(pets);
    return newPet;
  }

  static async update(_id, updatedPetData) {
    const pets = await readData();
    const index = pets.findIndex(p => p._id === _id);
    if (index === -1) return null;

    if (updatedPetData.personality && typeof updatedPetData.personality === 'object') {
      updatedPetData.personality = updatedPetData.personality.description || '';
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