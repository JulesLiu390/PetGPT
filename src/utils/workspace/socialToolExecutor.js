/**
 * socialToolExecutor.js — 社交代理专用内置工具执行器
 *
 * 通用文件工具：social_tree / social_read / social_write / social_edit / social_delete / social_rename
 *   操作 social/ 子目录下的任意文件，LLM 自主决定文件组织方式。
 *
 * 查询工具（保留专用逻辑）：
 *   history_read / daily_read / daily_list — 历史聊天搜索
 *   group_log_list / group_log_read — 跨群日志搜索
 */

import * as tauri from '../tauri';

// ============ 常量 ============

/** social 子目录前缀（所有社交文件必须在此目录下） */
const SOCIAL_DIR = 'social';

/** 群压缩历史日志路径前缀 */
const GROUP_LOG_PATH_PREFIX = 'social/group/LOG_';

/** 每日摘要路径前缀 */
const DAILY_PATH_PREFIX = 'social/daily/';

/** 已知 target 列表 */
const KNOWN_TARGETS_PATH = 'social/targets.json';

/** 历史查询返回最大字符数 */
export const HISTORY_READ_MAX_CHARS = 8000;

/** 单个社交文件最大字符数（写入时校验） */
export const SOCIAL_FILE_MAX_CHARS = 20000;

// ============ 通用文件工具 ============

const SOCIAL_FILE_TOOL_NAMES = new Set(['social_tree', 'social_read', 'social_write', 'social_edit', 'social_delete', 'social_rename']);

/** 检查工具名是否为社交通用文件工具 */
export function isSocialFileTool(toolName) {
  return SOCIAL_FILE_TOOL_NAMES.has(toolName);
}

/**
 * 获取社交通用文件工具的 function calling 定义
 */
export function getSocialFileToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'social_tree',
        description: '列出社交工作区 social/ 的目录结构（含所有子目录和文件）。用于了解当前有哪些文件、确认路径。',
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
        name: 'social_read',
        description: '读取社交工作区中的一个文件。路径相对于工作区根目录，例如 "social/people/123456.md"、"social/group/RULE_789.md"、"social/SOCIAL_MEMORY.md"。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（必须以 social/ 开头）',
            },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'social_write',
        description: '创建或覆盖社交工作区中的一个文件。会自动创建中间目录。路径必须以 social/ 开头。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（必须以 social/ 开头）',
            },
            content: {
              type: 'string',
              description: '要写入的完整内容',
            },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'social_edit',
        description: '通过精确文本查找替换来编辑社交工作区中的一个文件。使用前必须先调用 social_read 获取当前内容。每次只改一处，改完再 read 确认结果。如果需要大幅修改（超过一半内容），直接用 social_write 覆盖更可靠。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（必须以 social/ 开头）',
            },
            oldText: {
              type: 'string',
              description: '要替换的原文，必须从 social_read 返回的内容中精确复制（包括标点、空格、换行），不要凭记忆手打',
            },
            newText: {
              type: 'string',
              description: '替换后的新文本',
            },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'social_delete',
        description: '删除社交工作区中的一个文件。删除前建议先 social_read 确认内容，避免误删。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（必须以 social/ 开头）',
            },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'social_rename',
        description: '移动或重命名社交工作区中的一个文件。会自动创建目标路径的中间目录。',
        parameters: {
          type: 'object',
          properties: {
            from: {
              type: 'string',
              description: '源文件路径（必须以 social/ 开头）',
            },
            to: {
              type: 'string',
              description: '目标文件路径（必须以 social/ 开头）',
            },
          },
          required: ['from', 'to'],
        },
      },
    },
  ];
}

// ============ 路径安全 ============

/**
 * 校验路径是否在 social/ 目录下
 * @param {string} path
 * @returns {boolean}
 */
function isSocialPath(path) {
  if (!path) return false;
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('social/') && !normalized.includes('..');
}

/**
 * 只读路径（系统自动写入，LLM 不允许覆盖）
 */
