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
import { downloadUrlAsBase64 } from '../tauri';

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
  'social/stickers/index.yaml', // 表情包索引（由 sticker_save 自动维护）
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

  let result;
  switch (toolName) {
    case 'social_tree':
      result = await executeSocialTree(petId);
      break;
    case 'social_read':
      result = await executeSocialRead(petId, args);
      // Mark subagent results as read by Intent
      if (args?.path?.includes('subagent_sa_') && context.subagentRegistry) {
        const match = args.path.match(/subagent_(sa_[^./]+)/);
        if (match) {
          const entry = context.subagentRegistry.get(match[1]);
          if (entry) entry.readByIntent = true;
        }
      }
      break;
    case 'social_write': {
      // 拦截写入 reply_brief.md 的调用：如果思考过程中有新消息，强制先 social_edit 再重试
      const isReplyBrief = args?.path?.includes('reply_brief.md');
      const injectionWatermarks = context.intentInjectionWatermarks;
      const interceptCounts = context.intentInterceptCounts;
      const buf = context.dataBuffer?.get(context.targetId);
      const MAX_INTERCEPTS = 2;

      if (isReplyBrief && injectionWatermarks && interceptCounts && buf) {
        const watermark = injectionWatermarks.get(context.targetId) || '';
        const currentIntercepts = interceptCounts.get(context.targetId) || 0;
        const customRules = context.customGroupRules || '';

        // 找到水位线之后的新消息
        let newMessages = [];
        if (watermark) {
          const idx = buf.messages.findIndex(m => m.message_id === watermark);
          if (idx >= 0) newMessages = buf.messages.slice(idx + 1);
        }

        if (newMessages.length > 0 && currentIntercepts < MAX_INTERCEPTS) {
          // 推进水位线 + 拦截计数
          const lastNewMsg = newMessages[newMessages.length - 1];
          if (lastNewMsg?.message_id) injectionWatermarks.set(context.targetId, lastNewMsg.message_id);
          interceptCounts.set(context.targetId, currentIntercepts + 1);

          // 格式化新消息
          const botId = context.botQQ || '';
          const updateText = newMessages.map(m => {
            const name = m.sender_id === botId ? '[BOT]' : (m.sender_name || m.sender_id || '?');
            return `[${name}] ${m.content || ''}`;
          }).join('\n');

          // 写日志（独立条目，用户可看到拦截事件和注入的新消息）
          if (context.addLog) {
            context.addLog(
              'intent',
              `🛑 intercept social_write: ${newMessages.length} 条新消息 (${currentIntercepts + 1}/${MAX_INTERCEPTS})`,
              JSON.stringify({
                intercepted: 'reply_brief.md',
                newMessages: newMessages.map(m => ({
                  sender: m.sender_name || m.sender_id,
                  content: m.content,
                  isBot: m.sender_id === botId,
                })),
                interceptCount: currentIntercepts + 1,
                maxIntercepts: MAX_INTERCEPTS,
              }),
              context.targetId
            );
          }

          const customRulesBlock = customRules && customRules.trim()
            ? `\n\n⚠️ 自定义群规则（最高优先级，必须严格遵守）：\n${customRules.trim()}\n`
            : '';

          return {
            content: [{
              type: 'text',
              text: `⚠️ social_write 暂缓执行。你在思考过程中，群里出现了 ${newMessages.length} 条新消息（含 bot 自己刚发送的）：\n\n${updateText}\n\n你必须：\n1. 先用 social_edit 重新更新 INTENT 状态文件（【我刚做了】【群里情况】【我的判断】要反映这些新消息）\n2. 然后再次调用 social_write 写 reply_brief（可能需要调整内容或取消回复）\n\n不要直接跳到 write_intent_plan — 基于旧状态的 plan 已经过时了。${customRulesBlock}\n(第 ${currentIntercepts + 1}/${MAX_INTERCEPTS} 次拦截)`
            }],
          };
        }
      }

      result = await executeSocialWrite(petId, args);
      break;
    }
    case 'social_edit':
      result = await executeSocialEdit(petId, args);
      break;
    case 'social_delete':
      result = await executeSocialDelete(petId, args);
      break;
    case 'social_rename':
      result = await executeSocialRename(petId, args);
      break;
    default:
      return { error: `未知的社交文件工具: ${toolName}` };
  }
  return result;
}

// ============ 缓冲区搜索工具（Observer 用，搜索当前 buffer 中的完整消息） ============

const BUFFER_SEARCH_TOOL_NAMES = new Set(['buffer_search']);

export function isBufferSearchTool(toolName) {
  return BUFFER_SEARCH_TOOL_NAMES.has(toolName);
}

export function getBufferSearchToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'buffer_search',
        description: '搜索当前群/好友的消息缓冲区。按关键词匹配消息内容和发送者名称，返回匹配的消息（最新的在最后）。用于查找上下文窗口之外的较早消息。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词（在消息内容和发送者名称中查找）',
            },
            limit: {
              type: 'number',
              description: '最多返回条数，默认 10，最大 10',
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

export function executeBufferSearchTool(toolName, args, context) {
  if (toolName !== 'buffer_search') return { error: `未知工具: ${toolName}` };

  const { query, limit: rawLimit } = args || {};
  if (!query) return { error: '必须提供 query 参数' };

  const bufferMessages = context.bufferMessages;
  if (!bufferMessages || bufferMessages.length === 0) {
    return { text: '缓冲区为空，没有可搜索的消息。' };
  }

  const maxResults = Math.min(Math.max(rawLimit || 10, 1), 10);
  const lowerQuery = query.toLowerCase();
  const queryTerms = lowerQuery.split(/\s+/).filter(Boolean);

  // 搜索并计算相关度（关键词命中次数）
  const scored = [];
  for (const msg of bufferMessages) {
    const content = (msg.content || '').toLowerCase();
    const sender = (msg.sender_name || msg.sender_id || '').toLowerCase();
    const text = content + ' ' + sender;
    let score = 0;
    for (const term of queryTerms) {
      // 计算每个关键词在文本中出现的次数
      let idx = 0;
      while ((idx = text.indexOf(term, idx)) !== -1) { score++; idx += term.length; }
    }
    if (score > 0) scored.push({ msg, score });
  }

  if (scored.length === 0) {
    return { text: `未找到包含"${query}"的消息。缓冲区共 ${bufferMessages.length} 条消息。` };
  }

  // 按相关度降序，同分按时间降序（最新优先）
  scored.sort((a, b) => b.score - a.score || (b.msg.timestamp || 0) - (a.msg.timestamp || 0));
  const results = scored.slice(0, maxResults);
  const lines = results.map(({ msg: m, score }) => {
    const time = m.timestamp ? new Date(m.timestamp * 1000).toISOString().slice(11, 19) : '??:??:??';
    const sender = m.sender_name || m.sender_id || 'unknown';
    const content = (m.content || '').substring(0, 200);
    return `[${time}] ${sender}: ${content}`;
  });

  return { text: `找到 ${scored.length} 条匹配消息（显示最相关 ${results.length} 条）：\n\n${lines.join('\n')}` };
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
        description: '读取每日社交摘要。不传 target 读全局跨群日报；传 target 读该群/好友的详细日报。',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: '日期，格式 YYYY-MM-DD。不传则默认为昨天',
            },
            target: {
              type: 'string',
              description: '群号或好友 ID。不传则读全局日报，传了则读该群/好友的单独日报',
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
        description: '列出可用的每日社交摘要。返回日期列表及每天有哪些群的独立日报。',
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

  const target = args?.target;

  if (target) {
    // 读取特定群/好友的日报
    const perGroupPath = `${DAILY_PATH_PREFIX}${dateStr}/${target}.md`;
    try {
      const content = await tauri.workspaceRead(petId, perGroupPath);
      return { content: [{ type: 'text', text: content || '（该日期该群的摘要为空）' }] };
    } catch {
      return { content: [{ type: 'text', text: `（${dateStr} 没有 ${target} 的独立日报）` }] };
    }
  }

  // 读取全局日报
  const dailyPath = `${DAILY_PATH_PREFIX}${dateStr}.md`;
  try {
    const content = await tauri.workspaceRead(petId, dailyPath);
    return { content: [{ type: 'text', text: content || '（该日期的摘要为空）' }] };
  } catch {
    return { content: [{ type: 'text', text: `（${dateStr} 没有日报摘要）` }] };
  }
}

async function executeDailyList(petId) {
  const entries = [];
  const today = new Date();

  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dailyPath = `${DAILY_PATH_PREFIX}${dateStr}.md`;
    let hasGlobal = false;
    try {
      hasGlobal = await tauri.workspaceFileExists(petId, dailyPath);
    } catch { /* ignore */ }

    // 检查该日期是否有每群日报文件夹
    let groupFiles = [];
    try {
      const dirPath = `${DAILY_PATH_PREFIX}${dateStr}`;
      const tree = await tauri.workspaceListDir(petId, dirPath);
      if (tree && Array.isArray(tree)) {
        groupFiles = tree
          .filter(f => f.name && f.name.endsWith('.md'))
          .map(f => f.name.replace('.md', ''));
      }
    } catch { /* folder doesn't exist */ }

    if (hasGlobal || groupFiles.length > 0) {
      let line = dateStr;
      if (groupFiles.length > 0) {
        line += `  (${groupFiles.length} 个群独立日报: ${groupFiles.join(', ')})`;
      }
      entries.push(line);
    }
  }

  if (entries.length === 0) {
    return { content: [{ type: 'text', text: '（暂无日报摘要文件）' }] };
  }

  return { content: [{ type: 'text', text: `可用日报日期（最近30天）：\n${entries.join('\n')}` }] };
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

// ============ 表情包收藏工具 ============

const STICKER_DIR = 'social/stickers';
const STICKER_INDEX_PATH = `${STICKER_DIR}/index.yaml`;
const STICKER_MAX_COUNT = 30;

const STICKER_TOOL_NAMES = new Set(['sticker_save', 'sticker_list', 'sticker_send']);

/** 每个 target 上次发送的 sticker 记录 { id, time }，带冷却 */
const lastStickerSent = new Map();
const STICKER_COOLDOWN_MS = 60 * 1000; // 1 分钟冷却

/** 清除指定 target 的表情包冷却（有新消息时调用） */
export function resetStickerCooldown(targetId) {
  lastStickerSent.delete(targetId);
}

export function isStickerBuiltinTool(toolName) {
  return STICKER_TOOL_NAMES.has(toolName);
}

export function getStickerToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'sticker_save',
        description: '收藏一个表情包/贴纸。通过聊天消息中的图片序号（[图片#N] 中的 N）下载并保存。',
        parameters: {
          type: 'object',
          properties: {
            image_id: {
              type: 'number',
              description: '图片序号，即消息中 [图片#N: ...] 的 N',
            },
            meaning: {
              type: 'string',
              description: '这个表情包的含义/用途描述（如"开心大笑"、"无语"、"赞同"）',
            },
          },
          required: ['image_id', 'meaning'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'sticker_list',
        description: '查看已收藏的所有表情包列表（序号 + 含义）。',
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
        name: 'sticker_send',
        description: '发送一个已收藏的表情包到当前群聊。先用 sticker_list 查看有哪些表情包，再用序号发送。',
        parameters: {
          type: 'object',
          properties: {
            sticker_id: {
              type: 'number',
              description: '要发送的表情包序号（从 sticker_list 获取）',
            },
          },
          required: ['sticker_id'],
        },
      },
    },
  ];
}

