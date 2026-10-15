import test from 'node:test';
import assert from 'node:assert/strict';
import { GLANCE_INTERVAL, MAX_TILT, TILT_INTERVAL, createHeadMotion } from './headMotion.js';

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

test('a look around goes in many directions and the head rolls toward each', () => {
  const frames = run(createHeadMotion(seeded(3)), 0, 1200);
  const looks = frames.filter(f => f.gaze);
  const targets = new Set(looks.map(f => f.gaze));
  assert.ok(targets.size >= 60, `${targets.size} places looked at`);
  const has = (test) => [...targets].some(test);
  assert.ok(has(([x]) => x < -0.6) && has(([x]) => x > 0.6), 'both sides');
  assert.ok(has(([, y]) => y < -0.6) && has(([, y]) => y > 0.4) && has(([, y]) => Math.abs(y) < 0.2), 'up, down and level');
  assert.ok(has(([x, y]) => Math.abs(x) < 0.3 && y < -0.7), 'nearly straight up');
  // Once the head has caught up with a sideways look, it leans the same way, unless a separate tilt
  // happens to overlap the look and lean it the other way.
  const settled = looks.filter((f, i) => Math.abs(f.gaze[0]) >= 0.6 && i >= 20 && looks[i - 20].gaze === f.gaze);
  const toward = settled.filter(f => Math.sign(f.tilt) === Math.sign(f.gaze[0]));
  assert.ok(settled.length > 100 && toward.length / settled.length > 0.85, `${toward.length} of ${settled.length}`);
  assert.ok(frames.every(f => Math.abs(f.tilt) <= MAX_TILT));
});

test('tilts keep their own schedule', () => {
  const [low, high] = TILT_INTERVAL;
  for (const seed of [7, 8, 9]) {
    const frames = run(createHeadMotion(seeded(seed)), 0, 600);
    // A tilt holds past 2 degrees for well over half a second without a glance; a glance's roll
    // fades below that within a fraction of a second once the eyes return.
    let runs = 0;
    let since = null;
    for (const f of frames) {
      const leaning = !f.gaze && Math.abs(f.tilt) > 2;
      if (leaning) since ??= f.t;
      else {
        if (since !== null && f.t - since > 0.6) runs++;
        since = null;
      }
    }
    assert.ok(runs >= Math.floor(600 / (high + 3)) && runs <= Math.ceil(600 / low), `seed ${seed}: ${runs} tilts`);
  }
});

test('a drag holds back new actions, and an overdue one starts once it ends', () => {
  const motion = createHeadMotion(seeded(1));
  assert.ok(run(motion, 0, 60, { dragging: true }).every(f => f.tilt === 0 && f.gaze === null));
  assert.ok(run(motion, 60, 60.5).some(f => f.gaze));
});
