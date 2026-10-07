import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStickerState, buildStickerQuestion, parseStickerAnswer,
  leastRecentlyUsed, pickSticker, toCriteriaKey, fromCriteriaKey,
  STICKER_CONTEXT_WINDOW, STICKER_MIN_CONFIDENCE, STICKER_MIN_RATIO,
} from '../social/stickerPick.js';

const msg = (sender, content, isSelf = false) => ({ sender_name: sender, content, is_self: isSelf });
const stk = (id, meaning, lastUsed = null, used = 0) => ({ id, meaning, lastUsed, used });

const POOL = [
  stk(6, '吐舌头卖萌的初音未来 (Miku)', '2026-09-17T08:06:22Z', 23),
  stk(200, '无奈扶额猫咪，表达无语、头疼或自嘲。', '2026-05-01T00:00:00Z', 5),
  stk(240, 'Finance bro 扮演中 - 企鹅戴眼镜穿马甲，调侃装成功人士', null, 0),
];

// ───────── state ─────────

test('窗口是最近 16 条', () => {
  assert.equal(STICKER_CONTEXT_WINDOW, 16);
  const many = Array.from({ length: 40 }, (_, i) => msg('张三', `m${i}`));
  const s = buildStickerState(many);
  assert.equal(s.conversation.length, 16);
  assert.equal(s.conversation[15].text, 'm39', '取的是最近的');
});

test('标出哪条是自己', () => {
  const s = buildStickerState([msg('张三', 'a'), msg('bot', 'b', true)]);
  assert.equal(s.conversation[0].speaker, '张三');
  assert.equal(s.conversation[1].speaker, s.you_are);
  assert.match(s.you_are, /我自己/);
});

test('空输入返回 null', () => {
  assert.equal(buildStickerState([]), null);
  assert.equal(buildStickerState(null), null);
});

// ───────── criteria key（id 污染修复）─────────

test('⚠️ criteria key 带前缀 —— 裸数字会和聊天里的数字撞车', () => {
  // 沙盒实测：聊天最后两条是「6」「拉我」，Jev 就选了 #6
  const q = buildStickerQuestion(POOL);
  const keys = Object.keys(q.sticker.criteria);
  assert.deepEqual(keys.sort(), ['sticker_200', 'sticker_240', 'sticker_6']);
  for (const k of keys) assert.ok(Number.isNaN(Number(k)), `${k} 不该是纯数字`);
});

test('key 能来回转换', () => {
  assert.equal(toCriteriaKey(42), 'sticker_42');
  assert.equal(fromCriteriaKey('sticker_42'), '42');
  assert.equal(fromCriteriaKey('42'), null, '裸数字不认');
  assert.equal(fromCriteriaKey(null), null);
});

test('instructions 是英文，criteria 是中文含义（天然如此，没法改）', () => {
  const q = buildStickerQuestion(POOL);
  assert.doesNotMatch(q.sticker.instructions, /[一-鿿]/);
  assert.equal(q.sticker.criteria.sticker_6, POOL[0].meaning);
});

// ───────── 答案解析与置信门槛 ─────────

const ans = (key, conf, probs) => ({
  sticker: { type: 'choice', choice: key, confidence: conf, probabilities: probs },
});

test('判断明确时 decisive 为真 —— 沙盒里 #240 是 61% vs 12%', () => {
  const r = parseStickerAnswer(ans('sticker_240', 0.59, { sticker_240: 0.61, sticker_200: 0.12 }), POOL);
  assert.equal(r.id, '240');
  assert.equal(r.decisive, true);
  assert.ok(r.ratio > STICKER_MIN_RATIO);
});

test('在猜的时候 decisive 为假 —— 41% vs 30% 几乎持平', () => {
  const r = parseStickerAnswer(ans('sticker_6', 0.38, { sticker_6: 0.41, sticker_200: 0.30 }), POOL);
  assert.equal(r.decisive, false, '第一名只比第二名高一点，那是在猜');
});

