import test from 'node:test';
import assert from 'node:assert/strict';
import { HOP_HEIGHT, hopCount, hopPose, requestHop } from './petReactions.js';

test('a hop crouches, rises a little, lands with a squash and settles', () => {
  assert.deepEqual(hopPose(0), { rise: 0, stretch: 1 });
  assert.equal(hopPose(-0.01), null);
  assert.equal(hopPose(0.66), null);
  const crouch = hopPose(0.08);
  assert.ok(crouch.rise === 0 && crouch.stretch < 1);
  assert.ok(hopPose(0.14).stretch > 1, 'stretched at launch');
  const apex = hopPose(0.26);
  assert.ok(Math.abs(apex.rise - HOP_HEIGHT) < 1e-9 && Math.abs(apex.stretch - 1) < 1e-9);
  assert.ok(HOP_HEIGHT < 0.02);
  const landing = hopPose(0.44);
  assert.ok(landing.rise === 0 && landing.stretch < 1);
  // No jumps between frames, even at 120 fps.
  for (let t = 0; t + 1 / 120 < 0.66; t += 1 / 120) {
    const [a, b] = [hopPose(t), hopPose(t + 1 / 120)];
    assert.ok(Math.abs(a.rise - b.rise) < 0.004 && Math.abs(a.stretch - b.stretch) < 0.015, `at ${t.toFixed(3)} s`);
  }
  assert.equal(hopPose(0.659).stretch.toFixed(4), '1.0000');
});

test('each click requests one hop', () => {
  const before = hopCount();
  requestHop();
  requestHop();
  assert.equal(hopCount(), before + 2);
});
