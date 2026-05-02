/**
 * Migrate pets / api_providers / mcp_servers from the Tauri petgpt.db
 * into ~/.social-agent's stores.
 *
 * Default: dry-run — prints a report of what would be imported, no writes.
 * Pass --commit to actually persist.
 * Pass --replace to overwrite entries with the same id (default: skip dup).
 *
 * Run:
 *   bun run scripts/migrate-from-tauri.ts                        # report only
 *   bun run scripts/migrate-from-tauri.ts --commit                # apply, skip duplicates
 *   bun run scripts/migrate-from-tauri.ts --commit --replace      # apply + overwrite
 *   bun run scripts/migrate-from-tauri.ts --db /custom/path.db    # custom DB path
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveHome, ensureHome } from '../src/paths.ts';

// ─── parse args ───
const args = process.argv.slice(2);
const COMMIT  = args.includes('--commit');
const REPLACE = args.includes('--replace');
const DB_FLAG_IDX = args.findIndex(a => a === '--db');
const DEFAULT_DB  = join(homedir(), 'Library', 'Application Support', 'com.petgpt.app', 'petgpt.db');
const DB_PATH = DB_FLAG_IDX >= 0 ? args[DB_FLAG_IDX + 1] : DEFAULT_DB;

if (!existsSync(DB_PATH)) {
  console.error(`Tauri DB not found at: ${DB_PATH}`);
  console.error('Pass --db <path> to point at a different location.');
  process.exit(1);
}

ensureHome();
const home = resolveHome();
console.log(`Source:  ${DB_PATH}`);
console.log(`Target:  ${home}`);
console.log(`Mode:    ${COMMIT ? (REPLACE ? '⚠️  COMMIT (replace duplicates)' : '✅ COMMIT (skip duplicates)') : '👀 dry-run (no writes)'}\n`);

const db = new Database(DB_PATH, { readonly: true });

// ─── helpers ───
function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// Tauri api_format → social-agent provider type
function mapApiFormat(f: string): 'openai-compat' | 'anthropic' | 'gemini' {
  switch (f) {
    case 'openai_compatible': return 'openai-compat';
    case 'anthropic_native':  return 'anthropic';
    case 'gemini_official':   return 'gemini';
    default:                  return 'openai-compat';   // fallback for unknown
  }
}

// ─── 1. Pets ───
console.log('═══ Pets ═══');
const tauriPets = db.query<any, []>(
  `SELECT id, name, system_instruction, created_at, updated_at FROM pets WHERE COALESCE(is_deleted,0) = 0`,
).all();
console.log(`  Tauri: ${tauriPets.length} pet(s)`);

const { listPets, createPet, updatePet, deletePet } = await import('../src/config.ts');
const existingPets = await listPets();
const existingPetIds = new Set(existingPets.map(p => p.id));

const petPlan = tauriPets.map(p => ({
  id: p.id,
  name: p.name,
  persona: p.system_instruction || '',
  exists: existingPetIds.has(p.id),
}));
for (const p of petPlan) {
  console.log(`  ${p.exists ? '⚠️ DUP' : '   NEW'}  ${p.id.slice(0, 8)}…  ${p.name}${p.persona ? '  (persona ' + p.persona.length + ' chars)' : ''}`);
}

if (COMMIT) {
  for (const p of petPlan) {
    if (p.exists && !REPLACE) continue;
    if (p.exists && REPLACE) {
      // delete + recreate keeps id stable via the underlying createPet uuid?
      // No — createPet generates a new uuid. We need a direct write to keep id.
      // Easier: if dup, delete then we'll lose history; for now skip with warning.
      console.log(`  (skipping ${p.name} — id-stable replace not supported via CRUD; delete via API to retry)`);
      continue;
    }
    // createPet generates a new uuid — but we want to preserve Tauri's id so
    // SocialConfig.petId references stay valid. Direct file write below.
  }
  // Direct write to keep ids stable
  await directWritePets(petPlan, REPLACE);
}

// ─── 2. API Providers ───
console.log('\n═══ API Providers ═══');
const tauriProviders = db.query<any, []>(
  `SELECT id, name, base_url, api_key, api_format, cached_models, created_at, updated_at FROM api_providers`,
).all();
console.log(`  Tauri: ${tauriProviders.length} provider(s)`);

const { listProviders } = await import('../src/providers.ts');
const existingProviders = await listProviders();
const existingProviderIds = new Set(existingProviders.map(p => p.id));

const providerPlan = tauriProviders.map(p => {
  const cachedModels = parseJson<string[]>(p.cached_models, []);
  return {
    id: p.id,
    name: p.name,
    type: mapApiFormat(p.api_format),
    baseUrl: p.base_url,
    apiKey: p.api_key,
    cachedModels,
    apiFormat: p.api_format,
    exists: existingProviderIds.has(p.id),
  };
});
for (const p of providerPlan) {
  const keyPreview = p.apiKey ? `${p.apiKey.slice(0, 4)}…${p.apiKey.slice(-4)}` : '(empty)';
  console.log(`  ${p.exists ? '⚠️ DUP' : '   NEW'}  ${p.id.slice(0, 8)}…  ${p.name.padEnd(30)} ${p.apiFormat.padEnd(20)} ${p.baseUrl.padEnd(40)} key=${keyPreview} models=${p.cachedModels.length}`);
}

if (COMMIT) {
  await directWriteProviders(providerPlan, REPLACE);
}

// ─── 3. MCP Servers ───
console.log('\n═══ MCP Servers ═══');
const tauriMcp = db.query<any, []>(
  `SELECT id, name, transport, command, args, env, auto_start, created_at, updated_at FROM mcp_servers`,
).all();
console.log(`  Tauri: ${tauriMcp.length} server(s)`);

const { listMCPServers } = await import('../src/mcpServers.ts');
const existingMcp = await listMCPServers();
const existingMcpIds = new Set(existingMcp.map(s => s.id));
const existingMcpNames = new Set(existingMcp.map(s => s.name));

const mcpPlan = tauriMcp.map(s => ({
  id: s.id,
  name: s.name,
  transport: s.transport || 'stdio',
  command: s.command || '',
  args: parseJson<string[]>(s.args, []),
  env:  parseJson<Record<string, string>>(s.env, {}),
  enabled: !!s.auto_start,
  exists: existingMcpIds.has(s.id),
  nameTaken: existingMcpNames.has(s.name) && !existingMcpIds.has(s.id),
  unsupported: (s.transport || 'stdio') !== 'stdio',
}));
for (const s of mcpPlan) {
  const flag = s.unsupported ? '⛔ HTTP'
             : s.exists       ? '⚠️ DUP'
             : s.nameTaken    ? '⚠️ NAME-CLASH'
             : '   NEW';
  console.log(`  ${flag}  ${s.id.slice(0, 8)}…  ${s.name.padEnd(20)} ${s.transport.padEnd(8)} ${s.command || '—'} ${s.args.slice(0, 2).join(' ')}${s.args.length > 2 ? '…' : ''}  enabled=${s.enabled}`);
}

if (COMMIT) {
  await directWriteMcp(mcpPlan, REPLACE);
}

console.log('\n──────────');
if (!COMMIT) {
  console.log('Dry-run complete. Re-run with --commit to apply (add --replace to overwrite duplicates).');
} else {
  console.log('✓ Migration committed.');
}
db.close();

// ───────────────────────────────────────────────────────────
// Direct-write helpers — preserve Tauri ids by writing JSON
// stores directly (CRUD APIs would assign fresh uuids).
// ───────────────────────────────────────────────────────────

async function directWritePets(plan: typeof petPlan, replace: boolean) {
  const path = join(home, 'pets.json');
  const { readFile, writeFile, rename, chmod, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { existsSync } = await import('node:fs');
  let store: { pets: Array<{ id: string; name: string; persona?: string; createdAt: number; updatedAt: number }> } = { pets: [] };
  if (existsSync(path)) {
    try { store = JSON.parse(await readFile(path, 'utf8')); } catch { /* keep empty */ }
  }
  const now = Date.now();
  for (const p of plan) {
    const idx = store.pets.findIndex(x => x.id === p.id);
    if (idx >= 0 && !replace) continue;
    const entry = { id: p.id, name: p.name, persona: p.persona || undefined, createdAt: idx >= 0 ? store.pets[idx].createdAt : now, updatedAt: now };
    if (idx >= 0) store.pets[idx] = entry;
    else store.pets.push(entry);
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function directWriteProviders(plan: typeof providerPlan, replace: boolean) {
  const path = join(home, 'providers.json');
  const { readFile, writeFile, rename, chmod, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { existsSync } = await import('node:fs');
  let store: { providers: any[] } = { providers: [] };
  if (existsSync(path)) {
    try { store = JSON.parse(await readFile(path, 'utf8')); } catch { /* keep empty */ }
  }
  const now = Date.now();
  for (const p of plan) {
    const idx = store.providers.findIndex(x => x.id === p.id);
    if (idx >= 0 && !replace) continue;
    const entry = {
      id: p.id,
      type: p.type,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      cachedModels: p.cachedModels.length > 0 ? p.cachedModels : undefined,
      cachedModelsAt: p.cachedModels.length > 0 ? now : undefined,
      defaultModel: undefined,
      createdAt: idx >= 0 ? store.providers[idx].createdAt : now,
      updatedAt: now,
    };
    if (idx >= 0) store.providers[idx] = entry;
    else store.providers.push(entry);
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function directWriteMcp(plan: typeof mcpPlan, replace: boolean) {
  const path = join(home, 'mcp-servers.json');
  const { readFile, writeFile, rename, chmod, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { existsSync } = await import('node:fs');
  let store: { servers: any[] } = { servers: [] };
  if (existsSync(path)) {
    try { store = JSON.parse(await readFile(path, 'utf8')); } catch { /* keep empty */ }
  }
  const now = Date.now();
  let skippedHttp = 0, skippedNameClash = 0;
  for (const s of plan) {
    if (s.unsupported) { skippedHttp++; continue; }     // HTTP transport not yet supported
    if (s.nameTaken)   { skippedNameClash++; continue; }
    const idx = store.servers.findIndex(x => x.id === s.id);
    if (idx >= 0 && !replace) continue;
    const entry = {
      id: s.id,
      name: s.name,
      command: s.command,
      args: s.args,
      env: s.env,
      enabled: s.enabled,
      createdAt: idx >= 0 ? store.servers[idx].createdAt : now,
      updatedAt: now,
    };
    if (idx >= 0) store.servers[idx] = entry;
    else store.servers.push(entry);
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  if (skippedHttp > 0)      console.log(`  (skipped ${skippedHttp} HTTP-transport server(s) — only stdio supported)`);
  if (skippedNameClash > 0) console.log(`  (skipped ${skippedNameClash} server(s) with name-clash — rename existing first)`);
}
