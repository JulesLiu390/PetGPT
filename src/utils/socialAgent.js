/**
 * socialAgent.js — 后台自主社交循环引擎
 * 
 * 定时通过 MCP 获取群聊/私聊消息，用 LLM 自主决策是否回复。
 * 每次调用 LLM 都是独立的单轮请求，不累积上下文。
 */

import { buildSocialPrompt } from './socialPromptBuilder';
import { executeToolByName, getMcpTools, resolveImageUrls } from './mcp/toolExecutor';
import { callLLMWithTools } from './mcp/toolExecutor';
import * as tauri from './tauri';

// ============ 状态 ============

/** 当前活跃的社交循环（同一时间只有一个） */
let activeLoop = null;

/** 社交日志（内存中，最多保留 200 条） */
const socialLogs = [];
const MAX_LOGS = 200;

/**
 * 本地发送消息缓存
 * key: target (群号/QQ号)
 * value: Array<{ content, timestamp, message_id }>
 * 
 * 解决 MCP 在同一会话期间不返回 bot 自己发送的消息的问题。
 * bot 通过 send_message 成功发送后，记录到这里。
 * 下次 poll 时注入到 individualMessages 中作为 is_self=true 的消息，
 * 确保 buildTurnsFromMessages 能正确生成 assistant turn。
 */
const sentMessagesCache = new Map();

// ============ 日志 ============

