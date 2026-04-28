/**
 * promptBuilder.js — 基于 SOUL.md / USER.md / MEMORY.md 文件的 system prompt 构建器
 * 
 * 替换 ChatboxInputBox.jsx 中基于 isDefaultPersonality × memoryEnabled 的 4 分支逻辑。
 * 核心原则：全文本注入，无向量搜索，每轮对话重新从磁盘读取。
 */

import * as tauri from './tauri';

// ============ 常量 ============

/** 单文件最大字符数（超过则截断） */
const MAX_FILE_CHARS = 20000;

/** 截断时头部保留比例 */
const HEAD_RATIO = 0.7;

/** 截断时尾部保留比例 */
const TAIL_RATIO = 0.2;

// ============ 文件读取 ============

/**
 * 安全读取工作区文件，文件不存在或出错时返回 null
 */
async function safeReadFile(petId, path) {
  try {
    const content = await tauri.workspaceRead(petId, path);
    return content || null;
  } catch {
    // 文件不存在或读取失败，静默跳过
    return null;
  }
}

/**
 * 读取 SOUL.md — 始终读取，不受记忆开关影响
 */
export async function readSoulFile(petId) {
  return safeReadFile(petId, 'SOUL.md');
}

/**
 * 读取 USER.md — 仅记忆 ON 时调用
 */
export async function readUserFile(petId) {
  return safeReadFile(petId, 'USER.md');
}

/**
 * 读取 MEMORY.md — 仅记忆 ON 时调用
 */
export async function readMemoryFile(petId) {
  return safeReadFile(petId, 'MEMORY.md');
}

// ============ 截断 ============

/**
 * 截断过长的文件内容。
 * 保留前 70% + 后 20%，中间插入截断提示。
 */
export function truncateContent(content, maxChars = MAX_FILE_CHARS) {
  if (!content || content.length <= maxChars) return content;

  const headLen = Math.floor(maxChars * HEAD_RATIO);
  const tailLen = Math.floor(maxChars * TAIL_RATIO);

  const head = content.slice(0, headLen);
  const tail = content.slice(-tailLen);

  return `${head}\n\n[...内容被截断，完整内容请使用 read 工具查看原文件...]\n（截断：保留了 ${headLen}+${tailLen} 字符，共 ${content.length} 字符）\n\n${tail}`;
}

// ============ 动态引导指令 ============

/**
 * 根据 SOUL.md 状态生成引导指令
 */
function soulGuidance(soulContent) {
  if (!soulContent) {
    return '你还没有人格定义。在第一次对话时，和主人一起创建 SOUL.md。';
  }
  return '请根据上述人格定义来塑造你的性格和语气。';
}

/**
 * 根据 USER.md 状态生成引导指令
 */
