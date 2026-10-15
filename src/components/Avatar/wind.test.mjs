import test from 'node:test';
import assert from 'node:assert/strict';
import { GUST_INTERVAL, createWind, gustAt } from './wind.js';

const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};

test('a gust picks up, holds with flutter in one direction, then dies away smoothly', () => {
  const gust = { start: 10, duration: 2, side: -1, strength: 0.8, phase: 1 };
  assert.equal(gustAt(gust, 10), 0);
  assert.equal(gustAt(gust, 12), 0);
  assert.equal(gustAt(gust, 9), 0);
  const samples = [];
  for (let t = 10; t < 12; t += 1 / 120) samples.push(gustAt(gust, t));
  assert.ok(samples.every(v => v <= 0), 'never turns around mid-gust');
  assert.ok(Math.min(...samples) < -0.8, 'flutters past its strength');
  assert.ok(Math.abs(gustAt(gust, 10.05)) < Math.abs(gustAt(gust, 10.6)), 'picks up');
  assert.ok(Math.abs(gustAt(gust, 11.95)) < 0.05, 'dies away');
  assert.ok(samples.every((v, i) => !i || Math.abs(v - samples[i - 1]) < 0.06), 'no jumps at 120 fps');
});

test('gusts come at random within their interval, from both sides', () => {
  const [low, high] = GUST_INTERVAL;
  for (const seed of [1, 2, 3]) {
    const wind = createWind(seeded(seed));
    const spans = [];
    const sides = new Set();
    let before = 0;
    for (let t = 0; t < 1800; t += 1 / 30) {
      wind.advance(t);
      const push = wind.at(t);
      if (push && !before) spans.push([t, null]);
      if (!push && before) spans.at(-1)[1] = t;
      if (push) sides.add(Math.sign(push));
      before = push;
    }
    assert.ok(spans[0][0] >= low && spans[0][0] <= high + 0.1, `seed ${seed}: first at ${spans[0][0]}`);
    const gaps = spans.slice(1).map(([start], i) => start - spans[i][1]);
    assert.ok(gaps.every(g => g >= low - 0.1 && g <= high + 0.1), `seed ${seed}: ${gaps.map(g => g.toFixed(1))}`);
    assert.equal(sides.size, 2, `seed ${seed}: both directions`);
  }
});
