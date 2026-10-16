// How loud the pet is speaking right now, 0…1, for lip sync. The backend sends each utterance's
// loudness envelope as it starts playing; only the video call window feeds this. Starting the same
// utterance again restarts it, and stopping twice is the same as stopping once.

interface Utterance {
  envelope: readonly number[];
  frameMs: number;
  start: number;
}

let current: Utterance | null = null;

/** An utterance starts playing now: `envelope` holds one level per `frameMs`. */
export function startSpeech(
  { envelope, frameMs }: { envelope?: readonly number[] | null; frameMs?: number },
  now: number = performance.now(),
): void {
  current = Array.isArray(envelope) && envelope.length && frameMs && frameMs > 0
    ? { envelope, frameMs, start: now }
    : null;
}

export function stopSpeech(): void {
  current = null;
}

export function speechLevelAt(now: number = performance.now()): number {
  if (!current) return 0;
  const index = Math.floor((now - current.start) / current.frameMs);
  if (index < 0 || index >= current.envelope.length) return 0;
  return Math.max(0, Math.min(1, Number(current.envelope[index]) || 0));
}

// The mouth snaps open on a syllable and closes a little slower, like a jaw.
const OPEN_RATE = 30;
const CLOSE_RATE = 14;

/** Eases the drawn opening toward the level heard over `elapsed` seconds. */
export function easeMouth(shown: number, heard: number, elapsed: number): number {
  const rate = heard > shown ? OPEN_RATE : CLOSE_RATE;
  return shown + (heard - shown) * (1 - Math.exp(-rate * elapsed));
}
