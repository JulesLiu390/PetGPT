import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ViteDevServer } from 'vite';

/**
 * callLLMWithTools 的流式模式：视频通话靠它边生成边念。文字要边到边交出去、标明是第几轮，
 * 收完之后工具执行、用量、onLLMText 都和非流式一样；取消要能打断正在收的流。
 */

type LoadedModule = Awaited<ReturnType<ViteDevServer['ssrLoadModule']>>;
type OnChunk = (chunk: string) => void;

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const withToolExecutor = async (run: (module: LoadedModule) => Promise<void>) => {
  const scope = globalThis as unknown as { window?: unknown };
  const previousWindow = scope.window;
  scope.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        if (command === 'get_mcp_servers') return [];
        throw new Error(`Unexpected Tauri command in test: ${command}`);
      },
    },
  };
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    await run(await vite.ssrLoadModule('/src/utils/mcp/toolExecutor.js'));
  } finally {
    await vite.close();
    scope.window = previousWindow;
  }
};

const base = {
  messages: [
    { role: 'system', content: 'fixture system' },
    { role: 'user', content: 'fixture user' },
  ],
  apiFormat: 'openai_compatible',
  apiKey: 'fixture-key',
  model: 'fixture-model',
  baseUrl: 'https://example.invalid/v1',
  llmTransport: async () => { throw new Error('the non-streaming transport must not be used'); },
};

test('streaming hands text out as it arrives and still runs the tool loop', async () => {
  await withToolExecutor(async ({ callLLMWithTools }) => {
    const responses = [
      [
        sse({ choices: [{ delta: { content: '我查' } }] }),
        sse({ choices: [{ delta: { content: '一下。' } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"q":' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"天气"}' } }] }, finish_reason: 'tool_calls' }] }),
      ],
      [
        sse({ choices: [{ delta: { content: '明天' } }] }),
        // 切在一行中间：SSE 行要能跨块拼起来
        'data: {"choices":[{"delta":{"content":"晴。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
        '\n\ndata: [DONE]\n\n',
      ],
    ];
    const bodies: Array<{ stream?: boolean; messages?: unknown }> = [];
    const deltas: Array<[number, string, string]> = [];
    const texts: Array<[number, string, string[]]> = [];
    const result = await callLLMWithTools({
      ...base,
      mcpTools: [{ name: 'lookup', description: 'look things up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
      onTextDelta: (delta: string, { iteration, text }: { iteration: number; text: string }) => deltas.push([iteration, delta, text]),
      onLLMText: (iter: { iteration: number; content: string; toolNames: string[] }) => texts.push([iter.iteration, iter.content, iter.toolNames]),
      toolOverride: async (_name: string, args: { q: string }) => ({ content: [{ type: 'text', text: `结果:${args.q}` }] }),
      streamTransport: async (_endpoint: string, _headers: unknown, body: { stream?: boolean; messages?: unknown }, onChunk: OnChunk) => {
        bodies.push(body);
        for (const chunk of responses[bodies.length - 1] ?? []) onChunk(chunk);
      },
    });

    assert.deepEqual(deltas, [
      [1, '我查', '我查'],
      [1, '一下。', '我查一下。'],
      [2, '明天', '明天'],
      [2, '晴。', '明天晴。'],
    ]);
    assert.deepEqual(texts, [[1, '我查一下。', ['lookup']], [2, '明天晴。', []]]);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.stream, true);
    assert.ok(JSON.stringify(bodies[1]?.messages).includes('结果:天气'), 'the second request carries the tool result');
    assert.equal(result.content, '明天晴。');
    assert.equal(result.toolCallHistory[0].name, 'lookup');
    assert.deepEqual(result.toolCallHistory[0].arguments, { q: '天气' });
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.termination, 'end_turn');
  });
});

test('stopAfterTool ends a streamed request right after the speaking tool', async () => {
  await withToolExecutor(async ({ callLLMWithTools }) => {
    let requests = 0;
    const result = await callLLMWithTools({
      ...base,
      mcpTools: [{ name: 'send_message', description: 'say it', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } }],
      onTextDelta: () => {},
      toolOverride: async () => ({ content: [{ type: 'text', text: '{"success":true}' }] }),
      stopAfterTool: (name: string) => name === 'send_message',
      streamTransport: async (_endpoint: string, _headers: unknown, _body: unknown, onChunk: OnChunk) => {
        requests += 1;
        onChunk(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'send_message', arguments: '{"content":"你好"}' } }] }, finish_reason: 'tool_calls' }] }));
      },
    });
    assert.equal(requests, 1, 'no extra request after speaking');
    assert.equal(result.termination, 'stop_after_tool');
  });
});

test('aborting stops a stream in the middle and nothing more is handed out', async () => {
  await withToolExecutor(async ({ callLLMWithTools }) => {
    const controller = new AbortController();
    const deltas: string[] = [];
    const promise = callLLMWithTools({
      ...base,
      mcpTools: [],
      abortSignal: controller.signal,
      onTextDelta: (delta: string) => deltas.push(delta),
      streamTransport: async (_endpoint: string, _headers: unknown, _body: unknown, onChunk: OnChunk, signal: AbortSignal) => {
        assert.equal(signal, controller.signal);
        onChunk(sse({ choices: [{ delta: { content: '我想' } }] }));
        controller.abort();
        onChunk(sse({ choices: [{ delta: { content: '说的是' } }] }));
      },
    });
    await assert.rejects(promise, (error: { name?: string } | undefined) => error?.name === 'AbortError');
    assert.deepEqual(deltas, ['我想']);
  });
});
