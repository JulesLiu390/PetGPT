// Now and then a gust blows across the pet. The signed value is the wind's push: positive blows to
// the right, about 1 at a full gust, and it flutters while the gust lasts.

// Seconds from the end of one gust to the start of the next, drawn uniformly.
export const GUST_INTERVAL = [20, 45];

const between = (random, [low, high]) => low + random() * (high - low);
const smooth = k => k * k * (3 - 2 * k);

/** Push of `gust` at time `t`: picks up quickly, holds with some flutter, then dies away. */
export function gustAt({ start, duration, side, strength, phase }, t) {
  const age = t - start;
  const u = age / duration;
  if (u <= 0 || u >= 1) return 0;
  const envelope = u < 0.2 ? smooth(u / 0.2) : u < 0.55 ? 1 : smooth((1 - u) / 0.45);
  const flutter = 1 + 0.18 * Math.sin(2 * Math.PI * 2.3 * age + phase) + 0.08 * Math.sin(2 * Math.PI * 4.1 * age + 2 * phase);
  return side * strength * envelope * flutter;
}

export function createWind(random = Math.random) {
  let gust = null;
  let due = null;
  return {
    /** Starts the next gust once it is due. */
    advance(seconds) {
      due ??= seconds + between(random, GUST_INTERVAL);
      if (seconds < due) return;
      gust = {
        start: seconds,
        duration: between(random, [1.6, 2.6]),
        side: random() < 0.5 ? -1 : 1,
        strength: between(random, [0.6, 1]),
        phase: random() * 2 * Math.PI,
      };
      due = gust.start + gust.duration + between(random, GUST_INTERVAL);
    },
    // Parts that trail the gust ask for a moment in the past; gusts are far enough apart that only
    // the latest one matters.
    at: t => (gust ? gustAt(gust, t) : 0),
  };
}
