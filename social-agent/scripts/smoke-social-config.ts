/**
 * Smoke test for per-pet social config (Phase 4a).
 *
 * Verifies:
 *   - default config returned when no file exists
 *   - PUT replaces wholesale (with petId always anchored)
 *   - PATCH shallow merges, including nested objects (imageGenConfig / ttsConfig)
 *   - file mode is 0600 on disk
 *   - REST: GET / PUT / PATCH 404 when pet missing
 *
 * Run: bun run scripts/smoke-social-config.ts
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Override SOCIAL_AGENT_HOME before importing modules that read it
const tmpHome = mkdtempSync(join(tmpdir(), 'social-agent-cfg-'));
process.env.SOCIAL_AGENT_HOME = tmpHome;

const { defaultSocialConfig, readSocialConfig, writeSocialConfig, patchSocialConfig } = await import('../src/socialConfig.ts');
const { startServer } = await import('../src/server.ts');
const { createPet, deletePet } = await import('../src/config.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ── direct API ──
console.log('\n── direct module API ──');
{
  const pet = await createPet({ name: 'TestPet' });
  const id = pet.id;

  const def = await readSocialConfig(id);
  check('returns defaults when no file',     def.replyInterval === 0);
  check('petId anchored',                    def.petId === id);
  check('imageGenConfig defaults',           def.imageGenConfig.enabled === false);
  check('ttsConfig defaults',                def.ttsConfig.enabled === false);
  check('atMustReply default true',          def.atMustReply === true);
  check('observerInterval default 180',      def.observerInterval === 180);
  check('subagentModel default sonnet',      def.subagentModel === 'sonnet');

  // Write full
  const written = await writeSocialConfig(id, {
    ...def,
    apiProviderId: 'p1',
    modelName: 'claude-test',
    botQQ: '99999',
    watchedGroups: ['111', '222'],
    customGroupRules: { '111': 'rule1' },
    imageGenConfig: { enabled: true, providerId: 'pg', modelName: 'gpt-image-2' },
    ttsConfig:      { enabled: true, apiKey: 'sk-tts', voiceId: 'voice1', modelId: 'eleven-v2' },
  });
  check('write returns persisted',          written.modelName === 'claude-test');
  check('write keeps petId anchored',       written.petId === id);

  // File mode
  const filePath = join(tmpHome, 'pets', id, 'social-config.json');
  const mode = statSync(filePath).mode & 0o777;
  check('file mode 0600',                   mode === 0o600);

  // Re-read
  const reread = await readSocialConfig(id);
  check('round-trip apiProviderId',         reread.apiProviderId === 'p1');
  check('round-trip watchedGroups',         JSON.stringify(reread.watchedGroups) === JSON.stringify(['111', '222']));
  check('round-trip customGroupRules',      reread.customGroupRules['111'] === 'rule1');
  check('round-trip imageGenConfig',        reread.imageGenConfig.providerId === 'pg' && reread.imageGenConfig.enabled === true);
  check('round-trip ttsConfig',             reread.ttsConfig.voiceId === 'voice1');

  // PATCH shallow merge — top-level only changes specified
  const patched = await patchSocialConfig(id, {
    botQQ: '88888',
    customGroupRules: { '222': 'rule2' },     // merges with existing 111
  });
  check('patch updates botQQ',              patched.botQQ === '88888');
  check('patch keeps modelName',            patched.modelName === 'claude-test');
  check('patch merges customGroupRules 1',  patched.customGroupRules['111'] === 'rule1');
  check('patch merges customGroupRules 2',  patched.customGroupRules['222'] === 'rule2');
  check('patch keeps imageGenConfig',       patched.imageGenConfig.enabled === true);

  // Patch with nested override
  const patched2 = await patchSocialConfig(id, {
    imageGenConfig: { enabled: false } as any,    // partial
  });
  check('nested patch keeps providerId',    patched2.imageGenConfig.providerId === 'pg');
  check('nested patch updates enabled',     patched2.imageGenConfig.enabled === false);

  // Cleanup
  await deletePet(id);
}

// ── REST API ──
console.log('\n── REST API ──');
{
  // Spin up server on a random port (well, fixed but unused)
  const { server } = await startServer({ port: 0 });
  const port = server.port;

  const pet = await createPet({ name: 'RESTPet' });
  const id = pet.id;

  let r = await fetch(`http://localhost:${port}/api/pets/${id}/social-config`);
  check('GET returns 200',           r.status === 200);
  const cfg1 = await r.json();
  check('GET defaults populated',    cfg1.observerInterval === 180);

  r = await fetch(`http://localhost:${port}/api/pets/${id}/social-config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...cfg1, modelName: 'm2', enableImages: false }),
  });
  check('PUT returns 200',           r.status === 200);
  const after = await r.json();
  check('PUT body is updated',       after.modelName === 'm2' && after.enableImages === false);

  r = await fetch(`http://localhost:${port}/api/pets/${id}/social-config`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ atMustReply: false }),
  });
  check('PATCH returns 200',         r.status === 200);
  const patched = await r.json();
  check('PATCH atMustReply false',   patched.atMustReply === false);
  check('PATCH preserves modelName', patched.modelName === 'm2');

  // Bad pet id
  r = await fetch(`http://localhost:${port}/api/pets/does-not-exist/social-config`);
  check('GET unknown pet → 404',     r.status === 404);

  r = await fetch(`http://localhost:${port}/api/pets/does-not-exist/social-config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('PUT unknown pet → 404',     r.status === 404);

  r = await fetch(`http://localhost:${port}/api/pets/does-not-exist/social-config`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('PATCH unknown pet → 404',   r.status === 404);

  await deletePet(id);
  server.stop();
}

rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
