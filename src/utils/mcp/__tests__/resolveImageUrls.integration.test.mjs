import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * 已经解析成 base64 的图再解析一遍，必须原样留下。
 *
 * off 模式下 buffer 里的图会先被就地转成 base64，之后 appendNewMessages 和
 * pollTarget 还会各解析一遍。JPEG 的 base64 以 `/9j/` 开头，以前被当成本地
 * 路径去读文件、读不到就静默丢掉——Telegram 的照片全是 JPEG，一张都进不来。
 */
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const WEBP_B64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAw';

test('resolveImageUrls keeps already-resolved base64 and still reads real local paths', async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === 'get_mcp_servers') return [];
        calls.push([command, args]);
        if (command === 'read_local_image_as_base64') {
          if (args.path === '/Users/me/napcat/cache/a.jpg') return { data: JPEG_B64, mime_type: 'image/jpeg' };
          throw new Error(`no such file: ${args.path}`);
        }
        if (command === 'download_url_as_base64') return { data: JPEG_B64, mime_type: 'application/octet-stream' };
        throw new Error(`Unexpected Tauri command in test: ${command}`);
      },
    },
  };

  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { resolveImageUrls, looksLikeImageBase64 } = await vite.ssrLoadModule('/src/utils/mcp/toolExecutor.js');

    // 第一遍：URL → base64（octet-stream 按文件头修正成 jpeg）
    const url = 'https://api.telegram.org/file/bot<t>/photos/file_10.jpg';
    const first = await resolveImageUrls([{ data: url, mimeType: 'image/jpeg' }]);
    assert.equal(first.length, 1);
    assert.equal(first[0].data, JPEG_B64);
    assert.equal(first[0].mimeType, 'image/jpeg');
    assert.equal(first[0].sourceUrl, url);

    // 第二遍：线上丢图的那一步。不能去读文件，也不能丢
    calls.length = 0;
    const again = await resolveImageUrls([
      ...first,
      { data: PNG_B64, mimeType: 'image/png' },
      { data: WEBP_B64, mimeType: 'image/webp' },
    ]);
    assert.deepEqual(again.map(i => i.data), [JPEG_B64, PNG_B64, WEBP_B64]);
    assert.equal(again[0].sourceUrl, url, '来源要留着，sticker_save 靠它找原图');
    assert.deepEqual(calls, [], '已经是 base64 的不该再碰 Tauri');

    // 真正的本地路径（qq-mcp 给的 NapCat 副本）照常读
    const local = await resolveImageUrls([{ data: '/Users/me/napcat/cache/a.jpg', mimeType: 'image/jpeg' }]);
    assert.equal(local.length, 1);
    assert.equal(local[0].data, JPEG_B64);

    assert.equal(looksLikeImageBase64(JPEG_B64), true);
    assert.equal(looksLikeImageBase64('/Users/me/a.jpg'), false);
    assert.equal(looksLikeImageBase64(undefined), false);
  } finally {
    await vite.close();
    globalThis.window = previousWindow;
  }
});
