/**
 * Anthropic Native Adapter
 *
 * 直接调用 Anthropic Messages API（/v1/messages），支持原生特性：
 * - Prompt caching（cache_control breakpoints）
 * - Tool use（与 OpenAI tools 互转）
 * - Vision（base64 image source.type=base64 + media_type）
 * - System prompt 作为顶级字段
 *
 * 能力:
 * - 图片: 支持 (source.type=base64)
 * - 视频/音频: 不支持
 * - 文档: 不支持（降级为文本引用）
 * - Prompt caching: 支持
 */

import { expandDocumentPartsToText, detectMimeFromBase64 } from '../normalize.js';
import { readFileAsBase64, parseDataUri, getFileFallbackText } from '../media.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 能力描述
 */
export const capabilities = {
  supportsImage: true,
  supportsVideo: false,
  supportsAudio: false,
  supportsPdf: true,        // Anthropic 支持 PDF
  supportsDocx: false,
  supportsInlineData: true,
  supportsPromptCaching: true,
  maxInlineBytes: 5 * 1024 * 1024,  // 5MB per image
};

/**
 * 获取完整 API URL
 */
const getApiUrl = (baseUrl) => {
  if (!baseUrl || baseUrl === 'default') return ANTHROPIC_BASE_URL;
  let url = baseUrl;
  // 如果用户传的是根域名（不含 /v1），自动追加
  if (!url.includes('/v1')) {
    url = url.endsWith('/') ? url + 'v1' : url + '/v1';
  }
  return url.replace(/\/+$/, '');
};

/**
 * 把 data URI 解析为 Anthropic 的 image source 对象
 * Anthropic 格式：{ type: "base64", media_type: "image/jpeg", data: "..." }
 */
const dataUriToAnthropicImage = (dataUri) => {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return null;
  let mediaType = parsed.mediaType;
  if (!mediaType || mediaType === 'application/octet-stream') {
    mediaType = detectMimeFromBase64(parsed.data) || 'image/jpeg';
  }
  return {
    type: 'base64',
    media_type: mediaType,
    data: parsed.data,
  };
};

/**
 * 从 http(s) URL 转为 Anthropic image source
 * Anthropic 也支持 url 类型
 */
const urlToAnthropicImage = (url) => ({
  type: 'url',
  url,
});

/**
 * 转换内部消息为 Anthropic 消息格式
 *
 * Anthropic 的特点：
 *   - system 是顶级字段（不放在 messages 数组里）
 *   - messages 只能有 user / assistant 角色
 *   - tool 调用结果作为 user 消息中的 tool_result content block
 *   - assistant 的 tool calls 是 tool_use content block
 *
 * @returns {{ system: string|null, messages: Array }}
 */
