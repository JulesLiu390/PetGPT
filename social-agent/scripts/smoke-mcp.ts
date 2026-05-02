/**
 * Smoke test for real MCP integration (Phase 5a).
 *
 * Spawns scripts/fixtures/fake-mcp-server.ts via the platform.mcp adapter
 * and verifies the full lifecycle:
 *   - ensureRunning spawns the child + completes the protocol handshake
 *   - listTools returns the fake server's 2 tools with proper shape
 *   - callTool('echo') returns the echoed payload
 *   - callTool('throw_oops') surfaces isError without crashing the loop
 *   - dedup: concurrent ensureRunning spawns exactly one process
 *   - shutdown closes gracefully
 *   - status() / running() reflect state
 *   - missing config → throws "MCP server config not found"
 *   - disabled config → throws "MCP server is disabled"
 *
 * Run: bun run scripts/smoke-mcp.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createNodeMCP } from '../src/platform/node-mcp.ts';
import type { MCPServer } from '../src/mcpServers.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const tmpHome = mkdtempSync(join(tmpdir(), 'social-agent-mcp-'));
const fixturePath = resolve(import.meta.dir, 'fixtures/fake-mcp-server.ts');

// Mock registry — bypass the real disk-backed registry for isolation
const registry = new Map<string, MCPServer>();

function makeServerCfg(overrides: Partial<MCPServer> = {}): MCPServer {
  const now = Date.now();
  return {
    id: 'fake-id',
    name: 'fake',
    command: 'bun',
    args: ['run', fixturePath],
    env: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const lookup = async (name: string): Promise<MCPServer | undefined> => registry.get(name);

const mcp = createNodeMCP({ lookup });

// ── basic lifecycle ──
console.log('\n── ensure / list / call / shutdown ──');
{
  registry.set('fake', makeServerCfg());

  await mcp.ensureRunning('fake');
  check('after ensure: status running', mcp.status('fake') === 'running');
  check('running list has fake',        mcp.running().includes('fake'));

  const tools = await mcp.listTools('fake');
  check('listTools returns 2',          tools.length === 2);
  const echoTool = tools.find(t => t.name === 'echo');
  check('echo tool exists',             !!echoTool);
  check('echo has description',         !!echoTool?.description);
  check('echo has inputSchema',         !!echoTool?.inputSchema);

  const r1 = await mcp.callTool('fake', 'echo', { msg: 'hello' }) as any;
  const text1 = r1?.content?.[0]?.text;
  check('echo callTool returns text',   typeof text1 === 'string' && text1.includes('echoed: hello'));
  check('echo callTool not isError',    r1?.isError !== true);

  const r2 = await mcp.callTool('fake', 'throw_oops', {}) as any;
  check('throw_oops surfaces isError',  r2?.isError === true);
  check('throw_oops returns content',   typeof r2?.content?.[0]?.text === 'string');

  await mcp.shutdown('fake');
  check('after shutdown: status stopped', mcp.status('fake') === 'stopped');
  check('running list empty',             mcp.running().length === 0);
}

// ── concurrent ensureRunning dedup ──
console.log('\n── concurrent ensure dedup ──');
{
  registry.set('fake2', makeServerCfg({ id: 'f2', name: 'fake2' }));
  // Fire 5 concurrent ensureRunning. Only 1 child should be spawned.
  const before = mcp.running().length;
  await Promise.all([
    mcp.ensureRunning('fake2'),
    mcp.ensureRunning('fake2'),
    mcp.ensureRunning('fake2'),
    mcp.ensureRunning('fake2'),
    mcp.ensureRunning('fake2'),
  ]);
  const after = mcp.running().length;
  check('concurrent ensures: +1 process', after === before + 1);

  // listTools after concurrent ensure still works
  const tools = await mcp.listTools('fake2');
  check('post-dedup listTools works', tools.length === 2);

  await mcp.shutdown('fake2');
}

// ── error paths ──
console.log('\n── error paths ──');
{
  let threw = false;
  try { await mcp.ensureRunning('does-not-exist'); } catch (e: any) {
    threw = true;
    check('error mentions missing config', /not found/.test(e.message));
  }
  check('missing config throws', threw);

  registry.set('disabled-srv', makeServerCfg({ id: 'd1', name: 'disabled-srv', enabled: false }));
  let threw2 = false;
  try { await mcp.ensureRunning('disabled-srv'); } catch (e: any) {
    threw2 = true;
    check('error mentions disabled', /disabled/.test(e.message));
  }
  check('disabled config throws', threw2);
}

// ── shutdown all ──
console.log('\n── shutdown all ──');
{
  registry.set('s-all-1', makeServerCfg({ id: 'a1', name: 's-all-1' }));
  registry.set('s-all-2', makeServerCfg({ id: 'a2', name: 's-all-2' }));
  await mcp.ensureRunning('s-all-1');
  await mcp.ensureRunning('s-all-2');
  check('two running before',  mcp.running().length === 2);
  await mcp.shutdown();
  check('zero running after',  mcp.running().length === 0);
}

rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
