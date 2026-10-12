import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadMotion } from './headMotion.js';

// mulberry32: a repeatable random source.
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};

// Steps at 30 fps and returns every frame's output.
function run(motion, from, to, state) {
  const frames = [];
  for (let t = from; t < to; t += 1 / 30) frames.push({ t, ...motion.update(t, state) });
  return frames;
}

test('thinking leans the head and looks up to one side, then settles back exactly', () => {
  const motion = createHeadMotion(() => 0.7);
  const thinking = run(motion, 0, 3, { thinking: true, idle: true });
  assert.ok(Math.abs(thinking.at(-1).tilt - 4) < 0.05, `tilt ${thinking.at(-1).tilt}`);
  assert.deepEqual(thinking.at(-1).gaze, [0.5, -0.9]);
  assert.ok(thinking.every(f => f.tilt >= 0), 'one side for the whole thought');
  const after = run(motion, 3, 6, { thinking: false, idle: false });
  assert.deepEqual([after.at(-1).tilt, after.at(-1).gaze], [0, null]);
});

test('a resting cursor gets an occasional tilt or glance, and a moving one gets none', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const frames = run(createHeadMotion(seeded(seed)), 0, 180, { idle: true });
    assert.ok(frames.filter(f => f.t < 6).every(f => f.tilt === 0 && f.gaze === null), 'nothing right after start');
    assert.ok(frames.every(f => Math.abs(f.tilt) <= 3.5));
    // Count actions by their starts: the first moving frame after a still one.
    const starts = frames.filter((f, i) => i && (f.tilt || f.gaze) && !(frames[i - 1].tilt || frames[i - 1].gaze));
    assert.ok(starts.length >= 6 && starts.length <= 20, `seed ${seed}: ${starts.length} actions in 3 minutes`);
    assert.ok(frames.some(f => f.gaze) && frames.some(f => !f.gaze && Math.abs(f.tilt) > 2), `seed ${seed}: both kinds`);
  }
  const busy = run(createHeadMotion(seeded(1)), 0, 180, { idle: false });
  assert.ok(busy.every(f => f.tilt === 0 && f.gaze === null));
});

test('a glance ends as soon as the cursor moves', () => {
  const motion = createHeadMotion(seeded(1));
  const frames = run(motion, 0, 180, { idle: true });
  const glance = frames.find(f => f.gaze);
  const replay = createHeadMotion(seeded(1));
  run(replay, 0, glance.t + 1e-9, { idle: true });
  assert.equal(replay.update(glance.t + 0.05, { idle: false }).gaze, null);
});
