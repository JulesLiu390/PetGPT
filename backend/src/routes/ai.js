import express from 'express';
import GeminiService from '../LLMs/GeminiService.js';
import ChatGPTService from '../LLMs/ChatGPTService.js';
import DalleService from '../LLMs/ImageGenerators/DalleService.js';
import StableDiffusionService from '../LLMs/ImageGenerators/StableDiffusionService.js';
import { readData, writeData } from '../utils/jsonStorage.js';
import Conversation from '../models/Conversation.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const PETS_FILE = 'pets.json';
const CONVERSATIONS_FILE = 'conversations.json';


// Initialize services with environment variables
const geminiService = new GeminiService();
const chatGPTService = new ChatGPTService();
const dalleService = new DalleService();
const stableDiffusionService = new StableDiffusionService();

// Initialize services on first use
let servicesInitialized = false;
const initializeServices = async () => {
  if (!servicesInitialized) {
    try {
    await geminiService.initialize();
    await chatGPTService.initialize();
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
    
    // Use ChatGPT by default, fallback to Gemini if OpenAI key not set
    let response;
    try {
      response = await chatGPTService.generateText(prompt, options);
    } catch (error) {
      console.log('Falling back to Gemini:', error.message);
      response = await geminiService.generateText(prompt, options);
    }
    
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
    
    // Use ChatGPT by default, fallback to Gemini if OpenAI key not set
    let response;
    try {
      response = await chatGPTService.generateChatResponse(history, options);
    } catch (error) {
      console.log('Falling back to Gemini:', error.message);
      response = await geminiService.generateChatResponse(history, options);
    }
    
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
    const pets = await readData(PETS_FILE);
    const pet = pets.find(p => p._id === petId);
    if (!pet) {
      return res.status(404).json({ message: 'Pet not found' });
    }
    
    // Get or create a conversation for this pet
    let conversations = await readData(CONVERSATIONS_FILE);
    let conversation = conversations.find(c => c.petId === petId);
    
    if (!conversation) {
      conversation = new Conversation(
        uuidv4(),
        petId,
        []
      );
      conversations.push(conversation);
    }

    
    // Add user message to conversation
    conversation.history.push(message);

    // Prepare context for the AI from pet's personality
    let petContext = '';
    if (pet.personality) {
      petContext += `The pet's personality: ${pet.personality}\n`;
    }

    // Format conversation history for Gemini
    const formattedHistory = conversation.history.map(msg => ({
      message: msg
    }));
    
    // Add some system context if this is a new conversation
    if (formattedHistory.length <= 1) {
      formattedHistory.unshift({
        message: `You are ${pet.name}, a virtual pet. ${petContext}Respond in character to the user.`,
        isUser: false
      });
    }
    
    // Generate response
    // Use ChatGPT by default, fallback to Gemini if OpenAI key not set
    let response;
    try {
      response = await chatGPTService.generateChatResponse(formattedHistory, options);
    } catch (error) {
      console.log('Falling back to Gemini:', error.message);
      response = await geminiService.generateChatResponse(formattedHistory, options);
    }
    
    // Add AI response to conversation
    conversation.history.push(response);
    
    // Save the conversation
    await writeData(CONVERSATIONS_FILE, conversations);
    
    res.json({
      message: response,
      model: 'gemini-pro',
      petId,
      conversationId: conversation.id
    });
  } catch (error) {
    console.error('Error generating pet chat response:', error);
    res.status(500).json({ message: error.message });
  }
});

// New endpoint with strict conversation validation
router.post('/conversation/:conversationId/chat', async (req, res) => {
  try {
    await initializeServices();

    const { message, options = {} } = req.body;
    const conversationId = req.params.conversationId;

    if (!message) {
      return res.status(400).json({ message: 'Message is required' });
    }

    // Validate conversation exists and belongs to pet
    const conversations = await readData(CONVERSATIONS_FILE);
    const conversation = conversations.find(c =>
      c._id === conversationId
    );

    if (!conversation) {
      return res.status(404).json({
        message: 'Conversation not found'
      });
    }
    
    // Find pet to use its name and personality
    const pets = await readData(PETS_FILE);
    const pet = pets.find(p => p._id === conversation.petId);

    // Add user message to conversation
    conversation.history.push(message);

    // Prepare context for the AI from pet's personality
    let petContext = '';
    if (pet?.personality) {
      petContext += `The pet's personality: ${pet.personality}\n`;
    }

    // Format conversation history for Gemini
    const formattedHistory = conversation.history.map(msg => ({
      message: msg
    }));

    // Add some system context if this is a new conversation
    if (formattedHistory.length <= 1) {
      formattedHistory.unshift({
        message: `You are ${pet?.name || 'a virtual pet'}, a virtual pet. ${petContext}Respond in character to the user.`,
        isUser: false
      });
    }

    // Generate response
    // Use ChatGPT by default, fallback to Gemini if OpenAI key not set
    let response;
    try {
      response = await chatGPTService.generateChatResponse(formattedHistory, options);
    } catch (error) {
      console.log('Falling back to Gemini:', error.message);
      response = await geminiService.generateChatResponse(formattedHistory, options);
    }

    // Add AI response to conversation
    conversation.history.push(response);

    // Save the conversation
    await writeData(CONVERSATIONS_FILE, conversations);

    res.json({
      message: response,
      model: 'gemini-pro',
      conversationId: conversation.id
    });
  } catch (error) {
    console.error('Error generating pet chat response:', error);
    res.status(500).json({ message: error.message });
  }
});

// New endpoint with strict conversation validation

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
    const pets = await readData(PETS_FILE);
    const pet = pets.find(p => p._id === petId);
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
    pet.imageName = result.url;
    await writeData(PETS_FILE, pets);
    
    res.json({
      ...result,
      petId: petId
    });
  } catch (error) {
    console.error('Error generating pet image:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
