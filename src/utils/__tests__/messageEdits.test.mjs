import test from 'node:test';
import assert from 'node:assert/strict';

import { applyIncomingEdit } from '../social/messageEdits.js';

const original = () => ({
  message_id: '17200', sender_name: 'Jules', content: '明天几点开会',
  timestamp: '2026-10-07T12:30:00+08:00', image_urls: [],
});
const edit = (content, extra = {}) => ({
  message_id: '17200', sender_name: 'Jules', content, timestamp: '2026-10-07T12:30:00+08:00',
  edited: true, edit_date: '2026-10-07T12:31:00+08:00', image_urls: [], ...extra,
});

test('编辑：原消息改成新内容，并生成一条在编辑时间点的事件', () => {
  const existing = original();
  const event = applyIncomingEdit(existing, edit('明天十点开会'));
  assert.equal(existing.content, '明天十点开会');
  assert.equal(existing.edited, true);
  assert.ok(event);
  assert.notEqual(event.message_id, '17200', '新 ID 才能通过去重、被游标当成新消息');
  assert.equal(event.timestamp, '2026-10-07T12:31:00+08:00');
  assert.equal(event.content, '（修改了消息 #17200，改成：）明天十点开会');
  assert.equal(event.edit_of, '17200');
});

test('同一次编辑每秒都会再轮询到一遍——内容没变就不再出事件', () => {
  const existing = original();
  applyIncomingEdit(existing, edit('明天十点开会'));
  assert.equal(applyIncomingEdit(existing, edit('明天十点开会')), null);
});

test('改了两次，各出一条事件，ID 不同', () => {
  const existing = original();
  const a = applyIncomingEdit(existing, edit('十点'));
  const b = applyIncomingEdit(existing, edit('十一点', { edit_date: '2026-10-07T12:35:00+08:00' }));
  assert.ok(a && b);
  assert.notEqual(a.message_id, b.message_id);
  assert.equal(existing.content, '十一点');
});

test('只改了图（换了图片）也算编辑，事件带上新图', () => {
  const existing = { ...original(), image_urls: ['https://x/old.jpg'] };
  const event = applyIncomingEdit(existing, edit('明天几点开会', { image_urls: ['https://x/new.jpg'] }));
  assert.ok(event);
  assert.deepEqual(event._images, [{ data: 'https://x/new.jpg', mimeType: 'image/jpeg' }]);
  assert.deepEqual(existing.image_urls, ['https://x/new.jpg']);
});

test('没标 edited 的同 ID 消息不当编辑——QQ 那边回填和实时渲染略有差异时不能误报', () => {
  const existing = original();
  assert.equal(applyIncomingEdit(existing, { ...edit('渲染不一样的同一条'), edited: false }), null);
  assert.equal(existing.content, '明天几点开会');
});

test('bot 自己的消息不处理；找不到原消息也不处理', () => {
  assert.equal(applyIncomingEdit(original(), { ...edit('x'), is_self: true }), null);
  assert.equal(applyIncomingEdit(null, edit('x')), null);
});
