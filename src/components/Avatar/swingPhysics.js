// Drag swing as damped springs: the body trails the drag like a held doll and swings back past
// rest when it stops; hanging parts stay closer to vertical and lag the body. Angles are degrees,
// positive clockwise; velocities are screen pixels per second.
const BODY = { stiffness: 55, damping: 5, gain: 0.012, max: 9 };
const STRETCH = { stiffness: 140, damping: 9, gain: 0.00004, max: 0.05 };
export const PICKUP_STRETCH_VELOCITY = 0.6;
const SECONDARY = {
  head: { follow: 0.3, stiffness: 90, damping: 9, max: 4 },
  hair: { follow: 0.8, stiffness: 40, damping: 5, max: 8 },
  tail: { follow: 0.7, stiffness: 30, damping: 3.5, max: 15 },
  skirt: { follow: 0.5, stiffness: 55, damping: 6, max: 4 },
};
export const SWING_PARTS = ['body', 'stretch', ...Object.keys(SECONDARY)];
const SUBSTEP = 1 / 120;

const clamp = (value, max) => Math.max(-max, Math.min(max, value));

/** Each part is [position, velocity]. */
export function createSwing() {
  return Object.fromEntries(SWING_PARTS.map(part => [part, [0, 0]]));
}

function spring(part, target, { stiffness, damping, max }, dt) {
  const acceleration = stiffness * (target - part[0]) - damping * part[1];
  part[1] += acceleration * dt;
  part[0] += part[1] * dt;
  // A hard stop keeps the character inside its window.
  if (Math.abs(part[0]) > max) {
    part[0] = clamp(part[0], max);
    if (part[0] * part[1] > 0) part[1] = 0;
  }
}

/** Advances the swing by dt seconds while the window moves at (vx, vy). */
export function stepSwing(swing, { vx = 0, vy = 0, lever = 1 }, dt) {
  const steps = Math.ceil(dt / SUBSTEP);
  for (let i = 0; i < steps; i += 1) {
    const h = dt / steps;
    spring(swing.body, clamp(lever * vx * BODY.gain, BODY.max), BODY, h);
    spring(swing.stretch, clamp(-vy * STRETCH.gain, STRETCH.max), STRETCH, h);
    for (const [name, part] of Object.entries(SECONDARY)) {
      spring(swing[name], -part.follow * swing.body[0], part, h);
    }
  }
  return swing;
}

export function swingSettled(swing) {
  return SWING_PARTS.every(part => Math.abs(swing[part][0]) < 0.01 && Math.abs(swing[part][1]) < 0.05);
}

/**
 * How strongly the body swings for a grab at grabY within the character box. Held high, it dangles;
 * held at the middle, it still sways a little; held by the feet, it leans the other way.
 */
export function swingLever(grabY, top, height) {
  if (!(height > 0)) return 1;
  const aboveCenter = (top + height / 2 - grabY) / (height / 2);
  return Math.max(-0.6, Math.min(1, 0.4 + 0.6 * aboveCenter));
}
