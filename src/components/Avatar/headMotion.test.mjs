import test from 'node:test';
import assert from 'node:assert/strict';
import { GLANCE_INTERVAL, TILT_INTERVAL, createHeadMotion } from './headMotion.js';

// mulberry32: a repeatable random source.
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};

const FRAME = 1 / 30;

// Steps at 30 fps and returns every frame's output.
function run(motion, from, to, state = {}) {
  const frames = [];
  for (let t = from; t < to; t += FRAME) frames.push({ t, ...motion.update(t, state) });
  return frames;
}

test('thinking leans the head and looks up to one side, then settles back exactly', () => {
  const motion = createHeadMotion(() => 0.7);
  const thinking = run(motion, 0, 3, { thinking: true });
  assert.ok(Math.abs(thinking.at(-1).tilt - 4) < 0.05, `tilt ${thinking.at(-1).tilt}`);
  assert.deepEqual(thinking.at(-1).gaze, [0.5, -0.9]);
  assert.ok(thinking.every(f => f.tilt >= 0), 'one side for the whole thought');
  // Both schedules start over when the thought ends, so nothing fires right away.
  const after = run(motion, 3, 3 + GLANCE_INTERVAL[0] - 0.1);
  assert.ok(after.every(f => f.gaze === null));
  assert.equal(after.at(-1).tilt, 0);
});

test('glances start at random, never sooner or later than their interval allows', () => {
  const [low, high] = GLANCE_INTERVAL;
  for (const seed of [1, 2, 3, 4, 5]) {
    const frames = run(createHeadMotion(seeded(seed)), 0, 600);
    const spans = [];
    frames.forEach((f, i) => {
      const before = i > 0 && frames[i - 1].gaze;
      if (f.gaze && !before) spans.push([f.t, null]);
      if (!f.gaze && before) spans.at(-1)[1] = f.t;
    });
    assert.ok(spans[0][0] >= low && spans[0][0] <= high + FRAME, `seed ${seed}: first at ${spans[0][0]}`);
    // Spacing runs from the end of one glance to the start of the next.
    const gaps = spans.slice(1).map(([start], i) => start - spans[i][1]);
    assert.ok(gaps.every(g => g >= low - FRAME && g <= high + FRAME), `seed ${seed}: ${gaps.map(g => g.toFixed(1))}`);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) > 3, `seed ${seed}: the spacing varies`);
  }
});

test('tilts keep their own schedule and stack with a glance', () => {
  const [low, high] = TILT_INTERVAL;
  const frames = run(createHeadMotion(seeded(7)), 0, 600);
  // Only a tilt leans further than a glance's 1.2 degrees.
  const starts = frames.filter((f, i) => i && Math.abs(f.tilt) > 2 && Math.abs(frames[i - 1].tilt) <= 2);
  assert.ok(starts.length >= Math.floor(600 / (high + 3)) && starts.length <= Math.ceil(600 / low), `${starts.length} tilts`);
  assert.ok(frames.every(f => Math.abs(f.tilt) <= 3.5 + 1.2 + 1e-9));
});

test('a drag holds back new actions, and an overdue one starts once it ends', () => {
  const motion = createHeadMotion(seeded(1));
  assert.ok(run(motion, 0, 60, { dragging: true }).every(f => f.tilt === 0 && f.gaze === null));
  assert.ok(run(motion, 60, 60.5).some(f => f.gaze));
});
