const FIXED_INTENT_TOOL_NAMES = new Set([
  'get_situation',
  'write_intent_plan',
]);

const ASYNC_OPTIONAL_TOOL_NAMES = new Set([
  'dispatch_subagent',
  'generate_image_send',
  'md_organize',
]);

const NON_REPEAT_OPTIONAL_TOOL_NAMES = new Set([
  'social_edit',
  'social_write',
  'dispatch_subagent',
  'md_organize',
  'image_send',
  'webshot',
  'webshot_send',
  'voice_send',
  'generate_image_send',
]);

const REPLAYABLE_READ_TOOL_NAMES = new Set([
  'social_tree',
  'social_read',
  'history_read',
  'daily_read',
  'daily_list',
  'group_log_list',
  'group_log_read',
  'cc_history',
  'cc_read',
  'screenshot',
  'image_list',
  'chat_search',
  'chat_context',
]);

const MAX_TOOL_NAME_CHARS = 96;
const MAX_DETAIL_CHARS = 56;
const MAX_LEDGER_ENTRIES = 50;

function clipInline(value, maxChars = MAX_DETAIL_CHARS) {
  const normalized = String(value ?? '')
    .replace(/[<>\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 1)}…`
    : normalized;
}

function normalizeToolName(name) {
  const normalized = String(name ?? '')
    .replace(/[<>\r\n\t]+/g, '')
    .trim();
  return (normalized || 'unknown_tool').slice(0, MAX_TOOL_NAME_CHARS);
}

function baseToolName(name) {
  const parts = normalizeToolName(name).split('__');
  return parts[parts.length - 1] || normalizeToolName(name);
}

function describeUrl(rawUrl) {
  const value = clipInline(rawUrl, 512);
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return clipInline(`${parsed.origin}${parsed.pathname}`);
  } catch {
    const queryIndex = value.indexOf('?');
    const hashIndex = value.indexOf('#');
    const cutoffCandidates = [queryIndex, hashIndex].filter(index => index >= 0);
    const cutoff = cutoffCandidates.length > 0 ? Math.min(...cutoffCandidates) : value.length;
    return clipInline(value.slice(0, cutoff));
  }
}

function firstPresent(args, keys) {
  for (const key of keys) {
    const value = args?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return clipInline(value);
    }
  }
  return '';
}

/**
 * 固定流程工具不进入可选工具账本。
 * 使用完整工具名精确匹配，避免误排除 extraServer__get_situation 之类的外部工具。
 */
export function isOptionalIntentTool(name) {
  return !FIXED_INTENT_TOOL_NAMES.has(String(name ?? '').trim());
}

function classifyRetryPolicy(name, isError) {
  if (isError) return 'retryable_failure';

  const fullName = normalizeToolName(name);
  const lowerFullName = fullName.toLowerCase();
  const lowerShortName = baseToolName(fullName).toLowerCase();
  if (
    lowerFullName.includes('tavily')
    || lowerShortName === 'tavily_search'
    || lowerShortName === 'fetch'
    || lowerFullName.includes('__fetch')
  ) {
    return 'replayable_read';
  }
  if (fullName.includes('__')) return 'unknown_external';
  if (NON_REPEAT_OPTIONAL_TOOL_NAMES.has(fullName)) return 'non_repeat_side_effect';
  if (REPLAYABLE_READ_TOOL_NAMES.has(fullName)) return 'replayable_read';
  return 'unknown';
}

/** 给模型看的短描述只取安全、有限的参数，不复述工具结果或大段正文。 */
export function describeIntentOptionalToolUse(name, args = {}) {
  const fullName = normalizeToolName(name);
  const shortName = baseToolName(fullName);
  const lowerFullName = fullName.toLowerCase();
  const lowerShortName = shortName.toLowerCase();

  if (lowerFullName.includes('tavily') || lowerShortName === 'tavily_search') {
    const query = firstPresent(args, ['query', 'q', 'search_query']);
    return query ? `联网搜索「${query}」` : '进行联网搜索';
  }

  if (lowerShortName === 'fetch' || lowerFullName.includes('__fetch')) {
    const url = describeUrl(args?.url);
    return url ? `抓取网页 ${url}` : '抓取网页内容';
  }

  // 除 Tavily / fetch 外，不根据外部 MCP 的同名工具猜测其语义或复述参数。
  if (fullName.includes('__')) {
    return '执行外部可选工具';
  }

  switch (lowerShortName) {
    case 'social_read': {
      const path = firstPresent(args, ['path']);
      return path ? `读取社交文件 ${path}` : '读取社交文件';
    }
    case 'social_edit': {
      const path = firstPresent(args, ['path']);
      return path ? `编辑社交文件 ${path}` : '编辑社交文件';
    }
    case 'social_write': {
      const path = firstPresent(args, ['path']);
      return path ? `写入社交文件 ${path}` : '写入社交文件';
    }
    case 'history_read': {
      const query = firstPresent(args, ['query']);
      return query ? `查询聊天历史「${query}」` : '查询聊天历史';
    }
    case 'chat_search': {
      const keywords = firstPresent(args, ['keywords', 'query']);
      return keywords ? `搜索聊天记录「${keywords}」` : '搜索聊天记录';
    }
    case 'chat_context':
      return '读取聊天记录上下文';
    case 'daily_read':
      return '读取社交日报';
    case 'daily_list':
      return '查看社交日报列表';
    case 'group_log_list':
      return '查看跨群日志列表';
    case 'group_log_read': {
      const query = firstPresent(args, ['query']);
      return query ? `搜索跨群日志「${query}」` : '读取跨群日志';
    }
    case 'dispatch_subagent': {
      const task = firstPresent(args, ['task']);
      return task ? `派发后台研究「${task}」` : '派发后台研究';
    }
    case 'cc_history':
      return '查看后台研究记录';
    case 'cc_read': {
      const file = firstPresent(args, ['file']);
      return file ? `读取后台研究结果 ${file}` : '读取后台研究结果';
    }
    case 'md_organize': {
      const file = firstPresent(args, ['file']);
      return file ? `派发 Markdown 整理 ${file}` : '派发 Markdown 整理';
    }
    case 'screenshot':
      return '截取聊天画面';
    case 'image_list':
      return '查看图片存档';
    case 'image_send': {
      const file = firstPresent(args, ['file', 'filename']);
      return file ? `发送存档图片 ${file}` : '发送存档图片';
    }
    case 'webshot':
      return '生成网页截图';
    case 'webshot_send':
      return '生成并发送网页截图';
    case 'voice_send':
      return '发送语音';
    case 'generate_image_send':
      return '派发 AI 生图';
    default:
      return '执行可选工具';
  }
}

export function createIntentOptionalToolLedger() {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    byTool: Object.create(null),
    entries: [],
  };
}

/**
 * 记录一次已经产生执行结果的 optional 工具调用，并返回仅供下一次 Intent LLM 调用看的注释。
 * 固定流程工具返回空字符串且不计数。
 */
export function recordIntentOptionalToolUse(ledger, {
  name,
  args = {},
  isError = false,
} = {}) {
  if (!ledger || !isOptionalIntentTool(name)) return '';

  const toolName = normalizeToolName(name);
  const description = describeIntentOptionalToolUse(toolName, args);
  const asyncDispatched = !isError && ASYNC_OPTIONAL_TOOL_NAMES.has(toolName);
  const status = isError ? '失败' : (asyncDispatched ? '已派发' : '完成');
  const retryPolicy = classifyRetryPolicy(toolName, isError);

  ledger.total += 1;
  if (isError) ledger.failed += 1;
  else ledger.succeeded += 1;
  ledger.byTool[toolName] = (ledger.byTool[toolName] || 0) + 1;

  ledger.entries.push({
    sequence: ledger.total,
    name: toolName,
    description,
    status,
    retryPolicy,
  });
  if (ledger.entries.length > MAX_LEDGER_ENTRIES) {
    ledger.entries.splice(0, ledger.entries.length - MAX_LEDGER_ENTRIES);
  }

  const lead = isError ? '尝试使用' : '已使用';
  const failureSuffix = ledger.failed > 0 ? `，其中失败 ${ledger.failed} 次` : '';
  return [
    '<runtime_optional_tool_ledger>',
    `${lead} ${toolName}：${description}（${status}）。`,
    `本次 Intent 共使用可选工具 ${ledger.total} 次${failureSuffix}。`,
    '</runtime_optional_tool_ledger>',
  ].join('\n');
}

/**
 * 同一次 Intent eval 的外层 LLM 重试会重建消息历史；用这段短摘要恢复 optional 工具账本。
 */
export function formatIntentOptionalToolLedgerResume(ledger) {
  if (!ledger || ledger.total <= 0) return '';

  const summarizeEntries = entries => entries
    .slice(-3)
    .map(entry => `${entry.name}：${entry.description}`)
    .join('；');
  const counts = Object.entries(ledger.byTool)
    .slice(-8)
    .map(([name, count]) => `${name}×${count}`)
    .join('、');
  const recent = ledger.entries
    .slice(-3)
    .map(entry => `${entry.name}：${entry.description}（${entry.status}）`)
    .join('；');
  const nonRepeat = summarizeEntries(
    ledger.entries.filter(entry => entry.retryPolicy === 'non_repeat_side_effect'),
  );
  const replayableReads = summarizeEntries(
    ledger.entries.filter(entry => entry.retryPolicy === 'replayable_read'),
  );
  const unknownExternal = summarizeEntries(
    ledger.entries.filter(entry => entry.retryPolicy === 'unknown_external'),
  );
  const failures = summarizeEntries(
    ledger.entries.filter(entry => entry.retryPolicy === 'retryable_failure'),
  );

  return [
    '<runtime_optional_tool_ledger>',
    `这是同一次 Intent eval 的重试续接：此前共使用可选工具 ${ledger.total} 次${ledger.failed > 0 ? `，失败 ${ledger.failed} 次` : ''}。`,
    counts ? `调用统计：${counts}。` : '',
    recent ? `最近操作：${recent}。` : '',
    nonRepeat ? `以下操作已完成或已派发，可能产生副作用，不要因重试重复：${nonRepeat}。` : '',
    replayableReads ? `以下读取/搜索结果没有保留在重建后的消息里；如果决策仍需要这些信息，可以重新调用（次数继续累计）：${replayableReads}。` : '',
    unknownExternal ? `以下外部工具的副作用未知；只有确认它是只读查询且结果仍有必要时才重新调用：${unknownExternal}。` : '',
    failures ? `以下调用此前失败，可按需要修正参数后重试：${failures}。` : '',
    '固定流程工具 get_situation 与 write_intent_plan 不计入上述次数，仍按流程要求调用。',
    '</runtime_optional_tool_ledger>',
  ].filter(Boolean).join('\n');
}
