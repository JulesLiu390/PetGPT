import type { PlatformHTTP, HTTPRequest, HTTPResponse } from './types.ts';

const DEFAULT_TIMEOUT_MS = 60_000;

function buildAbort(req: HTTPRequest): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  if (req.signal) {
    req.signal.addEventListener('abort', () => ctrl.abort(req.signal!.reason), { once: true });
  }
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

export const nodeHTTP: PlatformHTTP = {
  async request(req: HTTPRequest): Promise<HTTPResponse> {
    const { signal, cancel } = buildAbort(req);
    try {
      const res = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body as BodyInit | undefined,
        signal,
      });
      const body = await res.text();
      return {
        status: res.status,
        ok: res.ok,
        headers: headersToObject(res.headers),
        body,
      };
    } finally {
      cancel();
    }
  },

  async *stream(req: HTTPRequest): AsyncIterable<Uint8Array> {
    const { signal, cancel } = buildAbort(req);
    try {
      const res = await fetch(req.url, {
        method: req.method ?? 'POST',
        headers: req.headers,
        body: req.body as BodyInit | undefined,
        signal,
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${errBody}`);
      }
      if (!res.body) return;
      // ReadableStream<Uint8Array> — Bun + modern Node fetch produce this directly.
      const reader = res.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      cancel();
    }
  },
};
