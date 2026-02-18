/**
 * socialAgent.js — 后台自主社交循环引擎
 * 
 * 定时通过 MCP 获取群聊/私聊消息，用 LLM 自主决策是否回复。
 * 每次调用 LLM 都是独立的单轮请求，不累积上下文。
 */

import { buildSocialPrompt } from './socialPromptBuilder';
import { executeToolByName, getMcpTools, resolveImageUrls } from './mcp/toolExecutor';
import { callLLMWithTools } from './mcp/toolExecutor';
import { getSocialBuiltinToolDefinitions } from './workspace/socialToolExecutor';
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
 * @param {Object} [params.prefetchedData] - 从 batch_get_recent_context 预取的数据
 *   { target, target_type, compressed_summary, message_count, messages: [...], group_name }
 *   如果提供，跳过 MCP 调用直接使用
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
  prefetchedData,
}) {
  let metadata = {};
  let groupName = target;
  let compressedSummary = null;
  let individualMessages = [];
  
  if (prefetchedData) {
    // ── 批量预取路径：数据已从 batch_get_recent_context 获取 ──
    if (prefetchedData.error) {
      addLog('error', `MCP batch error for ${target}`, prefetchedData.error);
      return { action: 'error', detail: prefetchedData.error };
    }
    metadata = prefetchedData;
    groupName = prefetchedData.group_name || prefetchedData.friend_name || target;
    compressedSummary = prefetchedData.compressed_summary || null;
    // messages 是 dict 数组 { sender_id, sender_name, content, is_at_me, is_self, image_urls, ... }
    for (const msg of (prefetchedData.messages || [])) {
      const images = (msg.image_urls || []).map(url => ({ data: url, mimeType: 'image/jpeg' }));
      individualMessages.push({ ...msg, _images: images });
    }
  } else {
    // ── 单次拉取路径（兼容旧调用方式） ──
    const toolName = `${mcpServerName}__get_recent_context`;
    let rawResult;
    try {
      rawResult = await executeToolByName(toolName, {
        target,
        target_type: targetType,
        limit: Math.max(5, Math.round(10 * Math.sqrt((config?.pollingInterval || 60)))),
      });
    } catch (e) {
      addLog('error', `Failed to get messages for ${targetType}:${target}`, e.message);
      return { action: 'error', detail: e.message };
    }
    if (rawResult?.error) {
      addLog('error', `MCP error for ${target}`, rawResult.error);
      return { action: 'error', detail: rawResult.error };
    }
    // 解析 MCP 返回（content 数组: metadata TextContent + 逐条消息 TextContent + ImageContent）
    const contentItems = rawResult.content || [];
    let lastMsg = null;
    let metadataParsed = false;
    for (const item of contentItems) {
      if (item.type === 'text') {
        try {
          const parsed = JSON.parse(item.text);
          if (!metadataParsed) {
            metadata = parsed;
            groupName = metadata.group_name || metadata.friend_name || target;
            compressedSummary = metadata.compressed_summary || null;
            metadataParsed = true;
          } else if (parsed.sender_id && parsed.content !== undefined) {
            parsed._images = [];
            individualMessages.push(parsed);
            lastMsg = parsed;
          }
        } catch { /* skip */ }
      } else if (item.type === 'image' && lastMsg) {
        lastMsg._images.push({ data: item.data, mimeType: item.mimeType || 'image/jpeg' });
      }
    }
  }
  
  // 解析图片 URL 为 base64
  let totalImageCount = 0;
  for (const msg of individualMessages) {
    if (msg._images && msg._images.length > 0) {
      msg._images = await resolveImageUrls(msg._images);
      totalImageCount += msg._images.length;
    } else {
      msg._images = [];
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
    targetId: target,
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
  
  // 6.5 合并社交内置工具（social_read / social_write / social_edit）
  const socialBuiltinDefs = getSocialBuiltinToolDefinitions();
  const socialToolsAsMcp = socialBuiltinDefs.map(t => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
    serverName: null, // 无 server 前缀 = 内置工具标识
  }));
  mcpTools = [...mcpTools, ...socialToolsAsMcp];
  
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
      builtinToolContext: { petId, memoryEnabled: true },
      // 强制覆盖 send_message 的 target/target_type，防止 LLM 用群名代替群号
      toolArgTransform: (name, args) => {
        if (name.includes('send_message')) {
          return { ...args, target, target_type: targetType };
        }
        return args;
      },

      onToolCall: (name, args) => {
        // 社交记忆写入用特殊 level 标记
        if (name === 'social_write' || name === 'social_edit') {
          addLog('memory', `🧠 社交记忆更新: ${name}`, JSON.stringify(args).substring(0, 300));
        } else {
          addLog('info', `LLM called tool: ${name}`, JSON.stringify(args).substring(0, 200));
        }
        // 暂存 send_message 的 content，等 onToolResult 确认成功后写入缓存
        if (name.includes('send_message')) {
          pendingSendContent = args?.content || '';
        }
      },
      onToolResult: (name, result, _id, isError) => {
        const preview = typeof result === 'string' ? result.substring(0, 100) : JSON.stringify(result).substring(0, 100);
        if ((name === 'social_write' || name === 'social_edit') && !isError) {
          addLog('memory', `✅ 社交记忆已保存`, preview);
        } else {
          addLog(isError ? 'error' : 'info', `Tool result: ${name}`, preview);
        }
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

// ============ 社交记忆辅助 ============

const COMPRESS_META_PATH = 'social/compress_meta.json';
const KNOWN_TARGETS_PATH = 'social/targets.json';

/**
 * 持久化已知 target 列表
 */
async function persistKnownTargets(petId, targetSet) {
  try {
    await tauri.workspaceWrite(petId, KNOWN_TARGETS_PATH, JSON.stringify([...targetSet]));
  } catch (e) {
    console.warn('[Social] Failed to persist known targets', e);
  }
}

/**
 * 加载已知 target 列表
 */
async function loadKnownTargets(petId) {
  try {
    const raw = await tauri.workspaceRead(petId, KNOWN_TARGETS_PATH);
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/**
 * 读取压缩元数据
 */
async function loadCompressMeta(petId) {
  try {
    const raw = await tauri.workspaceRead(petId, COMPRESS_META_PATH);
    return JSON.parse(raw);
  } catch {
    return { lastCompressTime: null };
  }
}

/**
 * 保存压缩元数据
 */
async function saveCompressMeta(petId, meta) {
  try {
    await tauri.workspaceWrite(petId, COMPRESS_META_PATH, JSON.stringify(meta));
  } catch (e) {
    console.warn('[Social] Failed to save compress meta', e);
  }
}

/**
 * 解析群缓冲文件内容，按日期分组
 * 每条格式: ## {ISO timestamp}\n{content}\n
 * @returns {Map<string, string[]>} dateStr -> entries[]
 */
function parseBufferByDate(content) {
  const groups = new Map();
  if (!content) return groups;
  const sections = content.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    // 提取时间戳行
    const match = trimmed.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (match) {
      const dateStr = match[1];
      const arr = groups.get(dateStr) || [];
      arr.push(trimmed);
      groups.set(dateStr, arr);
    }
  }
  return groups;
}

/**
 * 执行每日压缩
 * 读取所有群缓冲文件 → 按天分组 → 逐天 LLM 压缩 → 写入 DAILY → 清空已压缩内容
 */
async function runDailyCompress(petId, llmConfig, targetSet) {
  addLog('info', '📦 Starting daily compression...');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  // 收集所有群的所有非今天的数据，按天分组
  // key: dateStr, value: Array<{ target, entries[] }>
  const dayGroups = new Map();
  
  for (const target of targetSet) {
    const bufferPath = `social/GROUP_${target}.md`;
    let content;
    try {
      content = await tauri.workspaceRead(petId, bufferPath);
    } catch { continue; } // 文件不存在
    if (!content || !content.trim()) continue;
    
    const dateMap = parseBufferByDate(content);
    for (const [dateStr, entries] of dateMap) {
      if (dateStr === today) continue; // 今天的不压缩
      if (!dayGroups.has(dateStr)) dayGroups.set(dateStr, []);
      dayGroups.get(dateStr).push({ target, entries });
    }
  }
  
  if (dayGroups.size === 0) {
    addLog('info', 'No past-day data to compress');
    return;
  }
  
  // 逐天压缩
  for (const [dateStr, targetEntries] of [...dayGroups.entries()].sort()) {
    // 拼接当天所有群的所有摘要
    let combined = `# ${dateStr} 社交记录\n\n`;
    for (const { target, entries } of targetEntries) {
      combined += `## 群/好友 ${target}\n`;
      combined += entries.join('\n') + '\n\n';
    }
    
    // LLM 压缩
    try {
      const compressPrompt = `你是一个信息压缩助手。请将以下一天的社交聊天记录摘要压缩成精炼的每日总结。
保留关键事件、重要对话、群友动态，去除重复和琐碎内容。
输出纯文本，不需要 markdown 格式标题。控制在 500 字以内。

${combined}`;
      
      const result = await callLLMWithTools({
        messages: [
          { role: 'system', content: '你是一个精简信息的助手。' },
          { role: 'user', content: compressPrompt },
        ],
        apiFormat: llmConfig.apiFormat,
        apiKey: llmConfig.apiKey,
        model: llmConfig.modelName,
        baseUrl: llmConfig.baseUrl,
        mcpTools: [],
        options: { temperature: 0.3 },
      });
      
      const dailyContent = `# ${dateStr} 社交日报\n\n${result.content || '（压缩失败）'}\n`;
      const dailyPath = `social/DAILY_${dateStr}.md`;
      await tauri.workspaceWrite(petId, dailyPath, dailyContent);
      addLog('info', `📝 Compressed daily log: ${dailyPath}`);
    } catch (e) {
      addLog('error', `Failed to compress daily log for ${dateStr}`, e.message);
      continue; // 压缩失败不清空，下次重试
    }
    
    // 从各群缓冲中删除已压缩日期的条目（保留今天的）
    for (const { target } of targetEntries) {
      const bufferPath = `social/GROUP_${target}.md`;
      try {
        const content = await tauri.workspaceRead(petId, bufferPath);
        const dateMap = parseBufferByDate(content);
        dateMap.delete(dateStr); // 删除已压缩日期
        // 重写文件（只保留未压缩的日期条目）
        const remaining = [...dateMap.values()].flat().join('\n\n');
        await tauri.workspaceWrite(petId, bufferPath, remaining);
      } catch (e) {
        addLog('warn', `Failed to clean buffer for ${target} date ${dateStr}`, e.message);
      }
    }
  }
  
  // 更新压缩元数据
  await saveCompressMeta(petId, { lastCompressTime: new Date().toISOString() });
  addLog('info', '📦 Daily compression completed');
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
  const atInstantReply = config.atInstantReply !== false; // 默认开启
  // 批量轮询间隔：开启@瞬回时快速轮询(1s)，否则按用户配置
  const BATCH_POLL_INTERVAL_MS = atInstantReply ? 1000 : intervalMs;
  // 动态 limit：L = max(5, round(k * sqrt(T)))，k=10
  const dynamicLimit = Math.max(5, Math.round(10 * Math.sqrt(BATCH_POLL_INTERVAL_MS / 1000)));
  
  // per-target 上次 LLM 调用时间（冷却计时，@me 不受限制）
  const lastLlmCallTime = new Map();
  // 已知 target 列表（用于每日压缩时遍历群缓冲文件）
  const knownTargets = new Set();
  // 上次 append 到群缓冲的 compressed_summary（用于去重，避免累积摘要重复写入）
  const lastAppendedSummary = new Map();
  // 用于区分新旧循环的 generation ID，stopSocialLoop 后立即 start 时防止旧闭包继续调度
  const loopGeneration = Symbol('loopGen');
  let loopTimeoutId = null;
  let dailyCompressTimeoutId = null; // 每日压缩定时器
  
  /**
   * 解析 batch_get_recent_context 的 MCP 返回
   * MCP 工具返回 dict 会被包装成单个 TextContent
   * @returns {Array<Object>} 每个 target 的数据 dict
   */
  const parseBatchResult = (rawResult) => {
    const contentItems = rawResult?.content || [];
    for (const item of contentItems) {
      if (item.type === 'text') {
        try {
          const parsed = JSON.parse(item.text);
          if (parsed.results && Array.isArray(parsed.results)) {
            return parsed.results;
          }
          // 如果直接就是 results 数组（兼容）
          if (Array.isArray(parsed)) return parsed;
        } catch { /* skip */ }
      }
    }
    return [];
  };
  
  /**
   * 对单个 target 的预取数据做变化检测（不调 MCP，纯本地）
   * 返回 { changed, hasAtMe, hash } 或 null 表示跳过
   */
  const detectChange = (targetData, target) => {
    if (targetData.error) return null;
    const messages = targetData.messages || [];
    const otherMessages = messages.filter(m => !m.is_self);
    const otherText = otherMessages
      .map(m => `${m.sender_name}:${m.content}`)
      .join('\n').trim();
    const currentHash = otherText.length < 10
      ? null
      : `${otherText.length}:${otherText.slice(-200)}`;
    if (currentHash === null) return null;
    
    const prevWm = watermarks.get(target) ?? null;
    const changed = prevWm === null || currentHash !== prevWm.hash;
    const isFirstRun = prevWm === null;
    const hasAtMe = messages.some(m => m.is_at_me && !m.is_self);
    return { changed, hasAtMe, hash: currentHash, isFirstRun };
  };
  
  /**
   * 统一批量轮询：一次拉取所有 target → 本地分群处理
   */
  const runBatchPoll = async () => {
    if (!activeLoop || activeLoop._generation !== loopGeneration) return;
    
    const t0 = Date.now();
    const batchToolName = `${config.mcpServerName}__batch_get_recent_context`;
    
    // 1. 一次 MCP 调用获取所有 target 数据
    let targetResults = [];
    try {
      const batchArgs = {
        targets: targets.map(t => ({ target: t.target, target_type: t.targetType })),
        limit: dynamicLimit,
      };
      const rawResult = await executeToolByName(batchToolName, batchArgs, { timeout: 10000 });
      targetResults = parseBatchResult(rawResult);
    } catch (e) {
      addLog('error', 'Batch poll failed', e.message);
      scheduleBatchPoll();
      return;
    }
    
    if (targetResults.length === 0) {
      addLog('debug', 'Batch poll returned empty results');
      scheduleBatchPoll();
      return;
    }
    
    // 2. 逐 target 本地处理（变化检测 + 冷却 + LLM 调用）— 并发执行
    const pollTasks = [];
    for (const targetData of targetResults) {
      if (!activeLoop || activeLoop._generation !== loopGeneration) return;
      
      const target = targetData.target;
      const targetType = targetData.target_type || 'group';
      const label = `${targetType}:${target}`;
      
      const detection = detectChange(targetData, target);
      if (!detection) continue; // 无消息 / 错误
      
      const { changed, hasAtMe, hash, isFirstRun } = detection;
      
      // 首次运行：设水位线，不调 LLM
      if (isFirstRun) {
        watermarks.set(target, { hash });
        addLog('info', `${label} first run, watermark set (skip LLM)`);
        continue;
      }
      
      if (!changed) continue; // 无新内容
      
      // 自动 append compressed_summary 到每群缓冲文件（去重：跳过与上次相同的摘要）
      if (targetData.compressed_summary) {
        const prevSummary = lastAppendedSummary.get(target);
        if (targetData.compressed_summary !== prevSummary) {
          const bufferPath = `social/GROUP_${target}.md`;
          const timestamp = new Date().toISOString();
          const entry = `\n## ${timestamp}\n${targetData.compressed_summary}\n`;
          try {
            let existing = '';
            try { existing = await tauri.workspaceRead(config.petId, bufferPath) || ''; } catch { /* 文件不存在 */ }
            await tauri.workspaceWrite(config.petId, bufferPath, existing + entry);
            lastAppendedSummary.set(target, targetData.compressed_summary);
            // 维护已知 target 列表
            knownTargets.add(target);
            await persistKnownTargets(config.petId, knownTargets);
          } catch (e) {
            addLog('warn', `Failed to append group buffer for ${target}`, e.message);
          }
        }
      }
      
      // 决定是否调用 LLM
      const now = Date.now();
      const sinceLastLlm = now - (lastLlmCallTime.get(target) || 0);
      const cooldownPassed = sinceLastLlm >= intervalMs;
      
      if (hasAtMe) {
        // @me → 立即回复（无视冷却）
        addLog('info', `⚡ @me detected in ${label}, triggering instant reply`);
      } else if (!cooldownPassed) {
        // 有新消息但冷却中 → 跳过，不更新水位线，让消息积累到冷却结束
        continue;
      }
      
      // 创建并发任务
      pollTasks.push((async () => {
        try {
          const result = await pollTarget({
            target,
            targetType,
            mcpServerName: config.mcpServerName,
            llmConfig,
            petId: config.petId,
            promptConfig,
            watermarks,
            sentCache: sentMessagesCache,
            prefetchedData: targetData,
          });
          // 只有成功处理（replied/silent）才记录 LLM 调用时间
          if (result.action === 'replied' || result.action === 'silent') {
            lastLlmCallTime.set(target, Date.now());
          }
        } catch (e) {
          addLog('error', `Unexpected error polling ${label}`, e.message);
        }
      })());
    }
    
    // 等待所有并发 pollTarget 完成
    if (pollTasks.length > 0) {
      await Promise.all(pollTasks);
    }
    
    const elapsed = Date.now() - t0;
    addLog('debug', `Batch poll completed in ${elapsed}ms for ${targetResults.length} targets`);
    
    // 3. 调度下一次
    scheduleBatchPoll();
  };
  
  const scheduleBatchPoll = () => {
    if (activeLoop && activeLoop._generation === loopGeneration) {
      loopTimeoutId = setTimeout(runBatchPoll, BATCH_POLL_INTERVAL_MS);
    }
  };
  
  // 设置 activeLoop
  activeLoop = {
    petId: config.petId,
    config,
    _generation: loopGeneration,
    _scheduleCleanup: () => {
      if (loopTimeoutId !== null) {
        clearTimeout(loopTimeoutId);
        loopTimeoutId = null;
      }
      if (dailyCompressTimeoutId !== null) {
        clearTimeout(dailyCompressTimeoutId);
        dailyCompressTimeoutId = null;
      }
    },
  };
  
  // === 启动时：加载已知 targets + 检查并执行待处理的每日压缩 ===
  (async () => {
    try {
      const loaded = await loadKnownTargets(config.petId);
      for (const t of loaded) knownTargets.add(t);
      // 也把当前配置的 targets 加入
      for (const t of targets) knownTargets.add(t.target);
      
      // 检查是否有过去日期的群缓冲需要压缩
      if (knownTargets.size > 0) {
        await runDailyCompress(config.petId, llmConfig, knownTargets);
      }
    } catch (e) {
      addLog('warn', 'Startup compression check failed', e.message);
    }
  })();
  
  // === 调度每日 23:55 定时压缩 ===
  const scheduleDailyCompressTimer = () => {
    if (!activeLoop || activeLoop._generation !== loopGeneration) return;
    
    const now = new Date();
    // 计算今天 23:55 的时间点
    const target2355 = new Date(now);
    target2355.setHours(23, 55, 0, 0);
    
    let msUntilTarget;
    if (now >= target2355) {
      // 已经过了今天 23:55，调度到明天 23:55
      const tomorrow2355 = new Date(target2355);
      tomorrow2355.setDate(tomorrow2355.getDate() + 1);
      msUntilTarget = tomorrow2355.getTime() - now.getTime();
    } else {
      msUntilTarget = target2355.getTime() - now.getTime();
    }
    
    addLog('info', `Next daily compression scheduled in ${Math.round(msUntilTarget / 60000)} minutes`);
    
    dailyCompressTimeoutId = setTimeout(async () => {
      if (!activeLoop || activeLoop._generation !== loopGeneration) return;
      addLog('info', '⏰ 23:55 daily compression triggered');
      try {
        await runDailyCompress(config.petId, llmConfig, knownTargets);
      } catch (e) {
        addLog('error', 'Daily compression timer failed', e.message);
      }
      // 压缩完成后调度下一次（明天 23:55）
      scheduleDailyCompressTimer();
    }, msUntilTarget);
  };
  
  scheduleDailyCompressTimer();
  
  // 启动批量轮询
  runBatchPoll();
  
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
