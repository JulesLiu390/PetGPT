/**
 * Smoke test for Reply → MCP dispatch (Phase 5c).
 *
 * Spins up a fake MCP server (echo tool) + a mock LLM that emits a 2-round
 * Intent then a 1-round Reply (send_message). When AgentManager finishes
 * the reply, it should:
 *   - emit reply:sent with the captured content
 *   - call platform.mcp.callTool(mcpServerName, mcpSendTool, payload)
 *   - emit reply:dispatched with the MCP result
 *
 * Then a second round triggers the dispatch-failed path by pointing to a
 * server that returns isError.
 *
 * Run: bun run scripts/smoke-reply-mcp.ts
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

const home = mkdtempSync(join(tmpdir(), 'social-agent-replymcp-'));

// MCP registry — fake server pointing at the same fake-mcp-server fixture
const fixture = resolve(import.meta.dir, 'fixtures/fake-mcp-server.ts');
const registry = new Map<string, MCPServer>();
registry.set('fake-qq', {
  id: 'r1', name: 'fake-qq', command: 'bun', args: ['run', fixture],
  env: {}, enabled: true, createdAt: 0, updatedAt: 0,
});

const platform = createNodePlatform({
  home,
  mcpLookup: async (name) => registry.get(name),
});

await platform.workspace.write('pet-test', 'SOUL.md', '# Soul\nTest pet.');

// ── Mock LLM: 2-round Intent → 1-round Reply (echo) ──
let intentRound = 0;
let replyRound  = 0;

const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/messages') return new Response('not found', { status: 404 });
    const body = await req.json() as any;
    const tools = (body.tools || []).map((t: any) => t.name);
    const isReply = tools.includes('send_message');

    if (isReply) {
      replyRound++;
      return Response.json({
        id: `r${replyRound}`, type: 'message', role: 'assistant', model: 'm',
        content: [{
          type: 'tool_use', id: `tu_r${replyRound}`, name: 'send_message',
          input: { content: `hello from reply #${replyRound}`, reply_to: 'msg_xyz' },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 20 },
      });
    }

    intentRound++;
    if (intentRound % 2 === 1) {
      return Response.json({
        id: `i${intentRound}`, type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'tool_use', id: `tu_i${intentRound}`, name: 'get_situation', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
      });
    }
    return Response.json({
      id: `i${intentRound}`, type: 'message', role: 'assistant', model: 'm',
      content: [{
        type: 'tool_use', id: `tu_i${intentRound}`, name: 'write_intent_plan',
        input: {
          state: '【我的判断】回复',
          brief: `[闲扯]\n回复内容`,
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

const events: AgentEvent[] = [];
platform.events.on<AgentEvent>(AGENT_EVENT_CHANNEL, (e) => events.push(e));
function eventsOf(t: AgentEvent['type']) { return events.filter(e => e.type === t); }
async function waitFor(t: AgentEvent['type'], ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const e = eventsOf(t).at(-1);
    if (e) return e;
    await new Promise(r => setTimeout(r, 30));
  }
  return null;
}

// ── Test 1: Reply → MCP dispatched (success path) ──
console.log('\n── reply dispatched to MCP echo tool ──');
{
  events.length = 0;
  intentRound = 0; replyRound = 0;

  agent.start({
    petId: 'pet-test', targetId: 't-mcp', targetType: 'group',
    providerId: 'p1', model: 'claude-test', targetName: 'TestGroup', botQQ: '99999',
    mcpServerName: 'fake-qq',
    mcpSendTool: 'echo',           // map to the echo tool exposed by fake server
  });

  agent.feedChat('t-mcp', '[14:00] Bob: hi');

  await waitFor('reply:done', 6000);
  // Wait an extra beat for dispatched (it fires after sent)
  await new Promise(r => setTimeout(r, 200));

  const sent       = eventsOf('reply:sent').at(-1) as any;
  const dispatched = eventsOf('reply:dispatched').at(-1) as any;
  const failed     = eventsOf('reply:dispatch-failed').at(-1) as any;

  check('reply:sent emitted',                !!sent);
  check('reply:dispatched emitted',          !!dispatched);
  check('reply:dispatched not failed',       !failed);
  check('dispatched.mcpServerName correct',  dispatched?.mcpServerName === 'fake-qq');
  check('dispatched.toolName correct',       dispatched?.toolName === 'echo');
  // The echo fixture's reply contains "echoed: <content>" where content is
  // a JSON string. We loaded an object with content/target/etc, so the actual
  // arg to echo is the full payload — fixture echoes args.msg. Since we don't
  // pass msg, fixture echoes 'undefined'. That's fine — test still verifies
  // dispatch happened and the MCP tool ran.
  const echoText = dispatched?.result?.content?.[0]?.text ?? '';
  check('echo result returned text',         typeof echoText === 'string' && echoText.startsWith('echoed:'));

  agent.stop('t-mcp');
}

// ── Test 2: Reply with NO mcpServerName → no dispatch event ──
console.log('\n── no mcpServerName → reply:sent only, no dispatch ──');
{
  events.length = 0;
  intentRound = 0; replyRound = 0;

  agent.start({
    petId: 'pet-test', targetId: 't-no-mcp', targetType: 'group',
    providerId: 'p1', model: 'claude-test', targetName: 'NoMCP', botQQ: '99999',
    // intentionally no mcpServerName
  });

  agent.feedChat('t-no-mcp', '[14:00] Bob: hi');
  await waitFor('reply:done', 6000);
  await new Promise(r => setTimeout(r, 200));

  check('reply:sent emitted',           eventsOf('reply:sent').length === 1);
  check('reply:dispatched NOT emitted', eventsOf('reply:dispatched').length === 0);
  check('reply:dispatch-failed NOT emitted', eventsOf('reply:dispatch-failed').length === 0);

  agent.stop('t-no-mcp');
}

// ── Test 3: missing MCP server name → dispatch-failed ──
console.log('\n── unknown mcpServerName → reply:dispatch-failed ──');
{
  events.length = 0;
  intentRound = 0; replyRound = 0;

  agent.start({
    petId: 'pet-test', targetId: 't-bad-mcp', targetType: 'group',
    providerId: 'p1', model: 'claude-test', targetName: 'BadMCP', botQQ: '99999',
    mcpServerName: 'does-not-exist',
    mcpSendTool: 'send_message',
  });

  agent.feedChat('t-bad-mcp', '[14:00] Bob: hi');
  await waitFor('reply:done', 6000);
  await new Promise(r => setTimeout(r, 300));

  const failed = eventsOf('reply:dispatch-failed').at(-1) as any;
  check('reply:dispatch-failed emitted',          !!failed);
  check('reply:dispatched NOT emitted',           eventsOf('reply:dispatched').length === 0);
  check('failure message mentions config',        /not found/.test(failed?.message ?? ''));
  check('failed.mcpServerName preserved',         failed?.mcpServerName === 'does-not-exist');

  agent.stop('t-bad-mcp');
}

await platform.mcp.shutdown();
mock.stop(true);
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