/**
 * 从 URL 推断文件扩展名
 */
function inferImageExt(url, mimeType) {
  // 先尝试从 MIME 类型推断
  if (mimeType) {
    const mimeMap = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
    };
    const ext = mimeMap[mimeType.toLowerCase()];
    if (ext) return ext;
  }
  // 从 URL 路径推断
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i);
    if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  } catch { /* ignore */ }
  return 'png'; // 默认
}

/**
 * 解析 index.yaml（简单 YAML：每条记录为 "- id: N\n  meaning: ...\n  file: ..."）
 */
function parseStickerIndex(content) {
  if (!content || !content.trim()) return [];
  const entries = [];
  const blocks = content.split(/^- /m).filter(Boolean);
  for (const block of blocks) {
    const entry = {};
    const lines = block.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*(\w+):\s*(.+)$/);
      if (m) entry[m[1]] = m[2].trim();
    }
    if (entry.id) {
      entry.id = parseInt(entry.id, 10);
      if (entry.used != null) entry.used = parseInt(entry.used, 10) || 0;
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * 序列化 sticker entries 为简单 YAML
 */
function serializeStickerIndex(entries) {
  return entries.map(e => {
    let lines = `- id: ${e.id}\n  meaning: ${e.meaning}\n  file: ${e.file}`;
    if (e.url) lines += `\n  url: ${e.url}`;
    if (e.used != null) lines += `\n  used: ${e.used}`;
    if (e.last_used) lines += `\n  last_used: ${e.last_used}`;
    return lines;
  }).join('\n');
}

/**
 * 清除字符串中的安全令牌/分隔符（如 ‹/74a2c1›）
 */
function stripSecurityTokens(text) {
  if (!text) return text;
  // 匹配 ‹...› 或 ‹/...› 格式的安全分隔符
  return text.replace(/[‹<]\/?\w+[›>]/g, '').trim();
}

async function executeStickerSave(petId, args, imageUrlMap) {
  const { image_id } = args;
  let { meaning } = args;
  if (!image_id) return { error: '缺少 image_id 参数' };
  if (!meaning) return { error: '缺少 meaning 参数' };

  // 清除 meaning 中可能泄漏的安全令牌
  meaning = stripSecurityTokens(meaning);

  // 1. 从 imageUrlMap 查找真实 URL
  const url = imageUrlMap?.get(Number(image_id));
  if (!url) {
    return { error: `找不到图片 #${image_id}，请确认序号正确（来自 [图片#N: ...] 中的 N）` };
  }

  // 2. 读取现有索引（提前读取，用于 URL 去重）
  let entries = [];
  try {
    const existing = await tauri.workspaceRead(petId, STICKER_INDEX_PATH);
    entries = parseStickerIndex(existing);
  } catch { /* index doesn't exist yet */ }

  // 3. URL 去重：检查是否已保存过相同 URL 的表情包
  const existingWithUrl = entries.find(e => e.url === url);
  if (existingWithUrl) {
    return { content: [{ type: 'text', text: `该表情包已收藏过（#${existingWithUrl.id}：${existingWithUrl.meaning}），无需重复保存。` }] };
  }

  // 4. 下载图片
  let base64Data, mimeType;
  try {
    const result = await downloadUrlAsBase64(url);
    base64Data = result.data;
    mimeType = result.mime_type;
  } catch (e) {
    return { error: `下载图片失败: ${e}` };
  }

  if (!base64Data) {
    return { error: '下载图片返回空数据' };
  }

  // 5. 确定新 ID 和文件名
  const newId = entries.length > 0 ? Math.max(...entries.map(e => e.id)) + 1 : 1;
  const ext = inferImageExt(url, mimeType);
  const fileName = `stk_${String(newId).padStart(3, '0')}.${ext}`;
  const filePath = `${STICKER_DIR}/${fileName}`;

  // 6. 写入二进制图片
  try {
    await tauri.workspaceWriteBinary(petId, filePath, base64Data);
  } catch (e) {
    return { error: `保存图片文件失败: ${e}` };
  }

  // 7. 更新索引（含 url 用于去重）
  entries.push({ id: newId, meaning, file: fileName, url });
  try {
    await tauri.workspaceWrite(petId, STICKER_INDEX_PATH, serializeStickerIndex(entries));
  } catch (e) {
    return { error: `更新索引失败: ${e}` };
  }

  // 8. 自动清理：超过上限时删除使用频率最低的表情包
  let cleanupMsg = '';
  if (entries.length > STICKER_MAX_COUNT) {
    cleanupMsg = await autoCleanupStickers(petId, entries, newId);
  }

  return { content: [{ type: 'text', text: `已收藏表情包 #${newId}（${meaning}）→ ${fileName}${cleanupMsg}` }] };
}

/**
 * 自动清理表情包：删除使用频率最低的，直到总数 ≤ STICKER_MAX_COUNT
 * @param {string} petId
 * @param {Array} entries - 当前全部条目（会被 mutate）
 * @param {number} excludeId - 刚保存的条目 ID，不参与清理
 * @returns {string} 清理结果描述
 */
async function autoCleanupStickers(petId, entries, excludeId) {
  const toRemoveCount = entries.length - STICKER_MAX_COUNT;
  if (toRemoveCount <= 0) return '';

  // 按 last_used 升序（最久没发的排前面），相同 last_used 再按 used 升序
  const candidates = entries
    .filter(e => e.id !== excludeId)
    .sort((a, b) => {
      const timeA = a.last_used ? new Date(a.last_used).getTime() : 0;
      const timeB = b.last_used ? new Date(b.last_used).getTime() : 0;
      if (timeA !== timeB) return timeA - timeB;
      const usedA = a.used || 0;
      const usedB = b.used || 0;
      return usedA - usedB;
    });

  const toRemove = candidates.slice(0, toRemoveCount);
  const removedIds = [];

  for (const entry of toRemove) {
    // 删除图片文件
    try {
      await tauri.workspaceDeleteFile(petId, `${STICKER_DIR}/${entry.file}`);
    } catch { /* file may not exist */ }
    removedIds.push(entry.id);
  }

  // 从 entries 中移除（原地修改）
  const removeSet = new Set(removedIds);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (removeSet.has(entries[i].id)) {
      entries.splice(i, 1);
    }
  }

  // 更新索引
  try {
    await tauri.workspaceWrite(petId, STICKER_INDEX_PATH, serializeStickerIndex(entries));
  } catch { /* ignore */ }

  return `（已自动清理 ${removedIds.length} 个低频表情包：#${removedIds.join(', #')}）`;
}

async function executeStickerList(petId) {
  let entries = [];
  try {
    const content = await tauri.workspaceRead(petId, STICKER_INDEX_PATH);
    entries = parseStickerIndex(content);
  } catch {
    return { content: [{ type: 'text', text: '（还没有收藏任何表情包）' }] };
  }

  if (entries.length === 0) {
    return { content: [{ type: 'text', text: '（还没有收藏任何表情包）' }] };
  }

  const lines = entries.map(e => `#${e.id} ${e.meaning} (${e.file})`);
  return { content: [{ type: 'text', text: `已收藏 ${entries.length} 个表情包：\n${lines.join('\n')}` }] };
}

