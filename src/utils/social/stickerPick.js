/**
 * 表情选择 —— 主模型只决定"此刻该发个表情"，具体发哪个交给 Jev。
 *
 * 为什么是 Jev 最合适的用法（比情绪打标合适得多）：
 *   · 输出空间闭合 —— 30 个已知 id，schema 上不可能选出不存在的
 *   · 主模型没有信息优势 —— 它读的也是同一批文字描述
 *   · 错了代价小 —— 表情略微不贴切而已，不像情绪标错会把判断带偏
 *
 * 省掉的代价是实打实的：session prompt 里**没有**表情索引，所以模型想发表情
 * 必须先调一次 sticker_list，那是一整轮主模型推理（实测 4–21.6s、约 50k
 * 上下文），只为从 30 个里挑一个。Jev 实测平均 251ms、约 2.1k tok。
 *
 * 分工要划清：**"该不该发"永远是主模型的判断**（它知道防复读、知道刚发过什么、
 * 知道冷却），Jev 只回答"如果要发，发哪个"。沙盒里见过一个窗口里 bot 刚连发
 * 两条，Jev 照样给了个答案——它不知道那种时候本就不该再发。
 */

import { askJev, pickChoice, JEV_DEFAULT_MODEL } from './jevClient.js';

/** 给 Jev 看多少条上下文。 */
export const STICKER_CONTEXT_WINDOW = 16;

/** 选择超时。它在发送的关键路径上，但 Jev 实测 122–556ms，给到 2s 很宽裕。 */
export const STICKER_PICK_TIMEOUT_MS = 2000;

/**
 * 置信门槛。低于这个就当 Jev 没主意，退回最久没发的那个。
 *
 * 沙盒实测：判断明确时第一名 61%、第二名 12%（拉开 5 倍）；在猜的时候
 * 41% vs 30%，几乎持平。所以光看绝对值不够，还要看和第二名的比值。
 */
export const STICKER_MIN_CONFIDENCE = 0.45;
export const STICKER_MIN_RATIO = 1.8;

/**
 * criteria 的 key 不能直接用数字 id。
 *
 * 沙盒里遇到过：聊天记录最后两条是「6」「拉我」，Jev 就选了 #6。数字 id 和
 * 聊天正文里的数字撞车，成了假线索。加前缀之后就不会了。
 */
const KEY_PREFIX = 'sticker_';
export const toCriteriaKey = (id) => `${KEY_PREFIX}${id}`;
export const fromCriteriaKey = (key) =>
  (typeof key === 'string' && key.startsWith(KEY_PREFIX)) ? key.slice(KEY_PREFIX.length) : null;

/** bot 自己在 state 里的标记。 */
const SELF = 'GLITCH(我自己)';

/**
 * state：最近 N 条聊天，标出哪条是自己。
 */
export function buildStickerState(messages, { botName = SELF, window = STICKER_CONTEXT_WINDOW } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const recent = messages.slice(-window);
  return {
    note: 'Chinese tech group chat. The last line is the current moment.',
    you_are: botName,
    conversation: recent.map((m) => ({
      speaker: m.is_self ? botName : (m.sender_name || String(m.sender_id || 'unknown')),
      text: m.content || '',
    })),
  };
}

export function buildStickerQuestion(stickers) {
  return {
    sticker: {
      type: 'choice',
      instructions:
        'You are picking one sticker for the bot to post right now, as a reaction to the '
        + 'conversation above. Pick the one whose described content best fits the mood and '
        + 'the last few lines. Each option is a sticker described in Chinese.',
      criteria: Object.fromEntries(stickers.map(s => [toCriteriaKey(s.id), s.meaning])),
    },
  };
}

/**
 * 解析答案。返回 { id, confidence, ratio, decisive }。
 *
 * decisive 表示"这不是在猜"——置信够高**且**和第二名拉开了差距。
 * 两个条件缺一不可，见 STICKER_MIN_CONFIDENCE 的注释。
 */
export function parseStickerAnswer(answers, stickers) {
  const a = answers?.sticker;
  const keyed = Object.fromEntries(stickers.map(s => [toCriteriaKey(s.id), s]));
  const key = pickChoice(a, keyed);
  if (!key) return null;

  const probs = a?.probabilities || {};
  const sorted = Object.values(probs).map(Number).filter(Number.isFinite).sort((x, y) => y - x);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  const ratio = second > 0 ? top / second : Infinity;
  const confidence = Number(a?.confidence) || 0;

  return {
    id: fromCriteriaKey(key),
    confidence,
    ratio,
    decisive: confidence >= STICKER_MIN_CONFIDENCE && ratio >= STICKER_MIN_RATIO,
  };
}

/** 最久没发的那个。Jev 不可用或拿不准时的退路。 */
export function leastRecentlyUsed(stickers) {
  if (!Array.isArray(stickers) || stickers.length === 0) return null;
  return [...stickers].sort((a, b) => {
    const ta = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const tb = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return (a.used || 0) - (b.used || 0);
  })[0];
}

/**
 * 挑一个。
 *
 * 永远返回一个可发送的 id（只要 stickers 非空）——主模型已经决定"此刻该发表情"了，
 * 这一步不该把它的决定推翻掉，拿不准就发个最久没露面的。
 *
 * @returns { id, source: 'jev'|'fallback', confidence?, ratio? } | null
 */
export async function pickSticker(messages, stickers, opts = {}) {
  if (!Array.isArray(stickers) || stickers.length === 0) return null;

  const fallback = () => {
    const s = leastRecentlyUsed(stickers);
    return s ? { id: String(s.id), source: 'fallback' } : null;
  };

  if (!opts.apiKey) return fallback();
  const state = buildStickerState(messages, opts);
  if (!state) return fallback();

  const answers = await askJev(state, buildStickerQuestion(stickers), {
    model: JEV_DEFAULT_MODEL,
    timeoutMs: STICKER_PICK_TIMEOUT_MS,
    ...opts,
  });
  const parsed = parseStickerAnswer(answers, stickers);
  if (!parsed) return fallback();
  if (!parsed.decisive) {
    // 拿不准。与其发一个像是随手抓的，不如发最久没露面的——至少不会复读。
    return { ...fallback(), confidence: parsed.confidence, ratio: parsed.ratio, indecisive: true };
  }
  return { id: parsed.id, source: 'jev', confidence: parsed.confidence, ratio: parsed.ratio };
}
