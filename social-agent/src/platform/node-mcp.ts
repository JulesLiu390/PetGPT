import type { PlatformMCP, MCPToolDescriptor } from './types.ts';

/**
 * MCP stub.
 * Phase 4 will replace this with a real implementation built on
 * `@modelcontextprotocol/sdk`, capable of spawning stdio servers, reading
 * `mcp-servers.json`, and managing process lifecycle.
 *
 * For now any call throws so the core port (Phase 3) can compile and run
 * without MCP-dependent code paths active.
 */
export const nodeMCPStub: PlatformMCP = {
  async ensureRunning(serverName: string): Promise<void> {
    throw new Error(`MCP not implemented yet (server: ${serverName}) — pending Phase 4`);
  },
  async listTools(serverName: string): Promise<MCPToolDescriptor[]> {
    throw new Error(`MCP not implemented yet (server: ${serverName}) — pending Phase 4`);
  },
  async callTool(serverName: string, toolName: string): Promise<unknown> {
    throw new Error(`MCP not implemented yet (server=${serverName}, tool=${toolName}) — pending Phase 4`);
  },
  async shutdown(): Promise<void> {
    /* nothing to shut down */
  },
};
