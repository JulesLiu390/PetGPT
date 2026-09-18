import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('stream tool loop forwards AbortSignal and never returns late model content', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async command => {
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
    const { callLLMStreamWithTools } = await vite.ssrLoadModule('/src/utils/mcp/toolExecutor.js');
    const controller = new AbortController();
    let transportSignal = null;
    let deliveredChunks = 0;

    const promise = callLLMStreamWithTools({
      messages: [{ role: 'user', content: 'hello' }],
      apiFormat: 'openai_compatible',
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.test/v1',
      mcpTools: [],
      abortSignal: controller.signal,
      onChunk: () => { deliveredChunks += 1; },
      streamTransport: async (_endpoint, _headers, _body, onChunk, signal) => {
        transportSignal = signal;
        controller.abort();
        onChunk('data: {"choices":[{"delta":{"content":"late"}}]}\n\n');
      },
    });

    await assert.rejects(promise, error => error?.name === 'AbortError');
    assert.equal(transportSignal, controller.signal);
    assert.equal(deliveredChunks, 0);
  } finally {
    await vite.close();
    globalThis.window = previousWindow;
  }
});
