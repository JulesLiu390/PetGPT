/**
 * socialToolExecutor.js — 社交代理专用内置工具执行器
 * 
 * 社交记忆工具：操作 social/SOCIAL_MEMORY.md（全局共享），路径硬编码。
 * 群规则工具：操作 social/GROUP_RULE_{群号}.md（群专属），群号从上下文自动获取。
 * 工具名使用 social_ / group_rule_ 前缀，与主聊天的 read / write / edit 工具隔离。
 */

import * as tauri from '../tauri';

// ============ 常量 ============

const SOCIAL_MEMORY_PATH = 'social/SOCIAL_MEMORY.md';
const SOCIAL_TOOL_NAMES = new Set(['social_read', 'social_write', 'social_edit']);

const GROUP_RULE_PATH_PREFIX = 'social/GROUP_RULE_';
const GROUP_RULE_TOOL_NAMES = new Set(['group_rule_read', 'group_rule_write', 'group_rule_edit']);

const REPLY_STRATEGY_PATH = 'social/REPLY_STRATEGY.md';
const REPLY_STRATEGY_TOOL_NAMES = new Set(['reply_strategy_read', 'reply_strategy_edit']);

const GROUP_BUFFER_PATH_PREFIX = 'social/GROUP_';
const DAILY_PATH_PREFIX = 'social/DAILY_';
const HISTORY_TOOL_NAMES = new Set(['history_read', 'daily_read', 'daily_list']);

const KNOWN_TARGETS_PATH = 'social/targets.json';
const GROUP_LOG_TOOL_NAMES = new Set(['group_log_list', 'group_log_read']);

/** 历史查询返回最大字符数 */
export const HISTORY_READ_MAX_CHARS = 8000;

/** 社交记忆文件最大字符数 */
export const SOCIAL_MEMORY_MAX_CHARS = 20000;

/** 群规则文件最大字符数 */
export const GROUP_RULE_MAX_CHARS = 10000;

/** 回复策略文件最大字符数 */
export const REPLY_STRATEGY_MAX_CHARS = 5000;

// ============ 工具检测 ============

/**
 * 检查工具名是否为社交内置工具（社交记忆）
 */
export function isSocialBuiltinTool(toolName) {
  return SOCIAL_TOOL_NAMES.has(toolName);
}

/**
 * 检查工具名是否为群规则内置工具
 */
export function isGroupRuleBuiltinTool(toolName) {
  return GROUP_RULE_TOOL_NAMES.has(toolName);
}

/**
 * 检查工具名是否为回复策略内置工具
 */
export function isReplyStrategyBuiltinTool(toolName) {
  return REPLY_STRATEGY_TOOL_NAMES.has(toolName);
}

/**
 * 检查工具名是否为历史查询内置工具
 */
export function isHistoryBuiltinTool(toolName) {
  return HISTORY_TOOL_NAMES.has(toolName);
}

/**
 * 检查工具名是否为跨群日志内置工具
 */
export function isGroupLogBuiltinTool(toolName) {
  return GROUP_LOG_TOOL_NAMES.has(toolName);
}

/** 获取群规则文件路径 */
function groupRulePath(targetId) {
  return `${GROUP_RULE_PATH_PREFIX}${targetId}.md`;
}

// ============ 工具定义 ============

/**
 * 获取社交专用内置工具的 function calling 定义
 * 路径固定为 social/SOCIAL_MEMORY.md，不需要 path 参数
 */
export function getSocialBuiltinToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'social_read',
        description: '读取你的社交长期记忆文件内容。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'social_write',
        description: '创建或覆盖你的社交长期记忆文件。用于记录社交中值得长期记住的信息（群友关系、重要事件、习惯偏好等）。',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: '要写入的完整内容',
            },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'social_edit',
        description: '通过精确文本查找替换来编辑你的社交长期记忆文件。使用前必须先调用 social_read 获取当前内容。每次只改一处，改完再 read 确认结果。如果需要大幅修改（超过一半内容），直接用 social_write 覆盖更可靠。',
        parameters: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: '要替换的原文，必须从 social_read 返回的内容中精确复制（包括标点、空格、换行），不要凭记忆手打',
            },
            newText: {
              type: 'string',
              description: '替换后的新文本，保留原文的 Markdown 格式（标题层级、列表符号等）',
            },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
  ];
}

// ============ 工具执行 ============

