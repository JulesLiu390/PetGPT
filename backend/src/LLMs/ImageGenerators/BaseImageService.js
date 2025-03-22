import { ImageGeneratorService } from '../llm.js';

/**
 * Base Image Generator Service
 * This abstract class provides common functionality for image generators
 */
export class BaseImageService extends ImageGeneratorService {
  constructor(config = {}) {
    super(config);
    this.serviceName = 'base-image-service';
    this.defaultSize = config.defaultSize || '1024x1024';
    this.maxPromptLength = config.maxPromptLength || 1000;
  }

  /**
   * Pre-process a prompt before sending it to the image generation service
   * @param {string} prompt - The raw prompt from the user
   * @returns {string} - The processed prompt
   */
  preprocessPrompt(prompt) {
    // Trim and ensure the prompt isn't too long
    let processedPrompt = prompt.trim();
    if (processedPrompt.length > this.maxPromptLength) {
      processedPrompt = processedPrompt.substring(0, this.maxPromptLength);
    }
    return processedPrompt;
  }

  /**
   * Format the generation options according to the service requirements
   * @param {Object} options - The raw options provided by the caller
   * @returns {Object} - The formatted options
   */
  formatOptions(options) {
    // Base implementation returns options as-is
    // Subclasses should override this to format options for their specific API
    return options;
  }

  /**
   * Log image generation details for monitoring/debugging
   * @param {string} prompt - The prompt used for generation
   * @param {Object} options - The options used for generation
   * @param {Object} result - The result of the generation
   */
  logGeneration(prompt, options, result) {
    console.log(`[${this.serviceName}] Generated image with prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);
    
    // Avoid logging potentially large result data
    const logResult = { ...result };
    if (logResult.url) {
      console.log(`[${this.serviceName}] Image URL: ${logResult.url}`);
    }
    
    if (logResult.error) {
      console.error(`[${this.serviceName}] Error: ${logResult.error}`);
    }
  }

  /**
   * Standard error handler for image generation errors
   * @param {Error} error - The error that occurred
   * @param {string} operation - The operation that was being performed
   * @returns {Object} - A standardized error response
   */
  handleError(error, operation = 'image generation') {
    console.error(`[${this.serviceName}] Error during ${operation}:`, error);
    
    return {
      success: false,
      error: error.message || `An error occurred during ${operation}`,
      serviceName: this.serviceName,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Standard success response formatter for image generation
   * @param {Object} data - The raw data from the image generation API
   * @param {string} prompt - The prompt that was used
   * @returns {Object} - A standardized success response
   */
  formatSuccess(data, prompt) {
    return {
      success: true,
      url: data.url,
      prompt: prompt,
      serviceName: this.serviceName,
      modelName: this.modelName || 'unknown',
      timestamp: new Date().toISOString(),
      metadata: data.metadata || {}
    };
  }
}

export default BaseImageService;
