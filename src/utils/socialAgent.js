/**
 * socialAgent.js — 后台自主社交循环引擎
 * 
 * 定时通过 MCP 获取群聊/私聊消息，用 LLM 自主决策是否回复。
 * 每次调用 LLM 都是独立的单轮请求，不累积上下文。
 */

import { buildSocialPrompt, buildIntentSystemPrompt } from './socialPromptBuilder';
import { executeToolByName, getMcpTools, resolveImageUrls } from './mcp/toolExecutor';
import { callLLMWithTools } from './mcp/toolExecutor';
import { getSocialBuiltinToolDefinitions, getGroupRuleToolDefinitions, getReplyStrategyToolDefinitions, getHistoryToolDefinitions, getGroupLogToolDefinitions } from './workspace/socialToolExecutor';
import * as tauri from './tauri';

// ============ 状态 ============

/** 当前活跃的社交循环（同一时间只有一个） */
let activeLoop = null;

/** 每个 target 的潜水模式 Map<target, 'normal'|'semi-lurk'|'full-lurk'> */
const lurkModes = new Map();

/** 每个 target 的暂停状态 Map<target, boolean> —— 暂停后 Observer 和 Reply 均跳过 */
const pausedTargets = new Map();

/** target 名称缓存 Map<target, string> —— 从 MCP 批量拉取中自动填充 */
const targetNamesCache = new Map();

