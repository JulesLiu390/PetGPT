// Head and gaze behaviour for layered skins: a thinking pose, plus occasional looks around and head
// tilts, each on its own random schedule. Tilt is a clockwise head roll in degrees; gaze is a unit
// offset within the iris range, or null to keep following the cursor.

// Seconds from the end of one action to the start of the next of its kind, drawn uniformly.
export const GLANCE_INTERVAL = [8, 20];
export const TILT_INTERVAL = [15, 35];
// A tilt on top of a glance's roll stays within this many degrees.
export const MAX_TILT = 5;

// Per second: how quickly the head settles on its target.
const TILT_RATE = 3.5;
const THINKING_TILT = 4;
// Looking up and toward the side the head leans.
const THINKING_GAZE = [0.5, -0.9];
// The head rolls toward where the eyes look: degrees per unit of sideways gaze.
const GLANCE_ROLL = [2, 3.5];

const between = (random, [low, high]) => low + random() * (high - low);
const pickSide = random => (random() < 0.5 ? -1 : 1);

// Somewhere to look: mostly off to a side, level or upward, sometimes downward or nearly straight up.
function lookTarget(random, side) {
  const kind = random();
  if (kind < 0.1) return [between(random, [-0.3, 0.3]), between(random, [-1, -0.7])];
  const height = kind < 0.55 ? between(random, [-0.2, 0.15])
    : kind < 0.85 ? between(random, [-1, -0.6])
      : between(random, [0.4, 0.8]);
  return [side * between(random, [0.6, 1]), height];
}

// A look around: one to three points, usually alternating sides, the head rolling toward each.
function planGlance(random, now) {
  const steps = [];
  let side = pickSide(random);
  let until = now;
  for (let count = 1 + Math.floor(random() * 3); count > 0; count--) {
    const gaze = lookTarget(random, side);
    until += between(random, [0.7, 1.3]);
    const roll = Math.abs(gaze[0]) < 0.4 ? between(random, [-1, 1]) : gaze[0] * between(random, GLANCE_ROLL);
    steps.push({ until, tilt: roll, gaze });
    if (random() < 0.75) side = -side;
  }
  return steps;
}

const planTilt = (random, now) => [
  { until: now + between(random, [1.6, 2.8]), tilt: pickSide(random) * between(random, [2.5, 3.5]), gaze: null },
];

// One kind of action, due at a random time within its interval after the previous one ends.
function schedule(interval, plan, random) {
  let steps = [];
  let due = null;
  return {
    current(seconds, canStart) {
      due ??= seconds + between(random, interval);
      while (steps.length && seconds >= steps[0].until) {
        steps.shift();
        if (!steps.length) due = seconds + between(random, interval);
      }
      if (!steps.length && canStart && seconds >= due) steps = plan(random, seconds);
      return steps[0] ?? null;
    },
    restart(seconds) {
      steps = [];
      due = seconds + between(random, interval);
    },
  };
}

export function createHeadMotion(random = Math.random) {
  const glances = schedule(GLANCE_INTERVAL, planGlance, random);
  const tilts = schedule(TILT_INTERVAL, planTilt, random);
  let last = null;
  let tilt = 0;
  let thinkingSide = 0;
  return {
    /** Advances to `seconds`. Thinking replaces the idle actions; a drag holds back new ones. */
    update(seconds, { thinking = false, dragging = false } = {}) {
      const dt = last === null ? 0 : Math.min(0.1, Math.max(0, seconds - last));
      last = seconds;
      let goal;
      if (thinking) {
        thinkingSide ||= pickSide(random);
        goal = { tilt: thinkingSide * THINKING_TILT, gaze: [thinkingSide * THINKING_GAZE[0], THINKING_GAZE[1]] };
      } else {
        // Both schedules start over when a thought ends, so nothing fires the moment it does.
        if (thinkingSide) {
          thinkingSide = 0;
          glances.restart(seconds);
          tilts.restart(seconds);
        }
        const glance = glances.current(seconds, !dragging);
        const held = tilts.current(seconds, !dragging);
        const roll = (held?.tilt ?? 0) + (glance?.tilt ?? 0);
        goal = { tilt: Math.max(-MAX_TILT, Math.min(MAX_TILT, roll)), gaze: glance?.gaze ?? null };
      }
      tilt += (goal.tilt - tilt) * (1 - Math.exp(-TILT_RATE * dt));
      if (!goal.tilt && Math.abs(tilt) < 0.01) tilt = 0;
      return { tilt, gaze: goal.gaze };
    },
  };
}
