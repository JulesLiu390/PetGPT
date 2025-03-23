import express from 'express';
import { readData, writeData } from '../utils/jsonStorage.js';
import Pet from '../models/Pet.js';

const router = express.Router();
const PETS_FILE = 'pets.json';

// Create a new pet
router.post('/', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    // 处理 personality：如果传入的是对象，则取 description 字段，否则直接使用传入值
    let personality = '';
    if (req.body.personality) {
      personality = typeof req.body.personality === 'object'
        ? req.body.personality.description || ''
        : req.body.personality;
    }
    // 构造新宠物实例，注意字段顺序：name, personality, appearance, imageName, modelName, modelApiKey, modelProvider
    const newPet = new Pet(
      null, 
      req.body.name,
      personality,
      req.body.appearance,
      req.body.imageName,
      req.body.modelName,
      req.body.modelApiKey,
      req.body.modelProvider
    );
    pets.push(newPet);
    await writeData(PETS_FILE, pets);
    res.status(201).json(newPet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all pets
router.get('/', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    res.json(pets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get a specific pet by _id
router.get('/:_id', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    const pet = pets.find(p => p._id === req.params._id);
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    res.json(pet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update a pet's information (excluding personality update)
router.patch('/:_id', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    const petIndex = pets.findIndex(p => p._id === req.params._id);
    if (petIndex === -1) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    let updatedData = { ...req.body };
    // 处理 personality 字段：如果为对象，则提取 description 字段
    if (updatedData.personality && typeof updatedData.personality === 'object') {
      updatedData.personality = updatedData.personality.description || '';
    }
    const updatedPet = { ...pets[petIndex], ...updatedData };
    pets[petIndex] = updatedPet;
    await writeData(PETS_FILE, pets);
    res.json(updatedPet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update a pet's personality only
router.patch('/:_id/personality', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    const petIndex = pets.findIndex(p => p._id === req.params._id);
    if (petIndex === -1) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    let newPersonality = '';
    if (typeof req.body === 'object') {
      newPersonality = req.body.description || '';
    } else {
      newPersonality = req.body;
    }
    pets[petIndex].personality = newPersonality;
    await writeData(PETS_FILE, pets);
    res.json(pets[petIndex]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete a pet
router.delete('/:_id', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    const petIndex = pets.findIndex(p => p._id === req.params._id);
    if (petIndex === -1) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    const deletedPet = pets.splice(petIndex, 1)[0];
    await writeData(PETS_FILE, pets);
    res.json({ message: 'Pet deleted successfully', pet: deletedPet });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;