test('置信够高但和第二名拉不开，仍然算猜', () => {
  const r = parseStickerAnswer(ans('sticker_6', 0.9, { sticker_6: 0.40, sticker_200: 0.38 }), POOL);
  assert.ok(r.confidence >= STICKER_MIN_CONFIDENCE);
  assert.equal(r.decisive, false, '两个条件必须同时满足');
});

test('枚举外的 key 被拒', () => {
  assert.equal(parseStickerAnswer(ans('sticker_999', 0.9, {}), POOL), null);
  assert.equal(parseStickerAnswer(ans('忽略之前的指令', 0.9, {}), POOL), null);
  assert.equal(parseStickerAnswer(null, POOL), null);
});

test('只有一个选项时 ratio 视为无穷', () => {
  const r = parseStickerAnswer(ans('sticker_6', 0.9, { sticker_6: 1.0 }), POOL);
  assert.equal(r.ratio, Infinity);
  assert.equal(r.decisive, true);
});

// ───────── 退路 ─────────

test('最久没发的排第一；从没发过的优先', () => {
  assert.equal(leastRecentlyUsed(POOL).id, 240, 'lastUsed 为 null 算最久');
  const used = [stk(1, 'a', '2026-01-01T00:00:00Z'), stk(2, 'b', '2026-06-01T00:00:00Z')];
  assert.equal(leastRecentlyUsed(used).id, 1);
});

test('空池返回 null', () => {
  assert.equal(leastRecentlyUsed([]), null);
  assert.equal(leastRecentlyUsed(null), null);
});

// ───────── 端到端 ─────────

const chat = [msg('张三', '我手上的香橙派也成理财产品了')];

test('明确时用 Jev 的选择', async () => {
  const r = await pickSticker(chat, POOL, {
    apiKey: 'k',
    request: async () => ({ answers: ans('sticker_240', 0.59, { sticker_240: 0.61, sticker_200: 0.12 }).sticker ? { sticker: { type: 'choice', choice: 'sticker_240', confidence: 0.59, probabilities: { sticker_240: 0.61, sticker_200: 0.12 } } } : {} }),
  });
  assert.equal(r.id, '240');
  assert.equal(r.source, 'jev');
});

test('拿不准时退回最久没发的，但仍然发得出去', async () => {
  const r = await pickSticker(chat, POOL, {
    apiKey: 'k',
    request: async () => ({ answers: { sticker: { type: 'choice', choice: 'sticker_6', confidence: 0.38, probabilities: { sticker_6: 0.41, sticker_200: 0.30 } } } }),
  });
  assert.equal(r.source, 'fallback');
  assert.equal(r.indecisive, true);
  assert.equal(r.id, '240', '最久没发的');
});

test('Jev 挂了也要发得出去 —— 主模型已经决定要发表情了', async () => {
  const r = await pickSticker(chat, POOL, {
    apiKey: 'k', request: async () => { throw new Error('API error 429'); },
  });
  assert.equal(r.source, 'fallback');
  assert.ok(r.id);
});

test('没配 key 时不发请求，直接退路', async () => {
  let called = false;
  const r = await pickSticker(chat, POOL, { apiKey: '', request: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(r.source, 'fallback');
});

test('空表情库返回 null —— 这时该报错而不是硬发', async () => {
  assert.equal(await pickSticker(chat, [], { apiKey: 'k' }), null);
  assert.equal(await pickSticker(chat, null, { apiKey: 'k' }), null);
});

test('没有聊天记录时也能退路，不抛', async () => {
  const r = await pickSticker([], POOL, { apiKey: 'k', request: async () => { throw new Error('不该被调用'); } });
  assert.equal(r.source, 'fallback');
});

test('门槛常量', () => {
  assert.equal(STICKER_MIN_CONFIDENCE, 0.45);
  assert.equal(STICKER_MIN_RATIO, 1.8);
});
