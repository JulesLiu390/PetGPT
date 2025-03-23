/**
 * Base LLM Service Interface
 * This abstract class defines the common interface for all LLM services
 */
export class LLMService {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Initialize the LLM service
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('Method not implemented: initialize()');
  }

  /**
   * Generate a text response from the LLM
   * @param {string} prompt - The prompt to send to the LLM
   * @param {Object} options - Additional options for the generation
   * @returns {Promise<string>} - The generated response
   */
  async generateText(prompt, options = {}) {
    throw new Error('Method not implemented: generateText()');
  }

  /**
   * Generate a chat response from conversation history
   * @param {Array} history - Array of message objects with role and content
   * @param {Object} options - Additional options for the generation
   * @returns {Promise<string>} - The generated response
   */
  async generateChatResponse(history, options = {}) {
    throw new Error('Method not implemented: generateChatResponse()');
  }
}

/**
 * Base Image Generator Interface
 * This abstract class defines the common interface for all image generation services
 */
export class ImageGeneratorService {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Initialize the image generator service
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('Method not implemented: initialize()');
  }

  /**
   * Generate an image from a text prompt
   * @param {string} prompt - The text prompt describing the image
   * @param {Object} options - Additional options for the generation (size, style, etc)
   * @returns {Promise<Object>} - Object containing the generated image URL and metadata
   */
  async generateImage(prompt, options = {}) {
    throw new Error('Method not implemented: generateImage()');
  }

  /**
   * Generate variations of an existing image
   * @param {string} imageUrl - URL or base64 of the source image
   * @param {Object} options - Additional options for the variation (count, similarity, etc)
   * @returns {Promise<Array>} - Array of objects containing the generated image URLs and metadata
   */
  async generateVariations(imageUrl, options = {}) {
    throw new Error('Method not implemented: generateVariations()');
  }
}