function userGuidance(userContent) {
  if (!userContent) {
    return '你对主人还不太了解。在对话中自然地了解他们，并使用 edit 工具更新 USER.md。';
  }
  // 简单判断内容是否丰富：去掉模板标记后超过 100 字符
  const stripped = userContent.replace(/<!--.*?-->/gs, '').replace(/[#\-*_]/g, '').trim();
  if (stripped.length < 100) {
    return '你对主人还不太了解。在对话中自然地了解他们，并使用 edit 工具更新 USER.md。';
  }
  return '你已经了解了主人的一些信息（见上方）。在对话中获知新信息时，使用 edit 工具更新 USER.md。不要猜测，只记录主人明确告诉你的事实。';
}

/**
 * 根据 MEMORY.md 状态生成引导指令
 */
function memoryGuidance(memoryContent) {
  if (!memoryContent) {
    return '你还没有长期记忆。当有值得记住的事时，使用 write 工具创建 MEMORY.md。';
  }
  if (memoryContent.length > MAX_FILE_CHARS * 0.8) {
    return '你的记忆快满了。请在本次对话中整理 MEMORY.md，移除过时内容，合并重复信息。';
  }
  return '遇到值得记住的信息时，使用 edit 工具更新 MEMORY.md。定期整理，保持精炼。';
}

// ============ System Prompt 构建 ============

/**
 * 构建完整的 system prompt
 * 
 * @param {Object} params
 * @param {string} params.petId - 宠物 ID
 * @param {boolean} params.memoryEnabled - 记忆开关是否开启
 * @param {string} [params.timeContext] - 时间注入上下文（可选）
 * @returns {Promise<string>} 完整的 system prompt 内容
 */
export async function buildSystemPrompt({ petId, memoryEnabled, timeContext }) {
  const sections = [];

  // === 时间上下文 ===
  if (timeContext) {
    sections.push(timeContext);
  }

  // === 始终读取 SOUL.md ===
  const soulContent = await readSoulFile(petId);
  const soulTruncated = truncateContent(soulContent);

  sections.push('# 人格');
  if (soulTruncated) {
    sections.push(soulTruncated);
  } else {
    sections.push('（空）');
  }
  sections.push(soulGuidance(soulContent));

  // === 记忆 ON 时：读取 USER.md 和 MEMORY.md ===
  if (memoryEnabled) {
    const userContent = await readUserFile(petId);
    const userTruncated = truncateContent(userContent);

    sections.push('# 用户信息');
    if (userTruncated) {
      sections.push(userTruncated);
    } else {
      sections.push('（空）');
    }
    sections.push(userGuidance(userContent));

    const memoryContent = await readMemoryFile(petId);
    const memoryTruncated = truncateContent(memoryContent);

    sections.push('# 记忆');
    if (memoryTruncated) {
      sections.push(memoryTruncated);
    } else {
      sections.push('（空）');
    }
    sections.push(memoryGuidance(memoryContent));
  }

  return sections.join('\n\n');
}

/**
 * 获取内置工具的 function calling 定义
 * 根据记忆开关状态返回不同的工具集
 * 
 * @param {boolean} memoryEnabled - 记忆开关状态
 * @returns {Array} LLM function calling 工具定义数组
 */
export function getBuiltinToolDefinitions(memoryEnabled) {
  const tools = [];

  // read 工具始终可用
  tools.push({
    type: 'function',
    function: {
      name: 'read',
      description: '读取工作区中的文件内容。可用文件：SOUL.md（人格定义）' +
        (memoryEnabled ? '、USER.md（用户画像）、MEMORY.md（长期记忆）' : '') + '。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作区根目录），如 SOUL.md、USER.md、MEMORY.md'
          }
        },
        required: ['path']
      }
    }
  });

  // write 工具始终可用（SOUL.md 写入需要用户确认，在执行层处理）
  tools.push({
    type: 'function',
    function: {
      name: 'write',
      description: '创建或覆盖文件。自动创建父目录。' +
        (memoryEnabled
          ? '可写入 SOUL.md（需用户确认）、USER.md、MEMORY.md。'
          : '仅可写入 SOUL.md（需用户确认）。'),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作区根目录）'
          },
          content: {
            type: 'string',
            description: '要写入的完整内容'
          }
        },
        required: ['path', 'content']
      }
    }
  });

  // edit 工具始终可用
  tools.push({
    type: 'function',
    function: {
      name: 'edit',
      description: '通过精确文本查找替换来编辑文件。oldText 必须精确匹配文件中的内容。' +
        (memoryEnabled
          ? '可编辑 SOUL.md（需用户确认）、USER.md、MEMORY.md。'
          : '仅可编辑 SOUL.md（需用户确认）。'),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作区根目录）'
          },
          oldText: {
            type: 'string',
            description: '要查找并替换的精确文本（必须唯一匹配）'
          },
          newText: {
            type: 'string',
            description: '替换后的新文本'
          }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  });

  // generate_image：根据 prompt 生成图片，返回 base64，前端渲染到对话气泡
  tools.push({
    type: 'function',
    function: {
      name: 'generate_image',
      description: '根据文字描述生成图片。返回的图片会直接显示在对话中。当用户明确要求"画"、"生成图"、"做一张图"等时调用。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '英文 / 中文 图像描述，越具体越好（主体、风格、构图、光影等）'
          },
          size: {
            type: 'string',
            enum: ['1024x1024', '1024x1792', '1792x1024'],
            description: '图片尺寸（默认 1024x1024）'
          }
        },
        required: ['prompt']
      }
    }
  });

  return tools;
}

