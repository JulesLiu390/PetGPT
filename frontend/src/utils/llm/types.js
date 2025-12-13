/**
 * PetGPT 内部消息格式 Type Definitions
 * 
 * 统一的消息结构，不依赖任何特定 provider
 */

/**
 * @typedef {'text' | 'image' | 'video' | 'audio' | 'file'} PartType
 */

/**
 * @typedef {Object} TextPart
 * @property {'text'} type
 * @property {string} text
 */

/**
 * @typedef {Object} ImagePart
 * @property {'image'} type
 * @property {string} url - 本地路径、data: URI 或 http URL
 * @property {string} [mime_type]
 */

/**
 * @typedef {Object} VideoPart
 * @property {'video'} type
 * @property {string} url
 * @property {string} mime_type
 * @property {string} [name]
 */

/**
 * @typedef {Object} AudioPart
 * @property {'audio'} type
 * @property {string} url
 * @property {string} mime_type
 * @property {string} [name]
 */

/**
 * @typedef {Object} FilePart
 * @property {'file'} type
 * @property {string} url
 * @property {string} mime_type
 * @property {string} [name]
 */

/**
 * @typedef {TextPart | ImagePart | VideoPart | AudioPart | FilePart} MessagePart
 */

/**
 * @typedef {'system' | 'user' | 'assistant'} MessageRole
 */

/**
 * @typedef {Object} PetMessage
 * @property {MessageRole} role
 * @property {MessagePart[] | string} content
 */

/**
 * @typedef {Object} LLMResponse
 * @property {string} content - 模型回复的文本
 * @property {string} mood - 情绪 (angry, normal, smile)
 */

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} supportsImage
 * @property {boolean} supportsVideo
 * @property {boolean} supportsAudio
 * @property {boolean} supportsPdf
 * @property {boolean} supportsDocx
 * @property {boolean} supportsInlineData - 是否支持内联 base64 数据
 * @property {number} [maxInlineBytes] - 内联数据最大字节数
 */

/**
 * @typedef {Object} LLMConfig
 * @property {string} provider - 'openai' | 'gemini' | 'anthropic' | 'grok' | 'custom'
 * @property {string} apiKey
 * @property {string} model
 * @property {string} [baseUrl]
 * @property {number} [temperature]
 */

export default {};