/** 系统日志（无 target，最多 200 条） */
const systemLogs = [];
/** 每目标日志 Map<target, Array>（每个 target 最多 200 条） */
const targetLogs = new Map();
const MAX_LOGS = 200;
let _logIdCounter = 0;

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
    id: _logIdCounter++,
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
  // Incremental push to all windows (SocialPage lives in a different webview)
  tauri.emitToAll('social-log-entry', entry);

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
        ...msg._images.flatMap(img => {
          let url;
          if (img.data.startsWith('http://') || img.data.startsWith('https://')) {
            url = img.data;
          } else if (img.data.startsWith('data:')) {
            url = img.data;
          } else {
            url = `data:${img.mimeType};base64,${img.data}`;
          }
          return [
            { type: 'text', text: '（如果是梗图/表情包，理解情绪即可，不需要刻意回应每张图）' },
            { type: 'image_url', image_url: { url, mime_type: img.mimeType || 'image/jpeg' } },
          ];
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
 * @param {Map} params.watermarks - 水位线 Map (target -> lastSeenMessageId)
 * @param {Map} params.sentCache - 本地发送消息缓存 (target -> Array)
 * @param {Array} params.bufferMessages - 从累积 buffer 传入的全部消息
 * @param {string|null} params.compressedSummary - MCP 侧的压缩摘要
 * @param {string} params.groupName - 群名/好友名
 * @param {Set<string>} [params.consumedAtMeIds] - 已消费的 @me message_id 集合
 * @param {'normal'|'semi-lurk'|'full-lurk'} [params.lurkMode='normal'] - 潜水模式
 * @param {'observer'|'reply'} [params.role='reply'] - 角色
 * @param {Array} [params.intentHistory=[]] - 该群意图滚动窗口
 * @param {boolean} [params.intentSleeping=false] - 该群 intent 是否处于休眠状态
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
  bufferMessages = [],
  compressedSummary: compSummary = null,
  groupName: gName = null,
  consumedAtMeIds,
  lurkMode: pollLurkMode = 'normal',
  role = 'reply',
  intentHistory: pollIntentHistory = [],
  intentSleeping: pollIntentSleeping = false,
}) {
  const groupName = gName || target;
  const compressedSummary = compSummary;
  
  // ── 0. 快照水位线：记录 LLM 开始前 buffer 的最后一条消息 ID ──
  // 防止 LLM 异步调用期间 fetcherLoop 追加新消息导致水位线跳过未处理的消息
  const snapshotWatermarkId = bufferMessages.length > 0
    ? bufferMessages[bufferMessages.length - 1]?.message_id
    : null;

  // ── 1. 构建 individualMessages：复制 buffer 消息 ──
  let individualMessages = bufferMessages.map(msg => ({
    ...msg,
    _images: msg._images || (msg.image_urls || []).map(url => ({ data: url, mimeType: 'image/jpeg' })),
  }));
  
  if (individualMessages.length === 0) {
    return { action: 'skipped', detail: 'no messages in buffer' };
  }
  
  // ── 2. 标注旧/新消息 ──
  // 找到当前水位线位置
  const lastSeenId = watermarks.get(target);
  let wmIdx = -1; // 水位线消息的 index，-1 表示没有水位线（全部为新）
  if (lastSeenId) {
    for (let i = individualMessages.length - 1; i >= 0; i--) {
      if (individualMessages[i].message_id === lastSeenId) { wmIdx = i; break; }
    }
  }
  // _isOld 标记已移除：LLM 看到统一的对话历史，不区分新旧
  
  // ── 3. 解析图片 URL 为 base64 ──
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
  
  // ── 4. 注入本地发送缓存中的 bot 消息 ──
  const cachedSent = sentCache.get(target) || [];
  if (cachedSent.length > 0) {
    const existingIds = new Set(
      individualMessages.filter(m => m.is_self && m.message_id).map(m => m.message_id)
    );
    const oldest = individualMessages.length > 0 ? individualMessages[0].timestamp : null;
    
    let injected = 0;
    for (const cached of cachedSent) {
      if (cached.message_id && existingIds.has(cached.message_id)) continue;
      if (oldest && cached.timestamp < oldest) continue;
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
      individualMessages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      addLog('info', `Injected ${injected} cached bot message(s) for ${target}`, null, target);
    }
    if (oldest) {
      const kept = cachedSent.filter(c => c.timestamp >= oldest);
      if (kept.length !== cachedSent.length) sentCache.set(target, kept);
    }
  }
  
  // ── 5. 统计 ──
  const otherMessages = individualMessages.filter(m => !m.is_self);
  const newMessages = individualMessages;
  const oldMessages = [];
  
  if (otherMessages.length === 0) {
    // 推进水位线
    const lastMsg = individualMessages[individualMessages.length - 1];
    if (lastMsg?.message_id) watermarks.set(target, lastMsg.message_id);
    addLog('info', `${targetType}:${target} only bot messages, skipping`, null, target);
    return { action: 'skipped', detail: 'only bot messages' };
  }
  
  // 生成本轮临时安全令牌（每次 poll 都不同，用完即弃）
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
    agentCanEditStrategy: promptConfig.agentCanEditStrategy === true,
    lurkMode: pollLurkMode,
    role,
    intentHistory: pollIntentHistory,
    intentSleeping: pollIntentSleeping,
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
  
  // ── 防复读：根据末尾 turn 类型注入不同提示 ──
  const lastTurn = historyTurns.length > 0 ? historyTurns[historyTurns.length - 1] : null;
  if (lastTurn && lastTurn.role === 'assistant') {
    // 位置 A：在 bot 最后的 assistant turn 内容上追加醒目标记
    const selfWarning = '\n[⚠️ 这是你自己的回复。如果你还有没说完的话可以继续，但如果观点已经表达完整就不要重复了。]';
    if (typeof lastTurn.content === 'string') {
      lastTurn.content += selfWarning;
    } else if (Array.isArray(lastTurn.content)) {
      // 多模态数组：找最后一个 text part 追加
      for (let i = lastTurn.content.length - 1; i >= 0; i--) {
        if (lastTurn.content[i].type === 'text') {
          lastTurn.content[i].text += selfWarning;
          break;
        }
      }
    }
    // 位置 B（末尾=assistant）：提示注意复读，但允许补充未说完的内容
    historyTurns.push({ role: 'user', content: '（以上对话的最后几条是你自己的发言，之后没有新的群友消息。请判断：1. 如果你还有想说但没说完的内容，可以继续补充。 2. 但如果你的观点已经表达完整，或者想说的话和上面重复，请回答"[沉默]：<理由>"。⚠️ 提醒：想发消息必须调用 send_message 工具，直接输出纯文本群友看不到。不想回复请回答"[沉默]：<理由>"。需要回复请使用 send_message 工具，且只能调用一次。）' });
  }
  // 末尾=user 时不额外注入 prompt，群友消息本身就是最好的回复信号

  // ── Reply 模式：在最后一条 user 消息底部注入当前想法（来自 Intent Loop） ──
  if (role === 'reply') {
    const hist = pollIntentHistory || [];
    const latestIntent = hist.filter(e => !e.idle).slice(-1)[0] || hist.slice(-1)[0];

    let intentBlock = '\n\n---\n# 你的当前想法\n';
    if (latestIntent) {
      const wTag = latestIntent.willingnessLabel ? ` ${latestIntent.willingnessLabel}` : '';
      intentBlock += `${latestIntent.content}${wTag}\n`;
      if (pollIntentSleeping) {
        intentBlock += '（群里已经安静了一段时间，以上是你之前的想法，可能需要更新）';
      } else if (latestIntent.idle) {
        intentBlock += '以上是你最近的想法。你当时对这个话题兴趣不高，但情况可能已经变化了。';
      } else {
        intentBlock += '以上是你对当前对话的想法和行为倾向，自然体现在回复风格和话题选择中。不要直接说出这些想法。';
      }
    } else {
      intentBlock += '（意图模块尚未产出评估，请根据聊天内容自行判断。）';
    }
    intentBlock += '\n---';
    intentBlock += '\n⚠️ 回复前请回顾上方 assistant 消息（你之前说过的话）。如果你想表达的观点已经出现过，且没有人针对你的发言追问或回应，请选择沉默。但如果有群友回应或追问了你刚才说的话，回答他们是对话的延续，不是重复——即使话题相同，你也应该回应。';

    // 找到最后一条 user turn 并追加
    for (let i = historyTurns.length - 1; i >= 0; i--) {
      if (historyTurns[i].role === 'user') {
        if (typeof historyTurns[i].content === 'string') {
          historyTurns[i].content += intentBlock;
        } else if (Array.isArray(historyTurns[i].content)) {
          historyTurns[i].content.push({ type: 'text', text: intentBlock });
        }
        break;
      }
    }
  }
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyTurns,
  ];
  
  // 6. 获取 MCP 工具（基于 role 分配不同工具集）
  let mcpTools = [];

  if (role === 'observer') {
    // ── Observer: 只有 builtin 工具（group_rule RW, social RW, reply_strategy RW, history），无 send_message，无外部 MCP ──
    const toMcp = (defs) => defs.map(t => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
      serverName: null,
    }));
    mcpTools = [
      ...toMcp(getSocialBuiltinToolDefinitions()),
      ...toMcp(getGroupRuleToolDefinitions()),
      ...toMcp(getHistoryToolDefinitions()),
    ];
    // Observer 也可以管理回复策略（如果开启）
    if (promptConfig.agentCanEditStrategy) {
      mcpTools = [...mcpTools, ...toMcp(getReplyStrategyToolDefinitions())];
    }
  } else {
    // ── Reply: send_message + 外部 MCP + history 工具，无 builtin 读写 ──
    try {
      const allTools = await getMcpTools();
      const extraServers = new Set(promptConfig.enabledMcpServers || []);
      mcpTools = allTools.filter(t => 
        (t.serverName === mcpServerName && t.name === 'send_message') ||
        (extraServers.has(t.serverName) && t.serverName !== mcpServerName)
      );
    } catch (e) {
      addLog('warn', 'Failed to get MCP tools, proceeding without tools', e.message, target);
    }
    // Reply 有 history 只读工具 + 跨群日志工具
    const historyDefs = [...getHistoryToolDefinitions(), ...getGroupLogToolDefinitions()];
    const historyToolsAsMcp = historyDefs.map(t => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
      serverName: null,
    }));
    mcpTools = [...mcpTools, ...historyToolsAsMcp];
  }
  
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
      inputPrompt: messages,
      llmIters: pollLlmIters,
      sentMessages: pollSentMessages,
      toolCalls: pollToolCalls,
      action,
      role,
    }, target);
  };

  // 7. 调用 LLM（非流式，带工具循环）
  addLog('info', `🤖 ${role === 'observer' ? 'Observer' : 'Reply'} LLM starting for ${target} (turns=${messages.length}, hasAtMe=${individualMessages.some(m => m.is_at_me)})`, null, target);
  let sendMessageSuccess = false;
  let sendCount = 0;
  let pendingSendContent = null; // 暂存 send_message 的 content 参数
  let _messagesForLLM = messages;
  for (let _imgRetry = 0; _imgRetry < 2; _imgRetry++) {
  try {
    const result = await callLLMWithTools({
      messages: _messagesForLLM,
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
          // num_chunks 防护：LLM 忘传时默认 1（不拆分）
          const num_chunks = args?.num_chunks ?? 1;
          return { ...args, content, num_chunks, target, target_type: targetType };
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
    
    // 只有 LLM 调用成功完成后才推进水位线
    // 使用开头快照的 snapshotWatermarkId，而非 bufferMessages 当前末尾
    // 因为 LLM 异步调用期间 fetcherLoop 可能已追加新消息到 bufferMessages
    // 快照确保水位线精确到 LLM 实际看到的最后一条消息
    const newWatermarkId = snapshotWatermarkId;
    if (sendMessageSuccess || !result.toolCallHistory?.some(t => t.name.includes('send_message'))) {
      if (newWatermarkId) watermarks.set(target, newWatermarkId);
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
      // LLM 没调 send_message — 检查是否想说话但忘了用工具
      const text = (result.content || '').trim();
      const isTrueSilent = !text || text === '[沉默]' || text.includes('[沉默]');
      
      if (!isTrueSilent && text.length > 2 && role !== 'observer') {
        // LLM 输出了实际内容但没调 send_message → 补发（先句内去重）
        // 句内去重：按中英文标点拆句，去掉连续重复段
        const dedup = (s) => {
          // 按句末标点拆分，保留分隔符
          const parts = s.split(/(?<=[。！？!?\n])\s*/).filter(p => p.trim());
          if (parts.length <= 1) {
            // 无标点 → 尝试按空格拆分（处理 "X X" 模式）
            const words = s.split(/\s+/).filter(w => w);
            if (words.length >= 2) {
              const half = Math.ceil(words.length / 2);
              const first = words.slice(0, half).join(' ');
              const second = words.slice(half).join(' ');
              if (first === second) return first;
            }
            return s;
          }
          const out = [parts[0]];
          for (let i = 1; i < parts.length; i++) {
            if (parts[i].trim() !== parts[i - 1].trim()) out.push(parts[i]);
          }
          return out.join('');
        };
        const cleanText = dedup(text);
        if (cleanText !== text) {
          addLog('info', `🔁 Auto-send dedup: "${text.substring(0, 60)}" → "${cleanText.substring(0, 60)}"`, null, target);
        }
        try {
          const sendToolName = `${mcpServerName}__send_message`;
          await executeToolByName(sendToolName, { content: cleanText, target, target_type: targetType, num_chunks: 1 }, { timeout: 10000 });
          sendMessageSuccess = true;
          if (newWatermarkId) watermarks.set(target, newWatermarkId);
          // 缓存发送记录
          const arr = sentCache.get(target) || [];
          arr.push({ content: cleanText, timestamp: new Date().toISOString() });
          sentCache.set(target, arr);
          emitPollLog('replied');
          addLog('info', `✅ Auto-sent for ${targetType}:${target} (LLM forgot tool): ${cleanText.substring(0, 80)}`, null, target);
          return { action: 'replied', detail: cleanText };
        } catch (e) {
          addLog('warn', `Auto-send fallback failed for ${target}: ${e.message}`, null, target);
        }
      }
      
      emitPollLog('silent');
      addLog('info', `😶 Silent for ${targetType}:${target}`, result.content?.substring(0, 50), target);
      return { action: 'silent', detail: result.content };
    }
  } catch (e) {
    // Plan B: 带图片的 LLM 调用失败 → 剥离图片后重试一次
    if (_imgRetry === 0 && totalImageCount > 0) {
      addLog('warn', `LLM failed with ${totalImageCount} image(s), retrying without images for ${target}`, e.message || e, target);
      _messagesForLLM = messages.map(msg => {
        if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg;
        if (!msg.content.some(p => p.type === 'image_url')) return msg;
        const texts = msg.content.filter(p => p.type === 'text' && !p.text.includes('梗图/表情包'));
        return { ...msg, content: (texts.map(p => p.text).join('\n') + '\n[图片]').trim() };
      });
      continue;
    }
    emitPollLog('error');
    addLog('error', `LLM call failed for ${target}`, e._debugBody || (e.message || e), target);
    return { action: 'error', detail: e.message || e };
  }
  } // end for _imgRetry
}

// ============ 社交记忆辅助 ============

const COMPRESS_META_PATH = 'social/compress_meta.json';
const KNOWN_TARGETS_PATH = 'social/targets.json';

/**
 * 持久化已知 target 列表（含群名）
 */
async function persistKnownTargets(petId, targetSet) {
  try {
    const data = [...targetSet].map(id => ({ id, name: targetNamesCache.get(id) || null }));
    await tauri.workspaceWrite(petId, KNOWN_TARGETS_PATH, JSON.stringify(data));
  } catch (e) {
    console.warn('[Social] Failed to persist known targets', e);
  }
}

/**
 * 加载已知 target 列表（兼容旧格式 [id, ...] 和新格式 [{id, name}, ...]）
 */
async function loadKnownTargets(petId) {
  try {
    const raw = await tauri.workspaceRead(petId, KNOWN_TARGETS_PATH);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    const ids = new Set();
    for (const item of arr) {
      if (typeof item === 'string') {
        ids.add(item); // 旧格式
      } else if (item && item.id) {
        ids.add(item.id);
        if (item.name) targetNamesCache.set(item.id, item.name);
      }
    }
    return ids;
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
 * @param {number} [config.replyInterval] - Reply 冷却秒数（0=无冷却）
 * @param {number} [config.observerInterval] - Observer 冷却秒数
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
  
  addLog('info', `Watching ${targets.length} targets, reply: ${config.replyInterval ?? 0}s, observer: ${config.observerInterval || 180}s`);
  
  const promptConfig = {
    socialPersonaPrompt: config.socialPersonaPrompt || '',
    atMustReply: config.atMustReply !== false,
    agentCanEditStrategy: config.agentCanEditStrategy === true,
    botQQ: config.botQQ || '',
    ownerQQ: config.ownerQQ || '',
    ownerName: config.ownerName || '',
    enabledMcpServers: config.enabledMcpServers || [],
  };
  
  const replyIntervalMs = (config.replyInterval ?? 0) * 1000;
  const observerIntervalMs = (config.observerInterval || 180) * 1000;
  const BATCH_POLL_INTERVAL_MS = 1000; // 始终 1s 拉取
  const dynamicLimit = 10; // 固定每次拉取 10 条
  
  // per-target 上次 LLM 调用时间（冷却计时）
  const lastObserveTime = new Map();   // Observer 线程冷却
  const lastReplyTime = new Map();     // Reply 线程冷却（replyIntervalMs > 0 时使用）
  // 独立水位线（message_id based）
  // watermark = lastSeenMessageId，标记上次处理到哪条消息
  const observerWatermarks = new Map(); // target → lastSeenMessageId
  const replyWatermarks = new Map();    // target → lastSeenMessageId
  // 已知 target 列表（用于每日压缩时遍历群缓冲文件）
  const knownTargets = new Set();
  // 上次 append 到群缓冲的 compressed_summary（用于去重，避免累积摘要重复写入）
  const lastAppendedSummary = new Map();
  // 已消费的 @me message_id：每条 @me 只触发一次瞬回，防止旧 @me 反复绕过冷却
  const consumedAtMe = new Map(); // target → Set<message_id>
  // Fetcher → Processor 共享数据缓冲：target → MessageBuffer
  // MessageBuffer 按 message_id 去重累积消息，不覆盖
  const dataBuffer = new Map(); // target → { messages: [], metadata: {}, compressedSummary, seenIds: Set }
  const BUFFER_HARD_CAP = 500; // 安全阀：单 target 最大缓存消息数
  const BUFFER_COMPRESS_THRESHOLD = 30; // 旧消息超过此数触发 compress
  const fetcherFirstSeen = new Set(); // 已完成首次 fetch 的 target（用于跳过历史 @me）
  // Intent ↔ Reply 互斥锁：同一 target 同时只能有一个在跑 LLM
  const processorBusy = new Map(); // target → 'intent' | 'reply' | null
  // Fetcher 的定时器 ID
  let fetcherTimeoutId = null;
  // 用于区分新旧循环的 generation ID，stopSocialLoop 后立即 start 时防止旧闭包继续调度
  const loopGeneration = Symbol('loopGen');
  let dailyCompressTimeoutId = null; // 每日压缩定时器
  
  // ============ 层4: Intent Loop 状态（每群独立） ============
  const intentMap = new Map();                // target → IntentState { history, sleeping, lastActivityTime, lastEvalTime, loopTimeoutId }
  const INTENT_HISTORY_MAX = 10;              // 每群滚动窗口长度

  // ── 回复意愿五档解析 ──
  const WILLINGNESS_TAGS = [
    { level: 1, key: '不想理' },
    { level: 2, key: '无感' },
    { level: 2, key: '等回复' },
    { level: 3, key: '有点想说' },
    { level: 4, key: '想聊' },
    { level: 5, key: '忍不住' },
  ];
  const WILLINGNESS_RE = /\[(不想理|无感|等回复|有点想说|想聊|忍不住)[：:][^\]]*\]/;
  const WILLINGNESS_RE_LOOSE = /(不想理|无感|等回复|有点想说|想聊|忍不住)[：:]([^\n]*)/;
  const parseWillingness = (rawText) => {
    // 严格匹配：[tag：reason]（带方括号）
    const m = rawText.match(WILLINGNESS_RE);
    if (m) {
      const key = m[1];
      const tag = WILLINGNESS_TAGS.find(t => t.key === key);
      const thought = rawText.replace(WILLINGNESS_RE, '').trim();
      return { level: tag ? tag.level : 0, label: m[0], thought };
    }
    // 容错匹配：tag：reason（无方括号，LLM 偶尔会省略括号）
    const mLoose = rawText.match(WILLINGNESS_RE_LOOSE);
    if (mLoose) {
      const key = mLoose[1];
      const tag = WILLINGNESS_TAGS.find(t => t.key === key);
      const reason = (mLoose[2] || '').trim();
      const label = `[${key}：${reason}]`;
      const thought = rawText.substring(0, mLoose.index).trim();
      return { level: tag ? tag.level : 0, label, thought };
    }
    return { level: 0, label: '', thought: rawText.trim() };
  };
  const INTENT_EVAL_COOLDOWN_MS = 60 * 1000;  // 非 normal 模式的评估冷却
  const INTENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟无新消息 → 最终评估 → sleep（保留历史）
  const INTENT_LLM_MAX_RETRIES = 2;             // LLM 调用失败后最多重试 2 次（共 3 次尝试），每次间隔 30s
  const intentWatermarks = new Map();            // target → lastProcessedMessageId（用于 normal 模式新消息检测）
  const intentGate = new Map();                  // target → lock timestamp（Reply 发完消息后锁住，等 Intent 重评后解锁）
  const INTENT_GATE_TIMEOUT_MS = 30 * 1000;      // 门控安全超时：30s 后自动解锁
  const replyWakeFlag = new Map();                // target → true（Intent 评出 ≥3 时置位，Reply 消费后清除）

  /** 获取/创建某群的 IntentState */
  const getIntentState = (target) => {
    if (!intentMap.has(target)) {
      intentMap.set(target, {
        history: [],
        sleeping: true,
        lastActivityTime: 0, // 最近一条新消息（含 self）的时间
        lastEvalTime: 0,
        loopTimeoutId: null,
        _wake: null,          // 可中断 sleep 的 resolve 回调
        forceEval: false,     // Reply 发完消息后强制立即评估（跳过 detectChange）
        urgentAtMe: false,    // Fetcher 检测到 @me 时置位，Intent 优先处理
      });
    }
    return intentMap.get(target);
  };

  /** 可中断的延迟（用于 intentLoop，支持 forceWakeIntent 立即唤醒） */
  const sleepInterruptible = (state, ms) => new Promise(r => {
    state._wake = r;
    state.loopTimeoutId = setTimeout(r, ms);
  });

  /** 强制唤醒指定 target 的 intentLoop 并立即评估 */
  const forceWakeIntent = (target) => {
    const state = getIntentState(target);
    state.sleeping = false;
    state.forceEval = true;
    state.lastActivityTime = Date.now();
    clearTimeout(state.loopTimeoutId);
    if (state._wake) { state._wake(); state._wake = null; }
  };
  
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
   * 获取 target 的消息缓冲区（不存在则创建）
   */
  const getBuffer = (target) => {
    if (!dataBuffer.has(target)) {
      dataBuffer.set(target, { messages: [], metadata: {}, compressedSummary: null, seenIds: new Set() });
    }
    return dataBuffer.get(target);
  };

  /**
   * 向 target 缓冲区追加消息（按 message_id 去重）
   * @returns {number} 实际新增的消息数
   */
  const appendToBuffer = (target, newMessages, metadata) => {
    const buf = getBuffer(target);
    // 更新元数据（总是用最新的）
    buf.metadata = metadata || buf.metadata;
    buf.compressedSummary = metadata?.compressed_summary ?? buf.compressedSummary;
    
    let added = 0;
    for (const msg of newMessages) {
      const id = msg.message_id;
      if (id && buf.seenIds.has(id)) continue; // 去重
      if (id) buf.seenIds.add(id);
      buf.messages.push(msg);
      added++;
    }
    
    // 安全阀：超过硬上限时丢弃最旧的
    if (buf.messages.length > BUFFER_HARD_CAP) {
      const excess = buf.messages.length - BUFFER_HARD_CAP;
      const removed = buf.messages.splice(0, excess);
      for (const m of removed) {
        if (m.message_id) buf.seenIds.delete(m.message_id);
      }
    }
    
    // seenIds 安全阀：防止无限增长（只保留当前 messages 中存在的 ID）
    if (buf.seenIds.size > BUFFER_HARD_CAP * 3) {
      const activeIds = new Set(buf.messages.map(m => m.message_id).filter(Boolean));
      buf.seenIds = activeIds;
    }
    
    return added;
  };

  /**
   * 清理 target 缓冲区中水位线之前的旧消息（compress 完成后调用）
   * 保留最新 BUFFER_COMPRESS_THRESHOLD 条 + 水位线之后的所有消息
   */
  const trimBufferOldMessages = (target) => {
    const buf = dataBuffer.get(target);
    if (!buf) return;
    
    // 取两个水位线中较早的那个（保守清理）
    const obsWm = observerWatermarks.get(target);
    const repWm = replyWatermarks.get(target);
    
    // 找到较早水位线的位置
    let earlierWmIdx = -1;
    if (obsWm || repWm) {
      for (let i = 0; i < buf.messages.length; i++) {
        if (buf.messages[i].message_id === obsWm || buf.messages[i].message_id === repWm) {
          if (earlierWmIdx === -1 || i < earlierWmIdx) earlierWmIdx = i;
        }
      }
    }
    
    // 水位线之前的消息数
    const oldCount = earlierWmIdx >= 0 ? earlierWmIdx : 0;
    if (oldCount <= BUFFER_COMPRESS_THRESHOLD) return; // 旧消息不多，不需要清理
    
    // 删除超出 threshold 的旧消息
    const trimCount = oldCount - BUFFER_COMPRESS_THRESHOLD;
    const removed = buf.messages.splice(0, trimCount);
    for (const m of removed) {
      if (m.message_id) buf.seenIds.delete(m.message_id);
    }
    addLog('info', `Trimmed ${removed.length} old messages from buffer for ${target}`, null, target);
  };

  /**
   * 对单个 target 的缓冲区做变化检测（基于 message_id 水位线）
   * @param {string} target
   * @param {Map} wmMap - 使用的水位线 Map（observerWatermarks 或 replyWatermarks）
   * 返回 { changed, hasAtMe, atMeIds, newCount, isFirstRun } 或 null 表示跳过
   */
  const detectChange = (target, wmMap = replyWatermarks) => {
    const buf = dataBuffer.get(target);
    if (!buf || buf.messages.length === 0) return null;
    
    const messages = buf.messages;
    const lastMsgId = wmMap.get(target); // string | undefined
    const isFirstRun = lastMsgId === undefined;
    
    // 找到水位线位置
    let wmIdx = -1;
    if (lastMsgId) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].message_id === lastMsgId) { wmIdx = i; break; }
      }
    }
    
    // 水位线之后的新消息（包括 bot 自己的消息，一视同仁）
    const newMessages = wmIdx >= 0 ? messages.slice(wmIdx + 1) : (isFirstRun ? messages : messages);
    const changed = newMessages.length > 0;
    
    // @me 检测（只看新消息中未消费的）
    const consumed = consumedAtMe.get(target) || new Set();
    // 清理已不在 buffer 中的旧 consumed ID
    const bufferIds = new Set(messages.map(m => m.message_id).filter(Boolean));
    for (const id of consumed) {
      if (!bufferIds.has(id)) consumed.delete(id);
    }
    const newAtMeMessages = newMessages.filter(m => m.is_at_me && !m.is_self && m.message_id && !consumed.has(m.message_id));
    const hasAtMe = newAtMeMessages.length > 0;
    const atMeIds = newAtMeMessages.map(m => m.message_id);

    return { changed, hasAtMe, atMeIds, newCount: newMessages.length, isFirstRun };
  };
  
  // ============ 层4: Intent Loop — 每群独立意图循环 ============

  /**
   * 从 dataBuffer 获取单个 target 的最近消息，构建与 Reply 完全一致的多轮消息数组。
   * 返回 { turns: [{role, content}], ephemeral: {ownerSecret, nameL, nameR, msgL, msgR} }
   */
  const buildIntentTurns = (target) => {
    const MAX_MSGS = 30;
    const buf = dataBuffer.get(target);
    if (!buf || buf.messages.length === 0) return { turns: [], ephemeral: null };
    // Intent 不需要图片（只评估意愿），剥离图片避免因图片导致 LLM 500 错误
    const recent = buf.messages.slice(-MAX_MSGS).map(m => ({ ...m, _images: [] }));
    // 生成本轮临时安全令牌（每次评估都不同）
    const _rnd = () => crypto.randomUUID().slice(0, 6);
    const eph = {
      ownerSecret: _rnd(),
      nameL: `«${_rnd()}»`,
      nameR: `«/${_rnd()}»`,
      msgL:  `‹${_rnd()}›`,
      msgR:  `‹/${_rnd()}›`,
    };
    const turns = buildTurnsFromMessages(recent, {
      sanitizeAtMe: false,
      ownerQQ: promptConfig.ownerQQ,
      ownerName: promptConfig.ownerName,
      ownerSecret: eph.ownerSecret,
      nameL: eph.nameL,
      nameR: eph.nameR,
      msgL: eph.msgL,
      msgR: eph.msgR,
    });
    return { turns, ephemeral: eph };
  };

  /**
   * intentLoop: 每群独立的意图循环
   * 
   * 生命周期：
   *   sleeping → (新消息到达) → awake → 每 1min 评估 → LLM 输出 idle 或 3min 无新消息 → sleep（保留历史）
   *
   * @param {string} target - 群号/好友号
   */
  const intentLoop = async (target) => {
    const state = getIntentState(target);
    const tName = () => targetNamesCache.get(target) || target;

    while (activeLoop && activeLoop._generation === loopGeneration) {
      try {
        // ── 睡眠中 → 每 5s 检查 ──
        if (state.sleeping) {
          await sleepInterruptible(state, 5000);
          continue;
        }

        const now = Date.now();

        // ── 3 分钟无新消息 → 最终评估 → sleep（保留历史） ──
        if (now - state.lastActivityTime >= INTENT_IDLE_TIMEOUT_MS) {
          // 互斥：等待 Reply 完成
          if (processorBusy.get(target) === 'reply') {
            if (!state._waitingForReply) {
              state._waitingForReply = true;
              addLog('intent', `🧠 [${tName()}] waiting for Reply to finish`, null, target);
            }
            await sleepInterruptible(state, 500);
            continue;
          }
          state._waitingForReply = false;
          processorBusy.set(target, 'intent');

          // 做最后一次 LLM 评估（带重试）
          const intentModel = config.intentModelName || llmConfig.modelName;
          addLog('intent', `🧠 [${tName()}] idle-eval starting (model=${intentModel})`, null, target);

          // 构建只读工具集（与 Reply 相同的 history + groupLog）
          const intentToolDefs = [...getHistoryToolDefinitions(), ...getGroupLogToolDefinitions()];
          const intentMcpTools = intentToolDefs.map(t => ({
            name: t.function.name,
            description: t.function.description,
            inputSchema: t.function.parameters,
            serverName: null,
          }));

          let intentResult;
          for (let attempt = 0; ; attempt++) {
            // 每次尝试都重新构建 prompt（拉取最新 buffer，覆盖重试期间到达的新消息）
            const { turns: intentTurns, ephemeral: eph } = buildIntentTurns(target);
            const sinceMin = state.lastEvalTime > 0
              ? Math.round((Date.now() - state.lastEvalTime) / 60000) : 0;
            const targetLurkMode = lurkModes.get(target) || 'normal';
            const intentPrompt = await buildIntentSystemPrompt({
              petId: config.petId,
              targetName: tName(),
              targetId: target,
              intentHistory: state.history,
              sinceLastEvalMin: sinceMin,
              socialPersonaPrompt: promptConfig.socialPersonaPrompt,
              botQQ: promptConfig.botQQ,
              ownerQQ: promptConfig.ownerQQ,
              ownerName: promptConfig.ownerName,
              ownerSecret: eph?.ownerSecret || '',
              nameDelimiterL: eph?.nameL || '',
              nameDelimiterR: eph?.nameR || '',
              msgDelimiterL: eph?.msgL || '',
              msgDelimiterR: eph?.msgR || '',
              lurkMode: targetLurkMode,
            });

            try {
              const raw = await callLLMWithTools({
                messages: [
                  { role: 'system', content: intentPrompt },
                  ...intentTurns,
                  { role: 'user', content: '请分析当前想法和行为倾向。' },
                ],
                apiFormat: llmConfig.apiFormat,
                apiKey: llmConfig.apiKey,
                model: intentModel,
                baseUrl: llmConfig.baseUrl,
                mcpTools: intentMcpTools,
                options: {
                  temperature: 0.4,
                },
                builtinToolContext: { petId: config.petId, targetId: target, memoryEnabled: false },
                onToolCall: (name, args) => {
                  addLog('intent', `🧠 [${tName()}] tool: ${name}`, JSON.stringify(args).substring(0, 200), target);
                },
              });
              intentResult = { content: raw.content, error: null };
              break;
            } catch (e) {
              if (attempt < INTENT_LLM_MAX_RETRIES) {
                addLog('intent', `🧠 [${tName()}] idle-eval LLM error (retry ${attempt + 1}/${INTENT_LLM_MAX_RETRIES} in 2s): ${e.message || e}`, e._debugBody || null, target);
                await sleepInterruptible(state, 2000);
                continue;
              }
              intentResult = { content: e.message || e, error: true };
            }
          }

          // 解析纯文本结果并记入历史（不清空）
          if (!intentResult.error) {
            const rawText = (intentResult.content || '').trim();
            const w = parseWillingness(rawText);
            const isIdle = !rawText || w.level <= 2;
            const entry = {
              timestamp: new Date().toISOString(),
              idle: isIdle,
              willingness: w.level,
              willingnessLabel: w.label,
              content: w.thought || (isIdle ? '(无内容)' : ''),
            };
            state.history.push(entry);
            if (state.history.length > INTENT_HISTORY_MAX) state.history.shift();
            addLog('intent', `🧠 [${tName()}] → sleeping ${w.label}`, entry.content, target);
          } else {
            addLog('intent', `🧠 [${tName()}] → sleeping (LLM error)`, null, target);
          }

          // 解锁 Intent 门控
          intentGate.delete(target);

          // 推进 intent 水位线到最新
          const bufBeforeSleep = dataBuffer.get(target);
          if (bufBeforeSleep && bufBeforeSleep.messages.length > 0) {
            const lm = bufBeforeSleep.messages[bufBeforeSleep.messages.length - 1];
            if (lm?.message_id) intentWatermarks.set(target, lm.message_id);
          }

          state.sleeping = true;
          processorBusy.delete(target);
          continue;
        }

        // ── 模式感知的评估触发 ──
        const intentLurkMode = lurkModes.get(target) || 'normal';
        const wasForceEval = state.forceEval;
        const wasUrgentAtMe = state.urgentAtMe;
        if (state.urgentAtMe) {
          // Fetcher 检测到 @me → 跳过一切冷却，立即评估
          state.urgentAtMe = false;
          state.forceEval = false;
          addLog('intent', `🧠 [${tName()}] urgent-eval: @me detected`, null, target);
        } else if (state.forceEval) {
          // Reply 刚发完消息，跳过 detectChange 直接评估
          state.forceEval = false;
          addLog('intent', `🧠 [${tName()}] force-eval after Reply`, null, target);
        } else if (intentLurkMode === 'normal') {
          // normal 模式：有新消息才评估（和 Reply 一样逐条触发），但保底每 60s 评估一次
          const intentDetection = detectChange(target, intentWatermarks);
          const sinceLastEval = state.lastEvalTime > 0 ? now - state.lastEvalTime : Infinity;
          const hasNewMessages = intentDetection && intentDetection.changed;
          const guaranteedInterval = sinceLastEval >= INTENT_EVAL_COOLDOWN_MS; // 60s 保底

          if (!hasNewMessages && !guaranteedInterval) {
            await sleepInterruptible(state, 500);
            continue;
          }
          // 首次运行只设水位线，不立即评估
          if (intentDetection && intentDetection.isFirstRun) {
            const buf = dataBuffer.get(target);
            const lastMsg = buf?.messages?.[buf.messages.length - 1];
            if (lastMsg?.message_id) intentWatermarks.set(target, lastMsg.message_id);
            await sleepInterruptible(state, 500);
            continue;
          }
        } else {
          // semi-lurk / full-lurk 模式：保持 1 分钟冷却
          if (state.lastEvalTime > 0 && now - state.lastEvalTime < INTENT_EVAL_COOLDOWN_MS) {
            const waitMs = INTENT_EVAL_COOLDOWN_MS - (now - state.lastEvalTime) + 1000;
            await sleepInterruptible(state, Math.min(waitMs, 10000));
            continue;
          }
        }

        // ── 互斥：等待 Reply 完成 ──
        if (processorBusy.get(target) === 'reply') {
          if (!state._waitingForReply) {
            state._waitingForReply = true;
            addLog('intent', `🧠 [${tName()}] waiting for Reply to finish`, null, target);
          }
          await sleepInterruptible(state, 500);
          continue;
        }
        state._waitingForReply = false;
        processorBusy.set(target, 'intent');

        // ── 常规意图评估（带重试） ──
        const intentModel = config.intentModelName || llmConfig.modelName;
        addLog('intent', `🧠 [${tName()}] eval starting (model=${intentModel})`, null, target);
        state.lastEvalTime = Date.now(); // 冷却从 eval 开始计时（start-to-start）

        // 构建只读工具集（与 Reply 相同的 history + groupLog）
        const intentToolDefs = [...getHistoryToolDefinitions(), ...getGroupLogToolDefinitions()];
        const intentMcpTools = intentToolDefs.map(t => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
          serverName: null,
        }));

        const intentEvalPrompt = wasUrgentAtMe
          ? '有群友 @了你，请立即评估当前状态。注意：被 @ 通常意味着有人在跟你说话或提问，应优先考虑回复。同时仍需遵守「别三连」规则。'
          : wasForceEval
            ? '你的 Reply 模块刚刚发了消息（可能尚未出现在对话记录中）。请重新评估当前状态。你刚发了言，除非有人直接回应你（追问、反驳、@你），否则必须选 [等回复]。同时检查「别三连」规则：如果你已经连续发言 ≥ 2 次且没人回应你，无论如何不得选 ≥ 3 的意愿。'
            : '请分析当前想法和行为倾向。';

        let intentResult;
        for (let attempt = 0; ; attempt++) {
          // 每次尝试都重新构建 prompt（拉取最新 buffer，覆盖重试期间到达的新消息）
          const { turns: intentTurns, ephemeral: eph } = buildIntentTurns(target);
          const sinceMin = state.lastEvalTime > 0
            ? Math.round((Date.now() - state.lastEvalTime) / 60000) : 0;
          const targetLurkMode = lurkModes.get(target) || 'normal';
          const intentPrompt = await buildIntentSystemPrompt({
            petId: config.petId,
            targetName: tName(),
            targetId: target,
            intentHistory: state.history,
            sinceLastEvalMin: sinceMin,
            socialPersonaPrompt: promptConfig.socialPersonaPrompt,
            botQQ: promptConfig.botQQ,
            ownerQQ: promptConfig.ownerQQ,
            ownerName: promptConfig.ownerName,
            ownerSecret: eph?.ownerSecret || '',
            nameDelimiterL: eph?.nameL || '',
            nameDelimiterR: eph?.nameR || '',
            msgDelimiterL: eph?.msgL || '',
            msgDelimiterR: eph?.msgR || '',
            lurkMode: targetLurkMode,
          });

          try {
            const raw = await callLLMWithTools({
              messages: [
                { role: 'system', content: intentPrompt },
                ...intentTurns,
                { role: 'user', content: intentEvalPrompt },
              ],
              apiFormat: llmConfig.apiFormat,
              apiKey: llmConfig.apiKey,
              model: intentModel,
              baseUrl: llmConfig.baseUrl,
              mcpTools: intentMcpTools,
              options: {
                temperature: 0.4,
              },
              builtinToolContext: { petId: config.petId, targetId: target, memoryEnabled: false },
              onToolCall: (name, args) => {
                addLog('intent', `🧠 [${tName()}] tool: ${name}`, JSON.stringify(args).substring(0, 200), target);
              },
            });
            intentResult = { content: raw.content, error: null };
            break;
          } catch (e) {
            if (attempt < INTENT_LLM_MAX_RETRIES) {
              addLog('intent', `🧠 [${tName()}] eval LLM error (retry ${attempt + 1}/${INTENT_LLM_MAX_RETRIES} in 2s): ${e.message || e}`, e._debugBody || null, target);
              await sleepInterruptible(state, 2000);
              continue;
            }
            intentResult = { content: e.message || e, error: true };
          }
        }

        if (intentResult.error) {
          addLog('intent', `Intent LLM error [${tName()}]: ${intentResult.content}`, null, target);
          intentGate.delete(target); // 解锁门控（即使出错也要解锁，避免死锁）
          processorBusy.delete(target);
          await sleepInterruptible(state, 2000);
          continue;
        }

        // ── 解析纯文本输出（五档回复意愿） ──
        const rawText = (intentResult.content || '').trim();
        const w = parseWillingness(rawText);
        const isIdle = !rawText || w.level <= 2;
        const entry = {
          timestamp: new Date().toISOString(),
          idle: isIdle,
          willingness: w.level,
          willingnessLabel: w.label,
          content: w.thought || (isIdle ? '(无内容)' : ''),
        };

        state.history.push(entry);
        if (state.history.length > INTENT_HISTORY_MAX) state.history.shift();

        // 解锁 Intent 门控（Reply 可以重新发言了）
        if (intentGate.has(target)) {
          intentGate.delete(target);
          addLog('intent', `🔓 [${tName()}] intent gate unlocked`, null, target);
        }

        // 更新 intent 水位线到 buffer 最新消息
        const bufAfterEval = dataBuffer.get(target);
        if (bufAfterEval && bufAfterEval.messages.length > 0) {
          const lastMsgAfterEval = bufAfterEval.messages[bufAfterEval.messages.length - 1];
          if (lastMsgAfterEval?.message_id) intentWatermarks.set(target, lastMsgAfterEval.message_id);
        }

        // Intent 评出 ≥ 3（有点想说/想聊/忍不住）时，通知 Reply 可以主动触发（即使没有新消息）
        if (w.level >= 3 && !intentGate.has(target)) {
          replyWakeFlag.set(target, true);
        }

        if (isIdle) {
          addLog('intent', `🧠 [${tName()}] → idle ${w.label}`, entry.content, target);
        } else {
          addLog('intent', `🧠 [${tName()}] ${w.label}`, entry.content, target);
        }

        // idle 不 sleep，保持 awake 继续监听新消息；只有 5min 无新消息的 idle timeout 才真正进入 sleep
        processorBusy.delete(target);
        await sleepInterruptible(state, 500);
      } catch (e) {
        addLog('intent', `Intent loop error [${tName()}]`, e.message || e, target);
        processorBusy.delete(target);
        await sleepInterruptible(state, 2000);
      }
    }
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
    
    // 逐 target 去重累积到 dataBuffer + append compressed_summary
    for (const targetData of targetResults) {
      try {
      const target = targetData.target;
      
      // 缓存 target 名称（群名/好友名）
      const name = targetData.group_name || targetData.friend_name;
      if (name && name !== target) {
        targetNamesCache.set(target, name);
      }
      
      // 去重累积写入共享缓冲（Observer/Reply 会读取）
      const fetchedMessages = (targetData.messages || []).map(msg => ({
        ...msg,
        _images: (msg.image_urls || []).map(url => ({ data: url, mimeType: 'image/jpeg' })),
      }));
      const added = appendToBuffer(target, fetchedMessages, targetData);

      // --- Intent Loop 唤醒：有新消息（含 self）→ 唤醒该群 ---
      if (added > 0) {
        const iState = getIntentState(target);
        iState.lastActivityTime = Date.now();
        if (iState.sleeping) {
          iState.sleeping = false;
        }

        // --- @me 检测：有新的未消费 @me → 标记紧急 + 强制唤醒 Intent + 立即消费 ---
        const consumed = consumedAtMe.get(target) || new Set();
        if (!fetcherFirstSeen.has(target)) {
          // 首次 fetch：将初始批次中所有 @me 标记为已消费，不触发 urgentAtMe（历史数据忽略）
          fetcherFirstSeen.add(target);
          let seeded = 0;
          for (const m of fetchedMessages) {
            if (m.is_at_me && !m.is_self && m.message_id) { consumed.add(m.message_id); seeded++; }
          }
          if (seeded > 0) {
            consumedAtMe.set(target, consumed);
            addLog('info', `Fetcher ${target}: first fetch, seeded ${seeded} historical @me IDs (ignored)`, null, target);
          }
        } else {
          const newAtMeMsgs = fetchedMessages.filter(m => m.is_at_me && !m.is_self && m.message_id && !consumed.has(m.message_id));
          if (newAtMeMsgs.length > 0) {
            // 立即消费这些 @me ID，防止下次 poll 重复触发
            for (const m of newAtMeMsgs) consumed.add(m.message_id);
            consumedAtMe.set(target, consumed);
            iState.urgentAtMe = true;
            forceWakeIntent(target);
            addLog('info', `📩 Fetcher ${target}: @me detected (${newAtMeMsgs.length}), urgent-waking Intent`, null, target);
          }
        }
      }
      
      // --- compressed_summary 更新后触发旧消息清理 ---
      // 当 MCP 侧 compressed_summary 变化说明 compress 已完成，可以安全清理 buffer 中的旧消息
      const buf = getBuffer(target);
      const prevSummary = lastAppendedSummary.get(target) || '';
      if (targetData.compressed_summary && targetData.compressed_summary !== prevSummary) {
        // compressed_summary 更新了 → 对应的旧消息已被 MCP 压缩 → 清理 buffer
        trimBufferOldMessages(target);
      }
      
      // 自动 append compressed_summary 增量到每群缓冲文件
      if (targetData.compressed_summary && targetData.compressed_summary !== prevSummary) {
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
      } catch (e) {
        addLog('error', `Fetcher: error processing target ${targetData?.target}`, e.message || e, targetData?.target);
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

  // ============ 层2: Observer — 每个 target 独立观察循环 ============

  /**
   * observerLoop: 每个 target 独立运行的观察循环
   * 所有模式都运行（normal/semi-lurk/full-lurk）
   * 冷却周期：observerIntervalMs（默认 180s，用户可配置）
   * 职责：记录群档案（group_rule/social_memory），不发消息
   */
  const observerLoop = async (target, targetType) => {
    const label = `${targetType}:${target}`;
    // 随机延迟，避免同时启动
    await new Promise(r => setTimeout(r, Math.random() * 3000 + 1000));

    let llmRunning = false;   // 本 target observer 的 LLM 是否正在执行
    let consecutiveErrors = 0;  // 连续错误计数（用于退避）

    while (activeLoop && activeLoop._generation === loopGeneration) {
      try {
        // ── 暂停检查 ──
        if (pausedTargets.get(target)) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        const buf = dataBuffer.get(target);
        if (!buf || buf.messages.length === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        // Observer 使用独立水位线
        const detection = detectChange(target, observerWatermarks);
        
        if (!detection) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        const { changed, isFirstRun } = detection;
        
        if (isFirstRun) {
          // 首次：设水位线为 buffer 最后一条消息
          const lastMsg = buf.messages[buf.messages.length - 1];
          if (lastMsg?.message_id) observerWatermarks.set(target, lastMsg.message_id);
          addLog('info', `${label} observer first run, watermark set`, null, target);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        if (!changed) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        // ── LLM 正在执行 → 跳过本轮 ──
        if (llmRunning) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        // Observer 冷却（连续错误时指数退避：180s, 360s, 720s... 上限 300s 额外）
        const now = Date.now();
        const errorBackoff = consecutiveErrors > 0 ? Math.min(consecutiveErrors * observerIntervalMs, 300000) : 0;
        const effectiveCooldown = observerIntervalMs + errorBackoff;
        const sinceLastObserve = now - (lastObserveTime.get(target) || 0);
        if (sinceLastObserve < effectiveCooldown) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        // ── 异步启动 LLM（不阻塞检测循环） ──
        llmRunning = true;
        const snapshotBuf = dataBuffer.get(target);
        
        pollTarget({
          target,
          targetType,
          mcpServerName: config.mcpServerName,
          llmConfig,
          petId: config.petId,
          promptConfig,
          watermarks: observerWatermarks,
          sentCache: sentMessagesCache,
          bufferMessages: snapshotBuf ? snapshotBuf.messages : buf.messages,
          compressedSummary: snapshotBuf ? snapshotBuf.compressedSummary : buf.compressedSummary,
          groupName: (snapshotBuf || buf).metadata?.group_name || (snapshotBuf || buf).metadata?.friend_name || target,
          consumedAtMeIds: new Set(), // Observer 不消费 @me
          lurkMode: 'full-lurk',      // Observer 始终使用观察模式
          role: 'observer',
          intentHistory: getIntentState(target).history,
          intentSleeping: getIntentState(target).sleeping,
        }).then(result => {
          // 无论成功失败都更新冷却时间，防止错误时 2s 重试风暴
          lastObserveTime.set(target, Date.now());
          if (result.action === 'error') {
            consecutiveErrors++;
            addLog('warn', `Observer ${label} LLM error (consecutive: ${consecutiveErrors}, next cooldown: ${Math.round((observerIntervalMs + Math.min(consecutiveErrors * observerIntervalMs, 300000)) / 1000)}s)`, result.detail, target);
          } else {
            consecutiveErrors = 0; // 成功后重置
            // Observer 处理完后触发 compress（如果旧消息超过阈值）
            const currentBuf = dataBuffer.get(target);
            if (currentBuf) {
              const obsWmId = observerWatermarks.get(target);
              const repWmId = replyWatermarks.get(target);
              let earlierWmIdx = -1;
              for (let i = 0; i < currentBuf.messages.length; i++) {
                if (currentBuf.messages[i].message_id === obsWmId || currentBuf.messages[i].message_id === repWmId) {
                  if (earlierWmIdx === -1 || i < earlierWmIdx) earlierWmIdx = i;
                }
              }
              const oldCount = earlierWmIdx >= 0 ? earlierWmIdx : 0;
              if (oldCount > BUFFER_COMPRESS_THRESHOLD) {
                const compressToolName = `${config.mcpServerName}__compress_context`;
                const tt = targetType || 'group';
                executeToolByName(compressToolName, { target, target_type: tt }, { timeout: 15000 })
                  .then(() => addLog('info', `compress_context triggered for ${target} (${oldCount} old msgs > ${BUFFER_COMPRESS_THRESHOLD})`, null, target))
                  .catch(e => addLog('warn', `compress_context failed for ${target}`, e.message, target));
              }
            }
          }
        }).catch(e => {
          lastObserveTime.set(target, Date.now());
          consecutiveErrors++;
          addLog('error', `Observer ${label} error (consecutive: ${consecutiveErrors})`, e.message || e, target);
        }).finally(() => {
          llmRunning = false;
        });
        
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        addLog('error', `Observer ${label} loop error`, e.message || e, target);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    addLog('debug', `Observer ${label} stopped`, null, target);
  };

  // ============ 层3: Reply — 每个 target 独立回复循环 ============

  /**
   * replyLoop: 每个 target 独立运行的回复循环
   * 模式控制：normal → 正常回复，semi-lurk → 仅 @me，full-lurk → 不运行
   * 冷却周期：replyIntervalMs（默认 0，用户可配置）
   * 职责：决定是否回复 + send_message，不写 group_rule/social_memory
   */
  const replyLoop = async (target, targetType) => {
    const label = `${targetType}:${target}`;
    await new Promise(r => setTimeout(r, Math.random() * 2000));

    let llmRunning = false;        // 本 target 的 LLM 是否正在执行
    let lastLoggedNewCount = 0;    // 上次日志记录的新消息条数（去重用）
    let waitingForIntent = false;  // 日志去重：等待 Intent 完成

    while (activeLoop && activeLoop._generation === loopGeneration) {
      try {
        // ── 暂停检查 ──
        if (pausedTargets.get(target)) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        const buf = dataBuffer.get(target);
        if (!buf || buf.messages.length === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        // ── 检测变化（每 1s 无论 LLM 是否运行都执行） ──
        const detection = detectChange(target, replyWatermarks);
        
        if (!detection) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        const { changed, hasAtMe, isFirstRun, newCount } = detection;
        
        // ── 检测日志：仅当新消息条数变化时记录 ──
        if (changed && newCount > 0 && newCount !== lastLoggedNewCount) {
          addLog('info', `📨 Reply ${label}: +${newCount} new messages${hasAtMe ? ' (has @me)' : ''}${llmRunning ? ' [LLM busy]' : ''}`, null, target);
          lastLoggedNewCount = newCount;
        }
        
        if (isFirstRun) {
          // 检查 buffer 中是否有未消费的 @me
          const consumed = consumedAtMe.get(target) || new Set();
          const pendingAtMe = buf.messages.some(m => m.is_at_me && !m.is_self && m.message_id && !consumed.has(m.message_id));
          
          if (pendingAtMe) {
            // 有 @me → 消费 + 唤醒 Intent 让它评估
            const pendingAtMeMsgs = buf.messages.filter(m => m.is_at_me && !m.is_self && m.message_id && !consumed.has(m.message_id));
            for (const m of pendingAtMeMsgs) consumed.add(m.message_id);
            consumedAtMe.set(target, consumed);
            const iState = getIntentState(target);
            iState.urgentAtMe = true;
            forceWakeIntent(target);
            addLog('info', `${label} reply first run, has pending @me (${pendingAtMeMsgs.length}) — waking Intent`, null, target);
          }
          // 无论有无 @me，首次运行都设水位线，等 Intent 评估后通过 replyWakeFlag 触发
          const lastMsg = buf.messages[buf.messages.length - 1];
          if (lastMsg?.message_id) replyWatermarks.set(target, lastMsg.message_id);
          addLog('info', `${label} reply first run, watermark set`, null, target);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        // ── Intent 唯一触发：Reply 只在 Intent 信号或 @me 时运行，不再因“有新消息”就跑 ──
        const intentWoke = replyWakeFlag.get(target);
        if (!intentWoke) {
          // 无 Intent 信号 → 推进水位线但不触发 Reply
          if (changed) {
            const lastMsg = buf.messages[buf.messages.length - 1];
            if (lastMsg?.message_id) replyWatermarks.set(target, lastMsg.message_id);
          }
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        replyWakeFlag.delete(target);
        addLog('info', `🔔 Reply ${label}: triggered by Intent (willingness ≥ 3)`, null, target);
        
        // ── LLM 正在执行 → 等待完成 ──
        if (llmRunning) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // ── 互斥：等待 Intent 完成 ──
        if (processorBusy.get(target) === 'intent') {
          if (!waitingForIntent) {
            waitingForIntent = true;
            addLog('info', `⏳ Reply ${label}: waiting for Intent to finish`, null, target);
          }
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        waitingForIntent = false;
        
        // ── 潜水模式决定是否跳过回复 ──
        const targetLurkMode = lurkModes.get(target) || 'normal';
        if (targetLurkMode === 'full-lurk') {
          // full-lurk：Reply 不运行，只推进水位线到最新
          const lastMsg = buf.messages[buf.messages.length - 1];
          if (lastMsg?.message_id) replyWatermarks.set(target, lastMsg.message_id);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        // semi-lurk 且没有 @me → 跳过回复，推进水位线
        if (targetLurkMode === 'semi-lurk' && !hasAtMe) {
          const lastMsg = buf.messages[buf.messages.length - 1];
          if (lastMsg?.message_id) replyWatermarks.set(target, lastMsg.message_id);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        // ── Intent 门控：Reply 发完消息后等 Intent 重新评估才能再次发言 ──
        const gateLockTime = intentGate.get(target);
        if (gateLockTime) {
          if (Date.now() - gateLockTime < INTENT_GATE_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          // 安全超时 — 自动解锁
          intentGate.delete(target);
          addLog('warn', `🔓 Reply ${label}: intent gate timeout-unlocked (${INTENT_GATE_TIMEOUT_MS / 1000}s)`, null, target);
        }

        // Reply 冷却（replyIntervalMs，默认 0 = 无冷却）
        if (replyIntervalMs > 0) {
          const now = Date.now();
          const sinceLastReply = now - (lastReplyTime.get(target) || 0);
          if (sinceLastReply < replyIntervalMs) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
        }
        
        // 标记 @me 为已消费（统一流程，不再特殊处理）
        if (hasAtMe) {
          const consumed = consumedAtMe.get(target) || new Set();
          for (const id of detection.atMeIds) consumed.add(id);
          consumedAtMe.set(target, consumed);
        }
        
        // ── 启动 LLM（单轮，不再自主 catchup，新消息交还 Intent 决策） ──
        llmRunning = true;
        lastLoggedNewCount = 0;
        processorBusy.set(target, 'reply');

        const runReplyLLM = async () => {
          try {
            const allConsumed = consumedAtMe.get(target) || new Set();
            const snapshotBuf = dataBuffer.get(target);

            const result = await pollTarget({
              target,
              targetType,
              mcpServerName: config.mcpServerName,
              llmConfig,
              petId: config.petId,
              promptConfig,
              watermarks: replyWatermarks,
              sentCache: sentMessagesCache,
              bufferMessages: snapshotBuf ? snapshotBuf.messages : buf.messages,
              compressedSummary: snapshotBuf ? snapshotBuf.compressedSummary : buf.compressedSummary,
              groupName: (snapshotBuf || buf).metadata?.group_name || (snapshotBuf || buf).metadata?.friend_name || target,
              consumedAtMeIds: allConsumed,
              lurkMode: 'normal',
              role: 'reply',
              intentHistory: getIntentState(target).history,
              intentSleeping: getIntentState(target).sleeping,
            });

            if (replyIntervalMs > 0) lastReplyTime.set(target, Date.now());
            if (result && result.action === 'replied') {
              // 锁定门控 + 立即唤醒 Intent 重新评估
              intentGate.set(target, Date.now());
              addLog('info', `🔒 Reply ${label}: gate locked, waking Intent`, null, target);
              forceWakeIntent(target);
            }
          } catch (e) {
            addLog('error', `Reply ${label} LLM error`, e.message || e, target);
          } finally {
            llmRunning = false;
            lastLoggedNewCount = 0;
            processorBusy.delete(target);
          }
        };

        // 不 await — 异步执行，检测循环继续运行（但 llmRunning 会阻止重复启动）
        runReplyLLM();
        
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        addLog('error', `Reply ${label} loop error`, e.message || e, target);
        // 安全清理：防止崩溃后 processorBusy/llmRunning 卡死导致 Intent 死锁
        llmRunning = false;
        processorBusy.delete(target);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    addLog('debug', `Reply ${label} stopped`, null, target);
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
      for (const [, iState] of intentMap) {
        if (iState.loopTimeoutId !== null) {
          clearTimeout(iState.loopTimeoutId);
          iState.loopTimeoutId = null;
        }
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
  
  // 启动层 2: 每个 target 独立的 Observer 循环（记录群档案）
  for (const t of targets) {
    observerLoop(t.target, t.targetType); // fire-and-forget
  }
  
  // 启动层 3: 每个 target 独立的 Reply 循环（决定回复）
  for (const t of targets) {
    replyLoop(t.target, t.targetType); // fire-and-forget
  }
  
  // 启动层 4: 每个 target 独立的 Intent Loop（意图分析）
  for (const t of targets) {
    getIntentState(t.target); // 预注册
    intentLoop(t.target); // fire-and-forget
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
    pausedTargets.clear();
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
 * 设置指定 target 的暂停状态
 * @param {string} target - 群号/QQ号
 * @param {boolean} paused
 */
export function setTargetPaused(target, paused) {
  if (!target) return;
  const prev = pausedTargets.get(target) || false;
  if (paused) {
    pausedTargets.set(target, true);
  } else {
    pausedTargets.delete(target);
  }
  if (prev !== !!paused) {
    addLog('info', `Target [${target}] ${paused ? '⏸️ paused' : '▶️ resumed'}`, null, target);
  }
}

/**
 * 获取所有 target 的暂停状态
 * @returns {Object<string, boolean>}
 */
export function getPausedTargets() {
  return Object.fromEntries(pausedTargets);
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
    pausedTargets: Object.fromEntries(pausedTargets),
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
  setTargetPaused,
  getPausedTargets,
  getTargetNames,
};
