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

export type ProviderType = 'openai-compat' | 'anthropic' | 'gemini';

/** Tauri-side `apiFormat` aliases. Read-only mirror derived from `type`. */
export type ProviderApiFormat = 'openai_compatible' | 'anthropic_native' | 'gemini_official';

export function apiFormatOf(t: ProviderType): ProviderApiFormat {
  switch (t) {
    case 'openai-compat': return 'openai_compatible';
    case 'anthropic':     return 'anthropic_native';
    case 'gemini':        return 'gemini_official';
  }
}

/** Inverse: accept Tauri-style format strings when ingesting external configs. */
export function typeFromApiFormat(f: string): ProviderType | null {
  switch (f) {
    case 'openai_compatible':
    case 'openai-compat':       return 'openai-compat';
    case 'anthropic_native':
    case 'anthropic':           return 'anthropic';
    case 'gemini_official':
    case 'gemini':              return 'gemini';
    default:                    return null;
  }
}

export interface Provider {
  id: string;
  type: ProviderType;
  name: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey: string;          // sensitive — never returned by listProviders/getProvider
  /** Last-fetched model id list. Populated by POST /api/providers/:id/fetch-models. */
  cachedModels?: string[];
  cachedModelsAt?: number; // epoch ms
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

export type ProviderPublic = Omit<Provider, 'apiKey'> & {
  apiKeyMasked: string;
  /** Tauri-style alias of `type`, surfaced read-only for UI labels. */
  apiFormat: ProviderApiFormat;
};

function maskApiKey(k: string): string {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function toPublic(p: Provider): ProviderPublic {
  const { apiKey, ...rest } = p;
  return { ...rest, apiKeyMasked: maskApiKey(apiKey), apiFormat: apiFormatOf(p.type) };
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

/**
 * System-write to update the cached model list after a successful fetch.
 * Bypasses regular update path because this is provider metadata, not a user
 * edit — keeps `updatedAt` for UI freshness semantics.
 */
export async function setCachedModels(id: string, models: string[]): Promise<ProviderPublic | null> {
  const data = await load();
  const idx = data.providers.findIndex(p => p.id === id);
  if (idx < 0) return null;
  const cur = data.providers[idx];
  data.providers[idx] = {
    ...cur,
    cachedModels: models,
    cachedModelsAt: Date.now(),
    updatedAt: Date.now(),
  };
  await save(data);
  return toPublic(data.providers[idx]);
}