async function executeRead(petId) {
  try {
    const content = await tauri.workspaceRead(petId, SOCIAL_MEMORY_PATH);
    return { content: [{ type: 'text', text: content || '（空）' }] };
  } catch {
    return { content: [{ type: 'text', text: '（社交记忆文件尚未创建）' }] };
  }
}

async function executeWrite(petId, args) {
  const { content } = args;
  if (content === undefined || content === null) {
    return { error: '缺少 content 参数' };
  }
  try {
    const result = await tauri.workspaceWrite(petId, SOCIAL_MEMORY_PATH, content);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

async function executeEdit(petId, args) {
  const { oldText, newText } = args;
  if (!oldText) return { error: '缺少 oldText 参数' };
  if (newText === undefined || newText === null) return { error: '缺少 newText 参数' };
  try {
    const result = await tauri.workspaceEdit(petId, SOCIAL_MEMORY_PATH, oldText, newText);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

// ============ 统一入口 ============

/**
 * 执行社交内置工具
 * 
 * @param {string} toolName - 'social_read' | 'social_write' | 'social_edit'
 * @param {Object} args - 工具参数
 * @param {Object} context - { petId }
 * @returns {Promise<Object>} MCP 标准响应格式
 */
export async function executeSocialBuiltinTool(toolName, args, context) {
  const { petId } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行社交记忆操作。' };
  }

  console.log(`[SocialBuiltin] Executing ${toolName}`, { petId });

  switch (toolName) {
    case 'social_read':
      return executeRead(petId);
    case 'social_write':
      return executeWrite(petId, args);
    case 'social_edit':
      return executeEdit(petId, args);
    default:
      return { error: `未知的社交工具: ${toolName}` };
  }
}

// ============ 群规则工具定义 ============

/**
 * 获取群规则内置工具的 function calling 定义
 * 路径自动绑定当前群号，AI 不需要也不能指定群号
 */
export function getGroupRuleToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'group_rule_read',
        description: '读取当前群的专属规则和观察记录。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'group_rule_write',
        description: '创建或覆盖当前群的规则文件。用于记录：这个群是干什么的、群内特殊规则、话题偏好、禁忌等。',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: '要写入的完整内容',
            },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'group_rule_edit',
        description: '通过精确文本查找替换来编辑当前群的规则文件。使用前必须先调用 group_rule_read 获取当前内容。每次只改一处，改完再 read 确认结果。如果需要大幅修改（超过一半内容），直接用 group_rule_write 覆盖更可靠。',
        parameters: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: '要替换的原文，必须从 group_rule_read 返回的内容中精确复制（包括标点、空格、换行），不要凭记忆手打',
            },
            newText: {
              type: 'string',
              description: '替换后的新文本，保留原文的 Markdown 格式（标题层级、列表符号等）',
            },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
  ];
}

// ============ 群规则工具执行 ============

async function executeGroupRuleRead(petId, targetId) {
  const path = groupRulePath(targetId);
  try {
    const content = await tauri.workspaceRead(petId, path);
    return { content: [{ type: 'text', text: content || '（空）' }] };
  } catch {
    return { content: [{ type: 'text', text: '（当前群还没有规则文件）' }] };
  }
}

async function executeGroupRuleWrite(petId, targetId, args) {
  const { content } = args;
  if (content === undefined || content === null) {
    return { error: '缺少 content 参数' };
  }
  if (content.length > GROUP_RULE_MAX_CHARS) {
    return { error: `内容超出群规则文件上限（${GROUP_RULE_MAX_CHARS} 字符），请精简后重试。` };
  }
  const path = groupRulePath(targetId);
  try {
    const result = await tauri.workspaceWrite(petId, path, content);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

async function executeGroupRuleEdit(petId, targetId, args) {
  const { oldText, newText } = args;
  if (!oldText) return { error: '缺少 oldText 参数' };
  if (newText === undefined || newText === null) return { error: '缺少 newText 参数' };
  const path = groupRulePath(targetId);
  try {
    const result = await tauri.workspaceEdit(petId, path, oldText, newText);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

/**
 * 执行群规则内置工具
 * 
 * @param {string} toolName - 'group_rule_read' | 'group_rule_write' | 'group_rule_edit'
 * @param {Object} args - 工具参数
 * @param {Object} context - { petId, targetId }
 * @returns {Promise<Object>} MCP 标准响应格式
 */
export async function executeGroupRuleBuiltinTool(toolName, args, context) {
  const { petId, targetId } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行群规则操作。' };
  }
  if (!targetId) {
    return { error: '缺少 targetId（群号），无法执行群规则操作。' };
  }

  console.log(`[GroupRule] Executing ${toolName}`, { petId, targetId });

  switch (toolName) {
    case 'group_rule_read':
      return executeGroupRuleRead(petId, targetId);
    case 'group_rule_write':
      return executeGroupRuleWrite(petId, targetId, args);
    case 'group_rule_edit':
      return executeGroupRuleEdit(petId, targetId, args);
    default:
      return { error: `未知的群规则工具: ${toolName}` };
  }
}

// ============ 回复策略工具定义 ============

/**
 * 获取回复策略内置工具的 function calling 定义
 * 仅在 agentCanEditStrategy 开启时注入
 */
export function getReplyStrategyToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'reply_strategy_read',
        description: '读取你当前的回复策略文件。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'reply_strategy_edit',
        description: '通过精确文本查找替换来修改你的回复策略。用于根据经验调整何时回复、回复频率、语气等规则。oldText 必须精确匹配文件中的内容。',
        parameters: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: '要查找并替换的精确文本（必须唯一匹配）',
            },
            newText: {
              type: 'string',
              description: '替换后的新文本',
            },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
  ];
}

