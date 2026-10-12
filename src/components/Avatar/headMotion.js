// Head and gaze behaviour for layered skins: a thinking pose, plus an occasional tilt or a glance to
// either side once nobody is moving the cursor. Tilt is a clockwise head roll in degrees; gaze is a
// unit offset within the iris range, or null to keep following the cursor.

// Per second: how quickly the head settles on its target.
const TILT_RATE = 3.5;
const THINKING_TILT = 4;
// Looking up and toward the side the head leans.
const THINKING_GAZE = [0.5, -0.9];
const GLANCE_TILT = 1.2;

const between = (random, low, high) => low + random() * (high - low);
const pickSide = random => (random() < 0.5 ? -1 : 1);

// Either a held tilt, or a glance to one side that sometimes continues to the other.
function planIdleAction(random, now) {
  const side = pickSide(random);
  if (random() < 0.5) {
    return [{ until: now + between(random, 1.6, 2.8), tilt: side * between(random, 2.5, 3.5), gaze: null }];
  }
  const steps = [{ until: now + between(random, 0.9, 1.4), tilt: side * GLANCE_TILT, gaze: [side, 0] }];
  if (random() < 0.6) {
    steps.push({ until: steps[0].until + between(random, 0.9, 1.4), tilt: -side * GLANCE_TILT, gaze: [-side, 0] });
  }
  return steps;
}

export function createHeadMotion(random = Math.random) {
  let last = null;
  let tilt = 0;
  let next = null;
  let steps = [];
  let thinkingSide = 0;
  return {
    /** Advances to `seconds`. `idle` means the cursor is resting and nothing is dragging the pet. */
    update(seconds, { thinking = false, idle = true } = {}) {
      const dt = last === null ? 0 : Math.min(0.1, Math.max(0, seconds - last));
      last = seconds;
      next ??= seconds + between(random, 6, 12);
      let goal = { tilt: 0, gaze: null };
      if (thinking) {
        thinkingSide ||= pickSide(random);
        steps = [];
        goal = { tilt: thinkingSide * THINKING_TILT, gaze: [thinkingSide * THINKING_GAZE[0], THINKING_GAZE[1]] };
      } else {
        if (thinkingSide) {
          thinkingSide = 0;
          next = seconds + between(random, 6, 12);
        }
        // A glance away ends as soon as the cursor moves; the eyes go back to it.
        if (!idle && steps.some(step => step.gaze)) steps = [];
        while (steps.length && seconds >= steps[0].until) steps.shift();
        if (!steps.length && idle && seconds >= next) {
          steps = planIdleAction(random, seconds);
          next = steps.at(-1).until + between(random, 7, 16);
        }
        if (steps.length) goal = steps[0];
      }
      tilt += (goal.tilt - tilt) * (1 - Math.exp(-TILT_RATE * dt));
      if (!goal.tilt && Math.abs(tilt) < 0.01) tilt = 0;
      return { tilt, gaze: goal.gaze };
    },
  };
}