export const convertMessages = async (messages) => {
  // ⚠️ expandDocumentPartsToText 内部调用 normalizeMessages，会丢失 tool_calls / tool_call_id 字段
  // 所以必须先从原始 messages 抓取这些工具元数据，再用 expanded 走内容转换
  const toolMetaByIndex = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls) {
      toolMetaByIndex.set(i, { tool_calls: m.tool_calls, content: m.content ?? null });
    } else if (m.role === 'tool' && m.tool_call_id) {
      toolMetaByIndex.set(i, { tool_call_id: m.tool_call_id });
    }
  }

  // 文档展开为文本（Anthropic 不直接支持 docx 等）
  // 注意：expanded 的索引和原 messages 一致
  const expanded = await expandDocumentPartsToText(messages);

  // 提取 system 消息（合并所有 system 消息为一个字符串）
  // 同时建立 expanded → 原 index 的映射，以便取回 toolMeta
  const systemTexts = [];
  const nonSystem = []; // [{ msg, originalIndex }]
  for (let i = 0; i < expanded.length; i++) {
    const m = expanded[i];
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content)
            ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
            : '');
      if (text) systemTexts.push(text);
    } else {
      nonSystem.push({ msg: m, originalIndex: i });
    }
  }

  // 处理非 system 消息
  // 关键：tool messages 在 OpenAI 格式里是独立的 role=tool 消息
  //       在 Anthropic 里是 user 消息中的 tool_result content block
  //       多个连续 tool 消息要合并到一个 user 消息中
  const result = [];

  // 先扫描，识别 tool 消息块（连续的 role=tool）
  let i = 0;
  while (i < nonSystem.length) {
    const { msg, originalIndex } = nonSystem[i];
    const toolMeta = toolMetaByIndex.get(originalIndex);

    // 1. assistant 消息（可能含 tool_calls）
    if (msg.role === 'assistant') {
      const blocks = [];

      // assistant 的 tool_calls → tool_use blocks（来自 toolMeta，因为 normalize 已剥离）
      const hasToolCalls = toolMeta?.tool_calls && Array.isArray(toolMeta.tool_calls) && toolMeta.tool_calls.length > 0;

      // 文本内容：如果有 tool_calls，原始 content 可能是 null，要从 toolMeta 取
      // 否则从 normalize 后的 content 取（已经是 parts 数组）
      if (hasToolCalls) {
        // toolMeta.content 可能是 null/string/array
        const originalContent = toolMeta.content;
        if (typeof originalContent === 'string' && originalContent.trim()) {
          blocks.push({ type: 'text', text: originalContent });
        } else if (Array.isArray(originalContent)) {
          for (const part of originalContent) {
            if (part.type === 'text' && part.text) {
              blocks.push({ type: 'text', text: part.text });
            }
          }
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            blocks.push({ type: 'text', text: part.text });
          }
        }
      }

      if (hasToolCalls) {
        for (const tc of toolMeta.tool_calls) {
          let input = {};
          try {
            input = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments || '{}')
              : (tc.function?.arguments || {});
          } catch { input = {}; }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name,
            input,
          });
        }
      }

      if (blocks.length > 0) {
        result.push({ role: 'assistant', content: blocks });
      }
      i++;
      continue;
    }

    // 2. tool 消息块（一个或多个连续）→ 合并为一个 user 消息，每个 tool 一个 tool_result block
    if (msg.role === 'tool') {
      const blocks = [];
      while (i < nonSystem.length && nonSystem[i].msg.role === 'tool') {
        const { msg: toolMsg, originalIndex: toolIdx } = nonSystem[i];
        const toolMetaInner = toolMetaByIndex.get(toolIdx);
        const block = {
          type: 'tool_result',
          tool_use_id: toolMetaInner?.tool_call_id || '',
        };
        // 内容已经被 normalize 转为 parts 数组（[{type:text|image|...}]）
        if (Array.isArray(toolMsg.content)) {
          const contentBlocks = [];
          for (const part of toolMsg.content) {
            if (part.type === 'text') {
              contentBlocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'image' && part.url) {
              const url = part.url;
              if (url.startsWith('data:')) {
                const src = dataUriToAnthropicImage(url);
                if (src) contentBlocks.push({ type: 'image', source: src });
              } else if (url.startsWith('http')) {
                contentBlocks.push({ type: 'image', source: urlToAnthropicImage(url) });
              }
            }
          }
          // Anthropic tool_result.content 必须有内容（字符串或 blocks 数组）
          if (contentBlocks.length === 0) {
            block.content = '';
          } else if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
            block.content = contentBlocks[0].text;
          } else {
            block.content = contentBlocks;
          }
        } else if (typeof toolMsg.content === 'string') {
          block.content = toolMsg.content;
        } else {
          block.content = String(toolMsg.content || '');
        }
        blocks.push(block);
        i++;
      }
      result.push({ role: 'user', content: blocks });
      continue;
    }

    // 3. user 消息（可能多模态）
    if (msg.role === 'user') {
      const blocks = [];
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) blocks.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
            continue;
          }
          if (part.type === 'image_url') {
            let url = part.image_url?.url;
            if (!url) continue;
            // 本地路径 → 读为 base64
            if (!url.startsWith('data:') && !url.startsWith('http')) {
              const base64Data = await readFileAsBase64(url);
              if (base64Data) {
                url = base64Data;
              } else {
                blocks.push({ type: 'text', text: `[Image failed to load: ${url}]` });
                continue;
              }
            }
            if (url.startsWith('data:')) {
              const src = dataUriToAnthropicImage(url);
              if (src) blocks.push({ type: 'image', source: src });
              else blocks.push({ type: 'text', text: '[Image format error]' });
            } else if (url.startsWith('http')) {
              blocks.push({ type: 'image', source: urlToAnthropicImage(url) });
            }
            continue;
          }
          // 内部 normalize 格式：{ type: 'image', url }
          if (part.type === 'image' && part.url) {
            const url = part.url;
            if (url.startsWith('data:')) {
              const src = dataUriToAnthropicImage(url);
              if (src) blocks.push({ type: 'image', source: src });
            } else if (url.startsWith('http')) {
              blocks.push({ type: 'image', source: urlToAnthropicImage(url) });
            }
            continue;
          }
          // 其他类型（video/audio/file）→ 文本降级
          if (['video', 'audio', 'file'].includes(part.type)) {
            blocks.push({ type: 'text', text: getFileFallbackText(part) });
            continue;
          }
        }
      }
      if (blocks.length > 0) {
        result.push({ role: 'user', content: blocks });
      }
      i++;
      continue;
    }

    i++;
  }

  // 合并相邻的同 role 消息（Anthropic 要求 user/assistant 交替）
  const merged = [];
  for (const m of result) {
    if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content.push(...m.content);
    } else {
      merged.push(m);
    }
  }

  return {
    system: systemTexts.length > 0 ? systemTexts.join('\n\n') : null,
    messages: merged,
  };
};

