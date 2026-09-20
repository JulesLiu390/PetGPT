/**
 * 标签持久化。
 *
 * 标签是**冻结**的——它记录的是"发这条消息的当时"的状态，所以一条消息标过
 * 一次就永远不该再标第二次。不落盘的话，每次重启重建 session 都要把窗口里的
 * 64 条重标一遍：既花钱，又会出现同一条消息前后两次标得不一样的尴尬。
 *
 * 存在 workspace 里而不是 chat_history 表，是因为后者要动 Rust 侧的 schema，
 * 而这里的读写模式（整份读、批量写、按量裁剪）用一个 JSON 文件就够了。
 */

import { socialTargetDir } from '../socialTargetType.js';

/** 单个 target 最多留多少条标签。902317662 最忙的一天 1385 条，这个量够放几天。 */
export const MOOD_TAG_MAX_ENTRIES = 4000;

const SCHEMA_VERSION = 1;

export function moodTagPath(targetId, targetType = 'group') {
  return `social/${socialTargetDir(targetType)}/MOODTAG_${targetId}.json`;
}

/** 解析磁盘内容。任何损坏都当成"没有标签"，不抛——标签丢了不该拖垮启动。 */
export function parseStore(raw) {
  if (!raw || typeof raw !== 'string') return new Map();
  try {
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== SCHEMA_VERSION || !obj.tags) return new Map();
    return new Map(Object.entries(obj.tags));
  } catch {
    return new Map();
  }
}

/**
 * 序列化。超出上限时按 at 保留最新的——旧消息早就滑出窗口了，留着没用。
 */
export function serializeStore(map, { max = MOOD_TAG_MAX_ENTRIES } = {}) {
  let entries = [...map.entries()];
  if (entries.length > max) {
    entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    entries = entries.slice(0, max);
  }
  return JSON.stringify({ version: SCHEMA_VERSION, tags: Object.fromEntries(entries) });
}

/**
 * 每个 target 一个 store。
 *
 * @param io.read  async (path) => string|null
 * @param io.write async (path, content) => void
 */
export function createMoodTagStore(targetId, targetType, io) {
  const path = moodTagPath(targetId, targetType);
  let map = new Map();
  let loaded = false;
  let dirty = false;
  let flushTimer = null;

  const load = async () => {
    if (loaded) return map;
    loaded = true;
    try {
      map = parseStore(await io.read(path));
    } catch {
      map = new Map();
    }
    return map;
  };

  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    try {
      await io.write(path, serializeStore(map));
    } catch {
      dirty = true;   // 写失败下次再试，不抛
    }
  };

  return {
    path,
    load,
    get: (messageId) => map.get(String(messageId)) || null,
    has: (messageId) => map.has(String(messageId)),
    size: () => map.size,
    set(messageId, tag) {
      if (!messageId || !tag) return;
      map.set(String(messageId), { ...tag, at: tag.at ?? Date.now() });
      dirty = true;
    },
    /** 攒一会儿再写，避免每条消息一次磁盘 IO。 */
    scheduleFlush(delayMs = 5000) {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, delayMs);
    },
    flush,
    dispose() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      return flush();
    },
  };
}
