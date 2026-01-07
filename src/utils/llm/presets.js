/**
 * API Base URL Presets
 * 
 * 预设的 API 端点列表，用于快速选择常用服务商
 * 这些都是直连官方/本地服务，不涉及中转
 */

/**
 * OpenAI Compatible 格式的预设端点
 */
export const OPENAI_COMPATIBLE_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    notes: 'Official OpenAI API'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    notes: 'DeepSeek API'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    notes: 'Claude models (OpenAI-compatible endpoint)'
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    notes: 'Groq fast inference'
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    notes: 'xAI Grok models'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    notes: 'Multi-provider gateway'
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    notes: 'Together AI inference'
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434/v1',
    notes: 'Local Ollama server',
    isLocal: true
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (Local)',
    baseUrl: 'http://localhost:1234/v1',
    notes: 'Local LM Studio server',
    isLocal: true
  },
  {
    id: 'custom',
    label: 'Custom URL',
    baseUrl: '',
    notes: 'Enter your own endpoint'
  }
];

/**
 * Gemini Official 格式的预设端点
 */
export const GEMINI_OFFICIAL_PRESETS = [
  {
    id: 'google',
    label: 'Google AI (Official)',
    baseUrl: 'https://generativelanguage.googleapis.com',
    notes: 'Official Google Gemini API'
  },
  {
    id: 'custom',
    label: 'Custom URL',
    baseUrl: '',
    notes: 'Enter your own endpoint (e.g., proxy)'
  }
];

/**
 * 根据 apiFormat 获取对应的预设列表
 */
export const getPresetsForFormat = (apiFormat) => {
  if (apiFormat === 'gemini_official') {
    return GEMINI_OFFICIAL_PRESETS;
  }
  return OPENAI_COMPATIBLE_PRESETS;
};

/**
 * 根据 apiFormat 获取默认的 Base URL
 */
export const getDefaultBaseUrl = (apiFormat) => {
  if (apiFormat === 'gemini_official') {
    return 'https://generativelanguage.googleapis.com';
  }
  return 'https://api.openai.com/v1';
};

/**
 * 根据 URL 查找匹配的 preset ID
 */
export const findPresetByUrl = (apiFormat, url) => {
  const presets = getPresetsForFormat(apiFormat);
  const normalizedUrl = url?.replace(/\/+$/, ''); // 去掉尾部斜杠
  
  for (const preset of presets) {
    if (preset.baseUrl && preset.baseUrl.replace(/\/+$/, '') === normalizedUrl) {
      return preset.id;
    }
  }
  return 'custom';
};

/**
 * 获取用于 Auto-detect 的候选 URL 列表
 * @param {boolean} includeLocal - 是否包含本地端点
 */
export const getDetectionCandidates = (includeLocal = false) => {
  return OPENAI_COMPATIBLE_PRESETS
    .filter(p => p.id !== 'custom' && (includeLocal || !p.isLocal))
    .map(p => ({ id: p.id, label: p.label, baseUrl: p.baseUrl }));
};

export default {
  OPENAI_COMPATIBLE_PRESETS,
  GEMINI_OFFICIAL_PRESETS,
  getPresetsForFormat,
  getDefaultBaseUrl,
  findPresetByUrl,
  getDetectionCandidates
};