async function executeStickerSend(petId, args, context) {
  const { sticker_id } = args;
  if (!sticker_id) return { error: '缺少 sticker_id 参数' };

  const { targetId, targetType, mcpServerName } = context;
  if (!targetId) return { error: '缺少 targetId，无法发送表情包。' };
  if (!mcpServerName) return { error: '缺少 mcpServerName，无法发送表情包。' };

  // 防止短时间内连发同一张表情包（1分钟冷却，有新消息时自动清除）
  const numId = Number(sticker_id);
  const last = lastStickerSent.get(targetId);
  if (last && last.id === numId && (Date.now() - last.time) < STICKER_COOLDOWN_MS) {
    return { error: `表情包 #${sticker_id} 刚刚已经发过了，换一个吧。` };
  }

  // 1. 读取索引找到对应表情包
  let entries = [];
  try {
    const content = await tauri.workspaceRead(petId, STICKER_INDEX_PATH);
    entries = parseStickerIndex(content);
  } catch {
    return { error: '还没有收藏任何表情包，请先用 sticker_save 收藏。' };
  }

  const entry = entries.find(e => e.id === Number(sticker_id));
  if (!entry) {
    return { error: `找不到表情包 #${sticker_id}，请用 sticker_list 查看可用的表情包。` };
  }

  // 2. 读取表情包文件为 base64
  const filePath = `${STICKER_DIR}/${entry.file}`;
  let base64Data;
  try {
    base64Data = await tauri.workspaceReadBinary(petId, filePath);
  } catch (e) {
    return { error: `读取表情包文件失败: ${e}` };
  }

  if (!base64Data) {
    return { error: '表情包文件为空' };
  }

  // 3. 通过 MCP send_image 发送
  const sendArgs = {
    target: targetId,
    target_type: targetType || 'group',
    image: base64Data, // base64 without prefix
  };
  try {
    const fullToolName = `${mcpServerName}__send_image`;
    const result = await tauri.mcp.callToolByName(fullToolName, sendArgs);
    console.log('[Sticker] send_image result:', result);

    // 记录本次发送，防止连发
    lastStickerSent.set(targetId, { id: numId, time: Date.now() });

    // 缓存发送记录（带含义），让 prompt 上下文知道自己发了什么表情包
    if (context.sentCache) {
      const arr = context.sentCache.get(targetId) || [];
      arr.push({
        content: `[发送了表情包#${numId}：${entry.meaning}]`,
        timestamp: new Date().toISOString(),
        _isStickerSend: true,
      });
      context.sentCache.set(targetId, arr);
    }

    // 更新使用计数（不影响发送结果）
    try {
      entry.used = (entry.used || 0) + 1;
      entry.last_used = new Date().toISOString();
      await tauri.workspaceWrite(petId, STICKER_INDEX_PATH, serializeStickerIndex(entries));
    } catch (e) {
      console.warn('[Sticker] Failed to update usage count:', e);
    }

    return { content: [{ type: 'text', text: `已发送表情包 #${sticker_id}（${entry.meaning}）` }] };
  } catch (e) {
    return { error: `发送表情包失败: ${e}` };
  }
}

// ============ Intent 计划工具 ============

export function isIntentPlanTool(toolName) {
  return toolName === 'write_intent_plan';
}

export function getIntentPlanToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'write_intent_plan',
        description: '提交本次评估的**完整决策**——一次原子写入 INTENT 状态文件 + reply_brief（如有 reply 动作）+ 派发 actions。这是 eval 的最后一步，调用后 eval 立即结束。\n⚠️ 调用前必须已通过 social_read recent_self.md 读完最近发送过的内容，避免重复。\n⚠️ 如果中途群里有新消息到达，本调用会被拦截，要求你重新评估并再次提交（最多 5 次）。',
        parameters: {
          type: 'object',
          properties: {
            state: {
              type: 'string',
              description: '⚠️ 必填。完整的 INTENT 状态文件内容（覆盖式写入到 INTENT_<target>.md）。必须包含【我刚做了】【效果复盘】（有上次行动时）【群里情况】【我的判断】，可选【策略】。每段写充分，不要省略。',
            },
            brief: {
              type: 'string',
              description: '完整的 reply_brief 内容（覆盖式写入到 scratch_<target>/reply_brief.md）。**仅当 actions 含 reply 时才填**，否则不传或传空字符串。第 1 行必须是档位标签 [接梗] / [闲扯] / [观点] / [展开] / [深答]，正文 ≤150 字。',
            },
            actions: {
              type: 'array',
              description: '要执行的动作列表（并发执行）。不需要任何动作时传空数组。',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['reply', 'sticker', 'wait'],
                    description: '"reply" = 触发文字回复；"sticker" = 发送表情包；"wait" = 等新消息后再评估。有 reply 或 sticker 时 wait 可省略。',
                  },
                  atTarget: {
                    type: 'string',
                    description: '（reply 专用）要@的人的QQ号（纯数字），不需要@时省略。90% 情况下不需要@，只有同时回复多人或消息已被刷远时才用。',
                  },
                  id: {
                    type: 'integer',
                    description: '（sticker 专用）表情包序号',
                  },
                },
                required: ['type'],
              },
            },
          },
          required: ['state', 'actions'],
        },
      },
    },
  ];
}

export async function executeIntentPlanTool(toolName, args, context) {
  if (toolName !== 'write_intent_plan') return { error: `未知工具: ${toolName}` };
  const { petId, targetId, targetType } = context;
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };

  const { state = '', brief = '', actions = [] } = args || {};
  const intentDir = targetType === 'friend' ? 'friend' : 'group';

  // ── 拦截：检查 eval 中途群里有无新消息，有则要求重提 ──
  // 把原本在 social_write reply_brief 上的拦截语义挪过来，因为现在 plan 是一次性提交的
  const MAX_INTERCEPTS = 2;
  const injectionWatermarks = context.intentInjectionWatermarks;
  const interceptCounts = context.intentInterceptCounts;
  const buf = context.dataBuffer?.get(targetId);
  if (injectionWatermarks && interceptCounts && buf) {
    const watermark = injectionWatermarks.get(targetId) || '';
    const currentIntercepts = interceptCounts.get(targetId) || 0;
    let newMessages = [];
    if (watermark) {
      const idx = buf.messages.findIndex(m => m.message_id === watermark);
      if (idx >= 0) newMessages = buf.messages.slice(idx + 1);
    }

    if (newMessages.length > 0 && currentIntercepts < MAX_INTERCEPTS) {
      const lastNewMsg = newMessages[newMessages.length - 1];
      if (lastNewMsg?.message_id) injectionWatermarks.set(targetId, lastNewMsg.message_id);
      interceptCounts.set(targetId, currentIntercepts + 1);

      const botId = context.botQQ || '';
      const updateText = newMessages.map(m => {
        const name = m.sender_id === botId ? '[BOT]' : (m.sender_name || m.sender_id || '?');
        return `[${name}] ${m.content || ''}`;
      }).join('\n');

      if (context.addLog) {
        context.addLog(
          'intent',
          `🛑 intercept write_intent_plan: ${newMessages.length} 条新消息 (${currentIntercepts + 1}/${MAX_INTERCEPTS})`,
          JSON.stringify({
            intercepted: 'write_intent_plan',
            newMessages: newMessages.map(m => ({
              sender: m.sender_name || m.sender_id,
              content: m.content,
              isBot: m.sender_id === botId,
            })),
            interceptCount: currentIntercepts + 1,
            maxIntercepts: MAX_INTERCEPTS,
          }),
          targetId,
        );
      }

      const customRules = context.customGroupRules || '';
      const customRulesBlock = customRules && customRules.trim()
        ? `\n\n⚠️ 自定义群规则（最高优先级）：\n${customRules.trim()}\n`
        : '';

      return {
        content: [{
          type: 'text',
          text: `⚠️ write_intent_plan 暂缓提交。期间群里出现 ${newMessages.length} 条新消息（含你自己刚发送的）：\n\n${updateText}\n\n请把这些新信息融进 state 的【群里情况】【我的判断】等段落，必要时调整 brief 或 actions，然后再次调用 write_intent_plan 提交完整 plan。${customRulesBlock}\n(第 ${currentIntercepts + 1}/${MAX_INTERCEPTS} 次拦截)`,
        }],
      };
    }
  }

  // ── 写 INTENT 状态文件（覆盖） ──
  if (!state || !state.trim()) {
    return { error: 'state 参数为空，必须提供完整的 INTENT 文件内容（4 段：【我刚做了】【效果复盘】【群里情况】【我的判断】）' };
  }
  const intentPath = `social/${intentDir}/INTENT_${targetId}.md`;
  try {
    await tauri.workspaceWrite(petId, intentPath, state);
  } catch (e) {
    return { error: `写 INTENT 失败: ${e?.message || e}` };
  }

  // ── 写 reply_brief（仅当 actions 含 reply 且 brief 非空） ──
  const hasReply = Array.isArray(actions) && actions.some(a => a?.type === 'reply');
  if (hasReply) {
    if (!brief || !brief.trim()) {
      return { error: 'actions 含 reply 但 brief 为空——必须提供完整 reply_brief（第 1 行档位标签，正文 ≤150 字）' };
    }
    const briefPath = `social/${intentDir}/scratch_${targetId}/reply_brief.md`;
    try {
      await tauri.workspaceWrite(petId, briefPath, brief);
    } catch (e) {
      return { error: `写 reply_brief 失败: ${e?.message || e}` };
    }
  }

  return { content: [{ type: 'text', text: '✓ 计划已提交（INTENT 已更新' + (hasReply ? '，brief 已写入' : '') + '）' }] };
}

// ============ Subagent 工具 ============

/** 检查是否为 subagent 工具 */
export function isSubagentTool(toolName) {
  return toolName === 'dispatch_subagent' || toolName === 'cc_history' || toolName === 'cc_read' || toolName === 'md_organize' || toolName === 'screenshot' || toolName === 'image_send' || toolName === 'image_list' || toolName === 'webshot' || toolName === 'webshot_send' || toolName === 'chat_search' || toolName === 'chat_context' || toolName === 'voice_send' || toolName === 'generate_image_send' || toolName === 'get_situation';
}

/** 获取 dispatch_subagent 工具的 function calling 定义 */
export function getSubagentToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'dispatch_subagent',
      description: '发起一个后台研究任务（也叫 CC / Claude Code）。当用户要求"用CC查"或需要深入调研时使用。CC 会在独立沙箱中自主完成任务（可用 web search 等工具），比普通搜索更深入。结果会异步写入 scratch 文件，你在后续 eval 中用 social_read 读取。发起后请 write_intent_plan(actions=[]) 等待结果。',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '明确的任务描述，例如"查一下 Therac-25 事故经过，200字总结"',
          },
          maxLen: {
            type: 'number',
            description: '结果最大字数限制',
            default: 500,
          },
        },
        required: ['task'],
      },
    },
  };
}

/** 获取 cc_history 工具的 function calling 定义 */
export function getCcHistoryToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'cc_history',
      description: '查看当前群/好友的 CC 后台研究任务历史。返回正在执行/已完成/失败/超时的任务列表，已完成的任务会给出结果文件名，用 cc_read 读取内容。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  };
}

/** 获取 cc_read 工具的 function calling 定义（只能读取 CC 结果文件） */
export function getCcReadToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'cc_read',
      description: '读取 CC 研究结果文件。只能读取 cc_ 开头的文件（由 cc_history 列出的结果文件名）。',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'cc_history 返回的结果文件名，例如 "cc_查Qwen最新模型_sa_abc123.md"',
          },
        },
        required: ['file'],
      },
    },
  };
}

