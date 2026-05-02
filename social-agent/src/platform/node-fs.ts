import {
  readFile, writeFile, appendFile, rename, unlink,
  mkdir, readdir, stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PlatformFS, FileStat } from './types.ts';

async function ensureParent(path: string): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

export const nodeFS: PlatformFS = {
  async read(path) {
    return await readFile(path, 'utf8');
  },

  async readBuffer(path) {
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },

  async write(path, content) {
    await ensureParent(path);
    await writeFile(path, content);
  },

  async writeAtomic(path, content) {
    await ensureParent(path);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, content);
    await rename(tmp, path);
  },

  async append(path, content) {
    await ensureParent(path);
    await appendFile(path, content);
  },

  async exists(path) {
    return existsSync(path);
  },

  async mkdir(path, recursive = true) {
    await mkdir(path, { recursive });
  },

  async readdir(path) {
    return await readdir(path);
  },

  async unlink(path) {
    if (existsSync(path)) await unlink(path);
  },

  async rename(from, to) {
    await rename(from, to);
  },

  async stat(path): Promise<FileStat | null> {
    if (!existsSync(path)) return null;
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
  },
};
