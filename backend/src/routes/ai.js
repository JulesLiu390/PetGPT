import express from 'express';
import GeminiService from '../LLMs/GeminiService.js';
import DalleService from '../LLMs/ImageGenerators/DalleService.js';
import StableDiffusionService from '../LLMs/ImageGenerators/StableDiffusionService.js';
import Pet from '../models/Pet.js';
import Conversation from '../models/Conversation.js';

const router = express.Router();

// Initialize services with environment variables
const geminiService = new GeminiService();
const dalleService = new DalleService();
const stableDiffusionService = new StableDiffusionService();

// Initialize services on first use
let servicesInitialized = false;
const initializeServices = async () => {
  if (!servicesInitialized) {
    try {
      await geminiService.initialize();
      await dalleService.initialize();
      await stableDiffusionService.initialize();
      servicesInitialized = true;
      console.log('AI services initialized successfully');
    } catch (error) {
      console.error('Error initializing AI services:', error);
      throw error;
    }
  }
};

/**
 * Generate text using Gemini
 * POST /api/ai/text
 * Body: { prompt: string, options?: object }
 */
router.post('/text', async (req, res) => {
  try {
    await initializeServices();
    
    const { prompt, options } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ message: 'Prompt is required' });
    }
    
    const response = await geminiService.generateText(prompt, options);
    
    res.json({
      text: response,
      model: 'gemini-pro'
    });
  } catch (error) {
    console.error('Error generating text:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Generate chat response using Gemini
 * POST /api/ai/chat
 * Body: { history: Array<{message: string, isUser: boolean}>, options?: object }
 */
router.post('/chat', async (req, res) => {
  try {
    await initializeServices();
    
    const { history, options } = req.body;
    
    if (!history || !Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ message: 'Valid conversation history is required' });
    }
    
    const response = await geminiService.generateChatResponse(history, options);
    
    res.json({
      text: response,
      model: 'gemini-pro'
    });
  } catch (error) {
    console.error('Error generating chat response:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Generate image using DALL-E or Stable Diffusion
 * POST /api/ai/image
 * Body: { prompt: string, model: 'dalle' | 'stable-diffusion', options?: object }
 */
router.post('/image', async (req, res) => {
  try {
    await initializeServices();
    
    const { prompt, model = 'dalle', options = {} } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ message: 'Prompt is required' });
    }
    
    let result;
    
    if (model === 'stable-diffusion') {
      result = await stableDiffusionService.generateImage(prompt, options);
    } else {
      // Default to DALL-E
      result = await dalleService.generateImage(prompt, options);
    }
    
    if (!result.success) {
      return res.status(500).json({ message: result.error });
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Generate image variations using DALL-E or Stable Diffusion
 * POST /api/ai/image/variations
 * Body: { imageUrl: string, model?: 'dalle' | 'stable-diffusion', options?: object }
 */
router.post('/image/variations', async (req, res) => {
  try {
    await initializeServices();
    
    const { imageUrl, model = 'dalle', options = {} } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ message: 'Image URL is required' });
    }
    
    let results;
    
    if (model === 'stable-diffusion') {
      results = await stableDiffusionService.generateVariations(imageUrl, options);
    } else {
      // Default to DALL-E
      results = await dalleService.generateVariations(imageUrl, options);
    }
    
    // Check if we got an error response
    if (!Array.isArray(results) && !results.success) {
      return res.status(500).json({ message: results.error });
    }
    
    res.json(Array.isArray(results) ? results : [results]);
  } catch (error) {
    console.error('Error generating image variations:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Generate chat response for a specific pet
 * POST /api/ai/pet/:id/chat
 * Body: { message: string, options?: object }
 */
router.post('/pet/:id/chat', async (req, res) => {
  try {
    await initializeServices();
    
    const { message, options = {} } = req.body;
    const petId = req.params.id;
    
    if (!message) {
      return res.status(400).json({ message: 'Message is required' });
    }
    
    // Get the pet
    const pet = await Pet.findById(petId);
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    
    // Get or create a conversation for this pet
    let conversation = await Conversation.findOne({ petId }).sort({ 'history.timestamp': -1 });
    
    if (!conversation) {
      conversation = new Conversation({
        petId,
        history: []
      });
    }
    
    // Add user message to conversation
    conversation.history.push({
      message,
      isUser: true,
      timestamp: new Date(),
      LLM: null
    });
    
    // Prepare context for the AI from pet's personality
    let petContext = '';
    if (pet.personality) {
      if (pet.personality.description) {
        petContext += `The pet's description: ${pet.personality.description}\n`;
      }
      if (pet.personality.mood) {
        petContext += `The pet's current mood: ${pet.personality.mood}\n`;
      }
    }
    
    // Format conversation history for Gemini
    const formattedHistory = conversation.history.map(msg => ({
      message: msg.message,
      isUser: msg.isUser
    }));
    
    // Add some system context if this is a new conversation
    if (formattedHistory.length <= 1) {
      formattedHistory.unshift({
        message: `You are ${pet.name}, a virtual pet. ${petContext}Respond in character to the user.`,
        isUser: false
      });
    }
    
    // Generate response
    const response = await geminiService.generateChatResponse(formattedHistory, options);
    
    // Add AI response to conversation
    conversation.history.push({
      message: response,
      isUser: false,
      timestamp: new Date(),
      LLM: 'gemini-pro'
    });
    
    // Save the conversation
    await conversation.save();
    
    res.json({
      message: response,
      model: 'gemini-pro',
      conversationId: conversation._id
    });
  } catch (error) {
    console.error('Error generating pet chat response:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Generate image for a pet
 * POST /api/ai/pet/:id/image
 * Body: { prompt: string, model?: 'dalle' | 'stable-diffusion', options?: object }
 */
router.post('/pet/:id/image', async (req, res) => {
  try {
    await initializeServices();
    
    const { prompt, model = 'dalle', options = {} } = req.body;
    const petId = req.params.id;
    
    if (!prompt) {
      return res.status(400).json({ message: 'Prompt is required' });
    }
    
    // Get the pet
    const pet = await Pet.findById(petId);
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    
    // Generate the image
    let result;
    if (model === 'stable-diffusion') {
      result = await stableDiffusionService.generateImage(prompt, options);
    } else {
      // Default to DALL-E
      result = await dalleService.generateImage(prompt, options);
    }
    
    if (!result.success) {
      return res.status(500).json({ message: result.error });
    }
    
    // Update the pet with the new image URL
    pet.img_LLM = result.url;
    await pet.save();
    
    res.json({
      ...result,
      petId: pet._id
    });
  } catch (error) {
    console.error('Error generating pet image:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
