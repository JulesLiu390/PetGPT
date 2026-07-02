import { readFile, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths } from './paths.ts';
import { withStoreLock } from './storeLock.ts';

const paths = getPaths();

// ─────────────────── generic JSON store ───────────────────

async function readJson<T>(path: string, defaultValue: T): Promise<T> {
  if (!existsSync(path)) return structuredClone(defaultValue);
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    // corrupt file — fall back to default rather than crash; user can repair manually
    return structuredClone(defaultValue);
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

// ─────────────────── settings.json ───────────────────

export interface Settings {
  port: number;
  logLevel: 'info' | 'warn' | 'error' | 'debug';
  defaultProviderId?: string;     // chosen LLM provider for new pets
  defaultModel?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 39066,
  logLevel: 'info',
};

export async function readSettings(): Promise<Settings> {
  const loaded = await readJson<Partial<Settings>>(paths.settings, {});
  // shallow merge with defaults so newly added fields get sane values
  return { ...DEFAULT_SETTINGS, ...loaded };
}

export async function writeSettings(next: Settings): Promise<void> {
  await writeJsonAtomic(paths.settings, next);
}

export async function patchSettings(partial: Partial<Settings>): Promise<Settings> {
  return withStoreLock(paths.settings, async () => {
    const current = await readSettings();
    const next: Settings = { ...current, ...partial };
    await writeSettings(next);
    return next;
  });
}

// ─────────────────── pets.json ───────────────────

export interface Pet {
  id: string;
  name: string;
  persona?: string;        // system prompt fragment describing personality
  createdAt: number;
  updatedAt: number;
}

interface PetsStore { pets: Pet[]; }

const DEFAULT_PETS: PetsStore = { pets: [] };

export async function listPets(): Promise<Pet[]> {
  const store = await readJson<PetsStore>(paths.petsRegistry, DEFAULT_PETS);
  return store.pets;
}

async function savePets(pets: Pet[]): Promise<void> {
  await writeJsonAtomic(paths.petsRegistry, { pets });
}

export async function getPet(id: string): Promise<Pet | undefined> {
  return (await listPets()).find(p => p.id === id);
}

export async function createPet(input: { name: string; persona?: string }): Promise<Pet> {
  return withStoreLock(paths.petsRegistry, async () => {
    const pets = await listPets();
    const now = Date.now();
    const pet: Pet = {
      id: randomUUID(),
      name: input.name.trim() || 'unnamed',
      persona: input.persona,
      createdAt: now,
      updatedAt: now,
    };
    pets.push(pet);
    await savePets(pets);
    return pet;
  });
}

export async function updatePet(id: string, partial: Partial<Omit<Pet, 'id' | 'createdAt'>>): Promise<Pet | null> {
  return withStoreLock(paths.petsRegistry, async () => {
    const pets = await listPets();
    const idx = pets.findIndex(p => p.id === id);
    if (idx < 0) return null;
    const next: Pet = { ...pets[idx], ...partial, id: pets[idx].id, createdAt: pets[idx].createdAt, updatedAt: Date.now() };
    pets[idx] = next;
    await savePets(pets);
    return next;
  });
}

export async function deletePet(id: string): Promise<boolean> {
  return withStoreLock(paths.petsRegistry, async () => {
    const pets = await listPets();
    const filtered = pets.filter(p => p.id !== id);
    if (filtered.length === pets.length) return false;
    await savePets(filtered);
    return true;
  });
}

/**
 * Cascade cleanup after deletePet: removes ~/.social-agent/pets/{id}
 * (social-config.json, workspace, training data, …). Callers must only
 * invoke this for ids that were actually in the registry — that gate is
 * what keeps arbitrary path segments out of the rm.
 */
export async function deletePetData(id: string): Promise<void> {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`suspicious pet id, refusing to delete data dir: ${id}`);
  }
  await rm(join(paths.petsDir, id), { recursive: true, force: true });
}
