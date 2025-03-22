import express from 'express';
import Pet from '../models/Pet.js';

const router = express.Router();

// Create a new pet
router.post('/', async (req, res) => {
  try {
    const pet = new Pet(req.body);
    await pet.save();
    res.status(201).json(pet);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Get all pets
router.get('/', async (req, res) => {
  try {
    const pets = await Pet.find();
    res.json(pets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get a specific pet
router.get('/:id', async (req, res) => {
  try {
    const pet = await Pet.findById(req.params.id);
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    res.json(pet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update a pet's information
router.patch('/:id', async (req, res) => {
  try {
    const updates = req.body;
    const pet = await Pet.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true }
    );
    
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    
    res.json(pet);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update a pet's personality
router.patch('/:id/personality', async (req, res) => {
  try {
    const updates = req.body;
    const pet = await Pet.findByIdAndUpdate(
      req.params.id, 
      { 'personality': updates },
      { new: true }
    );
    
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    
    res.json(pet);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete a pet
router.delete('/:id', async (req, res) => {
  try {
    const pet = await Pet.findByIdAndDelete(req.params.id);
    
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    
    res.json({ message: 'Pet deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
