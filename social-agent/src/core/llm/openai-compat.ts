import type { PlatformHTTP } from '../../platform/types.ts';
import type { Provider } from '../../providers.ts';
import type { LLMClient, ChatRequest, ChatResponse, FinishReason } from './types.ts';
import { LLMError } from './types.ts';

interface OpenAICompatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function createOpenAICompatClient(http: PlatformHTTP, provider: Provider): LLMClient {
  if (!provider.baseUrl) {
    throw new Error('openai-compat provider requires baseUrl');
  }
  const baseUrl = provider.baseUrl.replace(/\/$/, '');

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const body = {
        model: req.model,
        messages: req.messages.map(m => ({ role: m.role, content: m.content })),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      };

      const t0 = Date.now();
      const res = await http.request({
        url: `${baseUrl}/chat/completions`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        timeoutMs: req.timeoutMs,
      });
      const elapsedMs = Date.now() - t0;

      if (!res.ok) {
        throw new LLMError(`OpenAI-compat ${res.status}: ${shortErr(res.body)}`, res.status, res.body);
      }
      let parsed: OpenAICompatResponse;
      try {
        parsed = JSON.parse(res.body) as OpenAICompatResponse;
      } catch {
        throw new LLMError(`OpenAI-compat returned non-JSON: ${res.body.slice(0, 300)}`);
      }

      const choice = parsed.choices?.[0];
      if (!choice) throw new LLMError('OpenAI-compat: empty choices', res.status, res.body);

      return {
        content: choice.message?.content ?? '',
        finishReason: mapStop(choice.finish_reason),
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
        elapsedMs,
        model: parsed.model,
        raw: parsed,
      };
    },
  };
}

function mapStop(s: string): FinishReason {
  switch (s) {
    case 'stop':         return 'stop';
    case 'length':       return 'length';
    case 'tool_calls':   return 'tool_use';
    default:             return 'other';
  }
}

function shortErr(body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message ?? j?.message ?? JSON.stringify(j).slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
