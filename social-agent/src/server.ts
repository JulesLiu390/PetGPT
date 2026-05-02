import { ensureHome } from './paths.ts';
import {
  readSettings, patchSettings,
  listPets, createPet, getPet, updatePet, deletePet,
} from './config.ts';
import {
  isUnlocked, isInitialized, unlock, lock,
  listProviders, getProvider, createProvider, updateProvider, deleteProvider, changePassword,
  getProviderInternal,
} from './providers.ts';
import { createNodePlatform } from './platform/index.ts';
import { createLLMClient, LLMError } from './core/llm/index.ts';
import dashboardHtml from './web/index.html';

export interface StartServerOptions {
  port?: number;
}

export async function startServer(opts: StartServerOptions = {}) {
  const platform = createNodePlatform();
  const paths = ensureHome();
  const port = opts.port ?? Number(process.env.SOCIAL_AGENT_PORT ?? 8787);

// ─────────────────── helpers ───────────────────

function ok(body: unknown, status = 200): Response {
  return Response.json(body as any, { status });
}
function err(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Wrap a handler so thrown errors become 4xx/5xx JSON without crashing the server. */
async function safe(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg === 'locked') return err(423, 'providers store is locked — POST /api/providers/unlock first');
    if (msg === 'invalid master password') return err(401, msg);
    if (msg.startsWith('master password too short')) return err(400, msg);
    if (msg === 'apiKey required') return err(400, msg);
    return err(500, msg);
  }
}