function addLog(level, message, details = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
  };
  socialLogs.push(entry);
  if (socialLogs.length > MAX_LOGS) {
    socialLogs.splice(0, socialLogs.length - MAX_LOGS);
  }
  
  const prefix = `[Social][${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(prefix, message, details || '');
  } else if (level === 'warn') {
    console.warn(prefix, message, details || '');
  } else {
    console.log(prefix, message, details || '');
  }
}

/**
 * 获取社交日志
 * @returns {Array} 日志条目数组
 */
export function getSocialLogs() {
  return [...socialLogs];
}

/**
 * 清空社交日志
 */
export function clearSocialLogs() {
  socialLogs.length = 0;
}

// ============ 配置加载 ============

/**
 * 从 settings 加载社交配置
 * @param {string} petId
 * @returns {Promise<Object|null>}
 */
export async function loadSocialConfig(petId) {
  try {
    const allSettings = await tauri.getSettings();
    const raw = allSettings[`social_config_${petId}`];
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[Social] Failed to load config for', petId, e);
    return null;
  }
}

/**
 * 保存社交配置到 settings
 * @param {string} petId
 * @param {Object} config
 */
export async function saveSocialConfig(petId, config) {
  await tauri.updateSettings({
    [`social_config_${petId}`]: JSON.stringify(config)
  });
}

// ============ API Provider 解析 ============

/**
 * 从 apiProviderId 解析出 LLM 调用所需的参数
 * @param {string} apiProviderId
 * @param {string} modelName
 * @returns {Promise<{apiKey: string, baseUrl: string, apiFormat: string}|null>}
 */
async function resolveApiProvider(apiProviderId, modelName) {
  try {
    const providers = await tauri.getApiProviders();
    const provider = providers.find(p => (p.id || p._id) === apiProviderId);
    if (!provider) {
      addLog('error', `API provider not found: ${apiProviderId}`);
      return null;
    }
    return {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat || 'openai_compatible',
      modelName: modelName || provider.defaultModel || '',
    };
  } catch (e) {
    addLog('error', 'Failed to resolve API provider', e.message);
    return null;
  }
}

// ============ 核心轮询逻辑 ============

/**
 * 从逐条消息构建多轮 user/assistant turns
 * 
 * 每条消息根据 is_self 字段判断角色：
 *   - is_self === true → assistant（bot 自己的消息）
 *   - 其他 → user（群友的消息，带 sender_name 前缀）
 * 
 * Gemini 要求 user/model 严格交替，连续同 role 会被合并。
 * 
 * @param {Array<Object>} messages - 逐条消息 { sender_id, sender_name, content, is_at_me, is_self, ... }
 * @param {Object} options
 * @param {boolean} options.sanitizeAtMe - 是否把 @me 替换为 @[已读]（用于历史消息）
 * @returns {Array<{role: string, content: string}>}
 */
function buildTurnsFromMessages(messages, { sanitizeAtMe = false, ownerQQ = '' } = {}) {
  if (!messages || messages.length === 0) return [];

  const turns = [];

  for (const msg of messages) {
    const role = msg.is_self ? 'assistant' : 'user';

    let text;
    if (msg.is_self) {
      // assistant turn：只放内容，不加名字前缀
      text = msg.content || '';
    } else {
      // user turn：「名字: 内容」 格式，主人加 (user) 标签
      const name = msg.sender_name || msg.sender_id;
      const isOwner = ownerQQ && (String(msg.sender_id) === String(ownerQQ));
      text = `${name}${isOwner ? '(user)' : ''}: ${msg.content || ''}`;
    }

    if (sanitizeAtMe) {
      text = text.replaceAll('@me', '@[已读]');
    }

    // 构建 content：有图片时用多模态数组，否则用纯字符串
    const hasImages = !msg.is_self && msg._images && msg._images.length > 0;
    let content;
    if (hasImages) {
      content = [
        { type: 'text', text },
        ...msg._images.map(img => {
          let url;
          if (img.data.startsWith('http://') || img.data.startsWith('https://')) {
            url = img.data;
          } else if (img.data.startsWith('data:')) {
            url = img.data;
          } else {
            url = `data:${img.mimeType};base64,${img.data}`;
          }
          return { type: 'image_url', image_url: { url, mime_type: img.mimeType || 'image/jpeg' } };
        }),
      ];
    } else {
      content = text;
    }

    // Gemini 约束：连续同 role 则合并
    if (turns.length > 0 && turns[turns.length - 1].role === role) {
      const prev = turns[turns.length - 1];
      // 统一为数组格式再合并
      const prevParts = typeof prev.content === 'string'
        ? [{ type: 'text', text: prev.content }]
        : prev.content;
      const newParts = typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : content;
      // 合并文本部分：如果前后都是纯文本，用换行拼接更紧凑
      const lastPrev = prevParts[prevParts.length - 1];
      const firstNew = newParts[0];
      if (lastPrev?.type === 'text' && firstNew?.type === 'text' && newParts.length === 1 && prevParts.every(p => p.type === 'text')) {
        // 都是纯文本，保持字符串格式
        prev.content = (typeof prev.content === 'string' ? prev.content : prevParts.map(p => p.text).join('\n'))
          + '\n' + firstNew.text;
      } else {
        // 有图片，用数组格式合并
        if (lastPrev?.type === 'text' && firstNew?.type === 'text') {
          prev.content = [
            ...prevParts.slice(0, -1),
            { type: 'text', text: lastPrev.text + '\n' + firstNew.text },
            ...newParts.slice(1),
          ];
        } else {
          prev.content = [...prevParts, ...newParts];
        }
      }
    } else {
      turns.push({ role, content });
    }
  }

  // Gemini 要求第一条必须是 user
  if (turns.length > 0 && turns[0].role === 'assistant') {
    turns.unshift({ role: 'user', content: '（之前的群聊消息）' });
  }

  return turns;
}

/**
 * 对单个目标执行一次轮询
 * 
 * @param {Object} params
 * @param {string} params.target - 群号或 QQ 号
 * @param {string} params.targetType - 'group' 或 'private'
 * @param {string} params.mcpServerName - MCP 服务器名称
 * @param {Object} params.llmConfig - { apiKey, baseUrl, apiFormat, modelName }
 * @param {string} params.petId
 * @param {Object} params.promptConfig - { socialPersonaPrompt, replyStrategyPrompt, atMustReply, botQQ }
 * @param {Map} params.watermarks - 水位线 Map (target -> lastMessageId)
 * @param {Map} params.sentCache - 本地发送消息缓存 (target -> Array)
 * @returns {Promise<{action: 'skipped'|'silent'|'replied'|'error', detail?: string}>}
 */
async function pollTarget({
  target,
  targetType,
  mcpServerName,
  llmConfig,
  petId,
  promptConfig,
  watermarks,
  sentCache,
}) {
  const toolName = `${mcpServerName}__get_recent_context`;
  
  // 1. 获取最新消息
  let rawResult;
  try {
    rawResult = await executeToolByName(toolName, {
      target,
      target_type: targetType,
      limit: 15,
    });
  } catch (e) {
    addLog('error', `Failed to get messages for ${targetType}:${target}`, e.message);
    return { action: 'error', detail: e.message };
  }
  
  if (rawResult?.error) {
    addLog('error', `MCP error for ${target}`, rawResult.error);
    return { action: 'error', detail: rawResult.error };
  }
  
  // 2. 解析 MCP 返回的结构化数据（按消息关联图片）
  //    新版 QQ MCP 返回 content 数组：
  //      [0] TextContent: 元数据 JSON { target, target_type, compressed_summary, message_count, group_name }
  //      [1..N] TextContent: 逐条消息 JSON { message_id, timestamp, sender_id, sender_name, content, is_at_me }
  //      每条 TextContent 后紧跟该消息关联的 ImageContent（0 或多张）
  const contentItems = rawResult.content || [];
  
  let metadata = {};
  let groupName = target;
  let compressedSummary = null;
  let individualMessages = [];  // 逐条消息对象（含 _images）
  let lastMsg = null;           // 用于关联紧随其后的 ImageContent
  let metadataParsed = false;
  
  for (const item of contentItems) {
    if (item.type === 'text') {
      try {
        const parsed = JSON.parse(item.text);
        if (!metadataParsed) {
          // 第一个 text 项是元数据
          metadata = parsed;
          groupName = metadata.group_name || metadata.friend_name || target;
          compressedSummary = metadata.compressed_summary || null;
          metadataParsed = true;
        } else if (parsed.sender_id && parsed.content !== undefined) {
          // 逐条消息
          parsed._images = [];  // 初始化每条消息的图片数组
          individualMessages.push(parsed);
          lastMsg = parsed;
        }
      } catch {
        // 非 JSON 文本段，跳过
      }
    } else if (item.type === 'image' && lastMsg) {
      // 图片紧跟在其所属消息后面，挂载到该消息
      lastMsg._images.push({ data: item.data, mimeType: item.mimeType || 'image/jpeg' });
    }
  }
  
  // 按消息下载图片 URL 为 base64
  let totalImageCount = 0;
  for (const msg of individualMessages) {
    if (msg._images.length > 0) {
      msg._images = await resolveImageUrls(msg._images);
      totalImageCount += msg._images.length;
    }
  }
  if (totalImageCount > 0) {
    addLog('info', `Resolved ${totalImageCount} image(s) across ${individualMessages.filter(m => m._images.length > 0).length} message(s)`);
  }
  
  // 2.5 注入本地发送缓存中的 bot 消息（MCP 同会话可能不返回 is_self 消息）
  const cachedSent = sentCache.get(target) || [];
  if (cachedSent.length > 0) {
    // 收集 MCP 已返回的 bot message_id，避免重复
    const existingIds = new Set(
      individualMessages.filter(m => m.is_self && m.message_id).map(m => m.message_id)
    );
    // 获取消息时间范围，只注入在此范围内的缓存消息
    const oldest = individualMessages.length > 0 
      ? individualMessages[0].timestamp 
      : null;
    
    let injected = 0;
    for (const cached of cachedSent) {
      if (cached.message_id && existingIds.has(cached.message_id)) continue; // MCP 已返回
      if (oldest && cached.timestamp < oldest) continue; // 太旧，不在窗口内
      individualMessages.push({
        message_id: cached.message_id || `local_${cached.timestamp}`,
        timestamp: cached.timestamp,
        sender_id: 'self',
        sender_name: 'bot',
        content: cached.content,
        is_at_me: false,
        is_self: true,
        _fromCache: true,
      });
      injected++;
    }
    if (injected > 0) {
      // 按时间排序
      individualMessages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      addLog('info', `Injected ${injected} cached bot message(s) for ${target}`);
    }
    
    // 清理已过期的缓存（早于当前窗口最早消息的）
    if (oldest) {
      const kept = cachedSent.filter(c => c.timestamp >= oldest);
      if (kept.length !== cachedSent.length) {
        sentCache.set(target, kept);
      }
    }
  }
  
  // 3. 变化检测
  //    只看非 bot 的消息做 hash
  const otherMessages = individualMessages.filter(m => !m.is_self);
  const otherPeopleText = otherMessages
    .map(m => `${m.sender_name}:${m.content}`)
    .join('\n')
    .trim();
  
  const previousWatermark = watermarks.get(target) ?? null;
  const currentHash = otherPeopleText.length < 10 
    ? null 
    : `${otherPeopleText.length}:${otherPeopleText.slice(-200)}`;
  
  if (currentHash === null) {
    if (previousWatermark === null) {
      addLog('info', `${targetType}:${target} no messages found, skipping`);
    }
    return { action: 'skipped', detail: 'empty result' };
  }
  
  if (previousWatermark !== null && currentHash === previousWatermark.hash) {
    return { action: 'skipped' };
  }
  
  const isFirstRun = previousWatermark === null;
  const pendingWatermark = { hash: currentHash };
  
  // 首次运行：记住当前水位线，但不调用 LLM（不回复历史消息）
  if (isFirstRun) {
    watermarks.set(target, pendingWatermark);
    addLog('info', `${targetType}:${target} first run, ${individualMessages.length} messages, watermark set (skip LLM)`);
    return { action: 'skipped', detail: 'first run — watermark initialized' };
  }
  
  // 4. 消息缓冲区过大时触发压缩（依赖 MCP Sampling）
  const messageCount = metadata.message_count ?? individualMessages.length;
  if (messageCount >= 30) {
    try {
      const compressToolName = `${mcpServerName}__compress_context`;
      await executeToolByName(compressToolName, { target, target_type: targetType }, { timeout: 15000 });
      addLog('info', `Triggered compress_context for ${target} (${messageCount} messages)`);
    } catch (e) {
      addLog('warn', `compress_context failed/timeout for ${target}`, e.message);
    }
  }
  
  // 5. 构建多轮消息数组
  const systemPrompt = await buildSocialPrompt({
    petId,
    socialPersonaPrompt: promptConfig.socialPersonaPrompt,
    replyStrategyPrompt: promptConfig.replyStrategyPrompt,
    atMustReply: promptConfig.atMustReply,
    targetName: groupName,
    botQQ: promptConfig.botQQ,
    ownerQQ: promptConfig.ownerQQ,
    ownerName: promptConfig.ownerName,
    injectBehaviorGuidelines: promptConfig.injectBehaviorGuidelines !== false,
  });
  
  // 从逐条消息构建 user/assistant 轮次
  const historyTurns = buildTurnsFromMessages(individualMessages, { sanitizeAtMe: false, ownerQQ: promptConfig.ownerQQ });
  
  // 如果有 compressed_summary，作为最前面的 user turn 提供上下文
  if (compressedSummary) {
    // 消毒摘要中的 @me
    const sanitizedSummary = compressedSummary.replaceAll('@me', '@[已读]');
    const summaryText = `[历史摘要]\n${sanitizedSummary}`;
    // 如果 historyTurns 第一条也是 user，合并（Gemini 不允许连续同 role）
    if (historyTurns.length > 0 && historyTurns[0].role === 'user') {
      const first = historyTurns[0];
      if (typeof first.content === 'string') {
        first.content = summaryText + '\n\n' + first.content;
      } else {
        // content 是多模态数组，在第一个 text part 前面拼接
        const firstTextIdx = first.content.findIndex(p => p.type === 'text');
        if (firstTextIdx >= 0) {
          first.content[firstTextIdx] = {
            type: 'text',
            text: summaryText + '\n\n' + first.content[firstTextIdx].text,
          };
        } else {
          first.content.unshift({ type: 'text', text: summaryText });
        }
      }
    } else {
      historyTurns.unshift({ role: 'user', content: summaryText });
    }
  }
  
  // 检查最新消息是否有 @me
  const hasAtMe = individualMessages.some(m => m.is_at_me);
  if (hasAtMe) {
    addLog('info', `${targetType}:${target} has @me in messages`);
  }
  
  // 如果其他人没有新消息（只有 bot 自己的），跳过
  if (otherMessages.length === 0) {
    watermarks.set(target, pendingWatermark);
    addLog('info', `${targetType}:${target} only bot messages, skipping`);
    return { action: 'skipped', detail: 'only bot messages' };
  }
  
  // 确保最后一条是 user（LLM 需要回复 user 消息）
  if (historyTurns.length > 0 && historyTurns[historyTurns.length - 1].role === 'assistant') {
    historyTurns.push({ role: 'user', content: '（以上是最近的群聊消息，请决定是否回复。不想回复的话回答"[沉默]"。）' });
  }
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyTurns,
  ];
  
  // 6. 获取 MCP 工具（QQ MCP 的 send_message + 额外 MCP 服务器的全部工具）
  let mcpTools = [];
  try {
    const allTools = await getMcpTools();
    const extraServers = new Set(promptConfig.enabledMcpServers || []);
    mcpTools = allTools.filter(t => 
      (t.serverName === mcpServerName && t.name === 'send_message') ||
      (extraServers.has(t.serverName) && t.serverName !== mcpServerName)
    );
  } catch (e) {
    addLog('warn', 'Failed to get MCP tools, proceeding without tools', e.message);
  }
  
  // 7. 调用 LLM（非流式，带工具循环）
  let sendMessageSuccess = false;
  let sendCount = 0;
  let pendingSendContent = null; // 暂存 send_message 的 content 参数
  try {
    const result = await callLLMWithTools({
      messages,
      apiFormat: llmConfig.apiFormat,
      apiKey: llmConfig.apiKey,
      model: llmConfig.modelName,
      baseUrl: llmConfig.baseUrl,
      mcpTools,
      options: { temperature: 0.7 },
      // 强制覆盖 send_message 的 target/target_type，防止 LLM 用群名代替群号
      toolArgTransform: (name, args) => {
        if (name.includes('send_message')) {
          return { ...args, target, target_type: targetType };
        }
        return args;
      },

      onToolCall: (name, args) => {
        addLog('info', `LLM called tool: ${name}`, JSON.stringify(args).substring(0, 200));
        // 暂存 send_message 的 content，等 onToolResult 确认成功后写入缓存
        if (name.includes('send_message')) {
          pendingSendContent = args?.content || '';
        }
      },
      onToolResult: (name, result, _id, isError) => {
        const preview = typeof result === 'string' ? result.substring(0, 100) : JSON.stringify(result).substring(0, 100);
        addLog(isError ? 'error' : 'info', `Tool result: ${name}`, preview);
        // 追踪 send_message 是否真正成功（结果中不含 error/失败标记）
        if (name.includes('send_message') && !isError) {
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          if (!resultStr.includes('"success": false') && !resultStr.includes('"success":false')) {
            sendMessageSuccess = true;
            sendCount++;
            
            // 将成功发送的消息记入本地缓存
            if (pendingSendContent) {
              // 尝试从结果中提取 message_id 和 timestamp
              let msgId = null;
              let msgTs = new Date().toISOString();
              try {
                const parsed = typeof result === 'string' ? JSON.parse(result) : result;
                msgId = parsed?.message_id || null;
                if (parsed?.timestamp) msgTs = parsed.timestamp;
              } catch { /* ignore */ }
              
              const arr = sentCache.get(target) || [];
              arr.push({ content: pendingSendContent, timestamp: msgTs, message_id: msgId });
              sentCache.set(target, arr);
              addLog('info', `Cached sent message for ${target}: ${pendingSendContent.substring(0, 50)}...`);
            }
            pendingSendContent = null; // 重置
          }
        }
      },
    });
    
    // 只有 LLM 调用成功完成后才更新水位线
    // 如果 send_message 失败了，不更新水位线，下次轮询会重试
    if (sendMessageSuccess || !result.toolCallHistory?.some(t => t.name.includes('send_message'))) {
      watermarks.set(target, pendingWatermark);
    } else {
      addLog('warn', `send_message failed, watermark NOT updated for ${target} (will retry next poll)`);
    }
    
    if (sendMessageSuccess) {
      addLog('info', `✅ Replied to ${targetType}:${target}`, result.content?.substring(0, 100));
      return { action: 'replied', detail: result.content };
    } else if (result.toolCallHistory?.some(t => t.name.includes('send_message'))) {
      addLog('warn', `⚠️ Tried to reply but send failed for ${targetType}:${target}`, result.content?.substring(0, 100));
      return { action: 'send_failed', detail: result.content };
    } else {
      addLog('info', `😶 Silent for ${targetType}:${target}`, result.content?.substring(0, 50));
      return { action: 'silent', detail: result.content };
    }
  } catch (e) {
    addLog('error', `LLM call failed for ${target}`, e.message);
    return { action: 'error', detail: e.message };
  }
}

// ============ 循环引擎 ============

/**
 * 启动社交循环
 * 
 * @param {Object} config - 社交配置
 * @param {string} config.petId
 * @param {string} config.mcpServerName
 * @param {string} config.apiProviderId
 * @param {string} config.modelName
 * @param {number} config.pollingInterval - 秒
 * @param {string[]} config.watchedGroups
 * @param {string[]} config.watchedFriends
 * @param {string} config.socialPersonaPrompt
 * @param {string} config.replyStrategyPrompt
 * @param {boolean} config.atMustReply
 * @param {string} config.botQQ
 * @param {Function} [onStatusChange] - 状态变化回调 (active: boolean) => void
 */
export async function startSocialLoop(config, onStatusChange) {
  // 先停止现有循环
  stopSocialLoop();
  
  addLog('info', `Starting social loop for pet: ${config.petId}`);
  
  // 确保 MCP 服务器已启动
  try {
    const server = await tauri.mcp.getServerByName(config.mcpServerName);
    if (server?._id) {
      const isRunning = await tauri.mcp.isServerRunning(server._id);
      if (!isRunning) {
        addLog('info', `Starting MCP server "${config.mcpServerName}"...`);
        await tauri.mcp.startServer(server._id);
        // 等待服务器就绪
        await new Promise(r => setTimeout(r, 2000));
        addLog('info', `MCP server "${config.mcpServerName}" started`);
      }
    } else {
      addLog('error', `MCP server "${config.mcpServerName}" not found`);
      return false;
    }
  } catch (e) {
    addLog('error', `Failed to start MCP server "${config.mcpServerName}"`, typeof e === 'string' ? e : e.message);
    return false;
  }
  
  // 解析 API provider
  const llmConfig = await resolveApiProvider(config.apiProviderId, config.modelName);
  if (!llmConfig) {
    addLog('error', 'Cannot start: API provider not resolved');
    return false;
  }

  // 为 MCP 服务器设置 Sampling LLM 配置
  // 这样当 QQ MCP 的 compress_context 需要 Sampling 时，Tauri 能代理调用 LLM
  try {
    const server = await tauri.mcp.getServerByName(config.mcpServerName);
    if (server?._id) {
      await tauri.mcp.setSamplingConfig(server._id, {
        api_key: llmConfig.apiKey,
        model: llmConfig.modelName,
        base_url: llmConfig.baseUrl || null,
        api_format: llmConfig.apiFormat || 'openai_compatible',
      });
      addLog('info', `Sampling config set for MCP server "${config.mcpServerName}"`);
    }
  } catch (e) {
    addLog('warn', `Failed to set sampling config: ${e.message || e}`);
    // 非致命错误，继续启动
  }
  
  // 启动额外的 MCP 服务器
  const extraMcpServers = config.enabledMcpServers || [];
  for (const extraName of extraMcpServers) {
    if (extraName === config.mcpServerName) continue; // 跳过主 MCP
    try {
      const extraServer = await tauri.mcp.getServerByName(extraName);
      if (extraServer?._id) {
        const isRunning = await tauri.mcp.isServerRunning(extraServer._id);
        if (!isRunning) {
          addLog('info', `Starting extra MCP server "${extraName}"...`);
          await tauri.mcp.startServer(extraServer._id);
          await new Promise(r => setTimeout(r, 1500));
          addLog('info', `Extra MCP server "${extraName}" started`);
        }
      } else {
        addLog('warn', `Extra MCP server "${extraName}" not found, skipping`);
      }
    } catch (e) {
      addLog('warn', `Failed to start extra MCP server "${extraName}"`, e.message || e);
    }
  }

  const watermarks = new Map();
  
  // 构建目标列表
  const targets = [];
  for (const g of (config.watchedGroups || [])) {
    if (g.trim()) targets.push({ target: g.trim(), targetType: 'group' });
  }
  for (const f of (config.watchedFriends || [])) {
    if (f.trim()) targets.push({ target: f.trim(), targetType: 'private' });
  }
  
  if (targets.length === 0) {
    addLog('warn', 'No watched targets configured');
    return false;
  }
  
  addLog('info', `Watching ${targets.length} targets, interval: ${config.pollingInterval}s`);
  
  const promptConfig = {
    socialPersonaPrompt: config.socialPersonaPrompt || '',
    replyStrategyPrompt: config.replyStrategyPrompt || '',
    atMustReply: config.atMustReply !== false,
    injectBehaviorGuidelines: config.injectBehaviorGuidelines !== false,
    botQQ: config.botQQ || '',
    ownerQQ: config.ownerQQ || '',
    ownerName: config.ownerName || '',
    enabledMcpServers: config.enabledMcpServers || [],
  };
  
  const intervalMs = (config.pollingInterval || 60) * 1000;
  // 每个 target 独立的 timeout ID，互不阻塞
  const targetTimeouts = new Map();
  // 用于区分新旧循环的 generation ID，stopSocialLoop 后立即 start 时防止旧闭包继续调度
  const loopGeneration = Symbol('loopGen');
  
  // 为单个 target 创建独立的轮询循环（含独立计时）
  const startTargetLoop = (target, targetType, staggerMs = 0) => {
    const label = `${targetType}:${target}`;
    
    const runOnce = async () => {
      // 检查循环是否仍属于本次启动（防止 stop→start 竞态）
      if (!activeLoop || activeLoop._generation !== loopGeneration) return;
      const t0 = Date.now();
      try {
        await pollTarget({
          target,
          targetType,
          mcpServerName: config.mcpServerName,
          llmConfig,
          petId: config.petId,
          promptConfig,
          watermarks,
          sentCache: sentMessagesCache,
        });
      } catch (e) {
        addLog('error', `Unexpected error polling ${label}`, e.message);
      }
      const elapsed = Date.now() - t0;
      addLog('debug', `${label} poll completed in ${elapsed}ms`);
      
      // 调度下一次（独立计时，从本次开始算）
      if (activeLoop && activeLoop._generation === loopGeneration) {
        const tid = setTimeout(runOnce, intervalMs);
        targetTimeouts.set(target, tid);
      }
    };
    
    // 首次执行（可错开启动，避免所有 target 同时发起请求）
    if (staggerMs > 0) {
      const tid = setTimeout(runOnce, staggerMs);
      targetTimeouts.set(target, tid);
    } else {
      runOnce(); // 立即启动
    }
  };
  
  // 并发启动所有 target，每个间隔 200ms 错开，减轻瞬时并发压力
  const STAGGER_MS = 200;
  
  // 必须在启动 target 循环之前设置 activeLoop，
  // 否则 stagger=0 的首个 target 同步执行 runOnce() 时 activeLoop 仍为 null 会被跳过
  activeLoop = {
    petId: config.petId,
    config,
    targetTimeouts,
    _generation: loopGeneration,
    _scheduleCleanup: () => {
      for (const [, tid] of targetTimeouts) {
        clearTimeout(tid);
      }
      targetTimeouts.clear();
    },
  };
  
  targets.forEach(({ target, targetType }, index) => {
    startTargetLoop(target, targetType, index * STAGGER_MS);
  });
  
  onStatusChange?.(true);
  addLog('info', 'Social loop started successfully');
  return true;
}

/**
 * 停止社交循环
 */
export function stopSocialLoop() {
  if (activeLoop) {
    activeLoop._scheduleCleanup?.();
    addLog('info', `Stopped social loop for pet: ${activeLoop.petId}`);
    activeLoop = null;
    sentMessagesCache.clear();
  }
}

/**
 * 获取当前社交循环状态
 * @returns {{ active: boolean, petId: string|null }}
 */
export function getSocialStatus() {
  return {
    active: activeLoop !== null,
    petId: activeLoop?.petId || null,
  };
}

/**
 * 检查指定 pet 的社交循环是否活跃
 * @param {string} petId
 * @returns {boolean}
 */
export function isSocialActiveForPet(petId) {
  return activeLoop?.petId === petId;
}

export default {
  loadSocialConfig,
  saveSocialConfig,
  startSocialLoop,
  stopSocialLoop,
  getSocialStatus,
  isSocialActiveForPet,
  getSocialLogs,
  clearSocialLogs,
};
