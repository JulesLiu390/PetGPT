import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * 没调工具就结束时，callLLMWithTools 要把 finishReason 带出来。
 *
 * Session 靠它区分「模型选择不说话」和「模型想做事但没做成」——Gemini 在工具
 * 调用格式坏掉时回 MALFORMED_FUNCTION_CALL + 空 parts，不带这个字段的话，
 * 它和一次正常的空回复在调用方看来一模一样。
 */
test('no-tool exit carries finishReason through for gemini and openai formats', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command) => {
        if (command === 'get_mcp_servers') return [];
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
    const { callLLMWithTools } = await vite.ssrLoadModule('/src/utils/mcp/toolExecutor.js');
    const base = {
      messages: [
        { role: 'system', content: 'fixture system' },
        { role: 'user', content: 'fixture user' },
      ],
      apiKey: 'fixture-key',
      model: 'fixture-model',
      mcpTools: [],
    };

    const malformed = await callLLMWithTools({
      ...base,
      apiFormat: 'gemini_official',
      llmTransport: async () => ({
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }],
      }),
    });
    assert.equal(malformed.finishReason, 'MALFORMED_FUNCTION_CALL');
    assert.equal(malformed.termination, 'end_turn');
    assert.equal(malformed.toolCallHistory.length, 0);
    assert.ok(!malformed.content, '空 parts 不该凭空生成文字');

    const normal = await callLLMWithTools({
      ...base,
      apiFormat: 'openai_compatible',
      baseUrl: 'https://example.invalid/v1',
      llmTransport: async () => ({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      }),
    });
    assert.equal(normal.finishReason, 'stop');
    assert.equal(normal.termination, 'end_turn');
    assert.equal(normal.content, 'hi');
  } finally {
    await vite.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

/**
 * 被截断时 content 是 callLLMWithTools 自己拼的系统提示，调用方必须能认出来——
 * Session 以前把它当成模型的最后一句话写进了 history，bot 在自己的记忆里
 * 「说过」一句 "[Maximum tool call iterations reached]"。
 */
test('max-iterations exit is marked so callers never mistake its content for model output', async () => {
  const previousWindow = globalThis.window;
  const mcpCalls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args = {}) => {
        if (command === 'get_mcp_servers') return [{ name: 'fetch', maxIterations: 100 }];
        if (command === 'get_mcp_server_by_name') return { _id: args.name };
        if (command === 'mcp_call_tool') {
          mcpCalls.push(args.toolName);
          return { content: [{ type: 'text', text: 'fixture page' }] };
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
    const { callLLMWithTools } = await vite.ssrLoadModule('/src/utils/mcp/toolExecutor.js');
    let n = 0;
    const result = await callLLMWithTools({
      messages: [
        { role: 'system', content: 'fixture system' },
        { role: 'user', content: 'fixture user' },
      ],
      apiFormat: 'openai_compatible',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      baseUrl: 'https://example.invalid/v1',
      maxIterations: 2,
      mcpTools: [{
        serverName: 'fetch',
        name: 'fetch',
        description: 'fixture fetch',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      }],
      // 永远要再调一次工具，逼它撞上限
      llmTransport: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `call-${++n}`, type: 'function', function: { name: 'fetch__fetch', arguments: '{"url":"https://example.invalid"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    });

    assert.equal(result.termination, 'max_iterations');
    assert.equal(result.content, '[Maximum tool call iterations reached]');
    assert.equal(mcpCalls.length, 2, '两轮都真的执行了工具');
  } finally {
    await vite.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
