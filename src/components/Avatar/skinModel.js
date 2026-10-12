export function describeSkinImport(config) {
  if (config?.format === 'petgpt-layered-skin') {
    if (config.version !== 1 || !Array.isArray(config.layers) || !config.layers.length) {
      throw new Error('Unsupported or empty layered skin package');
    }
    return { kind: 'layered', name: config.name, detail: `${config.layers.length} layers` };
  }
  if (config?.parts && Array.isArray(config.frame_size)) {
    return { kind: 'layered', name: 'LayerDiff Character', detail: `${Object.keys(config.parts).length} layers · LayerDiff` };
  }
  if (config?.name && config.moods && !Array.isArray(config.moods) && typeof config.moods === 'object' && config.moods.normal) {
    return { kind: 'image', name: config.name, detail: `${Object.keys(config.moods).length} expressions` };
  }
  throw new Error('Select a LayerDiff *.psd.json, a layered skin.json, or an image skin with a normal expression');
}

// Fit the character, not transparent canvas padding. Leave room for subtle breathing.
export function skinViewBox(manifest) {
  const left = Math.min(...manifest.layers.map(l => l.origin[0]));
  const top = Math.min(...manifest.layers.map(l => l.origin[1]));
  const right = Math.max(...manifest.layers.map(l => l.origin[0] + l.size[0]));
  const bottom = Math.max(...manifest.layers.map(l => l.origin[1] + l.size[1]));
  const padding = Math.max(right - left, bottom - top) * 0.025;
  return [left - padding, top - padding, right - left + padding * 2, bottom - top + padding * 2].join(' ');
}

export function orderedSkinLayers(manifest) {
  return [...manifest.layers].sort((a, b) => a.z - b.z);
}

const EYE_LAYERS = ['eyewhite', 'irides', 'eyelash'];
// Everything attached to the head turns with it about the neck during a drag swing.
const HEAD_LAYERS = [
  'back hair', 'face', 'ears', 'earwear', 'eyebrow', 'eyelash', 'eyewhite', 'irides',
  'nose', 'mouth', 'eyewear', 'headwear', 'front hair',
];
// Skew in degrees at the hair tips; the bangs trail the back hair slightly and are stiffer.
const HAIR_SWAY = [
  { name: 'back hair', amplitude: 0.9, lag: 0, inertia: 1 },
  { name: 'front hair', amplitude: 0.6, lag: 0.35, inertia: 0.5 },
];
// Every LayerDiff tag by what a breath does to it; packages with other names breathe as one piece.
const CHEST_LAYERS = ['topwear', 'neckwear', 'neck'];
const CARRIED_LAYERS = ['handwear', 'objects', 'wings'];
const PLANTED_LAYERS = ['bottomwear', 'legwear', 'footwear', 'tail'];
const LAYERDIFF_TAGS = new Set([...HEAD_LAYERS, ...CHEST_LAYERS, ...CARRIED_LAYERS, ...PLANTED_LAYERS]);
// Shoulder rise at a full breath as a share of the character's height, close to a real chest's.
const BREATH_RISE = 0.0055;

/**
 * Motion rig keyed by LayerDiff part tags; packages with other layer names only breathe and swing
 * as a whole. eyeLine is the backend's alpha analysis of the eyewhite layer (center and tilt).
 */
