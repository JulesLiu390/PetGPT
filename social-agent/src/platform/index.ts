import { join } from 'node:path';
import type { Platform } from './types.ts';
import { nodeFS } from './node-fs.ts';
import { createNodeWorkspace } from './node-workspace.ts';
import { nodeHTTP } from './node-http.ts';
import { createNodeEvents } from './node-events.ts';
import { nodeMCPStub } from './node-mcp.ts';
import { resolveHome } from '../paths.ts';

export type { Platform } from './types.ts';
export type {
  PlatformFS, PlatformWorkspace, PlatformHTTP, PlatformEvents, PlatformMCP,
  HTTPRequest, HTTPResponse, FileStat, MCPToolDescriptor, EventHandler,
} from './types.ts';

/**
 * Build a Platform backed by Node/Bun primitives.
 *
 * @param home  Override for the home directory. Defaults to {@link resolveHome}.
 */
export function createNodePlatform(home: string = resolveHome()): Platform {
  return {
    fs: nodeFS,
    workspace: createNodeWorkspace(nodeFS, home),
    http: nodeHTTP,
    events: createNodeEvents(),
    mcp: nodeMCPStub,
    paths: {
      home,
      petWorkspace(petId: string) {
        return join(home, 'pets', petId, 'workspace');
      },
    },
  };
}
