/**
 * Smoke test for the MCP-driven fetcher (Phase 5d).
 *
 * Boots the fake MCP server (which exposes fetch_messages with a stateful
 * 4-message script) + a mock LLM that 100% sends-replies on every Intent
 * eval. Verifies:
 *   - session.start with mcpServerName auto-starts the fetcher
 *   - fetch:tick fires per interval, surfaces newMessageCount
 *   - rolling buffer accumulates with `since` watermark advance
 *   - dedup: replayed messages are dropped
 *   - feedChat is implicitly triggered → eval runs against fetched snapshot
 *   - pause stops the fetcher, resume restarts
 *   - stop clears the interval
 *
 * Run: bun run scripts/smoke-fetcher.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';
import { createAgentManager } from '../src/core/agent/agent.ts';
import { AGENT_EVENT_CHANNEL, type AgentEvent } from '../src/core/agent/events.ts';
import type { Provider } from '../src/providers.ts';
import type { MCPServer } from '../src/mcpServers.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const home = mkdtempSync(join(tmpdir(), 'social-agent-fetcher-'));

// MCP registry
const fixture = resolve(import.meta.dir, 'fixtures/fake-mcp-server.ts');
const registry = new Map<string, MCPServer>();
registry.set('fake-fetch', {
  id: 'f1', name: 'fake-fetch', command: 'bun', args: ['run', fixture],
  env: {}, enabled: true, createdAt: 0, updatedAt: 0,
});

const platform = createNodePlatform({
  home,
  mcpLookup: async (name) => registry.get(name),
});
await platform.workspace.write('pet-test', 'SOUL.md', '# Soul\nTest pet.');

// ── Mock LLM (Intent always plans no-reply, to keep eval simple) ──
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/messages') return new Response('not found', { status: 404 });
    const body = await req.json() as any;
    const tools = (body.tools || []).map((t: any) => t.name);
    const isReply = tools.includes('send_message');
    if (isReply) {
      // Just send a fixed reply
      return Response.json({
        type: 'message', role: 'assistant', model: 'm', id: 'r',
        content: [{ type: 'tool_use', id: 'tu_r', name: 'send_message', input: { content: 'ack' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 10 },
      });
    }
    // Intent: 1-round terminal write_intent_plan with empty actions (no reply spawn)
    return Response.json({
      type: 'message', role: 'assistant', model: 'm', id: 'i',
      content: [{
        type: 'tool_use', id: 'tu_i', name: 'write_intent_plan',
        input: { state: '【我的判断】sit tight', brief: '', actions: [] },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  },
});

const provider: Provider = {
  id: 'p1', type: 'anthropic', name: 'mock',
  apiKey: 'sk-test', baseUrl: `http://localhost:${mock.port}`,
  createdAt: 0, updatedAt: 0,
};

const agent = createAgentManager(platform, {
  providerLookup: async (id) => id === 'p1' ? provider : undefined,
});

const events: AgentEvent[] = [];
platform.events.on<AgentEvent>(AGENT_EVENT_CHANNEL, (e) => events.push(e));
function eventsOf(t: AgentEvent['type']) { return events.filter(e => e.type === t); }
async function waitFor(predicate: () => boolean, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 30));
  }
  return false;
}

// ── Test: start session with MCP → fetcher auto-starts and drains messages ──
console.log('\n── fetcher auto-starts + drains 4 messages ──');
{
  events.length = 0;

  agent.start({
    petId: 'pet-test', targetId: 't-fetch', targetType: 'group',
    providerId: 'p1', model: 'claude-test', targetName: 'FetchGroup',
    mcpServerName: 'fake-fetch',
    mcpFetchTool: 'fetch_messages',
    fetchIntervalMs: 200,         // tight for smoke test
    fetchBufferSize: 60,
  });

  // First tick fires immediately + then every 200ms. Wait for either
  // a tick that surfaces ≥1 fetched message, OR a couple of ticks elapsed.
  const arrived = await waitFor(
    () => eventsOf('fetch:tick').some((e: any) => e.newMessageCount >= 4),
    8000,
  );
  check('fetch:started emitted',        eventsOf('fetch:started').length === 1);
  check('all 4 messages fetched',       arrived);

  const ticksWithNew = eventsOf('fetch:tick').filter((e: any) => e.newMessageCount > 0);
  check('at least 1 tick with new msgs', ticksWithNew.length >= 1);
  check('watermark advanced to m4',     (eventsOf('fetch:tick').at(-1) as any)?.watermark === 'm4');

  // After messages arrive, eval should run (status flips to evaluating then idle)
  const evalDone = await waitFor(() => eventsOf('eval:done').length >= 1, 6000);
  check('eval ran after fetch',         evalDone);

  // Wait for a couple more ticks — should NOT surface new messages (dedup)
  const ticksAfter = eventsOf('fetch:tick').length;
  await new Promise(r => setTimeout(r, 600));
  const ticksLater = eventsOf('fetch:tick');
  const newAfter = ticksLater.slice(ticksAfter).filter((e: any) => e.newMessageCount > 0);
  check('no new messages after drain (dedup)', newAfter.length === 0);

  // Pause should stop the fetcher
  events.length = 0;
  agent.pause('t-fetch');
  await new Promise(r => setTimeout(r, 100));
  check('fetch:stopped on pause',       eventsOf('fetch:stopped').some((e: any) => e.reason === 'session-paused'));
  // No more ticks for ~600ms
  const ticksBeforePause = eventsOf('fetch:tick').length;
  await new Promise(r => setTimeout(r, 600));
  const ticksAfterPause = eventsOf('fetch:tick').length;
  check('no fetcher ticks while paused', ticksAfterPause === ticksBeforePause);

  // Resume restarts fetcher
  events.length = 0;
  agent.resume('t-fetch');
  await new Promise(r => setTimeout(r, 400));
  check('fetch:started on resume',      eventsOf('fetch:started').length >= 1);

  // Stop clears everything
  events.length = 0;
  agent.stop('t-fetch');
  await new Promise(r => setTimeout(r, 100));
  check('fetch:stopped on stop',        eventsOf('fetch:stopped').some((e: any) => e.reason === 'session-stopped'));
}

// ── Test: session WITHOUT mcpServerName → no fetcher ──
console.log('\n── session w/o mcpServerName → no fetcher events ──');
{
  events.length = 0;
  agent.start({
    petId: 'pet-test', targetId: 't-no-fetch', targetType: 'group',
    providerId: 'p1', model: 'claude-test',
    // intentionally no mcpServerName
  });
  await new Promise(r => setTimeout(r, 500));
  check('no fetch:started',             eventsOf('fetch:started').length === 0);
  check('no fetch:tick',                eventsOf('fetch:tick').length === 0);
  agent.stop('t-no-fetch');
}

await platform.mcp.shutdown();
mock.stop(true);
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
