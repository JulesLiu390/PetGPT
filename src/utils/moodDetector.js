/**
 * 固定表情系统
 * 
 * 表情分为两类：
 * 1. 情绪表情 (由 LLM 检测): normal, smile, sad, shocked
 * 2. 系统状态 (由代码控制): thinking, idle-1, idle-2, idle-3
 * 
 * 图片命名规则: {角色名}-{表情名}.png
 * 例如: Jules-normal.png, Jules-smile.png
 */

import { callLLM } from './llm/index.js';

// ============ 固定表情常量 ============

/**
 * 情绪表情 - 由 LLM 检测用户情绪后返回
 * 这些是 LLM 可以选择的 4 种情绪
 */
export const EMOTION_MOODS = ["normal", "smile", "sad", "shocked"];

/**
 * 系统状态 - 由代码逻辑控制，不参与 LLM 检测
 * - thinking: AI 正在处理
 * - idle-1/2/3: 待机动画（无对话时随机切换）
 */
export const SYSTEM_STATES = ["thinking", "idle-1", "idle-2", "idle-3"];

/**
 * 所有可用的表情/状态（用于图片加载）
 */
export const ALL_MOODS = [...EMOTION_MOODS, ...SYSTEM_STATES];

/**
 * 默认表情（向后兼容）
 * @deprecated 使用 EMOTION_MOODS 代替
 */
export const DEFAULT_MOODS = EMOTION_MOODS;

// ============ 表情映射（向后兼容） ============

/**
 * 旧表情名 -> 新表情名 映射
 * 用于兼容旧的皮肤和数据
 */
const MOOD_MIGRATION_MAP = {
  'angry': 'sad',      // angry 图片临时作为 sad 使用
  'happy': 'smile',    // happy 映射到 smile
  'thinking': 'thinking', // 保持
  'normal': 'normal',  // 保持
};

/**
 * 将旧表情名映射到新表情名
 * @param {string} mood - 可能是旧的表情名
 * @returns {string} 新的表情名
 */
export const migrateMoodName = (mood) => {
  return MOOD_MIGRATION_MAP[mood] || mood;
};

// ============ 情绪检测 ============

/**
 * 检测用户情绪（固定 4 选 1）
 * 
 * @param {string} userMessage - 用户消息
 * @param {object} apiConfig - { apiFormat, apiKey, model, baseURL }
 * @returns {Promise<string>} 表情名称: "normal" | "smile" | "sad" | "shocked"
 */
export const detectMood = async (userMessage, apiConfig) => {
  const { apiFormat, apiKey, model, baseURL } = apiConfig;
  
  // 针对固定 4 种情绪优化的 prompt - 更强调只返回 JSON
  const systemPrompt = `You are a mood classifier. Your ONLY job is to output a JSON object.

Analyze the user's message and determine the appropriate mood for a desktop pet to display.

Available moods:
- "normal": Neutral, factual, greetings, unclear emotion
- "smile": Happy, grateful, excited, good news
- "sad": Upset, disappointed, worried, bad news
- "shocked": Surprising, unexpected, unusual

IMPORTANT: You must respond with ONLY this JSON format, nothing else:
{"mood": "normal"}

Replace "normal" with the appropriate mood. Do not add any explanation or other text.`;
  
  console.log('[detectMood] User message preview:', userMessage.slice(0, 50));
  
  try {
    const result = await callLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Classify this message's mood: "${userMessage}"` }
      ],
      apiFormat,
      apiKey,
      model,
      baseUrl: baseURL === "default" ? undefined : baseURL,
      options: { temperature: 0.1, maxTokens: 30 }  // 使用 maxTokens 而不是 max_tokens
    });
    
    const content = result.content || "";
    console.log('[detectMood] Raw response:', content);
    
    // 解析返回的表情名称
    let detectedMood = "normal";
    
    // 首先尝试提取 JSON（可能被其他文本包围）
    const jsonMatch = content.match(/\{[\s\S]*?"mood"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.mood) {
          const lowerMood = parsed.mood.toLowerCase();
          const matched = EMOTION_MOODS.find(m => m.toLowerCase() === lowerMood);
          if (matched) {
            detectedMood = matched;
          } else {
            // 尝试使用迁移映射
            const migrated = migrateMoodName(lowerMood);
            if (EMOTION_MOODS.includes(migrated)) {
              detectedMood = migrated;
            }
          }
        }
      } catch {
        // JSON 解析失败，继续尝试其他方法
      }
    }
    
    // 如果 JSON 解析失败，直接在文本中查找表情关键词
    if (detectedMood === "normal" && !jsonMatch) {
      const lowerContent = content.toLowerCase();
      // 按优先级顺序检查（避免 "normal" 误匹配）
      const priorityOrder = ["shocked", "smile", "sad", "normal"];
      for (const m of priorityOrder) {
        if (lowerContent.includes(m.toLowerCase())) {
          detectedMood = m;
          break;
        }
      }
    }
    
    console.log('[detectMood] Result:', detectedMood);
    return detectedMood;
    
  } catch (e) {
    console.warn('[detectMood] Error:', e);
    return "normal";
  }
};

// ============ 辅助函数 ============

/**
 * 验证表情名称是否有效（情绪表情）
 * @param {string} mood - 表情名称
 * @returns {boolean}
 */
export const isValidEmotionMood = (mood) => {
  return EMOTION_MOODS.includes(mood);
};

/**
 * 验证是否是系统状态
 * @param {string} state - 状态名称
 * @returns {boolean}
 */
export const isSystemState = (state) => {
  return SYSTEM_STATES.includes(state);
};

/**
 * 验证表情/状态名称是否有效（包括情绪和系统状态）
 * @param {string} mood - 表情/状态名称
 * @returns {boolean}
 */
export const isValidMood = (mood) => {
  return ALL_MOODS.includes(mood);
};

/**
 * 获取安全的表情名称（如果无效则返回 normal）
 * @param {string} mood - 表情名称
 * @returns {string}
 */
export const getSafeMood = (mood) => {
  // 先尝试迁移映射
  const migrated = migrateMoodName(mood);
  if (isValidMood(migrated)) {
    return migrated;
  }
  return "normal";
};

/**
 * 获取随机待机状态
 * @returns {string} "idle-1" | "idle-2" | "idle-3"
 */
export const getRandomIdleState = () => {
  const idleStates = ["idle-1", "idle-2", "idle-3"];
  const randomIndex = Math.floor(Math.random() * idleStates.length);
  return idleStates[randomIndex];
};
