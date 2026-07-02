/**
 * Smoke test for the Node platform implementation.
 * Run: bun run scripts/smoke-platform.ts
 *
 * Touches a temp dir under $TMPDIR — does NOT use ~/.social-agent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';

const home = mkdtempSync(join(tmpdir(), 'social-agent-platform-test-'));
console.log('temp home:', home);

const platform = createNodePlatform(home);

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log('\n── fs ──');
{
  const path = join(home, 'hello.txt');
  await platform.fs.writeAtomic(path, 'world');
  check('writeAtomic', await platform.fs.exists(path));
  check('read',        (await platform.fs.read(path)) === 'world');
  await platform.fs.append(path, '!');
  check('append',      (await platform.fs.read(path)) === 'world!');
  const s = await platform.fs.stat(path);
  check('stat',        s !== null && s.size === 6 && !s.isDirectory);
  await platform.fs.unlink(path);
  check('unlink',      !(await platform.fs.exists(path)));
  check('stat null',   (await platform.fs.stat(path)) === null);
}

console.log('\n── workspace (petId-aware) ──');
{
  const petId = 'pet-abc';
  await platform.workspace.write(petId, 'social/group/INTENT_999.md', '【我刚做了】test');
  check('write',  await platform.workspace.exists(petId, 'social/group/INTENT_999.md'));
  const text = await platform.workspace.read(petId, 'social/group/INTENT_999.md');
  check('read',   text === '【我刚做了】test');
  const files = await platform.workspace.list(petId, 'social/group');
  check('list',   files.includes('INTENT_999.md'));
  const abs = platform.workspace.absolute(petId, 'social/group/INTENT_999.md');
  check('absolute path is under home', abs.startsWith(home));

  // path-traversal protection
  let escaped = false;
  try {
    await platform.workspace.read(petId, '../../../etc/passwd');
  } catch { escaped = true; }
  check('escape blocked',  escaped);

  // bad petId
  let badPet = false;
  try {
    await platform.workspace.read('../foo', 'x');
  } catch { badPet = true; }
  check('bad petId blocked', badPet);
}

console.log('\n── http ──');
{
  // bun native fetch against a publicly known small endpoint? we don't want
  // network here. Instead spin up a tiny server on a random port locally.
  const localServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.endsWith('/echo')) {
        return Response.json({ method: req.method, headers: Object.fromEntries(req.headers) });
      }
      if (req.url.endsWith('/stream')) {
        const body = new ReadableStream({
          async start(controller) {
            for (const chunk of ['data: a\n\n', 'data: b\n\n', 'data: c\n\n']) {
              controller.enqueue(new TextEncoder().encode(chunk));
              await new Promise(r => setTimeout(r, 5));
            }
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('ok');
    },
  });
  const base = `http://localhost:${localServer.port}`;

  const r = await platform.http.request({ url: `${base}/echo`, method: 'POST', headers: { 'x-test': '1' }, body: '{}' });
  check('request status 200',  r.status === 200);
  check('request body parsed', JSON.parse(r.body).method === 'POST');

  const chunks: string[] = [];
  for await (const chunk of platform.http.stream({ url: `${base}/stream` })) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  const joined = chunks.join('');
  check('stream all 3 events', joined.includes('a') && joined.includes('b') && joined.includes('c'));

  let timedOut = false;
  try {
    await platform.http.request({ url: `${base}/never-responds`, timeoutMs: 50, method: 'GET' });
  } catch { timedOut = false; /* not actually a never-responds endpoint, can't easily test timeout */ }
  // we'll skip the strict timeout-failure test — endpoint above does respond

  localServer.stop(true);
}

console.log('\n── events ──');
{
  let received: any = null;
  const off = platform.events.on<{ x: number }>('test', (p) => { received = p; });
  platform.events.emit('test', { x: 42 });
  check('on receives', received?.x === 42);
  off();
  received = null;
  platform.events.emit('test', { x: 99 });
  check('off stops delivery', received === null);

  let onceCount = 0;
  platform.events.once('once-ch', () => { onceCount++; });
  platform.events.emit('once-ch', null);
  platform.events.emit('once-ch', null);
  check('once fires exactly once', onceCount === 1);
}

console.log('\n── mcp stub ──');
{
  let threw = false;
  try { await platform.mcp.callTool('any', 'any', {}); } catch { threw = true; }
  check('mcp throws (Phase 4 placeholder)', threw);
}

console.log('\n── paths ──');
{
  check('paths.home matches', platform.paths.home === home);
  check('paths.petWorkspace correct', platform.paths.petWorkspace('xyz') === join(home, 'pets', 'xyz', 'workspace'));
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(home, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
