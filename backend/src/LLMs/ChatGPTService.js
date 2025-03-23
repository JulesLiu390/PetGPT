import OpenAI from 'openai';
import { LLMService } from './llm.js';

export class ChatGPTService extends LLMService {
  constructor(config = {}) {
    super(config);
    this.modelName = config.modelName || 'gpt-3.5-turbo';
    this.client = null;
  }

  async initialize() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable');
    }

    try {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
      console.log(`ChatGPT service initialized with model: ${this.modelName}`);
    } catch (error) {
      console.error('Failed to initialize ChatGPT service:', error);
      throw error;
    }
  }

  async generateText(prompt, options = {}) {
    if (!this.client) {
      await this.initialize();
    }

    try {
      const completion = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 1024,
        top_p: options.topP || 1,
      });

      return completion.choices[0].message.content;
    } catch (error) {
      console.error('Error generating text with ChatGPT:', error);
      throw error;
    }
  }

  async generateChatResponse(history, options = {}) {
    if (!this.client) {
      await this.initialize();
    }

    try {
      const formattedHistory = history.map(msg => ({
        role: msg.isUser ? 'user' : 'assistant',
        content: msg.message
      }));

      const completion = await this.client.chat.completions.create({
        model: this.modelName,
        messages: formattedHistory,
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 1024,
        top_p: options.topP || 1,
      });

      return completion.choices[0].message.content;
    } catch (error) {
      console.error('Error generating chat response with ChatGPT:', error);
      throw error;
    }
  }
}

export default ChatGPTService;
