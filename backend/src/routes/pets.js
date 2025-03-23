import express from 'express';
import { readData, writeData } from '../utils/jsonStorage.js';
import Pet from '../models/Pet.js';

const router = express.Router();
const PETS_FILE = 'pets.json';

// Create a new pet
router.post('/', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    const newPet = new Pet(
      null,
      req.body.name,
      req.body.img_LLM,
      req.body.voice_LLM,
      req.body.personality
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

// Get a specific pet
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

// Update a pet's information
router.patch('/:_id', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    const petIndex = pets.findIndex(p => p._id === req.params._id);
    if (petIndex === -1) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    const updatedPet = { ...pets[petIndex], ...req.body };
    pets[petIndex] = updatedPet;
    await writeData(PETS_FILE, pets);
    res.json(updatedPet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update a pet's personality
router.patch('/:_id/personality', async (req, res) => {
  try {
    const pets = await readData(PETS_FILE);
    const petIndex = pets.findIndex(p => p._id === req.params._id);

    if (petIndex === -1) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    const updatedPet = { ...pets[petIndex] };
    updatedPet.personality = { ...updatedPet.personality, ...req.body};
    pets[petIndex] = updatedPet;

    await writeData(PETS_FILE, pets);
    res.json(updatedPet);
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
    pets.splice(petIndex, 1);
    await writeData(PETS_FILE, pets);
    res.json({ message: 'Pet deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
