import { join } from 'node:path';
import type { Platform, PlatformMCP } from './types.ts';
import { nodeFS } from './node-fs.ts';
import { createNodeWorkspace } from './node-workspace.ts';
import { nodeHTTP } from './node-http.ts';
import { createNodeEvents } from './node-events.ts';
import { nodeMCPStub, createNodeMCP } from './node-mcp.ts';
import { resolveHome } from '../paths.ts';
import type { MCPServer } from '../mcpServers.ts';

export type { Platform } from './types.ts';
export type {
  PlatformFS, PlatformWorkspace, PlatformHTTP, PlatformEvents, PlatformMCP,
  HTTPRequest, HTTPResponse, FileStat, MCPToolDescriptor, EventHandler,
} from './types.ts';

export interface CreateNodePlatformOptions {
  /** Override the home directory. Defaults to resolveHome(). */
  home?: string;
  /** Look up an MCP server config by `name`. When supplied, the platform's
   *  mcp adapter will spawn real child processes via @modelcontextprotocol/sdk.
   *  When omitted, mcp.* throws "MCP not configured" — useful for tests that
   *  don't exercise MCP. */
  mcpLookup?: (name: string) => Promise<MCPServer | undefined>;
  /** Pre-built mcp adapter, takes precedence over mcpLookup. Used by tests. */
  mcp?: PlatformMCP;
}

/** Convenience: legacy positional signature supported. */
export function createNodePlatform(arg?: string | CreateNodePlatformOptions): Platform {
  const opts: CreateNodePlatformOptions = typeof arg === 'string' ? { home: arg } : (arg ?? {});
  const home = opts.home ?? resolveHome();
  const mcp: PlatformMCP =
    opts.mcp ??
    (opts.mcpLookup ? createNodeMCP({ lookup: opts.mcpLookup }) : nodeMCPStub);

  return {
    fs: nodeFS,
    workspace: createNodeWorkspace(nodeFS, home),
    http: nodeHTTP,
    events: createNodeEvents(),
    mcp,
    paths: {
      home,
      petWorkspace(petId: string) {
        return join(home, 'pets', petId, 'workspace');
      },
    },
  };
}
