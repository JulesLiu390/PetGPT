/**
 * 上下文预算 —— 阈值判定、裁剪、压缩三步走。
 *
 * 顺序是有讲究的（和 Codex 一致）：超阈值先裁工具输出，裁完还超才真压缩。
 * 压缩要多跑一次 LLM，而且一旦总结就回不去了，能不做就不做。
 *
 *   估算 → 超阈值？ → 裁工具输出 → 还超？ → 压缩封窗 → 新窗口继续
 *
 * 压缩用滚动摘要：每次把「上一份摘要 + 这段 live 条目」一起总结成新的一份，
 * 所以请求里永远只有一份摘要，不会随 session 变长而堆积。
 */

import { buildRequestItems, latestSummary, sealWindow } from './sessionState.js';
import { trimToolOutputs, toolOutputChars, totalChars } from './contextTrim.js';

/**
 * 超过这个估算 token 数就动手。
 *
 * ⚠️ **这是"我们的估算"超过多少，不是真实计费 token 超过多少。** 两者差着
 * 一截，而且是系统性偏低——线上实测：阈值设 96k 时，真实触发点稳定落在
 * 128–129k，偏高约 33k。
 *
 *   04:53:28  真实 126,407 → 压缩 → 50,774
 *   14:49:45  真实 129,146 → 压缩 → 51,152
 *
 * 少算的东西：
 *   · 工具集 schema —— 19 个工具的 JSON 实测 13,636 B ≈ 4.5k tok，每次都发，
 *     但 staticPrefixTokens 只 estimateTokens(systemPrompt)，没把它算进去
 *   · 图片 —— estimateItemsTokens 只统计 text part，多模态一律记 0
 *   · 气压计块 —— 挂在请求尾部，不进 history 也就没被估到
 *   · 中文按 1 tok/字，实际更省一点
 *
 * 所以 64k 是**倒推**出来的：64 + 33 ≈ 97k 真实触发，压在延迟拐点之前
 * （实测 <100k 三档都是 4–6.4s，过 100k 跳到 17.9s）。
 *
 * 这是治标。治本是把估算口径补齐（至少把固定的 4.5k 工具 schema 加上），
 * 那之后这个常量应该改回接近真实值的数。
 *
 * 另外有一处观察值得记下来：两条被无视的 @me 直接提问，恰好都发生在上下文
 * 128–129k 的那两轮（各 1 iteration、零工具调用），压缩之后第一轮它就正常
 * 开口了。不能算证明，但长上下文下指令遵循退化这件事是有迹象的。
 */
export const COMPACT_THRESHOLD_TOKENS = 64_000;

/** 裁剪后留给工具输出的预算，占总阈值的比例。 */
export const TOOL_OUTPUT_BUDGET_RATIO = 0.35;

/**
 * 估 token。中日韩字符按 1 token 算，其余按 4 字符 1 token。
 *
 * 不追求精确——它只用来决定「要不要动手」，判错一点的代价是早压或晚压一轮，
 * 而真实 token 数要等响应回来才知道。真实值到手后由调用方回填校准。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 统一表意
      (code >= 0x3040 && code <= 0x30ff) ||   // 日文假名
      (code >= 0xac00 && code <= 0xd7af) ||   // 韩文
      (code >= 0x3000 && code <= 0x303f) ||   // CJK 标点
      (code >= 0xff00 && code <= 0xffef)      // 全角
    ) cjk += 1;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

const itemText = (item) => {
  const c = item?.content;
  if (typeof c === 'string') return c;
  // 先滤掉非文本 part 再拼，否则图片之类的空串也会带进一个换行，把估算抬高
  if (Array.isArray(c)) return c.filter(p => typeof p?.text === 'string').map(p => p.text).join('\n');
  return '';
};

/** 一批 history 条目的估算 token。 */
export function estimateItemsTokens(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) total += estimateTokens(itemText(item));
  return total;
}

/**
 * 准备一次请求的 history 条目，必要时裁剪 / 压缩。
 *
 * @param session
 * @param opts.thresholdTokens    默认 COMPACT_THRESHOLD_TOKENS
 * @param opts.staticPrefixTokens 系统提示 + 工具集的估算，一并计入预算
 * @param opts.summarize          async (payload) => string，只有真要压缩时才调
 * @param opts.onEvent            (type, detail) => void，日志钩子
 * @returns { items, tokens, trimmed, compacted }
 */
export async function prepareRequestItems(session, {
  thresholdTokens = COMPACT_THRESHOLD_TOKENS,
  staticPrefixTokens = 0,
  summarize = null,
  onEvent = null,
} = {}) {
  const emit = (type, detail) => { try { onEvent?.(type, detail); } catch { /* 日志不该影响主流程 */ } };

  let items = buildRequestItems(session);
  let tokens = staticPrefixTokens + estimateItemsTokens(items);
  if (tokens <= thresholdTokens) {
    return { items, tokens, trimmed: null, compacted: null };
  }

  // ── 第一步：裁工具输出 ──
  const toolChars = toolOutputChars(items);
  const budgetChars = Math.max(0, Math.floor(thresholdTokens * TOOL_OUTPUT_BUDGET_RATIO));
  const trimResult = trimToolOutputs(items, { budgetChars });
  if (trimResult.trimmedCount > 0) {
    items = trimResult.items;
    tokens = staticPrefixTokens + estimateItemsTokens(items);
    emit('trim', {
      trimmedCount: trimResult.trimmedCount,
      savedChars: trimResult.savedChars,
      toolCharsBefore: toolChars,
      tokensAfter: tokens,
    });
  }
  if (tokens <= thresholdTokens) {
    return { items, tokens, trimmed: trimResult, compacted: null };
  }

  // ── 第二步：真压缩 ──
  if (typeof summarize !== 'function') {
    emit('compact-skipped', { reason: 'no summarizer', tokens });
    return { items, tokens, trimmed: trimResult, compacted: null };
  }

  const prior = latestSummary(session);
  // 喂给总结器的是裁剪后的条目——总结本身也不该被超长工具输出淹没。
  const summary = await summarize({
    priorSummary: prior,
    items,
    targetId: session.targetId,
    targetType: session.targetType,
  });
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    emit('compact-failed', { reason: 'empty summary', tokens });
    return { items, tokens, trimmed: trimResult, compacted: null };
  }

  const { sealedWindowId, newWindowId } = sealWindow(session, summary.trim());
  items = buildRequestItems(session);
  const tokensAfter = staticPrefixTokens + estimateItemsTokens(items);
  emit('compact', {
    sealedWindowId,
    newWindowId,
    tokensBefore: tokens,
    tokensAfter,
    summaryChars: summary.trim().length,
  });

  return {
    items,
    tokens: tokensAfter,
    trimmed: trimResult,
    compacted: { sealedWindowId, newWindowId, summary: summary.trim() },
  };
}

/** 诊断用：当前 session 的预算画像。 */
export function budgetSnapshot(session, { staticPrefixTokens = 0, thresholdTokens = COMPACT_THRESHOLD_TOKENS } = {}) {
  const items = buildRequestItems(session);
  const tokens = staticPrefixTokens + estimateItemsTokens(items);
  return {
    items: items.length,
    chars: totalChars(items),
    toolChars: toolOutputChars(items),
    tokens,
    thresholdTokens,
    overBy: Math.max(0, tokens - thresholdTokens),
    pct: thresholdTokens > 0 ? Math.round((tokens / thresholdTokens) * 100) : 0,
  };
}
