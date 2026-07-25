import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const tool = (name, serverName = null) => ({
  name,
  serverName,
  description: `fixture ${name}`,
  inputSchema: { type: 'object', properties: {} },
});

const openAiToolCallResponse = calls => ({
  choices: [{
    message: {
      content: '',
      tool_calls: calls.map(({ id, name, args }) => ({
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args || {}) },
      })),
    },
    finish_reason: 'tool_calls',
  }],
});

const openAiDoneResponse = content => ({
  choices: [{
    message: { content },
    finish_reason: 'stop',
  }],
});

test('tool loops authorize every builtin and external tool from the per-turn declaration list', async () => {
  const previousWindow = globalThis.window;
  const invocations = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args = {}) => {
        invocations.push({ command, args: structuredClone(args) });
        if (command === 'get_mcp_servers') {
          return [
            { name: 'qq', maxIterations: 100 },
            { name: 'external', maxIterations: 100 },
          ];
        }
        if (command === 'mcp_get_all_tools') {
          return [{
            serverId: 'external-id',
            serverName: 'external',
            tool: {
              name: 'lookup',
              description: 'read-only lookup',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            },
          }];
        }
        if (command === 'workspace_delete_file') return 'deleted';
        if (command === 'workspace_read') {
          return '- id: 7\n  meaning: hello\n  file: hello.png\n  used: 0';
        }
        if (command === 'workspace_read_binary') return 'iVBORfixture';
        if (command === 'workspace_write') return 'written';
        if (command === 'get_mcp_server_by_name') return { _id: args.name };
        if (command === 'mcp_call_tool') {
          return {
            content: [{
              type: 'text',
              text: `called ${args.serverId}/${args.toolName}`,
            }],
          };
        }
        throw new Error(`Unexpected Tauri command in test: ${command}`);
      },
    },
  };

  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });

  try {
    const {
      callLLMWithTools,
      callLLMStreamWithTools,
      getMcpTools,
    } = await vite.ssrLoadModule('/src/utils/mcp/toolExecutor.js');

    const flattenedTools = await getMcpTools();
    assert.deepEqual(flattenedTools[0].annotations, { readOnlyHint: true });

    const calls = [
      {
        id: 'delete_call',
        name: 'social_delete',
        args: { path: 'social/scratch/reply-temp.md' },
      },
      {
        id: 'sticker_call',
        name: 'sticker_send',
        args: { sticker_id: 7 },
      },
      {
        id: 'external_call',
        name: 'external__lookup',
        args: { query: 'fixture' },
      },
    ];
    const context = {
      petId: 9,
      targetId: 'reply-target',
      targetType: 'group',
      mcpServerName: 'qq',
      sentCache: new Map(),
    };
    const sideEffectCommands = () => invocations.filter(({ command }) =>
      command === 'workspace_delete_file'
      || command === 'workspace_read'
      || command === 'workspace_read_binary'
      || command === 'workspace_write'
      || command === 'get_mcp_server_by_name'
      || command === 'mcp_call_tool');

    // A Reply turn with an empty tool list must not gain builtin permissions
    // merely because the hallucinated names are recognised by an executor.
    const rejectedRequests = [];
    const rejectedResponses = [
      openAiToolCallResponse(calls),
      openAiDoneResponse('rejected done'),
    ];
    const rejected = await callLLMWithTools({
      messages: [{ role: 'user', content: 'Reply fixture' }],
      apiFormat: 'openai_compatible',
      apiKey: 'fixture',
      model: 'fixture',
      baseUrl: 'https://example.invalid/v1',
      mcpTools: [],
      builtinToolContext: context,
      llmTransport: async (_endpoint, _headers, body) => {
        rejectedRequests.push(structuredClone(body));
        return rejectedResponses.shift();
      },
    });

    assert.equal(rejected.content, 'rejected done');
    assert.equal(sideEffectCommands().length, 0);
    assert.equal(rejected.toolCallHistory.length, 3);
    assert.ok(rejected.toolCallHistory.every(entry =>
      entry.result.includes('is not available in this turn')));
    const rejectedToolMessages = rejectedRequests[1].messages.filter(
      message => message.role === 'tool',
    );
    assert.deepEqual(
      rejectedToolMessages.map(message => message.tool_call_id),
      ['delete_call', 'sticker_call', 'external_call'],
    );

    // Declaring the exact same names authorizes their corresponding executors.
    const declaredResponses = [
      openAiToolCallResponse(calls),
      openAiDoneResponse('declared done'),
    ];
    const declared = await callLLMWithTools({
      messages: [{ role: 'user', content: 'Reply fixture' }],
      apiFormat: 'openai_compatible',
      apiKey: 'fixture',
      model: 'fixture',
      baseUrl: 'https://example.invalid/v1',
      mcpTools: [
        tool('social_delete'),
        tool('sticker_send'),
        tool('lookup', 'external'),
      ],
      builtinToolContext: context,
      llmTransport: async () => declaredResponses.shift(),
    });

    assert.equal(declared.content, 'declared done');
    assert.equal(declared.toolCallHistory.length, 3);
    assert.equal(
      invocations.filter(entry => entry.command === 'workspace_delete_file').length,
      1,
    );
    assert.equal(
      invocations.filter(entry =>
        entry.command === 'mcp_call_tool'
        && entry.args.serverId === 'qq'
        && entry.args.toolName === 'send_image').length,
      1,
    );
    assert.equal(
      invocations.filter(entry =>
        entry.command === 'mcp_call_tool'
        && entry.args.serverId === 'external'
        && entry.args.toolName === 'lookup').length,
      1,
    );

    // The streaming loop uses the same strict gate, preserves one result per
    // provider call, and places annotations only in the next model request.
    const beforeStreamSideEffects = sideEffectCommands().length;
    const streamRequests = [];
    let streamRound = 0;
    const streamed = await callLLMStreamWithTools({
      messages: [{ role: 'user', content: 'stream Reply fixture' }],
      apiFormat: 'openai_compatible',
      apiKey: 'fixture',
      model: 'fixture',
      baseUrl: 'https://example.invalid/v1',
      mcpTools: [],
      builtinToolContext: context,
      toolResultAnnotation: ({ name }) => `<annotation>${name}</annotation>`,
      streamTransport: async (_endpoint, _headers, body, onText) => {
        streamRequests.push(structuredClone(body));
        if (streamRound++ === 0) {
          onText(`data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: calls.map(({ id, name, args }, index) => ({
                  index,
                  id,
                  function: { name, arguments: JSON.stringify(args || {}) },
                })),
              },
              finish_reason: 'tool_calls',
            }],
          })}\n\n`);
        } else {
          onText(`data: ${JSON.stringify({
            choices: [{
              delta: { content: 'stream done' },
              finish_reason: 'stop',
            }],
          })}\n\n`);
        }
      },
    });

    assert.equal(streamed.content, 'stream done');
    assert.equal(sideEffectCommands().length, beforeStreamSideEffects);
    assert.equal(streamed.toolCallHistory.length, 3);
    const streamToolMessages = streamRequests[1].messages.filter(
      message => message.role === 'tool',
    );
    assert.deepEqual(
      streamToolMessages.map(message => message.tool_call_id),
      ['delete_call', 'sticker_call', 'external_call'],
    );
    assert.ok(streamToolMessages.every(message =>
      message.content.includes('<annotation>')));
  } finally {
    await vite.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
