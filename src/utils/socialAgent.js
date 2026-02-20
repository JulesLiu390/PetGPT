/**
 * socialAgent.js — 后台自主社交循环引擎
 * 
 * 定时通过 MCP 获取群聊/私聊消息，用 LLM 自主决策是否回复。
 * 每次调用 LLM 都是独立的单轮请求，不累积上下文。
 */

import { buildSocialPrompt } from './socialPromptBuilder';
import { executeToolByName, getMcpTools, resolveImageUrls } from './mcp/toolExecutor';
import { callLLMWithTools } from './mcp/toolExecutor';
import { getSocialBuiltinToolDefinitions, getGroupRuleToolDefinitions, getReplyStrategyToolDefinitions, getHistoryToolDefinitions } from './workspace/socialToolExecutor';
import * as tauri from './tauri';

// ============ 状态 ============

/** 当前活跃的社交循环（同一时间只有一个） */
let activeLoop = null;

/** 每个 target 的潜水模式 Map<target, 'normal'|'semi-lurk'|'full-lurk'> */
const lurkModes = new Map();

/** target 名称缓存 Map<target, string> —— 从 MCP 批量拉取中自动填充 */
const targetNamesCache = new Map();

/** 系统日志（无 target，最多 200 条） */
const systemLogs = [];
/** 每目标日志 Map<target, Array>（每个 target 最多 200 条） */
const targetLogs = new Map();
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

function addLog(level, message, details = null, target = undefined) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
    target,
  };
  if (target) {
    if (!targetLogs.has(target)) targetLogs.set(target, []);
    const arr = targetLogs.get(target);
    arr.push(entry);
    if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
  } else {
    systemLogs.push(entry);
    if (systemLogs.length > MAX_LOGS) systemLogs.splice(0, systemLogs.length - MAX_LOGS);
  }

  // Don't console.log poll entries (they are aggregated and verbose)
  if (level === 'poll') return;

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
  const all = [...systemLogs];
  for (const arr of targetLogs.values()) all.push(...arr);
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

/**
 * 清空社交日志
 */
