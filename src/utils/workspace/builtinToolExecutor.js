/**
 * builtinToolExecutor.js — 内置工具执行器
 * 
 * 处理 read / write / edit 三个内置工具的执行逻辑。
 * 这些工具操作 pet workspace 中的文件（SOUL.md, USER.md, MEMORY.md 等）。
 * 
 * 与 MCP 工具的区别：
 * - 内置工具不通过 MCP 协议调用，直接调用 Tauri invoke
 * - 内置工具名没有 serverName__ 前缀
 * - SOUL.md 的 write/edit 需要用户确认
 * - 记忆 OFF 时，USER.md/MEMORY.md 的操作被拒绝
 */

import * as tauri from '../tauri';
import { isPathAllowed, isSoulFile } from '../promptBuilder';

// ============ 工具名常量 ============

const BUILTIN_TOOL_NAMES = new Set(['read', 'write', 'edit']);

/**
 * 检查工具名是否为内置工具
 */
export function isBuiltinTool(toolName) {
  return BUILTIN_TOOL_NAMES.has(toolName);
}

// ============ 确认对话框 ============

/**
 * 弹出 SOUL.md 修改确认对话框
 * @param {string} action - 'write' | 'edit'
 * @param {Object} args - 工具参数
 * @returns {Promise<boolean>} 用户是否确认
 */
async function confirmSoulModification(action, args) {
  let message;
  if (action === 'write') {
    const preview = args.content?.slice(0, 500) || '';
    message = `AI 想要覆盖你的人格文件 SOUL.md：\n\n${preview}${args.content?.length > 500 ? '\n...(内容过长已截断)' : ''}\n\n是否允许？`;
  } else {
    // edit
    message = `AI 想要修改你的人格文件 SOUL.md：\n\n旧文本：${args.oldText?.slice(0, 200) || ''}\n\n新文本：${args.newText?.slice(0, 200) || ''}\n\n是否允许？`;
  }

  return tauri.confirm(message, { title: '人格修改确认', kind: 'warning' });
}

// ============ 工具执行 ============

/**
 * 执行内置 read 工具
 */
async function executeRead(petId, args, memoryEnabled) {
  const { path } = args;
  if (!path) return { error: '缺少 path 参数' };

  // 权限检查：记忆 OFF 时只允许读取 SOUL.md
  if (!isPathAllowed(path, memoryEnabled)) {
    return { error: '记忆功能已关闭，无法读取此文件。' };
  }

  try {
    const content = await tauri.workspaceRead(petId, path);
    return { content: [{ type: 'text', text: content }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

/**
 * 执行内置 write 工具
 */
async function executeWrite(petId, args, memoryEnabled) {
  const { path, content } = args;
  if (!path) return { error: '缺少 path 参数' };
  if (content === undefined || content === null) return { error: '缺少 content 参数' };

  // 权限检查
  if (!isPathAllowed(path, memoryEnabled)) {
    return { error: '记忆功能已关闭，无法写入此文件。' };
  }

  // SOUL.md 写入需要用户确认
  if (isSoulFile(path)) {
    const confirmed = await confirmSoulModification('write', args);
    if (!confirmed) {
      return { content: [{ type: 'text', text: '用户拒绝了此次修改。' }] };
    }
  }

  try {
    const result = await tauri.workspaceWrite(petId, path, content);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

/**
 * 执行内置 edit 工具
 */
async function executeEdit(petId, args, memoryEnabled) {
  const { path, oldText, newText } = args;
  if (!path) return { error: '缺少 path 参数' };
  if (!oldText) return { error: '缺少 oldText 参数' };
  if (newText === undefined || newText === null) return { error: '缺少 newText 参数' };

  // 权限检查
  if (!isPathAllowed(path, memoryEnabled)) {
    return { error: '记忆功能已关闭，无法编辑此文件。' };
  }

  // SOUL.md 编辑需要用户确认
  if (isSoulFile(path)) {
    const confirmed = await confirmSoulModification('edit', args);
    if (!confirmed) {
      return { content: [{ type: 'text', text: '用户拒绝了此次修改。' }] };
    }
  }

  try {
    const result = await tauri.workspaceEdit(petId, path, oldText, newText);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return { error: err.toString() };
  }
}

// ============ 统一入口 ============

/**
 * 执行内置工具
 * 
 * @param {string} toolName - 工具名: 'read' | 'write' | 'edit'
 * @param {Object} args - 工具参数
 * @param {Object} context - 执行上下文
 * @param {string} context.petId - 当前宠物 ID
 * @param {boolean} context.memoryEnabled - 记忆开关状态
 * @returns {Promise<Object>} MCP 标准响应格式 { content: [...] } 或 { error: string }
 */
export async function executeBuiltinTool(toolName, args, context) {
  const { petId, memoryEnabled } = context;

  if (!petId) {
    return { error: '缺少宠物 ID，无法执行文件操作。' };
  }

  console.log(`[Builtin] Executing ${toolName}`, { args, petId, memoryEnabled });

  switch (toolName) {
    case 'read':
      return executeRead(petId, args, memoryEnabled);
    case 'write':
      return executeWrite(petId, args, memoryEnabled);
    case 'edit':
      return executeEdit(petId, args, memoryEnabled);
    default:
      return { error: `未知的内置工具: ${toolName}` };
  }
}