export function layeredRig(manifest, eyeLine) {
  const layers = new Map(manifest.layers.map(layer => [layer.name, layer]));
  const white = layers.get('eyewhite');
  const iris = layers.get('irides');
  let eyes = null;
  if (white && eyeLine) {
    const width = white.size[0];
    eyes = {
      layers: EYE_LAYERS.filter(name => layers.has(name)),
      pivot: eyeLine.center,
      angle: eyeLine.angle,
      shift: width * 0.03,
      gazeRange: [width * 0.06, width * 0.035],
      // The iris may only show over the sclera or where it was originally painted.
      irisMask: iris ? [white, iris] : null,
      irisRegion: iris ? unionBox([white, iris]) : null,
    };
  }
  const hair = HAIR_SWAY.filter(h => layers.has(h.name))
    .map(h => ({ ...h, pivotY: layers.get(h.name).origin[1] }));
  const face = layers.get('face');
  const head = face ? {
    layers: HEAD_LAYERS.filter(name => layers.has(name)),
    pivot: [face.origin[0] + face.size[0] / 2, face.origin[1] + face.size[1]],
  } : null;
  const torso = ['topwear', 'bottomwear'].map(name => layers.get(name)).filter(Boolean);
  const tailLayer = layers.get('tail');
  // The tail hangs from the corner of its box nearest the body.
  const tail = tailLayer ? {
    name: 'tail',
    pivot: nearestPoint(unionBox([tailLayer]), boxCenter(unionBox(torso.length ? torso : manifest.layers))),
  } : null;
  // Only a skirt flares; skewing trousers would tear them from the legs.
  const bottom = layers.get('bottomwear');
  const legs = layers.get('legwear');
  const skirt = bottom && (!legs || bottom.size[0] > legs.size[0] * 1.3)
    ? { name: 'bottomwear', pivotY: bottom.origin[1] } : null;
  const breath = manifest.animation?.breathing ? breathRig(manifest, layers, face) : null;
  const parts = new Set([
    ...(eyes?.layers ?? []), ...hair.map(h => h.name), ...(head?.layers ?? []),
    ...(tail ? [tail.name] : []), ...(skirt ? [skirt.name] : []),
    ...(breath ? [...breath.chest, ...breath.lift.keys()] : []),
  ]);
  return { eyes, hair, head, tail, skirt, breath, parts };
}

/**
 * The chest swells from its hem, which stays on the skirt, and the head and arms ride up exactly as
 * far as the chest moves at the chin and shoulders, so no seam opens. The legs stay planted.
 */
function breathRig(manifest, layers, face) {
  const chest = layers.get('topwear');
  if (!chest || !manifest.layers.every(l => LAYERDIFF_TAGS.has(l.name))) return null;
  const stretch = BREATH_RISE * unionBox(manifest.layers)[3] / chest.size[1];
  const anchored = (names, y) => names.filter(name => layers.has(name)).map(name => [name, y]);
  return {
    chest: CHEST_LAYERS.filter(name => layers.has(name)),
    pivot: [chest.origin[0] + chest.size[0] / 2, chest.origin[1] + chest.size[1]],
    scale: [stretch / 2, stretch],
    // Height on the chest that each rigid part follows.
    lift: new Map([
      ...anchored(CARRIED_LAYERS, chest.origin[1]),
      ...anchored(HEAD_LAYERS, face ? face.origin[1] + face.size[1] : chest.origin[1]),
    ]),
  };
}

const boxCenter = ([x, y, w, h]) => [x + w / 2, y + h / 2];
const nearestPoint = ([x, y, w, h], [px, py]) => [Math.min(Math.max(px, x), x + w), Math.min(Math.max(py, y), y + h)];

function unionBox(layers) {
  const left = Math.min(...layers.map(l => l.origin[0]));
  const top = Math.min(...layers.map(l => l.origin[1]));
  const right = Math.max(...layers.map(l => l.origin[0] + l.size[0]));
  const bottom = Math.max(...layers.map(l => l.origin[1] + l.size[1]));
  return [left, top, right - left, bottom - top];
}

// Squeeze perpendicular to the (possibly tilted) eye line, closing slightly downward.
export function blinkTransform({ pivot: [x, y], angle, shift }, scale) {
  if (scale >= 1) return '';
  return `translate(${x} ${y}) rotate(${angle}) translate(0 ${(1 - scale) * shift}) scale(1 ${scale}) rotate(${-angle}) translate(${-x} ${-y})`;
}

// Unit sway in [-1, 1]: a slow swing on the breathing period plus a faster flutter.
export function hairSwayAt(seconds, lag = 0) {
  const t = seconds - lag;
  return Math.sin(t * 2 * Math.PI / 4.5) * 0.8 + Math.sin(t * 2 * Math.PI / 2.3 + 1.3) * 0.2;
}

// Skew around the top of the layer: the roots stay put and the tips travel furthest.
const skewFromTop = (degrees, pivotY) => `translate(0 ${pivotY}) skewX(${degrees}) translate(0 ${-pivotY})`;
const rotateAbout = (degrees, [x, y]) => `rotate(${degrees} ${x} ${y})`;

export function hairTransform({ amplitude, lag, pivotY }, seconds, extra = 0) {
  return skewFromTop(amplitude * hairSwayAt(seconds, lag) + extra, pivotY);
}

