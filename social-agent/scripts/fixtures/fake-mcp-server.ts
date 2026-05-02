/**
 * Fake MCP server for smoke tests. Spawned as a child of the test harness
 * over stdio. Implements 2 tools:
 *   echo({ msg })        → echoes msg as a text content block
 *   throw_oops({})       → returns isError content for error-path coverage
 *
 * Run directly:  bun run scripts/fixtures/fake-mcp-server.ts
 * (intended invocation is via spawn, not standalone use.)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fake-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'echoes the input message',
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
    },
    {
      name: 'throw_oops',
      description: 'always returns an error (for error-path tests)',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'echo') {
    const msg = String((args as any)?.msg ?? '');
    return { content: [{ type: 'text', text: `echoed: ${msg}` }] };
  }
  if (name === 'throw_oops') {
    return { content: [{ type: 'text', text: 'intentional failure' }], isError: true };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
