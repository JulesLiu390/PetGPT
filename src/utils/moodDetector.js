/**
 * 动态情绪检测器
 * 
 * 支持注入式表情管理：
 * - 输入：表情名称数组 ["normal", "happy", "sad"]
 * - Schema：动态生成 z.enum(["normal", "happy", "sad"])
 * - LLM 返回：表情名称 "happy"
 * - 映射：代码转换成数字索引用于加载图片
 */

import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { callLLM } from './llm/index.js';

// 默认表情列表（向后兼容）
export const DEFAULT_MOODS = ["normal", "smile", "angry", "thinking"];

/**
 * 动态创建情绪 Schema
 * @param {string[]} moods - 表情名称数组 e.g. ["normal", "happy", "sad"]
 * @returns {z.ZodObject} 动态生成的 Zod Schema
 */
export const createMoodSchema = (moods) => {
  if (!moods?.length) moods = DEFAULT_MOODS;
  // 动态生成 enum: z.enum(["normal", "happy", "sad", ...])
  return z.object({
    mood: z.enum([moods[0], ...moods.slice(1)])
  });
};

/**
 * 表情名称 -> 索引映射（用于加载图片）
 * @param {string[]} moods - 表情列表
 * @param {string} mood - 当前表情名称
 * @returns {number} 索引 (0-based)
 */
export const moodToIndex = (moods, mood) => {
  const idx = moods.indexOf(mood);
  return idx >= 0 ? idx : 0;
};

/**
 * 索引 -> 表情名称映射
 * @param {string[]} moods - 表情列表
 * @param {number} index - 索引
 * @returns {string} 表情名称
 */
export const indexToMood = (moods, index) => {
  return (index >= 0 && index < moods.length) ? moods[index] : moods[0];
};

/**
 * 检测用户情绪
 * @param {string} userMessage - 用户消息
 * @param {string[]} moods - 可用表情列表
 * @param {object} apiConfig - { apiFormat, apiKey, model, baseURL }
 * @returns {Promise<string>} 表情名称
 */
export const detectMood = async (userMessage, moods, apiConfig) => {
  // 使用默认表情列表（如果未提供）
  if (!moods?.length) {
    moods = DEFAULT_MOODS;
  }
  
  const { apiFormat, apiKey, model, baseURL } = apiConfig;
  
  // 动态生成 prompt，直接列出表情名称
  const moodList = moods.join(', ');
  const systemPrompt = `You analyze user emotions for a desktop pet assistant.

Available moods: ${moodList}

Based on the user's message, determine what mood/emotion the pet should display.
Guidelines:
- "normal": Neutral questions, factual requests, or unclear emotion
- "happy"/"smile": Joyful, grateful, friendly, praising messages
- "sad": User is upset, disappointed, or sharing bad news
- "angry": User is frustrated, complaining harshly, or being rude
- Use other moods from the list as appropriate based on their names

Reply with JSON only: {"mood": "<mood_name>"}`;
  
  console.log('[detectMood] Available moods:', moodList);
  console.log('[detectMood] User message preview:', userMessage.slice(0, 50));
  
  try {
    const result = await callLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      apiFormat,
      apiKey,
      model,
      baseUrl: baseURL === "default" ? undefined : baseURL,
      options: { temperature: 0.1, max_tokens: 20 }
    });
    
    const content = result.content || "";
    console.log('[detectMood] Raw response:', content);
    
    // 解析返回的表情名称
    let detectedMood = moods[0];
    
    try {
      // 尝试解析 JSON
      const parsed = JSON.parse(content);
      if (parsed.mood && moods.includes(parsed.mood)) {
        detectedMood = parsed.mood;
      } else if (parsed.mood) {
        // 如果返回的 mood 不在列表中，尝试模糊匹配
        const lowerMood = parsed.mood.toLowerCase();
        const matched = moods.find(m => m.toLowerCase() === lowerMood);
        if (matched) {
          detectedMood = matched;
        }
      }
    } catch {
      // 如果不是 JSON，直接匹配表情名称
      const lowerContent = content.toLowerCase();
      for (const m of moods) {
        if (lowerContent.includes(m.toLowerCase())) {
          detectedMood = m;
          break;
        }
      }
    }
    
    console.log('[detectMood] Result:', detectedMood, '-> index:', moodToIndex(moods, detectedMood));
    return detectedMood;
    
  } catch (e) {
    console.warn('[detectMood] Error:', e);
    return moods[0];
  }
};

/**
 * 为支持结构化输出的模型创建 response_format
 * @param {string[]} moods - 可用表情列表
 * @returns {object} OpenAI response_format
 */
export const createMoodResponseFormat = (moods) => {
  const schema = createMoodSchema(moods);
  return zodResponseFormat(schema, "mood_response");
};

/**
 * 验证表情名称是否有效
 * @param {string} mood - 表情名称
 * @param {string[]} moods - 可用表情列表
 * @returns {boolean}
 */
export const isValidMood = (mood, moods) => {
  if (!moods?.length) moods = DEFAULT_MOODS;
  return moods.includes(mood);
};

/**
 * 获取安全的表情名称（如果无效则返回第一个）
 * @param {string} mood - 表情名称
 * @param {string[]} moods - 可用表情列表
 * @returns {string}
 */
export const getSafeMood = (mood, moods) => {
  if (!moods?.length) moods = DEFAULT_MOODS;
  return isValidMood(mood, moods) ? mood : moods[0];
};
