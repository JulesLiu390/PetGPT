import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blinkTransform, breathAt, describeSkinImport, gazeOffset, hairTransform, layerTransform, layeredRig,
  orderedSkinLayers, skinViewBox, thoughtDots,
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

const breathing = { ...dressed, animation: { breathing: true }, layers: [
  ...dressed.layers,
  { name: 'neck', origin: [462, 215], size: [60, 40], z: 6 },
  { name: 'handwear', origin: [330, 240], size: [340, 420], z: 6 },
  { name: 'footwear', origin: [430, 900], size: [150, 60], z: 9 },
] };

test('a breath swells the chest from its hem and lifts the head and arms while the legs stay planted', () => {
  const rig = layeredRig(breathing, { center: [498, 188], angle: -22.5 });
  const inhaled = (name, point) => apply(layerTransform(rig, name, { seconds: 1, breath: 1 }), point);
  for (const name of ['bottomwear', 'legwear', 'footwear', 'tail']) {
    assert.equal(layerTransform(rig, name, { seconds: 1, breath: 1 }), '');
  }
  assert.equal(layerTransform(rig, 'topwear', { seconds: 1, breath: 0 }), '');
  // The hem stays on the skirt while the shoulders rise and the chest widens.
  assert.equal(inhaled('topwear', [400, 621])[1], 621);
  const rise = 228 - inhaled('topwear', [504.5, 228])[1];
  assert.ok(rise > 2 && rise < 8, `shoulders rise ${rise}px`);
  assert.ok(inhaled('topwear', [363, 400])[0] < 363);
  // The head moves exactly as far as the neck does at the chin, and the face is not stretched.
  const chin = inhaled('face', [492, 235]);
  assert.ok(Math.abs(chin[1] - inhaled('neck', [492, 235])[1]) < 1e-9);
  close([inhaled('face', [492, 117])[1] - chin[1]], [117 - 235]);
  // The shoulders carry the arms.
  assert.ok(Math.abs(inhaled('handwear', [350, 600])[1] - (600 - rise)) < 1e-9);
  // Breathing applies outermost, so a swing still turns the head about its lifted chin.
  const turned = layerTransform(rig, 'face', { seconds: 1, breath: 1, pose: { head: 3 } });
  close(apply(turned, [492, 235]), chin);
});

test('a head tilt rolls the head about the neck and leaves the body alone', () => {
  const rig = layeredRig(dressed, { center: [498, 188], angle: -22.5 });
  const tilted = layerTransform(rig, 'face', { seconds: 1, tilt: 4 });
  close(apply(tilted, [492, 235]), [492, 235]);
  assert.ok(apply(tilted, [492, 117])[0] > 492, 'a clockwise tilt moves the crown right');
  assert.equal(layerTransform(rig, 'topwear', { seconds: 1, tilt: 4 }), '');
  assert.equal(layerTransform(rig, 'face', { seconds: 1, tilt: 0 }), '');
});

test('a gust to the right blows the hair, skirt and tail that way from their roots', () => {
  const rig = layeredRig(dressed, null);
  const blown = (name, point, wind = () => 1) => apply(layerTransform(rig, name, { seconds: 1, wind }), point);
  const calm = (name, point) => apply(layerTransform(rig, name, { seconds: 1 }), point);
  // Hair skews from its roots; the stiffer bangs move less.
  close(blown('back hair', [300, 91]), calm('back hair', [300, 91]));
  const back = blown('back hair', [300, 191])[0] - calm('back hair', [300, 191])[0];
  const front = blown('front hair', [450, 161])[0] - calm('front hair', [450, 161])[0];
  assert.ok(back > front && front > 0, `back ${back}, front ${front}`);
  // The skirt flares from the waist and the hanging tail swings its tip downwind.
  close(blown('bottomwear', [400, 401]), [400, 401]);
  assert.ok(blown('bottomwear', [400, 687])[0] > 400);
  close(blown('tail', [594, 515]), [594, 515]);
  assert.ok(blown('tail', [712, 743])[0] > 712);
  // Just as a gust arrives only the back hair has felt it; the rest trail behind.
  const arriving = lag => (lag < 0.05 ? 1 : 0);
  assert.ok(blown('back hair', [300, 191], arriving)[0] > calm('back hair', [300, 191])[0]);
  close(blown('front hair', [450, 161], arriving), calm('front hair', [450, 161]));
  assert.equal(layerTransform(rig, 'bottomwear', { seconds: 1, wind: arriving }), '');
});

test('thought dots float just above the crown, right of the face, sized to it', () => {
  const dots = thoughtDots(dressed);
  assert.equal(dots.length, 3);
  // The front hair's top at y = 61 is the crown; the face spans x 440–544.
  assert.ok(dots.every(d => d.cy + d.r < 61 && d.cx > 492 && d.r > 0), JSON.stringify(dots));
  assert.ok(dots[0].cx < dots[1].cx && dots[1].cx < dots[2].cx);
  assert.deepEqual(thoughtDots({ layers: [{ name: 'body', origin: [0, 0], size: [1, 1] }] }), []);
});

test('packages the rig cannot read breathe as one piece', () => {
  assert.equal(layeredRig(dressed, null).breath, null, 'the manifest must enable breathing');
  assert.equal(layeredRig({ ...breathing, animation: { breathing: false } }, null).breath, null);
  const cape = { ...breathing, layers: [...breathing.layers, { name: 'cape', origin: [300, 200], size: [400, 600], z: 0 }] };
  assert.equal(layeredRig(cape, null).breath, null);
  assert.ok(!layeredRig(cape, null).parts.has('topwear'));
});

test('breaths pause between cycles and vary in pace and depth', () => {
  assert.equal(breathAt(0), 0);
  const starts = [];
  const peaks = [];
  for (let i = 1, previous = 0; i < 180 * 50; i++) {
    const fill = breathAt(i / 50);
    assert.ok(fill >= 0 && fill <= 1.4);
    if (fill && !previous) {
      starts.push(i / 50);
      peaks.push(0);
    }
    if (fill) peaks[peaks.length - 1] = Math.max(peaks.at(-1), fill);
    previous = fill;
  }
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(Math.min(...gaps) < 4.3 && Math.max(...gaps) > 4.7, `breaths every ${Math.min(...gaps)}–${Math.max(...gaps)} s`);
  assert.ok(peaks.some(p => p > 1.2), 'an occasional deep breath');
  assert.ok(new Set(peaks.map(p => p.toFixed(2))).size > 10);
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