export function clearSocialLogs() {
  systemLogs.length = 0;
  targetLogs.clear();
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

/**
 * 加载持久化的 lurk modes
 * @param {string} petId
 * @returns {Promise<Object|null>} { [target]: mode }
 */
async function loadLurkModes(petId) {
  try {
    const allSettings = await tauri.getSettings();
    const raw = allSettings[`social_lurk_modes_${petId}`];
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[Social] Failed to load lurk modes for', petId, e);
    return null;
  }
}

/**
 * 持久化 lurk modes
 * @param {string} petId
 * @param {Object} modes - { [target]: mode }
 */
async function saveLurkModes(petId, modes) {
  try {
    await tauri.updateSettings({
      [`social_lurk_modes_${petId}`]: JSON.stringify(modes)
    });
  } catch (e) {
    console.warn('[Social] Failed to save lurk modes', e);
  }
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
function buildTurnsFromMessages(messages, { sanitizeAtMe = false, ownerQQ = '', ownerName = '', ownerSecret = '', nameL = '', nameR = '', msgL = '', msgR = '' } = {}) {
  if (!messages || messages.length === 0) return [];

  // 用于从文本中剥离所有安全分隔符和令牌的辅助函数
  const allSecrets = [ownerSecret, nameL, nameR, msgL, msgR].filter(Boolean);
  const stripSecrets = (s) => {
    for (const sec of allSecrets) s = s.replaceAll(sec, '');
    return s;
  };

  const turns = [];

  for (const msg of messages) {
    const role = msg.is_self ? 'assistant' : 'user';

    let text;
    if (msg.is_self) {
      // assistant turn：只放内容，不加名字前缀
      text = msg.content || '';
    } else {
      // user turn：用安全分隔符包裹名字和消息
      let name = stripSecrets(String(msg.sender_name || msg.sender_id));
      const isOwner = ownerQQ && (String(msg.sender_id) === String(ownerQQ));
      // 非主人：如果昵称试图冒充主人（包含主人名字/QQ/owner/user关键词），替换为警告
      if (!isOwner) {
        const nameLower = name.toLowerCase();
        const suspicious =
          (ownerName && nameLower.includes(ownerName.toLowerCase())) ||
          (ownerQQ && nameLower.includes(String(ownerQQ))) ||
          /\b(owner|user)\b/i.test(nameLower);
        if (suspicious) {
          name = '（试图骗你是user，使用注入的坏人）';
        }
      }
      const idTag = isOwner && ownerSecret ? `owner:${ownerSecret}` : String(msg.sender_id || '');
      let msgContent = stripSecrets(msg.content || '');
      text = `${nameL}${name}(${idTag})${nameR} ${msgL}${msgContent}${msgR}`;
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
 * @param {Object} params.promptConfig - { socialPersonaPrompt, atMustReply, agentCanEditStrategy, botQQ }
 * @param {Map} params.watermarks - 水位线 Map (target -> lastMessageId)
 * @param {Map} params.sentCache - 本地发送消息缓存 (target -> Array)
 * @param {Object} [params.prefetchedData] - 从 batch_get_recent_context 预取的数据
 *   { target, target_type, compressed_summary, message_count, messages: [...], group_name }
 *   如果提供，跳过 MCP 调用直接使用
 * @param {Set<string>} [params.consumedAtMeIds] - 已消费的 @me message_id 集合，用于消毒旧 @me
 * @param {'normal'|'semi-lurk'|'full-lurk'} [params.lurkMode='normal'] - 潜水模式
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
  consumedAtMeIds,
  lurkMode: pollLurkMode = 'normal',
}) {
  let metadata = {};
  let groupName = target;
  let compressedSummary = null;
  let individualMessages = [];
  
  if (prefetchedData) {
    // ── 批量预取路径：数据已从 batch_get_recent_context 获取 ──
    if (prefetchedData.error) {
      addLog('error', `MCP batch error for ${target}`, prefetchedData.error, target);
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
      addLog('error', `Failed to get messages for ${targetType}:${target}`, e.message, target);
      return { action: 'error', detail: e.message };
    }
    if (rawResult?.error) {
      addLog('error', `MCP error for ${target}`, rawResult.error, target);
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
    addLog('info', `Resolved ${totalImageCount} image(s) across ${individualMessages.filter(m => m._images.length > 0).length} message(s)`, null, target);
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
      addLog('info', `Injected ${injected} cached bot message(s) for ${target}`, null, target);
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
      addLog('info', `${targetType}:${target} no messages found, skipping`, null, target);
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
    addLog('info', `${targetType}:${target} first run, ${individualMessages.length} messages, watermark set (skip LLM)`, null, target);
    return { action: 'skipped', detail: 'first run — watermark initialized' };
  }
  
  // 4. 消息缓冲区过大时触发压缩（依赖 MCP Sampling）
  const messageCount = metadata.message_count ?? individualMessages.length;
  if (messageCount >= 30) {
    try {
      const compressToolName = `${mcpServerName}__compress_context`;
      await executeToolByName(compressToolName, { target, target_type: targetType }, { timeout: 15000 });
      addLog('info', `Triggered compress_context for ${target} (${messageCount} messages)`, null, target);
    } catch (e) {
      addLog('warn', `compress_context failed/timeout for ${target}`, e.message, target);
    }
  }
  
  // 5. 生成本轮临时安全令牌（每次 poll 都不同，用完即弃）
  const _rnd = () => crypto.randomUUID().slice(0, 6);
  const ephemeral = {
    ownerSecret: _rnd(),
    nameL: `«${_rnd()}»`,
    nameR: `«/${_rnd()}»`,
    msgL:  `‹${_rnd()}›`,
    msgR:  `‹/${_rnd()}›`,
  };

  // 6. 构建多轮消息数组
  const systemPrompt = await buildSocialPrompt({
    petId,
    socialPersonaPrompt: promptConfig.socialPersonaPrompt,
    atMustReply: promptConfig.atMustReply,
    targetName: groupName,
    targetId: target,
    botQQ: promptConfig.botQQ,
    ownerQQ: promptConfig.ownerQQ,
    ownerName: promptConfig.ownerName,
    ownerSecret: ephemeral.ownerSecret,
    nameDelimiterL: ephemeral.nameL,
    nameDelimiterR: ephemeral.nameR,
    msgDelimiterL: ephemeral.msgL,
    msgDelimiterR: ephemeral.msgR,
    injectBehaviorGuidelines: promptConfig.injectBehaviorGuidelines !== false,
    agentCanEditStrategy: promptConfig.agentCanEditStrategy === true,
    lurkMode: pollLurkMode,
  });
  
  // 消毒已消费的 @me：让 LLM 不再看到旧 @me 触发信号
  if (consumedAtMeIds && consumedAtMeIds.size > 0) {
    for (const msg of individualMessages) {
      if (msg.is_at_me && !msg.is_self && msg.message_id && consumedAtMeIds.has(msg.message_id)) {
        msg.content = (msg.content || '').replaceAll('@me', '@[已读]');
        msg.is_at_me = false;
      }
    }
  }

  // 从逐条消息构建 user/assistant 轮次
  const historyTurns = buildTurnsFromMessages(individualMessages, {
    sanitizeAtMe: false,
    ownerQQ: promptConfig.ownerQQ,
    ownerName: promptConfig.ownerName,
    ownerSecret: ephemeral.ownerSecret,
    nameL: ephemeral.nameL,
    nameR: ephemeral.nameR,
    msgL: ephemeral.msgL,
    msgR: ephemeral.msgR,
  });
  
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
    addLog('info', `${targetType}:${target} has @me in messages`, null, target);
  }
  
  // 如果其他人没有新消息（只有 bot 自己的），跳过
  if (otherMessages.length === 0) {
    watermarks.set(target, pendingWatermark);
    addLog('info', `${targetType}:${target} only bot messages, skipping`, null, target);
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
    // full-lurk: 移除 send_message，只保留观察类工具
    if (pollLurkMode === 'full-lurk') {
      mcpTools = mcpTools.filter(t => t.name !== 'send_message');
    }
  } catch (e) {
    addLog('warn', 'Failed to get MCP tools, proceeding without tools', e.message, target);
  }
  
  // 6.5 合并社交内置工具（social_read / social_write / social_edit）
  const socialBuiltinDefs = getSocialBuiltinToolDefinitions();
  const socialToolsAsMcp = socialBuiltinDefs.map(t => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
    serverName: null, // 无 server 前缀 = 内置工具标识
  }));

  // 6.6 合并群规则内置工具（group_rule_read / group_rule_write / group_rule_edit）
  const groupRuleDefs = getGroupRuleToolDefinitions();
  const groupRuleToolsAsMcp = groupRuleDefs.map(t => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
    serverName: null,
  }));

  mcpTools = [...mcpTools, ...socialToolsAsMcp, ...groupRuleToolsAsMcp];

  // 6.7 合并回复策略工具（仅在 agentCanEditStrategy 开启时注入，full-lurk 下禁用）
  if (promptConfig.agentCanEditStrategy && pollLurkMode !== 'full-lurk') {
    const replyStrategyDefs = getReplyStrategyToolDefinitions();
    const replyStrategyToolsAsMcp = replyStrategyDefs.map(t => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
      serverName: null,
    }));
    mcpTools = [...mcpTools, ...replyStrategyToolsAsMcp];
  }

  // 6.8 合并历史查询工具（history_read / daily_read / daily_list，所有模式均可用）
  const historyDefs = getHistoryToolDefinitions();
  const historyToolsAsMcp = historyDefs.map(t => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
    serverName: null,
  }));
  mcpTools = [...mcpTools, ...historyToolsAsMcp];
  
  // -- Poll data collection for aggregated log entry --
  const pollChatMessages = otherMessages.map(m => ({
    sender: m.sender_name,
    content: (m.content || '').substring(0, 200),
    isAtMe: m.is_at_me,
  }));
  const pollToolCalls = [];
  const pollLlmIters = [];  // every LLM iteration: { content, reasoning, iteration, toolNames }
  const pollSentMessages = []; // content of successful send_message calls
  const emitPollLog = (action) => {
    addLog('poll', `Poll: ${action}`, {
      chatMessages: pollChatMessages,
      llmIters: pollLlmIters,
      sentMessages: pollSentMessages,
      toolCalls: pollToolCalls,
      action,
    }, target);
  };

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
      builtinToolContext: { petId, targetId: target, memoryEnabled: true },
      // 强制覆盖 send_message 的 target/target_type，防止 LLM 用群名代替群号
      toolArgTransform: (name, args) => {
        if (name.includes('send_message')) {
          // 防泄漏：将回复中出现的所有临时安全令牌/分隔符剥离
          let content = args?.content || '';
          for (const sec of Object.values(ephemeral)) {
            content = content.replaceAll(sec, '');
          }
          return { ...args, content, target, target_type: targetType };
        }
        return args;
      },

      onLLMText: (iter) => {
        pollLlmIters.push(iter);
      },
      onToolCall: (name, args) => {
        pollToolCalls.push({ name, args: JSON.stringify(args).substring(0, 300) });
        // 社交记忆写入用特殊 level 标记
        if (name === 'social_write' || name === 'social_edit') {
          addLog('memory', `🧠 社交记忆更新: ${name}`, JSON.stringify(args).substring(0, 300), target);
        } else if (name === 'group_rule_write' || name === 'group_rule_edit') {
          addLog('memory', `📋 群规则更新: ${name}`, JSON.stringify(args).substring(0, 300), target);
        } else if (name === 'reply_strategy_edit') {
          addLog('memory', `📐 回复策略更新: ${name}`, JSON.stringify(args).substring(0, 300), target);
        } else {
          addLog('info', `LLM called tool: ${name}`, JSON.stringify(args).substring(0, 200), target);
        }
        // 暂存 send_message 的 content，等 onToolResult 确认成功后写入缓存
        if (name.includes('send_message')) {
          pendingSendContent = args?.content || '';
        }
      },
      onToolResult: (name, result, _id, isError) => {
        const preview = typeof result === 'string' ? result.substring(0, 100) : JSON.stringify(result).substring(0, 100);
        // Track tool result in poll collector
        if (pollToolCalls.length > 0 && pollToolCalls[pollToolCalls.length - 1].name === name) {
          pollToolCalls[pollToolCalls.length - 1].result = preview;
          pollToolCalls[pollToolCalls.length - 1].isError = isError;
        }
        if ((name === 'social_write' || name === 'social_edit') && !isError) {
          addLog('memory', `✅ 社交记忆已保存`, preview, target);
        } else {
          addLog(isError ? 'error' : 'info', `Tool result: ${name}`, preview, target);
        }
        // 追踪 send_message 是否真正成功（结果中不含 error/失败标记）
        if (name.includes('send_message') && !isError) {
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          if (!resultStr.includes('"success": false') && !resultStr.includes('"success":false')) {
            sendMessageSuccess = true;
            sendCount++;
            // Record sent content for poll log
            if (pendingSendContent) pollSentMessages.push(pendingSendContent);
            
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
              addLog('info', `Cached sent message for ${target}: ${pendingSendContent.substring(0, 50)}...`, null, target);
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
      addLog('warn', `send_message failed, watermark NOT updated for ${target} (will retry next poll)`, null, target);
    }
    
    if (sendMessageSuccess) {
      emitPollLog('replied');
      addLog('info', `✅ Replied to ${targetType}:${target}`, result.content?.substring(0, 100), target);
      return { action: 'replied', detail: result.content };
    } else if (result.toolCallHistory?.some(t => t.name.includes('send_message'))) {
      emitPollLog('send_failed');
      addLog('warn', `⚠️ Tried to reply but send failed for ${targetType}:${target}`, result.content?.substring(0, 100), target);
      return { action: 'send_failed', detail: result.content };
    } else {
      emitPollLog('silent');
      addLog('info', `😶 Silent for ${targetType}:${target}`, result.content?.substring(0, 50), target);
      return { action: 'silent', detail: result.content };
    }
  } catch (e) {
    emitPollLog('error');
    addLog('error', `LLM call failed for ${target}`, e.message, target);
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
        addLog('warn', `Failed to clean buffer for ${target} date ${dateStr}`, e.message, target);
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
 * @param {boolean} config.atMustReply
 * @param {boolean} [config.agentCanEditStrategy]
 * @param {string} config.botQQ
 * @param {Function} [onStatusChange] - 状态变化回调 (active: boolean) => void
 */
export async function startSocialLoop(config, onStatusChange) {
  // 先停止现有循环
  stopSocialLoop();
  
  addLog('info', `Starting social loop for pet: ${config.petId}`);
  
  // 恢复持久化的 lurk modes
  try {
    const savedModes = await loadLurkModes(config.petId);
    if (savedModes && typeof savedModes === 'object') {
      for (const [target, mode] of Object.entries(savedModes)) {
        if (['semi-lurk', 'full-lurk'].includes(mode)) {
          lurkModes.set(target, mode);
        }
      }
      if (lurkModes.size > 0) {
        addLog('info', `Restored lurk modes for ${lurkModes.size} target(s)`);
      }
    }
  } catch (e) {
    addLog('warn', 'Failed to restore lurk modes', e.message);
  }
  
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
    atMustReply: config.atMustReply !== false,
    injectBehaviorGuidelines: config.injectBehaviorGuidelines !== false,
    agentCanEditStrategy: config.agentCanEditStrategy === true,
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
  // 已消费的 @me message_id：每条 @me 只触发一次瞬回，防止旧 @me 反复绕过冷却
  const consumedAtMe = new Map(); // target → Set<message_id>
  // Fetcher → Processor 共享数据缓冲：target → { data: targetData, fetchedAt: number }
  const dataBuffer = new Map();
  // Fetcher 的定时器 ID
  let fetcherTimeoutId = null;
  // 用于区分新旧循环的 generation ID，stopSocialLoop 后立即 start 时防止旧闭包继续调度
  const loopGeneration = Symbol('loopGen');
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

    // 只对未消费的 @me 触发瞬回（同一条 @me 只能触发一次）
    const consumed = consumedAtMe.get(target) || new Set();
    // 清理已滑出窗口的旧 ID，防止 Set 无限增长
    const windowIds = new Set(messages.map(m => m.message_id).filter(Boolean));
    for (const id of consumed) {
      if (!windowIds.has(id)) consumed.delete(id);
    }
    const newAtMeMessages = messages.filter(m => m.is_at_me && !m.is_self && m.message_id && !consumed.has(m.message_id));
    const hasAtMe = newAtMeMessages.length > 0;
    const atMeIds = newAtMeMessages.map(m => m.message_id);

    return { changed, hasAtMe, atMeIds, hash: currentHash, isFirstRun };
  };
  
  // ============ 层1: Fetcher — 定时 batch 拉取，写入 dataBuffer ============

  /**
   * fetcherLoop: 每 BATCH_POLL_INTERVAL_MS 执行一次
   * 职责：batch 拉取所有 target 数据 → 写入 dataBuffer + 处理 compressed_summary append
   * 不做冷却/LLM 决策，不阻塞
   */
  const fetcherLoop = async () => {
    if (!activeLoop || activeLoop._generation !== loopGeneration) return;
    
    const t0 = Date.now();
    const batchToolName = `${config.mcpServerName}__batch_get_recent_context`;
    
    let targetResults = [];
    try {
      const batchArgs = {
        targets: targets.map(t => ({ target: t.target, target_type: t.targetType })),
        limit: dynamicLimit,
      };
      const rawResult = await executeToolByName(batchToolName, batchArgs, { timeout: 10000 });
      targetResults = parseBatchResult(rawResult);
    } catch (e) {
      addLog('error', 'Fetcher: batch poll failed', e.message);
      scheduleFetcher();
      return;
    }
    
    if (targetResults.length === 0) {
      addLog('debug', 'Fetcher: batch poll returned empty results');
      scheduleFetcher();
      return;
    }
    
    // 逐 target 写入 dataBuffer + append compressed_summary
    for (const targetData of targetResults) {
      const target = targetData.target;
      
      // 缓存 target 名称（群名/好友名）
      const name = targetData.group_name || targetData.friend_name;
      if (name && name !== target) {
        targetNamesCache.set(target, name);
      }
      
      // 写入共享缓冲（Processor 会读取）
      dataBuffer.set(target, { data: targetData, fetchedAt: Date.now() });
      
      // 自动 append compressed_summary 增量到每群缓冲文件
      if (targetData.compressed_summary) {
        const prevSummary = lastAppendedSummary.get(target) || '';
        if (targetData.compressed_summary !== prevSummary) {
          let delta = targetData.compressed_summary;
          if (prevSummary && targetData.compressed_summary.startsWith(prevSummary)) {
            delta = targetData.compressed_summary.slice(prevSummary.length).replace(/^\n+/, '');
          }
          if (delta) {
            const bufferPath = `social/GROUP_${target}.md`;
            const timestamp = new Date().toISOString();
            const entry = `\n## ${timestamp}\n${delta}\n`;
            try {
              let existing = '';
              try { existing = await tauri.workspaceRead(config.petId, bufferPath) || ''; } catch { /* 文件不存在 */ }
              await tauri.workspaceWrite(config.petId, bufferPath, existing + entry);
              lastAppendedSummary.set(target, targetData.compressed_summary);
              knownTargets.add(target);
              await persistKnownTargets(config.petId, knownTargets);
            } catch (e) {
              addLog('warn', `Failed to append group buffer for ${target}`, e.message, target);
            }
          }
        }
      }
    }
    
    const elapsed = Date.now() - t0;
    addLog('debug', `Fetcher completed in ${elapsed}ms for ${targetResults.length} targets`);
    
    scheduleFetcher();
  };
  
  const scheduleFetcher = () => {
    if (activeLoop && activeLoop._generation === loopGeneration) {
      fetcherTimeoutId = setTimeout(fetcherLoop, BATCH_POLL_INTERVAL_MS);
    }
  };

  // ============ 层2: Processor — 每个 target 独立循环 ============

  /**
   * processorLoop: 每个 target 独立运行的 async 循环
   * 从 dataBuffer 读取最新数据 → detectChange → 冷却/@me 决策 → pollTarget
   * 各 target 互不阻塞：群A的LLM调用130s不影响群B检测@me
   */
  const processorLoop = async (target, targetType) => {
    const label = `${targetType}:${target}`;
    // 给每个 processor 加点随机延迟，避免同时启动全部 LLM 调用
    await new Promise(r => setTimeout(r, Math.random() * 2000));

    while (activeLoop && activeLoop._generation === loopGeneration) {
      try {
        // 从 dataBuffer 读最新数据
        const buffered = dataBuffer.get(target);
        if (!buffered || !buffered.data) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        const targetData = buffered.data;
        const detection = detectChange(targetData, target);
        
        if (!detection) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        const { changed, hasAtMe, hash, isFirstRun } = detection;
        
        // 首次运行：设水位线，不调 LLM
        if (isFirstRun) {
          watermarks.set(target, { hash });
          addLog('info', `${label} first run, watermark set (skip LLM)`, null, target);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        if (!changed) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        // ── 潜水模式（per-target） ──
        const targetLurkMode = lurkModes.get(target) || 'normal';
        // semi-lurk 的有效模式：@me → normal（正常回复），非 @me → full-lurk（观察学习）
        const effectiveLurkMode = targetLurkMode === 'semi-lurk'
          ? (hasAtMe ? 'normal' : 'full-lurk')
          : targetLurkMode;

        // 决定是否调用 LLM
        const now = Date.now();
        const sinceLastLlm = now - (lastLlmCallTime.get(target) || 0);
        // full-lurk / semi-lurk 观察态: 冷却周期 ×3（降低观察频率）
        const effectiveInterval = effectiveLurkMode === 'full-lurk' ? intervalMs * 3 : intervalMs;
        const cooldownPassed = sinceLastLlm >= effectiveInterval;
        
        if (hasAtMe) {
          // @me → 立即回复（无视冷却），并标记这些 @me 为已消费
          const consumed = consumedAtMe.get(target) || new Set();
          for (const id of detection.atMeIds) consumed.add(id);
          consumedAtMe.set(target, consumed);
          addLog('info', `⚡ @me detected in ${label} (${detection.atMeIds.length} new), triggering instant reply`, null, target);
        } else if (!cooldownPassed) {
          // 有新消息但冷却中 → 等待，不更新水位线，让消息积累
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        // 调用 pollTarget（串行，本 target 同时只有一个 LLM 调用）
        try {
          // 收集当前 target 已消费的所有 @me id，传给 pollTarget 用于消毒
          const allConsumed = consumedAtMe.get(target) || new Set();
          
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
            consumedAtMeIds: allConsumed,
            lurkMode: effectiveLurkMode,
          });
          // 只有成功处理（replied/silent）才记录 LLM 调用时间
          if (result.action === 'replied' || result.action === 'silent') {
            lastLlmCallTime.set(target, Date.now());
          }
        } catch (e) {
          addLog('error', `Unexpected error in processor ${label}`, e.message, target);
        }
        
        // LLM 调用完成后短暂等待再继续下一轮检测
        await new Promise(r => setTimeout(r, 1000));
        
      } catch (e) {
        addLog('error', `Processor ${label} loop error`, e.message, target);
        await new Promise(r => setTimeout(r, 3000)); // 出错后等久一点
      }
    }
    
    addLog('debug', `Processor ${label} stopped`, null, target);
  };
  
  // 设置 activeLoop
  activeLoop = {
    petId: config.petId,
    config,
    _generation: loopGeneration,
    _scheduleCleanup: () => {
      if (fetcherTimeoutId !== null) {
        clearTimeout(fetcherTimeoutId);
        fetcherTimeoutId = null;
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
  
  // 启动层 1: Fetcher 循环（每 1s batch 拉取）
  fetcherLoop();
  
  // 启动层 2: 每个 target 独立的 Processor 循环
  for (const t of targets) {
    processorLoop(t.target, t.targetType); // fire-and-forget, 各跑各的
  }
  
  onStatusChange?.(true);
  addLog('info', 'Social loop started successfully');
  return true;
}

/**
 * 停止社交循环
 */
export function stopSocialLoop() {
  if (activeLoop) {
    // 持久化 lurk modes 在清空之前
    if (lurkModes.size > 0) {
      saveLurkModes(activeLoop.petId, Object.fromEntries(lurkModes));
    }
    activeLoop._scheduleCleanup?.();
    addLog('info', `Stopped social loop for pet: ${activeLoop.petId}`);
    activeLoop = null;
    sentMessagesCache.clear();
    lurkModes.clear();
    targetNamesCache.clear();
  }
}

/**
 * 设置指定 target 的潜水模式
 * @param {string} target - 群号/QQ号
 * @param {'normal'|'semi-lurk'|'full-lurk'} mode
 */
export function setLurkMode(target, mode) {
  if (!target || !['normal', 'semi-lurk', 'full-lurk'].includes(mode)) return;
  const prev = lurkModes.get(target) || 'normal';
  if (mode === 'normal') {
    lurkModes.delete(target);
  } else {
    lurkModes.set(target, mode);
  }
  if (prev !== mode) {
    addLog('info', `Lurk mode [${target}]: ${prev} → ${mode}`, null, target);
    // 持久化
    if (activeLoop?.petId) {
      saveLurkModes(activeLoop.petId, Object.fromEntries(lurkModes));
    }
  }
}

/**
 * 获取指定 target 的潜水模式
 * @param {string} target
 * @returns {'normal'|'semi-lurk'|'full-lurk'}
 */
export function getLurkMode(target) {
  return lurkModes.get(target) || 'normal';
}

/**
 * 获取所有 target 的潜水模式（用于 UI 同步）
 * @returns {Object<string, string>}
 */
export function getLurkModes() {
  return Object.fromEntries(lurkModes);
}

/**
 * 获取 target 名称缓存（群名/好友名）—— 用于 UI 显示
 * @returns {Object<string, string>} { targetId: displayName }
 */
export function getTargetNames() {
  return Object.fromEntries(targetNamesCache);
}

/**
 * 获取当前社交循环状态
 * @returns {{ active: boolean, petId: string|null }}
 */
export function getSocialStatus() {
  return {
    active: activeLoop !== null,
    petId: activeLoop?.petId || null,
    lurkModes: Object.fromEntries(lurkModes),
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
  setLurkMode,
  getLurkMode,
  getLurkModes,
  getTargetNames,
};