const READ_ONLY_PREFIXES = [
  'social/group/LOG_',  // 压缩历史（Fetcher 自动写入）
  'social/daily/',      // 日报（系统自动生成）
  'social/targets.json', // 已知 target 列表
];

function isReadOnlyPath(path) {
  const normalized = path.replace(/\\/g, '/');
  return READ_ONLY_PREFIXES.some(p => normalized.startsWith(p) || normalized === p);
}

// ============ 通用文件工具执行 ============

async function executeSocialTree(petId) {
  try {
    const entries = await tauri.workspaceListDir(petId, SOCIAL_DIR);
    if (!entries || entries.length === 0) {
      return { content: [{ type: 'text', text: 'social/ 目录为空。你可以用 social_write 创建文件。' }] };
    }
    // 构建树形显示
    const tree = buildTreeString(entries);
    return { content: [{ type: 'text', text: `social/\n${tree}` }] };
  } catch (e) {
    // 目录不存在时返回空提示
    if (e?.toString?.()?.includes('不存在') || e?.toString?.()?.includes('FileNotFound')) {
      return { content: [{ type: 'text', text: 'social/ 目录尚未创建。用 social_write 写入第一个文件时会自动创建。' }] };
    }
    return { error: e.toString() };
  }
}

/**
 * 将扁平的路径列表转换为缩进的树形字符串
 */