/** 获取 md_organize 工具的 function calling 定义 */
export function getMdOrganizeToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'md_organize',
      description: '异步整理一个 social/ 下的 markdown 文件。会启动一个后台整理助手，用 social_read + social_edit 自动读取并整理文件内容。适用于：追加教训并自动去重排序、精简过长文件、合并重复条目等。调用后不需要等待，继续你的工作即可。',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: '要整理的文件路径（social/ 开头），例如 "social/group/scratch_902317662/lessons.md"',
          },
          context: {
            type: 'string',
            description: '文件背景说明：这个文件是什么、格式规则是什么',
          },
          instruction: {
            type: 'string',
            description: '本次具体指令：要新增什么内容、如何整理、控制条数等',
          },
        },
        required: ['file', 'instruction'],
      },
    },
  };
}

/** 获取 screenshot 工具的 function calling 定义 */
export function getScreenshotToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'screenshot',
      description: '截取 QQ 聊天记录的截图并保存。传入截图描述和起始消息 ID（对话记录中 [#数字] 标注的 ID），系统会自动渲染 QQ 风格截图并保存到 workspace。',
      parameters: {
        type: 'object',
        properties: {
          desc: {
            type: 'string',
            description: '截图描述，例如"关于Qwen性能对比的讨论"',
          },
          message_id: {
            type: 'string',
            description: '从哪条消息开始截图（消息 ID，对话记录中 [#数字] 标注的数字）',
          },
        },
        required: ['desc', 'message_id'],
      },
    },
  };
}

/** 获取 image_send 工具的 function calling 定义 */
export function getImageSendToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'image_send',
      description: '发送一张已保存的图片到当前群聊。file 为 social/images/ 下的文件名。',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: '图片文件名（如 "screenshot_关于Qwen讨论_001.png"）',
          },
        },
        required: ['file'],
      },
    },
  };
}

/** 获取 image_list 工具的 function calling 定义 */
export function getImageListToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'image_list',
      description: '列出已保存的截图/图片。返回文件名、描述和创建时间。用于查看有哪些图片可以用 image action 发送。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  };
}

/**
 * 执行 subagent 相关工具
 */
export async function executeSubagentTool(toolName, args, context) {
  if (toolName === 'cc_history') return executeCcHistory(context);
  if (toolName === 'md_organize') return executeMdOrganize(args, context);
  if (toolName === 'cc_read') return executeCcRead(args, context);
  if (toolName === 'screenshot') return executeScreenshot(args, context);
  if (toolName === 'image_list') return executeImageList(context);
  if (toolName === 'image_send') return executeImageSend(args, context);
  if (toolName === 'webshot') return executeWebshot(args, context);
  if (toolName === 'webshot_send') return executeWebshotSend(args, context);
  if (toolName === 'generate_image_send') return executeGenerateImageSend(args, context);
  if (toolName === 'get_situation') return executeGetSituation(args, context);
  if (toolName === 'chat_search') return executeChatSearch(args, context);
  if (toolName === 'chat_context') return executeChatContext(args, context);
  if (toolName === 'voice_send') return executeVoiceSend(args, context);
  if (toolName !== 'dispatch_subagent') return { error: `未知工具: ${toolName}` };

  const { petId, targetId, targetType, subagentRegistry, subagentConfig } = context;
  if (!petId) return { error: '缺少 petId' };
  if (!subagentConfig?.enabled) return { error: 'Subagent 功能未启用' };

  const { task, maxLen = 500 } = args;
  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return { error: '缺少 task 参数' };
  }

  const taskId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const source = targetId ? 'social' : 'chat';
  const dir = targetType === 'friend' ? 'friend' : 'group';

  const nowDate = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const claudeMd = `# Task

当前日期：${nowDate}

${task.trim()}

## Output

把结果写入 output/result.md。完成后直接退出。

## Constraints
- 结果控制在 ${maxLen} 字以内
- 只输出最终结果，不要输出思考过程
- 用中文
- 必须附上信息来源 URL（每个关键结论标注出处链接）
`;

  try {
    await tauri.workspaceWrite(petId, `subagents/${taskId}/CLAUDE.md`, claudeMd);
    await tauri.workspaceWrite(petId, `subagents/${taskId}/output/.gitkeep`, '');

    const cwd = await tauri.workspaceGetPath(petId, `subagents/${taskId}`, false);

    await tauri.subagentSpawn(
      taskId,
      cwd,
      subagentConfig.model || 'sonnet',
      subagentConfig.timeoutSecs || 300,
      claudeMd,
    );

    // 生成描述性文件名: cc_{task前20字}_{taskId}.md
    const safeName = task.trim().substring(0, 20).replace(/[\/\\:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const resultFileName = `cc_${safeName}_${taskId}.md`;
    const outputPath = source === 'social' && targetId
      ? `social/${dir}/scratch_${targetId}/${resultFileName}`
      : null;

    if (subagentRegistry) {
      subagentRegistry.set(taskId, {
        status: 'running',
        task: task.trim(),
        target: targetId || 'chat',
        targetType: targetType || 'chat',
        dir,
        outputPath,
        resultFileName,
        source,
        createdAt: Date.now(),
      });
    }

    return {
      content: [{ type: 'text', text: `✓ 后台任务已发起: ${taskId}\n任务: ${task.trim()}${outputPath ? `\n结果将写入 ${outputPath}` : ''}` }],
    };
  } catch (e) {
    return { error: `Subagent 发起失败: ${e.message || e}` };
  }
}

/** 读取 cc_index.jsonl + 当前 running 任务，返回格式化的任务历史 */
async function executeCcHistory(context) {
  const { petId, targetId, targetType, subagentRegistry } = context;
  if (!petId) return { error: '缺少 petId' };

  const dir = targetType === 'friend' ? 'friend' : 'group';
  const lines = [];

  // 1. 正在执行的任务（从 live registry）
  if (subagentRegistry) {
    for (const [tid, e] of subagentRegistry) {
      if (e.target === targetId && e.status === 'running') {
        const elapsed = Math.round((Date.now() - e.createdAt) / 1000);
        lines.push(`⏳ [${tid}] ${e.task} — 执行中 (${elapsed}s)`);
      }
    }
  }

  // 2. 已完成的任务（从 cc_index.jsonl）
  const indexPath = targetId ? `social/${dir}/scratch_${targetId}/cc_index.jsonl` : null;
  if (indexPath) {
    try {
      const raw = await tauri.workspaceRead(petId, indexPath).catch(() => '');
      if (raw && raw.trim()) {
        for (const line of raw.trim().split('\n').filter(Boolean)) {
          try {
            const e = JSON.parse(line);
            const icon = e.status === 'done' ? '✅' : e.status === 'timeout' ? '⏰' : '❌';
            const fileHint = e.status === 'done' && e.file
              ? ` → 用 social_read("social/${dir}/scratch_${targetId}/${e.file}") 查看`
              : e.error ? ` (${e.error.substring(0, 80)})` : '';
            lines.push(`${icon} [${e.taskId}] ${e.task} (${e.elapsed ?? '?'}s)${fileHint}`);
          } catch { /* skip */ }
        }
      }
    } catch { /* best-effort */ }
  }

  if (lines.length === 0) {
    return { content: [{ type: 'text', text: '（暂无 CC 任务记录）' }] };
  }
  return { content: [{ type: 'text', text: `CC 任务记录 (${lines.length} 条):\n${lines.join('\n')}` }] };
}

/** 读取 CC 结果文件（只允许读 cc_ 开头的文件） */
async function executeCcRead(args, context) {
  const { petId, targetId, targetType } = context;
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };

  const { file } = args;
  if (!file || typeof file !== 'string') return { error: '缺少 file 参数' };
  if (!file.startsWith('cc_')) return { error: '只能读取 cc_ 开头的文件（CC 结果文件）' };

  const dir = targetType === 'friend' ? 'friend' : 'group';
  const fullPath = `social/${dir}/scratch_${targetId}/${file}`;

  try {
    const content = await tauri.workspaceRead(petId, fullPath);
    return { content: [{ type: 'text', text: content || '（空文件）' }] };
  } catch (e) {
    if (e?.toString?.()?.includes('不存在') || e?.toString?.()?.includes('FileNotFound')) {
      return { content: [{ type: 'text', text: `（文件不存在: ${file}）` }] };
    }
    return { error: `读取失败: ${e}` };
  }
}

/** 执行 md_organize — 验证参数后委托给 context.dispatchMdOrganizer */
async function executeMdOrganize(args, context) {
  const { file, context: fileContext, instruction } = args;
  if (!file || typeof file !== 'string') return { error: '缺少 file 参数' };
  if (!instruction || typeof instruction !== 'string') return { error: '缺少 instruction 参数' };
  if (!file.startsWith('social/')) return { error: '文件路径必须以 social/ 开头' };

  // 委托给 socialAgent 提供的回调（fire-and-forget LLM 调用）
  if (context.dispatchMdOrganizer) {
    context.dispatchMdOrganizer({ file, context: fileContext || '', instruction });
    return { content: [{ type: 'text', text: `✓ 已派整理助手处理 ${file}` }] };
  }
  return { error: 'md_organize 不可用（缺少 dispatchMdOrganizer 回调）' };
}

