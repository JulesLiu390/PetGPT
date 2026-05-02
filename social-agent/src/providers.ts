import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths } from './paths.ts';

/**
 * Plaintext provider store.
 *
 * Same posture as ~/.aws/credentials, ~/.kube/config, ~/.npmrc, ~/.gitconfig:
 * a plain JSON file with mode 0600. Security relies on FS permissions + user
 * account isolation + (optionally) full-disk encryption.
 *
 * No master password, no unlock flow.
 */

export interface Provider {
  id: string;
  type: 'openai-compat' | 'anthropic' | 'gemini';
  name: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey: string;          // sensitive — never returned by listProviders/getProvider
  createdAt: number;
  updatedAt: number;
}

interface ProvidersData {
  providers: Provider[];
}

const EMPTY: ProvidersData = { providers: [] };

const paths = getPaths();

// ─────────────────── disk I/O ───────────────────

async function load(): Promise<ProvidersData> {
  if (!existsSync(paths.providers)) return structuredClone(EMPTY);
  try {
    const text = await readFile(paths.providers, 'utf8');
    const parsed = JSON.parse(text) as ProvidersData;
    if (!Array.isArray(parsed.providers)) return structuredClone(EMPTY);
    return parsed;
  } catch {
    return structuredClone(EMPTY);
  }
}

async function save(data: ProvidersData): Promise<void> {
  mkdirSync(dirname(paths.providers), { recursive: true });
  const tmp = `${paths.providers}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, paths.providers);
}

// ─────────────────── public API ───────────────────

export type ProviderPublic = Omit<Provider, 'apiKey'> & { apiKeyMasked: string };

function maskApiKey(k: string): string {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function toPublic(p: Provider): ProviderPublic {
  const { apiKey, ...rest } = p;
  return { ...rest, apiKeyMasked: maskApiKey(apiKey) };
}

export async function listProviders(): Promise<ProviderPublic[]> {
  const { providers } = await load();
  return providers.map(toPublic);
}

export async function getProvider(id: string): Promise<ProviderPublic | undefined> {
  const { providers } = await load();
  const p = providers.find(x => x.id === id);
  return p ? toPublic(p) : undefined;
}

/** Internal — full record incl. apiKey. Only the LLM dispatcher should use this. */
export async function getProviderInternal(id: string): Promise<Provider | undefined> {
  const { providers } = await load();
  return providers.find(x => x.id === id);
}

export async function createProvider(input: {
  type: Provider['type'];
  name: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey: string;
}): Promise<ProviderPublic> {
  if (!input.apiKey) throw new Error('apiKey required');
  const data = await load();
  const now = Date.now();
  const p: Provider = {
    id: randomUUID(),
    type: input.type,
    name: input.name,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    apiKey: input.apiKey,
    createdAt: now,
    updatedAt: now,
  };
  data.providers.push(p);
  await save(data);
  return toPublic(p);
}

export async function updateProvider(
  id: string,
  partial: Partial<Pick<Provider, 'type' | 'name' | 'baseUrl' | 'defaultModel' | 'apiKey'>>,
): Promise<ProviderPublic | null> {
  const data = await load();
  const idx = data.providers.findIndex(p => p.id === id);
  if (idx < 0) return null;
  const cur = data.providers[idx];
  data.providers[idx] = {
    ...cur,
    ...partial,
    id: cur.id,
    createdAt: cur.createdAt,
    updatedAt: Date.now(),
  };
  await save(data);
  return toPublic(data.providers[idx]);
}

export async function deleteProvider(id: string): Promise<boolean> {
  const data = await load();
  const before = data.providers.length;
  data.providers = data.providers.filter(p => p.id !== id);
  if (data.providers.length === before) return false;
  await save(data);
  return true;
}
