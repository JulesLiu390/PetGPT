/**
 * socialAgent.js — 后台自主社交循环引擎
 * 
 * 定时通过 MCP 获取群聊/私聊消息，用 LLM 自主决策是否回复。
 * 每次调用 LLM 都是独立的单轮请求，不累积上下文。
 */

import { buildSocialPrompt } from './socialPromptBuilder';
import { writeIntentTrace } from './intentTraining';
import { buildCacheKey, shouldUseExplicitCache, formatUsageLogMessage } from './promptCache';
import { socialTargetDir } from './socialTargetType.js';
import { seedToolDocs } from './toolDocs';
import { executeToolByName, getMcpTools, resolveImageUrls } from './mcp/toolExecutor';
import { callLLMWithTools } from './mcp/toolExecutor';
import { getSocialFileToolDefinitions, getHistoryToolDefinitions, getGroupLogToolDefinitions, getStickerToolDefinitions, getBufferSearchToolDefinitions, getSubagentToolDefinition, getCcHistoryToolDefinition, getCcReadToolDefinition, getMdOrganizeToolDefinition, getScreenshotToolDefinition, getImageSendToolDefinition, getImageListToolDefinition, getWebshotToolDefinition, getWebshotSendToolDefinition, getChatSearchToolDefinition, getChatContextToolDefinition, getVoiceSendToolDefinition, getGenerateImageSendToolDefinition } from './workspace/socialToolExecutor';
import { getTurnNoteToolDefinition, getCheckNewMessagesToolDefinition } from './workspace/socialToolExecutor';
import {
  createSession, beginTurn, endTurn, appendHistory, canInject, recordInjection,
  recordSend, sessionStats, REGISTER_SILENT,
  shouldRemindBacklog, markBacklogReminded, BACKLOG_REMINDER_AT,
} from './social/sessionState.js';
import { prepareRequestItems, estimateTokens, COMPACT_THRESHOLD_TOKENS } from './social/compaction.js';
import { recycleSessionImages } from './social/contextTrim.js';
import { toProviderTurns, ensureUserLast, prependToLastUser, classifyRoundOutput, renderTurnNote, formatSelfMessage, SYSTEM_RECORD } from './social/sessionTurn.js';
import { tagBatch, renderMoodTag, MOOD_TAG_TIMEOUT_MS } from './social/moodTag.js';
import { createMoodTagStore } from './social/moodTagStore.js';
import { readBarometer, renderBarometer, BAROMETER_WINDOW } from './social/barometer.js';
import { createCursor, messagesAfter, advanceCursor, sortByTime, isCursorUnset } from './social/messageCursor.js';
import { subagentRegistry, initSubagentListeners, destroySubagentListeners, killBySource, reapSubagentRegistry } from './subagentManager';
import { startKeepAwake, stopKeepAwake } from './keepAwake.js';
import { normalizeTargetIds } from './social/targetId.js';
import { normalizeSplitTags, stripSplitTagsForSpeech } from './social/outgoingText.js';
import { resolveTts, hasVisibleVoiceGuide, isVoiceGuideResult } from './social/voiceScript.ts';
import { applyIncomingEdit } from './social/messageEdits.js';
import { callLLM } from './llm/index.js';
import * as tauri from './tauri';

// ============ 状态 ============

// 社交里的 CC 子 Agent（dispatch_subagent、cc_history/cc_read、md 整理）已下线，配置里的开关不再生效。
const SUBAGENTS_ENABLED = false;

/** 当前活跃的社交循环（同一时间只有一个） */
let activeLoop = null;

/**
 * 单调递增的 runtime generation。start/stop 都会推进它，因此即使 stop 发生在
 * startSocialLoop 的异步初始化阶段，旧启动流程和旧 LLM 闭包也会立即失效。
 */
let socialLoopGeneration = 0;
let startingPetId = null;

/** 每个 target 的潜水模式 Map<target, 'normal'|'semi-lurk'|'full-lurk'> */
const lurkModes = new Map();

/** 每个 target 的暂停状态 Map<target, boolean> —— 暂停后 Observer 和 Reply 均跳过 */
const pausedTargets = new Map();

/** 每个 target 的用户自定义规则 Map<target, string> —— 运行时可热更新 */
const customGroupRulesMap = new Map();

/** Intent eval 内部的消息注入水位线 Map<target, lastMessageId> —— 单次 eval 内生效，防止重复注入 */
const intentInjectionWatermarks = new Map();
/** Intent eval 内部的拦截次数 Map<target, count> —— 上限 5，防死循环 */
const intentInterceptCounts = new Map();

/** 已知的所有 target Set<string> —— 用于持久化时保存 enabled 状态（false）而不只是 paused（true） */
const knownTargets = new Set();

/** target 名称缓存 Map<target, string> —— 从 MCP 批量拉取中自动填充 */
const targetNamesCache = new Map();

/** 图片描述缓存 Map<messageId_imageIndex, string> —— 避免重复调用 vision LLM */
const imageDescCache = new Map();

/**
 * 图片描述缓存容量上限。
 *
 * 缓存只服务于「同一张图在 Intent/Observer/Reply 之间复用」，命中窗口就是 buffer
 * 的存活期（BUFFER_HARD_CAP 500 条/target × 若干 target）。超过这个量级的旧条目
 * 再也不会被查到，只会一直占内存 —— 挂机几天下来是纯增长。
 */
const IMAGE_DESC_CACHE_MAX = 2000;

/** 读缓存并刷新 LRU 顺序（Map 迭代序即插入序，重新 set 等于挪到队尾） */
function getCachedImageDesc(cacheKey) {
  if (!imageDescCache.has(cacheKey)) return undefined;
  const value = imageDescCache.get(cacheKey);
  imageDescCache.delete(cacheKey);
  imageDescCache.set(cacheKey, value);
  return value;
}

/** 写缓存并按容量淘汰最久未使用的条目 */
function setCachedImageDesc(cacheKey, value) {
  if (imageDescCache.has(cacheKey)) imageDescCache.delete(cacheKey);
  imageDescCache.set(cacheKey, value);
  while (imageDescCache.size > IMAGE_DESC_CACHE_MAX) {
    const oldest = imageDescCache.keys().next();
    if (oldest.done) break;
    imageDescCache.delete(oldest.value);
  }
}

/** 图片描述进行中 Map<cacheKey, Promise<string>> —— Observer/Reply 并发去重 */
const imageDescInflight = new Map();

/** target → boolean; opt-in whitelist for training data collection */
const trainingTargetsMap = new Map();

/** Global training collection enabled flag — updated by event so running loop sees it */
let _currentTrainingCollectionEnabled = false;

/** Unlisten callback for the social-set-training-enabled event (one active loop at a time) */
let _unlistenTraining = null;

/** Unlisten callback for the social-set-training-collection-enabled event (global toggle) */
let _unlistenTrainingGlobal = null;

/** LLM 调用指数重试 delays: 5s → 25s → 125s */
const LLM_RETRY_DELAYS = [5000, 25000, 125000];

/**
 * Vision（图片描述）单次调用硬超时。
 * 后端已有超时，这里再加一层前端兜底：Vision 是唯一被 Intent 关键路径 await 的
 * LLM 调用，一次永久挂起就会让整个 target 再也不评估、不发言。
 */
const VISION_CALL_TIMEOUT_MS = 90 * 1000;
/** Vision 重试 delays —— 比通用 LLM 短：图片描述可以降级成 [图片描述失败]，不值得占住调用方 */
const VISION_RETRY_DELAYS = [5000, 25000];
/**
 * Intent eval 前的图片预处理总预算。超过就不再等——本轮直接带原图/无描述进 eval，
 * 未完成的描述继续在后台跑并落进 imageDescCache，下一轮 eval 直接命中。
 */
const VISION_PREPROCESS_BUDGET_MS = 120 * 1000;

/**
 * 给任意 Promise 加硬超时。
 * 底层 Promise 无法真正取消（JS 限制），但调用方的 await 一定会在 ms 内返回，
 * 不会被永不 settle 的 Promise 永久钉死。
 */
function withHardTimeout(promise, ms, label = 'Operation') {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} 硬超时（${Math.round(ms / 1000)}s）`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

/**
 * MCP/内置工具的失败形状并不统一：有的 reject，有的 resolve
 * `{ error }` / `{ isError: true }` / `{ success: false }`，还有的把 JSON
 * 包在 content[0].text 中。发送类动作必须统一按失败处理。
 */
function isToolResultFailure(result, isError = false) {
  if (isError || result == null) return true;
  const inspect = (value, depth = 0) => {
    if (depth > 3 || value == null) return false;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return false;
      try {
        return inspect(JSON.parse(text), depth + 1);
      } catch {
        return /(^|\W)(error|failed|failure)(\W|$)/i.test(text)
          && !/(no errors?|without errors?)/i.test(text);
      }
    }
    if (Array.isArray(value)) return value.some(item => inspect(item, depth + 1));
    if (typeof value !== 'object') return false;
    if (value.isError === true || value.success === false || value.ok === false) return true;
    if (value.error != null && value.error !== false && value.error !== '') return true;
    if (Array.isArray(value.content) && value.content.some(item => inspect(item?.text ?? item, depth + 1))) {
      return true;
    }
    return false;
  };
  return inspect(result);
}

function canonicalSocialPath(value) {
  const segments = String(value || '').replace(/\\/g, '/').split('/');
  const canonical = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    canonical.push(segment.toLowerCase());
  }
  return canonical.join('/');
}

const INTENT_READ_ONLY_EXTERNAL_TOOL_BASE_NAMES = new Set([
  'tavily_search',
  'search',
  'fetch',
  'read',
  'get',
  'list',
  'query',
  'lookup',
]);

/**
 * Intent 只允许显式只读的外部 MCP 工具。
 *
 * 优先信任 MCP 标准 annotations.readOnlyHint；对于尚未提供 annotations 的
 * 老服务器，仅兼容一组完整 base-name allowlist。名称判断是精确匹配，
 * 不使用 includes，未知工具一律 fail-closed。
 */
export function isReadOnlyIntentExternalTool(tool) {
  if (!tool || typeof tool !== 'object') return false;
  if (tool.annotations?.readOnlyHint === true) return true;
  if (tool.annotations?.readOnlyHint === false) return false;

  const rawName = typeof tool.name === 'string' ? tool.name.trim().toLowerCase() : '';
  if (!rawName) return false;
  const separatorIndex = rawName.lastIndexOf('__');
  const baseName = separatorIndex >= 0 ? rawName.slice(separatorIndex + 2) : rawName;
  return INTENT_READ_ONLY_EXTERNAL_TOOL_BASE_NAMES.has(baseName);
}

/**
 * 带指数重试的 LLM 调用包装器
 * @param {Function} fn - 返回 Promise 的 LLM 调用函数
 * @param {Object} [opts] - 选项
 * @param {string} [opts.label='LLM'] - 日志标签
 * @param {string} [opts.target] - 日志 target
 * @param {number[]} [opts.delays] - 重试延迟数组（默认 5s/25s/125s）
 * @returns {Promise<*>} LLM 调用结果
 */
async function retryLLM(fn, { label = 'LLM', target = undefined, delays = LLM_RETRY_DELAYS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < delays.length) {
        const delay = delays[attempt];
        const reason = (e.message || String(e)).substring(0, 120);
        addLog('warn', `${label} retry ${attempt + 1}/${delays.length} in ${delay / 1000}s: ${reason}`, e.message || String(e), target);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

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
    petId: activeLoop?.petId || startingPetId || null,
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
  // Incremental push only to windows that consume logs (social + management),
  // NOT to character/chat windows — avoids event flooding on the main character webview.
  tauri.emitToLabels(['social', 'management'], 'social-log-entry', entry);

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
 * 将 callLLMWithTools / 直调 callLLM 产生的 usage record 输出为一条
 * addLog('usage') 行，供 SocialPage 日志面板和 PromptCachePanel 消费。
 */
function logUsageRecord(record) {
  if (!record) return;
  addLog('usage', formatUsageLogMessage(record), record, record.target || undefined);
}

/** 保留最近多少条 Intent 行动记录（防漂移的客观历史） */
const INTENT_HISTORY_LIMIT = 5;


/**
 * 把 write_intent_plan 的 args 拆成结构化 markdown，作为日志的可展开详情。
 * 帮用户快速看清：plan / brief / 当前氛围（state【群里情况】+【我的判断】）/ todolist（state【策略】）/ 完整 state。
 */
function _buildPlanDetails(args = {}) {
  const state = args?.state || '';
  const brief = args?.brief || '';
  const actions = Array.isArray(args?.actions) ? args.actions : [];

  // 从 state 抽取 【XXX】 段。markers 顺序就是 state 里的预期顺序
  const markers = ['我刚做了', '效果复盘', '群里情况', '我的判断', '策略'];
  const sections = {};
  if (state) {
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const startIdx = state.indexOf(`【${marker}】`);
      if (startIdx === -1) continue;
      let endIdx = state.length;
      for (let j = i + 1; j < markers.length; j++) {
        const nextStart = state.indexOf(`【${markers[j]}】`, startIdx + 1);
        if (nextStart !== -1 && nextStart < endIdx) endIdx = nextStart;
      }
      sections[marker] = state.slice(startIdx, endIdx).trim();
    }
  }

  const planJson = JSON.stringify({ actions }, null, 2);

  const atmosphere = [sections['群里情况'], sections['我的判断']]
    .filter(Boolean).join('\n\n');
  const todolist = sections['策略'] || '';

  const parts = [
    '## 📋 Plan (actions)',
    planJson,
    '',
  ];
  if (brief && brief.trim()) {
    parts.push('## 💬 Reply brief');
    parts.push(brief.trim());
    parts.push('');
  }
  if (atmosphere) {
    parts.push('## 🌡️ 当前氛围（INTENT 抽取）');
    parts.push(atmosphere);
    parts.push('');
  }
  if (todolist) {
    parts.push('## ✅ Todolist / 多步策略（INTENT 抽取）');
    parts.push(todolist);
    parts.push('');
  } else {
    parts.push('## ✅ Todolist / 多步策略');
    parts.push('（本轮无多步计划）');
    parts.push('');
  }
  parts.push('---');
  parts.push('## 📄 完整 state（INTENT_xxx.md 写入内容）');
  parts.push(state || '(空)');

  return parts.join('\n');
}


/**
 * 获取社交日志
 * @param {string} [petId] - 可选；仅返回指定宠物的日志
 * @returns {Array} 日志条目数组
 */
export function getSocialLogs(petId) {
  const matchesPet = (entry) => petId == null || entry.petId === petId;
  const all = systemLogs.filter(matchesPet);
  for (const arr of targetLogs.values()) all.push(...arr.filter(matchesPet));
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

/**
 * 清空社交日志
 * @param {string} [petId] - 可选；仅清空指定宠物，不传则清空全部
 */
export function clearSocialLogs(petId) {
  if (petId == null) {
    systemLogs.length = 0;
    targetLogs.clear();
    return;
  }
  for (let i = systemLogs.length - 1; i >= 0; i--) {
    if (systemLogs[i].petId === petId) systemLogs.splice(i, 1);
  }
  for (const [target, entries] of targetLogs) {
    const kept = entries.filter(entry => entry.petId !== petId);
    if (kept.length > 0) targetLogs.set(target, kept);
    else targetLogs.delete(target);
  }
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

/**
 * 加载持久化的 paused targets
 * @param {string} petId
 * @returns {Promise<Object|null>} { [target]: true } 或 null（首次启动）
 */
async function loadPausedTargets(petId) {
  try {
    const allSettings = await tauri.getSettings();
    const raw = allSettings[`social_paused_targets_${petId}`];
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[Social] Failed to load paused targets for', petId, e);
    return null;
  }
}

/**
 * 持久化 paused targets
 * @param {string} petId
 * @param {Object} paused - { [target]: true }
 */
async function savePausedTargets(petId, paused) {
  try {
    await tauri.updateSettings({
      [`social_paused_targets_${petId}`]: JSON.stringify(paused)
    });
  } catch (e) {
    console.warn('[Social] Failed to save paused targets', e);
  }
}

// ============ API Provider 解析 ============

/**
 * API Key 轮询计数器（每个 Provider 独立）
 * key: providerId, value: 上次使用的 key 索引
 */
const apiKeyRoundRobin = new Map();

/**
 * 从多 Key 字符串中解析 Key 数组（换行分隔，忽略空行）
 */
function parseApiKeys(raw) {
  if (!raw) return [];
  return raw.split('\n').map(k => k.trim()).filter(Boolean);
}

/**
 * 从 apiProviderId 解析出 LLM 调用所需的参数
 * 支持多 Key 负载均衡：apiKey 是 getter，每次读取自动轮询到下一个 Key
 * @param {string} apiProviderId
 * @param {string} modelName
 * @returns {Promise<{apiKey: string, baseUrl: string, apiFormat: string, modelName: string}|null>}
 */
async function resolveApiProvider(apiProviderId, modelName) {
  try {
    const providers = await tauri.getApiProviders();
    const provider = providers.find(p => (p.id || p._id) === apiProviderId);
    if (!provider) {
      addLog('error', `API provider not found: ${apiProviderId}`);
      return null;
    }

    const keys = parseApiKeys(provider.apiKey);
    if (keys.length === 0) {
      addLog('error', `API provider "${provider.name}" has no valid API keys`);
      return null;
    }

    const config = {
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat || 'openai_compatible',
      modelName: modelName || provider.defaultModel || '',
    };

    if (keys.length === 1) {
      config.apiKey = keys[0];
    } else {
      // 多 Key 轮询：每次读取 apiKey 自动切换到下一个
      Object.defineProperty(config, 'apiKey', {
        enumerable: true,
        get() {
          const idx = (apiKeyRoundRobin.get(apiProviderId) ?? -1) + 1;
          const nextIdx = idx % keys.length;
          apiKeyRoundRobin.set(apiProviderId, nextIdx);
          return keys[nextIdx];
        }
      });
      addLog('info', `API provider "${provider.name}": ${keys.length} keys, round-robin enabled`);
    }

    return config;
  } catch (e) {
    addLog('error', 'Failed to resolve API provider', e.message);
    return null;
  }
}

// ============ 图片预描述 ============

/**
 * 调用 vision LLM 描述一张图片，结合聊天上下文分析内容和发送者意图。
 *
 * @param {Object} resolvedImage - { data: string (base64/url), mimeType: string }
 * @param {string} contextBefore - 图片前的聊天文本
 * @param {string} contextAfter - 图片后的聊天文本
 * @param {string} senderName - 发送者名称
 * @param {string} botName - bot 在群里的名称
 * @param {Object} visionLLMConfig - { apiKey, baseUrl, apiFormat, modelName }
 * @returns {Promise<string>} 图片描述文本
 */
/**
 * 将 GIF 图片转换为 PNG（取第一帧），因为 Gemini 不支持 image/gif。
 * 通过 Rust image crate 解码后重新编码为 PNG base64，跨平台兼容。
 * @param {string} base64Data - 纯 base64 字符串（不带 data: 前缀）
 * @returns {Promise<{data: string, mimeType: string}>} PNG base64 数据
 */
async function convertGifToPng(base64Data) {
  const result = await tauri.convertGifToPng(base64Data);
  return { data: result.data, mimeType: result.mime_type };
}

/**
 * 解析图片给模型用：URL → base64，GIF → 3×3 采样网格。
 *
 * GIF 不能原样发：Gemini 的 inline_data 不收 image/gif，Anthropic 也只认静态图。
 * 过去的做法是在 buildTurnsFromMessages 里把 GIF 直接 filter 掉 —— 群里大部分
 * 表情包就这么无声消失了。这里改成转成九宫格：按时间均匀取 9 帧拼一张 PNG，
 * 动作和笑点都还在，而且对所有 API 格式都通用。
 *
 * 转换结果带 `fromGif` 标记，buildTurnsFromMessages 据此告诉模型这是动图采样，
 * 否则模型会把九宫格当成九张独立的图来理解。
 */
async function resolveImagesForModel(images) {
  const resolved = await resolveImageUrls(images);
  const out = [];
  for (const img of resolved) {
    if (img.mimeType !== 'image/gif') {
      out.push(img);
      continue;
    }
    try {
      const sheet = await tauri.gifToContactSheet(img.data);
      console.log(`[Social] GIF → 九宫格: ${sheet.frame_count} 帧采样 ${sheet.sampled} 格, ${Math.round(sheet.data.length / 1024)}KB`);
      out.push({
        data: sheet.data,
        mimeType: sheet.mime_type,
        sourceUrl: img.sourceUrl,
        fromGif: true,
        gifFrames: sheet.frame_count,
        gifSampled: sheet.sampled,
      });
    } catch (e) {
      // 转换失败就退回首帧，至少比整张丢掉强
      console.warn('[Social] GIF contact sheet failed, falling back to first frame:', e);
      try {
        const png = await convertGifToPng(img.data);
        out.push({ ...png, sourceUrl: img.sourceUrl, fromGif: true, gifFrames: 0, gifSampled: 1 });
      } catch {
        // 首帧也转不出来才放弃这张图
      }
    }
  }
  return out;
}

async function describeImage(resolvedImage, contextBefore, contextAfter, senderName, botName, visionLLMConfig, petId) {
  // GIF → PNG 转码（Gemini 不支持 image/gif）
  if (resolvedImage.mimeType === 'image/gif' || resolvedImage.data?.includes('data:image/gif')) {
    try {
      let rawBase64 = resolvedImage.data;
      if (rawBase64.startsWith('data:')) {
        rawBase64 = rawBase64.split(',')[1];
      }
      const converted = await convertGifToPng(rawBase64);
      resolvedImage = { ...resolvedImage, data: converted.data, mimeType: 'image/png' };
      console.log('[Vision] Converted GIF to PNG for Vision API');
    } catch (e) {
      console.warn('[Vision] GIF→PNG conversion failed, skipping image:', e.message || e);
      return '[GIF 动图，无法识别内容]';
    }
  }

  let imageUrl;
  if (resolvedImage.data.startsWith('http://') || resolvedImage.data.startsWith('https://')) {
    imageUrl = resolvedImage.data;
  } else if (resolvedImage.data.startsWith('data:')) {
    imageUrl = resolvedImage.data;
  } else {
    imageUrl = `data:${resolvedImage.mimeType};base64,${resolvedImage.data}`;
  }

  const systemPrompt = `你是图片描述助手。先判断图片类型，再详细描述内容。输出为一段连续的文字，不要换行。

