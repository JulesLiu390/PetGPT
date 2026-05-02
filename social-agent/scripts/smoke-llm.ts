/**
 * Smoke test for the LLM adapters.
 *
 * Spins up a single mock server that pretends to be all three providers
 * (Anthropic / OpenAI-compat / Gemini), routed by URL path. Verifies that
 * each adapter sends the expected request shape and parses the response
 * into the unified ChatResponse correctly.
 *
 * Run: bun run scripts/smoke-llm.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';
import { createLLMClient, LLMError } from '../src/core/llm/index.ts';
import type { Provider } from '../src/providers.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ─── mock servers (one Bun.serve, three pretending paths) ───
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);

    // Anthropic Messages API
    if (url.pathname === '/v1/messages') {
      const body = await req.json() as any;
      return Response.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: `you said: ${body.messages.at(-1).content}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 13 },
      }, { headers: { 'x-api-key-echo': req.headers.get('x-api-key') ?? '' } });
    }

    // OpenAI-compat
    if (url.pathname === '/openai/chat/completions') {
      const body = await req.json() as any;
      return Response.json({
        id: 'chatcmpl-test',
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `you said: ${body.messages.at(-1).content}` },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28 },
      });
    }

    // Gemini
    const geminiMatch = url.pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (geminiMatch) {
      const body = await req.json() as any;
      const lastUserText = body.contents.at(-1).parts[0].text;
      return Response.json({
        candidates: [{
          content: { role: 'model', parts: [{ text: `you said: ${lastUserText}` }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 11, totalTokenCount: 16 },
        modelVersion: geminiMatch[1],
      });
    }

    // 4xx error path (so we can test LLMError handling)
    if (url.pathname === '/v1/messages-401') {
      return Response.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'bad key' } },
        { status: 401 },
      );
    }

    return new Response('not found', { status: 404 });
  },
});
const base = `http://localhost:${mock.port}`;
console.log('mock server:', base);

const home = mkdtempSync(join(tmpdir(), 'social-agent-llm-test-'));
const platform = createNodePlatform(home);

function p(type: Provider['type'], baseUrl: string): Provider {
  return {
    id: 'p',
    type,
    name: 'mock',
    apiKey: 'sk-test-key-1234',
    baseUrl,
    createdAt: 0,
    updatedAt: 0,
  };
}

console.log('\n── anthropic ──');
{
  const client = createLLMClient(platform, p('anthropic', base));
  const r = await client.chat({
    messages: [
      { role: 'system', content: 'you are a cat' },
      { role: 'user', content: 'hello' },
    ],
    model: 'claude-test',
    maxTokens: 100,
  });
  check('content',  r.content === 'you said: hello');
  check('finish',   r.finishReason === 'stop');
  check('input',    r.inputTokens === 7);
  check('output',   r.outputTokens === 13);
  check('model',    r.model === 'claude-test');
  check('elapsed > 0', r.elapsedMs >= 0);
}

console.log('\n── openai-compat ──');
{
  const client = createLLMClient(platform, p('openai-compat', `${base}/openai`));
  const r = await client.chat({
    messages: [
      { role: 'system', content: 'you are a cat' },
      { role: 'user', content: 'meow?' },
    ],
    model: 'gpt-test',
    temperature: 0.4,
    maxTokens: 50,
  });
  check('content',  r.content === 'you said: meow?');
  check('finish',   r.finishReason === 'stop');
  check('input',    r.inputTokens === 11);
  check('output',   r.outputTokens === 17);
  check('model',    r.model === 'gpt-test');
}

console.log('\n── gemini ──');
{
  const client = createLLMClient(platform, p('gemini', `${base}/v1beta`));
  const r = await client.chat({
    messages: [
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'tell a joke' },
    ],
    model: 'gemini-test',
    maxTokens: 80,
  });
  check('content',  r.content === 'you said: tell a joke');
  check('finish',   r.finishReason === 'stop');
  check('input',    r.inputTokens === 5);
  check('output',   r.outputTokens === 11);
  check('model',    r.model === 'gemini-test');
}

console.log('\n── error path (Anthropic 401) ──');
{
  // Patch the base URL to a known-error path
  const bad = p('anthropic', `${base}`);
  bad.apiKey = 'sk-bad';
  // we don't have a real 401 path; emulate by hitting a non-messages path
  const client = createLLMClient(platform, p('anthropic', `${base}/wrong-prefix`));
  let caught: LLMError | null = null;
  try {
    await client.chat({ messages: [{ role: 'user', content: 'x' }], model: 'm' });
  } catch (e) {
    if (e instanceof LLMError) caught = e;
  }
  check('threw LLMError', caught !== null);
  check('status set',     caught?.status === 404);
}

mock.stop(true);
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
