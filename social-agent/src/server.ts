import { ensureHome } from './paths.ts';
import {
  readSettings, patchSettings,
  listPets, createPet, getPet, updatePet, deletePet,
} from './config.ts';
import {
  listProviders, getProvider, createProvider, updateProvider, deleteProvider,
  getProviderInternal, setCachedModels,
} from './providers.ts';
import { readSocialConfig, writeSocialConfig, patchSocialConfig } from './socialConfig.ts';
import { createNodePlatform } from './platform/index.ts';
import { createLLMClient, LLMError } from './core/llm/index.ts';
import { runIntentEval } from './core/agent/intentEval.ts';
import { createAgentManager } from './core/agent/agent.ts';
import { AGENT_EVENT_CHANNEL, type AgentEvent } from './core/agent/events.ts';
import dashboardHtml from './web/index.html';

export interface StartServerOptions {
  port?: number;
}

export async function startServer(opts: StartServerOptions = {}) {
  const platform = createNodePlatform();
  const paths = ensureHome();
  // Port resolution precedence: explicit opts > $SOCIAL_AGENT_PORT > settings.json > default 8787
  const settingsAtBoot = await readSettings();
  const envPort = Number(process.env.SOCIAL_AGENT_PORT ?? '');
  const port = opts.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : settingsAtBoot.port);

  // Agent manager — singleton per server instance
  const agent = createAgentManager(platform, {
    providerLookup: (id: string) => getProviderInternal(id),
  });

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
    if (msg === 'apiKey required') return err(400, msg);
    return err(500, msg);
  }
}