格式：[类型] 描述内容

类型判断：
- [表情包]：表情包、梗图、emoji、动图、搞笑图。描述画面内容（角色、表情、动作、背景），提取图上所有文字
- [截图]：聊天记录、网页、文章、代码、通知、应用界面等屏幕截图。描述截图类型和界面布局，然后完整逐字提取截图中所有可见文字，不要省略不要概括
- [照片]：实拍照片、实物、风景、人物照、自拍等。详细描述拍摄的内容、环境、光线、构图等
- 以上都不是：直接描述图片中看到的所有内容`;

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请分析这张图片。' },
        { type: 'image_url', image_url: { url: imageUrl, mime_type: resolvedImage.mimeType || 'image/jpeg' } },
      ],
    },
  ];

  const _visionStart = Date.now();
  // Vision 走 callLLM → Rust 后端，Rust 不转发 explicitCache/cacheKey，
  // 而且 Vision 通常用 Gemini（隐式缓存），因此此处不传显式缓存参数。
  // usage 日志行仍然通过 logUsageRecord 发出，面板能看到 Vision 的 cached tokens。
  // 硬超时兜底：即使后端/网络层完全不返回，调用方也不会被永久阻塞。
  const result = await withHardTimeout(
    callLLM({
      messages,
      apiFormat: visionLLMConfig.apiFormat,
      apiKey: visionLLMConfig.apiKey,
      model: visionLLMConfig.modelName,
      baseUrl: visionLLMConfig.baseUrl,
      options: { temperature: 0.2 },
      conversationId: `vision-desc-${Date.now()}`,
    }),
    VISION_CALL_TIMEOUT_MS,
    'Vision LLM',
  );

  // Log vision usage
  if (petId) {
    const { normalizeUsage, appendUsageLog } = await import('./mcp/toolExecutor.js');
    const u = normalizeUsage(result.usage);
    const record = {
      ts: new Date().toISOString(), label: 'Vision', target: '',
      model: visionLLMConfig.modelName || '', apiFormat: visionLLMConfig.apiFormat || '',
      inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens,
      toolCalls: 0, iterations: 1, durationMs: Date.now() - _visionStart,
    };
    appendUsageLog(petId, record);
    logUsageRecord(record);
  }

  if (result.error) {
    throw new Error(result.content || 'Vision LLM call failed');
  }

  return (result.content || '').trim();
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
function buildTurnsFromMessages(messages, { sanitizeAtMe = false, ownerQQ = '', ownerName = '', ownerSecret = '', nameL = '', nameR = '', msgL = '', msgR = '', imageUrlMap = null, moodTags = null } = {}) {
  if (!messages || messages.length === 0) return [];

  // 用于从文本中剥离所有安全分隔符和令牌的辅助函数
  const allSecrets = [ownerSecret, nameL, nameR, msgL, msgR].filter(Boolean);
  const stripSecrets = (s) => {
    for (const sec of allSecrets) s = s.replaceAll(sec, '');
    return s;
  };

  // 图片序号计数器（跨消息递增），用于 sticker_save 的 image_id 引用
  let imageIdCounter = 0;

  const turns = [];

  // 把 ISO 时间戳格式化成 HH:MM:SS（无时区，本地时区显示）
  const formatHMS = (ts) => {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
      return '';
    }
  };

  for (const msg of messages) {
    const role = msg.is_self ? 'assistant' : 'user';
    const tsTag = formatHMS(msg.timestamp);

    let text;
    if (msg.is_self) {
      // assistant turn：标注为"我的回复"并带时间戳，避免和"背景描述"混淆
      let body;
      if (!(msg.content || '').trim() && msg._images && msg._images.length > 0) {
        body = '[发送了表情包]';
      } else {
        body = msg.content || '';
      }
      const prefix = tsTag ? `[${tsTag} 我的回复]` : '[我的回复]';
      text = `${prefix} ${body}`;
    } else {
      // user turn：用安全分隔符包裹名字和消息，前面附时间戳
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
      const msgIdTag = msg.message_id ? ` [#${msg.message_id}]` : '';
      let msgContent = stripSecrets(msg.content || '');
      const tsPrefix = tsTag ? `[${tsTag}] ` : '';
      // 状态标签放在名字块内（可信区）——它是运行时产出的元数据，不是用户输入。
      // 值来自 Jev 的受限枚举并在 parseMoodAnswers 里过了白名单，这里再 strip 一次
      // 分隔符做纵深防御。
      const moodTag = moodTags ? stripSecrets(renderMoodTag(moodTags.get(String(msg.message_id)))) : '';
      text = `${tsPrefix}${nameL}${name}(${idTag})${moodTag}${msgIdTag}${nameR} ${msgL}${msgContent}${msgR}`;
    }

    if (sanitizeAtMe) {
      text = text.replaceAll('@me', '@[已读]');
    }

    // 构建 content：有预描述时用文本占位，有原始图片时用多模态数组，否则用纯字符串
    const hasImageDescs = !msg.is_self && msg._imageDescs && msg._imageDescs.length > 0;

    // 用原始 image_urls（resolve 前的 HTTP URL）注册到 imageUrlMap
    // msg._images.data 在 resolveImageUrls 后已变成 base64，无法用于下载
    const originalUrls = (!msg.is_self && msg.image_urls) ? msg.image_urls : [];

    // 兜底过滤：正常情况下 GIF 已经在 resolveImagesForModel 里转成九宫格 PNG 了，
    // 走到这里还是 image/gif 只可能是转换失败的残留 —— Gemini/Anthropic 收到会报错。
    if (!msg.is_self && msg._images) {
      msg._images = msg._images.filter(img => img.mimeType !== 'image/gif');
    }
    const hasImages = !msg.is_self && msg._images && msg._images.length > 0;
    let content;

    // 为本条消息的图片分配序号并注册原始 URL 到 imageUrlMap。
    //
    // 序号必须以**真正发给模型的图片数**为准。之前这里取 originalUrls.length，
    // 而上面那道过滤可能已经删掉了一部分 —— 于是模型眼里的「第 1 张图」对应到
    // imageUrlMap 里的第 2 条，sticker_save(image_id=1) 会存下一张模型根本没看过的图。
    const visibleImageCount = hasImageDescs ? msg._imageDescs.length : (hasImages ? msg._images.length : 0);
    const imageCount = Math.min(originalUrls.length || visibleImageCount, visibleImageCount) || visibleImageCount;
    const msgImageBaseId = imageIdCounter;
    for (let i = 0; i < imageCount; i++) {
      imageIdCounter++;
      // 优先用图片自己记下的来源（resolveImageUrls 写的 sourceUrl）。
      // 按下标去 originalUrls 里取是不可靠的：下载失败或格式不支持的图会被
      // 中途丢弃，剩下的图与原始 URL 列表就错位了，模型说的「第 1 张」会对到
      // 一张它根本没看过的图上。
      const url = msg._images?.[i]?.sourceUrl || originalUrls[i];
      // 本地路径也要收：图片现在优先解析成 NapCat 的本地副本，
      // 只认 http 的话 imageUrlMap 永远是空的，sticker_save 会报「找不到图片 #N」。
      if (imageUrlMap && url
          && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/'))) {
        imageUrlMap.set(imageIdCounter, url);
      }
    }

    /**
     * 把 _images 摊成多模态 parts。
     *
     * 提示语整条消息只给一次，不再每张图前面重复一遍：多图时那句话会被说 N 遍，
     * 白烧 token；更要紧的是它原文写着「不需要刻意回应每张图」，用户明明发了
     * 「这三张图对比一下」也会被这句话对冲掉。所以只在这条消息**没有文字**、
     * 图片确实是独立表情包时才提示。
     */
    const buildImageParts = (images, senderHasText) => {
      const toUrl = (img) => (
        img.data.startsWith('http://') || img.data.startsWith('https://') || img.data.startsWith('data:')
          ? img.data
          : `data:${img.mimeType};base64,${img.data}`
      );
      const hints = [];
      const gif = images.find(img => img.fromGif);
      if (gif) {
        // 不说明的话模型会把九宫格当成九张互不相干的图
        hints.push(gif.gifSampled > 1
          ? `（其中的九宫格图是一张 GIF 动图，按时间均匀采样 ${gif.gifSampled} 帧拼成，从左到右、从上到下为播放顺序）`
          : '（其中一张图来自 GIF 动图）');
      }
      if (!senderHasText) {
        hints.push('（如果是梗图/表情包，理解情绪即可，不需要刻意回应每张图）');
      }
      return [
        ...hints.map(h => ({ type: 'text', text: h })),
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: toUrl(img), mime_type: img.mimeType || 'image/jpeg' },
        })),
      ];
    };
    const senderHasText = Boolean((msg.content || '').trim());

    if (hasImageDescs && !hasImages) {
      // 全部图片已描述成功 → 纯文本（描述占位）
      const descText = msg._imageDescs.map((d, i) => `[图片#${msgImageBaseId + i + 1}: ${d}]`).join('\n');
      content = text + '\n' + descText;
    } else if (hasImageDescs && hasImages) {
      // 部分描述成功 + 部分保留原图 → 混合：描述文本 + 原图多模态
      const descText = msg._imageDescs.map((d, i) => `[图片#${msgImageBaseId + i + 1}: ${d}]`).join('\n');
      content = [
        { type: 'text', text: text + '\n' + descText },
        ...buildImageParts(msg._images, senderHasText),
      ];
    } else if (hasImages) {
      // 无描述，原始图片 → 多模态数组
      content = [
        { type: 'text', text },
        ...buildImageParts(msg._images, senderHasText),
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
 * @param {Object|null} [params.intentPlan=null] - 最新 write_intent_plan 结果 { state, actions[] }
 * @param {string} [params.replyBriefOverride=''] - Reply 派发瞬间的 brief 快照
 * @param {Function|null} [params.dispatchGuard=null] - 副作用执行前的 runtime 状态检查
 * @param {boolean} [params.enableImages=true] - 是否向 LLM 发送图片
 * @param {'off'|'self'|'other'} [params.imageDescMode='off'] - 图片预描述模式：off=关闭, self=用主模型, other=用独立模型
 * @param {Object|null} [params.visionLLMConfig=null] - vision LLM 配置 { apiKey, baseUrl, apiFormat, modelName }
 * @param {string} [params.botName=''] - bot 在群里的名称
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
  intentPlan: pollIntentPlan = null,
  replyBriefOverride = '',
  dispatchGuard = null,
  enableImages = true,
  imageDescMode = 'off',
  visionLLMConfig = null,
  botName = '',
  fullBufferMessages = null,  // Observer 用：完整 buffer（供 buffer_search 搜索）
  socialConfig = null,  // per-pet social config; used for explicit prompt cache opt-in
}) {
  const groupName = gName || target;
  const compressedSummary = compSummary;

  if (dispatchGuard && !dispatchGuard()) {
    return { action: 'cancelled', detail: 'runtime no longer allows this task' };
  }
  
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
  
  // ── 3. 解析图片 URL 为 base64（enableImages=false 时跳过） ──
  let totalImageCount = 0;
  if (enableImages) {
    for (const msg of individualMessages) {
      if (msg._images && msg._images.length > 0) {
        msg._images = await resolveImagesForModel(msg._images);
        totalImageCount += msg._images.length;
      } else {
        msg._images = [];
      }
    }
    if (totalImageCount > 0) {
      addLog('info', `Resolved ${totalImageCount} image(s) across ${individualMessages.filter(m => m._images.length > 0).length} message(s)`, null, target);
    }

    // ── 3b. 图片预描述（vision LLM） ──
    if (imageDescMode !== 'off' && visionLLMConfig && totalImageCount > 0) {
      let describedCount = 0;
      let cachedCount = 0;
      for (let i = 0; i < individualMessages.length; i++) {
        const msg = individualMessages[i];
        if (!msg._images || msg._images.length === 0 || msg.is_self) continue;

        // 构建上下文：前5条消息文本 + 后所有消息文本
        const ctxBefore = individualMessages.slice(Math.max(0, i - 5), i)
          .map(m => `${m.sender_name || m.sender_id}: ${m.content || ''}`.trim())
          .join('\n');
        const ctxAfter = individualMessages.slice(i + 1)
          .map(m => `${m.sender_name || m.sender_id}: ${m.content || ''}`.trim())
          .join('\n');
        const sender = msg.sender_name || msg.sender_id || 'unknown';

        const remainingImages = [];
        // 并行描述同一条消息内的所有图片
        const descPromises = msg._images.map((img, j) => {
          const cacheKey = `${msg.message_id}_${j}`;
          // 检查缓存
          const cachedDesc = msg.message_id ? getCachedImageDesc(cacheKey) : undefined;
          if (cachedDesc !== undefined) {
            cachedCount++;
            return Promise.resolve(cachedDesc);
          }
          // 调用 vision LLM（并发去重：若已有 inflight Promise 则复用，失败指数重试）
          if (imageDescInflight.has(cacheKey)) {
            cachedCount++;
            // 复用的 inflight 可能因硬超时/接口错误 reject —— 降级为占位符，
            // 不能让一张图把整轮 Reply 拖成异常。
            return imageDescInflight.get(cacheKey).catch(() => '[图片描述失败]');
          }
          const imgData = img.data || '';
          const imgPreview = imgData.startsWith('http') ? imgData.slice(0, 120) : `${img.mimeType || 'unknown'} base64(${Math.round(imgData.length / 1024)}KB)`;
          const wrappedDescribe = () => {
            const p = describeImage(img, ctxBefore, ctxAfter, sender, botName, visionLLMConfig, petId);
            imageDescInflight.set(cacheKey, p);
            return p;
          };
          const descP = retryLLM(wrappedDescribe, { label: `Vision [${sender}] img${j}`, target, delays: VISION_RETRY_DELAYS })
            .then(desc => {
              addLog('llm', `🖼️ Vision [${sender}] img${j}`, `input: ${imgPreview}\noutput: ${desc}`, target);
              describedCount++;
              if (msg.message_id) setCachedImageDesc(cacheKey, desc);
              return desc;
            })
            .catch(e => {
              addLog('warn', `Vision desc failed for ${target} msg=${msg.message_id} img=${j}`, e.message || e, target);
              const fallback = '[图片描述失败]';
              if (msg.message_id) setCachedImageDesc(cacheKey, fallback);
              return fallback;
            })
            .finally(() => {
              imageDescInflight.delete(cacheKey);
            });
          return descP;
        });
        const descs = await Promise.all(descPromises);
        // 写回消息
        if (descs.length > 0) {
          msg._imageDescs = descs;
        }
        msg._images = remainingImages; // 只保留未描述成功的图片
      }
      if (describedCount > 0 || cachedCount > 0) {
        addLog('info', `🖼️ Vision desc: ${describedCount} described, ${cachedCount} cached for ${target}`, null, target);
      }
    }
  } else {
    // 图片关闭：清空所有 _images
    for (const msg of individualMessages) {
      msg._images = [];
    }
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
    targetType,
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
    intentPlan: pollIntentPlan,
    replyBriefOverride,
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

  // 图片序号 → 原始 URL 映射（用于 sticker_save 按序号引用图片）
  const imageUrlMap = new Map();

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
    imageUrlMap,
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
    let intentBlock = '\n\n---\n# 你的当前想法\n';
    if (pollIntentPlan) {
      const replyAction = pollIntentPlan.actions?.find(a => a.type === 'reply');
      intentBlock += (pollIntentPlan.state || '').trim() + '\n';
      if (replyAction) {
        if (replyAction.atTarget && replyAction.atTarget !== '无') intentBlock += `【需要 @${replyAction.atTarget}】\n`;
        if (replyAction.replyTo) intentBlock += `【发送参数：引用回复消息 ID ${replyAction.replyTo}】\n`;
      }
      intentBlock += '以上是你对当前对话的想法和行为倾向，自然体现在回复风格和话题选择中。不要直接说出这些想法。';
    } else {
      intentBlock += '（意图模块尚未产出评估，请根据聊天内容自行判断。）';
    }
    intentBlock += '\n---';
    intentBlock += '\n⚠️ 回复前请回顾上方 assistant 消息（你之前说过的话）。如果你想表达的观点已经出现过，且没有人针对你的发言追问或回应，请选择沉默。但如果有群友回应或追问了你刚才说的话，回答他们是对话的延续，不是重复——即使话题相同，你也应该回应。';
    intentBlock += '\n⚠️ 你必须通过 send_message 工具发送回复，不要直接输出文字。所有要说的内容都放在 send_message 的 content 参数里。';

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
    // ── Observer: 通用文件工具（social_tree/read/write/edit）+ history，无 send_message，无外部 MCP ──
    const toMcp = (defs) => defs.map(t => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
      serverName: null,
    }));
    mcpTools = [
      ...toMcp(getSocialFileToolDefinitions()),
      ...toMcp(getHistoryToolDefinitions()),
      ...toMcp(getStickerToolDefinitions().filter(t =>
        ['sticker_save', 'sticker_list'].includes(t.function.name)
      )),
      ...(fullBufferMessages ? toMcp(getBufferSearchToolDefinitions()) : []),
    ];
  } else {
    // ── Reply: send_message + 外部 MCP + history 工具，无 builtin 读写 ──
    try {
      const allTools = await getMcpTools();
      const extraServers = new Set(promptConfig.enabledMcpServers || []);
      mcpTools = allTools.filter(t =>
        (t.serverName === mcpServerName && t.name === 'send_message') ||
        (extraServers.has(t.serverName) && t.serverName !== mcpServerName)
      );
      // 从 send_message schema 剥离 num_chunks / split_content —— 分段统一走 </分段> 标签
      mcpTools = mcpTools.map(t => {
        if (t.name !== 'send_message' || !t.inputSchema?.properties) return t;
        const { num_chunks, split_content, ...rest } = t.inputSchema.properties;
        const prevRequired = t.inputSchema.required || [];
        return {
          ...t,
          inputSchema: {
            ...t.inputSchema,
            properties: rest,
            required: prevRequired.filter(k => k !== 'num_chunks' && k !== 'split_content'),
          },
        };
      });
    } catch (e) {
      addLog('warn', 'Failed to get MCP tools, proceeding without tools', e.message, target);
    }
    // Reply 有 history 只读工具 + 跨群日志工具 + cc_history + cc_read（读 CC 结果）
    const builtinDefs = [
      ...getHistoryToolDefinitions(),
      ...getGroupLogToolDefinitions(),
      ...[getCcHistoryToolDefinition(), getCcReadToolDefinition()],
    ];
    const builtinToolsAsMcp = builtinDefs.map(t => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
      serverName: null,
    }));
    mcpTools = [...mcpTools, ...builtinToolsAsMcp];

  }

  // -- Poll data collection for aggregated log entry --
  const pollChatMessages = otherMessages.map(m => {
    let content = (m.content || '').substring(0, 200);
    if (m._imageDescs && m._imageDescs.length > 0) {
      const descSuffix = m._imageDescs.map(d => `[图片: ${d}]`).join(' ');
      content = (content + ' ' + descSuffix).substring(0, 400);
    } else if (m._images && m._images.length > 0) {
      content = content + ` [图片x${m._images.length}]`;
    }
    return {
      sender: m.sender_name,
      content,
      isAtMe: m.is_at_me,
    };
  });
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
    const result = await retryLLM(() => callLLMWithTools({
      messages: _messagesForLLM,
      apiFormat: llmConfig.apiFormat,
      apiKey: llmConfig.apiKey,
      model: llmConfig.modelName,
      baseUrl: llmConfig.baseUrl,
      mcpTools,
      options: {
        temperature: 0.7,
        explicitCache: shouldUseExplicitCache(socialConfig, llmConfig.apiFormat),
        cacheKey: buildCacheKey(petId, target, role === 'observer' ? 'Observer' : 'Reply'),
      },
      builtinToolContext: { petId, targetId: target, targetType, mcpServerName, memoryEnabled: true, imageUrlMap, sentCache: sentMessagesCache, bufferMessages: fullBufferMessages || undefined, subagentRegistry },
      maxIterations: role === 'observer' ? 25 : undefined,
      stopAfterTool: role === 'reply' ? (name) => name.includes('send_message') : undefined,
      toolCallFilter: (name, args) => {
        // Reply 可能在 LLM 思考期间被 stop / pause / 切到 full-lurk。
        // 真正执行任意工具前再检查一次，避免旧闭包继续产生外部副作用。
        if (dispatchGuard && !dispatchGuard()) {
          return `${role === 'reply' ? 'Reply' : 'Observer'} 已取消：Social Agent 已停止、目标已暂停或进入禁止状态。`;
        }
        if (
          role === 'observer'
          && /(send_message|send_image|sticker_send|image_send|webshot_send|voice_send|generate_image_send)/i.test(name)
        ) {
          return `Observer 是只观察角色，禁止调用发送工具 ${name}。`;
        }
        // REPLY_STRATEGY 是显式用户策略文件；关闭编辑权限时，不依赖 prompt。
        if (promptConfig.agentCanEditStrategy !== true) {
          const mutationTools = new Set(['social_write', 'social_edit', 'social_delete', 'social_rename']);
          const touchesStrategy = [args?.path, args?.from, args?.to]
            .some(path => path != null && (
              canonicalSocialPath(path) == null
              || canonicalSocialPath(path) === 'social/reply_strategy.md'
            ));
          if (mutationTools.has(name) && touchesStrategy) {
            return '当前配置禁止 Agent 修改 social/REPLY_STRATEGY.md。';
          }
        }
        return null;
      },
      usageLabel: role === 'observer' ? 'Observer' : 'Reply',
      usageTarget: target,
      usagePetId: petId,
      onUsageLogged: (record) => {
        if (!dispatchGuard || dispatchGuard()) logUsageRecord(record);
      },
      // 强制覆盖 send_message 的 target/target_type，防止 LLM 用群名代替群号
      toolArgTransform: (name, args) => {
        if (name.includes('send_message')) {
          // 防泄漏：将回复中出现的所有临时安全令牌/分隔符剥离
          let content = args?.content || '';
          for (const sec of Object.values(ephemeral)) {
            content = content.replaceAll(sec, '');
          }
          // reply_to: 优先用 LLM 自己传的，其次用 Intent plan 里的
          const intentEntry = pollIntentPlan?.actions?.find(a => a.type === 'reply');
          const replyTo = args?.reply_to || intentEntry?.replyTo || undefined;
          const extra = {};
          if (replyTo) extra.reply_to = String(replyTo);
          // 过滤 LLM 误抄的占位符
          content = content.replace(/\[图片\]/g, '').replace(/\[视频\]/g, '').replace(/\[语音\]/g, '').replace(/\[文件\]/g, '').trim();
          return { ...args, content, ...extra, target, target_type: targetType };
        }
        return args;
      },

      onLLMText: (iter) => {
        if (dispatchGuard && !dispatchGuard()) return;
        pollLlmIters.push(iter);
      },
      onToolCall: (name, args) => {
        if (dispatchGuard && !dispatchGuard()) return;
        pollToolCalls.push({ name, args: JSON.stringify(args).substring(0, 300) });
        // 社交文件写入用特殊 level 标记
        if ((name === 'social_write' || name === 'social_edit') && args?.path) {
          addLog('memory', `📝 社交文件更新: ${name} → ${args.path}`, JSON.stringify(args).substring(0, 300), target);
        } else {
          addLog('info', `LLM called tool: ${name}`, JSON.stringify(args, null, 2), target);
        }
        // 暂存 send_message 的 content，等 onToolResult 确认成功后写入缓存
        if (name.includes('send_message')) {
          pendingSendContent = args?.content || '';
        }
      },
      onToolResult: (name, result, _id, isError) => {
        if (dispatchGuard && !dispatchGuard()) return;
        const preview = typeof result === 'string' ? result.substring(0, 100) : JSON.stringify(result).substring(0, 100);
        // Track tool result in poll collector
        if (pollToolCalls.length > 0 && pollToolCalls[pollToolCalls.length - 1].name === name) {
          pollToolCalls[pollToolCalls.length - 1].result = preview;
          pollToolCalls[pollToolCalls.length - 1].isError = isError;
        }
        if ((name === 'social_write' || name === 'social_edit') && !isError) {
          addLog('memory', `✅ 社交文件已保存`, preview, target);
        } else {
          addLog(isError ? 'error' : 'info', `Tool result: ${name}`, preview, target);
        }
        // 追踪 send_message 是否真正成功（结果中不含 error/失败标记）
        if (name.includes('send_message') && !isToolResultFailure(result, isError)) {
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
                msgId = parsed?.message_ids?.[0]?.toString() || parsed?.message_id || null;
                if (parsed?.timestamp) msgTs = parsed.timestamp;
              } catch { /* ignore */ }
              
              const arr = sentCache.get(target) || [];
              arr.push({ content: pendingSendContent, timestamp: msgTs, message_id: msgId });
              sentCache.set(target, arr);
              addLog('info', `Cached sent message for ${target}: ${pendingSendContent.substring(0, 50)}...`, null, target);
            }
            pendingSendContent = null; // 重置
        }
      },
    }), { label: `${role === 'observer' ? 'Observer' : 'Reply'} ${target}`, target });
    
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
        const dedup = (s) => {
          const parts = s.split(/(?<=[。！？!?\n])\s*/).filter(p => p.trim());
          if (parts.length <= 1) {
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
        // 尝试发送，失败则重试一次
        const sendToolName = `${mcpServerName}__send_message`;
        for (let autoAttempt = 0; autoAttempt < 2; autoAttempt++) {
          try {
            if (dispatchGuard && !dispatchGuard()) {
              throw new Error('Reply 已取消：Social Agent 已停止、目标已暂停或进入 full-lurk');
            }
            const autoSendResult = await executeToolByName(sendToolName, { content: cleanText, target, target_type: targetType }, { timeout: 10000 });
            if (dispatchGuard && !dispatchGuard()) {
              return { action: 'cancelled', detail: 'runtime stopped while send was in flight' };
            }
            if (isToolResultFailure(autoSendResult)) {
              throw new Error('send_message returned an error result');
            }
            sendMessageSuccess = true;
            if (newWatermarkId) watermarks.set(target, newWatermarkId);
            let autoMsgId = null;
            try {
              const rawText = autoSendResult?.content?.[0]?.text;
              const p = rawText ? JSON.parse(rawText) : autoSendResult;
              autoMsgId = p?.message_ids?.[0]?.toString() || p?.message_id || null;
            } catch { /* ignore */ }
            const arr = sentCache.get(target) || [];
            arr.push({ content: cleanText, timestamp: new Date().toISOString(), message_id: autoMsgId });
            sentCache.set(target, arr);
            emitPollLog('replied');
            addLog('info', `✅ Auto-sent for ${targetType}:${target} (LLM forgot tool): ${cleanText.substring(0, 80)}`, null, target);
            return { action: 'replied', detail: cleanText };
          } catch (e) {
            addLog('warn', `Auto-send attempt ${autoAttempt + 1} failed for ${target}: ${e.message}`, null, target);
            if (autoAttempt === 0) await new Promise(r => setTimeout(r, 2000)); // 2s 后重试
          }
        }
        // 两次都失败 → send_failed，不是 silent
        emitPollLog('send_failed');
        addLog('error', `❌ Auto-send failed after 2 attempts for ${targetType}:${target}: ${cleanText.substring(0, 80)}`, null, target);
        return { action: 'send_failed', detail: cleanText };
      }

      // Reply 被调用但 LLM 输出为空/沉默 — 这也不应该是正常的 silent
      if (role === 'reply') {
        emitPollLog('silent');
        addLog('warn', `⚠️ Reply produced no sendable content for ${targetType}:${target}`, text?.substring(0, 50), target);
        return { action: 'silent', detail: text };
      }

      emitPollLog('silent');
      addLog('info', `😶 Silent for ${targetType}:${target}`, result.content?.substring(0, 50), target);
      return { action: 'silent', detail: result.content };
    }
  } catch (e) {
    if (dispatchGuard && !dispatchGuard()) {
      return { action: 'cancelled', detail: 'runtime stopped while LLM was in flight' };
    }
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
    const errMsg = e.message || String(e);
    const detail = e._debugBody ? `${errMsg}\n\n--- request body ---\n${e._debugBody}` : errMsg;
    addLog('error', `LLM call failed for ${target}`, detail, target);
    return { action: 'error', detail: errMsg };
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

/** Debounced persistKnownTargets — max once per 30s to avoid flooding IO from fetcher loop */
let _persistDebounceTimer = null;
function persistKnownTargetsDebounced(petId, targetSet) {
  if (_persistDebounceTimer) return; // already scheduled
  _persistDebounceTimer = setTimeout(() => {
    _persistDebounceTimer = null;
    persistKnownTargets(petId, targetSet);
  }, 30000);
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
async function runDailyCompress(petId, llmConfig, targetSet, socialConfig = null, runtimeGuard = null) {
  const stillActive = () => !runtimeGuard || runtimeGuard();
  if (!stillActive()) return;
  addLog('info', '📦 Starting daily compression...');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // 收集所有群的所有非今天的数据，按天分组
  // key: dateStr, value: Array<{ target, entries[] }>
  const dayGroups = new Map();

  for (const target of targetSet) {
    if (!stillActive()) return;
    // 历史 targets.json 没有保存 targetType；同时探测两个命名空间，
    // 兼容旧版曾把 private 错写进 group 的数据。
    for (const dir of ['group', 'friend']) {
      const bufferPath = `social/${dir}/LOG_${target}.md`;
      let content;
      try {
        content = await tauri.workspaceRead(petId, bufferPath);
      } catch { continue; } // 文件不存在
      if (!content || !content.trim()) continue;

      const dateMap = parseBufferByDate(content);
      for (const [dateStr, entries] of dateMap) {
        if (dateStr === today) continue; // 今天的不压缩
        if (!dayGroups.has(dateStr)) dayGroups.set(dateStr, []);
        dayGroups.get(dateStr).push({ target, entries, bufferPath });
      }
    }
  }

  if (dayGroups.size === 0) {
    if (!stillActive()) return;
    addLog('info', 'No past-day data to compress');
    return;
  }

  // 逐天压缩
  for (const [dateStr, targetEntries] of [...dayGroups.entries()].sort()) {
    let anyGroupCompressed = false;
    const groupSummaries = []; // 收集每群摘要，用于生成全局日报

    // ── 第一步：逐群压缩，写入 social/daily/{date}/{target}.md ──
    for (const { target, entries } of targetEntries) {
      const groupName = targetNamesCache.get(target) || target;
      const groupContent = entries.join('\n');

      try {
        const perGroupPrompt = `你是一个信息压缩助手。请将以下聊天记录摘要压缩成该群/好友当天的详细总结。
保留关键事件、重要对话、群友动态、话题走向、氛围变化，去除重复和琐碎内容。
输出纯文本，不需要 markdown 格式标题。控制在 500 字以内。

群/好友：${groupName}（${target}）
日期：${dateStr}

${groupContent}`;

        const result = await retryLLM(() => callLLMWithTools({
          messages: [
            { role: 'system', content: '你是一个精简信息的助手。' },
            { role: 'user', content: perGroupPrompt },
          ],
          apiFormat: llmConfig.apiFormat,
          apiKey: llmConfig.apiKey,
          model: llmConfig.modelName,
          baseUrl: llmConfig.baseUrl,
          mcpTools: [],
          options: {
            temperature: 0.3,
            explicitCache: shouldUseExplicitCache(socialConfig, llmConfig.apiFormat),
            cacheKey: buildCacheKey(petId, target, 'Compress:daily'),
          },
          usageLabel: 'Compress:daily',
          usageTarget: target,
          usagePetId: petId,
          onUsageLogged: (record) => {
            if (stillActive()) logUsageRecord(record);
          },
        }), { label: `DailyCompress:${target}` });
        if (!stillActive()) return;

        const summary = result.content || '（压缩失败）';
        const perGroupContent = `# ${dateStr} ${groupName}\n\n${summary}\n`;
        const perGroupPath = `social/daily/${dateStr}/${target}.md`;
        await tauri.workspaceWrite(petId, perGroupPath, perGroupContent);
        if (!stillActive()) return;
        addLog('info', `📝 Per-group daily: ${perGroupPath}`, null, target);

        groupSummaries.push({ target, groupName, summary });
        anyGroupCompressed = true;
      } catch (e) {
        if (!stillActive()) return;
        addLog('error', `Failed to compress daily log for ${target} on ${dateStr}`, e.message, target);
      }
    }

    if (!anyGroupCompressed) continue; // 所有群都压缩失败，不清空 buffer

    // ── 第二步：全局日报（跨群总结） ──
    try {
      const globalInput = groupSummaries.map(({ groupName, target, summary }) =>
        `## ${groupName}（${target}）\n${summary}`
      ).join('\n\n');

      const globalPrompt = `你是一个信息压缩助手。以下是各群/好友今天的独立摘要，请写一篇跨群全局日报。
重点关注：跨群事件关联、整体社交动态、值得注意的趋势。
不要逐群复述，而是提炼跨群视角的洞察。
输出纯文本，不需要 markdown 格式标题。控制在 800 字以内。

日期：${dateStr}
涉及 ${groupSummaries.length} 个群/好友

${globalInput}`;

      const globalResult = await retryLLM(() => callLLMWithTools({
        messages: [
          { role: 'system', content: '你是一个精简信息的助手。' },
          { role: 'user', content: globalPrompt },
        ],
        apiFormat: llmConfig.apiFormat,
        apiKey: llmConfig.apiKey,
        model: llmConfig.modelName,
        baseUrl: llmConfig.baseUrl,
        mcpTools: [],
        options: {
          temperature: 0.3,
          explicitCache: shouldUseExplicitCache(socialConfig, llmConfig.apiFormat),
          cacheKey: buildCacheKey(petId, '', 'Compress:global'),
        },
        usageLabel: 'Compress:global',
        usageTarget: '',
        usagePetId: petId,
        onUsageLogged: (record) => {
          if (stillActive()) logUsageRecord(record);
        },
      }), { label: 'DailyCompressGlobal' });
      if (!stillActive()) return;

      const dailyContent = `# ${dateStr} 社交日报\n\n${globalResult.content || '（压缩失败）'}\n`;
      const dailyPath = `social/daily/${dateStr}.md`;
      await tauri.workspaceWrite(petId, dailyPath, dailyContent);
      if (!stillActive()) return;
      addLog('info', `📝 Global daily: ${dailyPath}`);
    } catch (e) {
      if (!stillActive()) return;
      addLog('error', `Failed to compress global daily log for ${dateStr}`, e.message);
    }

    // ── 第三步：从各群缓冲中删除已压缩日期的条目 ──
    for (const { target, bufferPath } of targetEntries) {
      if (!stillActive()) return;
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
  if (!stillActive()) return;
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
  // 配置里可能存着用户粘进来的 Telegram 链接。不在这里换成规范 ID，MCP 回来的
  // 结果对不上号、以 target 命名的文件也写不进去，见 normalizeTargetId。
  config = {
    ...config,
    watchedGroups: normalizeTargetIds(config.watchedGroups),
    watchedFriends: normalizeTargetIds(config.watchedFriends),
  };
  const restartingSamePet = activeLoop?.petId === config.petId;
  const carriedKnownTargets = restartingSamePet ? new Set(knownTargets) : new Set();
  const carriedLurkModes = restartingSamePet ? new Map(lurkModes) : new Map();
  const carriedPausedTargets = restartingSamePet ? new Map(pausedTargets) : new Map();
  // 先停止现有循环
  stopSocialLoop();
  const loopGeneration = ++socialLoopGeneration;
  startingPetId = config.petId;
  const startupStillCurrent = () => socialLoopGeneration === loopGeneration;
  const abortStartup = () => {
    if (startupStillCurrent()) startingPetId = null;
    return false;
  };

  // 通知 SocialPage 重置 PromptCachePanel 的会话累计
  tauri.emitToLabels(['social', 'management'], 'social-cache-stats-reset', { petId: config.petId });

  // Seed 工具详细说明 .md 文件（仅当不存在时写入默认版本）
  try { await seedToolDocs(config.petId); } catch (e) { console.warn('[seedToolDocs] failed:', e); }
  if (!startupStillCurrent()) return false;

  addLog('info', `Starting social loop for pet: ${config.petId}`);
  
  // 恢复持久化的 lurk modes
  try {
    const savedModes = await loadLurkModes(config.petId);
    if (!startupStillCurrent()) return false;
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
  if (restartingSamePet) {
    for (const target of carriedKnownTargets) lurkModes.delete(target);
    for (const [target, mode] of carriedLurkModes) lurkModes.set(target, mode);
  }

  // 初始化用户自定义群规则（从 config 加载）
  customGroupRulesMap.clear();
  if (config.customGroupRules && typeof config.customGroupRules === 'object') {
    for (const [target, rules] of Object.entries(config.customGroupRules)) {
      if (rules && rules.trim()) customGroupRulesMap.set(target, rules);
    }
  }

  // 初始化训练数据采集白名单（从 config 加载）
  trainingTargetsMap.clear();
  if (config.trainingTargets && typeof config.trainingTargets === 'object') {
    for (const [tid, enabled] of Object.entries(config.trainingTargets)) {
      trainingTargetsMap.set(String(tid), !!enabled);
    }
  }
  // Seed the global toggle from config so the running loop starts with the right value
  _currentTrainingCollectionEnabled = !!config.trainingCollectionEnabled;

  // 注册所有已知 target（用于持久化 enabled 状态）
  const allTargetIds = [
    ...(config.watchedGroups || []).map(g => g.trim()).filter(Boolean),
    ...(config.watchedFriends || []).map(f => f.trim()).filter(Boolean),
  ];
  for (const t of allTargetIds) knownTargets.add(t);

  // 重置每个 target 的 Intent 状态感知文件，并清空 scratch 临时工作目录（不跨会话持久化）
  try {
    const INTENT_INITIAL = '# 当前状态感知\n\n（本次会话开始，尚无记录）\n';
    const watchedGroupSet = new Set((config.watchedGroups || []).map(g => g.trim()).filter(Boolean));
    for (const t of allTargetIds) {
      if (!startupStillCurrent()) return false;
      const dir = watchedGroupSet.has(t) ? 'group' : 'friend';
      await tauri.workspaceWrite(config.petId, `social/${dir}/INTENT_${t}.md`, INTENT_INITIAL);
      // 清空 scratch 文件夹
      try {
        const entries = await tauri.workspaceListDir(config.petId, `social/${dir}/scratch_${t}`);
        if (entries && entries.length > 0) {
          for (const entry of entries) {
            // 保留 lessons.json 和 principles.md（跨会话持久化），其他全部清空
            const filename = entry.split('/').pop();
            if (!entry.endsWith('/') && filename !== 'lessons.json' && filename !== 'principles.md') {
              await tauri.workspaceDeleteFile(config.petId, entry);
            }
          }
        }
      } catch { /* 目录不存在，忽略 */ }
    }
  } catch (e) {
    addLog('warn', 'Failed to reset Intent state files', e.message);
  }

  // 恢复持久化的 paused targets（首次启动时全部暂停）
  try {
    const savedPaused = await loadPausedTargets(config.petId);
    if (!startupStillCurrent()) return false;
    if (savedPaused && typeof savedPaused === 'object') {
      // 有保存的状态 → 恢复（已知 target 使用保存的值；全新 target 默认暂停）
      for (const t of allTargetIds) {
        if (t in savedPaused) {
          // 曾经保存过此 target 的状态，直接使用
          if (savedPaused[t]) pausedTargets.set(t, true);
          // savedPaused[t] === false → 已开启，不加入 pausedTargets
        } else {
          // 全新 target（从未出现在已保存数据中）→ 默认暂停
          pausedTargets.set(t, true);
        }
      }
      addLog('info', `Restored paused state: ${pausedTargets.size} target(s) paused, ${allTargetIds.length - pausedTargets.size} enabled`);
    } else {
      // 首次启动 → 全部暂停
      for (const t of allTargetIds) {
        pausedTargets.set(t, true);
      }
      addLog('info', `First launch: all ${allTargetIds.length} target(s) paused by default`);
    }
  } catch (e) {
    addLog('warn', 'Failed to restore paused targets', e.message);
    // 出错也全部暂停，安全第一
    for (const t of allTargetIds) {
      pausedTargets.set(t, true);
    }
  }
  if (restartingSamePet) {
    for (const target of carriedKnownTargets) {
      pausedTargets.delete(target);
      if (carriedPausedTargets.get(target)) pausedTargets.set(target, true);
    }
  }
  if (!startupStillCurrent()) return false;
  
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
      return abortStartup();
    }
  } catch (e) {
    addLog('error', `Failed to start MCP server "${config.mcpServerName}"`, typeof e === 'string' ? e : e.message);
    return abortStartup();
  }
  if (!startupStillCurrent()) return false;
  
  // 解析 API provider — Reply (主模型)
  const replyLLMConfig = await resolveApiProvider(config.apiProviderId, config.modelName);
  if (!replyLLMConfig) {
    addLog('error', 'Cannot start: API provider not resolved');
    return abortStartup();
  }

  // 解析 Observer API provider（独立时用独立配置，否则用 Reply）
  let observerLLMConfig = replyLLMConfig;
  if (config.observerApiProviderId) {
    const resolved = await resolveApiProvider(config.observerApiProviderId, config.observerModelName || '');
    if (resolved) {
      observerLLMConfig = resolved;
      addLog('info', `Observer LLM resolved: ${resolved.modelName} (${resolved.apiFormat})`);
    } else {
      addLog('warn', 'Observer API provider not resolved, falling back to Reply LLM');
    }
  }

  // 解析 Intent API provider（独立时用独立配置，否则用 Reply + 可选模型名覆盖）

  // 解析 Compress API provider（独立时用独立配置，否则用 Reply）
  let compressLLMConfig = replyLLMConfig;
  if (config.compressApiProviderId) {
    const resolved = await resolveApiProvider(config.compressApiProviderId, config.compressModelName || '');
    if (resolved) {
      compressLLMConfig = resolved;
      addLog('info', `Compress LLM resolved: ${resolved.modelName} (${resolved.apiFormat})`);
    } else {
      addLog('warn', 'Compress API provider not resolved, falling back to Reply LLM');
    }
  }

  // 解析 Vision API provider（图片预描述用）
  let visionLLMConfig = null;
  if (config.imageDescMode && config.imageDescMode !== 'off') {
    const visionProviderId = config.imageDescMode === 'self'
      ? config.apiProviderId
      : (config.imageDescProviderId || config.apiProviderId);
    const visionModelName = config.imageDescMode === 'self'
      ? config.modelName
      : (config.imageDescModelName || '');
    if (visionProviderId) {
      visionLLMConfig = await resolveApiProvider(visionProviderId, visionModelName);
      if (visionLLMConfig) {
        addLog('info', `Vision LLM resolved: ${visionLLMConfig.modelName} (${visionLLMConfig.apiFormat})`);
      } else {
        addLog('warn', 'Vision API provider not resolved, image pre-description disabled');
      }
    }
  }

  // 解析 Image Generation provider（generate_image_send 工具用）
  // imageGenConfig: { enabled, providerId, modelName }
  let imageGenLLMConfig = null;
  if (config.imageGenConfig?.enabled && config.imageGenConfig?.providerId && config.imageGenConfig?.modelName) {
    const resolved = await resolveApiProvider(config.imageGenConfig.providerId, config.imageGenConfig.modelName);
    if (resolved) {
      imageGenLLMConfig = {
        modelName: resolved.modelName,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
      };
      addLog('info', `Image Gen LLM resolved: ${resolved.modelName}`);
    } else {
      addLog('warn', 'Image Gen API provider not resolved, generate_image_send disabled');
    }
  }

  // 为 MCP 服务器设置 Sampling LLM 配置（使用 Compress 配置）
  // 这样当 QQ MCP 的 compress_context 需要 Sampling 时，Tauri 能代理调用 LLM
  try {
    const server = await tauri.mcp.getServerByName(config.mcpServerName);
    if (server?._id) {
      await tauri.mcp.setSamplingConfig(server._id, {
        api_key: compressLLMConfig.apiKey,
        model: compressLLMConfig.modelName,
        base_url: compressLLMConfig.baseUrl || null,
        api_format: compressLLMConfig.apiFormat || 'openai_compatible',
      });
      addLog('info', `Sampling config set for MCP server "${config.mcpServerName}" (using ${compressLLMConfig === replyLLMConfig ? 'Reply' : 'Compress'} LLM)`);
    }
  } catch (e) {
    addLog('warn', `Failed to set sampling config: ${e.message || e}`);
    // 非致命错误，继续启动
  }
  
  // 启动额外的 MCP 服务器
  const extraMcpServers = config.enabledMcpServers || [];
  for (const extraName of extraMcpServers) {
    if (!startupStillCurrent()) return false;
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
  if (!startupStillCurrent()) return false;

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
    return abortStartup();
  }
  
  addLog('info', `Watching ${targets.length} targets, reply: ${config.replyInterval ?? 0}s, observer: ${config.observerInterval || 180}s`);
  
  const promptConfig = {
    // 社交补充人设和可编辑的回复策略已下线：只用人格文件和内置默认策略。
    socialPersonaPrompt: '',
    atMustReply: config.atMustReply !== false,
    agentCanEditStrategy: false,
    botQQ: config.botQQ || '',
    ownerQQ: config.ownerQQ || '',
    ownerName: config.ownerName || '',
    enabledMcpServers: config.enabledMcpServers || [],
    // customGroupRules 从 live map 读取（支持运行时热更新）
  };
  
  // 状态打标（"敬酒系统"）配置。关掉时整条链路不产生任何调用、也不渲染标签。
  const moodConfig = {
    enabled: config.moodTagConfig?.enabled === true && !!config.moodTagConfig?.apiKey,
    apiKey: config.moodTagConfig?.apiKey || '',
    model: config.moodTagConfig?.model || 'jev-latest',
  };
  if (moodConfig.enabled) {
    addLog('info', `🏷️ 状态打标已启用（${moodConfig.model}）`);
  }

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
  // 上次 append 到群缓冲的 compressed_summary（用于去重，避免累积摘要重复写入）
  const lastAppendedSummary = new Map();
  // 已消费的 @me message_id：每条 @me 只触发一次瞬回，防止旧 @me 反复绕过冷却
  const consumedAtMe = new Map(); // target → Set<message_id>
  // Fetcher → Processor 共享数据缓冲：target → MessageBuffer
  // MessageBuffer 按 message_id 去重累积消息，不覆盖
  const dataBuffer = new Map(); // target → { messages: [], metadata: {}, compressedSummary, seenIds: Set }
  const BUFFER_HARD_CAP = 500; // 安全阀：单 target 最大缓存消息数
  // Intent 读取的消息窗口。同时也是 base64 图片在 buffer 里的保留窗口 ——
  // 两者必须一致：保留得比读取窗口少会让 Intent 看不到图，多则是白占内存。
  const INTENT_IMAGE_WINDOW = 64;
  const BUFFER_COMPRESS_THRESHOLD = 30; // 旧消息超过此数触发 compress
  // Fetcher 的定时器 ID
  let fetcherTimeoutId = null;
  // loopGeneration 在异步启动前生成；stop 即使发生在 STARTING 阶段也会使其失效。
  let dailyCompressTimeoutId = null; // 每日压缩定时器
  let socialWatchdogTimeoutId = null; // 看门狗定时器（Intent 循环 + Fetcher 链）
  let fetcherTickAt = Date.now();     // Fetcher 最近一次开始拉取的时间（看门狗用）
  let watchdogScheduledAt = Date.now(); // 本次看门狗 tick 是什么时候排进去的（算漂移用）
  const isRuntimeGenerationCurrent = () =>
    socialLoopGeneration === loopGeneration && activeLoop?._generation === loopGeneration;
  const canTargetDispatch = (target, { allowFullLurk = false } = {}) =>
    isRuntimeGenerationCurrent()
    && !pausedTargets.get(target)
    && (allowFullLurk || (lurkModes.get(target) || 'normal') !== 'full-lurk');
  
  // ============ 层4: Intent Loop 状态（每群独立） ============
  const intentMap = new Map();                // target → IntentState { lastPlan, lastEvalTime, loopTimeoutId, _wake, forceEval }

  const INTENT_EVAL_COOLDOWN_MS = 60 * 1000;  // semi-lurk / full-lurk 模式的评估冷却
  const INTENT_MIN_INTERVAL_MS = 0;            // 无冷却，新消息立刻触发 eval
  const INTENT_IDLE_SLEEP_MS = 3 * 60 * 1000;    // 3 分钟无新消息 → 休眠
  const INTENT_LLM_MAX_RETRIES = 3;             // LLM 调用失败后最多重试 3 次
  const INTENT_RETRY_DELAYS = [5000, 25000, 125000];           // 默认退避 5s/25s/125s
  const INTENT_RETRY_DELAYS_OVERLOAD = [32000, 64000, 128000]; // 上游 503/UNAVAILABLE 时用更长退避
  const INTENT_WATCHDOG_CHECK_MS = 30 * 1000;      // 看门狗巡检间隔
  // 停滞判定阈值：必须大于"最慢但正常"的一轮 eval。心跳打在每次工具调用/重试上，
  // 单次 LLM 请求受后端 180s 超时约束，重试退避最长 128s——10 分钟没有任何心跳
  // 只可能是真的卡死了。
  const INTENT_WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;
  // Fetcher 正常每 BATCH_POLL_INTERVAL_MS 一轮、单轮受 10s 工具超时约束；
  // 2 分钟没开始新一轮说明 setTimeout 链断了（未捕获异常 / invoke 永不 settle）。
  const FETCHER_WATCHDOG_TIMEOUT_MS = 2 * 60 * 1000;
  // 看门狗自己迟到多少算"整个 webview 刚被挂起过"。正常抖动在毫秒级。
  const WATCHDOG_DRIFT_REPORT_MS = 5 * 1000;
  const intentWatermarks = new Map();            // target → lastProcessedMessageId（用于 normal 模式新消息检测）
  // Reply 并发机制（inFlightReplies / MAX_CONCURRENT_REPLY / 僵死槽位回收）已随
  // session 化删除：实测 4483 次 Reply 里 97.4% 并发度为 1，只有 4 次摸到上限 3。
  // 现在一个 target 一条 session 串行跑，多条回复在同一个 turn 内顺序发出。

  // === Lessons Review 机制 ===
  // 暂未接入 session 循环（消耗偏大，先留着不用）。保留完整实现是为了将来
  // 想复用时不用从 git 历史里刨；接线点是 runSessionTurn 收尾处。
  const LESSONS_MAX_WAIT_MS = 30 * 60 * 1000;       // 最长 30 分钟必须 review
  const pendingReviews = new Map();                  // target → [{ intentSnapshot, replyTime, chatSnapshot }]
  const lessonsReviewTimers = new Map();             // target → setTimeout id（30 分钟兜底计时器）

  /**
   * 快照 INTENT 文件 + 对话记录，加入待 review 队列
   */
  // eslint-disable-next-line no-unused-vars -- 见上：lessons review 暂时保留不接线
  const snapshotForReview = async (target, targetType) => {
    try {
      if (!isRuntimeGenerationCurrent()) return;
      const intentDir = socialTargetDir(targetType);
      const intentContent = await tauri.workspaceRead(config.petId, `social/${intentDir}/INTENT_${target}.md`).catch(() => '');
      if (!isRuntimeGenerationCurrent()) return;
      const buf = dataBuffer.get(target);
      const messages = buf ? buf.messages.slice(-30) : []; // 最近 30 条作为上下文
      const chatSnapshot = messages.map(m => {
        const isBotMsg = m.sender_id === config.botQQ;
        const name = isBotMsg ? '[BOT]' : (m.sender_name || m.sender_id);
        return `[${name}] ${m.content || ''}`;
      }).join('\n');

      if (!pendingReviews.has(target)) pendingReviews.set(target, []);
      pendingReviews.get(target).push({
        intentSnapshot: intentContent,
        replyTime: Date.now(),
        chatSnapshot,
      });

      // 设置 30 分钟兜底计时器（如果没有的话）
      if (!lessonsReviewTimers.has(target)) {
        const timerId = setTimeout(() => {
          lessonsReviewTimers.delete(target);
          dispatchLessonsReview(target, targetType);
        }, LESSONS_MAX_WAIT_MS);
        lessonsReviewTimers.set(target, timerId);
      }
    } catch (e) {
      if (!isRuntimeGenerationCurrent()) return;
      addLog('warn', `Lessons snapshot failed: ${e.message}`, null, target);
    }
  };

  /**
   * 发起 Lessons Review Subagent
   */
  const dispatchLessonsReview = async (target, targetType) => {
    if (!isRuntimeGenerationCurrent() || pausedTargets.get(target)) return;
    const reviews = pendingReviews.get(target);
    if (!reviews || reviews.length === 0) return;

    // 取出所有待 review 并清空队列
    const batch = reviews.splice(0, reviews.length);
    pendingReviews.delete(target);

    // 清除兜底计时器
    const timerId = lessonsReviewTimers.get(target);
    if (timerId) { clearTimeout(timerId); lessonsReviewTimers.delete(target); }

    const dir = socialTargetDir(targetType);
    const taskId = `lr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      // 读取当前 lessons + principles
      const lessonsContent = await tauri.workspaceRead(config.petId, `social/${dir}/scratch_${target}/lessons.json`).catch(() => '');
      const principlesContent = await tauri.workspaceRead(config.petId, `social/${dir}/scratch_${target}/principles.md`).catch(() => '');

      // 构建 review 输入
      const reviewSections = batch.map((r, i) => {
        const time = new Date(r.replyTime).toLocaleTimeString();
        return `### Reply ${i + 1} (${time})\n\n**INTENT 文件（bot 当时的判断）：**\n${r.intentSnapshot || '（无）'}\n\n**对话记录：**\n${r.chatSnapshot || '（无）'}`;
      }).join('\n\n---\n\n');

      const nowDate = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

      const claudeMd = `# Reflect Task

当前日期：${nowDate}

你是一个独立的行为分析师。你的任务是分析 [BOT] 在群聊中的行为表现，更新教训记录和核心原则。

## 系统限制（bot 的能力边界，不要把系统限制当成 bot 的错误）
- 图片和文字消息无法合并为一条发送，图片（image action）和回复（reply action）是两个独立动作，分开发送是正常行为
- bot 无法编辑已发送的消息，只能发新消息
- bot 无法撤回已发送的消息
- bot 无法看到谁在打字、谁在线
- 消息有延迟，bot 看到的消息可能不是最新的

## 待 Review 的行为（共 ${batch.length} 轮）

${reviewSections}

## 当前教训文件 (lessons.json)

\`\`\`json
${lessonsContent || '[]'}
\`\`\`

## 当前核心原则 (principles.md)

${principlesContent || '（空）'}

## 你的工作

### 1. 分析每轮 Reply 的效果
对照 INTENT 文件（bot 的意图）和对话记录（实际效果），判断 bot 这轮行为有没有问题：
- 有没有被无视、被反驳、被嫌话多、被说杠？
- 有没有打断别人、抢话、自说自话？
- 有没有说错事实、误导别人？
- 时机和语气合适吗？
- 只关注负面问题。表现正常或好的不需要记录。

### 2. 更新 lessons.json（只记负面教训）
JSON 数组格式，每条：
\`\`\`json
{"problem": "什么行为在什么场景下出了问题", "action": "什么情况该做什么、什么情况不该做什么", "count": N, "lastDate": "YYYY-MM-DD"}
\`\`\`
- problem：写清楚具体行为和场景（如"对方还在连续发言时插话打断"），但不要复述具体事件经过或绑定具体人名
- action：写清楚判断标准和行为指导（如"同一人连发多条时等对方说完再回应，不要看到第一条就急着回"），要让 bot 看了知道什么时候该做什么时候不该做
- count：触发次数
- lastDate：最近触发日期
- 相似问题合并（按 problem 语义匹配，更新 count、lastDate，action 可更新为更好的表述）
- 控制在 15 条以内
- 如果本轮没有负面问题，保持原样不新增

### 3. 更新 principles.md（如果需要）
当同一 problem 主题下的教训总触发次数（相关条目的 count 之和）达到 50 次：
- 把相关 lessons 合并提炼为一条核心原则
- 原则要写清楚：什么场景 + 具体怎么做 + 为什么。把 lessons 里积累的 action 合并成完整的行为指南
- 提炼后从 lessons.json 删除被吸收的条目
- 核心原则控制在 8 条以内

每条 principle 的格式：先写总则，再列出不同情境下的具体动作（该回应/无视/用工具/截图等）。

示例——假设 lessons.json 中有以下相关条目（count 之和 ≥ 50）：
\`\`\`
(45次) 未核实就下技术结论，忽略已有的反例 → 发表前先检查有没有反例或补充说明
(35次) 对自身底层架构凭直觉猜测，被当场纠正 → 不确定时先查代码确认再说
(25次) 被纠正的技术错误在后续回复中再次犯 → 被纠正过的错误记住不要重复
\`\`\`

提炼为 principles.md 中的一条：
\`\`\`
技术判断必须有依据：发表观点前先核实有没有反例或已有的补充信息，没把握的技术细节宁可不说。
→ 不确定时：先 dispatch CC 查证据或用 Tavily 搜索，拿到数据再发言
→ 被当场纠正时：立刻认错，不要辩解或找借口
→ 有数据支撑时：正常发言，附上来源 URL 或 webshot 截图佐证
→ 涉及自身架构时：先查代码确认，不要凭直觉猜
\`\`\`

再一个示例：
\`\`\`
(50次) 同一内容或高度相似的观点重复发送多次 → 同一观点说一次就够
(30次) 对方还在连续发言时插话打断 → 等对方说完再回应
(25次) 群聊话题转移时强行拉回旧话题 → 跟随自然话题流转
\`\`\`

提炼为：
\`\`\`
控制发言节奏和频率：说话的时机和频率比内容更重要。
→ 同一观点已经说过：不再重复，无视这个冲动
→ 对方还在连续发消息：等对方说完再回应，不要看到第一条就急着回
→ 群聊话题自然转移了：跟随新话题，不要强行拉回旧话题
→ 被要求少说话时：立即降低频率，简短回应表示收到
\`\`\`

### 4. 违反检测
如果 bot 的行为违反了已有核心原则：
- 不要写入 lessons.json（那是重复信息）
- 直接在 principles.md 中加强该原则，在末尾追加违反记录：
  ⚠️ 原则内容（最近违反：日期 简述什么行为违反了）
- 连续 3 次以上违反升级为：
  🚫 原则内容（连续N次违反，上次：日期）

## Output

1. 把修改后的 lessons 写入 output/lessons.json（必须是 valid JSON 数组）
2. 把修改后的 principles 写入 output/principles.md
3. **验证**：写完 output/lessons.json 后，用 Read 工具读回来，确认是 valid JSON。如果解析失败，修复后重新写入。

只输出文件内容，不要输出分析过程。
`;

      // 写入 subagent workspace
      await tauri.workspaceWrite(config.petId, `subagents/${taskId}/CLAUDE.md`, claudeMd);
      await tauri.workspaceWrite(config.petId, `subagents/${taskId}/output/.gitkeep`, '');

      const cwd = await tauri.workspaceGetPath(config.petId, `subagents/${taskId}`, false);

      if (!isRuntimeGenerationCurrent() || pausedTargets.get(target)) return;
      await tauri.subagentSpawn(
        taskId,
        cwd,
        config.subagentModel || 'sonnet',
        300, // 5 分钟超时
        claudeMd,
      );

      // 注册到 subagentRegistry
      subagentRegistry.set(taskId, {
        status: 'running',
        task: `Lessons review (${batch.length} replies)`,
        petId: config.petId,
        target,
        targetType,
        dir,
        source: 'lessons', // 特殊标记，区别于 'social'
        createdAt: Date.now(),
      });

      addLog('reflect', `🪞 Reflect dispatched (${batch.length} replies)`, JSON.stringify({ taskId, replyCount: batch.length, status: 'dispatched' }), target);
    } catch (e) {
      if (!isRuntimeGenerationCurrent()) return;
      addLog('warn', `Reflect dispatch failed: ${e.message}`, null, target);
    }
  };

  /** 获取/创建某群的 IntentState */
  const getIntentState = (target) => {
    if (!intentMap.has(target)) {
      intentMap.set(target, {
        lastPlan: null,       // 最新 write_intent_plan args（供 Reply 读取 atTarget/replyTo）
        lastEvalTime: 0,
        loopTimeoutId: null,
        _wake: null,          // 可中断 sleep 的 resolve 回调
        forceEval: null,      // 强制评估来源: null | 'reply' | 'subagent' | 'newmsg'
        postReplyRestUntil: 0, // Reply 发完后的休息截止时间（20s 内有新消息则提前结束）
        // ── 看门狗字段 ──
        heartbeatAt: Date.now(), // 最近一次"取得进展"的时间戳；卡在 await 里就不再更新
        epoch: 0,               // 循环代次；看门狗重启时 +1，旧实例解冻后凭此自杀
        targetType: null,       // 供看门狗重启时复用
      });
    }
    return intentMap.get(target);
  };

  /**
   * 心跳：标记该 target 的 Intent 循环"仍在推进"。
   * 必须打在每个可能长时间阻塞的 await 前后，以及 LLM 工具回调里——
   * 这样一次正常的慢 eval（重试退避可达数分钟）不会被看门狗误判，
   * 而真正永久挂起的 await 一定会让心跳停滞。
   */
  const touchIntent = (state) => {
    if (state) state.heartbeatAt = Date.now();
  };

  /** 可中断的延迟（用于 intentLoop，支持通过 state._wake 提前唤醒） */
  const sleepInterruptible = (state, ms) => new Promise(r => {
    state._wake = r;
    state.loopTimeoutId = setTimeout(r, ms);
  });

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
    const editEvents = [];
    for (const msg of newMessages) {
      const id = msg.message_id;
      if (id && buf.seenIds.has(id)) {
        // 去重——但被编辑过的要更新内容，并补一条编辑事件，见 messageEdits.js
        const existing = msg.edited ? buf.messages.find(m => m.message_id === id) : null;
        const event = applyIncomingEdit(existing, msg);
        if (event && !buf.seenIds.has(event.message_id)) editEvents.push(event);
        continue;
      }
      if (id) buf.seenIds.add(id);
      buf.messages.push(msg);
      added++;
    }
    for (const event of editEvents) {
      buf.seenIds.add(event.message_id);
      buf.messages.push(event);
      added++;
    }

    // 纯追加只在"MCP 返回的一定有序"时成立。qq-mcp 把历史回填改成后台任务之后
    // 这个前提破了：回填完成时插进来的几十条历史，对这里是"没见过的"，会被
    // 追加到实时消息**后面**。排一道底，让下游所有按下标切片的地方仍然安全。
    if (added > 0) sortByTime(buf.messages);
    
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


  /** 检查 intentWatermarks 之后是否有非自身的新消息（不更新水位线）*/
  const hasNewNonSelfMessages = (target) => {
    const buf = dataBuffer.get(target);
    if (!buf || buf.messages.length === 0) return false;
    const messages = buf.messages;
    const lastMsgId = intentWatermarks.get(target);
    let wmIdx = -1;
    if (lastMsgId) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].message_id === lastMsgId) { wmIdx = i; break; }
      }
    }
    const newMessages = wmIdx >= 0 ? messages.slice(wmIdx + 1) : messages;
    return newMessages.some(m => !m.is_self);
  };

  function getLastNonSelfMessageTime(target) {
    const buf = dataBuffer.get(target);
    if (!buf || buf.messages.length === 0) return 0;
    for (let i = buf.messages.length - 1; i >= 0; i--) {
      const msg = buf.messages[i];
      if (!msg.is_self && msg.timestamp) {
        return new Date(msg.timestamp).getTime() || 0;
      }
    }
    return 0;
  }

  // ============ 层4: Intent Loop — 每群独立意图循环 ============

  /**
   * eval 完成后，并行预取当前 buffer 中发言人的人物档案，写入缓存文件供下次 eval 注入。
   * fire-and-forget，不阻塞 eval 流程。
   */
  /**
   * 异步整理 markdown 文件（fire-and-forget）
   * 启动一个轻量 LLM 调用，只给 social_read + social_edit 两个工具
   */
  const dispatchMdOrganizer = ({ file, context: fileContext, instruction }) => {
    // fire-and-forget — 不阻塞调用者
    (async () => {
      try {
        if (!isRuntimeGenerationCurrent()) return;
        // 只给 social_read 和 social_edit 工具
        const readDef = getSocialFileToolDefinitions().find(t => t.function.name === 'social_read');
        const editDef = getSocialFileToolDefinitions().find(t => t.function.name === 'social_edit');
        const tools = [readDef, editDef].filter(Boolean).map(t => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
          serverName: null,
        }));

        const systemPrompt = `你是一个 Markdown 文件整理助手。你有 social_read 和 social_edit 两个工具。
根据指令读取并整理指定文件。用 social_edit 做精确修改，不要全量覆写。
完成后不需要输出任何文字。`;

        const userMsg = `文件路径：${file}
${fileContext ? `\n文件说明：${fileContext}\n` : ''}
指令：${instruction}

请先用 social_read("${file}") 读取文件内容，然后根据指令用 social_edit 修改。`;

        // 使用 Intent 的 LLM 配置（便宜的模型）
        await callLLMWithTools({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ],
          apiFormat: replyLLMConfig.apiFormat,
          apiKey: replyLLMConfig.apiKey,
          model: replyLLMConfig.modelName,
          baseUrl: replyLLMConfig.baseUrl,
          mcpTools: tools,
          options: {
            temperature: 0.2,
            explicitCache: shouldUseExplicitCache(config, replyLLMConfig.apiFormat),
            cacheKey: buildCacheKey(config.petId, '', 'MdOrganizer'),
          },
          builtinToolContext: { petId: config.petId },
          toolCallFilter: () => isRuntimeGenerationCurrent()
            ? null
            : 'Markdown organizer 已取消：Social Agent 已停止。',
          maxIterations: 10,
          usageLabel: 'MdOrganizer',
          usagePetId: config.petId,
          onUsageLogged: (record) => {
            if (isRuntimeGenerationCurrent()) logUsageRecord(record);
          },
        });
        if (!isRuntimeGenerationCurrent()) return;
        addLog('info', `📝 md_organize done: ${file}`, null);
      } catch (e) {
        if (!isRuntimeGenerationCurrent()) return;
        addLog('warn', `md_organize error: ${file}: ${e.message || e}`, null);
      }
    })();
  };

  const updatePeopleCache = async (target, targetType) => {
    if (!isRuntimeGenerationCurrent()) return;
    const buf = dataBuffer.get(target);
    if (!buf || buf.messages.length === 0) return;
    const qqs = [...new Set(
      buf.messages
        .filter(m => !m.is_self && m.sender_id)
        .map(m => String(m.sender_id))
    )];
    if (qqs.length === 0) return;
    const profiles = await Promise.all(qqs.map(async qq => {
      try {
        const content = await tauri.workspaceRead(config.petId, `social/people/${qq}.md`);
        if (!content) return null;
        // 只取前 300 字作为简介，避免撑大 context
        const brief = content.trim();
        return `- ${qq}: ${brief}`;
      } catch { return null; }
    }));
    const combined = profiles.filter(Boolean).join('\n\n');
    if (!combined || !isRuntimeGenerationCurrent()) return;
    const dir = socialTargetDir(targetType);
    await tauri.workspaceWrite(config.petId, `social/${dir}/PEOPLE_CACHE_${target}.md`, combined);
  };


  /**
   * VLM 关闭时的图片预处理：把 buffer 里的图 resolve 成 base64 就地写回，
   * 让 Intent 也能看到原图而不是一句 "[图片]"。
   *
   * 只对最近 `INTENT_IMAGE_WINDOW` 条消息保留 base64，滑出窗口的换回原始 URL。
   * buffer 硬上限是 500 条，而 Intent 只读最近 64 条 —— 不回收的话，几百条
   * 消息的图片数据会一直压在内存里，且永远不会被读到。真需要时
   * `resolveImageUrls` 的 LRU 缓存还在，换回来几乎没有代价。
   */
  const resolveBufferImagesInPlace = async (buf, target) => {
    const total = buf.messages.length;
    const windowStart = Math.max(0, total - INTENT_IMAGE_WINDOW);
    let resolvedCount = 0;

    for (let i = 0; i < total; i++) {
      const msg = buf.messages[i];
      if (msg.is_self || !msg._images || msg._images.length === 0) continue;

      if (i < windowStart) {
        // 滑出窗口：退回原始 URL 形态，把 base64 占的内存还回去
        if (msg._images.some(img => !String(img.data || '').startsWith('http'))) {
          msg._images = (msg.image_urls || []).map(url => ({ data: url, mimeType: 'image/jpeg' }));
        }
        continue;
      }

      if (!msg._images.some(img => String(img.data || '').startsWith('http'))) continue;
      try {
        const resolved = await resolveImagesForModel(msg._images);
        // resolveImageUrls 会丢弃下载失败或非图片的条目，所以可能变短甚至为空。
        // 一张都没拿到就保留原始 URL，下次再试——写成空数组的话，后面所有读
        // buffer 的地方都当它「没有图」，这张图就永久消失了
        if (resolved.length === 0) {
          addLog('warn', `🖼️ msg=${msg.message_id} 的 ${msg._images.length} 张图都没下载下来，下次再试`, null, target);
          continue;
        }
        msg._images = resolved;
        resolvedCount += resolved.length;
      } catch (e) {
        addLog('warn', `Image resolve failed for ${target} msg=${msg.message_id}`, e.message || e, target);
      }
    }

    if (resolvedCount > 0) {
      addLog('info', `🖼️ Resolved ${resolvedCount} image(s) to base64 for ${target} (VLM off, sending originals)`, null, target);
    }
  };

  /**
   * 在 Intent 评估前批量预处理 buffer 中未描述的图片
   * 结果写入 buffer 消息的 _imageDescs + imageDescCache，
   * 使后续 Observer/Reply 的 pollTarget 直接命中缓存。
   */
  const preprocessBufferImages = async (target) => {
    if (config.enableImages === false) return;
    const buf = dataBuffer.get(target);
    if (!buf || buf.messages.length === 0) return;

    // VLM 关闭时不做描述，但**必须**把图片 resolve 成 base64 写回 buffer。
    //
    // 否则 buffer 里的 _images 一直是 http URL，buildIntentTurns 那道
    // `!img.data.startsWith('http')` 过滤会把它们全部剥掉 —— 于是 Intent 看到的
    // 历史里既没有原图、也没有描述（描述本来就没生成），只剩 QQ 消息原文里的
    // "[图片]" 字面量。VLM 开着时这个缺口被描述文本盖住了，一关就露出来。
    //
    // 走 base64 而不是直接把 URL 交给模型：Gemini 的 inline_data 根本不收 URL，
    // Anthropic 只认 base64，而 QQ 图床对外部服务商也不一定可达
    // （resolveImageUrls 里那句「OpenAI 可能可以但不稳定」就是说这个）。
    if (!config.imageDescMode || config.imageDescMode === 'off' || !visionLLMConfig) {
      await resolveBufferImagesInPlace(buf, target);
      return;
    }

    const botName = targetNamesCache.get(config.botQQ) || config.botQQ || 'bot';
    let describedCount = 0;
    let cachedCount = 0;

    for (let i = 0; i < buf.messages.length; i++) {
      const msg = buf.messages[i];
      if (msg.is_self || msg._imageDescs) continue; // 已处理或自己的消息
      if (!msg._images || msg._images.length === 0) continue;

      // 上下文（用 buffer 内消息构建，不需要很精确）
      const ctxBefore = buf.messages.slice(Math.max(0, i - 5), i)
        .map(m => `${m.sender_name || m.sender_id}: ${m.content || ''}`.trim())
        .join('\n');
      const ctxAfter = buf.messages.slice(i + 1, i + 3)
        .map(m => `${m.sender_name || m.sender_id}: ${m.content || ''}`.trim())
        .join('\n');
      const sender = msg.sender_name || msg.sender_id || 'unknown';

      // 临时 resolve 图片 URL → base64（不保留 base64 数据到 buffer，避免内存膨胀）
      const resolvedImages = await resolveImageUrls(msg._images.map(img => ({ ...img })));

      // 将 resolve 检测到的真实 mimeType 写回 buffer（修正 fetcher 硬编码的 image/jpeg）
      for (let j = 0; j < resolvedImages.length && j < msg._images.length; j++) {
        if (resolvedImages[j].mimeType && resolvedImages[j].mimeType !== msg._images[j].mimeType) {
          msg._images[j].mimeType = resolvedImages[j].mimeType;
        }
      }

      // 并行描述同一条消息内的所有图片
      const descPromises = resolvedImages.map((img, j) => {
        const cacheKey = `${msg.message_id}_${j}`;
        const cachedDesc = msg.message_id ? getCachedImageDesc(cacheKey) : undefined;
        if (cachedDesc !== undefined) {
          cachedCount++;
          return Promise.resolve(cachedDesc);
        }
        if (imageDescInflight.has(cacheKey)) {
          cachedCount++;
          // 同上：复用 inflight 时也要吃掉 reject，避免一张图导致整轮 eval 抛异常
          return imageDescInflight.get(cacheKey).catch(() => '[图片描述失败]');
        }
        const imgData = img.data || '';
        const imgPreview = imgData.startsWith('http') ? imgData.slice(0, 120) : `${img.mimeType || 'unknown'} base64(${Math.round(imgData.length / 1024)}KB)`;
        const wrappedDescribe = () => {
          const p = describeImage(img, ctxBefore, ctxAfter, sender, botName, visionLLMConfig, config.petId);
          imageDescInflight.set(cacheKey, p);
          return p;
        };
        return retryLLM(wrappedDescribe, { label: `Vision-pre [${sender}] img${j}`, target, delays: VISION_RETRY_DELAYS })
          .then(desc => {
            addLog('llm', `🖼️ Vision-pre [${sender}] img${j}`, `input: ${imgPreview}\noutput: ${desc}`, target);
            describedCount++;
            if (msg.message_id) setCachedImageDesc(cacheKey, desc);
            return desc;
          })
          .catch(e => {
            addLog('warn', `Vision-pre desc failed for ${target} msg=${msg.message_id} img=${j}`, e.message || e, target);
            const fallback = '[图片描述失败]';
            if (msg.message_id) setCachedImageDesc(cacheKey, fallback);
            return fallback;
          })
          .finally(() => {
            imageDescInflight.delete(cacheKey);
          });
      });
      const descs = await Promise.all(descPromises);
      if (descs.length > 0) {
        msg._imageDescs = descs;
        // 已描述的图片从 _images 中移除，避免 buildTurnsFromMessages 再把原图发给 LLM
        if (descs.length >= msg._images.length) {
          msg._images = []; // 全部描述成功
        } else {
          msg._images = msg._images.slice(descs.length); // 保留未描述的
        }
      }
    }
    if (describedCount > 0 || cachedCount > 0) {
      addLog('info', `🖼️ Vision-pre: ${describedCount} described, ${cachedCount} cached for ${target}`, null, target);
    }
  };

  /**
   * Intent 看门狗：兜住任何"await 永不返回"导致的静默睡死。
   *
   * Intent 是唯一的发言派发者——它一卡，Fetcher/Observer 日志照刷、状态照显示
   * active，但这个 target 再也不会说话。心跳由 intentLoop 在每个推进点打点；
   * 超过 INTENT_WATCHDOG_TIMEOUT_MS 没有任何进展就判定卡死，bump epoch 让旧实例
   * 解冻后自杀，并原地重启一个新循环（IntentState 复用，lastPlan/水位线不丢）。
   */
  const socialWatchdogTick = () => {
    if (!isRuntimeGenerationCurrent()) return;
    const now = Date.now();

    // ── 定时器漂移 ──
    // 看门狗自己也是 setTimeout 驱动的：webview 被系统挂起时它和被监控对象
    // 一起停摆，醒来后所有"停滞了多久"的墙上时钟差都虚高，下面的判定会误报。
    // 这里只**记录**不干预——保活（keepAwake.js）到底管不管用，看这条就知道：
    // 保活生效后这条日志应该一次都不再出现。
    const tickDrift = now - watchdogScheduledAt - INTENT_WATCHDOG_CHECK_MS;
    if (tickDrift > WATCHDOG_DRIFT_REPORT_MS) {
      addLog(
        'warn',
        `⏱️ 定时器漂移 ${Math.round(tickDrift / 1000)}s —— webview 刚从挂起/阻塞中恢复，本轮停滞判定不可信`,
        `预期 ${INTENT_WATCHDOG_CHECK_MS}ms 后触发，实际 ${now - watchdogScheduledAt}ms`,
      );
    }

    // ── Fetcher 链：断了就没有任何 target 会再收到新消息 ──
    const fetcherStalledMs = now - fetcherTickAt;
    if (fetcherStalledMs > FETCHER_WATCHDOG_TIMEOUT_MS) {
      addLog(
        'error',
        `🐕 看门狗：Fetcher 已 ${Math.round(fetcherStalledMs / 1000)}s 未开始新一轮拉取，重启轮询链`,
      );
      fetcherTickAt = now;
      // scheduleFetcher 会先清掉已有定时器，旧实例若稍后恢复也只会重排出一条链
      scheduleFetcher();
    }

    for (const [target, state] of intentMap) {
      if (!state.targetType) continue;      // 该 target 的循环还没起过
      if (pausedTargets.get(target)) {
        touchIntent(state);                  // 暂停期间不计入卡死
        continue;
      }
      const stalledMs = now - (state.heartbeatAt || 0);
      if (stalledMs <= INTENT_WATCHDOG_TIMEOUT_MS) continue;

      const tName = targetNamesCache.get(target) || target;
      addLog(
        'error',
        `🐕 看门狗：[${tName}] Session 循环已停滞 ${Math.round(stalledMs / 1000)}s，判定卡死并重启`,
        `epoch ${state.epoch} → ${state.epoch + 1}；上次 eval 于 ${state.lastEvalTime ? new Date(state.lastEvalTime).toISOString() : '从未'}`,
        target,
      );
      // 让旧实例失效：它从阻塞中恢复后会在 while 条件 / epoch 检查处退出
      state.epoch++;
      state.heartbeatAt = now;
      if (state.loopTimeoutId !== null) {
        clearTimeout(state.loopTimeoutId);
        state.loopTimeoutId = null;
      }
      if (state._wake) { state._wake(); state._wake = null; }
      state.postReplyRestUntil = 0;
      sessionLoop(target, state.targetType); // fire-and-forget，新 epoch
    }
  };

  const scheduleSocialWatchdog = () => {
    if (!isRuntimeGenerationCurrent()) return;
    watchdogScheduledAt = Date.now();
    socialWatchdogTimeoutId = setTimeout(() => {
      try {
        socialWatchdogTick();
      } catch (e) {
        addLog('warn', `看门狗执行失败: ${e.message || e}`);
      }
      scheduleSocialWatchdog();
    }, INTENT_WATCHDOG_CHECK_MS);
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
    fetcherTickAt = t0; // 心跳：卡在本轮内部时时间戳不再前进，看门狗据此重启轮询链
    const batchToolName = `${config.mcpServerName}__batch_get_recent_context`;
    
    let targetResults = [];
    try {
      const batchArgs = {
        targets: targets.map(t => ({ target: t.target, target_type: t.targetType })),
        limit: dynamicLimit,
      };
      const rawResult = await executeToolByName(batchToolName, batchArgs, { timeout: 10000 });
      if (!isRuntimeGenerationCurrent()) return;
      targetResults = parseBatchResult(rawResult);
    } catch (e) {
      if (!isRuntimeGenerationCurrent()) return;
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
      // 在 appendToBuffer 前记录哪些 bot 自发消息是新的（用于排除自激活）
      const bufRef = getBuffer(target);
      let newSelfCount = 0;
      // 同时收集所有"新消息"（未在 seenIds 中），用于稍后插入 SQLite chat_history
      const trulyNewMsgs = [];
      for (const m of fetchedMessages) {
        if (m.message_id && !bufRef.seenIds.has(m.message_id)) {
          trulyNewMsgs.push(m);
          if (m.is_self) newSelfCount++;
        }
      }
      const added = appendToBuffer(target, fetchedMessages, targetData);

      // ─── 写入 SQLite chat_history（fire-and-forget，不阻塞主流程）───
      if (trulyNewMsgs.length > 0) {
        const targetTypeForDb = targetData.target_type || (targetData.friend_name ? 'friend' : 'group');
        const dbBatch = trulyNewMsgs.map(m => ({
          messageId: String(m.message_id),
          targetId: String(target),
          targetType: targetTypeForDb,
          senderId: String(m.sender_id || ''),
          content: m.content || '',
          timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
          replyToId: m.reply_to ? String(m.reply_to) : null,
          isBot: !!m.is_self,
          rawJson: JSON.stringify(m),
        })).filter(x => x.messageId && x.senderId);
        if (dbBatch.length > 0) {
          tauri.chatHistoryInsertBatch(dbBatch).catch(e => {
            addLog('warn', `chat_history insert failed: ${e.message || e}`, null, target);
          });
        }
      }
      // 排除 bot 所有自发消息，不算作"新活动"（防止自己的回复触发表情包冷却重置）
      const effectiveAdded = added - Math.min(newSelfCount, added);

      // --- 有新消息（排除自己发的消息）→ 清除表情包冷却 + 唤醒 Intent ---
      if (effectiveAdded > 0) {
        // 唤醒 Intent（中断 sleepInterruptible 等待，触发下一轮 detectChange）
        const iState = getIntentState(target);
        if (iState._wake) { iState._wake(); iState._wake = null; }
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
          const configuredTarget = targets.find(t => t.target === target);
          const fetchedTargetType = targetData.target_type || (targetData.friend_name ? 'private' : configuredTarget?.targetType);
          const bufferPath = `social/${socialTargetDir(fetchedTargetType)}/LOG_${target}.md`;
          const timestamp = new Date().toISOString();
          const entry = `\n## ${timestamp}\n${delta}\n`;
          try {
            let existing = '';
            try { existing = await tauri.workspaceRead(config.petId, bufferPath) || ''; } catch { /* 文件不存在 */ }
            await tauri.workspaceWrite(config.petId, bufferPath, existing + entry);
            lastAppendedSummary.set(target, targetData.compressed_summary);
            knownTargets.add(target);
            persistKnownTargetsDebounced(config.petId, knownTargets);
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
    // 先清掉可能已存在的定时器：看门狗重启轮询链后，旧实例若稍后恢复并再次
    // scheduleFetcher，也只会保留一条链，不会出现重复轮询。
    if (fetcherTimeoutId !== null) {
      clearTimeout(fetcherTimeoutId);
      fetcherTimeoutId = null;
    }
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

        // Observer query: 只取水位线之后的新消息 + 最多 OBSERVER_CONTEXT_WINDOW 条旧消息作为上下文
        const OBSERVER_CONTEXT_WINDOW = 20;
        const allMsgs = snapshotBuf ? snapshotBuf.messages : buf.messages;
        const obsWmId = observerWatermarks.get(target);
        let obsWmIdx = -1;
        if (obsWmId) {
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            if (allMsgs[i].message_id === obsWmId) { obsWmIdx = i; break; }
          }
        }
        // 新消息 = 水位线之后的全部；上下文 = 水位线之前最多 N 条
        const contextStart = obsWmIdx >= 0 ? Math.max(0, obsWmIdx - OBSERVER_CONTEXT_WINDOW + 1) : Math.max(0, allMsgs.length - OBSERVER_CONTEXT_WINDOW);
        const observerMessages = allMsgs.slice(contextStart);
        addLog('info', `${label} observer query: ${allMsgs.length} total, wm@${obsWmIdx}, sending ${observerMessages.length} (${obsWmIdx >= 0 ? observerMessages.length - (allMsgs.length - obsWmIdx - 1) : 0} ctx + ${obsWmIdx >= 0 ? allMsgs.length - obsWmIdx - 1 : observerMessages.length} new)`, null, target);

        pollTarget({
          target,
          targetType,
          mcpServerName: config.mcpServerName,
          llmConfig: observerLLMConfig,
          petId: config.petId,
          promptConfig,
          watermarks: observerWatermarks,
          sentCache: sentMessagesCache,
          bufferMessages: observerMessages,
          compressedSummary: snapshotBuf ? snapshotBuf.compressedSummary : buf.compressedSummary,
          groupName: (snapshotBuf || buf).metadata?.group_name || (snapshotBuf || buf).metadata?.friend_name || target,
          consumedAtMeIds: new Set(), // Observer 不消费 @me
          lurkMode: 'full-lurk',      // Observer 始终使用观察模式
          role: 'observer',
          intentPlan: getIntentState(target).lastPlan,
          dispatchGuard: () => isRuntimeGenerationCurrent() && !pausedTargets.get(target),
          enableImages: config.enableImages !== false,
          imageDescMode: config.imageDescMode || 'off',
          visionLLMConfig,
          botName: targetNamesCache.get(config.botQQ) || config.botQQ || 'bot',
          fullBufferMessages: allMsgs,
          socialConfig: config,
        }).then(result => {
          if (!isRuntimeGenerationCurrent()) return;
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
              if (oldCount > BUFFER_COMPRESS_THRESHOLD && isRuntimeGenerationCurrent() && !pausedTargets.get(target)) {
                const compressToolName = `${config.mcpServerName}__compress_context`;
                const tt = targetType || 'group';
                executeToolByName(compressToolName, { target, target_type: tt }, { timeout: 15000 })
                  .then(() => addLog('info', `compress_context triggered for ${target} (${oldCount} old msgs > ${BUFFER_COMPRESS_THRESHOLD})`, null, target))
                  .catch(e => addLog('warn', `compress_context failed for ${target}`, e.message, target));
              }
            }
          }
        }).catch(e => {
          if (!isRuntimeGenerationCurrent()) return;
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
  
  // 异步初始化期间可能收到 stop；旧启动流程不得重新“复活” runtime。
  if (!startupStillCurrent()) return false;

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
      if (socialWatchdogTimeoutId !== null) {
        clearTimeout(socialWatchdogTimeoutId);
        socialWatchdogTimeoutId = null;
      }
      for (const [, iState] of intentMap) {
        if (iState.loopTimeoutId !== null) {
          clearTimeout(iState.loopTimeoutId);
          iState.loopTimeoutId = null;
        }
      }
      for (const timerId of lessonsReviewTimers.values()) clearTimeout(timerId);
      lessonsReviewTimers.clear();
      pendingReviews.clear();
    },
  };
  startingPetId = null;
  
  // === 启动时：加载已知 targets + 检查并执行待处理的每日压缩 ===
  (async () => {
    try {
      const loaded = await loadKnownTargets(config.petId);
      for (const t of loaded) knownTargets.add(t);
      // 也把当前配置的 targets 加入
      for (const t of targets) knownTargets.add(t.target);
      
      // 检查是否有过去日期的群缓冲需要压缩
      if (knownTargets.size > 0) {
        await runDailyCompress(config.petId, compressLLMConfig, knownTargets, config, isRuntimeGenerationCurrent);
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
        await runDailyCompress(config.petId, compressLLMConfig, knownTargets, config, isRuntimeGenerationCurrent);
      } catch (e) {
        addLog('error', 'Daily compression timer failed', e.message);
      }
      // 压缩完成后调度下一次（明天 23:55）
      scheduleDailyCompressTimer();
    }, msUntilTarget);
  };
  
  scheduleDailyCompressTimer();

  // Setup subagent event listeners
  if (SUBAGENTS_ENABLED) {
    await initSubagentListeners({
      petId: config.petId,
      addLog,
      wakeIntent: (target) => {
        const iState = intentMap.get(target);
        if (iState) {
          iState.forceEval = 'subagent';
          if (iState._wake) { iState._wake(); iState._wake = null; }
        }
      },
    });
    if (!isRuntimeGenerationCurrent()) {
      destroySubagentListeners();
      return false;
    }
    if (config.subagentMaxConcurrent) {
      tauri.subagentSetMaxConcurrent(config.subagentMaxConcurrent).catch(() => {});
    }
  }

  // Setup training collection whitelist listener
  if (_unlistenTraining) { _unlistenTraining(); _unlistenTraining = null; }
  const unlistenTraining = await tauri.listen('social-set-training-enabled', (e) => {
    const { target, enabled, petId } = e.payload || {};
    if (petId !== config.petId) return;
    if (target == null) return;
    trainingTargetsMap.set(String(target), !!enabled);
    addLog('info', `Training collection ${enabled ? 'enabled' : 'disabled'} for ${target}`, null, target);
  });
  if (!isRuntimeGenerationCurrent()) {
    unlistenTraining();
    return false;
  }
  _unlistenTraining = unlistenTraining;

  // Setup global training collection toggle listener
  if (_unlistenTrainingGlobal) { _unlistenTrainingGlobal(); _unlistenTrainingGlobal = null; }
  const unlistenTrainingGlobal = await tauri.listen('social-set-training-collection-enabled', (e) => {
    const { enabled, petId } = e.payload || {};
    if (petId !== config.petId) return;
    _currentTrainingCollectionEnabled = !!enabled;
    addLog('info', `Training collection global switch ${enabled ? 'enabled' : 'disabled'}`);
  });
  if (!isRuntimeGenerationCurrent()) {
    unlistenTrainingGlobal();
    return false;
  }
  _unlistenTrainingGlobal = unlistenTrainingGlobal;

  // Listener 注册前发生的 UI toggle 事件可能已经丢失；以持久化 settings
  // 再同步一次，确保启动完成时采用最新的全局开关和 target 白名单。
  try {
    const latestSettings = await tauri.getSettings();
    if (!isRuntimeGenerationCurrent()) return false;
    if (latestSettings?.trainingCollectionEnabled != null) {
      _currentTrainingCollectionEnabled = !!latestSettings.trainingCollectionEnabled;
    }
    if (
      latestSettings?.trainingTargets
      && typeof latestSettings.trainingTargets === 'object'
      && !Array.isArray(latestSettings.trainingTargets)
    ) {
      trainingTargetsMap.clear();
      for (const [target, enabled] of Object.entries(latestSettings.trainingTargets)) {
        trainingTargetsMap.set(String(target), !!enabled);
      }
    }
  } catch (error) {
    addLog('warn', 'Failed to refresh latest training settings', error?.message || error);
  }

  // ============ 层3+4 合并: Session Loop（取代 Intent Loop + Reply Loop） ============
  // 一个 target 一个 session，串行跑 turn。
  //
  // 为什么合并：实测 4483 次 Reply 里 4366 次（97.4%）并发度为 1，只有 4 次摸到
  // 上限 3——为并发付出的复杂度（在途任务伪装、僵死槽位回收、两套水位线、
  // INTENT_*.md 跨调用传状态）几乎全是白付的。串行之后这些全可以去掉，
  // 而且 prompt 前缀在整个 session 内逐字不变，cache 命中率能从 Reply 的 14% 拉上来。
  const sessionMap = new Map();  // target → SocialSession

  /** 所有"会被群友看到"的工具。发送闸门和 full-lurk 禁令共用这一份，避免两处漂移。 */
  const SEND_TOOL_RE = /(send_message|send_image|sticker_send|image_send|webshot_send|voice_send|generate_image_send)/i;
  /** session 内最多跑几轮工具循环。单个 turn 的保险丝。 */
  const SESSION_MAX_ITERATIONS = 30;
  /** 无新消息时的巡检间隔。 */
  const SESSION_IDLE_POLL_MS = 500;
  /** 长时间没人说话后降频。 */
  const SESSION_IDLE_SLEEP_MS = 3 * 60 * 1000;
  /** 发完消息后的冷静期，期间有新消息则提前结束。 */
  const SESSION_POST_SEND_REST_MS = 20 * 1000;
  /** 给 Jev 打标时带多少条上文。32 条足够读出语气，成本约 $0.25/月/群。 */
  const MOOD_CONTEXT_WINDOW = 32;

  const getSession = (target, targetType) => {
    let s = sessionMap.get(target);
    if (!s) {
      s = createSession({ targetId: target, targetType });
      // 安全令牌整个 session 固定：每轮换一次会让 system prompt 逐字变化，
      // 前缀缓存直接作废——这正是原 Reply 只有 14% 命中率的原因之一。
      const rnd = () => crypto.randomUUID().slice(0, 6);
      s.ephemeral = {
        ownerSecret: rnd(),
        nameL: `«${rnd()}»`, nameR: `«/${rnd()}»`,
        msgL: `‹${rnd()}›`, msgR: `‹/${rnd()}›`,
      };
      s.systemPrompt = null;
      s.cursor = createCursor();
      s.selfSentTexts = new Set();
      // 标签是冻结的：标过一次就不再重标。不落盘的话每次重启都要把窗口里的
      // 64 条重标一遍——既花钱，又会出现同一条消息前后两次标得不一样。
      s.moodStore = createMoodTagStore(target, targetType, {
        read: (path) => tauri.workspaceRead(config.petId, path),
        write: (path, content) => tauri.workspaceWrite(config.petId, path, content),
      });
      sessionMap.set(target, s);
      addLog('info', `🧵 [${targetNamesCache.get(target) || target}] session 建立 ${s.sessionId.slice(0, 8)}`, null, target);
    }
    return s;
  };

  /**
   * 游标之后的新消息。游标是**时间**语义而不是数组下标语义——见 messageCursor.js。
   * 游标还没起步（session 刚建）时取最近一个窗口当起点。
   */
  const messagesSince = (target, cursor) => {
    const buf = dataBuffer.get(target);
    if (!buf?.messages?.length) return [];
    if (isCursorUnset(cursor)) return buf.messages.slice(-INTENT_IMAGE_WINDOW);
    return messagesAfter(buf.messages, cursor);
  };

  /**
   * 合并后的工具集 = Intent ∪ Reply。
   *
   * 实测这个并集相对 Intent 只多 675 字节（cc_history + cc_read），所以"工具全给"
   * 在 token 上几乎是免费的。真正的变化是能力打通了：原先 Intent 能发图不能说话、
   * Reply 能说话不能发图，现在一轮里图文可以一起发。
   */
  const buildSessionTools = async (target, lurkMode) => {
    const defs = [
      ...getSocialFileToolDefinitions().filter(t => t.function.name === 'social_read'),
      ...getHistoryToolDefinitions(),
      ...getGroupLogToolDefinitions(),
      getScreenshotToolDefinition(),
      getImageListToolDefinition(),
      getWebshotToolDefinition(),
      getChatSearchToolDefinition(),
      getChatContextToolDefinition(),
      getCheckNewMessagesToolDefinition(),
      getTurnNoteToolDefinition(),
    ];
    if (SUBAGENTS_ENABLED) {
      defs.push(getCcHistoryToolDefinition(), getCcReadToolDefinition());
      defs.push(getSubagentToolDefinition());
      defs.push(getMdOrganizeToolDefinition());
    }
    // full-lurk 下不暴露任何发送工具——只观察。
    if (lurkMode !== 'full-lurk') {
      defs.push(getImageSendToolDefinition());
      defs.push(getWebshotSendToolDefinition());
      defs.push(...getStickerToolDefinitions().filter(t => ['sticker_send', 'sticker_list'].includes(t.function.name)));
      const tts = resolveTts(config.ttsConfig);
      if (tts) defs.push(getVoiceSendToolDefinition(tts.provider));
      if (imageGenLLMConfig) defs.push(getGenerateImageSendToolDefinition());
    }

    let tools = defs.map(t => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
      serverName: null,
    }));

    try {
      const allTools = await getMcpTools();
      const extraServers = new Set(promptConfig.enabledMcpServers || []);
      // 外部 MCP：非 full-lurk 全给（Reply 一侧本来就不过滤）。
      // 只读闸 isReadOnlyIntentExternalTool 保留给「本轮还没决定发言」的场景，见下。
      const external = allTools.filter(t =>
        extraServers.has(t.serverName) && t.serverName !== config.mcpServerName
      );
      if (lurkMode === 'full-lurk') {
        tools = [...tools, ...external.filter(isReadOnlyIntentExternalTool)];
      } else {
        tools = [...tools, ...external];
        // 主 MCP 只取 send_message，并剥掉 num_chunks / split_content——分段统一走 </分段>
        const send = allTools.find(t => t.serverName === config.mcpServerName && t.name === 'send_message');
        if (send) {
          const props = send.inputSchema?.properties || {};
          const { num_chunks: _nc, split_content: _sc, ...rest } = props;
          tools.push({
            ...send,
            inputSchema: {
              ...send.inputSchema,
              properties: rest,
              required: (send.inputSchema?.required || []).filter(k => k !== 'num_chunks' && k !== 'split_content'),
            },
          });
        }
      }
    } catch (e) {
      addLog('warn', 'session 取 MCP 工具失败，本轮只用内置工具', e.message || e, target);
    }
    return tools;
  };

  /** 压缩用的摘要器。用 compress 档模型，不占主模型。 */
  const makeSessionSummarizer = (target) => async ({ priorSummary, items }) => {
    const transcript = toProviderTurns(items)
      .map(m => {
        const text = typeof m.content === 'string' ? m.content : '[多模态内容]';
        // [系统记录] 是 user 侧的流水，不是群友说的话，别在摘要里记成「群里」
        const who = m.role === 'assistant' ? '我' : (text.startsWith(SYSTEM_RECORD) ? '系统' : '群里');
        return `${who}：${text}`;
      })
      .join('\n');
    const sys = '把下面这段群聊经历压缩成一份自述式摘要，供"我"在后续对话中继续使用。'
      + '保留：正在进行的话题、我已经表态过的观点、我答应过要做的事、关键的人和他们的立场、我查过什么结论是什么。'
      + '丢弃：寒暄、复读、与我无关的闲聊细节。用第一人称，纯文本，不要 Markdown，不超过 800 字。';
    const user = (priorSummary ? `【此前的摘要】\n${priorSummary}\n\n` : '')
      + `【这段新经历】\n${transcript}`;
    const startedAt = Date.now();
    const out = await callLLM({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      apiFormat: compressLLMConfig.apiFormat,
      apiKey: compressLLMConfig.apiKey,
      model: compressLLMConfig.modelName,
      baseUrl: compressLLMConfig.baseUrl,
      options: { temperature: 0.3 },
      conversationId: `session-compact-${target}-${startedAt}`,
    });
    const text = typeof out === 'string' ? out : (out?.content || '');
    try {
      const { normalizeUsage, appendUsageLog } = await import('./mcp/toolExecutor.js');
      const u = normalizeUsage(out?.usage);
      const record = {
        ts: new Date().toISOString(), label: 'SessionCompact', target,
        model: compressLLMConfig.modelName || '', apiFormat: compressLLMConfig.apiFormat || '',
        inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens,
        toolCalls: 0, iterations: 1, durationMs: Date.now() - startedAt,
      };
      appendUsageLog(config.petId, record);
      logUsageRecord(record);
    } catch { /* 记账失败不影响压缩本身 */ }
    addLog('memory', `🗜️ [${targetNamesCache.get(target) || target}] session 压缩完成（${text.length} 字）`, null, target);
    return text;
  };

  /**
   * 跑一个 turn。
   *
   * turn 的边界：新消息进来 → 一直做事 → 不再调工具时检查有没有新消息 →
   * 有且未达上限就注入继续，否则收尾。这就是原先 write_intent_plan 的
   * "暂缓提交"拦截逻辑，从卡在某个工具上挪到了卡在 turn 边界上。
   */
  const runSessionTurn = async (session, target, targetType, { trigger, epoch }) => {
    const state = getIntentState(target);
    const tName = () => targetNamesCache.get(target) || target;
    const lurkMode = lurkModes.get(target) || 'normal';
    const turn = beginTurn(session, { trigger });
    const ep = session.ephemeral;

    // ── system prompt：整个 session 固定，只有材料被外部改动时才重建 ──
    if (!session.systemPrompt || session.materialsDirty) {
      // 档案只能在建 prompt 之前刷——建完就固化进前缀了。中途来的新人
      // 靠模型自己 social_read social/people/{QQ号}.md 现拉。
      try { await updatePeopleCache(target, targetType); } catch { /* 非致命 */ }
      session.systemPrompt = await buildSocialPrompt({
        petId: config.petId,
        socialPersonaPrompt: promptConfig.socialPersonaPrompt,
        atMustReply: promptConfig.atMustReply,
        targetName: tName(),
        targetId: target,
        targetType,
        botQQ: promptConfig.botQQ,
        ownerQQ: promptConfig.ownerQQ,
        ownerName: promptConfig.ownerName,
        ownerSecret: ep.ownerSecret,
        nameDelimiterL: ep.nameL, nameDelimiterR: ep.nameR,
        msgDelimiterL: ep.msgL, msgDelimiterR: ep.msgR,
        agentCanEditStrategy: promptConfig.agentCanEditStrategy,
        lurkMode,
        role: 'session',
        customGroupRules: customGroupRulesMap.get(target) || '',
        subagentRegistry,
        voiceEnabled: !!resolveTts(config.ttsConfig),
        imageGenEnabled: !!imageGenLLMConfig,
        backlogRemindAt: BACKLOG_REMINDER_AT,
        moodTagEnabled: moodConfig.enabled,
      });
      session.materialsDirty = false;
      session.staticPrefixTokens = estimateTokens(session.systemPrompt);
    }

    // detectChange 用的是 message_id 水位线，所以这里把时间游标翻译回一个 id：
    // 取"已消费部分里最后的那条"，而不是 buffer 末尾。还没消化完的消息必须继续
    // 算作"有变化"，否则 detectChange 看不见它们，要等再来一条新消息才会被顺带
    // 捞出去——那几条就被装死了。两个出口都要同步，漏一个就会空转。
    const syncWatermark = () => {
      const buf = dataBuffer.get(target);
      const msgs = buf?.messages || [];
      if (msgs.length === 0 || isCursorUnset(session.cursor)) return;
      const unconsumed = new Set(messagesAfter(msgs, session.cursor));
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (unconsumed.has(msgs[i])) continue;
        if (msgs[i]?.message_id) intentWatermarks.set(target, msgs[i].message_id);
        return;
      }
    };

    // ── 状态打标（"敬酒系统"）──
    // 每条消息单独一次 Jev 调用，state 是截止到它为止的**原文**窗口（不含标签，
    // 否则 Jev 会被前面的标签锚定）。正因为不带标签，条与条之间没有顺序依赖，
    // 可以完全并发。标过的消息永不重标。
    const tagFreshMessages = async (fresh) => {
      if (!moodConfig.enabled || !moodConfig.apiKey) return;
      const buf = dataBuffer.get(target);
      const all = buf?.messages || [];
      const targets = [];
      for (const m of fresh) {
        if (m.is_self || !m.message_id) continue;
        if (session.moodStore.has(m.message_id)) continue;   // 冻结：标过就跳过
        const idx = all.indexOf(m);
        const start = idx >= 0 ? Math.max(0, idx - MOOD_CONTEXT_WINDOW) : 0;
        const window = (idx >= 0 ? all.slice(start, idx + 1) : [m]).map(x => ({
          time: x.timestamp ? new Date(x.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '',
          sender: x.sender_name || String(x.sender_id || ''),
          text: x.content || '',
          isSelf: !!x.is_self,
        }));
        targets.push({ id: String(m.message_id), window });
      }
      if (targets.length === 0) return;

      const started = Date.now();
      let failed = 0;
      let firstError = '';
      const tags = await tagBatch(targets, {
        apiKey: moodConfig.apiKey,
        model: moodConfig.model,
        timeoutMs: MOOD_TAG_TIMEOUT_MS,
        botName: targetNamesCache.get(config.botQQ) || config.ownerName || 'the bot',
        // 只记次数不记原因，出问题时根本无从下手——第一条 CORS 故障就是这么
        // 变成一行"5 次失败"的。原因必须带出来。
        onError: (e) => { failed += 1; if (!firstError) firstError = String(e?.message || e); },
      });
      for (const [id, tag] of tags) {
        if (tag) session.moodStore.set(id, tag);
      }
      session.moodStore.scheduleFlush();
      const ok = [...tags.values()].filter(Boolean).length;

      // 明细带上原文——中文阴阳判得准不准，只能靠人眼看标签和原文的对照。
      // 没有这个，"准确率"就无从评估。
      const byId = new Map(fresh.map(m => [String(m.message_id), m]));
      const items = [...tags.entries()].map(([id, tag]) => {
        const m = byId.get(id);
        return {
          id,
          sender: m?.sender_name || String(m?.sender_id || ''),
          text: (m?.content || '').slice(0, 120),
          tag: tag || null,
          render: renderMoodTag(tag),
        };
      });
      const suffix = failed ? `，${failed} 次失败：${firstError}` : '';
      addLog(failed === targets.length && failed > 0 ? 'warn' : 'mood-tag',
        `🏷️ [${tName()}] 打标 ${ok}/${targets.length} 条（${Date.now() - started}ms${suffix}）`,
        JSON.stringify({ items }), target);
    };

    // ── poll 日志采集 ──
    // 前端的 💬 Chat / 🧠 LLM / 🔧 Tools 三个开关和 PollEntry 全靠 'poll' 级日志。
    // 那个日志原本由 pollTarget 发，而 pollTarget 现在只剩 Observer 在调——
    // 删掉 Reply 路径时把群消息显示的数据源一起带走了，UI 上只剩
    // "turn #N 开始（+10 条）"这种摘要，看不到任何内容。这里补回来。
    const pollChat = [];
    const pollIters = [];
    const pollTools = [];
    const pollSent = [];
    let lastRequestMessages = null;

    // ── 新消息进 history ──
    const imageUrlMap = new Map();
    // stats（可选）带回这批里真正解析出来的图片数——check_new_messages 据此决定
    // 要不要结束本次请求、让模型在下一次请求里看到图
    const appendNewMessages = async (msgs, kind, stats = null) => {
      if (!msgs.length) return 0;
      // 按原始批次推进，不管去重滤掉多少——否则全是自发消息的一批会让它卡死。
      // 时间语义：乱序的批次也能算对，且游标只前进不后退。
      advanceCursor(session.cursor, msgs);
      const raw = msgs.filter(m => !(m.is_self && session.selfSentTexts.has((m.content || '').trim())));
      if (!raw.length) return 0;

      // 复制一份再解析：base64 只进 session history，不回写 buffer。
      // buffer 里留着原始路径/URL，靠 resolveBufferImagesInPlace 的窗口回收控内存。
      // buffer 里的 _images 是空数组也要退回原始 URL：空数组是真值，`||` 兜不住，
      // 之前某次下载失败把它清空过的话，这张图就再也没有机会被重新拉取
      const fresh = raw.map(m => ({
        ...m,
        _images: m._images?.length ? m._images : (m.image_urls || []).map(u => ({ data: u, mimeType: 'image/jpeg' })),
      }));
      let resolvedCount = 0;
      if (config.enableImages !== false) {
        for (const m of fresh) {
          if (!m._images?.length) { m._images = []; continue; }
          const wanted = m._images.length;
          try {
            m._images = await resolveImagesForModel(m._images);
            resolvedCount += m._images.length;
          } catch (e) {
            addLog('warn', `图片解析失败 msg=${m.message_id}：${e.message || e}`, null, target);
            m._images = [];
          }
          // resolveImageUrls 对下载失败、不是图片的条目是静默丢弃的（只打 console），
          // 这里不报的话，模型说「看不到图」时日志里什么都没有
          if (m._images.length < wanted) {
            addLog('warn', `🖼️ msg=${m.message_id} 有 ${wanted - m._images.length}/${wanted} 张图没拿到（下载失败或不是有效图片）`, null, target);
          }
        }
        if (resolvedCount > 0) {
          addLog('info', `🖼️ 解析 ${resolvedCount} 张图为 base64`, null, target);
        }
      } else {
        for (const m of fresh) m._images = [];
      }

      await tagFreshMessages(fresh);

      const provider = buildTurnsFromMessages(fresh, {
        sanitizeAtMe: false,
        ownerQQ: promptConfig.ownerQQ, ownerName: promptConfig.ownerName,
        ownerSecret: ep.ownerSecret,
        nameL: ep.nameL, nameR: ep.nameR, msgL: ep.msgL, msgR: ep.msgR,
        imageUrlMap,
        moodTags: moodConfig.enabled ? session.moodStore : null,
      });
      for (const t of provider) appendHistory(session, { role: t.role, content: t.content, kind });

      // 供前端 💬 Chat 显示。只收群友的，bot 自己的走 pollSent。
      for (const m of fresh) {
        if (m.is_self) continue;
        let body = (m.content || '').substring(0, 200);
        if (m._imageDescs?.length) {
          body = (body + ' ' + m._imageDescs.map(d => `[图片: ${d}]`).join(' ')).substring(0, 400);
        } else if (m._images?.length) {
          body += ` [图片x${m._images.length}]`;
        }
        pollChat.push({ sender: m.sender_name || String(m.sender_id || ''), content: body, isAtMe: !!m.is_at_me });
      }
      if (stats) stats.images = resolvedCount;
      return fresh.length;
    };

    if (moodConfig.enabled) {
      try { await session.moodStore.load(); } catch { /* 标签丢了不该拖垮 turn */ }
    }

    try {
      await withHardTimeout(preprocessBufferImages(target), VISION_PREPROCESS_BUDGET_MS, 'Vision-pre');
    } catch (e) {
      addLog('warn', `🖼️ [${tName()}] 图片预处理超出预算，本轮跳过：${e.message || e}`, null, target);
    }
    touchIntent(state);

    const initialCount = await appendNewMessages(messagesSince(target, session.cursor), 'message');
    if (initialCount === 0 && turn.seq > 1) {
      // 水位线推进与 detectChange 之间有竞态窗口，偶尔会开出一个没有新输入的
      // turn。没有新东西就没什么可想的，直接收掉，不烧一次 LLM。
      endTurn(session, turn, { note: { register: REGISTER_SILENT, summary: '无新消息，空转', inferred: true } });
      syncWatermark();
      return turn;
    }
    addLog('intent', `🧵 [${tName()}] turn #${turn.seq} 开始（${trigger}，+${initialCount} 条）`, null, target);
    // turn-state 专供右侧面板做实时显示，不进日志流（前端见到这个 level 直接吃掉）
    const emitTurnState = (extra = {}) => addLog('turn-state', '', JSON.stringify({
      seq: turn.seq, trigger, ended: false,
      sends: turn.sends, toolCalls: turn.toolCalls, injections: turn.injections,
      backlogRemindAt: BACKLOG_REMINDER_AT,
      injectedMessages: turn.injectedMessages, backlog: turn.backlog,
      register: turn.note?.register ?? null, summary: turn.note?.summary ?? null,
      ...extra,
    }), target);
    emitTurnState({ newMessages: initialCount });

    // ── 群气压计 ──
    // 和消息打标是两回事：那个冻结、进 history、每条一次；这个实时、**不进
    // history**、每 turn 一次。不进 history 是硬要求——它每轮都变，塞进去
    // 就把整个 session 的前缀缓存打穿了。所以它作为请求尾部的一次性块注入。
    const readGroupBarometer = async () => {
      if (!moodConfig.enabled || !moodConfig.apiKey) return null;
      const buf = dataBuffer.get(target);
      const all = buf?.messages || [];
      if (all.length === 0) return null;
      const window = all.slice(-BAROMETER_WINDOW).map(x => ({
        time: x.timestamp ? new Date(x.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '',
        at: x.timestamp ? new Date(x.timestamp).getTime() : null,
        sender: x.sender_name || String(x.sender_id || ''),
        text: x.content || '',
        isSelf: !!x.is_self,
      }));
      const started = Date.now();
      let err = '';
      const out = await readBarometer(window, {
        apiKey: moodConfig.apiKey,
        model: moodConfig.model,
        botName: targetNamesCache.get(config.botQQ) || config.ownerName || 'the bot',
        onError: (e) => { if (!err) err = String(e?.message || e); },
      });
      if (out) {
        addLog('mood-tag',
          `🌡️ [${tName()}] 气压：${renderBarometer(out.reading).split('\n').slice(1, 4).map(l => l.replace(/^· /, '')).join(' / ')}（${Date.now() - started}ms）`,
          JSON.stringify({ barometer: out.reading, stats: out.stats }), target);
      } else {
        addLog('warn', `🌡️ [${tName()}] 气压读取失败（${Date.now() - started}ms）${err ? `：${err}` : ''}`, null, target);
      }
      return out;
    };

    const mcpTools = await buildSessionTools(target, lurkMode);
    let capturedNote = null;
    let pendingSendContent = null;
    let pendingReplyTo = null;
    /** 刚注入过。用来让 check_new_messages 的"空结果"说对话，见该工具注释。 */
    let justInjected = false;
    /**
     * check_new_messages 刚把一批消息并进了 history。
     *   added    本次并入几条（工具结果在 history 里就不必再抄一遍全文）
     *   images   其中解析出的图片数。> 0 时结束本次请求：工具结果里只有文字，
     *            图片要等下一次请求从 history 重建时才看得到
     */
    let checkIngest = null;

    const collectTraining = !!_currentTrainingCollectionEnabled && !!trainingTargetsMap.get(String(target));
    let latestTrace = null;
    const turnStartedAt = Date.now();

    const guard = () => isRuntimeGenerationCurrent()
      && state.epoch === epoch
      && !pausedTargets.get(target);

    // ── 注入循环 ──
    for (;;) {
      if (!guard()) { addLog('info', `${targetType}:${target} session turn 取消`, null, target); break; }
      touchIntent(state);

      const prepared = await prepareRequestItems(session, {
        thresholdTokens: COMPACT_THRESHOLD_TOKENS,
        staticPrefixTokens: session.staticPrefixTokens || 0,
        summarize: makeSessionSummarizer(target),
        onEvent: (type, detail) => {
          if (type === 'trim') {
            addLog('info', `✂️ [${tName()}] 裁掉 ${detail.trimmedCount} 条旧工具输出（省 ${detail.savedChars} 字符）`, null, target);
          } else if (type === 'compact') {
            addLog('memory', `🗜️ [${tName()}] session 压缩：${detail.tokensBefore} → ${detail.tokensAfter} tok`, null, target);
          }
        },
      });

      // 气压计每轮重读。它**不经过 appendHistory**，用完即弃，history 里不留痕迹。
      // 并进最后一条 user 消息的开头，不能单独挂在最后——那样模型最后读到的是
      // 场面读数而不是群友的话，短的 @ 容易被当成不用回，见 prependToLastUser。
      const baro = await readGroupBarometer();
      const baroBlock = baro ? renderBarometer(baro.reading, baro.stats) : '';

      const messages = [
        { role: 'system', content: session.systemPrompt },
        ...prependToLastUser(ensureUserLast(toProviderTurns(prepared.items)), baroBlock),
      ];
      lastRequestMessages = messages;   // 供前端 🧠 LLM 里的 Input Prompt 查看

      let result;
      try {
        result = await retryLLM(() => callLLMWithTools({
          messages,
          apiFormat: replyLLMConfig.apiFormat,
          apiKey: replyLLMConfig.apiKey,
          model: replyLLMConfig.modelName,
          baseUrl: replyLLMConfig.baseUrl,
          mcpTools,
          options: {
            temperature: 0.7,
            explicitCache: shouldUseExplicitCache(config, replyLLMConfig.apiFormat),
            cacheKey: buildCacheKey(config.petId, target, 'Session'),
          },
          maxIterations: SESSION_MAX_ITERATIONS,
          builtinToolContext: {
            petId: config.petId, targetId: target, targetType,
            mcpServerName: config.mcpServerName, memoryEnabled: true,
            imageUrlMap, sentCache: sentMessagesCache, subagentRegistry,
            bufferMessages: dataBuffer.get(target)?.messages,
            dataBuffer,
            subagentConfig: {
              enabled: SUBAGENTS_ENABLED,
              model: config.subagentModel || 'sonnet',
              timeoutSecs: config.subagentTimeoutSecs || 300,
            },
            dispatchMdOrganizer,
            botQQ: promptConfig.botQQ,
            ownerQQ: promptConfig.ownerQQ,
            ownerName: promptConfig.ownerName,
            ownerSecret: ep.ownerSecret,
            addLog,
            customGroupRules: customGroupRulesMap.get(target) || '',
            ttsConfig: config.ttsConfig,
            // Fish 的 voice_send 写法说明只在模型还看不见时才给
            voiceGuideVisible: () => hasVisibleVoiceGuide(session),
            imageModel: imageGenLLMConfig,
            lurkMode,
            runtimeGuard: () => canTargetDispatch(target),
            onTurnNote: (note) => { capturedNote = note; },
            // 模型主动拉过的消息，turn 边界不该再当"新消息"注入一遍
            sessionCursor: {
              get: () => session.cursor,
              advance: (msgs) => advanceCursor(session.cursor, msgs),
            },
            wasJustInjected: () => justInjected,
            // 表情挑选也走 Jev：主模型只决定"该不该发"，"发哪个"交给它
            moodApiKey: moodConfig.apiKey,
            moodModel: moodConfig.model,
            // turn 中途主动查到的消息也要走 appendNewMessages：那是唯一下载图片、
            // 拼多模态的路径。只回文字的话图就永久丢了，见 check_new_messages 注释
            ingestNewMessages: async (msgs) => {
              const stats = {};
              const added = await appendNewMessages(msgs, 'message', stats);
              checkIngest = { added, images: stats.images || 0 };
              return checkIngest;
            },
            onNewMessagesChecked: (count) => {
              justInjected = false;   // 只影响紧跟注入的那一次查询
              if (count > 0) {
                addLog('intent', `👀 [${tName()}] 模型主动查到 ${count} 条新消息`, null, target);
              }
            },
          },
          // 查到带图的新消息就收住这次请求，下一次请求从 history 重建、带上图
          stopAfterTool: (name) => name === 'check_new_messages' && checkIngest?.images > 0,
          usageLabel: 'Session',
          usageTarget: target,
          usagePetId: config.petId,
          onTrace: collectTraining ? (t) => { latestTrace = t; } : undefined,
          onUsageLogged: (record) => { if (guard()) logUsageRecord(record); },
          toolCallFilter: (name, args) => {
            if (!guard()) return 'Session 已取消：Social Agent 已停止或目标已暂停。';
            if (lurkMode === 'full-lurk' && SEND_TOOL_RE.test(name)) {
              return `当前是纯观察模式，禁止调用发送工具 ${name}。`;
            }
            // 发送类工具没有任何运行时限制：限流窗口、开口前强制 check、
            // 表情冷却三道闸都已移除。节奏完全交给模型自己把握。
            if (promptConfig.agentCanEditStrategy !== true) {
              const mutation = new Set(['social_write', 'social_edit', 'social_delete', 'social_rename']);
              const touchesStrategy = [args?.path, args?.from, args?.to].some(p =>
                p != null && (canonicalSocialPath(p) == null || canonicalSocialPath(p) === 'social/reply_strategy.md'));
              if (mutation.has(name) && touchesStrategy) return '当前配置禁止 Agent 修改 social/REPLY_STRATEGY.md。';
            }
            return null;
          },
          toolArgTransform: (name, args) => {
            // 语音：分隔符和分段标记都得去掉，不然 TTS 会把它们念出来
            if (name === 'voice_send') {
              const speech = (value) => {
                let text = value || '';
                for (const sec of Object.values(ep)) text = text.replaceAll(sec, '');
                return stripSplitTagsForSpeech(text);
              };
              const out = { ...args };
              for (const key of ['text', 'script', 'direction']) {
                if (typeof args?.[key] === 'string') out[key] = speech(args[key]);
              }
              return out;
            }
            if (!name.includes('send_message')) return args;
            let content = args?.content || '';
            for (const sec of Object.values(ep)) content = content.replaceAll(sec, '');
            // 先剥分隔符再归一分段标记：模型会照着 ‹…› 分隔符的样子写成 ‹/分段›
            content = normalizeSplitTags(content)
              .replace(/\[图片\]/g, '').replace(/\[视频\]/g, '')
              .replace(/\[语音\]/g, '').replace(/\[文件\]/g, '').trim();
            const extra = {};
            if (args?.reply_to) extra.reply_to = String(args.reply_to);
            return { ...args, content, ...extra, target, target_type: targetType };
          },
          onLLMText: (iter) => {
            if (!guard()) return;
            pollIters.push(iter);
            // 模型的文字**只从这里**进 history：每次迭代都会回调，包括最后那次不调工具的。
            // 轮次结束后别再拿 result.content 补一遍——之前补过，被吞掉的回复存了两份；
            // 被截断时还会把系统提示「[Maximum tool call iterations reached]」当成 bot
            // 自己说的话写进去。
            const text = (iter?.content || '').trim();
            // 不记成 assistant 的 message：这段话没经过发送工具，群里看不见。记成
            // assistant 会让模型以为自己说过，下一轮照着「直接写文字」的样子继续，
            // 见 sessionTurn 的 SYSTEM_RECORD。
            if (text) appendHistory(session, { role: 'assistant', content: text, kind: 'unsent' });
          },
          onToolCall: (name, args) => {
            if (!guard()) return;
            turn.toolCalls += 1;
            // 每次查询各算各的：同一次请求里第二次查到空，不能沿用上一次的并入结果
            if (name === 'check_new_messages') checkIngest = null;
            pollTools.push({ name, args: JSON.stringify(args ?? {}).substring(0, 300) });
            appendHistory(session, {
              role: 'assistant', kind: 'tool_call', toolName: name,
              content: JSON.stringify(args ?? {}),
            });
            addLog('info', `LLM called tool: ${name}`, JSON.stringify(args, null, 2), target);
            if (name.includes('send_message')) {
              pendingSendContent = args?.content || '';
              pendingReplyTo = args?.reply_to ? String(args.reply_to) : null;
            }
          },
          onToolResult: (name, toolRes, _id, isError) => {
            if (!guard()) return;
            let text = typeof toolRes === 'string' ? toolRes : JSON.stringify(toolRes);
            // 这批消息已经按原样进了 history（就在这条结果前面），之后的请求里
            // 不用再把渲染过的全文存一份
            if (name === 'check_new_messages' && checkIngest?.added > 0 && !isError) {
              text = `新到的 ${checkIngest.added} 条消息已经按原样放进上面的对话里了。`;
            }
            // 写法说明要一直留在上下文里，窗口被压缩前都不再重复给
            const voiceGuide = name === 'voice_send' && !isError && isVoiceGuideResult(text);
            appendHistory(session, {
              role: 'tool', kind: 'tool_result', toolName: name,
              content: text, isError: !!isError,
              ...(voiceGuide ? { voiceGuide: true, keepFull: true } : {}),
            });
            if (pollTools.length && pollTools[pollTools.length - 1].name === name) {
              pollTools[pollTools.length - 1].result = String(text).slice(0, 100);
              pollTools[pollTools.length - 1].isError = !!isError;
            }
            addLog(isError ? 'error' : 'info', `Tool result: ${name}`, String(text).slice(0, 100), target);
            if (name.includes('send_message') && !isToolResultFailure(toolRes, isError)) {
              recordSend(session, turn);
              lastReplyTime.set(target, Date.now());
              if (pendingSendContent) {
                let msgId = null;
                let msgTs = new Date().toISOString();
                try {
                  const parsed = typeof toolRes === 'string' ? JSON.parse(toolRes) : toolRes;
                  msgId = parsed?.message_ids?.[0]?.toString() || parsed?.message_id || null;
                  if (parsed?.timestamp) msgTs = parsed.timestamp;
                } catch { /* 结果不是 JSON 也无妨 */ }
                // 和 buildTurnsFromMessages 的 is_self 分支同形，并额外带上引用标记。
                // 之前这里塞的是裸内容：prompt 说自发消息带 [我的回复] 前缀、实际没有，
                // 而且连发两条合并后分不清发了几次、哪条带引用——模型于是在正文里
                // 手写「回 yesname：」补偿。
                appendHistory(session, {
                  role: 'assistant', kind: 'message',
                  content: formatSelfMessage({
                    text: pendingSendContent,
                    time: (() => { try { return new Date(msgTs).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return ''; } })(),
                    replyTo: pendingReplyTo,
                  }),
                });
                // 去重比对的是原始正文——buffer 回灌的那条不带前缀
                pollSent.push(pendingSendContent);
                session.selfSentTexts.add(pendingSendContent.trim());
                const arr = sentMessagesCache.get(target) || [];
                arr.push({ content: pendingSendContent, timestamp: msgTs, message_id: msgId });
                sentMessagesCache.set(target, arr);
                addLog('send', `💬 [${tName()}] ${pendingSendContent.slice(0, 60)}`, null, target);
                emitTurnState();
              }
              pendingSendContent = null;
              pendingReplyTo = null;
            }
          },
        }), { label: `Session ${target}`, target });
      } catch (e) {
        addLog('error', `❌ [${tName()}] turn #${turn.seq} LLM 失败：${e.message || e}`, null, target);
        break;
      }

      // 这一轮的话有没有送进群里。只有发送类工具能出声，直接输出的文字只进
      // history——以前这里不留任何痕迹，丢回复和主动沉默在日志里分不出来。
      if (guard()) {
        // 被截断时 content 是 callLLMWithTools 拼的系统提示，不是模型的话
        const truncated = result?.termination === 'max_iterations' || result?.termination === 'server_iteration_limit';
        if (truncated) {
          addLog('warn', `⛔ [${tName()}] turn #${turn.seq} 工具循环被截断（${result.termination}）：${result.content}`, null, target);
        }
        const roundText = truncated ? '' : String(result?.content || '').trim();
        const outcome = classifyRoundOutput({
          toolNames: (result?.toolCallHistory || []).map(h => h.name),
          text: roundText,
          isSendTool: (name) => SEND_TOOL_RE.test(name),
        });
        // 非正常结束（MALFORMED_FUNCTION_CALL / SAFETY / MAX_TOKENS …）时附上，
        // 那是「想说但没说出来」，和模型自己选择不说是两回事
        const fr = result?.finishReason;
        const frTag = fr && !/^(stop|end_turn)$/i.test(fr) ? `（finishReason=${fr}）` : '';
        if (outcome === 'text_only') {
          const snippet = roundText.replace(/\s+/g, ' ');
          addLog('warn',
            `🕳️ [${tName()}] turn #${turn.seq} 模型只出了文字、没调发送工具，这段话群里看不见${frTag}：「${snippet.slice(0, 100)}${snippet.length > 100 ? '…' : ''}」`,
            roundText, target);
        } else if (outcome === 'empty' && !capturedNote) {
          // 之前已经 turn_note 收过尾的话，注入轮空着回来是正常的，不记。
          // 非正常结束说明它想做事但没做成，升成 warn
          addLog(frTag ? 'warn' : 'info', `🕳️ [${tName()}] turn #${turn.seq} 模型空响应：没调工具、没出文字，也还没收尾${frTag}`, null, target);
        }
      }

      // ── turn 边界：有新消息就注入继续，否则收尾 ──
      if (!guard()) break;

      // check_new_messages 查到了带图的消息、收住了上一次请求：图已经在 history 里，
      // 再跑一次让模型看到。游标已经推过去了，下面的常规注入不会再算这批
      if (checkIngest?.images > 0) {
        const ingested = checkIngest;
        checkIngest = null;
        recordInjection(turn, ingested.added);
        justInjected = true;
        appendHistory(session, {
          role: 'user', kind: 'injection',
          content: `（上面你刚查到的新消息里有 ${ingested.images} 张图，现在能看到了。把它们纳入判断再决定说什么。）`,
        });
        addLog('intent', `🖼️ [${tName()}] turn #${turn.seq} 查到带图的新消息（${ingested.images} 张），带图重跑一次`, null, target);
        emitTurnState({ newMessages: ingested.added });
        continue;
      }
      checkIngest = null;
      const fresh = messagesSince(target, session.cursor).filter(m => !m.is_self);
      if (!canInject(turn, fresh.length)) break;

      const added = await appendNewMessages(messagesSince(target, session.cursor), 'message');
      recordInjection(turn, added || fresh.length);
      // 注入之后紧跟的那次 check_new_messages 必然返回空（注入已经推进了游标），
      // 这个标记让它的措辞说对话：「你刚收到的那批就是最新的」而不是「群里没动静」。
      justInjected = true;
      let injectionText = `（以上 ${added} 条是你思考期间新到的消息，**已经是群里最新的了**。`
        + `把它们纳入判断：可能让你从不打算说变成该说了，也可能让你原本想说的话过时了。）`;
      // 积压过多时提醒，而不是切断——和 Codex 的 reminder_threshold 一个路子。
      if (shouldRemindBacklog(turn)) {
        markBacklogReminded(turn);
        injectionText += `\n\n⚠️ 你上次开口之后，群里已经堆了 ${turn.backlog} 条你还没回应的消息。`
          + `要么说点什么，要么调 turn_note 明确收尾——别就这么挂着。`;
        addLog('intent', `📬 [${tName()}] turn #${turn.seq} 积压 ${turn.backlog} 条未回应，已提醒`, null, target);
      }
      appendHistory(session, { role: 'user', kind: 'injection', content: injectionText });
      addLog('intent', `🛑 [${tName()}] turn #${turn.seq} 注入 ${added} 条（积压 ${turn.backlog}，本轮累计 ${turn.injectedMessages}）`, null, target);
      emitTurnState({ newMessages: added });
    }

    // ── 收尾 ──
    endTurn(session, turn, { note: capturedNote });

    // 前端的 💬 Chat / 🧠 LLM / 🔧 Tools 靠这条日志渲染（PollEntry）。
    // action 沿用 pollTarget 的取值，这样 actionIcons/actionColors 直接复用。
    addLog('poll', `Poll: ${turn.sends > 0 ? 'replied' : 'silent'}`, {
      chatMessages: pollChat,
      inputPrompt: lastRequestMessages,
      llmIters: pollIters,
      sentMessages: pollSent,
      toolCalls: pollTools,
      action: turn.sends > 0 ? 'replied' : 'silent',
      role: 'reply',
    }, target);

    appendHistory(session, {
      role: 'assistant', kind: 'note',
      turnId: turn.turnId,   // endTurn 已清空 currentTurn，这里要显式带上
      content: renderTurnNote(turn.note, turn.seq),
    });
    syncWatermark();
    if (turn.sends > 0) state.postReplyRestUntil = Date.now() + SESSION_POST_SEND_REST_MS;
    // selfSentTexts 只用于去重刚发出、buffer 还没回灌的消息。整个 clear() 会把
    // 尚未回灌的条目也丢掉，那条消息就会进两次——按 FIFO 只淘汰最旧的。
    while (session.selfSentTexts.size > 32) {
      session.selfSentTexts.delete(session.selfSentTexts.values().next().value);
    }
    // base64 图片只留最近几张，其余换占位符——否则 append-only 的 history 会一直涨
    const recycled = recycleSessionImages(session.history);
    if (recycled.recycled > 0) {
      addLog('info', `🖼️ 回收 ${recycled.recycled} 张旧图（保留最近 ${recycled.kept} 张）`, null, target);
    }

    addLog('intent', `🧵 [${tName()}] turn #${turn.seq} 结束 [${turn.note?.register || '—'}] ${turn.note?.summary || ''}（${turn.toolCalls} 次工具，${turn.sends} 条发送，${turn.injections} 次注入）`, JSON.stringify(sessionStats(session)), target);
    emitTurnState({ ended: true, stats: sessionStats(session) });

    if (collectTraining && latestTrace) {
      writeIntentTrace(config.petId, {
        target_id: target, target_type: targetType, pet_id: config.petId,
        provider: replyLLMConfig.apiFormat, model: replyLLMConfig.modelName, label: 'Session',
      }, { ...latestTrace, durationMs: latestTrace.durationMs ?? (Date.now() - turnStartedAt) });
    }
    return turn;
  };

  /** 每 target 一条 session 循环。 */
  const sessionLoop = async (target, targetType) => {
    const state = getIntentState(target);
    const tName = () => targetNamesCache.get(target) || target;
    state.targetType = targetType;
    const myEpoch = state.epoch;
    const session = getSession(target, targetType);
    touchIntent(state);

    while (activeLoop && activeLoop._generation === loopGeneration && state.epoch === myEpoch) {
      try {
        touchIntent(state);
        if (pausedTargets.get(target)) { await sleepInterruptible(state, 2000); continue; }

        const now = Date.now();
        const lurkMode = lurkModes.get(target) || 'normal';

        // 发完消息后的冷静期，有新消息则提前结束
        if (state.postReplyRestUntil) {
          const remaining = state.postReplyRestUntil - now;
          if (remaining > 0 && !hasNewNonSelfMessages(target)) {
            await sleepInterruptible(state, remaining);
          }
          state.postReplyRestUntil = 0;
        }

        // semi-lurk / full-lurk 保持冷却，避免空转
        if (lurkMode !== 'normal') {
          const since = session.lastTurnAt ? now - session.lastTurnAt : Infinity;
          if (since < INTENT_EVAL_COOLDOWN_MS) {
            await sleepInterruptible(state, Math.min(INTENT_EVAL_COOLDOWN_MS - since + 1000, 10000));
            continue;
          }
        }

        const detection = detectChange(target, intentWatermarks);
        if (detection?.isFirstRun) {
          const buf = dataBuffer.get(target);
          const lastMsg = buf?.messages?.[buf.messages.length - 1];
          if (lastMsg?.message_id) intentWatermarks.set(target, lastMsg.message_id);
        } else if (!detection?.changed) {
          const lastNonSelf = getLastNonSelfMessageTime(target);
          const idleMs = lastNonSelf > 0 ? Date.now() - lastNonSelf : 0;
          if (idleMs > SESSION_IDLE_SLEEP_MS) {
            await sleepInterruptible(state, 30000);
          } else {
            await sleepInterruptible(state, SESSION_IDLE_POLL_MS);
          }
          continue;
        }

        if (replyIntervalMs > 0) {
          const sinceLastReply = Date.now() - (lastReplyTime.get(target) || 0);
          if (sinceLastReply < replyIntervalMs) {
            await sleepInterruptible(state, Math.min(replyIntervalMs - sinceLastReply, 5000));
            continue;
          }
        }

        session.lastTurnAt = Date.now();
        await runSessionTurn(session, target, targetType, { trigger: 'newmsg', epoch: myEpoch });
      } catch (e) {
        if (state.epoch !== myEpoch) return;
        // runSessionTurn 中途抛出会绕过 endTurn，留下一个永远"活跃"的 turn，
        // 之后每次 beginTurn 都会撞 "已有活跃 turn"，这个群就永久停摆。
        if (session.currentTurn && !session.currentTurn.ended) {
          endTurn(session, session.currentTurn, {
            note: { register: REGISTER_SILENT, summary: `异常中断：${e.message || e}`.slice(0, 60), inferred: true },
          });
        }
        addLog('error', `❌ [${tName()}] session loop 异常：${e.message || e}`, e.stack, target);
        await sleepInterruptible(state, 5000);
      }
    }
  };

  // 启动层 1: Fetcher 循环（每 1s batch 拉取）
  fetcherLoop();
  
  // 启动层 2: 每个 target 独立的 Observer 循环（记录群档案）
  for (const t of targets) {
    observerLoop(t.target, t.targetType); // fire-and-forget
  }
  
  // 启动层 3+4: 每个 target 独立的 Session 循环（取代 Reply + Intent 两层）
  for (const t of targets) {
    getIntentState(t.target); // 预注册（循环控制状态：epoch / heartbeat / wake）
    sessionLoop(t.target, t.targetType); // fire-and-forget
  }

  // 看门狗：监控 Fetcher 轮询链 + 各 target 的 Intent 循环是否卡死
  scheduleSocialWatchdog();

  onStatusChange?.(true);
  // 保活：所有循环都靠 setTimeout 驱动，宿主 webview 一旦被系统挂起就整体
  // 静默停摆（实测一晚断 6 次、累计 43 分钟）。放到最后启动，这样启动失败的
  // 那些提前 return 不会留下一个开着的 AudioContext。详见 keepAwake.js。
  startKeepAwake({ onLog: (level, message, detail) => addLog(level, message, detail) })
    .then((status) => {
      if (status.running) {
        addLog('info', '🔊 webview 保活已开启（防止 WebContent 进程被系统挂起）');
      }
    })
    .catch((e) => addLog('warn', `🔇 webview 保活启动失败：${e?.message || e}`));

  addLog('info', 'Social loop started successfully');
  return true;
}

