import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blinkTransform, describeSkinImport, gazeOffset, hairTransform, layerTransform, layeredRig, orderedSkinLayers,
  skinViewBox,
} from './skinModel.js';

test('recognizes LayerDiff, standard skins and legacy image skins', () => {
  assert.equal(describeSkinImport({ frame_size: [1024, 1024], parts: { face: {} } }).kind, 'layered');
  assert.equal(describeSkinImport({ format: 'petgpt-layered-skin', version: 1, name: 'A', layers: [{}] }).name, 'A');
  assert.equal(describeSkinImport({ name: 'Legacy', moods: { normal: 'idle.png' } }).kind, 'image');
  assert.throws(() => describeSkinImport({ format: 'petgpt-layered-skin', version: 2, layers: [{}] }));
  assert.throws(() => describeSkinImport({ parts: {} }));
  assert.throws(() => describeSkinImport({ name: 'Bad', moods: { happy: 'happy.png' } }));
});

test('fits a tall character using its bounds with breathing space, independent of canvas padding', () => {
  const manifest = { canvas: [1024, 1024], layers: [
    { name: 'front', origin: [400, 60], size: [160, 210], z: 2 },
    { name: 'back', origin: [288, 100], size: [424, 900], z: 0 },
    { name: 'tie', origin: [400, 300], size: [100, 100], z: 0 },
  ] };
  assert.deepEqual(orderedSkinLayers(manifest).map(l => l.name), ['back', 'tie', 'front']);
  assert.equal(manifest.layers[0].name, 'front');
  assert.deepEqual(skinViewBox(manifest).split(' ').map(Number), [264.5, 36.5, 471, 987]);
});

// Applies an SVG transform list (translate/rotate with optional center/scale/skewX) to a point, rightmost first.
function apply(transform, [x, y]) {
  const ops = [...transform.matchAll(/(\w+)\(([^)]*)\)/g)].map(([, op, args]) => [op, args.trim().split(/\s+/).map(Number)]);
  for (const [op, [a, b = op === 'scale' ? a : 0, c = 0]] of ops.reverse()) {
    const r = a * Math.PI / 180;
    if (op === 'translate') [x, y] = [x + a, y + b];
    else if (op === 'scale') [x, y] = [x * a, y * b];
    else if (op === 'rotate') {
      [x, y] = [x - b, y - c];
      [x, y] = [x * Math.cos(r) - y * Math.sin(r) + b, x * Math.sin(r) + y * Math.cos(r) + c];
    }
    else if (op === 'skewX') x += y * Math.tan(r);
  }
  return [x, y];
}
const close = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `${actual} ≈ ${expected}`));

const layerDiff = { canvas: [1024, 1024], layers: [
  { name: 'back hair', origin: [288, 91], size: [394, 440], z: 0 },
  { name: 'face', origin: [440, 117], size: [104, 118], z: 1 },
  { name: 'eyelash', origin: [456, 165], size: [81, 44], z: 2 },
  { name: 'eyewhite', origin: [462, 170], size: [70, 37], z: 3 },
  { name: 'irides', origin: [465, 169], size: [63, 37], z: 4 },
  { name: 'front hair', origin: [409, 61], size: [152, 215], z: 5 },
] };

test('rigs LayerDiff eyes and hair by tag, leaving other packages static', () => {
  const rig = layeredRig(layerDiff, { center: [498, 188], angle: -22.5 });
  assert.deepEqual(rig.eyes.layers, ['eyewhite', 'irides', 'eyelash']);
  assert.deepEqual(rig.eyes.irisRegion, [462, 169, 70, 38]);
  assert.deepEqual(rig.hair.map(h => [h.name, h.pivotY]), [['back hair', 91], ['front hair', 61]]);
  assert.equal(layeredRig(layerDiff, null).eyes, null);
  const plain = layeredRig({ layers: [{ name: 'body', origin: [0, 0], size: [1, 1] }] }, null);
  assert.deepEqual([plain.eyes, plain.hair, plain.head, plain.tail, plain.skirt, plain.parts.size], [null, [], null, null, null, 0]);
});

const dressed = { canvas: [1024, 1024], layers: [
  ...layerDiff.layers,
  { name: 'topwear', origin: [363, 228], size: [283, 393], z: 6 },
  { name: 'bottomwear', origin: [297, 401], size: [384, 286], z: 7 },
  { name: 'legwear', origin: [428, 583], size: [158, 349], z: 8 },
  { name: 'tail', origin: [594, 515], size: [118, 228], z: 9 },
] };

