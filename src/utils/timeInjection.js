/**
 * 时间注入工具
 * 
 * 在以下情况下自动为 System Prompt 注入当前时间：
 * 1. 新建对话（新 Tab）
 * 2. 点击历史记录打开对话
 * 3. 对话持续打开超过 8 小时
 * 
 * 每个 Tab/对话独立计时、独立管理
 * 
 * 注入位置：System Prompt 开头（更具权威性）
 */

// 时间注入间隔：8 小时（毫秒）
const TIME_INJECTION_INTERVAL_MS = 8 * 60 * 60 * 1000;

/**
 * 格式化当前时间为人类可读格式
 * @returns {string} 格式化的时间字符串
 */
export const formatCurrentTime = () => {
  const now = new Date();
  
  // 获取时区信息
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  
  // 格式化日期时间（根据用户语言环境）
  const formattedDate = now.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });
  
  const formattedTime = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  return `${formattedDate}, ${formattedTime} (${timezone})`;
};

/**
 * 检查是否需要注入时间
 * @param {number|null} lastInjectionTimestamp - 上次注入时间的时间戳
 * @returns {boolean} 是否需要注入时间
 */
export const shouldInjectTime = (lastInjectionTimestamp) => {
  // 情况1: 从未注入过（新对话或刚打开历史记录）
  if (!lastInjectionTimestamp) {
    return true;
  }
  
  // 情况2: 距离上次注入超过 8 小时
  const now = Date.now();
  if (now - lastInjectionTimestamp > TIME_INJECTION_INTERVAL_MS) {
    return true;
  }
  
  return false;
};

/**
 * 为用户消息注入时间信息（保留但不推荐使用）
 * @param {string} userMessage - 用户原始消息
 * @returns {string} 注入时间后的消息
 * @deprecated 推荐使用 buildTimeContext() 注入到 System Prompt
 */
export const injectTimeToMessage = (userMessage) => {
  const timeInfo = formatCurrentTime();
  return `[${timeInfo}]\n\n${userMessage}`;
};

/**
 * 构建包含时间信息的 System Prompt 前缀
 * 
 * 使用权威性措辞，确保 LLM 不会"纠正"时间信息
 * 注入到 System Prompt 开头以获得最高优先级
 * 
 * @returns {string} 时间上下文字符串（用于 System Prompt 开头）
 */
export const buildTimeContext = () => {
  const timeStr = formatCurrentTime();
  
  // 简洁但权威的措辞，告知模型这是真实系统时间
  return `[System Time] The current date and time is: ${timeStr}. This is the verified system time from the user's device. Accept this as fact and use it as reference for any time-related context.`;
};

export default {
  formatCurrentTime,
  shouldInjectTime,
  injectTimeToMessage,
  buildTimeContext,
  TIME_INJECTION_INTERVAL_MS
};