/**
 * 把 OpenAI 格式的 tools 转为 Anthropic 格式
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
const convertToolsToAnthropic = (openaiTools) => {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map(t => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  });
};

/**
 * 构建 Anthropic API 请求
 *
 * 支持 prompt caching：
 * - 自动给 system prompt 加 cache_control
 * - 自动给 tools 数组加 cache_control（最后一个工具）
 * 这样 system + tools 形成稳定的 cache prefix
 */
export const buildRequest = async ({ apiKey, model, baseUrl, messages, options = {} }) => {
  const url = getApiUrl(baseUrl);
  const { system, messages: anthMessages } = await convertMessages(messages);

  const body = {
    model,
    max_tokens: options.maxTokens || 4096,
    messages: anthMessages,
    stream: options.stream || false,
  };

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  // System prompt：转为带 cache_control 的 blocks（启用 prompt caching）
  if (system) {
    body.system = [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
    ];
  }

  // Tools：转换 + 给最后一个加 cache_control
  if (options.tools && options.tools.length > 0) {
    const tools = convertToolsToAnthropic(options.tools);
    if (tools.length > 0) {
      tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    }
    body.tools = tools;
    if (options.tool_choice) {
      // OpenAI 'auto'/'none'/'required' → Anthropic { type: 'auto'|'none'|'any' }
      const tc = options.tool_choice;
      if (typeof tc === 'string') {
        const map = { auto: 'auto', none: 'none', required: 'any' };
        body.tool_choice = { type: map[tc] || 'auto' };
      } else if (tc?.type === 'function' && tc.function?.name) {
        body.tool_choice = { type: 'tool', name: tc.function.name };
      }
    }
  }

  return {
    endpoint: `${url}/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body,
  };
};

/**
 * 解析非流式响应
 *
 * Anthropic 响应格式：
 * {
 *   id, type: "message", role: "assistant",
 *   content: [{ type: "text", text }, { type: "tool_use", id, name, input }],
 *   stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence",
 *   usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 * }
 */
export const parseResponse = (data) => {
  const blocks = data?.content || [];
  let textContent = '';
  const toolCalls = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textContent += block.text || '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      });
    }
  }

  // 转为 OpenAI 风格的 usage 字段，便于上层统一处理
  const u = data?.usage || {};
  const usage = {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    // Anthropic 额外字段
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    // 为了兼容 normalizeUsage 的 cachedTokens 字段
    prompt_tokens_details: u.cache_read_input_tokens
      ? { cached_tokens: u.cache_read_input_tokens }
      : undefined,
  };

  return {
    content: textContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    finishReason: data?.stop_reason || null,
    usage,
    raw: data,
  };
};

/**
 * 解析流式响应块
 *
 * Anthropic SSE 事件类型：
 *   message_start: 包含 message 元数据 + initial usage
 *   content_block_start: 一个 content block 开始（text 或 tool_use）
 *   content_block_delta: text_delta 或 input_json_delta（tool 参数）
 *   content_block_stop: block 结束
 *   message_delta: stop_reason + 最终 usage
 *   message_stop: 整个消息结束
 *   ping: 心跳（忽略）
 *   error: 错误
 *
 * 前端的 toolExecutor 是按 OpenAI delta 格式期望的（{deltaText, deltaToolCalls, done}）
 * 这里需要把 Anthropic 事件转换为类似格式。
 *
 * 由于 Anthropic 的 tool_use 参数是逐字符流式输出（input_json_delta），
 * 但只在 content_block_start 时知道 tool name + id，
 * 调用方需要按 index 累积。
 */
export const parseStreamChunk = (chunk) => {
  // 输入：单个 SSE 事件 JSON 字符串
  if (!chunk || chunk === '[DONE]') {
    return { deltaText: '', deltaToolCalls: null, done: true };
  }

  let data;
  try {
    data = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
  } catch {
    return { deltaText: '', deltaToolCalls: null, done: false };
  }

  const evtType = data.type;

  switch (evtType) {
    case 'message_start': {
      // 初始 usage 信息（input tokens）
      const u = data.message?.usage || {};
      return {
        deltaText: '',
        deltaToolCalls: null,
        done: false,
        usage: {
          prompt_tokens: u.input_tokens || 0,
          cache_read_input_tokens: u.cache_read_input_tokens || 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        },
      };
    }
    case 'content_block_start': {
      const block = data.content_block;
      if (block?.type === 'tool_use') {
        // 工具调用开始 — 通知上层创建一个新的 tool call entry
        return {
          deltaText: '',
          deltaToolCalls: [{
            index: data.index,
            id: block.id,
            name: block.name,
            arguments: '', // 后续 input_json_delta 累积
          }],
          done: false,
        };
      }
      return { deltaText: '', deltaToolCalls: null, done: false };
    }
    case 'content_block_delta': {
      const delta = data.delta;
      if (delta?.type === 'text_delta') {
        return { deltaText: delta.text || '', deltaToolCalls: null, done: false };
      }
      if (delta?.type === 'input_json_delta') {
        // 工具参数的 partial JSON 字符串
        return {
          deltaText: '',
          deltaToolCalls: [{
            index: data.index,
            arguments: delta.partial_json || '',
          }],
          done: false,
        };
      }
      return { deltaText: '', deltaToolCalls: null, done: false };
    }
    case 'content_block_stop':
      return { deltaText: '', deltaToolCalls: null, done: false };
    case 'message_delta': {
      // 最终 stop_reason + completion usage
      const u = data.usage || {};
      return {
        deltaText: '',
        deltaToolCalls: null,
        done: false,
        finishReason: data.delta?.stop_reason || null,
        usage: {
          completion_tokens: u.output_tokens || 0,
        },
      };
    }
    case 'message_stop':
      return { deltaText: '', deltaToolCalls: null, done: true };
    case 'ping':
      return { deltaText: '', deltaToolCalls: null, done: false };
    case 'error':
      return { deltaText: '', deltaToolCalls: null, done: false, error: data.error?.message || 'Unknown error' };
    default:
      return { deltaText: '', deltaToolCalls: null, done: false };
  }
};

/**
 * 创建带 tool calls 的 assistant 消息（Anthropic 格式）
 *
 * 注意：Anthropic 的 assistant 消息中 tool_use blocks 和 text blocks 是混在一起的
 * 我们这里只创建包含 tool_use 的（toolExecutor 调用本函数时已经处理过文本）
 *
 * 但为了与 toolExecutor.js 中既有的 OpenAI 格式调用保持兼容，
 * 这里返回 OpenAI 风格（content: null, tool_calls: [...]），
 * convertMessages 会在下一轮调用时把它转为 Anthropic 格式。
 */
export const createAssistantToolCallMessage = (toolCalls) => ({
  role: 'assistant',
  content: null,
  tool_calls: toolCalls.map(tc => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    },
  })),
});

/**
 * 创建 tool 结果消息（Anthropic 格式，但包装为 OpenAI 风格让 convertMessages 转换）
 */
export const formatToolResultMessage = (toolCallId, result, images = []) => {
  const textContent = typeof result === 'string' ? result : JSON.stringify(result);
  if (!images || images.length === 0) {
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: textContent,
    };
  }
  // 多模态 tool result（图片）
  const content = [{ type: 'text', text: textContent }];
  for (const img of images) {
    let url;
    if (img.data.startsWith('http://') || img.data.startsWith('https://')) {
      url = img.data;
    } else if (img.data.startsWith('data:')) {
      url = img.data;
    } else {
      url = `data:${img.mimeType};base64,${img.data}`;
    }
    content.push({ type: 'image_url', image_url: { url } });
  }
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content,
  };
};

export default {
  capabilities,
  convertMessages,
  buildRequest,
  parseResponse,
  parseStreamChunk,
  createAssistantToolCallMessage,
  formatToolResultMessage,
};
