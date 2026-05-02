import type { PlatformHTTP } from '../../platform/types.ts';
import type { Provider } from '../../providers.ts';
import type { LLMClient, ChatRequest, ChatResponse, FinishReason } from './types.ts';
import { LLMError } from './types.ts';

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text?: string }>; role: 'model' };
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
  modelVersion?: string;
}

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function createGeminiClient(http: PlatformHTTP, provider: Provider): LLMClient {
  const baseUrl = (provider.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/$/, '');

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      // Gemini uses { role: 'user'|'model', parts:[{text}] } and a separate
      // systemInstruction. We collapse all `system` messages into one.
      const systemParts: string[] = [];
      const turns: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
      for (const m of req.messages) {
        if (m.role === 'system') systemParts.push(m.content);
        else turns.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        });
      }

      const body = {
        contents: turns,
        ...(systemParts.length
          ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } }
          : {}),
        generationConfig: {
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
        },
      };

      const url = `${baseUrl}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
      const t0 = Date.now();
      const res = await http.request({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: req.timeoutMs,
      });
      const elapsedMs = Date.now() - t0;

      if (!res.ok) {
        throw new LLMError(`Gemini ${res.status}: ${shortErr(res.body)}`, res.status, res.body);
      }
      let parsed: GeminiResponse;
      try {
        parsed = JSON.parse(res.body) as GeminiResponse;
      } catch {
        throw new LLMError(`Gemini returned non-JSON: ${res.body.slice(0, 300)}`);
      }

      const cand = parsed.candidates?.[0];
      if (!cand) {
        throw new LLMError(`Gemini: no candidates (likely safety-blocked); raw=${res.body.slice(0, 300)}`, res.status, res.body);
      }
      const text = (cand.content?.parts || [])
        .map(p => p.text ?? '')
        .join('');

      return {
        content: text,
        finishReason: mapStop(cand.finishReason),
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
        elapsedMs,
        model: parsed.modelVersion ?? req.model,
        raw: parsed,
      };
    },
  };
}

function mapStop(s: string): FinishReason {
  switch (s) {
    case 'STOP':       return 'stop';
    case 'MAX_TOKENS': return 'length';
    default:           return 'other';
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
