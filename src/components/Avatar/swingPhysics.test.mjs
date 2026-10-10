import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwing, stepSwing, swingLever, swingSettled } from './swingPhysics.js';

const run = (swing, input, seconds, observe = () => {}) => {
  for (let t = 0; t < seconds; t += 1 / 60) observe(stepSwing(swing, input, 1 / 60));
  return swing;
};

test('a dragged character trails the motion, swings back past rest when stopped, then settles', () => {
  const swing = run(createSwing(), { vx: 600, lever: 1 }, 2);
  assert.ok(swing.body[0] > 5 && swing.body[0] <= 9, `trails clockwise: ${swing.body[0]}`);
  assert.ok(swing.head[0] < 0 && swing.hair[0] < 0 && swing.tail[0] < 0, 'hanging parts lean back toward vertical');
  let overshoot = 0;
  run(swing, {}, 0.8, s => { overshoot = Math.min(overshoot, s.body[0]); });
  assert.ok(overshoot < -1, `swings back past rest: ${overshoot}`);
  run(swing, {}, 6);
  assert.ok(swingSettled(swing));
});

test('the swing stays inside its limits however violently it is dragged', () => {
  const swing = createSwing();
  run(swing, { vx: 1e6, vy: -1e6, lever: 1 }, 1, s => {
    assert.ok(Math.abs(s.body[0]) <= 9 && Math.abs(s.stretch[0]) <= 0.05 && Math.abs(s.tail[0]) <= 15);
  });
  assert.ok(swing.stretch[0] > 0, 'lifting stretches the body');
});

test('a high grip dangles, a middle grip sways, a low grip leans the other way', () => {
  assert.equal(swingLever(0, 0, 300), 1);
  assert.ok(Math.abs(swingLever(150, 0, 300) - 0.4) < 1e-9);
  assert.ok(swingLever(300, 0, 300) < 0);
  assert.equal(swingLever(10, 0, 0), 1);
  const low = run(createSwing(), { vx: 600, lever: swingLever(300, 0, 300) }, 2);
  assert.ok(low.body[0] < 0);
});
