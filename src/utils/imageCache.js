/**
 * 已下载图片的 LRU 缓存：URL → base64。
 *
 * 为什么需要：`resolveImageUrls` 每次都重新下载，而 Intent 循环会反复读取
 * buffer 里最近几十条消息。同一张群图在一轮对话里会被拉取很多次 —— 既慢，
 * 又给 QQ 的图床白白加压。
 *
 * 为什么按字节数而不是条数限容：图片 base64 的大小能差两个数量级（一个表情
 * 几 KB，一张截图几 MB），按条数限根本控不住内存。
 */

/** 缓存总量上限。超过就从最久未用的开始丢。 */
export const IMAGE_CACHE_MAX_BYTES = 24 * 1024 * 1024;

/**
 * 创建一个缓存实例。
 *
 * 做成工厂而不是模块级单例，是为了能在测试里拿到干净的实例 —— 共享单例的
 * 测试会互相污染，还得依赖执行顺序。
 */
export const createImageCache = (maxBytes = IMAGE_CACHE_MAX_BYTES) => {
  // Map 保持插入顺序，重新 set 就能把条目挪到末尾，天然是个 LRU
  const entries = new Map();
  let totalBytes = 0;

  const sizeOf = (entry) => (entry?.data?.length || 0);

  const evictUntilFits = () => {
    for (const key of entries.keys()) {
      if (totalBytes <= maxBytes) break;
      const victim = entries.get(key);
      entries.delete(key);
      totalBytes -= sizeOf(victim);
    }
  };

  return {
    get(url) {
      if (!url) return undefined;
      const hit = entries.get(url);
      if (hit === undefined) return undefined;
      // 命中即刷新位置：删了再塞回去就排到末尾，成为最近使用
      entries.delete(url);
      entries.set(url, hit);
      return hit;
    },

    set(url, entry) {
      if (!url || !entry?.data) return;
      const incoming = sizeOf(entry);
      // 单张就超上限的图不缓存 —— 存进去会把其它所有条目挤光
      if (incoming > maxBytes) return;
      const existing = entries.get(url);
      if (existing !== undefined) {
        entries.delete(url);
        totalBytes -= sizeOf(existing);
      }
      entries.set(url, entry);
      totalBytes += incoming;
      evictUntilFits();
    },

    has(url) {
      return entries.has(url);
    },

    clear() {
      entries.clear();
      totalBytes = 0;
    },

    get size() {
      return entries.size;
    },

    get bytes() {
      return totalBytes;
    },
  };
};

export default { createImageCache, IMAGE_CACHE_MAX_BYTES };
