import type { PlatformHTTP } from '../../platform/types.ts';
import type { Provider } from '../../providers.ts';
import type { LLMClient, ChatRequest, ChatResponse, FinishReason } from './types.ts';
import { LLMError } from './types.ts';

interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string } | { type: string; [k: string]: unknown }>;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | string;
  usage: { input_tokens: number; output_tokens: number };
}

const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicClient(http: PlatformHTTP, provider: Provider): LLMClient {
  const baseUrl = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      // Anthropic separates `system` from `messages`.
      const systemParts: string[] = [];
      const turns: { role: 'user' | 'assistant'; content: string }[] = [];
      for (const m of req.messages) {
        if (m.role === 'system') systemParts.push(m.content);
        else turns.push({ role: m.role, content: m.content });
      }

      const body = {
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
        messages: turns,
      };

      const t0 = Date.now();
      const res = await http.request({
        url: `${baseUrl}/v1/messages`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        timeoutMs: req.timeoutMs,
      });
      const elapsedMs = Date.now() - t0;

      if (!res.ok) {
        throw new LLMError(`Anthropic ${res.status}: ${shortErr(res.body)}`, res.status, res.body);
      }
      let parsed: AnthropicMessagesResponse;
      try {
        parsed = JSON.parse(res.body) as AnthropicMessagesResponse;
      } catch {
        throw new LLMError(`Anthropic returned non-JSON: ${res.body.slice(0, 300)}`);
      }

      const text = parsed.content
        .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
        .map(b => b.text)
        .join('');

      return {
        content: text,
        finishReason: mapStop(parsed.stop_reason),
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        elapsedMs,
        model: parsed.model,
        raw: parsed,
      };
    },
  };
}

function mapStop(s: string): FinishReason {
  switch (s) {
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    case 'max_tokens':    return 'length';
    case 'tool_use':      return 'tool_use';
    default:              return 'other';
  }
}

function shortErr(body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message ?? JSON.stringify(j).slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
