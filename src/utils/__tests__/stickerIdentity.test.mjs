import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  extractFileId, contentHash, findByFileId, findByHash, backfillFileIds,
} from '../social/stickerIdentity.js';

// 真实形状：同一张图，fileid 相同、rkey 每次不同
const QQ = (fileid, rkey) =>
  `https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=${fileid}&rkey=${rkey}`;
const FID = 'EhStPhhmT7LYPuuuiY3VPtalGt7IohjenAIg_woo';

// ───────── fileid 抽取 ─────────

test('⚠️ 同一张图的三条 URL，fileid 相同而 rkey 不同 —— 这正是漏掉重复的原因', () => {
  const urls = [
    QQ(FID, 'CAMSMF0-vDcWgnip54ErYw59c6t6LSB1kl'),
    QQ(FID, 'CAMSMNXdbVw3eIGAERV0yMDrCJyhGlggiD'),
    QQ(FID, 'CAISMJ70QzZTYBAv58xu7mMOeFmZYofF4R'),
  ];
  // 旧逻辑：整条 URL 比对 → 三条互不相同 → 三次都判为"新表情"
  assert.equal(new Set(urls).size, 3, '前提：整条 URL 确实各不相同');
  // 新逻辑：只看 fileid → 同一张
  assert.equal(new Set(urls.map(extractFileId)).size, 1);
});

test('拿不到 fileid 时返回 null，交给内容哈希兜底', () => {
  assert.equal(extractFileId('/Users/jules/Library/.../NapCat/cache/abc.jpg'), null,
    '本地路径没有 fileid —— 而这已经是现在的主力路径');
  assert.equal(extractFileId('https://example.com/a.png'), null);
  assert.equal(extractFileId(''), null);
  assert.equal(extractFileId(null), null);
});

test('URL 编码的 fileid 会被解开', () => {
  assert.equal(extractFileId('https://x/?fileid=a%2Bb%3Dc&rkey=z'), 'a+b=c');
});

test('参数顺序不影响抽取', () => {
  assert.equal(extractFileId('https://x/?fileid=ABC'), 'ABC');
  assert.equal(extractFileId('https://x/?rkey=z&fileid=ABC&appid=1'), 'ABC');
  assert.equal(extractFileId('https://x/?FileId=ABC'), 'ABC', '大小写不敏感');
});

// ───────── 内容哈希 ─────────

const b64 = (s) => Buffer.from(s).toString('base64');

test('相同字节 → 相同哈希；不同字节 → 不同', async () => {
  const a = await contentHash(b64('same bytes'), webcrypto.subtle);
  const b = await contentHash(b64('same bytes'), webcrypto.subtle);
  const c = await contentHash(b64('other bytes'), webcrypto.subtle);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/, 'SHA-256 十六进制');
});

test('data: 前缀会被剥掉 —— 同一张图带不带前缀该是同一个哈希', async () => {
  const raw = await contentHash(b64('img'), webcrypto.subtle);
  const pre = await contentHash(`data:image/jpeg;base64,${b64('img')}`, webcrypto.subtle);
  assert.equal(raw, pre);
});

test('算不出来时返回 null，不抛 —— 判重失败不该让收藏整个失败', async () => {
  assert.equal(await contentHash('', webcrypto.subtle), null);
  assert.equal(await contentHash(null, webcrypto.subtle), null);
  assert.equal(await contentHash(b64('x'), null), null, '环境不支持 subtle');
  assert.equal(await contentHash('%%%不是base64%%%', webcrypto.subtle), null);
});

// ───────── 查重 ─────────

const ents = [
  { id: 1, meaning: 'a', fileid: FID, sha256: 'aaa' },
  { id: 2, meaning: 'b', fileid: 'OTHER', sha256: 'bbb' },
  { id: 3, meaning: 'c' },   // 老条目，两个 key 都没有
];

test('fileid 命中', () => {
  assert.equal(findByFileId(ents, QQ(FID, 'anything'))?.id, 1);
  assert.equal(findByFileId(ents, QQ('NOPE', 'x')), null);
  assert.equal(findByFileId(ents, '/local/path.jpg'), null);
});

test('哈希命中', () => {
  assert.equal(findByHash(ents, 'aaa')?.id, 1);
  assert.equal(findByHash(ents, 'zzz'), null);
  assert.equal(findByHash(ents, null), null, 'null 不该匹配上没有 sha256 的老条目');
});

test('没有 key 的老条目不会被误判为命中', () => {
  assert.equal(findByFileId([{ id: 9 }], QQ(FID, 'x')), null);
  assert.equal(findByHash([{ id: 9 }], 'aaa'), null);
});

test('空输入安全', () => {
  assert.equal(findByFileId(null, QQ(FID, 'x')), null);
  assert.equal(findByHash(undefined, 'aaa'), null);
});

// ───────── 回填 ─────────

test('从已存的 url 里补 fileid', () => {
  const list = [
    { id: 1, url: QQ('AAA', 'r1') },
    { id: 2, url: '/local/no-fileid.jpg' },
    { id: 3, url: QQ('BBB', 'r2'), fileid: 'ALREADY' },
  ];
  assert.equal(backfillFileIds(list), 1, '只补拿得到的那条');
  assert.equal(list[0].fileid, 'AAA');
  assert.equal(list[1].fileid, undefined, '本地路径抠不出来，留给哈希');
  assert.equal(list[2].fileid, 'ALREADY', '已有的不覆盖');
});

test('回填后，旧的三张 Miku 会被认出是同一张', () => {
  const list = [
    { id: 6, url: QQ(FID, 'r1') },
    { id: 11, url: QQ(FID, 'r2') },
  ];
  backfillFileIds(list);
  // 第三次再来同一张图（又一个新 rkey）→ 这次挡得住
  assert.ok(findByFileId(list, QQ(FID, 'r3-brand-new')));
});

test('空输入安全', () => {
  assert.equal(backfillFileIds([]), 0);
  assert.equal(backfillFileIds(null), 0);
});
