/**
 * Smoke test for listModels + fetch-models REST endpoint (Phase 4b).
 *
 *   - each adapter's listModels() parses its provider's /models response shape
 *   - POST /api/providers/:id/fetch-models hits the live adapter, persists
 *     cachedModels + cachedModelsAt, returns the list
 *   - cachedModels round-trip through GET /api/providers/:id
 *   - apiFormat alias is exposed on ProviderPublic
 *
 * Run: bun run scripts/smoke-list-models.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'social-agent-models-'));
process.env.SOCIAL_AGENT_HOME = tmpHome;

const { createNodePlatform } = await import('../src/platform/index.ts');
const { createLLMClient }     = await import('../src/core/llm/index.ts');
const { createProvider, getProviderInternal } = await import('../src/providers.ts');
const { startServer }         = await import('../src/server.ts');
import type { Provider } from '../src/providers.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ── Mock all three /models shapes ──
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);

    // Anthropic
    if (url.pathname === '/v1/models') {
      return Response.json({
        data: [
          { id: 'claude-sonnet-4-6', type: 'model', display_name: 'Claude Sonnet 4.6', created_at: '2026-01-01' },
          { id: 'claude-haiku-4-5',  type: 'model', display_name: 'Claude Haiku 4.5',  created_at: '2026-01-01' },
          { id: 'claude-opus-4-7',   type: 'model', display_name: 'Claude Opus 4.7',   created_at: '2026-01-01' },
        ],
        has_more: false,
      });
    }

    // OpenAI-compatible
    if (url.pathname === '/openai/models') {
      return Response.json({
        data: [
          { id: 'gpt-4o',              object: 'model', created: 1700000000, owned_by: 'openai' },
          { id: 'gpt-4o-mini',         object: 'model', created: 1700000000, owned_by: 'openai' },
          { id: 'deepseek/deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' },
        ],
      });
    }

    // Gemini
    if (url.pathname === '/v1beta/models') {
      return Response.json({
        models: [
          { name: 'models/gemini-3-pro',     supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3-flash',   supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001',    supportedGenerationMethods: ['embedContent'] },
        ],
      });
    }

    // 401 path for error coverage
    if (url.pathname === '/v1/models-401') {
      return Response.json({ error: { message: 'invalid api key' } }, { status: 401 });
    }

    return new Response('not found', { status: 404 });
  },
});
const base = `http://localhost:${mock.port}`;
console.log('mock:', base);

const platform = createNodePlatform(tmpHome);

function provider(type: Provider['type'], baseUrl: string): Provider {
  return { id: 'p', type, name: 'mock', apiKey: 'sk-test', baseUrl, createdAt: 0, updatedAt: 0 };
}

// ── direct adapter listModels ──
console.log('\n── listModels (Anthropic) ──');
{
  const c = createLLMClient(platform, provider('anthropic', base));
  const m = await c.listModels();
  check('returns 3 models',     m.length === 3);
  check('contains sonnet-4-6',  m.includes('claude-sonnet-4-6'));
  check('contains opus-4-7',    m.includes('claude-opus-4-7'));
}

console.log('\n── listModels (OpenAI-compat) ──');
{
  const c = createLLMClient(platform, provider('openai-compat', `${base}/openai`));
  const m = await c.listModels();
  check('returns 3 models',         m.length === 3);
  check('contains gpt-4o',          m.includes('gpt-4o'));
  check('contains namespaced id',   m.includes('deepseek/deepseek-chat'));
}

console.log('\n── listModels (Gemini, strips models/ prefix) ──');
{
  const c = createLLMClient(platform, provider('gemini', `${base}/v1beta`));
  const m = await c.listModels();
  check('returns 3 models',          m.length === 3);
  check('strips models/ prefix',     m.includes('gemini-3-pro') && !m.some(x => x.startsWith('models/')));
  check('includes embedding model',  m.includes('embedding-001'));
}

console.log('\n── listModels error path ──');
{
  const c = createLLMClient(platform, provider('anthropic', `${base}/wrong-prefix`));
  let caught = false;
  try { await c.listModels(); } catch { caught = true; }
  check('throws LLMError on 404', caught);
}

// ── REST fetch-models + persistence ──
console.log('\n── REST POST /api/providers/:id/fetch-models ──');
{
  // Spin server
  const { server } = await startServer({ port: 0 });
  const port = server.port;

  // Create a real provider record
  const created = await createProvider({
    type: 'openai-compat', name: 'TestOA',
    apiKey: 'sk-x',
    baseUrl: `${base}/openai`,
  });
  const id = created.id;

  // GET → no cachedModels yet
  let r = await fetch(`http://localhost:${port}/api/providers/${id}`);
  check('GET initial 200',                r.status === 200);
  const before = await r.json();
  check('no cachedModels initially',      !before.cachedModels);
  check('apiFormat exposed (Tauri alias)', before.apiFormat === 'openai_compatible');

  // Fetch models
  r = await fetch(`http://localhost:${port}/api/providers/${id}/fetch-models`, { method: 'POST' });
  check('fetch-models 200',           r.status === 200);
  const fetched = await r.json();
  check('returned model list',        Array.isArray(fetched.models) && fetched.models.length === 3);
  check('count surfaced',             fetched.count === 3);
  check('provider.cachedModels set',  Array.isArray(fetched.provider?.cachedModels) && fetched.provider.cachedModels.length === 3);
  check('cachedModelsAt timestamp',   typeof fetched.provider?.cachedModelsAt === 'number');

  // Persistence: GET again
  r = await fetch(`http://localhost:${port}/api/providers/${id}`);
  const persisted = await r.json();
  check('cachedModels persisted',     persisted.cachedModels?.length === 3);
  check('cachedModels contains gpt-4o', persisted.cachedModels?.includes('gpt-4o'));

  // 404 for unknown provider
  r = await fetch(`http://localhost:${port}/api/providers/does-not-exist/fetch-models`, { method: 'POST' });
  check('unknown id → 404',           r.status === 404);

  // Internal-record API exposes the same data
  const internal = await getProviderInternal(id);
  check('internal record has cachedModels',   internal?.cachedModels?.length === 3);
  check('internal apiKey still readable',     internal?.apiKey === 'sk-x');

  server.stop();
}

// ── apiFormat alias ──
console.log('\n── apiFormat alias on each provider type ──');
{
  const { server } = await startServer({ port: 0 });
  const port = server.port;

  for (const [type, expected] of [
    ['anthropic', 'anthropic_native'],
    ['openai-compat', 'openai_compatible'],
    ['gemini', 'gemini_official'],
  ] as const) {
    const created = await createProvider({
      type, name: `T-${type}`, apiKey: 'sk',
      baseUrl: type === 'openai-compat' ? `${base}/openai` : type === 'gemini' ? `${base}/v1beta` : base,
    });
    const r = await fetch(`http://localhost:${port}/api/providers/${created.id}`);
    const j = await r.json();
    check(`apiFormat for ${type}`, j.apiFormat === expected);
  }
  server.stop();
}

mock.stop(true);
rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
