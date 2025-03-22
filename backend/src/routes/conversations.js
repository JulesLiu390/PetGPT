import express from 'express';
import Conversation from '../models/Conversation.js';

const router = express.Router();

// Create a new conversation
router.post('/', async (req, res) => {
  try {
    const conversation = new Conversation(req.body);
    await conversation.save();
    res.status(201).json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Get conversations for a specific pet
router.get('/pet/:petId', async (req, res) => {
  try {
    const conversations = await Conversation.find({ petId: req.params.petId });
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add message to conversation
router.post('/:id/messages', async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    conversation.history.push(req.body);
    await conversation.save();
    res.json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

export default router;
