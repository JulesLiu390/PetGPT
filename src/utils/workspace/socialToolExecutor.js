/**
 * socialToolExecutor.js — 社交代理专用内置工具执行器
 * 
 * 只允许操作 social/SOCIAL_MEMORY.md，路径硬编码，不需要 path 参数。
 * 工具名使用 social_read / social_write / social_edit 前缀，
 * 与主聊天的 read / write / edit 工具隔离。
 */

import * as tauri from '../tauri';

// ============ 常量 ============

const SOCIAL_MEMORY_PATH = 'social/SOCIAL_MEMORY.md';
const SOCIAL_TOOL_NAMES = new Set(['social_read', 'social_write', 'social_edit']);

/** 社交记忆文件最大字符数 */
export const SOCIAL_MEMORY_MAX_CHARS = 10000;

// ============ 工具检测 ============

/**
 * 检查工具名是否为社交内置工具
 */
export function isSocialBuiltinTool(toolName) {
  return SOCIAL_TOOL_NAMES.has(toolName);
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
        description: '通过精确文本查找替换来编辑你的社交长期记忆文件。oldText 必须精确匹配文件中的内容。',
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