// ============ 回复策略工具执行 ============

async function executeReplyStrategyRead(petId) {
  try {
    const content = await tauri.workspaceRead(petId, REPLY_STRATEGY_PATH);
    return { content: [{ type: 'text', text: content || '（空）' }] };
  } catch {
    return { content: [{ type: 'text', text: '（回复策略文件尚未创建，使用默认策略）' }] };
  }
}

async function executeReplyStrategyEdit(petId, args) {
  const { oldText, newText } = args;
  if (!oldText) return { error: '缺少 oldText 参数' };
  if (newText === undefined || newText === null) return { error: '缺少 newText 参数' };
  try {
    // 如果文件不存在，先用默认内容创建
    const exists = await tauri.workspaceFileExists(petId, REPLY_STRATEGY_PATH).catch(() => false);
    if (!exists) {
      // 动态导入默认策略以避免循环依赖
      const { DEFAULT_REPLY_STRATEGY } = await import('../socialPromptBuilder');
      await tauri.workspaceWrite(petId, REPLY_STRATEGY_PATH, DEFAULT_REPLY_STRATEGY);
    }
    const result = await tauri.workspaceEdit(petId, REPLY_STRATEGY_PATH, oldText, newText);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

/**
 * 执行回复策略内置工具
 *
 * @param {string} toolName - 'reply_strategy_read' | 'reply_strategy_edit'
 * @param {Object} args - 工具参数
 * @param {Object} context - { petId }
 * @returns {Promise<Object>} MCP 标准响应格式
 */
export async function executeReplyStrategyBuiltinTool(toolName, args, context) {
  const { petId } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行回复策略操作。' };
  }

  console.log(`[ReplyStrategy] Executing ${toolName}`, { petId });

  switch (toolName) {
    case 'reply_strategy_read':
      return executeReplyStrategyRead(petId);
    case 'reply_strategy_edit':
      return executeReplyStrategyEdit(petId, args);
    default:
      return { error: `未知的回复策略工具: ${toolName}` };
  }
}

// ============ 历史查询工具定义 ============

/**
 * 获取历史查询内置工具的 function calling 定义
 * history_read: 按关键词 + 时间范围搜索当前群的聊天记录
 * daily_read: 读取某天的日报摘要
 * daily_list: 列出可用的日报日期
 */
export function getHistoryToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'history_read',
        description: '搜索当前群的历史聊天记录。按关键词过滤，可指定时间范围。返回匹配的消息片段（最新的在最后）。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词（在消息内容中查找包含该文本的记录）',
            },
            start_time: {
              type: 'string',
              description: '起始时间，ISO 8601 格式（如 "2025-01-15T00:00:00Z"）',
            },
            end_time: {
              type: 'string',
              description: '结束时间，ISO 8601 格式。不传则默认为当前时间',
            },
          },
          required: ['query', 'start_time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'daily_read',
        description: '读取指定日期的每日社交摘要。摘要包含当天的聊天总结、关键事件等。',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: '日期，格式 YYYY-MM-DD。不传则默认为昨天',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'daily_list',
        description: '列出所有可用的每日社交摘要日期。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
  ];
}

// ============ 历史查询工具执行 ============

/**
 * 将 GROUP buffer 文件按 ## timestamp 分段
 * 返回 [{ timestamp: Date, text: string }, ...]
 */