/**
 * 停止社交循环
 */
export function stopSocialLoop() {
  // 无论 activeLoop 是否已经建立，都先使 STARTING/运行中的旧 generation 失效。
  socialLoopGeneration++;
  startingPetId = null;
  // 保活只为 agent 服务，agent 一停就放掉——它会阻止系统 idle 休眠。
  // 放在最前面：startSocialLoop 开头就会调本函数，重启时由它末尾重新打开。
  stopKeepAwake();

  if (activeLoop) {
    // 持久化 lurk modes 在清空之前
    if (lurkModes.size > 0) {
      saveLurkModes(activeLoop.petId, Object.fromEntries(lurkModes));
    }
    // 持久化 paused targets 在清空之前（包含所有 knownTargets 的 true/false 状态）
    const pausedSnapshot = {};
    for (const t of knownTargets) pausedSnapshot[t] = pausedTargets.get(t) || false;
    savePausedTargets(activeLoop.petId, pausedSnapshot);
    activeLoop._scheduleCleanup?.();
    // Flush debounced persistKnownTargets immediately before clearing state
    if (_persistDebounceTimer) {
      clearTimeout(_persistDebounceTimer);
      _persistDebounceTimer = null;
      persistKnownTargets(activeLoop.petId, knownTargets);
    }
    killBySource('social');
    destroySubagentListeners();
    if (_unlistenTraining) { _unlistenTraining(); _unlistenTraining = null; }
    if (_unlistenTrainingGlobal) { _unlistenTrainingGlobal(); _unlistenTrainingGlobal = null; }
    addLog('info', `Stopped social loop for pet: ${activeLoop.petId}`);
    activeLoop = null;
  }
  // stop 也可能发生在 startSocialLoop 尚未设置 activeLoop 的阶段。
  if (_unlistenTraining) { _unlistenTraining(); _unlistenTraining = null; }
  if (_unlistenTrainingGlobal) { _unlistenTrainingGlobal(); _unlistenTrainingGlobal = null; }
  sentMessagesCache.clear();
  imageDescCache.clear();
  imageDescInflight.clear();
  lurkModes.clear();
  pausedTargets.clear();
  trainingTargetsMap.clear();
  knownTargets.clear();
  targetNamesCache.clear();
  // 下面这几个原先漏在清理列表外。单独看都受 target/provider 数量约束、算不上
  // 泄漏，但「声明了却没清」很容易在以后新增 Map 时被照抄，所以一并补齐。
  customGroupRulesMap.clear();
  intentInjectionWatermarks.clear();
  intentInterceptCounts.clear();
  apiKeyRoundRobin.clear();
  // 终态 subagent 条目跟着会话一起走；running 的已由上面的 killBySource 处理。
  reapSubagentRegistry();
  // systemLogs / targetLogs 有意保留：agent 停掉后用户还要回看日志，
  // 二者各有 MAX_LOGS(200) 上限，清空由 clearSocialLogs 显式负责。
}

