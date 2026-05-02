import { scryptSync, randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getPaths } from './paths.ts';

/**
 * providers.enc layout
 *
 *   {
 *     v: 1,
 *     kdf: 'scrypt',
 *     N, r, p,
 *     salt:  base64,
 *     nonce: base64,
 *     ct:    base64,
 *     tag:   base64
 *   }
 *
 * Decryption authenticates via GCM tag — that *is* the password verifier.
 * No separate password hash is stored.
 */

const SCRYPT_N = 1 << 14;   // ~50ms on a modern Mac, comfortable for interactive unlock
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;       // 96-bit nonce required by GCM

interface EncryptedFile {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
  ct: string;
  tag: string;
}

export interface Provider {
  id: string;
  type: 'openai-compat' | 'anthropic' | 'gemini';
  name: string;            // display label
  baseUrl?: string;
  defaultModel?: string;
  apiKey: string;          // sensitive — never returned in API responses
  createdAt: number;
  updatedAt: number;
}

interface ProvidersData {
  providers: Provider[];
}

const EMPTY: ProvidersData = { providers: [] };

const paths = getPaths();

// ─────────────────── in-memory unlocked state ───────────────────

let unlockedKey: Buffer | null = null;
let unlockedSalt: Buffer | null = null;
let cached: ProvidersData | null = null;

// ─────────────────── crypto helpers ───────────────────

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function encrypt(plaintext: Buffer, key: Buffer) {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ct, tag };
}

function decrypt(ct: Buffer, key: Buffer, nonce: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ─────────────────── disk I/O ───────────────────

async function readEncryptedFile(): Promise<EncryptedFile | null> {
  if (!existsSync(paths.providers)) return null;
  const text = await readFile(paths.providers, 'utf8');
  return JSON.parse(text) as EncryptedFile;
}

async function persist(data: ProvidersData, key: Buffer, salt: Buffer): Promise<void> {
  const { nonce, ct, tag } = encrypt(Buffer.from(JSON.stringify(data)), key);
  const file: EncryptedFile = {
    v: 1,
    kdf: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
  mkdirSync(dirname(paths.providers), { recursive: true });
  const tmp = `${paths.providers}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(file), 'utf8');
  await rename(tmp, paths.providers);
}

// ─────────────────── public API ───────────────────

export function isUnlocked(): boolean {
  return unlockedKey !== null;
}

export function isInitialized(): boolean {
  return existsSync(paths.providers);
}

/**
 * Unlock with a master password.
 * - First call (file missing) → initializes the store with this password.
 * - Subsequent calls → derives key, attempts decrypt; throws on wrong password.
 *
 * After success, providers can be read/written until {@link lock}().
 */
export async function unlock(password: string): Promise<{ created: boolean }> {
  if (!password || password.length < 4) {
    throw new Error('master password too short (min 4 chars)');
  }
  const file = await readEncryptedFile();
  if (!file) {
    // first-time setup
    const salt = randomBytes(SALT_LEN);
    const key = deriveKey(password, salt);
    await persist(EMPTY, key, salt);
    unlockedKey = key;
    unlockedSalt = salt;
    cached = structuredClone(EMPTY);
    return { created: true };
  }
  // existing file → use file's stored salt + KDF params (allows future rotation)
  const salt = Buffer.from(file.salt, 'base64');
  const key = scryptSync(password, salt, KEY_LEN, { N: file.N, r: file.r, p: file.p });
  let pt: Buffer;
  try {
    pt = decrypt(
      Buffer.from(file.ct, 'base64'),
      key,
      Buffer.from(file.nonce, 'base64'),
      Buffer.from(file.tag, 'base64'),
    );
  } catch {
    throw new Error('invalid master password');
  }
  cached = JSON.parse(pt.toString('utf8')) as ProvidersData;
  unlockedKey = key;
  unlockedSalt = salt;
  return { created: false };
}

/** Drop the unlocked key from memory. Subsequent reads/writes will fail. */
export function lock(): void {
  if (unlockedKey) unlockedKey.fill(0);
  unlockedKey = null;
  unlockedSalt = null;
  cached = null;
}

function requireUnlocked(): { key: Buffer; salt: Buffer; data: ProvidersData } {
  if (!unlockedKey || !unlockedSalt || !cached) {
    throw new Error('locked');
  }
  return { key: unlockedKey, salt: unlockedSalt, data: cached };
}

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

/** List providers — apiKey field is masked, never sent in clear. */
export async function listProviders(): Promise<ProviderPublic[]> {
  const { data } = requireUnlocked();
  return data.providers.map(toPublic);
}

export async function getProvider(id: string): Promise<ProviderPublic | undefined> {
  const { data } = requireUnlocked();
  const p = data.providers.find(x => x.id === id);
  return p ? toPublic(p) : undefined;
}

/** Internal — full record incl. apiKey. Used by LLM dispatcher (not by REST). */
export async function getProviderInternal(id: string): Promise<Provider | undefined> {
  const { data } = requireUnlocked();
  return data.providers.find(x => x.id === id);
}

export async function createProvider(input: {
  type: Provider['type'];
  name: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey: string;
}): Promise<ProviderPublic> {
  const { key, salt, data } = requireUnlocked();
  if (!input.apiKey) throw new Error('apiKey required');
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
  await persist(data, key, salt);
  return toPublic(p);
}

export async function updateProvider(
  id: string,
  partial: Partial<Pick<Provider, 'type' | 'name' | 'baseUrl' | 'defaultModel' | 'apiKey'>>,
): Promise<ProviderPublic | null> {
  const { key, salt, data } = requireUnlocked();
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
  await persist(data, key, salt);
  return toPublic(data.providers[idx]);
}

export async function deleteProvider(id: string): Promise<boolean> {
  const { key, salt, data } = requireUnlocked();
  const before = data.providers.length;
  data.providers = data.providers.filter(p => p.id !== id);
  if (data.providers.length === before) return false;
  await persist(data, key, salt);
  return true;
}

/** Change the master password by re-encrypting everything with a new key. */
export async function changePassword(newPassword: string): Promise<void> {
  const { data } = requireUnlocked();
  if (!newPassword || newPassword.length < 4) {
    throw new Error('master password too short (min 4 chars)');
  }
  const newSalt = randomBytes(SALT_LEN);
  const newKey = deriveKey(newPassword, newSalt);
  await persist(data, newKey, newSalt);
  if (unlockedKey) unlockedKey.fill(0);
  unlockedKey = newKey;
  unlockedSalt = newSalt;
}
