import test from 'node:test';
import assert from 'node:assert/strict';

import { createImageCache } from '../imageCache.js';

const entry = (bytes, mimeType = 'image/png') => ({ data: 'x'.repeat(bytes), mimeType });

test('存进去就能取回来', () => {
  const cache = createImageCache(1000);
  cache.set('https://a/1.png', entry(10));
  assert.equal(cache.get('https://a/1.png').data.length, 10);
  assert.equal(cache.get('https://a/missing.png'), undefined);
});

test('超出上限时丢掉最久未用的那条', () => {
  const cache = createImageCache(100);
  cache.set('a', entry(40));
  cache.set('b', entry(40));
  cache.set('c', entry(40)); // 总量 120 > 100，'a' 最久未用，被丢

  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
  assert.ok(cache.bytes <= 100);
});

test('读一下就能让条目免于被淘汰', () => {
  const cache = createImageCache(100);
  cache.set('a', entry(40));
  cache.set('b', entry(40));
  cache.get('a');            // a 变成最近使用，此时最久未用的是 b
  cache.set('c', entry(40));

  assert.equal(cache.has('a'), true, '刚读过的不该被淘汰');
  assert.equal(cache.has('b'), false);
});

test('重复 set 同一个 URL 不会把字节数算两遍', () => {
  const cache = createImageCache(1000);
  cache.set('a', entry(100));
  cache.set('a', entry(100));
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 100, '覆盖时要先减掉旧条目的大小');
});

test('覆盖成更大的图后，字节数跟着更新', () => {
  const cache = createImageCache(1000);
  cache.set('a', entry(10));
  cache.set('a', entry(500));
  assert.equal(cache.bytes, 500);
});

test('单张就超上限的图直接不缓存，避免挤光其它条目', () => {
  const cache = createImageCache(100);
  cache.set('small', entry(50));
  cache.set('huge', entry(500));

  assert.equal(cache.has('huge'), false, '装不下的不该存');
  assert.equal(cache.has('small'), true, '也不该连累已有条目');
});

test('无效输入被忽略，不会污染缓存', () => {
  const cache = createImageCache(1000);
  cache.set('', entry(10));
  cache.set('a', null);
  cache.set('b', { mimeType: 'image/png' }); // 没有 data
  assert.equal(cache.size, 0);
  assert.equal(cache.get(''), undefined);
  assert.equal(cache.get(undefined), undefined);
});

test('淘汰会持续到总量降回上限以内', () => {
  const cache = createImageCache(100);
  cache.set('a', entry(30));
  cache.set('b', entry(30));
  cache.set('c', entry(30));
  cache.set('d', entry(90)); // 要腾出 90，得连丢 a、b、c

  assert.ok(cache.bytes <= 100, `实际 ${cache.bytes}`);
  assert.equal(cache.has('d'), true);
});

test('clear 之后计数归零', () => {
  const cache = createImageCache(1000);
  cache.set('a', entry(100));
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test('各实例互不影响', () => {
  const one = createImageCache(1000);
  const two = createImageCache(1000);
  one.set('a', entry(10));
  assert.equal(two.has('a'), false);
});
