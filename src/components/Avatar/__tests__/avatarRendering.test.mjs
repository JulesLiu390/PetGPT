import test from 'node:test';
import assert from 'node:assert/strict';
import { repairGeneratedEdgeColors, blinkScaleAt, mouthFrameAt } from '../avatarRendering.js';

test('expanded alpha receives the patch color without changing coverage or original colors', () => {
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 180,
    180, 120, 90, 255, 180, 120, 90, 100, 0, 0, 0, 20,
  ]);
  const before = pixels.slice();
  repairGeneratedEdgeColors(pixels, 6, 1);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(pixels[i * 4 + 3], before[i * 4 + 3]);
    assert.deepEqual([...pixels.slice(i * 4, i * 4 + 3)], i === 0 ? [0, 0, 0] : [180, 120, 90]);
  }
});

test('an artificial opaque black rim is repaired as well as semitransparent pixels', () => {
  const pixels = new Uint8ClampedArray([40, 35, 45, 255, 0, 0, 0, 255]);
  repairGeneratedEdgeColors(pixels, 2, 1);
  assert.deepEqual([...pixels], [40, 35, 45, 255, 40, 35, 45, 255]);
});

test('isolated black mask artifacts are removed instead of borrowing color across a row or gap', () => {
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 0, 200, 130, 100, 255,
    0, 0, 0, 80, 0, 0, 0, 0,
  ]);
  const before = pixels.slice();
  before[11] = 0;
  repairGeneratedEdgeColors(pixels, 2, 2);
  assert.deepEqual(pixels, before);
});

test('different colored patches retain their local edge colors', () => {
  const pixels = new Uint8ClampedArray([
    200, 120, 90, 255, 0, 0, 0, 60, 0, 0, 0, 0,
    0, 0, 0, 60, 30, 35, 40, 255,
  ]);
  repairGeneratedEdgeColors(pixels, 5, 1);
  assert.deepEqual([...pixels.slice(4, 8)], [200, 120, 90, 60]);
  assert.deepEqual([...pixels.slice(12, 16)], [30, 35, 40, 60]);
});

test('empty or entirely transparent masks remain unchanged', () => {
  assert.deepEqual(repairGeneratedEdgeColors(new Uint8ClampedArray(), 0, 0), new Uint8ClampedArray());
  const pixels = new Uint8ClampedArray([20, 30, 40, 0]);
  repairGeneratedEdgeColors(pixels, 1, 1);
  assert.deepEqual([...pixels], [20, 30, 40, 0]);
});

test('eyes stay open between blinks and reopen after the double blink', () => {
  assert.equal(blinkScaleAt(0), 1);
  assert.equal(blinkScaleAt(1.7), 1);
  assert.ok(blinkScaleAt(1.92) < 0.1);
  assert.equal(blinkScaleAt(2.1), 1);
  assert.ok(blinkScaleAt(1.8 + 8 + 0.18 + 0.12) < 0.1);
  assert.equal(blinkScaleAt(1.8 + 8 + 0.5), 1);
});

test('moods choose a single valid mouth frame without stretching the skin patch', () => {
  for (const mood of ['normal', 'sad', 'idle-1', 'unknown']) assert.equal(mouthFrameAt(mood, 2), 0);
  assert.equal(mouthFrameAt('shocked', 0), 3);
  assert.equal(mouthFrameAt('smile', 0), 1);
  const frames = new Set(Array.from({ length: 100 }, (_, i) => mouthFrameAt('thinking', i / 30)));
  assert.ok(frames.size > 1);
  assert.ok([...frames].every((frame) => Number.isInteger(frame) && frame >= 0 && frame < 4));
});
