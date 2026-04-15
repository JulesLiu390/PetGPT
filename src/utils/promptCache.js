/**
 * promptCache.js — 纯辅助函数，不持有状态
 *
 * 服务于 Social Agent 的 OpenAI 显式 prompt caching 开关：
 * - buildCacheKey：生成 prompt_cache_key
 * - shouldUseExplicitCache：判断当前 apiFormat + 开关状态是否应传缓存参数
 * - formatUsageLogMessage：把 usage 记录格式化为一行 addLog 文本
 */

/**
 * 将 label（如 "Intent:msg" / "Compress:daily"）规范化为 snake_case 字符串，
 * 用于 prompt_cache_key 组装。
 */
function normalizeLabel(label) {
  return String(label || 'unknown')
    .toLowerCase()
    .replace(/:/g, '_')
    .replace(/[^a-z0-9_]/g, '_');
}

/**
 * 组装 OpenAI prompt_cache_key。
 * 格式：petgpt-{petId}-{targetId|global}-{label_snake}
 */
export function buildCacheKey(petId, targetId, label) {
  const pet = String(petId || 'unknown');
  const tgt = targetId ? String(targetId) : 'global';
  return `petgpt-${pet}-${tgt}-${normalizeLabel(label)}`;
}

/**
 * 判断本次调用是否应向 OpenAI 兼容 adapter 传显式缓存参数。
 * - socialConfig.explicitPromptCache 缺失时按 true 解读（向后兼容）
 * - 只对 OpenAI 兼容 adapter 生效；anthropic_native 和 gemini_official 不受影响
 */
export function shouldUseExplicitCache(socialConfig, apiFormat) {
  const enabled = socialConfig?.explicitPromptCache ?? true;
  if (!enabled) return false;
  return apiFormat !== 'gemini_official' && apiFormat !== 'anthropic_native';
}

/**
 * 把一条 usage 记录格式化为单行 addLog 文本。
 *
 * 输入: { label, model, inputTokens, outputTokens, cachedTokens, durationMs }
 * 输出示例:
 *   "Intent:msg  in=5120 (cached 4820, 94%) out=240  3.2s  gpt-4o"
 *   "Reply       in=4980 (cached 0)         out=185  2.1s  gpt-4o"
 */
export function formatUsageLogMessage({ label, model, inputTokens, outputTokens, cachedTokens, durationMs }) {
  const inTok = inputTokens ?? 0;
  const outTok = outputTokens ?? 0;
  const cached = cachedTokens ?? 0;
  const sec = ((durationMs ?? 0) / 1000).toFixed(1);
  const cachedPart = cached > 0
    ? `(cached ${cached}, ${Math.min(100, Math.round((cached / Math.max(inTok, 1)) * 100))}%)`
    : `(cached 0)`;
  const labelStr = label ?? '(unknown)';
  return `${labelStr}  in=${inTok} ${cachedPart} out=${outTok}  ${sec}s  ${model || ''}`.trim();
}