// Breaths average 4.5 s: a 1.6 s inhale, a 2.4 s exhale, then a pause.
const BREATH_PERIOD = 4.5;
const INHALE = 1.6 / BREATH_PERIOD;
const EXHALE = 2.4 / BREATH_PERIOD;

// Stable value in [0, 1) per breath (murmur3 finalizer), identical on every JS engine.
function breathNoise(index) {
  let h = Math.imul(index ^ (index >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/**
 * Lung fill at a time in seconds: 0 between breaths, about 1 at a full one. The pace drifts by about
 * 10% and every breath has its own depth, with an occasional deep one, so it never ticks like a metronome.
 */
export function breathAt(seconds) {
  // The drift stays far below the base rate, so the phase never runs backwards.
  const phase = seconds / BREATH_PERIOD + 0.13 * Math.sin(seconds * 2 * Math.PI / 37);
  const index = Math.floor(phase);
  const t = phase - index;
  const noise = breathNoise(index);
  // About one breath in ten is a deep one.
  const depth = noise < 0.9 ? 0.85 + noise / 6 : 1.4;
  if (t < INHALE) return depth * (1 - Math.cos(Math.PI * t / INHALE)) / 2;
  if (t < INHALE + EXHALE) return depth * (1 + Math.cos(Math.PI * (t - INHALE) / EXHALE)) / 2;
  return 0;
}

// The chest scales about its hem; every carried part moves as far as the chest does at its anchor.
function breathTransform({ chest, pivot: [x, y], scale: [sx, sy], lift }, name, fill) {
  if (!fill) return '';
  if (chest.includes(name)) {
    return `translate(${x} ${y}) scale(${1 + sx * fill} ${1 + sy * fill}) translate(${-x} ${-y})`;
  }
  return lift.has(name) ? `translate(0 ${(lift.get(name) - y) * sy * fill})` : '';
}

/**
 * Full transform for one rigged layer. pose is the drag swing (null at rest): its secondary angles
 * are rotations relative to the body, so skewed parts lean the opposite way to hang straight.
 * breath is the lung fill from breathAt; it carries everything else, so it applies outermost.
 * tilt is the thinking or idle head roll in degrees, about the same neck pivot as the swing.
 */
export function layerTransform(rig, name, { seconds, blink = 1, pose = null, breath = 0, tilt = 0 }) {
  const transforms = [rig.breath ? breathTransform(rig.breath, name, breath) : ''];
  if (tilt && rig.head?.layers.includes(name)) transforms.push(rotateAbout(tilt, rig.head.pivot));
  if (pose && rig.head?.layers.includes(name)) transforms.push(rotateAbout(pose.head, rig.head.pivot));
  if (pose && rig.tail?.name === name) transforms.push(rotateAbout(pose.tail, rig.tail.pivot));
  if (pose && rig.skirt?.name === name) transforms.push(skewFromTop(-pose.skirt, rig.skirt.pivotY));
  const hair = rig.hair.find(h => h.name === name);
  if (hair) transforms.push(hairTransform(hair, seconds, pose ? -pose.hair * hair.inertia : 0));
  if (rig.eyes?.layers.includes(name)) transforms.push(blinkTransform(rig.eyes, blink));
  return transforms.filter(Boolean).join(' ');
}

/** "…" floating just above the crown, right of the face, sized to the face so it scales with the skin. */
export function thoughtDots(manifest) {
  const layers = new Map(manifest.layers.map(layer => [layer.name, layer]));
  const face = layers.get('face');
  if (!face) return [];
  const crown = Math.min(...HEAD_LAYERS.filter(name => layers.has(name)).map(name => layers.get(name).origin[1]));
  const r = face.size[0] * 0.05;
  const x = face.origin[0] + face.size[0] * 0.85;
  return [0, 1, 2].map(i => ({ cx: x + i * r * 2.8, cy: crown - r * 1.6, r }));
}

// Iris offset toward a point (dx, dy) away in screen pixels; saturates smoothly within range.
export function gazeOffset(dx, dy, [maxX, maxY], reach = 160) {
  const distance = Math.hypot(dx, dy);
  if (!distance) return [0, 0];
  const strength = distance / (distance + reach);
  return [dx / distance * strength * maxX, dy / distance * strength * maxY];
}
