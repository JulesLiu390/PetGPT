// Head and gaze behaviour for layered skins: a thinking pose, plus occasional glances to either side
// and head tilts, each on its own random schedule. Tilt is a clockwise head roll in degrees; gaze is
// a unit offset within the iris range, or null to keep following the cursor.

// Seconds from the end of one action to the start of the next of its kind, drawn uniformly.
export const GLANCE_INTERVAL = [8, 20];
export const TILT_INTERVAL = [15, 35];

// Per second: how quickly the head settles on its target.
const TILT_RATE = 3.5;
const THINKING_TILT = 4;
// Looking up and toward the side the head leans.
const THINKING_GAZE = [0.5, -0.9];
const GLANCE_TILT = 1.2;

const between = (random, [low, high]) => low + random() * (high - low);
const pickSide = random => (random() < 0.5 ? -1 : 1);

// A look to one side that sometimes continues to the other.
function planGlance(random, now) {
  const side = pickSide(random);
  const steps = [{ until: now + between(random, [0.9, 1.4]), tilt: side * GLANCE_TILT, gaze: [side, 0] }];
  if (random() < 0.6) {
    steps.push({ until: steps[0].until + between(random, [0.9, 1.4]), tilt: -side * GLANCE_TILT, gaze: [-side, 0] });
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
        goal = { tilt: (held?.tilt ?? 0) + (glance?.tilt ?? 0), gaze: glance?.gaze ?? null };
      }
      tilt += (goal.tilt - tilt) * (1 - Math.exp(-TILT_RATE * dt));
      if (!goal.tilt && Math.abs(tilt) < 0.01) tilt = 0;
      return { tilt, gaze: goal.gaze };
    },
  };
}