/** 截取聊天截图并保存到 workspace */
async function executeScreenshot(args, context) {
  const { desc, message_id } = args;
  const { petId, targetId, targetType, mcpServerName } = context;
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };
  if (!desc || !message_id) return { error: '缺少 desc 或 message_id' };
  if (!mcpServerName) return { error: '缺少 mcpServerName' };

  try {
    // 1. 调 MCP screenshot_chat
    const screenshotToolName = `${mcpServerName}__screenshot_chat`;
    const result = await tauri.mcp.callToolByName(screenshotToolName, {
      target: targetId,
      message_id: String(message_id),
      target_type: targetType || 'group',
    });

    // 解析结果
    let base64Data = null;
    if (result?.content) {
      for (const item of result.content) {
        if (item.type === 'text') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed.success && parsed.image) {
              base64Data = parsed.image;
            } else if (parsed.error) {
              return { error: `截图失败: ${parsed.error}` };
            }
          } catch { /* not JSON */ }
        }
      }
    }
    if (!base64Data) return { error: '截图失败: 未获取到图片数据' };

    // 2. 生成文件名
    const safeName = desc.trim().substring(0, 30).replace(/[/\\:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const id = Date.now().toString(36);
    const fileName = `screenshot_${safeName}_${id}.png`;

    // 3. 保存到 workspace
    await tauri.workspaceWriteBinary(petId, `social/images/${fileName}`, base64Data);

    // 4. 追加 index.toml
    const tomlEntry = `\n[[screenshots]]\nfile = "${fileName}"\ndesc = "${desc.trim().replace(/"/g, '\\"')}"\nmessage_id = "${message_id}"\ncreated_at = "${new Date().toISOString()}"\n`;
    await tauri.workspaceAppend(petId, 'social/images/index.toml', tomlEntry);

    return {
      content: [{ type: 'text', text: `✓ 截图已保存: ${fileName}\n描述: ${desc}\n起始消息: #${message_id}` }],
    };
  } catch (e) {
    return { error: `截图失败: ${e.message || e}` };
  }
}

/** 发送已保存的图片 */
/** 列出已保存的截图/图片 */
async function executeImageList(context) {
  const { petId } = context;
  if (!petId) return { error: '缺少 petId' };

  try {
    const raw = await tauri.workspaceRead(petId, 'social/images/index.toml').catch(() => '');
    if (!raw || !raw.trim()) {
      return { content: [{ type: 'text', text: '（暂无已保存的图片）' }] };
    }
    // 简单解析 toml: 提取 file, desc, created_at
    const entries = [];
    let current = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '[[screenshots]]') {
        if (current.file) entries.push(current);
        current = {};
      } else if (trimmed.startsWith('file = ')) {
        current.file = trimmed.slice(8, -1); // remove quotes
      } else if (trimmed.startsWith('desc = ')) {
        current.desc = trimmed.slice(8, -1);
      } else if (trimmed.startsWith('created_at = ')) {
        current.created_at = trimmed.slice(14, -1);
      }
    }
    if (current.file) entries.push(current);

    if (entries.length === 0) {
      return { content: [{ type: 'text', text: '（暂无已保存的图片）' }] };
    }

    const lines = entries.map(e => `🖼️ ${e.file} — ${e.desc || '无描述'} (${e.created_at?.substring(0, 10) || '?'})`);
    return { content: [{ type: 'text', text: `已保存 ${entries.length} 张图片：\n${lines.join('\n')}` }] };
  } catch (e) {
    return { error: `读取图片列表失败: ${e.message || e}` };
  }
}

async function executeImageSend(args, context) {
  const { file } = args;
  const { petId, targetId, targetType, mcpServerName } = context;
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };
  if (!file) return { error: '缺少 file 参数' };
  if (!mcpServerName) return { error: '缺少 mcpServerName' };

  try {
    // 读取 base64 图片
    const base64Data = await tauri.workspaceReadBinary(petId, `social/images/${file}`);
    if (!base64Data) return { error: `图片文件为空: ${file}` };

    // 调 MCP send_image
    const sendToolName = `${mcpServerName}__send_image`;
    await tauri.mcp.callToolByName(sendToolName, {
      target: targetId,
      target_type: targetType || 'group',
      image: base64Data,
    });

    return {
      content: [{ type: 'text', text: `✓ 图片已发送: ${file}` }],
    };
  } catch (e) {
    return { error: `发送图片失败: ${e.message || e}` };
  }
}

/** 获取 webshot 工具定义（截图网页，只存不发） */
export function getWebshotToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'webshot',
      description: '截取网页中匹配关键词的内容块截图并保存。只保存不发送，要发送请用 image action 或 webshot_send。keyword 用 CC 报告或搜索结果中的有意义英文/中文短语（如"faculty searches"），不要用纯数字或特殊符号。失败可换词重试。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '目标网页 URL',
          },
          keyword: {
            type: 'string',
            description: '要定位的关键词，系统会模糊匹配并截取关键词所在的内容块',
          },
          desc: {
            type: 'string',
            description: '截图描述（可选，不填则用 keyword）',
          },
        },
        required: ['url', 'keyword'],
      },
    },
  };
}

/** 获取 webshot_send 工具定义（截图网页并立即发送） */
export function getWebshotSendToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'webshot_send',
      description: '截取网页中匹配关键词的内容块截图，保存并立即发送到当前群聊。适合甩截图佐证观点、分享数据。keyword 用有意义的英文/中文短语，不要用纯数字或特殊符号。失败可换词重试。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '目标网页 URL',
          },
          keyword: {
            type: 'string',
            description: '要定位的关键词，系统会模糊匹配并截取关键词所在的内容块',
          },
          desc: {
            type: 'string',
            description: '截图描述（可选，不填则用 keyword）',
          },
        },
        required: ['url', 'keyword'],
      },
    },
  };
}

// ============ chat_search / chat_context（QQ 历史检索） ============

/** 解析时间字符串 → 毫秒时间戳。支持相对（"7d"/"1h"/"30m"/"30s"）和绝对（ISO 日期）。 */
function _parseTimeArg(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // 相对时间
  const m = trimmed.match(/^(\d+)([smhd])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const ms = unit === 's' ? n * 1000
             : unit === 'm' ? n * 60 * 1000
             : unit === 'h' ? n * 3600 * 1000
             : n * 86400 * 1000;
    return Date.now() - ms;
  }
  // 绝对时间
  const t = Date.parse(trimmed);
  if (!isNaN(t)) return t;
  return null;
}

/** 格式化一条消息为人类可读 */
function _formatChatMessage(m) {
  const time = new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false });
  const sender = m.isBot ? '[BOT]' : m.senderId;
  const replyTo = m.replyToId ? ` (reply→${m.replyToId})` : '';
  return `[${time}] ${sender}: ${m.content}\n  ↳ msg_id: ${m.messageId}${replyTo}`;
}

export function getChatSearchToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'chat_search',
      description: '搜索群聊历史消息（本地 SQLite + FTS5 全文搜索）。\n\nkeywords 语法（必填）：\n  "Claude" → 模糊匹配\n  "Claude benchmark" → AND\n  "Claude OR GPT" → OR\n  \'"Claude 4"\' → 精确短语\n  "Claude*" → 前缀匹配\n\n时间格式：相对（"30m"/"1h"/"7d"）或绝对（"2026-04-05"）\n\nsender 必须传 QQ号（纯数字），不接受昵称。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'FTS5 全文搜索语法（必填）' },
          sender: { type: 'string', description: '发送者 QQ号（纯数字）' },
          target: { type: 'string', description: '群号；不传 = 当前群' },
          start: { type: 'string', description: '起始时间，相对（"7d"）或绝对（"2026-04-05"）' },
          end: { type: 'string', description: '结束时间，同上格式，默认 now' },
          sort: { type: 'string', enum: ['relevance', 'newest', 'oldest'], description: '排序方式。默认 relevance' },
          limit: { type: 'integer', description: '最多返回条数，默认 20，最大 200' },
        },
        required: ['keywords'],
      },
    },
  };
}

export function getChatContextToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'chat_context',
      description: '获取某条消息前后的同群消息上下文。先用 chat_search 找到一条相关消息，再用 chat_context 看周围对话。',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: '锚点消息 ID（从 chat_search 结果获取）' },
          before: { type: 'integer', description: '取前 N 条，默认 5' },
          after: { type: 'integer', description: '取后 N 条，默认 5' },
        },
        required: ['message_id'],
      },
    },
  };
}


async function executeChatSearch(args, context) {
  const { keywords, sender, target, start, end, sort, limit } = args;
  const { targetId } = context;

  // keywords 必填
  if (!keywords || typeof keywords !== 'string' || !keywords.trim()) {
    return { error: '缺少 keywords 参数（必填）' };
  }

  // target 默认为当前群
  const finalTarget = target || targetId || '';

  // 时间解析
  const startTs = _parseTimeArg(start);
  const endTs = _parseTimeArg(end);
  if (start && startTs === null) return { error: `start 参数解析失败: "${start}"。请用 "7d" / "1h" / "2026-04-05" 等格式` };
  if (end && endTs === null) return { error: `end 参数解析失败: "${end}"` };

  try {
    const result = await tauri.chatHistorySearch({
      keywords: keywords.trim(),
      sender: sender || null,
      target: finalTarget || null,
      startTs,
      endTs,
      sort: sort || null,
      limit: limit || 20,
    });

    if (!result.messages || result.messages.length === 0) {
      return { content: [{ type: 'text', text: '未找到匹配的历史消息。' }] };
    }

    const lines = result.messages.map(_formatChatMessage);
    const sortLabel = sort || 'relevance';
    return {
      content: [{
        type: 'text',
        text: `找到 ${result.total} 条消息（按 ${sortLabel} 排序）：\n\n${lines.join('\n\n')}`,
      }],
    };
  } catch (e) {
    return { error: `chat_search 失败: ${e.message || e}` };
  }
}

async function executeChatContext(args, context) {
  void context;
  const { message_id, before = 5, after = 5 } = args;
  if (!message_id) return { error: '缺少 message_id 参数' };

  try {
    const result = await tauri.chatHistoryContext(String(message_id), Number(before), Number(after));
    if (!result.anchor) {
      return { error: `未找到消息 ${message_id}（可能尚未被记录到 chat_history）` };
    }

    const sections = [];
    if (result.before && result.before.length > 0) {
      sections.push(result.before.map(_formatChatMessage).join('\n\n'));
    }
    sections.push('▶ ' + _formatChatMessage(result.anchor) + '   ← 锚点');
    if (result.after && result.after.length > 0) {
      sections.push(result.after.map(_formatChatMessage).join('\n\n'));
    }

    return {
      content: [{
        type: 'text',
        text: `消息 ${message_id} 前后上下文（前 ${result.before.length} 条 + 后 ${result.after.length} 条）：\n\n${sections.join('\n\n')}`,
      }],
    };
  } catch (e) {
    return { error: `chat_context 失败: ${e.message || e}` };
  }
}

