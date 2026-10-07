/**
 * 群友编辑过的消息。
 *
 * Telegram 编辑消息不换 message_id。buffer 按 ID 去重，以前编辑后的内容直接被
 * 当成重复丢掉，bot 一直以为你说的还是改之前那句。
 *
 * 光原地改内容也不够：session 按时间游标读新消息，原消息的时间早就在游标后面了，
 * 改了它模型也看不到。所以除了更新原消息，还要在编辑发生的时间点追加一条
 * 「修改了消息」事件，走正常的新消息路径进 session。
 *
 * 只认 MCP 显式标了 `edited: true` 的：qq-mcp 没有编辑，也不会标；同一个 ID
 * 因为渲染差异内容略有不同时（比如回填和实时两条路），不能误报成编辑。
 */

const sameUrls = (a = [], b = []) => a.length === b.length && a.every((u, i) => u === b[i]);

/**
 * 处理一条「ID 已经见过」的消息。
 *
 * @param existing buffer 里已有的那条（会被原地更新）
 * @param incoming MCP 这次返回的同 ID 消息
 * @returns 需要追加的编辑事件；不是编辑、或者内容没变时为 null
 */
export function applyIncomingEdit(existing, incoming) {
  if (!existing || !incoming?.edited || incoming.is_self) return null;
  const content = incoming.content ?? '';
  const urls = incoming.image_urls || [];
  if (content === (existing.content ?? '') && sameUrls(urls, existing.image_urls || [])) {
    return null;   // 同一次编辑每秒轮询都会再来一遍，内容没变就什么都不做
  }

  existing.content = content;
  existing.image_urls = urls;
  existing._images = urls.map(url => ({ data: url, mimeType: 'image/jpeg' }));
  existing.edited = true;
  existing.edit_date = incoming.edit_date;

  const at = incoming.edit_date || new Date().toISOString();
  return {
    ...incoming,
    // 新 ID：要能通过去重、被游标当成新消息；带上时间，同一条改多次各是一个事件
    message_id: `${incoming.message_id}~edit~${Date.parse(at) || Date.now()}`,
    timestamp: at,
    content: `（修改了消息 #${incoming.message_id}，改成：）${content}`,
    image_urls: urls,
    _images: urls.map(url => ({ data: url, mimeType: 'image/jpeg' })),
    edit_of: incoming.message_id,
  };
}
