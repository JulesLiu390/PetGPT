/**
 * 消息游标 —— 按**时间**定位"看到哪了"，而不是按数组下标。
 *
 * 原来的实现是在 dataBuffer 里 indexOf(message_id) 再 slice(idx + 1)，
 * 本质上是位置语义，隐含假设"数组下标即时间顺序"。这个假设在 qq-mcp 把历史
 * 回填改成后台任务之后就破了：
 *
 *   t=1s   MCP 握手完成，PetGPT 开始轮询，拿到仅有的几条实时消息
 *   t=12s  后台回填完成，把几十条历史按时间插进 MCP 的 deque（MCP 侧有序）
 *   t=13s  PetGPT 再拉，这批历史对它是"没见过的"，于是被 push 到**末尾**
 *          → dataBuffer = [live1, live2, old1…old48]，时间顺序乱了
 *
 * 位置语义一乱，切片窗口、"哪些是新消息"、游标推进全跟着错。改成时间语义之后
 * 就和数组顺序解耦了。
 *
 * 同一秒内可能有多条消息（QQ 时间戳是秒粒度），所以游标是
 * 「时间戳 + 该时间戳上已消费的 id 集合」，靠后者消歧，不会漏也不会重。
 *
 * **bot 自己的消息不推进时间。** 两种时间不是同一个钟：群友的消息带的是平台
 * 服务器给的时间（Telegram 还截到整秒），bot 自己的消息是 MCP 在本机发送成功时
 * 记的（telegram-mcp 精确到微秒）。本机时钟只要比服务器快一点，紧跟在 bot 后面
 * 发的那句话时间戳就可能比 bot 那条还早——游标按 bot 的时间推过去，那句话会被
 * 当成「已经看过」直接跳掉，连文字都不剩。所以自发消息只按 id 记成已读
 * （selfSeen），时间轴只由群友的消息推进。
 */

/**
 * 游标还没起步、这批里又只有 bot 自己的消息时，时间退后这么多再起步。
 * 起步总得有个时间；用 bot 的本机时间直接起步，就是上面那个跳消息的问题。
 */
export const SELF_CLOCK_SKEW_MS = 60 * 1000;

/**
 * 解析消息时间戳为毫秒。
 *
 * buffer 里实际是 ISO 8601 字符串（qq-mcp 的 `datetime.isoformat()`），但
 * 历史上也出现过 Unix 秒/毫秒，所以三种都认。
 */
export function messageTimeMs(ts) {
  if (ts === null || ts === undefined || ts === '') return NaN;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return NaN;
    // 10 位是秒，13 位是毫秒；1e11 放在两者中间做分界
    return ts < 1e11 ? ts * 1000 : ts;
  }
  return new Date(ts).getTime();
}

/** 一条消息的时间，取不到时返回 NaN。 */
export const msgTime = (m) => messageTimeMs(m?.timestamp);

export function createCursor() {
  // selfSeen：已读的自发消息 id → 它的时间。早于 ts 的会被清掉（反正按时间就排除了）
  return { ts: 0, ids: new Set(), selfSeen: new Map() };
}

/** 游标是不是还没起步（session 刚建立）。 */
export function isCursorUnset(cursor) {
  return !cursor || !cursor.ts;
}

/**
 * 游标之后的消息。
 *
 * 时间戳**等于**游标的那些要看 id 有没有被消费过——秒粒度下同一秒常有好几条，
 * 单纯用 `>` 会把它们一起吞掉。
 *
 * 时间戳解析不出来的消息一律当作新消息：宁可重复处理一次，也不要静默丢消息。
 */
export function messagesAfter(messages, cursor) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  if (isCursorUnset(cursor)) return [...messages];
  const selfSeen = cursor.selfSeen;
  return messages.filter((m) => {
    if (m?.is_self && selfSeen?.has(String(m.message_id ?? ''))) return false;
    const t = msgTime(m);
    if (!Number.isFinite(t)) return true;
    if (t > cursor.ts) return true;
    if (t < cursor.ts) return false;
    return !cursor.ids.has(String(m.message_id ?? ''));
  });
}

/**
 * 把这批消息记为"已消费"。
 *
 * 和顺序无关——传进来的数组乱序也能得到正确结果，这正是改成时间语义的目的。
 */
export function advanceCursor(cursor, messages) {
  if (!cursor || !Array.isArray(messages)) return cursor;
  if (!cursor.selfSeen) cursor.selfSeen = new Map();   // 兼容旧形状的游标
  const pushTime = (t, id) => {
    if (t > cursor.ts) {
      cursor.ts = t;
      cursor.ids = id ? new Set([id]) : new Set();
    } else if (t === cursor.ts && id) {
      cursor.ids.add(id);
    }
  };

  let earliestSelf = Infinity;
  let sawOthers = false;
  for (const m of messages) {
    const t = msgTime(m);
    if (!Number.isFinite(t)) continue;
    const id = String(m.message_id ?? '');
    if (m.is_self) {
      // 只记 id，不推时间，见文件头
      if (id) cursor.selfSeen.set(id, t);
      earliestSelf = Math.min(earliestSelf, t);
      continue;
    }
    sawOthers = true;
    pushTime(t, id);
  }
  // 起步时这批全是自发消息：时间轴总得起步，退后一段再起，别用本机时间直接起
  if (!sawOthers && !cursor.ts && Number.isFinite(earliestSelf)) {
    cursor.ts = earliestSelf - SELF_CLOCK_SKEW_MS;
    cursor.ids = new Set();
  }

  for (const [id, t] of cursor.selfSeen) {
    if (t < cursor.ts) cursor.selfSeen.delete(id);
  }
  return cursor;
}

/**
 * 按时间就地排序。
 *
 * appendToBuffer 是纯追加（只按 message_id 去重，不排序），它同样依赖
 * "MCP 返回的一定有序"这个前提。后台回填打破了它，所以这里兜一道底。
 *
 * 时间戳解析不出来的保持相对位置不动（稳定排序 + NaN 当作"和邻居相等"），
 * 免得把它们全甩到一端。
 */
export function sortByTime(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const keyed = messages.map((m, i) => ({ m, i, t: msgTime(m) }));
  keyed.sort((a, b) => {
    const at = Number.isFinite(a.t) ? a.t : NaN;
    const bt = Number.isFinite(b.t) ? b.t : NaN;
    if (!Number.isFinite(at) || !Number.isFinite(bt)) return a.i - b.i;
    if (at !== bt) return at - bt;
    return a.i - b.i;   // 同一秒内保持到达顺序
  });
  for (let i = 0; i < keyed.length; i++) messages[i] = keyed[i].m;
  return messages;
}
