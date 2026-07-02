/**
 * Smoke test for MCP server registry (Phase 4c).
 *
 * Run: bun run scripts/smoke-mcp-servers.ts
 */
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'social-agent-mcp-'));
process.env.SOCIAL_AGENT_HOME = tmpHome;

const m = await import('../src/mcpServers.ts');
const { startServer } = await import('../src/server.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ── direct module API ──
console.log('\n── module API ──');
{
  check('list empty initially', (await m.listMCPServers()).length === 0);

  const created = await m.createMCPServer({
    name: 'qq-mcp',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/qq'],
    env: { QQ_BOT_TOKEN: 'sk-secret' },
  });
  check('create returns id',         typeof created.id === 'string' && created.id.length > 0);
  check('create timestamps',         created.createdAt > 0 && created.updatedAt > 0);
  check('enabled default true',      created.enabled === true);

  // Persistence
  const path = join(tmpHome, 'mcp-servers.json');
  check('file exists',               existsSync(path));
  const mode = statSync(path).mode & 0o777;
  check('file mode 0600',            mode === 0o600);

  // Read back
  const list = await m.listMCPServers();
  check('list has 1',                list.length === 1);
  check('list keeps env',            list[0].env.QQ_BOT_TOKEN === 'sk-secret');

  const byId = await m.getMCPServer(created.id);
  check('getById',                   byId?.name === 'qq-mcp');

  const byName = await m.getMCPServerByName('qq-mcp');
  check('getByName',                 byName?.id === created.id);

  // Duplicate name → throws
  let threw = false;
  try { await m.createMCPServer({ name: 'qq-mcp', command: 'echo' }); } catch { threw = true; }
  check('duplicate name throws',     threw);

  // Update — change command, keep env
  const updated = await m.updateMCPServer(created.id, { command: 'bun', args: ['x', '@mcp/qq'] });
  check('update returns next',       updated?.command === 'bun');
  check('update preserves env',      updated?.env.QQ_BOT_TOKEN === 'sk-secret');
  check('updatedAt bumped',          (updated?.updatedAt ?? 0) > (updated?.createdAt ?? 0));

  // Update name → conflict with existing? Make a 2nd entry first
  await m.createMCPServer({ name: 'telegram-mcp', command: 'uvx', args: ['mcp-telegram'] });
  let conflict = false;
  try { await m.updateMCPServer(created.id, { name: 'telegram-mcp' }); } catch { conflict = true; }
  check('rename to existing → throw', conflict);

  // Delete
  const removed = await m.deleteMCPServer(created.id);
  check('delete returns true',       removed);
  check('list now 1',                (await m.listMCPServers()).length === 1);
  check('delete missing → false',    (await m.deleteMCPServer('does-not-exist')) === false);
}

// ── REST ──
console.log('\n── REST ──');
{
  const { server } = await startServer({ port: 0 });
  const port = server.port;

  let r = await fetch(`http://localhost:${port}/api/mcp-servers`);
  check('GET 200',                    r.status === 200);
  const initial = await r.json();
  check('GET returns array',          Array.isArray(initial));

  r = await fetch(`http://localhost:${port}/api/mcp-servers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'fs-mcp', command: 'npx', args: ['-y', '@mcp/fs'] }),
  });
  check('POST 201',                   r.status === 201);
  const created = await r.json();
  check('POST returns id',            !!created.id);

  r = await fetch(`http://localhost:${port}/api/mcp-servers/${created.id}`);
  check('GET by id 200',              r.status === 200);

  r = await fetch(`http://localhost:${port}/api/mcp-servers/${created.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  check('PATCH 200',                  r.status === 200);
  const patched = await r.json();
  check('PATCH applied enabled',      patched.enabled === false);

  // Duplicate name → 409
  r = await fetch(`http://localhost:${port}/api/mcp-servers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'fs-mcp', command: 'echo' }),
  });
  check('duplicate POST → 409',       r.status === 409);

  // Validation: missing required fields
  r = await fetch(`http://localhost:${port}/api/mcp-servers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'no-cmd' }),
  });
  check('missing command → 400',      r.status === 400);

  // Unknown id → 404
  r = await fetch(`http://localhost:${port}/api/mcp-servers/does-not-exist`);
  check('unknown id GET → 404',       r.status === 404);
  r = await fetch(`http://localhost:${port}/api/mcp-servers/does-not-exist`, { method: 'DELETE' });
  check('unknown id DELETE → 404',    r.status === 404);

  // Delete
  r = await fetch(`http://localhost:${port}/api/mcp-servers/${created.id}`, { method: 'DELETE' });
  check('DELETE 200',                 r.status === 200);
  r = await fetch(`http://localhost:${port}/api/mcp-servers/${created.id}`);
  check('GET after delete → 404',     r.status === 404);

  server.stop();
}

rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