function parseGroupBuffer(content) {
  const sections = [];
  // Split by ## header lines (ISO timestamp)
  const regex = /^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z?)$/gm;
  let lastIndex = 0;
  let lastTimestamp = null;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (lastTimestamp !== null) {
      sections.push({
        timestamp: lastTimestamp,
        text: content.slice(lastIndex, match.index).trim(),
      });
    }
    lastTimestamp = new Date(match[1]);
    lastIndex = match.index;
  }
  // Push the last section
  if (lastTimestamp !== null) {
    sections.push({
      timestamp: lastTimestamp,
      text: content.slice(lastIndex).trim(),
    });
  }
  return sections;
}

async function executeHistoryRead(petId, targetId, args) {
  const { query, start_time, end_time } = args;
  if (!query) return { error: '缺少 query 参数' };
  if (!start_time) return { error: '缺少 start_time 参数' };

  const startDate = new Date(start_time);
  const endDate = end_time ? new Date(end_time) : new Date();

  if (isNaN(startDate.getTime())) return { error: 'start_time 格式无效' };
  if (isNaN(endDate.getTime())) return { error: 'end_time 格式无效' };

  const bufferPath = `${GROUP_BUFFER_PATH_PREFIX}${targetId}.md`;
  let content;
  try {
    content = await tauri.workspaceRead(petId, bufferPath);
  } catch {
    return { content: [{ type: 'text', text: '（当前群没有历史记录）' }] };
  }

  if (!content) {
    return { content: [{ type: 'text', text: '（当前群历史记录为空）' }] };
  }

  const sections = parseGroupBuffer(content);
  const queryLower = query.toLowerCase();

  // Filter by time range + query match
  const matched = sections.filter(s => {
    if (s.timestamp < startDate || s.timestamp > endDate) return false;
    return s.text.toLowerCase().includes(queryLower);
  });

  if (matched.length === 0) {
    return { content: [{ type: 'text', text: `在 ${start_time} ~ ${end_time || '现在'} 范围内未找到包含"${query}"的记录。` }] };
  }

  // Build result, truncate from the tail (keep most recent)
  let result = '';
  for (let i = matched.length - 1; i >= 0; i--) {
    const entry = matched[i].text + '\n\n';
    if (result.length + entry.length > HISTORY_READ_MAX_CHARS) break;
    result = entry + result;
  }

  return { content: [{ type: 'text', text: result.trim() }] };
}

async function executeDailyRead(petId, args) {
  let dateStr = args?.date;
  if (!dateStr) {
    // Default to yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = yesterday.toISOString().split('T')[0];
  }

  // Validate format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { error: 'date 格式无效，应为 YYYY-MM-DD' };
  }

  const dailyPath = `${DAILY_PATH_PREFIX}${dateStr}.md`;
  try {
    const content = await tauri.workspaceRead(petId, dailyPath);
    return { content: [{ type: 'text', text: content || '（该日期的摘要为空）' }] };
  } catch {
    return { content: [{ type: 'text', text: `（${dateStr} 没有日报摘要）` }] };
  }
}

async function executeDailyList(petId) {
  const dates = [];
  const today = new Date();

  // Check last 30 days
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dailyPath = `${DAILY_PATH_PREFIX}${dateStr}.md`;
    try {
      const exists = await tauri.workspaceFileExists(petId, dailyPath);
      if (exists) dates.push(dateStr);
    } catch {
      // ignore
    }
  }

  if (dates.length === 0) {
    return { content: [{ type: 'text', text: '（暂无日报摘要文件）' }] };
  }

  return { content: [{ type: 'text', text: `可用日报日期（最近30天）：\n${dates.join('\n')}` }] };
}

/**
 * 执行历史查询内置工具
 *
 * @param {string} toolName - 'history_read' | 'daily_read' | 'daily_list'
 * @param {Object} args - 工具参数
 * @param {Object} context - { petId, targetId }
 * @returns {Promise<Object>} MCP 标准响应格式
 */
export async function executeHistoryBuiltinTool(toolName, args, context) {
  const { petId, targetId } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行历史查询操作。' };
  }

  console.log(`[History] Executing ${toolName}`, { petId, targetId });

  switch (toolName) {
    case 'history_read':
      if (!targetId) return { error: '缺少 targetId（群号），无法查询历史记录。' };
      return executeHistoryRead(petId, targetId, args);
    case 'daily_read':
      return executeDailyRead(petId, args);
    case 'daily_list':
      return executeDailyList(petId);
    default:
      return { error: `未知的历史查询工具: ${toolName}` };
  }
}

