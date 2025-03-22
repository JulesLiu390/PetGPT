import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMService } from './llm.js';

/**
 * Gemini Service Implementation
 * This class implements the LLMService interface using Google's Gemini API
 */
export class GeminiService extends LLMService {
  constructor(config = {}) {
    super(config);
    this.modelName = config.modelName || 'gemini-pro';
    this.client = null;
    this.model = null;
  }

  /**
   * Initialize the Gemini service
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('Gemini API key is required. Set GOOGLE_API_KEY environment variable or pass in config');
    }

    try {
      this.client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
      this.model = this.client.getGenerativeModel({ model: this.modelName });
      console.log(`Gemini service initialized with model: ${this.modelName}`);
    } catch (error) {
      console.error('Failed to initialize Gemini service:', error);
      throw error;
    }
  }

  /**
   * Generate a text response from Gemini
   * @param {string} prompt - The prompt to send to Gemini
   * @param {Object} options - Additional options for generation
   * @returns {Promise<string>} - The generated response
   */
  async generateText(prompt, options = {}) {
    if (!this.model) {
      await this.initialize();
    }

    try {
      const generationConfig = {
        temperature: options.temperature || 0.7,
        topK: options.topK || 40,
        topP: options.topP || 0.95,
        maxOutputTokens: options.maxTokens || 1024,
      };

      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      });

      const response = result.response;
      return response.text();
    } catch (error) {
      console.error('Error generating text with Gemini:', error);
      throw error;
    }
  }

  /**
   * Generate a chat response from conversation history using Gemini
   * @param {Array} history - Array of message objects with role and content
   * @param {Object} options - Additional options for the generation
   * @returns {Promise<string>} - The generated response
   */
  async generateChatResponse(history, options = {}) {
    if (!this.model) {
      await this.initialize();
    }

    try {
      const generationConfig = {
        temperature: options.temperature || 0.7,
        topK: options.topK || 40,
        topP: options.topP || 0.95,
        maxOutputTokens: options.maxTokens || 1024,
      };

      // Convert history to Gemini format
      const formattedHistory = history.map(msg => ({
        role: msg.isUser ? 'user' : 'model',
        parts: [{ text: msg.message }]
      }));

      // Start a chat session
      const chat = this.model.startChat({
        generationConfig,
        history: formattedHistory.slice(0, -1), // All but the last message
      });

      // Send the last message to get a response
      const lastMessage = formattedHistory[formattedHistory.length - 1];
      const result = await chat.sendMessage(lastMessage.parts[0].text);
      
      return result.response.text();
    } catch (error) {
      console.error('Error generating chat response with Gemini:', error);
      throw error;
    }
  }
}

export default GeminiService;
