import fetch from 'node-fetch';
import FormData from 'form-data';
import { BaseImageService } from './BaseImageService.js';

/**
 * Stable Diffusion Service Implementation
 * This class implements the Image Generator interface using Stability AI's API
 */
export class StableDiffusionService extends BaseImageService {
  constructor(config = {}) {
    super(config);
    this.modelName = config.modelName || 'stable-diffusion-xl-1024-v1-0';
    this.apiHost = config.apiHost || 'https://api.stability.ai';
    this.client = null;
    this.serviceName = 'stable-diffusion';
    this.defaultSize = config.defaultSize || '1024x1024';
    this.defaultCfgScale = config.cfgScale || 7.0; // Controls how strictly the model follows the prompt
    this.defaultSteps = config.steps || 30; // Number of diffusion steps (higher = better quality but slower)
  }

  /**
   * Initialize the Stable Diffusion service
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!process.env.STABILITY_API_KEY) {
      throw new Error('Stability API key is required. Set STABILITY_API_KEY environment variable or pass in config');
    }

    try {
      // Validate the API key by making a request to list available engines
      const response = await fetch(`${this.apiHost}/v1/engines/list`, {
        headers: {
          Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Stability AI API error: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Verify that the requested model exists
      const availableModels = data.map(engine => engine.id);
      if (!availableModels.includes(this.modelName)) {
        console.warn(`Model ${this.modelName} not found in available models. Available models: ${availableModels.join(', ')}`);
        // Use the first available model as fallback
        if (availableModels.length > 0) {
          this.modelName = availableModels[0];
          console.log(`Falling back to model: ${this.modelName}`);
        }
      }
      
      console.log(`Stable Diffusion service initialized with model: ${this.modelName}`);
    } catch (error) {
      console.error('Failed to initialize Stable Diffusion service:', error);
      throw error;
    }
  }

  /**
   * Format options for Stable Diffusion API
   * @param {Object} options - Raw options
   * @returns {Object} - Formatted options for Stable Diffusion API
   */
  formatOptions(options) {
    const formatSize = (size) => {
      if (typeof size === 'string' && size.includes('x')) {
        const [width, height] = size.split('x').map(n => parseInt(n, 10));
        return { width, height };
      }
      // Default to square 1024x1024
      return { width: 1024, height: 1024 };
    };

    const sizeObj = formatSize(options.size || this.defaultSize);
    
    return {
      width: sizeObj.width,
      height: sizeObj.height,
      cfg_scale: options.cfgScale || this.defaultCfgScale,
      steps: options.steps || this.defaultSteps,
      samples: options.samples || 1
    };
  }

  /**
   * Generate an image using Stable Diffusion
   * @param {string} prompt - Text prompt describing the desired image
   * @param {Object} options - Additional generation options
   * @returns {Promise<Object>} - Object containing image URL and metadata
   */
  async generateImage(prompt, options = {}) {
    if (!process.env.STABILITY_API_KEY) {
      await this.initialize();
    }

    const processedPrompt = this.preprocessPrompt(prompt);
    const formattedOptions = this.formatOptions(options);

    try {
      const response = await fetch(
        `${this.apiHost}/v1/generation/${this.modelName}/text-to-image`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
          },
          body: JSON.stringify({
            text_prompts: [
              {
                text: processedPrompt,
                weight: 1.0,
              },
            ],
            cfg_scale: formattedOptions.cfg_scale,
            width: formattedOptions.width,
            height: formattedOptions.height,
            samples: formattedOptions.samples,
            steps: formattedOptions.steps,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Stability API error: ${error.message || response.statusText}`);
      }

      const responseJSON = await response.json();
      
      // The response contains an array of generated images
      // We'll extract the first one (or more if requested)
      const results = responseJSON.artifacts.map(artifact => {
        // The image is provided as a base64 string which we need to convert to a URL
        // In a real app, you would likely save this to a file server or S3 bucket
        // For this example, we'll assume we have an endpoint that can handle base64 data URLs
        const base64Data = artifact.base64;
        // In a real implementation, you might want to store these images server-side
        const imageUrl = `data:image/png;base64,${base64Data}`;
        
        return {
          url: imageUrl,
          seed: artifact.seed,
          metadata: {
            model: this.modelName,
            width: formattedOptions.width,
            height: formattedOptions.height,
            cfg_scale: formattedOptions.cfg_scale,
            steps: formattedOptions.steps
          }
        };
      });

      this.logGeneration(processedPrompt, formattedOptions, { count: results.length });
      
      if (results.length === 1) {
        return this.formatSuccess(results[0], processedPrompt);
      } else {
        return results.map(result => this.formatSuccess(result, processedPrompt));
      }
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
    if (!process.env.STABILITY_API_KEY) {
      await this.initialize();
    }

    const formattedOptions = this.formatOptions(options);
    
    try {
      // Download the image first
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      
      // Create form data
      const formData = new FormData();
      formData.append('init_image', new Blob([imageBuffer]));
      
      // Add options
      formData.append('init_image_mode', 'IMAGE_STRENGTH');
      formData.append('image_strength', options.imageStrength || 0.35);
      formData.append('cfg_scale', formattedOptions.cfg_scale);
      formData.append('samples', formattedOptions.samples);
      formData.append('steps', formattedOptions.steps);
      
      // Add text prompt if provided
      if (options.prompt) {
        const processedPrompt = this.preprocessPrompt(options.prompt);
        formData.append('text_prompts[0][text]', processedPrompt);
        formData.append('text_prompts[0][weight]', 1.0);
      }

      const response = await fetch(
        `${this.apiHost}/v1/generation/${this.modelName}/image-to-image`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Stability API error: ${error.message || response.statusText}`);
      }

      const responseJSON = await response.json();
      
      // Process results similar to generateImage
      const results = responseJSON.artifacts.map(artifact => {
        const base64Data = artifact.base64;
        const imageUrl = `data:image/png;base64,${base64Data}`;
        
        return {
          url: imageUrl,
          seed: artifact.seed,
          metadata: {
            model: this.modelName,
            width: formattedOptions.width,
            height: formattedOptions.height,
            cfg_scale: formattedOptions.cfg_scale,
            steps: formattedOptions.steps,
            image_strength: options.imageStrength || 0.35
          }
        };
      });

      this.logGeneration('Image variation', formattedOptions, { count: results.length });
      
      return results.map(result => this.formatSuccess(result, options.prompt || 'Image variation'));
    } catch (error) {
      return this.handleError(error, 'image variation');
    }
  }
}

export default StableDiffusionService;
