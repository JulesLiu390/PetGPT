import { readData, writeData } from '../utils/jsonStorage.js';
import { v4 as uuidv4 } from 'uuid';

const filename = 'pets.json';

class Pet {
  constructor(_id, name, img_LLM, voice_LLM, personality = {}) {
    this._id = _id || uuidv4();
    this.name = name;
    this.img_LLM = img_LLM || 'dall-e-3';
    this.voice_LLM = voice_LLM || 'elevenlabs';
    this.personality = {
      description: personality.description || '',
      mood: personality.mood || 'neutral',
      ...personality
    };
  }

  static async findAll() {
    return await readData(filename);
  }

  static async findById(_id) {
    const pets = await readData(filename);
    return pets.find(pet => pet._id === _id);
  }

  static async create(petData) {
    const pets = await readData(filename);
    const newPet = new Pet(null, petData.name, petData.img_LLM, petData.voice_LLM, petData.personality);
    pets.push(newPet);
    await writeData(filename, pets);
    return newPet;
  }

  static async update(_id, updatedPetData) {
    let pets = await readData(filename);
    const petIndex = pets.findIndex(pet => pet._id === _id);
    if (petIndex !== -1) {
      pets[petIndex] = { ...pets[petIndex], ...updatedPetData };
      await writeData(filename, pets);
      return pets[petIndex];
    }
    return null;
  }

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
