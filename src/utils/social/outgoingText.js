/**
 * 发出去之前的文本清理：分段标记的各种写法。
 *
 * MCP（qq-mcp / telegram-mcp）只认 ASCII 的 `</分段>`。可模型经常写成别的样子，
 * 线上 Telegram 群里就原样发出过：
 *
 *   喂，gemini 怎么了，明明聪明得很好不好。‹/分段›别拆我台啊姐姐
 *
 * 那个 `‹ ›` 不是随手打的——PetGPT 给每条群消息套的安全分隔符就长这样
 * （`‹abc123›…‹/abc123›`，见 getSession 的 msgL/msgR）。上下文里几百个这种
 * 闭合标签，模型照着写分段标记再自然不过。所以在发送前统一回 `</分段>`，
 * 不指望模型改。
 */

export const SPLIT_TAG = '</分段>';

// 各种尖括号/书名号/全角括号包起来的「分段」，有没有斜杠、中间有没有空格都算。
// 只在 bot 自己要发的文本上用，不碰群友的消息。
const SPLIT_TAG_VARIANTS = /[<‹〈＜《«]\s*[/／]?\s*分\s*段\s*[>›〉＞》»]/g;

/** send_message 用：所有变体换成 MCP 认的 `</分段>`。 */
export function normalizeSplitTags(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(SPLIT_TAG_VARIANTS, SPLIT_TAG);
}

/**
 * voice_send 用：语音没有「分条」这回事，标记换成一个停顿。
 * 不处理的话 TTS 会把「分段」两个字念出来。
 */
export function stripSplitTagsForSpeech(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(SPLIT_TAG_VARIANTS, '，')
    .replace(/([。！？!?，,…~～])\s*，/g, '$1')   // 「好的。」后面再插的那个逗号去掉
    .replace(/^[\s，,]+|[\s，,]+$/g, '')
    .trim();
}
