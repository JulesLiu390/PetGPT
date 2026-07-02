import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Resolve the social-agent home directory.
 *
 * Precedence:
 *  1. $SOCIAL_AGENT_HOME — explicit override (highest)
 *  2. macOS:   ~/.social-agent          (mirroring Claude Code's ~/.claude)
 *  3. Linux:   $XDG_CONFIG_HOME/social-agent  or  ~/.config/social-agent
 *  4. Windows: %APPDATA%\social-agent
 */
export function resolveHome(): string {
  const override = process.env.SOCIAL_AGENT_HOME;
  if (override && override.trim().length > 0) return override;

  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, '.social-agent');
    case 'linux': {
      const xdg = process.env.XDG_CONFIG_HOME;
      return xdg ? join(xdg, 'social-agent') : join(home, '.config', 'social-agent');
    }
    case 'win32': {
      const appData = process.env.APPDATA;
      return appData ? join(appData, 'social-agent') : join(home, 'social-agent');
    }
    default:
      return join(home, '.social-agent');
  }
}

export interface Paths {
  home: string;
  settings: string;
  settingsLocal: string;
  providers: string;       // plaintext JSON, file mode 0600
  petsRegistry: string;    // pets.json — list of pets (name / persona / id)
  mcpServers: string;
  petsDir: string;         // pets/ — per-pet runtime state (workspace, training, ...)
  cache: string;
  logs: string;
  debug: string;
}

/** Build the well-known paths under the home directory (does not create them). */
export function getPaths(home = resolveHome()): Paths {
  return {
    home,
    settings:      join(home, 'settings.json'),
    settingsLocal: join(home, 'settings.local.json'),
    providers:     join(home, 'providers.json'),
    petsRegistry:  join(home, 'pets.json'),
    mcpServers:    join(home, 'mcp-servers.json'),
    petsDir:       join(home, 'pets'),
    cache:         join(home, 'cache'),
    logs:          join(home, 'logs'),
    debug:         join(home, 'debug'),
  };
}

/** Per-pet paths under {home}/pets/{petId}/. */
export function getPetPaths(petId: string, home = resolveHome()) {
  const root = join(home, 'pets', petId);
  return {
    root,
    socialConfig: join(root, 'social-config.json'),
    workspace:    join(root, 'workspace'),
    social:       join(root, 'workspace', 'social'),
    training:     join(root, 'training'),
    images:       join(root, 'images'),
    logs:         join(root, 'logs'),
  };
}

/** Create the home directory tree if missing. Idempotent. */
export function ensureHome(home = resolveHome()): Paths {
  const paths = getPaths(home);
  for (const dir of [paths.home, paths.petsDir, paths.cache, paths.logs, paths.debug]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return paths;
}