// ─────────────────── server ───────────────────

  type WSData = { kind: 'echo' | 'agent'; off?: () => void };
  const server = Bun.serve<WSData, never>({
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
      if (server.upgrade(req, { data: { kind: 'echo' } })) return;
      return new Response('expected WebSocket upgrade', { status: 426 });
    }
    if (pathname === '/ws/agent') {
      if (server.upgrade(req, { data: { kind: 'agent' } })) return;
      return new Response('expected WebSocket upgrade', { status: 426 });
    }

    // ── Liveness ──
    if (method === 'GET' && pathname === '/api/ping') {
      return ok({ ok: true, home: paths.home, ts: Date.now() });
    }

    // ── Status ──
    if (method === 'GET' && pathname === '/api/status') {
      return ok({ home: paths.home });
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
      // Social config (per-pet) — schema mirrors Tauri's SocialPage config
      const sc = pathname.match(/^\/api\/pets\/([^/]+)\/social-config$/);
      if (sc) {
        const id = sc[1];
        if (method === 'GET') return safe(async () => {
          // Verify pet exists before returning config (otherwise consumers might
          // think any string is a valid pet id).
          const p = await getPet(id);
          if (!p) return err(404, 'pet not found');
          return ok(await readSocialConfig(id));
        });
        if (method === 'PUT') return safe(async () => {
          const p = await getPet(id);
          if (!p) return err(404, 'pet not found');
          const body = await readBody<any>(req);
          if (!body || typeof body !== 'object') return err(400, 'invalid JSON body');
          return ok(await writeSocialConfig(id, body));
        });
        if (method === 'PATCH') return safe(async () => {
          const p = await getPet(id);
          if (!p) return err(404, 'pet not found');
          const body = await readBody<any>(req);
          if (!body || typeof body !== 'object') return err(400, 'invalid JSON body');
          return ok(await patchSocialConfig(id, body));
        });
      }
    }

    // ── Providers ──
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
      const fm = pathname.match(/^\/api\/providers\/([^/]+)\/fetch-models$/);
      if (fm && method === 'POST') {
        const id = fm[1];
        return safe(async () => {
          const provider = await getProviderInternal(id);
          if (!provider) return err(404, 'provider not found');
          const client = createLLMClient(platform, provider);
          try {
            const models = await client.listModels({ timeoutMs: 30000 });
            const updated = await setCachedModels(id, models);
            return ok({ ok: true, models, count: models.length, provider: updated });
          } catch (e: any) {
            if (e instanceof LLMError) {
              return err(e.status && e.status >= 400 ? e.status : 502, e.message);
            }
            throw e;
          }
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

    // ── Intent eval (one-shot agent evaluation) ──
    if (method === 'POST' && pathname === '/api/agent/intent-eval') {
      return safe(async () => {
        const body = await readBody<any>(req);
        if (!body) return err(400, 'invalid JSON body');
        if (!body.petId)        return err(400, 'petId required');
        if (!body.targetId)     return err(400, 'targetId required');
        if (!body.providerId)   return err(400, 'providerId required');
        if (!body.model)        return err(400, 'model required');
        if (typeof body.chatSnapshot !== 'string') return err(400, 'chatSnapshot (string) required');

        const provider = await getProviderInternal(body.providerId);
        if (!provider) return err(404, 'provider not found');

        try {
          const result = await runIntentEval(platform, {
            petId: body.petId,
            targetId: body.targetId,
            targetType: body.targetType,
            provider,
            model: body.model,
            temperature: body.temperature,
            maxTokens: body.maxTokens,
            timeoutMs: body.timeoutMs,
            maxIterations: body.maxIterations,
            chatSnapshot: body.chatSnapshot,
            targetName: body.targetName,
            socialPersonaPrompt: body.socialPersonaPrompt,
            botQQ: body.botQQ,
            ownerQQ: body.ownerQQ,
            ownerName: body.ownerName,
            ownerSecret: body.ownerSecret,
            nameDelimiterL: body.nameDelimiterL,
            nameDelimiterR: body.nameDelimiterR,
            msgDelimiterL: body.msgDelimiterL,
            msgDelimiterR: body.msgDelimiterR,
            lurkMode: body.lurkMode,
            voiceEnabled: body.voiceEnabled,
            imageGenEnabled: body.imageGenEnabled,
            customGroupRules: body.customGroupRules,
            sinceLastEvalMin: body.sinceLastEvalMin,
            userPrompt: body.userPrompt,
          });
          // Drop full transcript from the wire to keep payload small;
          // toolCalls trace + plan is the actionable info.
          return ok({
            plan: result.plan,
            toolCalls: result.toolCalls,
            finalContent: result.finalContent,
            iterations: result.iterations,
            stoppedEarly: result.stoppedEarly,
            elapsedMs: result.elapsedMs,
          });
        } catch (e: any) {
          if (e instanceof LLMError) {
            return err(e.status && e.status >= 400 ? e.status : 502, e.message);
          }
          throw e;
        }
      });
    }

    // ── Agent sessions ──
    if (method === 'GET' && pathname === '/api/agent/sessions') {
      return ok(agent.list());
    }
    if (method === 'POST' && pathname === '/api/agent/sessions') {
      return safe(async () => {
        const body = await readBody<any>(req);
        if (!body) return err(400, 'invalid JSON body');
        if (!body.petId)      return err(400, 'petId required');
        if (!body.targetId)   return err(400, 'targetId required');
        if (!body.providerId) return err(400, 'providerId required');
        if (!body.model)      return err(400, 'model required');
        try {
          return ok(agent.start(body), 201);
        } catch (e: any) {
          if (e?.message?.startsWith('session already exists')) return err(409, e.message);
          throw e;
        }
      });
    }
    {
      const m = pathname.match(/^\/api\/agent\/sessions\/([^/]+)(?:\/(feed|pause|resume))?$/);
      if (m) {
        const targetId = decodeURIComponent(m[1]);
        const action = m[2];
        if (!action && method === 'GET') {
          const v = agent.get(targetId);
          return v ? ok(v) : err(404, 'session not found');
        }
        if (!action && method === 'DELETE') {
          return agent.stop(targetId) ? ok({ ok: true }) : err(404, 'session not found');
        }
        if (action === 'feed' && method === 'POST') {
          return safe(async () => {
            const body = await readBody<{ chatSnapshot?: string }>(req);
            if (!body || typeof body.chatSnapshot !== 'string') return err(400, 'chatSnapshot (string) required');
            return agent.feedChat(targetId, body.chatSnapshot)
              ? ok({ ok: true, queued: true })
              : err(404, 'session not found');
          });
        }
        if (action === 'pause' && method === 'POST') {
          return agent.pause(targetId) ? ok({ ok: true }) : err(404, 'session not found or already paused');
        }
        if (action === 'resume' && method === 'POST') {
          return agent.resume(targetId) ? ok({ ok: true }) : err(404, 'session not found or not paused');
        }
      }
    }

    // ── Help index (text listing, useful from terminal) ──
    if (method === 'GET' && pathname === '/api/help') {
      return new Response(
        [
          'PetGPT-Amadeus service v0.0.1',
          `home: ${paths.home}`,
          '',
          'endpoints:',
          '  GET    /api/ping',
          '  GET    /api/status',
          '  GET    /api/settings              PATCH',
          '  GET    /api/pets                  POST   { name, persona? }',
          '  GET    /api/pets/:id              PATCH  DELETE',
          '  GET    /api/pets/:id/social-config   PUT  PATCH',
          '  GET    /api/providers             POST   { type, name, apiKey, baseUrl?, defaultModel? }',
          '  GET    /api/providers/:id         PATCH  DELETE',
          '  POST   /api/providers/:id/fetch-models',
          '  POST   /api/llm/test              { providerId, model, prompt, ...opts }',
          '  POST   /api/agent/intent-eval     { petId, targetId, providerId, model, chatSnapshot, ... }',
          '  GET    /api/agent/sessions        POST   { petId, targetId, providerId, model, ... }',
          '  GET    /api/agent/sessions/:id    DELETE',
          '  POST   /api/agent/sessions/:id/feed   { chatSnapshot }',
          '  POST   /api/agent/sessions/:id/pause',
          '  POST   /api/agent/sessions/:id/resume',
          '  WS     /ws/agent                  agent event stream',
          '  WS     /ws',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    return err(404, 'not found');
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === 'agent') {
        // Subscribe this socket to agent events. Unsubscribe on close.
        const off = platform.events.on(AGENT_EVENT_CHANNEL, (e: AgentEvent) => {
          try { ws.send(JSON.stringify(e)); }
          catch { /* socket dead, listener will be released on close */ }
        });
        ws.data.off = off;
        ws.send(JSON.stringify({ type: 'hello', channel: 'agent', ts: Date.now() }));
        ws.send(JSON.stringify({ type: 'snapshot', sessions: agent.list(), ts: Date.now() }));
      } else {
        ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
      }
    },
    message(ws, msg) {
      if (ws.data.kind === 'agent') {
        return; // push-only
      }
      ws.send(JSON.stringify({ type: 'echo', payload: String(msg) }));
    },
    close(ws) {
      if (typeof ws.data.off === 'function') ws.data.off();
    },
  },
});

  return { server, paths, platform };
}

if (import.meta.main) {
  const { server, paths } = await startServer();
  console.log(`PetGPT-Amadeus listening on http://localhost:${server.port}`);
  console.log(`home: ${paths.home}`);
}