/** webshot 核心：调 MCP 截图 + 保存到 workspace */
async function _webshotCapture(args, context) {
  const { url, keyword, desc } = args;
  const { petId } = context;
  if (!petId) return { error: '缺少 petId' };
  if (!url || !keyword) return { error: '缺少 url 或 keyword' };

  try {
    // 调 webshot MCP
    const result = await tauri.mcp.callToolByName('webshot__webshot', { url, keyword });

    let base64Data = null;
    let matchedText = '';
    if (result?.content) {
      for (const item of result.content) {
        if (item.type === 'text') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed.success && parsed.image) {
              base64Data = parsed.image;
              matchedText = parsed.matched_text || '';
            } else if (!parsed.success) {
              return { error: `网页截图失败: ${parsed.error || '未知错误'}。可以换个关键词重试——避免特殊符号（%#$等），用页面上实际出现的中文或英文短语。` };
            }
          } catch { /* not JSON */ }
        }
      }
    }
    if (!base64Data) return { error: '网页截图失败: 未获取到图片数据' };

    // 生成文件名
    const label = (desc || keyword).trim();
    const safeName = label.substring(0, 30).replace(/[/\\:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const id = Date.now().toString(36);
    const fileName = `webshot_${safeName}_${id}.png`;

    // 保存到 workspace
    await tauri.workspaceWriteBinary(petId, `social/images/${fileName}`, base64Data);

    // 追加 index.toml
    const tomlEntry = `\n[[screenshots]]\nfile = "${fileName}"\ndesc = "${label.replace(/"/g, '\\"')}"\ntype = "webshot"\nurl = "${url.replace(/"/g, '\\"')}"\nmatched_text = "${matchedText.substring(0, 100).replace(/"/g, '\\"')}"\ncreated_at = "${new Date().toISOString()}"\n`;
    await tauri.workspaceAppend(petId, 'social/images/index.toml', tomlEntry);

    return { fileName, label };
  } catch (e) {
    return { error: `网页截图失败: ${e.message || e}` };
  }
}

/** 执行 webshot（只截图保存） */
async function executeWebshot(args, context) {
  const result = await _webshotCapture(args, context);
  if (result.error) return result;
  return {
    content: [{ type: 'text', text: `✓ 网页截图已保存: ${result.fileName}\n描述: ${result.label}\nURL: ${args.url}` }],
  };
}

/** 执行 webshot_send（截图 + 保存 + 发送 + INTENT 回写） */
async function executeWebshotSend(args, context) {
  const { petId, targetId, targetType, mcpServerName } = context;
  if (!mcpServerName) return { error: '缺少 mcpServerName' };

  const result = await _webshotCapture(args, context);
  if (result.error) return result;

  try {
    // 读取刚保存的图片并发送
    const base64Data = await tauri.workspaceReadBinary(petId, `social/images/${result.fileName}`);
    if (!base64Data) return { error: `图片文件为空: ${result.fileName}` };

    const sendToolName = `${mcpServerName}__send_image`;
    await tauri.mcp.callToolByName(sendToolName, {
      target: targetId,
      target_type: targetType || 'group',
      image: base64Data,
    });

    // INTENT 回写
    const intentDir = targetType === 'friend' ? 'friend' : 'group';
    const intentPath = `social/${intentDir}/INTENT_${targetId}.md`;
    try {
      const current = await tauri.workspaceRead(petId, intentPath) || '';
      const prefix = `【我刚做了】发了网页截图 ${result.fileName}`;
      const updated = current.replace(/【我刚做了】[^\n]*/, prefix);
      if (updated !== current) await tauri.workspaceWrite(petId, intentPath, updated);
    } catch { /* 非致命 */ }

    return {
      content: [{ type: 'text', text: `✓ 网页截图已保存并发送: ${result.fileName}\n描述: ${result.label}\nURL: ${args.url}` }],
    };
  } catch (e) {
    return { error: `发送网页截图失败: ${e.message || e}` };
  }
}

// ============ voice_send（ElevenLabs TTS → qq mcp send_voice） ============

/** voice_send 文字硬限：超过即拒绝（控费 + SILK 时长） */
const VOICE_SEND_MAX_CHARS = 50;

/** 获取 voice_send 工具定义 */
export function getVoiceSendToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'voice_send',
      description: `用配置的 TTS 音色把文字朗读成语音并发送到当前会话。仅在用户明确要求语音、需要卖萌、或有声音表达更合适的场景使用，普通对话不要用。文字最多 ${VOICE_SEND_MAX_CHARS} 字。`,
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: `要朗读的文字内容，最多 ${VOICE_SEND_MAX_CHARS} 字`,
          },
        },
        required: ['text'],
      },
    },
  };
}

/** 把成功/失败信息回写到 INTENT 文件的【我刚做了】行 */
async function _writeVoiceIntent(petId, targetId, targetType, line) {
  const intentDir = targetType === 'friend' ? 'friend' : 'group';
  const intentPath = `social/${intentDir}/INTENT_${targetId}.md`;
  try {
    const current = (await tauri.workspaceRead(petId, intentPath)) || '';
    const updated = current.replace(/【我刚做了】[^\n]*/, `【我刚做了】${line}`);
    if (updated !== current) {
      await tauri.workspaceWrite(petId, intentPath, updated);
    }
  } catch { /* 非致命 */ }
}

/** 执行 voice_send：TTS → 暂存 → 发送 → sentCache + INTENT 回写 */
async function executeVoiceSend(args, context) {
  const { petId, targetId, targetType, mcpServerName, ttsConfig, sentCache } = context;

  // 校验
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };
  if (!mcpServerName) return { error: '缺少 mcpServerName' };
  if (!ttsConfig || !ttsConfig.enabled) {
    const err = 'TTS 未在社交设置中启用';
    await _writeVoiceIntent(petId, targetId, targetType, `发语音失败：${err}`);
    return { error: err };
  }
  if (!ttsConfig.apiKey || !ttsConfig.voiceId) {
    const err = 'TTS 缺少 apiKey 或 voiceId';
    await _writeVoiceIntent(petId, targetId, targetType, `发语音失败：${err}`);
    return { error: err };
  }
  const text = (args?.text || '').trim();
  if (!text) {
    return { error: 'text 为空' };
  }
  if (text.length > VOICE_SEND_MAX_CHARS) {
    const err = `text 超过 ${VOICE_SEND_MAX_CHARS} 字（实际 ${text.length}），拒绝发送`;
    await _writeVoiceIntent(petId, targetId, targetType, `发语音失败：${err}`);
    return { error: err };
  }

  // 1. 调 ElevenLabs 生成 base64 音频
  let base64Audio;
  try {
    base64Audio = await tauri.elevenlabsTts({
      apiKey: ttsConfig.apiKey,
      voiceId: ttsConfig.voiceId,
      text,
      modelId: ttsConfig.modelId || undefined,
    });
  } catch (e) {
    const err = `TTS 生成失败: ${e?.message || e}`;
    await _writeVoiceIntent(petId, targetId, targetType, `发语音失败：${err.slice(0, 80)}`);
    return { error: err };
  }
  if (!base64Audio) {
    const err = 'TTS 返回空数据';
    await _writeVoiceIntent(petId, targetId, targetType, `发语音失败：${err}`);
    return { error: err };
  }

  // 2. 暂存到 workspace
  const fileName = `voice_${Date.now().toString(36)}.mp3`;
  try {
    await tauri.workspaceWriteBinary(petId, `social/voices/${fileName}`, base64Audio);
  } catch (e) {
    // 暂存失败不阻止发送，但记日志
    console.warn('[voice_send] 暂存失败:', e);
  }

  // 3. 调 qq mcp 的 send_voice
  let sendResult;
  try {
    const sendToolName = `${mcpServerName}__send_voice`;
    sendResult = await tauri.mcp.callToolByName(sendToolName, {
      target: targetId,
      target_type: targetType || 'group',
      audio: base64Audio, // 不带 base64:// 前缀
    });
  } catch (e) {
    const err = `send_voice 失败: ${e?.message || e}`;
    await _writeVoiceIntent(petId, targetId, targetType, `发语音失败：${err.slice(0, 80)}`);
    return { error: err };
  }

  // 4. 解析 message_id
  let msgId = null;
  try {
    const rawText = sendResult?.content?.[0]?.text;
    const parsed = rawText ? JSON.parse(rawText) : sendResult;
    if (parsed?.success === false) {
      const err = `send_voice 返回失败: ${parsed.error || '未知错误'}`;
      await _writeVoiceIntent(petId, targetId, targetType, `发语音失败：${err.slice(0, 80)}`);
      return { error: err };
    }
    msgId = parsed?.message_id?.toString() || parsed?.message_ids?.[0]?.toString() || null;
  } catch { /* 非致命 */ }

  // 5. 写入 sentCache（消息池子），让 bot 下一轮 Intent 知道自己说了什么
  // qq mcp 服务端 buffer 里只会出现 [语音]，如果不写这里 bot 会失忆
  if (sentCache) {
    const arr = sentCache.get(targetId) || [];
    arr.push({
      content: `[发送了语音："${text}"]`,
      timestamp: new Date().toISOString(),
      message_id: msgId,
      _isVoiceSend: true,
    });
    sentCache.set(targetId, arr);
  }

  // 6. INTENT 回写
  await _writeVoiceIntent(petId, targetId, targetType, `发了语音："${text}"`);

  return {
    content: [{ type: 'text', text: `✓ 已发送语音: "${text}"` }],
  };
}

// ============ generate_image_send（AI 生图 → 存档 → 发到群） ============

// ============ get_situation：一站式上下文快照 ============

