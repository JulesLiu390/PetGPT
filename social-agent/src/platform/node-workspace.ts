import { join, normalize, relative, sep } from 'node:path';
import type { PlatformFS, PlatformWorkspace } from './types.ts';

/**
 * Build the workspace adapter for a given home directory.
 *
 * Resolves `petId` + `relPath` to absolute paths under
 * `{home}/pets/{petId}/workspace/`, with strict containment checks so a
 * malicious `relPath` (`"../../../etc/passwd"`) cannot escape the pet dir.
 */
export function createNodeWorkspace(fs: PlatformFS, home: string): PlatformWorkspace {
  const petWorkspaceRoot = (petId: string) => join(home, 'pets', petId, 'workspace');

  const resolve = (petId: string, relPath: string): string => {
    if (!petId || /[\\/]/.test(petId)) throw new Error(`invalid petId: ${petId}`);
    const root = petWorkspaceRoot(petId);
    const abs = normalize(join(root, relPath));
    const r = relative(root, abs);
    if (r.startsWith('..') || (r !== '' && r.split(sep)[0] === '..')) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return abs;
  };

  return {
    read(petId, relPath)         { return fs.read(resolve(petId, relPath)); },
    write(petId, relPath, c)     { return fs.writeAtomic(resolve(petId, relPath), c); },
    exists(petId, relPath)       { return fs.exists(resolve(petId, relPath)); },
    list(petId, relPath)         { return fs.readdir(resolve(petId, relPath)); },
    unlink(petId, relPath)       { return fs.unlink(resolve(petId, relPath)); },
    absolute(petId, relPath)     { return resolve(petId, relPath); },
  };
}
