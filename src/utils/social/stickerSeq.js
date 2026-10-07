/**
 * 表情包的"逻辑时钟" —— 淘汰按**错过了多少次发送机会**算，而不是墙钟时间。
 *
 * 为什么墙钟不对：实测历史总发送 1305 次 / 168 天，但发送密度随群的活跃度
 * 剧烈波动。同样是"142 天没发"，可能夹着 800 次发送（真的被冷落了），也可能
 * 只夹着 30 次（根本没轮上）。墙钟测的是时间流逝，不是机会流逝。
 *
 * 旧策略按 last_used 排序的后果，在真实库里看得很清楚——排在最前面等着被删的
 * 是这几张：
 *
 *   #154  168 天前  used=21    #97   157 天前  used=35
 *   #34   165 天前  used=24    #158  144 天前  used=32
 *
 * 全是历史上用了二三十次的好表情，只是最近几个月话题没撞上。而 used=2 的
 * #314 反倒排在后面更安全。表情不是缓存条目，是**词汇**——用过 35 次证明了
 * 它好用，半年没用不代表以后用不上。
 *
 * 计数器不单独存：每次发送都把全局序号写进被选中那张的 last_used_seq，
 * 所以 max(last_used_seq) 就是最后分配出去的号。被删的永远是 seq 最小的那些
 * （错过最多），最大值不会因为淘汰而回退。
 */

/** 下一个要分配的序号。 */
export function nextStickerSeq(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 1;
  let max = 0;
  for (const e of entries) {
    const v = Number(e?.last_used_seq);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max + 1;
}

/** 这张错过了多少次发送机会。越大越该淘汰。 */
export function missCount(entry, entries) {
  const latest = nextStickerSeq(entries) - 1;
  const own = Number(entry?.last_used_seq);
  if (!Number.isFinite(own)) return latest;   // 没有序号的当作从头错到尾
  return Math.max(0, latest - own);
}

/**
 * 给存量数据补序号。
 *
 * 老索引里一条 last_used_seq 都没有。迁移方式：按 last_used 升序分配递增的
 * 伪序号，保持它们现有的相对顺序——过渡期的排序退化成旧行为，之后随着新的
 * 发送逐渐变准。
 *
 * **从没发过的（没有 last_used）排在最后**，拿最大的伪序号。旧实现把它们的
 * 时间戳当 0，于是一张刚存进来还没机会露面的表情会被立刻淘汰掉；逻辑时钟下
 * 「刚进来」应该等价于「刚用过」，miss 为 0。
 *
 * 原地修改，返回补了几条。
 */
export function backfillStickerSeq(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const missing = entries.filter(e => !Number.isFinite(Number(e?.last_used_seq)));
  if (missing.length === 0) return 0;

  const ts = (e) => {
    const t = e?.last_used ? new Date(e.last_used).getTime() : NaN;
    return Number.isFinite(t) ? t : Infinity;   // 没用过的排最后
  };
  missing.sort((a, b) => {
    const ta = ts(a);
    const tb = ts(b);
    if (ta !== tb) return ta - tb;
    return (a.used || 0) - (b.used || 0);
  });

  // 接在已有序号之后，避免和迁移前就有序号的那些撞车
  let seq = nextStickerSeq(entries);
  for (const e of missing) {
    e.last_used_seq = seq;
    seq += 1;
  }
  return missing.length;
}

/**
 * 记一次发送：把最新序号写给这张。
 * @returns 分配到的序号
 */
export function markStickerUsed(entry, entries, now = new Date()) {
  const seq = nextStickerSeq(entries);
  entry.last_used_seq = seq;
  entry.used = (entry.used || 0) + 1;
  entry.last_used = now.toISOString();   // 仅供人看，不再参与淘汰判定
  return seq;
}

/**
 * 新入库的表情拿当前序号，等价于"刚用过"。
 * 不这么做的话它 miss 会等于全局最大值，一进来就排在淘汰队首。
 */
export function initStickerSeq(entry, entries) {
  entry.last_used_seq = nextStickerSeq(entries);
  return entry.last_used_seq;
}

/** 淘汰顺序：错过最多的排前面。返回新数组，不改原数组。 */
export function evictionOrder(entries, { excludeId = null } = {}) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(e => e && e.id !== excludeId)
    .slice()
    .sort((a, b) => {
      const sa = Number(a.last_used_seq) || 0;
      const sb = Number(b.last_used_seq) || 0;
      if (sa !== sb) return sa - sb;
      return (a.used || 0) - (b.used || 0);
    });
}