/** 获取 get_situation 工具定义 */
export function getSituationToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'get_situation',
      description: '⚠️ **本轮 eval 第一步必调**。返回当前对话情况的一站式快照：群聊记录（最近 N 条原文，含时间戳、@me、图片描述）+ 你最近的动作（recent_self.md 全部内容，含 AI 生图状态、在途/孤儿任务、刚发出的文字）。\n一次调用拿到所有做决策需要的输入，不要分开调 social_read recent_self.md + 翻 chat history。\n本轮**只调一次**。eval 中途到达的新消息会在 write_intent_plan 时自动拦截要求重提（无需手动再次 get_situation）。',
      parameters: {
        type: 'object',
        properties: {
          n: {
            type: 'integer',
            description: '群聊记录返回最近多少条，默认 60，最大 200。',
          },
        },
      },
    },
  };
}

/** 共享的消息格式化（get_situation / read_new_messages 都用） */
function _formatChatMsg(msg) {
  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '?';
  if (msg.is_self) {
    let text = (msg.content || '').trim();
    if (!text && (msg._images?.length || 0) > 0) text = '[发送了表情包/图片]';
    return `[${ts}] **【我自己发的】**: ${text}`;
  }
  const name = msg.sender_name || msg.sender_id || '?';
  const id = msg.sender_id || '?';
  const msgIdTag = msg.message_id ? ` [#${msg.message_id}]` : '';
  const atMeTag = msg.is_at_me ? ' @me' : '';
  let content = msg.content || '';
  if (msg._imageDescs?.length > 0) {
    const descs = msg._imageDescs.map(d => `[图片: ${d}]`).join(' ');
    content = (content + ' ' + descs).trim();
  } else if ((msg._images?.length || 0) > 0) {
    content = (content + ` [图片x${msg._images.length}]`).trim();
  }
  return `[${ts}] ${name}(${id})${msgIdTag}${atMeTag}: ${content}`;
}

async function executeGetSituation(args, context) {
  const { petId, targetId, targetType, dataBuffer, intentInjectionWatermarks } = context;
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };

  const n = Math.max(1, Math.min(parseInt(args?.n, 10) || 60, 200));
  const buf = dataBuffer?.get(targetId);

  let chatBlock;
  let chatCount = 0;
  if (buf?.messages?.length > 0) {
    const recent = buf.messages.slice(-n);
    chatCount = recent.length;
    chatBlock = recent.map(_formatChatMsg).join('\n');
    // 推进水位线到 buffer 末尾——LLM 已经看过这些消息，下次 read_new_messages 只返回更新的；
    // write_intent_plan 拦截也只对真正"未看过"的消息触发
    const lastBufMsg = buf.messages[buf.messages.length - 1];
    if (lastBufMsg?.message_id && intentInjectionWatermarks) {
      intentInjectionWatermarks.set(targetId, lastBufMsg.message_id);
    }
  } else {
    chatBlock = '（暂无群消息）';
  }

  // 读 recent_self.md
  const dir = targetType === 'friend' ? 'friend' : 'group';
  let recentSelf = '';
  try {
    recentSelf = (await tauri.workspaceRead(petId, `social/${dir}/scratch_${targetId}/recent_self.md`).catch(() => '')) || '';
  } catch { /* 文件不存在则为空 */ }

  const output = [
    '# 当前情况快照',
    '',
    `## 群聊记录（最近 ${chatCount} 条；【我自己发的】= bot 自己之前发的内容，避免重复）`,
    chatBlock,
    '',
    '## 你最近的动作 / 在途任务（recent_self）',
    recentSelf.trim() || '（无最近动作）',
    '',
    '⚠️ eval 中途若有新消息，write_intent_plan 提交时会自动拦截，把增量新消息塞给你看，要求重新评估再次提交。所以你专注思考决策即可，不需要中途主动检查。',
  ].join('\n');

  return { content: [{ type: 'text', text: output }] };
}

/** 获取 generate_image_send 工具定义 */
export function getGenerateImageSendToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'generate_image_send',
      description: '用 AI 生成一张图片并直接发送到当前会话。fire-and-forget：调用立刻返回成功，图片在后台生成（最多 10 分钟整体超时，gpt-image-2 等慢 provider 可能 3-6 分钟），完成后自动发到群里并存档到 social/images/。\n状态跟踪：派发瞬间会在 sentCache 写一条"⏳ 派发中"占位（含 filename / prompt / reason）+ 写一个磁盘锁文件 pending_gen/<filename>.json；IIFE 完成（成功/失败/超时）后清锁、更新占位为"✅ 已发"或"❌ 失败"。dev 模式 HMR 或 app 重启杀掉 IIFE 时锁不会被清——下次 eval 会扫到，标"☠️ 孤儿"。所有状态都在 recent_self.md 的"在途/最近"段。\n**支持并发**：同一轮 plan 派多张是允许的（每张独立 IIFE / 独立 filename / 独立锁），但前提是**主题不同**——同主题不论 filename / prompt 怎么改都算重复。\n仅在以下场景使用（极其稀缺，绝不滥用）：(1) 画流程图/示意图辅助讲解技术 (2) 自制表情包/玩梗 (3) 用户明确"画个 X 给我看"。普通对话**不要用**——已有截图/旧表情包能解决就别生成。\n⚠️ **本轮 plan 调过本工具就停（同主题）**——已派发；无关的另一张主题可以并发再调。\n⚠️ **看到 recent_self.md 里有 ❌ 失败的同主题记录就不要立即重调**——失败常是配置/网络/参数问题。\n⚠️ **去重核心是 reason 字段**：换名换风格画同一个主题=重复。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图片描述（中英文皆可）。越具体越好：主体 + 风格 + 构图 + 配色。例: "一个程序员对着屏幕崩溃，扁平卡通风，黄色背景"',
          },
          filename: {
            type: 'string',
            description: '存档文件名（不含扩展名，会自动加 .png）。简短、英文/拼音、可识别用途。例: "flow_mcp_arch" / "meme_崩溃猫" / "diagram_intent_loop"',
          },
          reason: {
            type: 'string',
            description: '⚠️ 必填。一句话说明你**为什么**画这张图：给谁看、回应哪条消息、想达到什么效果。这是去重判定的核心字段——下次 eval 看到 reason 相近的已派记录就不要再画。\n例: "回应 冯·诺依曼 #123 的\'画一张我的自画像\'请求，把他作为逻辑神性的强大表现出来"\n例: "群里在讨论 MCP 协议架构，画一张架构图辅助 reply 讲解"\n例: "啾啾 #456 抛了崩溃的梗，画只崩溃猫回应"',
          },
        },
        required: ['prompt', 'filename', 'reason'],
      },
    },
  };
}

/** 把成功/失败信息回写到 INTENT 文件的【我刚做了】行 */
async function _writeImageGenIntent(petId, targetId, targetType, line) {
  const intentDir = targetType === 'friend' ? 'friend' : 'group';
  const intentPath = `social/${intentDir}/INTENT_${targetId}.md`;
  try {
    const current = (await tauri.workspaceRead(petId, intentPath)) || '';
    const updated = current.replace(/【我刚做了】[^\n]*/, `【我刚做了】${line}`);
    if (updated !== current) {
      await tauri.workspaceWrite(petId, intentPath, updated);
    }
  } catch { /* 非致命 */ }
}

