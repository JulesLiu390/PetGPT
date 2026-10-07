/**
 * 表情包判重 —— 两道 key：下载前看 fileid，下载后看内容哈希。
 *
 * 为什么原来的 URL 去重没用：QQ 图床的 URL 长这样
 *
 *   …?appid=1407&fileid=EhStPhhmT7LY…&rkey=CAMSMF0-vDcWgnip…
 *                       └─ 同一张图恒定 ─┘   └─ 每次都在变 ─┘
 *
 * `rkey` 是轮转的鉴权令牌。整条 URL 比对等于把随机数算进了 key，必然漏。
 * 实测被删掉的三张 Miku、三张"精神科大拇指"，各自 fileid 完全相同、rkey 三次三样。
 *
 * 而且图片现在优先解析成 NapCat 的本地路径，那个路径每次下载都不一样，
 * URL 去重在主力路径上彻底失效。
 *
 * 所以：
 *   A. fileid —— 从 URL 抠出来，**下载之前**就能判，省一次往返
 *   B. sha256 —— 拿到字节之后算，不依赖任何 URL 格式，本地路径/外部图床/手动导入都管用
 *
 * A 省流量，B 兜底。观测到的重复 100% 是字节完全相同的，所以 B 一定挡得住。
 *
 * 没做感知哈希（dHash/pHash）：它能抓"重新压过的同一张图"，但现存 25 张里
 * 连文件大小相同的都没有，一例都没发生过。等真出现再说。
 */

/**
 * 从 QQ 图床 URL 里抠出稳定标识。
 * 拿不到（本地路径、别的图床）就返回 null，交给内容哈希兜底。
 */
export function extractFileId(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/[?&]fileid=([^&#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/** base64 → Uint8Array。 */
function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 内容哈希。webview 里 crypto.subtle 是现成的，不用引依赖。
 * 算不出来（环境不支持 / base64 坏了）返回 null —— 判重失败只是少挡一次，
 * 不该让收藏整个失败。
 */
export async function contentHash(base64Data, subtle = globalThis.crypto?.subtle) {
  if (!base64Data || !subtle) return null;
  try {
    const buf = await subtle.digest('SHA-256', base64ToBytes(base64Data));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * 下载**之前**的判重。只认 fileid。
 * @returns 命中的条目，或 null
 */
export function findByFileId(entries, url) {
  const fid = extractFileId(url);
  if (!fid) return null;
  return (entries || []).find(e => e && e.fileid && e.fileid === fid) || null;
}

/**
 * 下载**之后**的判重。认内容哈希。
 * @returns 命中的条目，或 null
 */
export function findByHash(entries, sha256) {
  if (!sha256) return null;
  return (entries || []).find(e => e && e.sha256 && e.sha256 === sha256) || null;
}

/**
 * 给存量条目回填 fileid（从已存的 url 里抠）。
 * sha256 要读文件才能算，由调用方异步补，见 socialToolExecutor。
 * @returns 补了几条
 */
export function backfillFileIds(entries) {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const e of entries) {
    if (!e || e.fileid) continue;
    const fid = extractFileId(e.url);
    if (fid) { e.fileid = fid; n += 1; }
  }
  return n;
}
