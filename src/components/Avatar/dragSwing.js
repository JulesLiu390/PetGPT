import { onDragMotion, startDragMotion, stopDragMotion } from '../../utils/tauri';
import { PICKUP_STRETCH_VELOCITY, SWING_PARTS, createSwing, stepSwing, swingSettled } from './swingPhysics';

// One swing per window: only the window that starts a drag ever animates. Renderers read the pose
// each frame; it is null whenever the character hangs at rest.
const MAX_SPEED = 2500;
// Motion samples arrive only while the window moves; after this gap it is treated as stopped.
const STALE_MS = 80;

let swing = createSwing();
let pose = null;
let held = null;
let grip = null;
let velocity = [0, 0];
let lastSampleAt = 0;
let sessions = 0;
let rafId = null;
let lastFrame = null;
const subscribers = new Set();

const clampSpeed = value => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, value));

function onSample({ x, y, t, done }) {
  if (!held) return;
  if (done) {
    endDragSwing({ notifyBackend: false });
    return;
  }
  const previous = held.previous;
  held.previous = { x, y, t };
  lastSampleAt = performance.now();
  if (!previous || t <= previous.t) return;
  const seconds = (t - previous.t) / 1000;
  const instant = [(x - previous.x) / seconds, (y - previous.y) / seconds].map(clampSpeed);
  const blend = seconds > 0.1 ? 1 : 0.5;
  velocity = velocity.map((value, axis) => value + (instant[axis] - value) * blend);
}

// The OS swallows the release on Linux and Windows; the first pointer event without the primary
// button means the native drag is over.
function onPointer(event) {
  if ((event.buttons & 1) === 0) endDragSwing();
}

function frame(now) {
  const dt = lastFrame === null ? 0 : Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (now - lastSampleAt > STALE_MS) velocity = velocity.map(value => value * Math.exp(-15 * dt));
  stepSwing(swing, { vx: velocity[0], vy: velocity[1], lever: grip.lever }, dt);
  const resting = !held && swingSettled(swing);
  pose = resting ? null : {
    ...Object.fromEntries(SWING_PARTS.map(part => [part, swing[part][0]])),
    grab: grip.grab,
    session: grip.session,
  };
  subscribers.forEach(callback => callback(pose));
  if (resting) {
    swing = createSwing();
    velocity = [0, 0];
    rafId = null;
    lastFrame = null;
    return;
  }
  rafId = requestAnimationFrame(frame);
}

/** Starts the swing for a drag grabbed at a client point; lever comes from swingLever. */
export function beginDragSwing(grab, lever) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // A new backend session supersedes any previous one, so there is nothing to stop.
  endDragSwing({ notifyBackend: false });
  const session = ++sessions;
  grip = { grab, lever, session };
  held = { previous: null, unlisten: onDragMotion(onSample) };
  swing.stretch[1] += PICKUP_STRETCH_VELOCITY;
  for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.addEventListener(type, onPointer, true);
  startDragMotion().catch(error => {
    console.warn('[Avatar] Drag motion unavailable:', error);
    if (grip.session === session) endDragSwing({ notifyBackend: false });
  });
  rafId ??= requestAnimationFrame(frame);
}

export function endDragSwing({ notifyBackend = true } = {}) {
  if (!held) return;
  held.unlisten();
  held = null;
  for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.removeEventListener(type, onPointer, true);
  if (notifyBackend) stopDragMotion().catch(() => {});
}

export const currentSwingPose = () => pose;

export function subscribeSwing(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
