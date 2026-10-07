/**
 * 监听目标 ID 的规范化 —— 和 telegram-mcp 的 topics.normalize_target 必须一致。
 *
 * 用户会直接把 Telegram 链接粘进来（线上就这么填过：`https://t.me/c/3809923344/13288`），
 * 结果一直「Waiting for the first turn」：
 *   · MCP 回 batch 结果时用的是规范 target，PetGPT 按原样的链接去对，永远对不上
 *   · 链接里有 `/`，以 target 命名的 RULE_/LOG_/MOODTAG_ 文件写不进去
 * 所以进门就换成规范写法：
 *
 *   https://t.me/c/3809923344/13288   → -1003809923344:13288   （论坛话题）
 *   https://t.me/c/3809923344         → -1003809923344
 *   t.me/somegroup/45                 → @somegroup:45
 *
 * 认不出的（QQ 群号、已经规范的 ID、邀请链接）原样返回。
 */

const PRIVATE_LINK = /^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\/c\/(\d+)(?:\/(\d+))?(?:\/\d+)?\/?(?:[?#].*)?$/i;
const PUBLIC_LINK = /^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\/([A-Za-z][A-Za-z0-9_]{3,})(?:\/(\d+))?(?:\/\d+)?\/?(?:[?#].*)?$/i;
const RESERVED_PATHS = new Set(['c', 'joinchat', 'addstickers', 'share', 'proxy']);

const withThread = (chat, thread) => (thread ? `${chat}:${Number(thread)}` : chat);

export function normalizeTargetId(raw) {
  const id = String(raw ?? '').trim();
  let m = PRIVATE_LINK.exec(id);
  if (m) return withThread(`-100${m[1]}`, m[2]);
  m = PUBLIC_LINK.exec(id);
  if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) return withThread(`@${m[1]}`, m[2]);
  return id;
}

/** 规范化一组 ID：去空、去重（同一个群贴了链接又贴了 ID 时只留一份），保持顺序。 */
export function normalizeTargetIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = normalizeTargetId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