test('rigs the head about the neck, the tail at its root and only skirts', () => {
  const rig = layeredRig(dressed, { center: [498, 188], angle: -22.5 });
  assert.deepEqual(rig.head.pivot, [492, 235]);
  assert.ok(rig.head.layers.includes('back hair') && rig.head.layers.includes('irides') && !rig.head.layers.includes('topwear'));
  assert.deepEqual(rig.tail.pivot, [594, 515]);
  assert.equal(rig.skirt.pivotY, 401);
  assert.ok(['tail', 'bottomwear', 'face', 'eyelash'].every(name => rig.parts.has(name)));
  const trousers = { layers: dressed.layers.map(l => l.name === 'bottomwear' ? { ...l, size: [170, 286] } : l) };
  assert.equal(layeredRig(trousers, null).skirt, null);
});

test('at rest only blink and sway animate; a swing turns the head about the neck and lets parts hang', () => {
  const rig = layeredRig(dressed, { center: [498, 188], angle: -22.5 });
  assert.equal(layerTransform(rig, 'face', { seconds: 1 }), '');
  assert.equal(layerTransform(rig, 'eyelash', { seconds: 1, blink: 1 }), '');
  assert.equal(layerTransform(rig, 'topwear', { seconds: 1, pose: { head: 3 } }), '');
  const pose = { body: 6, head: -2, hair: -4, tail: -5, skirt: -3 };
  const face = layerTransform(rig, 'face', { seconds: 1, pose });
  close(apply(face, [492, 235]), [492, 235]);
  assert.ok(apply(face, [492, 117])[0] < 492, 'a counter-clockwise head turn moves the crown left');
  close(apply(layerTransform(rig, 'tail', { seconds: 1, pose }), [594, 515]), [594, 515]);
  const skirt = layerTransform(rig, 'bottomwear', { seconds: 1, pose });
  close(apply(skirt, [400, 401]), [400, 401]);
  assert.ok(apply(skirt, [400, 687])[0] > 400, 'the hem hangs right while the body swings clockwise');
  // The hair hangs against the swing on top of its idle sway.
  const hair = rig.hair[0];
  assert.ok(apply(layerTransform(rig, 'back hair', { seconds: 1, pose }), [300, 531])[0]
    > apply(hairTransform(hair, 1), [300, 531])[0]);
  // Eyes keep blinking inside the turned head.
  assert.equal(layerTransform(rig, 'eyelash', { seconds: 1, blink: 0.5, pose }).split('rotate(').length - 1, 3);
});

test('blinking keeps the tilted eye line and squeezes across it', () => {
  const eyes = { pivot: [100, 50], angle: -22.5, shift: 2 };
  assert.equal(blinkTransform(eyes, 1), '');
  const closed = blinkTransform(eyes, 0);
  const r = -22.5 * Math.PI / 180;
  const along = [Math.cos(r), Math.sin(r)];
  const across = [-Math.sin(r), Math.cos(r)];
  const shifted = [100 + across[0] * 2, 50 + across[1] * 2];
  close(apply(closed, [100 + along[0] * 10, 50 + along[1] * 10]), [shifted[0] + along[0] * 10, shifted[1] + along[1] * 10]);
  close(apply(closed, [100 + across[0] * 10, 50 + across[1] * 10]), shifted);
});

test('hair sways from its roots and the iris stays within its range', () => {
  const hair = { amplitude: 0.9, lag: 0, pivotY: 91 };
  const transform = hairTransform(hair, 1.2);
  close(apply(transform, [300, 91]), [300, 91]);
  assert.notEqual(apply(transform, [300, 531])[0], 300);
  const range = [4, 2];
  assert.deepEqual(gazeOffset(0, 0, range), [0, 0]);
  const far = gazeOffset(1e9, 0, range);
  assert.ok(far[0] < 4 && far[0] > 3.99 && far[1] === 0);
  const diagonal = gazeOffset(-300, 400, range);
  assert.ok(diagonal[0] < 0 && diagonal[1] > 0 && Math.hypot(diagonal[0] / 4, diagonal[1] / 2) < 1);
});
