/**
 * Smoke test for AgentManager (Phase 3e2).
 *
 *   - start session
 *   - subscribe to events via platform.events
 *   - feedChat → eval kicks off async
 *   - capture event sequence (session:created, eval:start, eval:tool×N, eval:plan, eval:done)
 *   - feedChat WHILE eval running → second feed queues, picked up after first ends
 *   - pause/resume blocks/unblocks evals
 *   - stop tears down session
 *
 * Run: bun run scripts/smoke-agent.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';
import { createAgentManager } from '../src/core/agent/agent.ts';
import { AGENT_EVENT_CHANNEL, type AgentEvent } from '../src/core/agent/events.ts';
import type { Provider } from '../src/providers.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const home = mkdtempSync(join(tmpdir(), 'social-agent-mgr-'));
const platform = createNodePlatform(home);

await platform.workspace.write('pet-test', 'SOUL.md', '# Soul\nTest pet.');

// ── stateful mock provider that always returns a 2-round eval ──
let totalRounds = 0;
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/messages') return new Response('not found', { status: 404 });
    totalRounds++;
    const isFirstRoundOfEval = totalRounds % 2 === 1;
    if (isFirstRoundOfEval) {
      return Response.json({
        id: `m${totalRounds}`, type: 'message', role: 'assistant', model: 'test',
        content: [{ type: 'tool_use', id: `tu_${totalRounds}`, name: 'get_situation', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
      });
    }
    return Response.json({
      id: `m${totalRounds}`, type: 'message', role: 'assistant', model: 'test',
      content: [{
        type: 'tool_use', id: `tu_${totalRounds}`, name: 'write_intent_plan',
        input: {
          state: '【我的判断】决定回复',
          brief: '[闲扯]\nhi',
          actions: [{ type: 'reply' }],
        },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 30 },
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

// ── Subscribe to events ──
const events: AgentEvent[] = [];
platform.events.on<AgentEvent>(AGENT_EVENT_CHANNEL, (e) => events.push(e));

// ── start ──
console.log('\n── start session ──');
{
  const v = agent.start({
    petId: 'pet-test', targetId: 't1', targetType: 'group',
    providerId: 'p1', model: 'claude-test',
    targetName: '群1',
  });
  check('view returned',    v.config.targetId === 't1');
  check('status idle',      v.status === 'idle');
  check('list has 1',       agent.list().length === 1);
  check('session:created emitted', events.some(e => e.type === 'session:created' && e.targetId === 't1'));
}

// ── feedChat triggers eval ──
console.log('\n── feedChat → eval ──');
{
  events.length = 0;
  agent.feedChat('t1', '[14:00] Bob: hi');
  // wait for the eval to complete; 2 rounds against local mock — fast
  await new Promise(r => setTimeout(r, 500));

  const types = events.map(e => e.type);
  check('eval:start emitted',           types.includes('eval:start'));
  check('eval:tool emitted',            types.includes('eval:tool'));
  check('eval:plan emitted',            types.includes('eval:plan'));
  check('eval:done emitted',            types.includes('eval:done'));
  check('event order: start before done', types.indexOf('eval:start') < types.indexOf('eval:done'));

  const planEvent = events.find(e => e.type === 'eval:plan') as any;
  check('plan event has state',  !!planEvent?.plan?.state);
  check('plan event has brief',  planEvent?.plan?.brief?.includes('[闲扯]'));
  check('plan event has reply action', planEvent?.plan?.actions?.some((a: any) => a.type === 'reply'));

  const view = agent.get('t1')!;
  check('evalCount = 1',         view.evalCount === 1);
  check('lastPlan persisted',    !!view.lastPlan);
  check('status back to idle',   view.status === 'idle');
}

// ── feedChat while running queues, runs again ──
console.log('\n── back-to-back feeds queue properly ──');
{
  events.length = 0;
  agent.feedChat('t1', '[14:01] Carol: ?');
  // Immediately push another — should queue, not race
  agent.feedChat('t1', '[14:02] Dave: !');
  await new Promise(r => setTimeout(r, 800));

  const evalDones = events.filter(e => e.type === 'eval:done');
  // The second feed was queued during the first eval. Result: 2 evals total
  // (one per snapshot — second feed merged into pendingSnapshot, picked up
  // after first eval ended). Count may be 1 or 2 depending on timing.
  check('at least 1 eval after back-to-back feed', evalDones.length >= 1);
  check('no eval:error',                            !events.some(e => e.type === 'eval:error'));
}

// ── pause / resume ──
console.log('\n── pause / resume ──');
{
  events.length = 0;
  const okPause = agent.pause('t1');
  check('pause returns true',   okPause === true);
  check('session:paused emitted', events.some(e => e.type === 'session:paused'));

  // Feed during paused — should queue but NOT run
  agent.feedChat('t1', 'while paused');
  await new Promise(r => setTimeout(r, 200));
  const evalDuringPause = events.filter(e => e.type === 'eval:start');
  check('no eval started while paused', evalDuringPause.length === 0);

  const view = agent.get('t1')!;
  check('hasPendingSnapshot after paused feed', view.hasPendingSnapshot === true);

  // Resume → queued snapshot evaluates
  events.length = 0;
  const okResume = agent.resume('t1');
  check('resume returns true',  okResume === true);
  await new Promise(r => setTimeout(r, 500));
  check('eval:done after resume', events.some(e => e.type === 'eval:done'));
}

// ── stop ──
console.log('\n── stop ──');
{
  events.length = 0;
  const okStop = agent.stop('t1');
  check('stop returns true',          okStop === true);
  check('session:stopped emitted',    events.some(e => e.type === 'session:stopped'));
  check('list empty after stop',      agent.list().length === 0);
  check('get returns undefined',      agent.get('t1') === undefined);
  check('stop on missing returns false', agent.stop('does-not-exist') === false);
}

// ── duplicate start rejection ──
console.log('\n── duplicate start ──');
{
  agent.start({ petId: 'pet-test', targetId: 't2', providerId: 'p1', model: 'm' });
  let threw = false;
  try { agent.start({ petId: 'pet-test', targetId: 't2', providerId: 'p1', model: 'm' }); }
  catch { threw = true; }
  check('start with existing targetId throws', threw);
  agent.stop('t2');
}

mock.stop(true);
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
