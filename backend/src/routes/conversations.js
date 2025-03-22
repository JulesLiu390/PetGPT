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
    const conversations = await Conversation.find({ petId: req.params.petId })
      .sort({ updatedAt: -1 });
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get recent conversations (with pagination)
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    
    const conversations = await Conversation.find()
      .sort({ 'history.timestamp': -1 })
      .skip(skip)
      .limit(limit);
      
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get a specific conversation
router.get('/:id', async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    
    res.json(conversation);
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
    
    const message = {
      ...req.body,
      timestamp: new Date()
    };
    
    conversation.history.push(message);
    await conversation.save();
    res.json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete a conversation
router.delete('/:id', async (req, res) => {
  try {
    const conversation = await Conversation.findByIdAndDelete(req.params.id);
    
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    
    res.json({ message: 'Conversation deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
