import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

import {
  createIntentOptionalToolLedger,
  recordIntentOptionalToolUse,
} from '../../intentToolLedger.js';

test('the next LLM request receives the optional-tool ledger in its tool result', async () => {
  const previousWindow = globalThis.window;
  const mcpCalls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args = {}) => {
        if (command === 'get_mcp_servers') {
          return [
            { name: 'fetch', maxIterations: 100 },
            { name: 'broken', maxIterations: 100 },
            { name: 'limited', maxIterations: 1 },
            { name: 'terminal', maxIterations: 100 },
            { name: 'gemini', maxIterations: 100 },
          ];
        }
        if (command === 'get_mcp_server_by_name') return { _id: args.name };
        if (command === 'mcp_call_tool') {
          mcpCalls.push({ serverId: args.serverId, toolName: args.toolName });
          if (args.serverId === 'broken') {
            return {
              success: false,
              isError: true,
              error: null,
              content: [{ type: 'text', text: 'broken fixture result' }],
            };
          }
          if (args.serverId === 'gemini') {
            return { content: [{ type: 'text', text: '{"answer":42}' }] };
          }
          return {
            content: [{
              type: 'text',
              text: `result from ${args.serverId}/${args.toolName}`,
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
      formatToolResult,
    } = await vite.ssrLoadModule('/src/utils/mcp/toolExecutor.js');
    assert.equal(
      formatToolResult({ success: false, content: [], error: 'transport down' }),
      'Error: transport down',
    );

    const requests = [];
    const responses = [
      {
        choices: [{
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_situation',
                type: 'function',
                function: {
                  name: 'get_situation',
                  arguments: '{}',
                },
              },
              {
                id: 'call_fetch',
                type: 'function',
                function: {
                  name: 'fetch__fetch',
                  arguments: JSON.stringify({
                    url: 'https://example.com/report?token=private',
                  }),
                },
              },
              {
                id: 'call_broken',
                type: 'function',
                function: {
                  name: 'broken__fetch',
                  arguments: JSON.stringify({
                    url: 'https://broken.example/report',
                  }),
                },
              },
              {
                id: 'call_limited_first',
                type: 'function',
                function: {
                  name: 'limited__fetch',
                  arguments: JSON.stringify({
                    url: 'https://limited.example/first',
                  }),
                },
              },
              {
                id: 'call_limited_skipped',
                type: 'function',
                function: {
                  name: 'limited__fetch',
                  arguments: JSON.stringify({
                    url: 'https://limited.example/second',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
      {
        choices: [{
          message: { content: 'done' },
          finish_reason: 'stop',
        }],
      },
    ];
    const ledger = createIntentOptionalToolLedger();
    const externalTool = (serverName, name = 'fetch') => ({
      serverName,
      name,
      description: `fixture ${serverName} ${name}`,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    });

    const result = await callLLMWithTools({
      messages: [
        { role: 'system', content: 'fixture system' },
        { role: 'user', content: 'fixture user' },
      ],
      apiFormat: 'openai_compatible',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      baseUrl: 'https://example.invalid/v1',
      mcpTools: [
        {
          serverName: null,
          name: 'get_situation',
          description: 'fixture fixed tool',
          inputSchema: { type: 'object', properties: {} },
        },
        externalTool('fetch'),
        externalTool('broken'),
        externalTool('limited'),
      ],
      llmTransport: async (_endpoint, _headers, body) => {
        requests.push(structuredClone(body));
        return responses.shift();
      },
      toolCallFilter: name =>
        name === 'get_situation' ? 'fixture fixed-tool result' : null,
      // A failed terminal candidate must not stop the loop.
      stopAfterTool: 'broken__fetch',
      toolResultAnnotation: ({ name, args, isError }) =>
        recordIntentOptionalToolUse(ledger, { name, args, isError }),
    });

    assert.equal(result.content, 'done');
    assert.equal(requests.length, 2);
    assert.equal(ledger.total, 3);
    assert.equal(ledger.succeeded, 2);
    assert.equal(ledger.failed, 1);
    assert.deepEqual(mcpCalls, [
      { serverId: 'fetch', toolName: 'fetch' },
      { serverId: 'broken', toolName: 'fetch' },
      { serverId: 'limited', toolName: 'fetch' },
    ]);
    assert.equal(result.toolCallHistory.length, 4);
    assert.ok(result.toolCallHistory.every(entry =>
      !entry.result.includes('runtime_optional_tool_ledger')));

    const toolMessages = requests[1].messages.filter(message => message.role === 'tool');
    assert.equal(toolMessages.length, 5);

    const fixedMessage = toolMessages.find(message => message.tool_call_id === 'call_situation');
    assert.match(fixedMessage.content, /fixture fixed-tool result/);
    assert.doesNotMatch(fixedMessage.content, /runtime_optional_tool_ledger/);

    const optionalMessage = toolMessages.find(message => message.tool_call_id === 'call_fetch');
    assert.match(optionalMessage.content, /result from fetch\/fetch/);
    assert.match(optionalMessage.content, /已使用 fetch__fetch：抓取网页 https:\/\/example\.com\/report（完成）/);
    assert.match(optionalMessage.content, /本次 Intent 共使用可选工具 1 次/);
    assert.doesNotMatch(optionalMessage.content, /token=private/);

    const failedMessage = toolMessages.find(message => message.tool_call_id === 'call_broken');
    assert.match(failedMessage.content, /Error: broken fixture result/);
    assert.match(failedMessage.content, /尝试使用 broken__fetch/);
    assert.match(failedMessage.content, /可选工具 2 次，其中失败 1 次/);

    const limitedMessage = toolMessages.find(
      message => message.tool_call_id === 'call_limited_first',
    );
    assert.match(limitedMessage.content, /result from limited\/fetch/);
    assert.match(limitedMessage.content, /可选工具 3 次，其中失败 1 次/);

    const skippedMessage = toolMessages.find(
      message => message.tool_call_id === 'call_limited_skipped',
    );
    assert.match(skippedMessage.content, /Skipped: Server "limited" reached maximum/);
    assert.doesNotMatch(skippedMessage.content, /runtime_optional_tool_ledger/);
    assert.doesNotMatch(skippedMessage.content, /result from limited\/fetch/);

    const terminalRequests = [];
    let terminalTrace = null;
    const terminalResult = await callLLMWithTools({
      messages: [{ role: 'user', content: 'terminal fixture' }],
      apiFormat: 'openai_compatible',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      baseUrl: 'https://example.invalid/v1',
      mcpTools: [
        externalTool('terminal', 'fetch'),
        externalTool('terminal', 'after'),
      ],
      llmTransport: async (_endpoint, _headers, body) => {
        terminalRequests.push(structuredClone(body));
        return {
          choices: [{
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_terminal',
                  type: 'function',
                  function: {
                    name: 'terminal__fetch',
                    arguments: '{"url":"https://terminal.example/start"}',
                  },
                },
                {
                  id: 'call_after_terminal',
                  type: 'function',
                  function: {
                    name: 'terminal__after',
                    arguments: '{"url":"https://terminal.example/after"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        };
      },
      stopAfterTool: 'terminal__fetch',
      onTrace: trace => { terminalTrace = trace; },
    });

    assert.equal(terminalRequests.length, 1);
    assert.equal(terminalResult.toolCallHistory.length, 1);
    assert.equal(
      mcpCalls.filter(call => call.serverId === 'terminal').length,
      1,
    );
    assert.match(
      terminalTrace.toolResults.find(
        entry => entry.tool_call_id === 'call_after_terminal',
      ).content,
      /was not executed because terminal tool "terminal__fetch" already completed/,
    );

    const geminiRequests = [];
    const geminiLedger = createIntentOptionalToolLedger();
    const geminiResponses = [
      {
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                name: 'gemini__fetch',
                args: { url: 'https://gemini.example/source' },
              },
              thought_signature: 'fixture-signature',
            }],
          },
          finishReason: 'STOP',
        }],
      },
      {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'gemini done' }] },
          finishReason: 'STOP',
        }],
      },
    ];
    const geminiResult = await callLLMWithTools({
      messages: [
        { role: 'system', content: 'gemini fixture system' },
        { role: 'user', content: 'gemini fixture user' },
      ],
      apiFormat: 'gemini_official',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      mcpTools: [externalTool('gemini')],
      llmTransport: async (_endpoint, _headers, body) => {
        geminiRequests.push(structuredClone(body));
        return geminiResponses.shift();
      },
      toolResultAnnotation: ({ name, args, isError }) =>
        recordIntentOptionalToolUse(geminiLedger, { name, args, isError }),
    });

    assert.equal(geminiResult.content, 'gemini done');
    assert.equal(geminiRequests.length, 2);
    const geminiToolTurn = geminiRequests[1].contents.find(message =>
      message.role === 'user'
      && message.parts.some(part => part.functionResponse));
    assert.ok(geminiToolTurn);
    const functionResponse = geminiToolTurn.parts.find(part => part.functionResponse);
    assert.deepEqual(functionResponse.functionResponse.response, { answer: 42 });
    assert.match(
      geminiToolTurn.parts.find(part => part.text)?.text || '',
      /已使用 gemini__fetch.*本次 Intent 共使用可选工具 1 次/s,
    );
  } finally {
    await vite.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