/** 简单 sluggify：去除非法字符，限制长度 */
function _slugifyFilename(raw) {
  const cleaned = String(raw || '').trim().replace(/[/\\:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return cleaned.slice(0, 60) || `gen_${Date.now().toString(36)}`;
}

/**
 * 派发瞬间往 sentCache 推占位条，让下一轮 Intent 通过 recent_self.md 看到"在途/已失败"。
 * status: 'dispatching' | 'sent' | 'failed'
 * IIFE 完成后用 _updateImageGenSentCache 修改同一条（按 fileName 唯一定位）。
 * genReason 是 LLM 调用时填的"为什么画"——用于下次 eval 的主题级去重判定。
 */
function _pushImageGenSentCache(sentCache, targetId, fileName, status, prompt = '', genReason = '', errReason = '') {
  if (!sentCache || !targetId || !fileName) return;
  const arr = sentCache.get(targetId) || [];
  arr.push({
    content: _formatImageGenSentLine(fileName, status, prompt, genReason, errReason),
    timestamp: new Date().toISOString(),
    message_id: null,
    _genImageFileName: fileName,
    _genImageStatus: status,
    _genImagePrompt: prompt,
    _genImageReason: genReason,
  });
  sentCache.set(targetId, arr);
}

function _updateImageGenSentCache(sentCache, targetId, fileName, status, errReason = '') {
  if (!sentCache || !targetId || !fileName) return;
  const arr = sentCache.get(targetId);
  if (!arr) return;
  // 倒序找：通常我们刚 push 的就在末尾
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr[i];
    if (entry?._genImageFileName === fileName) {
      entry._genImageStatus = status;
      entry.content = _formatImageGenSentLine(
        fileName, status,
        entry._genImagePrompt || '',
        entry._genImageReason || '',
        errReason,
      );
      return;
    }
  }
}

function _formatImageGenSentLine(fileName, status, prompt, genReason, errReason) {
  const promptPart = prompt ? ` prompt="${String(prompt).slice(0, 80)}"` : '';
  const reasonPart = genReason ? ` reason="${String(genReason).slice(0, 100)}"` : '';
  if (status === 'dispatching') return `[AI 生图派发中: ${fileName}${reasonPart}${promptPart}]`;
  if (status === 'sent') return `[已发 AI 生图: ${fileName}${reasonPart}${promptPart}]`;
  // failed
  const reason = errReason ? ` 原因=${String(errReason).slice(0, 80)}` : '';
  return `[AI 生图失败: ${fileName}${reasonPart}${reason}]`;
}

/**
 * 执行 generate_image_send：fire-and-forget
 * 派发瞬间立即返回 "✓ 已派发"，并 push 占位条到 sentCache 让下一轮 Intent 看到"在途任务"。
 * 后台 IIFE 异步：调 API → 存盘 → 发群 → 更新 sentCache 占位条 + 回写 INTENT。
 *
 * 任何失败（包括早期校验）都会：
 *   1) 把 sentCache 占位条标记为 'failed: 原因=...'
 *   2) 写 INTENT【我刚做了】"AI 生图失败: ..."
 *   3) 返回的 error 文案明确禁止本会话内重试
 * 这样下一轮 Intent eval 通过 recent_self.md 就能看到"上次失败"，不会盲目重试。
 */
/** 派发锁文件目录 */
function _pendingGenDir(targetType, targetId) {
  const dir = targetType === 'friend' ? 'friend' : 'group';
  return `social/${dir}/scratch_${targetId}/pending_gen`;
}

/** 写派发锁：让 IIFE 即便被 HMR/重启杀死，下次 Intent eval 也能扫到孤儿任务 */
async function _writePendingGenLock(petId, targetType, targetId, fileName, info) {
  const path = `${_pendingGenDir(targetType, targetId)}/${fileName}.json`;
  try {
    await tauri.workspaceWrite(petId, path, JSON.stringify({
      ...info,
      fileName,
      dispatchTs: Date.now(),
    }));
  } catch (e) {
    console.warn('[generate_image_send] write lock failed:', e);
  }
}

/** 删派发锁（IIFE 走完任意终态——success/fail/timeout 都要清） */
async function _deletePendingGenLock(petId, targetType, targetId, fileName) {
  const path = `${_pendingGenDir(targetType, targetId)}/${fileName}.json`;
  try {
    await tauri.workspaceDeleteFile(petId, path);
  } catch { /* 锁文件可能本来就不存在或被其他流程清掉，忽略 */ }
}

async function executeGenerateImageSend(args, context) {
  const { petId, targetId, targetType, mcpServerName, imageModel, addLog, sentCache } = context;
  if (!petId || !targetId) return { error: '缺少 petId 或 targetId' };
  if (!mcpServerName) return { error: '缺少 mcpServerName' };
  const prompt = (args?.prompt || '').toString().trim();
  const filenameRaw = (args?.filename || '').toString().trim();
  const reason = (args?.reason || '').toString().trim();

  // 即便参数缺失也先生成一个 fileName 用于占位/INTENT 回写（让 Intent 知道"试过了但参数不对"）
  const slug = _slugifyFilename(filenameRaw || 'unnamed');
  // 加随机 4 字符避免并发同 slug 的极小概率撞名
  const rand = Math.random().toString(36).slice(2, 6);
  const fileName = `gen_${slug}_${Date.now().toString(36)}${rand}.png`;

  // 同步硬错误：参数缺失 / imageModel 缺失 → 推失败占位 + 写 INTENT + 返回硬错误（禁止重试）
  const failHard = async (errMsg) => {
    _pushImageGenSentCache(sentCache, targetId, fileName, 'failed', prompt, reason, errMsg);
    await _writeImageGenIntent(petId, targetId, targetType, `AI 生图失败: ${fileName} 原因=${errMsg.slice(0, 80)}${reason ? ` (本来是为了: ${reason.slice(0, 60)})` : ''}`);
    return {
      error: `${errMsg}。⚠️ 本会话内不要再调用 generate_image_send，需要用户解决配置后重启 social agent。可以在 reply 里告诉用户"现在画不了图，去设置里启用 AI 生图模型"。`,
    };
  };

  if (!prompt) return failHard('缺少 prompt 参数');
  if (!filenameRaw) return failHard('缺少 filename 参数');
  if (!reason) return failHard('缺少 reason 参数（你必须说明为什么画这张图——给谁看、回应什么、想达到什么）');
  if (!imageModel || !imageModel.modelName || !imageModel.baseUrl || !imageModel.apiKey) {
    return failHard('社交 agent 未配置 Image Model（在社交设置启用并填好 provider/model，并重启 agent）');
  }

  // 派发：push '派发中' 占位条 + 同步写 INTENT + **写派发锁文件**（用于孤儿检测）
  _pushImageGenSentCache(sentCache, targetId, fileName, 'dispatching', prompt, reason);
  await _writeImageGenIntent(
    petId, targetId, targetType,
    `派发了 AI 生图任务 (${fileName}) reason="${reason.slice(0, 80)}" prompt="${prompt.slice(0, 50)}"`,
  );
  await _writePendingGenLock(petId, targetType, targetId, fileName, {
    prompt: prompt.slice(0, 500),
    reason: reason.slice(0, 500),
    model: imageModel.modelName,
  });

  // fire-and-forget IIFE
  // 多个并发调用：每次调用各自独立 IIFE + 独立 fileName + 独立锁，互不干扰
  (async () => {
    const log = (level, msg, detail) => {
      try { (addLog || (() => {}))(level, msg, detail || null, targetId); } catch { /* ignore */ }
    };
    const cleanup = async () => {
      // 任何终态都要清锁，否则下次 eval 会误判为孤儿
      await _deletePendingGenLock(petId, targetType, targetId, fileName);
    };
    const failAsync = async (errMsg) => {
      _updateImageGenSentCache(sentCache, targetId, fileName, 'failed', errMsg);
      await _writeImageGenIntent(petId, targetId, targetType, `AI 生图失败: ${fileName} 原因=${errMsg.slice(0, 80)} (本来是为了: ${reason.slice(0, 60)})`);
      log('warn', `generate_image_send failed: ${errMsg}`);
      await cleanup();
    };

    try {
      // 1. 调 OpenAI-compatible /v1/images/generations
      // ⚠️ 走 Rust image_gen_proxy_call（10 min 超时，独立 semaphore），不直接用 JS fetch
      // 原因：WKWebView 的 fetch 对长连接 / 第三方代理常返回 "Load failed"；reqwest 没这问题
      const baseUrl = String(imageModel.baseUrl).replace(/\/+$/, '');
      const endpoint = baseUrl.endsWith('/v1') ? `${baseUrl}/images/generations` : `${baseUrl}/v1/images/generations`;
      const apiKey = String(imageModel.apiKey).split(/[\n,]/).map(s => s.trim()).filter(Boolean)[0] || '';
      if (!apiKey) return failAsync('缺少 apiKey');

      let data;
      try {
        data = await tauri.imageGenProxyCall(
          endpoint,
          { Authorization: `Bearer ${apiKey}` },
          {
            model: imageModel.modelName,
            prompt,
            size: '1024x1024',
            n: 1,
            response_format: 'b64_json',
          },
        );
      } catch (e) {
        // Rust 侧把 timeout / HTTP error / API error 都格式化成 string 抛过来
        return failAsync(String(e?.message || e));
      }
      const item = data?.data?.[0];
      let base64 = item?.b64_json || '';
      if (!base64 && item?.url) {
        // URL fallback：走 Rust download_url_as_base64（30s 超时），同样不走 JS fetch
        try {
          const dl = await tauri.downloadUrlAsBase64(item.url);
          base64 = dl?.data || '';
        } catch (e) {
          return failAsync(`URL 下载失败: ${e?.message || e}`);
        }
      }
      if (!base64) return failAsync('响应无图片数据');

      // 2. 存到 social/images/
      try {
        await tauri.workspaceWriteBinary(petId, `social/images/${fileName}`, base64);
      } catch (e) {
        log('warn', `generate_image_send save fail`, String(e?.message || e));
      }

      // 3. 追加 index.toml（含 reason 字段，便于以后 image_list 看出每张图的"用途"）
      try {
        const tomlEntry = `\n[[screenshots]]\nfile = "${fileName}"\ndesc = "AI 生图: ${prompt.replace(/"/g, '\\"').slice(0, 100)}"\ntype = "ai_generated"\nprompt = "${prompt.replace(/"/g, '\\"').slice(0, 200)}"\nreason = "${reason.replace(/"/g, '\\"').slice(0, 200)}"\nmodel = "${imageModel.modelName}"\ncreated_at = "${new Date().toISOString()}"\n`;
        await tauri.workspaceAppend(petId, 'social/images/index.toml', tomlEntry);
      } catch { /* 非致命 */ }

      // 4. 发到群
      try {
        const sendToolName = `${mcpServerName}__send_image`;
        await tauri.mcp.callToolByName(sendToolName, {
          target: targetId,
          target_type: targetType || 'group',
          image: base64,
        });
        log('send', `🎨 generated → ${targetId}: ${fileName} (reason="${reason.slice(0, 60)}")`);
      } catch (e) {
        return failAsync(`生成成功但发送失败: ${e?.message || e}`);
      }

      // 5. 成功：update 占位条为 sent + 写 INTENT + 清锁
      _updateImageGenSentCache(sentCache, targetId, fileName, 'sent');
      await _writeImageGenIntent(
        petId, targetId, targetType,
        `发了 AI 生图 (${fileName}) reason="${reason.slice(0, 80)}" prompt="${prompt.slice(0, 50)}"`,
      );
      await cleanup();
    } catch (err) {
      await failAsync(String(err?.message || err));
    }
  })();

  return {
    content: [{
      type: 'text',
      text: `✓ 已派发 AI 生图任务（最长等 10 分钟）。\n  filename: ${fileName}\n  reason: ${reason}\n  prompt: ${prompt}\n后台会调 API → 存盘 → 发群 → 更新 sentCache + INTENT。\n⚠️ **本轮 Intent 不要再调本工具**（除非要画的是完全无关的另一张）。多个并发派发是支持的，每张独立 IIFE / 独立 filename / 独立锁文件，互不干扰。\n⚠️ **下次 eval 必须先看 recent_self.md 的"在途/最近"段，按 reason 字段去重**——同主题不要换 filename / 换 prompt 风格再调一次。`,
    }],
  };
}

/**
 * 执行表情包内置工具
 */
export async function executeStickerBuiltinTool(toolName, args, context) {
  const { petId, imageUrlMap } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行表情包操作。' };
  }

  console.log(`[Sticker] Executing ${toolName}`, { petId });

  switch (toolName) {
    case 'sticker_save':
      return executeStickerSave(petId, args, imageUrlMap);
    case 'sticker_list':
      return executeStickerList(petId);
    case 'sticker_send':
      return executeStickerSend(petId, args, context);
    default:
      return { error: `未知的表情包工具: ${toolName}` };
  }
}