// ============ 跨群日志工具 ============

/**
 * 获取跨群日志工具的 function calling 定义
 */
export function getGroupLogToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'group_log_list',
        description: '列出所有有日志记录的群（群号+群名）。用于了解当前监控了哪些群。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'group_log_read',
        description: '搜索指定群的原始日志（Observer 每轮记录的消息摘要）。支持同时查询多个群。不传 query 则返回最新日志内容。',
        parameters: {
          type: 'object',
          properties: {
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: '要查询的群号列表（可从 group_log_list 获取）',
            },
            query: {
              type: 'string',
              description: '搜索关键词（可选，不传则返回最新内容）',
            },
            start_time: {
              type: 'string',
              description: '起始时间，ISO 8601 格式（可选，不传则不限起始时间）',
            },
            end_time: {
              type: 'string',
              description: '结束时间，ISO 8601 格式（可选，不传则默认为当前时间）',
            },
          },
          required: ['targets'],
        },
      },
    },
  ];
}

/**
 * 执行 group_log_list：列出所有有记录的群
 */
async function executeGroupLogList(petId) {
  try {
    const raw = await tauri.workspaceRead(petId, KNOWN_TARGETS_PATH);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      return { content: [{ type: 'text', text: '（暂无群日志记录）' }] };
    }
    const lines = arr.map(item => {
      if (typeof item === 'string') return `- ${item}`;
      return item.name ? `- ${item.id}（${item.name}）` : `- ${item.id}`;
    });
    return { content: [{ type: 'text', text: `已记录的群：\n${lines.join('\n')}` }] };
  } catch {
    return { content: [{ type: 'text', text: '（暂无群日志记录）' }] };
  }
}

/**
 * 执行 group_log_read：搜索指定群的日志
 */
async function executeGroupLogRead(petId, args) {
  const { targets, query, start_time, end_time } = args;
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return { error: '缺少 targets 参数（群号数组）' };
  }

  const startDate = start_time ? new Date(start_time) : null;
  const endDate = end_time ? new Date(end_time) : new Date();
  if (start_time && isNaN(startDate.getTime())) return { error: 'start_time 格式无效' };
  if (end_time && isNaN(endDate.getTime())) return { error: 'end_time 格式无效' };

  const queryLower = query ? query.toLowerCase() : null;
  let totalChars = 0;
  const results = [];

  for (const target of targets) {
    const bufferPath = `${GROUP_BUFFER_PATH_PREFIX}${target}.md`;
    let content;
    try {
      content = await tauri.workspaceRead(petId, bufferPath);
    } catch { continue; }
    if (!content || !content.trim()) continue;

    const sections = parseGroupBuffer(content);

    // Filter by time range + optional query
    let matched = sections;
    if (startDate || endDate) {
      matched = matched.filter(s => {
        if (startDate && s.timestamp < startDate) return false;
        if (endDate && s.timestamp > endDate) return false;
        return true;
      });
    }
    if (queryLower) {
      matched = matched.filter(s => s.text.toLowerCase().includes(queryLower));
    }

    if (matched.length === 0) continue;

    // 取最新的部分（从尾部截取），受总字符数限制
    let groupResult = '';
    for (let i = matched.length - 1; i >= 0; i--) {
      const entry = matched[i].text + '\n\n';
      if (totalChars + groupResult.length + entry.length > HISTORY_READ_MAX_CHARS) break;
      groupResult = entry + groupResult;
    }

    if (groupResult.trim()) {
      results.push(`【${target}】\n${groupResult.trim()}`);
      totalChars += groupResult.length;
    }

    if (totalChars >= HISTORY_READ_MAX_CHARS) break;
  }

  if (results.length === 0) {
    const hint = queryLower ? `包含"${query}"的` : '';
    return { content: [{ type: 'text', text: `在指定群中未找到${hint}日志记录。` }] };
  }

  return { content: [{ type: 'text', text: results.join('\n\n') }] };
}

/**
 * 执行跨群日志内置工具
 */
export async function executeGroupLogBuiltinTool(toolName, args, context) {
  const { petId } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行跨群日志操作。' };
  }

  console.log(`[GroupLog] Executing ${toolName}`, { petId });

  switch (toolName) {
    case 'group_log_list':
      return executeGroupLogList(petId);
    case 'group_log_read':
      return executeGroupLogRead(petId, args);
    default:
      return { error: `未知的跨群日志工具: ${toolName}` };
  }
}