/**
 * Smoke test for tool calling — verifies all 3 adapters AND the multi-round
 * tool-loop driver. Mock server impersonates each provider, returning a
 * deterministic two-step exchange:
 *
 *   round 1 (user prompt) → response includes a tool_call: get_weather(city='Beijing')
 *   round 2 (with tool_result)  → response is plain text "Sunny in Beijing, 22°C"
 *
 * Run: bun run scripts/smoke-tools.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';
import { createLLMClient, callWithTools } from '../src/core/llm/index.ts';
import type { Provider } from '../src/providers.ts';
import type { ChatMessage, ToolDefinition } from '../src/core/llm/types.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// Each provider's mock server tracks call count to return appropriate response per round.
function makeMockServer() {
  let anthropicRound = 0;
  let openaiRound    = 0;
  let geminiRound    = 0;

  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => ({})) as any;

      // ── Anthropic /v1/messages ──
      if (url.pathname === '/v1/messages') {
        anthropicRound++;
        if (anthropicRound === 1) {
          // First round: emit tool_use
          return Response.json({
            id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'toolu_001', name: 'get_weather', input: { city: 'Beijing' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 20 },
          });
        }
        // Second round: model received tool_result, gives final answer
        return Response.json({
          id: 'msg_test2', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'Sunny in Beijing, 22°C' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 8 },
        });
      }

      // ── OpenAI /openai/chat/completions ──
      if (url.pathname === '/openai/chat/completions') {
        openaiRound++;
        if (openaiRound === 1) {
          return Response.json({
            id: 'chatcmpl-1', model: body.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_xyz', type: 'function',
                  function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Beijing' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        return Response.json({
          id: 'chatcmpl-2', model: body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Sunny in Beijing, 22°C' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
        });
      }

      // ── Gemini /v1beta/models/{model}:generateContent ──
      const geminiMatch = url.pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
      if (geminiMatch) {
        geminiRound++;
        if (geminiRound === 1) {
          return Response.json({
            candidates: [{
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'get_weather', args: { city: 'Beijing' } } }],
              },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            modelVersion: geminiMatch[1],
          });
        }
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ text: 'Sunny in Beijing, 22°C' }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, totalTokenCount: 38 },
          modelVersion: geminiMatch[1],
        });
      }

      return new Response('not found', { status: 404 });
    },
  });
}

const mock = makeMockServer();
const base = `http://localhost:${mock.port}`;
console.log('mock:', base);

const home = mkdtempSync(join(tmpdir(), 'social-agent-tools-test-'));
const platform = createNodePlatform(home);

function provider(type: Provider['type'], baseUrl: string): Provider {
  return { id: 'p', type, name: 'mock', apiKey: 'sk-test', baseUrl, createdAt: 0, updatedAt: 0 };
}

const tool: ToolDefinition = {
  name: 'get_weather',
  description: 'Look up the weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

const handlers = {
  get_weather: async (args: any) => ({ content: `weather(${args.city})=22C sunny` }),
};

// ─── single-round chat with tool call (verifies adapter parsing) ───
async function singleRound(name: string, p: Provider, expectedToolName: string) {
  console.log(`\n── ${name} single-round ──`);
  const client = createLLMClient(platform, p);
  const r = await client.chat({
    messages: [{ role: 'user', content: 'weather in Beijing?' }],
    model: 'm',
    tools: [tool],
  });
  check('finishReason tool_use', r.finishReason === 'tool_use');
  check('toolCalls 1 entry',     r.toolCalls.length === 1);
  check('tool name matches',     r.toolCalls[0]?.name === expectedToolName);
  const arg = r.toolCalls[0]?.arguments as any;
  check('tool arg city=Beijing', arg?.city === 'Beijing');
  check('id non-empty',          typeof r.toolCalls[0]?.id === 'string' && r.toolCalls[0]!.id.length > 0);
}

// Reset mock counters between providers
function resetMock() { mock.stop(true); }

// We need separate Bun.serve instances per provider since round counters
// are stateful. Recreate before each provider's full loop test.
async function fullLoop(name: string, p: Provider, expectedFinal: string) {
  console.log(`\n── ${name} full callWithTools loop ──`);
  const client = createLLMClient(platform, p);
  const messages: ChatMessage[] = [{ role: 'user', content: 'weather in Beijing?' }];
  const r = await callWithTools({
    client,
    messages,
    model: 'm',
    tools: [tool],
    handlers,
  });
  check('iterations==2',     r.iterations === 2);
  check('not stoppedEarly',  !r.stoppedEarly);
  check('final has answer',  r.finalContent.includes('Sunny'));
  check('transcript ≥ 4 msgs', r.messages.length >= 4);   // user + assistant(tool) + tool + assistant(text)

  // Round-trip integrity
  const assistantWithTool = r.messages.find(m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0);
  const toolReply = r.messages.find(m => m.role === 'tool');
  check('has assistant(toolCalls) turn', !!assistantWithTool);
  check('has role=tool turn',            !!toolReply);
  if (assistantWithTool && toolReply) {
    check('tool reply id matches',       toolReply.toolCallId === assistantWithTool.toolCalls![0].id);
  }
}

await singleRound('anthropic',     provider('anthropic',     base), 'get_weather');
await singleRound('openai-compat', provider('openai-compat', `${base}/openai`), 'get_weather');
await singleRound('gemini',        provider('gemini',        `${base}/v1beta`), 'get_weather');

// Full loop tests need fresh round counters per provider
resetMock();
{
  const m2 = makeMockServer();
  const b2 = `http://localhost:${m2.port}`;
  await fullLoop('anthropic', provider('anthropic', b2), 'Sunny');
  m2.stop(true);
}
{
  const m2 = makeMockServer();
  const b2 = `http://localhost:${m2.port}`;
  await fullLoop('openai-compat', provider('openai-compat', `${b2}/openai`), 'Sunny');
  m2.stop(true);
}
{
  const m2 = makeMockServer();
  const b2 = `http://localhost:${m2.port}`;
  await fullLoop('gemini', provider('gemini', `${b2}/v1beta`), 'Sunny');
  m2.stop(true);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
