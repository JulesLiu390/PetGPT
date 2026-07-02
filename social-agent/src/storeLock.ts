/**
 * In-process, per-key async mutex.
 *
 * All JSON stores (providers / mcp-servers / pets / settings / social-config)
 * follow a load → mutate → save pattern with awaits in between. Bun.serve
 * handles requests concurrently, so two overlapping mutations on the same file
 * could interleave and the later save would silently drop the earlier write.
 * Serializing mutations per file closes that window — the service is a single
 * process, so no cross-process file lock is needed.
 */

const chains = new Map<string, Promise<void>>();

export function withStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  // The stored tail never rejects, so a failed mutation doesn't poison the chain.
  const tail = next.then(() => undefined, () => undefined);
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

/**
 * Error carrying an HTTP-ish status code, thrown by stores on optimistic-lock
 * conflicts (and mappable to 409 by the server layer).
 */
export class ConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
