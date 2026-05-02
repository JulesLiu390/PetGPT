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
    {
      name: 'fetch_messages',
      description: 'simulated message fetcher for Phase 5d smoke tests',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          target_type: { type: 'string' },
          since: { type: 'string' },
        },
      },
    },
    {
      name: 'send_message',
      description: 'simulated send for Phase 5c — echoes the payload',
      inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    },
  ],
}));

// Stateful counter so each fetch_messages call returns a fresh batch.
// The fixture is a child process with its own state per spawn.
const FAKE_MESSAGES: Array<{ id: string; sender_id: string; sender_name: string; content: string; timestamp: string }> = [
  { id: 'm1', sender_id: '1001', sender_name: 'Alice', content: 'hello world',          timestamp: '14:00:01' },
  { id: 'm2', sender_id: '1002', sender_name: 'Bob',   content: 'how are things?',      timestamp: '14:00:30' },
  { id: 'm3', sender_id: '1001', sender_name: 'Alice', content: 'just shipped Phase 5', timestamp: '14:01:05' },
  { id: 'm4', sender_id: '1003', sender_name: 'Carol', content: '🎉',                    timestamp: '14:01:30' },
];

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'echo') {
    const msg = String((args as any)?.msg ?? '');
    return { content: [{ type: 'text', text: `echoed: ${msg}` }] };
  }
  if (name === 'throw_oops') {
    return { content: [{ type: 'text', text: 'intentional failure' }], isError: true };
  }
  if (name === 'fetch_messages') {
    // Emit messages strictly newer than `since` (or all if no since).
    const since = (args as any)?.since;
    const idx = since ? FAKE_MESSAGES.findIndex(m => m.id === since) : -1;
    const fresh = FAKE_MESSAGES.slice(idx + 1);
    return { content: [{ type: 'text', text: JSON.stringify({ messages: fresh }) }] };
  }
  if (name === 'send_message') {
    const content = String((args as any)?.content ?? '');
    return { content: [{ type: 'text', text: `sent: ${content}` }] };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
