import express from 'express';
import { readData, writeData } from '../utils/jsonStorage.js';
import Conversation from '../models/Conversation.js';

const router = express.Router();
const CONVERSATIONS_FILE = 'conversations.json';

// Get all conversations
router.get('/', async (req, res) => {
  try {
    const conversations = await readData(CONVERSATIONS_FILE);
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create a new conversation
router.post('/', async (req, res) => {
  try {
    const conversations = await readData(CONVERSATIONS_FILE);
    const newConversation = new Conversation(
      null,
      req.body.petId,
      []
    );
    conversations.push(newConversation);
    await writeData(CONVERSATIONS_FILE, conversations);
    res.status(201).json(newConversation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Get conversations for a specific pet
router.get('/pets/:petId/conversations', async (req, res) => {
  try {
    const conversations = await readData(CONVERSATIONS_FILE);
    const petConversations = conversations.filter(c => c.petId === req.params.petId);
    res.json(petConversations);
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
    
    let conversations = await readData(CONVERSATIONS_FILE);
    
    // Sort conversations by the timestamp of the last message in history
    conversations.sort((a, b) => {
      const lastMessageA = a.history.length > 0 ? new Date(a.history[a.history.length - 1].timestamp) : new Date(a.createdAt);
      const lastMessageB = b.history.length > 0 ? new Date(b.history[b.history.length - 1].timestamp) : new Date(b.createdAt);
      return lastMessageB - lastMessageA; // Sort in descending order
    });

    const paginatedConversations = conversations.slice(skip, skip + limit);
    res.json(paginatedConversations);
  } catch ( error) {
    res.status(500).json({ message: error.message });
  }
});

// Get a specific conversation
router.get('/:_id', async (req, res) => {
  try {
    const conversations = await readData(CONVERSATIONS_FILE);
    const conversation = conversations.find(c => c._id === req.params._id);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add message to conversation
router.post('/:_id/messages', async (req, res) => {
  try {
    const conversations = await readData(CONVERSATIONS_FILE);
    const conversationIndex = conversations.findIndex(c => c._id === req.params._id);
    if (conversationIndex === -1) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    
    const message = {
      message: req.body.message
    };
    
    conversations[conversationIndex].history.push(message);
    await writeData(CONVERSATIONS_FILE, conversations);
    res.json(conversations[conversationIndex]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete a conversation
router.delete('/:_id', async (req, res) => {
  try {
    const conversations = await readData(CONVERSATIONS_FILE);
    const conversationIndex = conversations.findIndex(c => c._id === req.params._id);
    if (conversationIndex === -1) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    conversations.splice(conversationIndex, 1);
    await writeData(CONVERSATIONS_FILE, conversations);
    res.json({ message: 'Conversation deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update a conversation
router.put('/:_id', async (req, res) => {
  try {
    const conversations = await readData(CONVERSATIONS_FILE);
    const conversationIndex = conversations.findIndex(c => c._id === req.params._id);
    if (conversationIndex === -1) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const updatedConversation = {
      ...conversations[conversationIndex],
      ...req.body
    };

    conversations[conversationIndex] = updatedConversation;
    await writeData(CONVERSATIONS_FILE, conversations);
    res.json(updatedConversation);

  } catch (error) {
    res.status(500).json({ message: error.message});
  }
})

export default router;
