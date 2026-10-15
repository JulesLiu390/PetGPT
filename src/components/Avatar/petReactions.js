// Reactions to being touched: a small hop when the pet is clicked.

// Clicks arrive from the pet window; each layered character picks up new ones on its next frame.
let hops = 0;
export function requestHop() {
  hops += 1;
}
export const hopCount = () => hops;

// Peak height as a share of the character's height.
export const HOP_HEIGHT = 0.018;
// Seconds into the hop: crouch until takeoff, land, then settle.
const TAKEOFF = 0.08;
const LANDING = 0.44;
const SETTLED = 0.66;
// Vertical stretch about the feet over time: crouch, launch, apex, fall, landing squash, rebound.
const STRETCH = [
  [0, 1], [TAKEOFF, 0.982], [0.14, 1.012], [0.26, 1], [0.38, 1.006], [LANDING, 0.982], [0.56, 1.006], [SETTLED, 1],
];

/**
 * Pose `t` seconds into a hop: rise is a share of the character's height and stretch scales it
 * vertically about its feet. Null once the hop has settled.
 */
export function hopPose(t) {
  if (t < 0 || t >= SETTLED) return null;
  const airborne = (t - TAKEOFF) / (LANDING - TAKEOFF);
  const rise = airborne > 0 && airborne < 1 ? HOP_HEIGHT * 4 * airborne * (1 - airborne) : 0;
  const next = STRETCH.findIndex(([at]) => at > t);
  const [[t0, s0], [t1, s1]] = [STRETCH[next - 1], STRETCH[next]];
  const k = (t - t0) / (t1 - t0);
  return { rise, stretch: s0 + (s1 - s0) * k * k * (3 - 2 * k) };
}