// ─────────────────── server ───────────────────

  const server = Bun.serve({
    port,
  // HTML import auto-bundles dashboard's .tsx + transitive deps + Tailwind CDN refs
  routes: {
    '/': dashboardHtml,
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // ── WebSocket ──
    if (pathname === '/ws') {
      if (server.upgrade(req)) return;
      return new Response('expected WebSocket upgrade', { status: 426 });
    }

    // ── Liveness ──
    if (method === 'GET' && pathname === '/api/ping') {
      return ok({ ok: true, home: paths.home, ts: Date.now() });
    }

    // ── Status ──
    if (method === 'GET' && pathname === '/api/status') {
      return ok({
        home: paths.home,
        providers: { initialized: isInitialized(), unlocked: isUnlocked() },
      });
    }

    // ── Settings ──
    if (method === 'GET' && pathname === '/api/settings') {
      return safe(async () => ok(await readSettings()));
    }
    if (method === 'PATCH' && pathname === '/api/settings') {
      return safe(async () => {
        const body = await readBody<Record<string, unknown>>(req);
        if (!body) return err(400, 'invalid JSON body');
        return ok(await patchSettings(body));
      });
    }

    // ── Pets (registry) ──
    if (method === 'GET' && pathname === '/api/pets') {
      return safe(async () => ok(await listPets()));
    }
    if (method === 'POST' && pathname === '/api/pets') {
      return safe(async () => {
        const body = await readBody<{ name?: string; persona?: string }>(req);
        if (!body || !body.name) return err(400, 'name required');
        return ok(await createPet({ name: body.name, persona: body.persona }), 201);
      });
    }
    {
      const m = pathname.match(/^\/api\/pets\/([^/]+)$/);
      if (m) {
        const id = m[1];
        if (method === 'GET') return safe(async () => {
          const p = await getPet(id);
          return p ? ok(p) : err(404, 'pet not found');
        });
        if (method === 'PATCH') return safe(async () => {
          const body = await readBody<{ name?: string; persona?: string }>(req);
          if (!body) return err(400, 'invalid JSON body');
          const next = await updatePet(id, body);
          return next ? ok(next) : err(404, 'pet not found');
        });
        if (method === 'DELETE') return safe(async () => {
          const removed = await deletePet(id);
          return removed ? ok({ ok: true }) : err(404, 'pet not found');
        });
      }
    }

    // ── Providers ──
    if (method === 'POST' && pathname === '/api/providers/unlock') {
      return safe(async () => {
        const body = await readBody<{ password?: string }>(req);
        if (!body?.password) return err(400, 'password required');
        const r = await unlock(body.password);
        return ok({ ok: true, unlocked: true, created: r.created });
      });
    }
    if (method === 'POST' && pathname === '/api/providers/lock') {
      lock();
      return ok({ ok: true, unlocked: false });
    }
    if (method === 'POST' && pathname === '/api/providers/change-password') {
      return safe(async () => {
        const body = await readBody<{ newPassword?: string }>(req);
        if (!body?.newPassword) return err(400, 'newPassword required');
        await changePassword(body.newPassword);
        return ok({ ok: true });
      });
    }
    if (method === 'GET' && pathname === '/api/providers') {
      return safe(async () => ok(await listProviders()));
    }
    if (method === 'POST' && pathname === '/api/providers') {
      return safe(async () => {
        const body = await readBody<any>(req);
        if (!body) return err(400, 'invalid JSON body');
        if (!body.type || !body.name || !body.apiKey) {
          return err(400, 'type, name, apiKey required');
        }
        return ok(await createProvider(body), 201);
      });
    }
    {
      const m = pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (m) {
        const id = m[1];
        if (method === 'GET') return safe(async () => {
          const p = await getProvider(id);
          return p ? ok(p) : err(404, 'provider not found');
        });
        if (method === 'PATCH') return safe(async () => {
          const body = await readBody<any>(req);
          if (!body) return err(400, 'invalid JSON body');
          const next = await updateProvider(id, body);
          return next ? ok(next) : err(404, 'provider not found');
        });
        if (method === 'DELETE') return safe(async () => {
          const removed = await deleteProvider(id);
          return removed ? ok({ ok: true }) : err(404, 'provider not found');
        });
      }
    }

    // ── LLM test (probe a saved provider) ──
    if (method === 'POST' && pathname === '/api/llm/test') {
      return safe(async () => {
        const body = await readBody<{ providerId?: string; model?: string; prompt?: string; temperature?: number; maxTokens?: number; timeoutMs?: number }>(req);
        if (!body?.providerId || !body?.model || !body?.prompt) {
          return err(400, 'providerId, model, prompt required');
        }
        const provider = await getProviderInternal(body.providerId);
        if (!provider) return err(404, 'provider not found');
        const client = createLLMClient(platform, provider);
        try {
          const r = await client.chat({
            messages: [{ role: 'user', content: body.prompt }],
            model: body.model,
            temperature: body.temperature,
            maxTokens: body.maxTokens ?? 256,
            timeoutMs: body.timeoutMs,
          });
          return ok({
            content: r.content,
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            elapsedMs: r.elapsedMs,
            finishReason: r.finishReason,
          });
        } catch (e) {
          if (e instanceof LLMError) {
            return err(e.status && e.status >= 400 ? e.status : 502, e.message);
          }
          throw e;
        }
      });
    }

    // ── Help index (text listing, useful from terminal) ──
    if (method === 'GET' && pathname === '/api/help') {
      return new Response(
        [
          'social-agent service v0.0.1',
          `home: ${paths.home}`,
          '',
          'endpoints:',
          '  GET    /api/ping',
          '  GET    /api/status',
          '  GET    /api/settings              PATCH',
          '  GET    /api/pets                  POST   { name, persona? }',
          '  GET    /api/pets/:id              PATCH  DELETE',
          '  POST   /api/providers/unlock      { password }',
          '  POST   /api/providers/lock',
          '  POST   /api/providers/change-password { newPassword }',
          '  GET    /api/providers             POST   { type, name, apiKey, baseUrl?, defaultModel? }',
          '  GET    /api/providers/:id         PATCH  DELETE',
          '  POST   /api/llm/test              { providerId, model, prompt, ...opts }',
          '  WS     /ws',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    return err(404, 'not found');
  },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ type: 'hello', ts: Date.now() })); },
    message(ws, msg) { ws.send(JSON.stringify({ type: 'echo', payload: String(msg) })); },
    close() { /* noop */ },
  },
});

  return { server, paths, platform };
}

if (import.meta.main) {
  const { server, paths } = await startServer();
  console.log(`social-agent listening on http://localhost:${server.port}`);
  console.log(`home: ${paths.home}`);
}
