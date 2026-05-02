import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { PlatformMCP, MCPToolDescriptor } from './types.ts';
import type { MCPServer } from '../mcpServers.ts';

/**
 * Throwing stub used when no real MCP backend is wired. Test harnesses
 * that don't exercise MCP functionality can keep this default.
 */
export const nodeMCPStub: PlatformMCP = {
  async ensureRunning(name: string): Promise<void> {
    throw new Error(`MCP not configured (server=${name}) — provide mcpLookup to createNodePlatform`);
  },
  async listTools(name: string): Promise<MCPToolDescriptor[]> {
    throw new Error(`MCP not configured (server=${name})`);
  },
  async callTool(name: string, tool: string): Promise<unknown> {
    throw new Error(`MCP not configured (server=${name}, tool=${tool})`);
  },
  async shutdown(): Promise<void> { /* nothing to shut down */ },
  status(_name: string) { return 'stopped' as const; },
  running() { return [] as string[]; },
};

/**
 * Real MCP implementation backed by `@modelcontextprotocol/sdk`.
 *
 * Each call to ensureRunning(name) lazily spawns the configured child
 * process and connects an MCP Client over stdio. The connection is kept
 * warm — subsequent listTools / callTool reuse it. shutdown() closes
 * gracefully (terminates the child).
 *
 * Concurrent ensureRunning() calls for the same server are deduped via
 * an in-flight promise map, so racing handlers don't spawn duplicates.
 */

export interface NodeMCPOptions {
  /** Look up an MCP server config record by its `name` field. */
  lookup: (name: string) => Promise<MCPServer | undefined>;
  /** Identifying string sent to the server during the MCP handshake. */
  clientName?: string;
  clientVersion?: string;
}

interface ManagedClient {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
  startedAt: number;
}

export function createNodeMCP(opts: NodeMCPOptions): PlatformMCP {
  const clients = new Map<string, ManagedClient>();
  const inFlight = new Map<string, Promise<void>>();

  async function spawnAndConnect(serverName: string): Promise<void> {
    const cfg = await opts.lookup(serverName);
    if (!cfg) throw new Error(`MCP server config not found: ${serverName}`);
    if (!cfg.enabled) throw new Error(`MCP server is disabled: ${serverName}`);
    if (!cfg.command) throw new Error(`MCP server missing command: ${serverName}`);

    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env as Record<string, string>, ...cfg.env },
    });

    const client = new Client(
      { name: opts.clientName ?? 'social-agent', version: opts.clientVersion ?? '0.0.1' },
      { capabilities: {} },
    );

    await client.connect(transport);
    clients.set(serverName, { serverName, client, transport, startedAt: Date.now() });
  }

  async function ensureRunning(serverName: string): Promise<void> {
    if (clients.has(serverName)) return;
    const pending = inFlight.get(serverName);
    if (pending) return pending;
    const p = spawnAndConnect(serverName).finally(() => {
      inFlight.delete(serverName);
    });
    inFlight.set(serverName, p);
    return p;
  }

  return {
    ensureRunning,

    async listTools(serverName: string): Promise<MCPToolDescriptor[]> {
      await ensureRunning(serverName);
      const c = clients.get(serverName)!;
      const r = await c.client.listTools();
      return (r.tools ?? []).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as unknown,
      }));
    },

    async callTool(serverName: string, toolName: string, args: unknown): Promise<unknown> {
      await ensureRunning(serverName);
      const c = clients.get(serverName)!;
      const r = await c.client.callTool({
        name: toolName,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      return r;
    },

    async shutdown(serverName?: string): Promise<void> {
      if (serverName) {
        const c = clients.get(serverName);
        if (!c) return;
        clients.delete(serverName);
        try { await c.client.close(); } catch { /* swallow during teardown */ }
        return;
      }
      const all = Array.from(clients.values());
      clients.clear();
      await Promise.allSettled(all.map(c => c.client.close()));
    },

    status(name: string) {
      return clients.has(name) ? 'running' : 'stopped';
    },

    running(): string[] {
      return Array.from(clients.keys());
    },
  };
}
