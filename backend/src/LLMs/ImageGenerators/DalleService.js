import OpenAI from 'openai';
import { BaseImageService } from './BaseImageService.js';

/**
 * DALL-E Service Implementation
 * This class implements the Image Generator interface using OpenAI's DALL-E API
 */
export class DalleService extends BaseImageService {
  constructor(config = {}) {
    super(config);
    this.modelName = config.modelName || 'dall-e-3';
    this.client = null;
    this.serviceName = 'dalle';
    // DALL-E 3 only supports 1024x1024, 1024x1792, or 1792x1024
    this.defaultSize = config.defaultSize || '1024x1024';
    this.quality = config.quality || 'standard'; // 'standard' or 'hd'
    this.style = config.style || 'vivid'; // 'vivid' or 'natural'
  }

  /**
   * Initialize the DALL-E service
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass in config');
    }

    try {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      console.log(`DALL-E service initialized with model: ${this.modelName}`);
    } catch (error) {
      console.error('Failed to initialize DALL-E service:', error);
      throw error;
    }
  }

  /**
   * Format options for DALL-E API
   * @param {Object} options - Raw options
   * @returns {Object} - Formatted options for DALL-E API
   */
  formatOptions(options) {
    // DALL-E 3 supported sizes: '1024x1024', '1024x1792', '1792x1024'
    // DALL-E 2 supported sizes: '256x256', '512x512', '1024x1024'
    let size = options.size || this.defaultSize;
    let quality = options.quality || this.quality;
    let style = options.style || this.style;
    let n = options.n || 1; // Number of images
    
    // Validate size based on model
    if (this.modelName === 'dall-e-3') {
      const validSizes = ['1024x1024', '1024x1792', '1792x1024'];
      if (!validSizes.includes(size)) {
        size = '1024x1024'; // Default for invalid sizes
      }
      // DALL-E 3 only generates 1 image at a time
      n = 1;
    } else {
      const validSizes = ['256x256', '512x512', '1024x1024'];
      if (!validSizes.includes(size)) {
        size = '1024x1024'; // Default for invalid sizes
      }
    }

    return {
      size,
      quality,
      style,
      n
    };
  }

  /**
   * Generate an image using DALL-E
   * @param {string} prompt - Text prompt describing the desired image
   * @param {Object} options - Additional generation options
   * @returns {Promise<Object>} - Object containing image URL and metadata
   */
  async generateImage(prompt, options = {}) {
    if (!this.client) {
      await this.initialize();
    }

    const processedPrompt = this.preprocessPrompt(prompt);
    const formattedOptions = this.formatOptions(options);

    try {
      const params = {
        model: this.modelName,
        prompt: processedPrompt,
        size: formattedOptions.size,
        n: formattedOptions.n
      };

      // DALL-E 3 specific options
      if (this.modelName === 'dall-e-3') {
        params.quality = formattedOptions.quality;
        params.style = formattedOptions.style;
      }

      const response = await this.client.images.generate(params);
      
      // Format the response
      const result = {
        url: response.data[0].url,
        revised_prompt: response.data[0].revised_prompt,
        metadata: {
          model: this.modelName,
          size: formattedOptions.size,
          quality: formattedOptions.quality,
          style: formattedOptions.style
        }
      };

      this.logGeneration(processedPrompt, formattedOptions, result);
      return this.formatSuccess(result, processedPrompt);
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Generate variations of an existing image
   * @param {string} imageUrl - URL or base64 of the source image
   * @param {Object} options - Additional options for the variation
   * @returns {Promise<Array>} - Array of objects containing image URLs and metadata
   */
  async generateVariations(imageUrl, options = {}) {
    if (!this.client) {
      await this.initialize();
    }

    // DALL-E 3 doesn't support variations, only DALL-E 2
    if (this.modelName === 'dall-e-3') {
      return this.handleError(
        new Error('Image variations are not supported by DALL-E 3'),
        'image variation'
      );
    }

    const formattedOptions = this.formatOptions(options);

    try {
      // For DALL-E, we need to first download the image from the URL
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      
      const response = await this.client.images.createVariation({
        image: new Blob([imageBuffer]),
        n: formattedOptions.n,
        size: formattedOptions.size
      });
      
      // Format the responses
      const results = response.data.map(item => ({
        url: item.url,
        metadata: {
          model: this.modelName,
          size: formattedOptions.size
        }
      }));

      this.logGeneration('Image variation', formattedOptions, { count: results.length });
      return results.map(result => this.formatSuccess(result, 'Image variation'));
    } catch (error) {
      return this.handleError(error, 'image variation');
    }
  }
}

export default DalleService;
