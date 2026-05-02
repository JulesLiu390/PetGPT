import { ensureHome } from './paths.ts';

/**
 * Minimal Bun HTTP+WS server placeholder.
 * Real routes will land once the core agent is migrated.
 */

const PORT = Number(process.env.SOCIAL_AGENT_PORT ?? 8787);

const paths = ensureHome();

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return;
      return new Response('expected WebSocket upgrade', { status: 426 });
    }

    if (url.pathname === '/api/ping') {
      return Response.json({ ok: true, home: paths.home, ts: Date.now() });
    }

    return new Response(
      `social-agent service v0.0.1\nhome: ${paths.home}\n\nendpoints:\n  GET  /api/ping\n  WS   /ws\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ type: 'hello', ts: Date.now() })); },
    message(ws, msg) { ws.send(JSON.stringify({ type: 'echo', payload: String(msg) })); },
    close() { /* noop */ },
  },
});

console.log(`social-agent listening on http://localhost:${server.port}`);
console.log(`home: ${paths.home}`);