/**
 * 判断指定路径是否为 SOUL.md（写入/编辑需要用户确认）
 */
export function isSoulFile(path) {
  return path === 'SOUL.md' || path === './SOUL.md';
}

/**
 * 判断指定路径在当前记忆开关状态下是否允许操作
 * 记忆 OFF 时，只允许操作 SOUL.md
 */
export function isPathAllowed(path, memoryEnabled) {
  if (memoryEnabled) return true; // 记忆 ON：所有文件都可操作
  return isSoulFile(path); // 记忆 OFF：仅 SOUL.md
}

// ============ 迁移 ============

/**
 * 从旧系统迁移数据到工作区文件。
 * - 如果 SOUL.md 不存在且有旧的 systemInstruction → 写入 SOUL.md
 * - 如果 USER.md 不存在且有旧的 userMemory → 写入 USER.md
 * 
 * 只在首次加载时调用一次，幂等操作。
 * 
 * @param {string} petId - 宠物 ID
 * @param {string} petName - 宠物名字
 * @param {string} [systemInstruction] - 旧的 system instruction
 * @param {string} [userMemory] - 旧的 user memory (JSON string)
 */
export async function migrateFromOldSystem(petId, petName, systemInstruction, userMemory) {
  // 先确保工作区和默认文件存在
  await tauri.workspaceEnsureDefaultFiles(petId, petName);

  // 迁移 systemInstruction → SOUL.md
  if (systemInstruction && systemInstruction.trim() &&
      systemInstruction.trim().toLowerCase() !== 'default' &&
      systemInstruction.trim().toLowerCase() !== 'default model (english)') {
    try {
      const soulExists = await tauri.workspaceFileExists(petId, 'SOUL.md');
      if (soulExists) {
        // 检查是否是默认模板（检查"待填写"标记）
        const currentSoul = await tauri.workspaceRead(petId, 'SOUL.md');
        if (currentSoul.includes('（待填写')) {
          // 默认模板未修改，将旧 systemInstruction 写入
          const migratedSoul = `# 🐾 我是谁

<!-- 从旧系统迁移的人格设定 -->

## 人格设定

${systemInstruction}

---

_这个文件属于你的宠物。随着你们越来越了解彼此，可以一起更新它。_
`;
          await tauri.workspaceWrite(petId, 'SOUL.md', migratedSoul);
          console.log('[Migration] Migrated systemInstruction to SOUL.md');
        }
      }
    } catch (err) {
      console.warn('[Migration] Failed to migrate SOUL.md:', err);
    }
  }

  // 迁移 userMemory → USER.md
  if (userMemory) {
    try {
      let memoryObj;
      if (typeof userMemory === 'string') {
        memoryObj = JSON.parse(userMemory);
      } else {
        memoryObj = userMemory;
      }

      if (memoryObj && Object.keys(memoryObj).length > 0) {
        const userFileExists = await tauri.workspaceFileExists(petId, 'USER.md');
        if (userFileExists) {
          const currentUser = await tauri.workspaceRead(petId, 'USER.md');
          if (currentUser.includes('还没有了解到太多')) {
            // 默认模板未修改，迁移旧数据
            const memoryEntries = Object.entries(memoryObj)
              .map(([key, value]) => `- **${key}：** ${value}`)
              .join('\n');

            const migratedUser = `# 🧑 关于我的主人

<!-- 从旧系统迁移的用户信息 -->

## 基本信息

${memoryEntries}

## 了解

（从旧记忆系统迁移而来，随着对话会继续更新。）

---

_了解越多，帮助越好。但这是在了解一个人，不是在建档案。_
`;
            await tauri.workspaceWrite(petId, 'USER.md', migratedUser);
            console.log('[Migration] Migrated userMemory to USER.md');
          }
        }
      }
    } catch (err) {
      console.warn('[Migration] Failed to migrate USER.md:', err);
    }
  }
}
