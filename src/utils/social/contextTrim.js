/**
 * 工具输出裁剪 —— 压缩之前的第一道手段。
 *
 * 压缩（叫模型总结一遍）很贵：多一次 LLM 往返，而且必然丢细节。
 * 绝大多数超长上下文其实是被工具输出撑起来的——一次 tavily_search、
 * 一次 webshot、一次 history_read 就可能几万字符，而这些内容在模型已经
 * 读过、用过之后，保留全文的边际价值很低。
 *
 * 所以先裁工具输出：从最新的往回走，能装下就保留全文，预算耗尽之后更旧的
 * 一律换成占位符。对话消息（user / assistant）一个字都不动——那是连贯性
 * 的载体，裁了模型就接不上话了。
 *
 * 裁完还超阈值，才轮到 compaction.js 真压缩。
 */

/** 被裁掉的工具输出留什么。带上原长度，模型知道这里曾经有东西。 */
export const trimmedPlaceholder = (chars, toolName) =>
  `[${toolName || '工具'}输出已省略 ${chars} 字符 —— 内容较旧，如仍需要请重新调用]`;

/** 短输出裁了也省不下多少，反而丢信息。低于这个长度直接跳过。 */
export const MIN_TRIMMABLE_CHARS = 400;

/** 无论预算多紧，最新的这几条工具输出永远保留全文。 */
export const ALWAYS_KEEP_NEWEST = 2;

const contentLength = (content) => {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
};

const isToolResult = (item) => item?.kind === 'tool_result' || item?.role === 'tool';

/**
 * 从最新往回保留工具输出全文，预算耗尽后把更旧的换成占位符。
 *
 * @param items       history 条目数组（不会被修改，返回新数组）
 * @param budgetChars 留给工具输出的字符预算
 * @param opts.alwaysKeepNewest  最新 N 条工具输出豁免（默认 2）
 * @param opts.minTrimmable      短于此长度不裁（默认 400）
 * @returns { items, trimmedCount, savedChars, keptChars }
 */
export function trimToolOutputs(items, { budgetChars, alwaysKeepNewest = ALWAYS_KEEP_NEWEST, minTrimmable = MIN_TRIMMABLE_CHARS } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: items || [], trimmedCount: 0, savedChars: 0, keptChars: 0 };
  }
  if (!Number.isFinite(budgetChars) || budgetChars < 0) {
    return { items: [...items], trimmedCount: 0, savedChars: 0, keptChars: 0 };
  }

  // 从最新往回：先决定哪些留、哪些裁，再按原顺序重建数组。
  const decisions = new Map(); // index → 'keep' | 'trim'
  let used = 0;
  let seenToolResults = 0;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!isToolResult(item)) continue;

    const len = contentLength(item.content);
    seenToolResults += 1;

    // 最新几条无条件保留：模型刚拿到的结果正在用。
    if (seenToolResults <= alwaysKeepNewest) {
      decisions.set(i, 'keep');
      used += len;
      continue;
    }
    // 太短，裁了不划算。
    if (len < minTrimmable) {
      decisions.set(i, 'keep');
      used += len;
      continue;
    }
    if (used + len <= budgetChars) {
      decisions.set(i, 'keep');
      used += len;
    } else {
      decisions.set(i, 'trim');
    }
  }

  let trimmedCount = 0;
  let savedChars = 0;
  const out = items.map((item, i) => {
    if (decisions.get(i) !== 'trim') return item;
    const len = contentLength(item.content);
    trimmedCount += 1;
    savedChars += len;
    return {
      ...item,
      content: trimmedPlaceholder(len, item.toolName),
      _trimmed: true,
      _originalChars: len,
    };
  });

  return { items: out, trimmedCount, savedChars, keptChars: used };
}

/** 当前这批条目里工具输出占了多少字符。决定要不要裁时先看这个。 */
export function toolOutputChars(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) {
    if (isToolResult(item)) total += contentLength(item.content);
  }
  return total;
}

/** 全部条目的字符数，含对话消息。估 token 用。 */
export function totalChars(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) total += contentLength(item.content);
  return total;
}

/**
 * 回收旧图片。
 *
 * session history 是 append-only，而一张 base64 图动辄几百 KB——不回收的话
 * 一个长 session 能吃掉几百 MB。旧 buffer 靠 INTENT_IMAGE_WINDOW 做窗口回收，
 * session 这边同理：只保留最近 N 张，更旧的换成文字占位符。
 *
 * 模型仍然知道那里有过一张图（占位符写明了），需要时可以让它重新看。
 *
 * 原地修改 —— history 条目本来就是 session 自己的，复制一份反而浪费。
 *
 * @returns { recycled, kept }
 */
export function recycleSessionImages(history, { keepNewest = IMAGE_KEEP_NEWEST } = {}) {
  if (!Array.isArray(history)) return { recycled: 0, kept: 0 };
  let seen = 0;
  let recycled = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (!part || part.type === 'text') continue;
      seen += 1;
      if (seen <= keepNewest) continue;
      content[j] = { type: 'text', text: IMAGE_PLACEHOLDER };
      recycled += 1;
    }
  }
  return { recycled, kept: Math.min(seen, keepNewest) };
}

/** 被回收掉的图片留什么。 */
export const IMAGE_PLACEHOLDER = '[更早的一张图片，已从上下文移出]';

/** session history 里保留多少张图的原图。 */
export const IMAGE_KEEP_NEWEST = 12;
