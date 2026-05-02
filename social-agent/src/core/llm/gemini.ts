import type { PlatformHTTP } from '../../platform/types.ts';
import type { Provider } from '../../providers.ts';
import type {
  LLMClient, ChatRequest, ChatResponse, ChatMessage, FinishReason,
  ToolCall, ToolDefinition, ToolChoice,
} from './types.ts';
import { LLMError } from './types.ts';

interface GeminiTextPart         { text: string }
interface GeminiFunctionCallPart { functionCall: { name: string; args?: unknown } }
interface GeminiFunctionRespPart { functionResponse: { name: string; response: unknown } }
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionRespPart | { [k: string]: unknown };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: GeminiPart[]; role: 'model' };
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
      const { systemText, contents } = transformMessages(req.messages);

      const body: Record<string, unknown> = {
        contents,
        ...(systemText
          ? { systemInstruction: { parts: [{ text: systemText }] } }
          : {}),
        generationConfig: {
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
        },
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = [{
          functionDeclarations: req.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        }];
      }
      if (req.toolChoice) {
        body.toolConfig = { functionCallingConfig: toGeminiToolMode(req.toolChoice) };
      }

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

      const parts = cand.content?.parts || [];
      const text = parts
        .filter((p): p is GeminiTextPart => typeof (p as any).text === 'string')
        .map(p => p.text)
        .join('');

      // Gemini lacks tool-call IDs; we synthesize stable ones per call so the
      // round-trip pairing still works through our adapter. The id is local —
      // Gemini matches functionResponse to functionCall by name only.
      const fnCalls = parts
        .filter((p): p is GeminiFunctionCallPart => !!(p as any).functionCall)
        .map(p => p.functionCall);
      const toolCalls: ToolCall[] = fnCalls.map((fc, i) => ({
        id: `gemini_${Date.now()}_${i}_${fc.name}`,
        name: fc.name,
        arguments: fc.args ?? {},
      }));

      return {
        content: text,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_use' : mapStop(cand.finishReason),
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
        elapsedMs,
        model: parsed.modelVersion ?? req.model,
        raw: parsed,
      };
    },

    async listModels(opts = {}) {
      const url = `${baseUrl}/models?key=${encodeURIComponent(provider.apiKey)}&pageSize=1000`;
      const res = await http.request({ url, method: 'GET', timeoutMs: opts.timeoutMs });
      if (!res.ok) throw new LLMError(`Gemini ${res.status}: ${shortErr(res.body)}`, res.status, res.body);
      const parsed = JSON.parse(res.body) as { models?: Array<{ name: string }> };
      // Gemini reports "models/gemini-2.5-flash" — strip the prefix to get clean ids
      return (parsed.models ?? [])
        .map(m => m.name?.startsWith('models/') ? m.name.slice(7) : m.name)
        .filter(Boolean);
    },
  };
}

// ─────────────────── translation ───────────────────

function toGeminiToolMode(c: ToolChoice) {
  if (c === 'auto') return { mode: 'AUTO' };
  if (c === 'any')  return { mode: 'ANY' };
  if (c === 'none') return { mode: 'NONE' };
  return { mode: 'ANY', allowedFunctionNames: [c.name] };
}

function transformMessages(messages: ChatMessage[]): { systemText: string; contents: GeminiContent[] } {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === 'system') { systemParts.push(m.content); continue; }

    if (m.role === 'tool') {
      // Gemini matches functionResponse → functionCall by NAME (no ids).
      // We don't have the original name on the tool message, so we rely on
      // the caller having already injected the assistant-side functionCall
      // turn just before; we look back to find the name.
      const lastModelTurn = [...contents].reverse().find(c => c.role === 'model');
      const lastFnCall = lastModelTurn?.parts.find(
        (p): p is GeminiFunctionCallPart => !!(p as any).functionCall,
      );
      const fnName = lastFnCall?.functionCall.name ?? 'unknown';
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: fnName,
            response: tryParseJSON(m.content),
          },
        }],
      });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }

  return { systemText: systemParts.join('\n\n'), contents };
}

function tryParseJSON(s: string): unknown {
  try { return JSON.parse(s); } catch { return { result: s }; }
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