function buildTreeString(entries) {
  // entries 已按字母排序，格式如 "social/group/RULE_123.md", "social/people/"
  // 去掉 "social/" 前缀后按层级缩进
  const lines = [];
  for (const entry of entries) {
    let rel = entry;
    if (rel.startsWith('social/')) rel = rel.slice('social/'.length);
    if (!rel) continue;
    const depth = (rel.match(/\//g) || []).length;
    const isDir = rel.endsWith('/');
    const name = isDir ? rel.split('/').filter(Boolean).pop() + '/' : rel.split('/').pop();
    // 只显示叶子节点的名字，目录前缀通过缩进表达
    const indent = '  '.repeat(depth);
    // 避免目录行和其子文件重复：只有目录条目才加目录行
    if (isDir) {
      lines.push(`${indent}${name}`);
    } else {
      // 文件条目，用最后一级的缩进
      const fileDepth = rel.split('/').length - 1;
      lines.push(`${'  '.repeat(fileDepth)}${name}`);
    }
  }
  return lines.join('\n');
}

async function executeSocialRead(petId, args) {
  const { path } = args;
  if (!path) return { error: '缺少 path 参数' };
  if (!isSocialPath(path)) return { error: '路径必须以 social/ 开头' };

  try {
    const content = await tauri.workspaceRead(petId, path);
    return { content: [{ type: 'text', text: content || '（空文件）' }] };
  } catch (e) {
    if (e?.toString?.()?.includes('不存在') || e?.toString?.()?.includes('FileNotFound')) {
      return { content: [{ type: 'text', text: `（文件不存在: ${path}）` }] };
    }
    return { error: e.toString() };
  }
}

async function executeSocialWrite(petId, args) {
  const { path, content } = args;
  if (!path) return { error: '缺少 path 参数' };
  if (content === undefined || content === null) return { error: '缺少 content 参数' };
  if (!isSocialPath(path)) return { error: '路径必须以 social/ 开头' };
  if (isReadOnlyPath(path)) return { error: `${path} 是系统自动维护的只读文件，不允许手动写入。` };
  if (content.length > SOCIAL_FILE_MAX_CHARS) {
    return { error: `内容超出单文件上限（${SOCIAL_FILE_MAX_CHARS} 字符），请精简后重试。` };
  }

  try {
    const result = await tauri.workspaceWrite(petId, path, content);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

async function executeSocialEdit(petId, args) {
  const { path, oldText, newText } = args;
  if (!path) return { error: '缺少 path 参数' };
  if (!oldText) return { error: '缺少 oldText 参数' };
  if (newText === undefined || newText === null) return { error: '缺少 newText 参数' };
  if (!isSocialPath(path)) return { error: '路径必须以 social/ 开头' };
  if (isReadOnlyPath(path)) return { error: `${path} 是系统自动维护的只读文件，不允许手动编辑。` };

  try {
    const result = await tauri.workspaceEdit(petId, path, oldText, newText);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

async function executeSocialDelete(petId, args) {
  const { path } = args;
  if (!path) return { error: '缺少 path 参数' };
  if (!isSocialPath(path)) return { error: '路径必须以 social/ 开头' };
  if (isReadOnlyPath(path)) return { error: `${path} 是系统自动维护的只读文件，不允许删除。` };

  try {
    const result = await tauri.workspaceDeleteFile(petId, path);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

async function executeSocialRename(petId, args) {
  const { from, to } = args;
  if (!from) return { error: '缺少 from 参数' };
  if (!to) return { error: '缺少 to 参数' };
  if (!isSocialPath(from)) return { error: 'from 路径必须以 social/ 开头' };
  if (!isSocialPath(to)) return { error: 'to 路径必须以 social/ 开头' };
  if (isReadOnlyPath(from)) return { error: `${from} 是系统自动维护的只读文件，不允许移动。` };
  if (isReadOnlyPath(to)) return { error: `${to} 是系统自动维护的只读路径，不允许写入。` };

  try {
    const result = await tauri.workspaceRenameFile(petId, from, to);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

/**
 * 执行社交通用文件工具
 *
 * @param {string} toolName - 'social_tree' | 'social_read' | 'social_write' | 'social_edit' | 'social_delete' | 'social_rename'
 * @param {Object} args - 工具参数
 * @param {Object} context - { petId }
 * @returns {Promise<Object>} MCP 标准响应格式
 */
export async function executeSocialFileTool(toolName, args, context) {
  const { petId } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行社交文件操作。' };
  }

  console.log(`[SocialFile] Executing ${toolName}`, { petId, path: args?.path });

  switch (toolName) {
    case 'social_tree':
      return executeSocialTree(petId);
    case 'social_read':
      return executeSocialRead(petId, args);
    case 'social_write':
      return executeSocialWrite(petId, args);
    case 'social_edit':
      return executeSocialEdit(petId, args);
    case 'social_delete':
      return executeSocialDelete(petId, args);
    case 'social_rename':
      return executeSocialRename(petId, args);
    default:
      return { error: `未知的社交文件工具: ${toolName}` };
  }
}

// ============ 历史查询工具（保留，有复杂查询逻辑） ============

const HISTORY_TOOL_NAMES = new Set(['history_read', 'daily_read', 'daily_list']);

export function isHistoryBuiltinTool(toolName) {
  return HISTORY_TOOL_NAMES.has(toolName);
}

export function getHistoryToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'history_read',
        description: '搜索指定群的历史聊天记录。按关键词过滤，可指定时间范围。返回匹配的消息片段（最新的在最后）。',
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

  const bufferPath = `${GROUP_LOG_PATH_PREFIX}${targetId}.md`;
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

  const matched = sections.filter(s => {
    if (s.timestamp < startDate || s.timestamp > endDate) return false;
    return s.text.toLowerCase().includes(queryLower);
  });

  if (matched.length === 0) {
    return { content: [{ type: 'text', text: `在 ${start_time} ~ ${end_time || '现在'} 范围内未找到包含"${query}"的记录。` }] };
  }

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
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = yesterday.toISOString().split('T')[0];
  }

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

// ============ 跨群日志工具（保留，有跨群搜索逻辑） ============

const GROUP_LOG_TOOL_NAMES = new Set(['group_log_list', 'group_log_read']);

export function isGroupLogBuiltinTool(toolName) {
  return GROUP_LOG_TOOL_NAMES.has(toolName);
}

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
    const bufferPath = `${GROUP_LOG_PATH_PREFIX}${target}.md`;
    let content;
    try {
      content = await tauri.workspaceRead(petId, bufferPath);
    } catch { continue; }
    if (!content || !content.trim()) continue;

    const sections = parseGroupBuffer(content);

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