/**
 * 设置指定 target 的潜水模式
 * @param {string} target - 群号/QQ号
 * @param {'normal'|'semi-lurk'|'full-lurk'} mode
 */
/**
 * 热更新指定 target 的用户自定义规则（立即生效，下轮 Intent eval 即注入）
 */
export function setCustomGroupRule(target, rules) {
  if (!target) return;
  if (rules && rules.trim()) {
    customGroupRulesMap.set(target, rules.trim());
  } else {
    customGroupRulesMap.delete(target);
  }
  addLog('info', `Custom rules updated for ${target} (${rules ? rules.trim().length + '字' : 'cleared'})`, null, target);
}

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
  knownTargets.add(target); // 确保 target 已被记录
  if (paused) {
    pausedTargets.set(target, true);
  } else {
    pausedTargets.delete(target);
  }
  if (prev !== !!paused) {
    addLog('info', `Target [${target}] ${paused ? '⏸️ paused' : '▶️ resumed'}`, null, target);
    // 持久化变更（显式保存所有 knownTargets 的状态，包括 enabled=false）
    if (activeLoop?.petId) {
      const pausedSnapshot = {};
      for (const t of knownTargets) pausedSnapshot[t] = pausedTargets.get(t) || false;
      savePausedTargets(activeLoop.petId, pausedSnapshot);
    }
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
 * @returns {{ active: boolean, starting: boolean, petId: string|null }}
 */
export function getSocialStatus() {
  return {
    active: activeLoop !== null,
    starting: activeLoop === null && startingPetId !== null,
    petId: activeLoop?.petId || startingPetId || null,
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

/**
 * 在 social loop 未启动时从 workspace 文件读取群名缓存（不修改全局 Map）
 * @param {string} petId
 * @returns {Promise<Object>} { [targetId]: name }
 */
export async function loadSavedTargetNames(petId) {
  try {
    const raw = await tauri.workspaceRead(petId, KNOWN_TARGETS_PATH);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return {};
    const names = {};
    for (const item of arr) {
      if (item && item.id && item.name) names[item.id] = item.name;
    }
    return names;
  } catch {
    return {};
  }
}

/**
 * 在 social loop 未启动时读取持久化的 paused targets
 * @param {string} petId
 * @returns {Promise<Object>} { [target]: boolean }，首次返回 null
 */
export async function loadSavedPausedTargets(petId) {
  return loadPausedTargets(petId);
}

/**
 * 在 social loop 未启动时直接保存单个 target 的 paused 状态
 * （loop 运行时改用 setTargetPaused）
 * @param {string} petId
 * @param {string} target
 * @param {boolean} paused
 */
export async function saveTargetPausedDirect(petId, target, paused) {
  try {
    const current = (await loadPausedTargets(petId)) || {};
    current[target] = paused;
    await tauri.updateSettings({ [`social_paused_targets_${petId}`]: JSON.stringify(current) });
  } catch (e) {
    console.warn('[Social] Failed to save target paused direct', e);
  }
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
  loadSavedTargetNames,
  loadSavedPausedTargets,
  saveTargetPausedDirect,
};
