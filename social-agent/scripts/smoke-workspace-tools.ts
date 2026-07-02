/**
 * Smoke test for workspace tools.
 *   - direct handler tests (read/write/edit/list, success + error paths)
 *   - integration: mock LLM that issues 3 sequential tool calls
 *     (write → edit → read) via callWithTools; verify on-disk effects.
 *
 * Run: bun run scripts/smoke-workspace-tools.ts
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';
import { createWorkspaceTools } from '../src/core/tools/workspace.ts';
import { createLLMClient, callWithTools } from '../src/core/llm/index.ts';
import type { Provider } from '../src/providers.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const home = mkdtempSync(join(tmpdir(), 'social-agent-ws-tools-'));
const platform = createNodePlatform(home);
const petId = 'pet-test';

const { definitions, handlers } = createWorkspaceTools(platform, petId);

// ─────────────────── direct handler tests ───────────────────

console.log('\n── definitions ──');
check('4 tool defs', definitions.length === 4);
check('every def has inputSchema', definitions.every(d => d.inputSchema && typeof d.inputSchema === 'object'));
check('names match handler keys', definitions.every(d => typeof handlers[d.name] === 'function'));

console.log('\n── social_write ──');
{
  const r = await handlers.social_write({ path: 'foo.txt', content: 'hello' });
  check('ok',                !r.isError);
  check('confirms target',   r.content.includes('foo.txt'));
  check('confirms char count', r.content.includes('5 chars'));
}

console.log('\n── social_read ──');
{
  const r = await handlers.social_read({ path: 'foo.txt' });
  check('ok',           !r.isError);
  check('exact content', r.content === 'hello');

  const r2 = await handlers.social_read({ path: 'missing.txt' });
  check('missing → error',          !!r2.isError);
  check('error mentions filename',  r2.content.includes('missing.txt'));

  const r3 = await handlers.social_read({});
  check('no path → error',          !!r3.isError);
}

console.log('\n── social_list ──');
{
  await handlers.social_write({ path: 'a/b/c.txt', content: 'x' });
  const r = await handlers.social_list({ path: '.' });
  check('lists root',   r.content.includes('foo.txt') && r.content.includes('a'));
  const r2 = await handlers.social_list({ path: 'a/b' });
  check('lists subdir', r2.content.includes('c.txt'));
  const r3 = await handlers.social_list({ path: 'nope' });
  check('missing → error', !!r3.isError);
}

console.log('\n── social_edit ──');
{
  const r = await handlers.social_edit({ path: 'foo.txt', oldText: 'hello', newText: 'world' });
  check('replaces 1 occurrence', !r.isError);
  const after = await handlers.social_read({ path: 'foo.txt' });
  check('content updated', after.content === 'world');

  await handlers.social_write({ path: 'dup.txt', content: 'cat\ncat\ncat\n' });
  const r2 = await handlers.social_edit({ path: 'dup.txt', oldText: 'cat', newText: 'dog' });
  check('ambiguous → error',  !!r2.isError);
  check('error mentions count', r2.content.includes('3 times'));

  const r3 = await handlers.social_edit({ path: 'foo.txt', oldText: 'XXX', newText: 'yyy' });
  check('not-found → error', !!r3.isError);

  // snake_case alias accepted
  const r4 = await handlers.social_edit({ path: 'foo.txt', old_text: 'world', new_text: 'sky' });
  check('snake_case args accepted', !r4.isError);
}

console.log('\n── path traversal ──');
{
  const r = await handlers.social_read({ path: '../../etc/passwd' });
  check('traversal blocked', !!r.isError);
}

// ─────────────────── integration: mock LLM + callWithTools ───────────────────

console.log('\n── integration: mock LLM driving real handlers ──');

// Stateful mock: 3 rounds of tool calls then a final text answer.
let round = 0;
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/messages') return new Response('not found', { status: 404 });
    round++;
    if (round === 1) {
      // → social_write
      return Response.json({
        id: 'm1', type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'social_write', input: { path: 'agent.md', content: 'first line' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    if (round === 2) {
      // → social_edit
      return Response.json({
        id: 'm2', type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'social_edit', input: { path: 'agent.md', oldText: 'first', newText: 'edited' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 12 },
      });
    }
    if (round === 3) {
      // → social_read
      return Response.json({
        id: 'm3', type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'tool_use', id: 'tu_3', name: 'social_read', input: { path: 'agent.md' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 14, output_tokens: 14 },
      });
    }
    // Final round: model has all info, returns text only
    return Response.json({
      id: 'm4', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'text', text: 'Done. File now contains: edited line' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 16, output_tokens: 12 },
    });
  },
});

const provider: Provider = {
  id: 'p', type: 'anthropic', name: 'mock',
  apiKey: 'sk-test', baseUrl: `http://localhost:${mock.port}`,
  createdAt: 0, updatedAt: 0,
};
const client = createLLMClient(platform, provider);

const calls: string[] = [];
const result = await callWithTools({
  client,
  model: 'm',
  messages: [{ role: 'user', content: 'Create agent.md, edit it, then show me.' }],
  tools: definitions,
  handlers,
  onToolCall: (c) => calls.push(c.name),
});

check('iterations==4',         result.iterations === 4);
check('called 3 tools',        calls.length === 3);
check('correct tool sequence', calls[0] === 'social_write' && calls[1] === 'social_edit' && calls[2] === 'social_read');
check('final answer text',     result.finalContent.includes('edited'));

// On-disk verification (the real point of this test)
const onDisk = readFileSync(join(home, 'pets', petId, 'workspace', 'agent.md'), 'utf8');
check('disk file exists', onDisk === 'edited line');

mock.stop(true);
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
