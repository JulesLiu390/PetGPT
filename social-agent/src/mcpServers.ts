import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths } from './paths.ts';

/**
 * MCP server registry.
 *
 * Mirrors Tauri's MCP server config shape (command + args + env).
 * `name` is the user-facing identifier referenced by SocialConfig.mcpServerName,
 * so it must be unique across the registry.
 *
 * Lifecycle (start/stop, status, tool dispatch) lives in the platform.mcp
 * adapter and Phase 5; this module only handles persisted configuration.
 *
 * Persisted at ~/.social-agent/mcp-servers.json (mode 0600).
 */

export interface MCPServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface MCPServersData { servers: MCPServer[]; }

const EMPTY: MCPServersData = { servers: [] };
const paths = getPaths();

// ─────────────────── disk I/O ───────────────────

async function load(): Promise<MCPServersData> {
  if (!existsSync(paths.mcpServers)) return structuredClone(EMPTY);
  try {
    const text = await readFile(paths.mcpServers, 'utf8');
    const parsed = JSON.parse(text) as MCPServersData;
    if (!Array.isArray(parsed.servers)) return structuredClone(EMPTY);
    return parsed;
  } catch {
    return structuredClone(EMPTY);
  }
}

async function save(data: MCPServersData): Promise<void> {
  mkdirSync(dirname(paths.mcpServers), { recursive: true });
  const tmp = `${paths.mcpServers}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, paths.mcpServers);
}

// ─────────────────── public API ───────────────────

export async function listMCPServers(): Promise<MCPServer[]> {
  const { servers } = await load();
  return servers;
}

export async function getMCPServer(id: string): Promise<MCPServer | undefined> {
  const { servers } = await load();
  return servers.find(s => s.id === id);
}

export async function getMCPServerByName(name: string): Promise<MCPServer | undefined> {
  const { servers } = await load();
  return servers.find(s => s.name === name);
}

export interface MCPServerCreateInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export async function createMCPServer(input: MCPServerCreateInput): Promise<MCPServer> {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');
  if (!input.command.trim()) throw new Error('command is required');

  const data = await load();
  if (data.servers.some(s => s.name === name)) {
    throw new Error(`MCP server name already exists: ${name}`);
  }

  const now = Date.now();
  const server: MCPServer = {
    id: randomUUID(),
    name,
    command: input.command.trim(),
    args: Array.isArray(input.args) ? input.args : [],
    env: input.env && typeof input.env === 'object' ? input.env : {},
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  data.servers.push(server);
  await save(data);
  return server;
}

export async function updateMCPServer(
  id: string,
  partial: Partial<Pick<MCPServer, 'name' | 'command' | 'args' | 'env' | 'enabled'>>,
): Promise<MCPServer | null> {
  const data = await load();
  const idx = data.servers.findIndex(s => s.id === id);
  if (idx < 0) return null;
  const cur = data.servers[idx];

  if (partial.name !== undefined) {
    const newName = String(partial.name).trim();
    if (!newName) throw new Error('name cannot be empty');
    if (newName !== cur.name && data.servers.some(s => s.name === newName)) {
      throw new Error(`MCP server name already exists: ${newName}`);
    }
  }

  data.servers[idx] = {
    ...cur,
    ...(partial.name     !== undefined ? { name: String(partial.name).trim() } : {}),
    ...(partial.command  !== undefined ? { command: String(partial.command).trim() } : {}),
    ...(partial.args     !== undefined ? { args: Array.isArray(partial.args) ? partial.args : [] } : {}),
    ...(partial.env      !== undefined ? { env: typeof partial.env === 'object' && partial.env !== null ? partial.env : {} } : {}),
    ...(partial.enabled  !== undefined ? { enabled: !!partial.enabled } : {}),
    updatedAt: Date.now(),
  };
  await save(data);
  return data.servers[idx];
}

export async function deleteMCPServer(id: string): Promise<boolean> {
  const data = await load();
  const before = data.servers.length;
  data.servers = data.servers.filter(s => s.id !== id);
  if (data.servers.length === before) return false;
  await save(data);
  return true;
}
