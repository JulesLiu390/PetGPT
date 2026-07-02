import type { PlatformHTTP } from '../../platform/types.ts';
import type { Provider } from '../../providers.ts';
import type {
  LLMClient, ChatRequest, ChatResponse, ChatMessage, FinishReason,
  ToolCall, ToolDefinition, ToolChoice,
} from './types.ts';
import { LLMError } from './types.ts';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChoiceMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAICompatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIChoiceMessage;
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
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages.map(toOpenAIMessage),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map(toOpenAITool);
      }
      if (req.toolChoice) {
        body.tool_choice = toOpenAIToolChoice(req.toolChoice);
      }

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

      const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseJSONLoose(tc.function.arguments),
      }));

      return {
        content: choice.message?.content ?? '',
        toolCalls,
        finishReason: mapStop(choice.finish_reason),
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
        elapsedMs,
        model: parsed.model,
        raw: parsed,
      };
    },

    async listModels(opts = {}) {
      const res = await http.request({
        url: `${baseUrl}/models`,
        method: 'GET',
        headers: { 'authorization': `Bearer ${provider.apiKey}` },
        timeoutMs: opts.timeoutMs,
      });
      if (!res.ok) throw new LLMError(`OpenAI-compat ${res.status}: ${shortErr(res.body)}`, res.status, res.body);
      const parsed = JSON.parse(res.body) as { data?: Array<{ id: string }> };
      return (parsed.data ?? []).map(m => m.id).filter(Boolean);
    },
  };
}

// ─────────────────── translation ───────────────────

function toOpenAITool(t: ToolDefinition) {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  };
}

function toOpenAIToolChoice(c: ToolChoice) {
  if (c === 'auto') return 'auto';
  if (c === 'any')  return 'required';
  if (c === 'none') return 'none';
  return { type: 'function', function: { name: c.name } };
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function toOpenAIMessage(m: ChatMessage): OpenAIMessage {
  if (m.role === 'tool') {
    if (!m.toolCallId) throw new Error('tool message missing toolCallId');
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      })),
    };
  }
  return { role: m.role as 'system' | 'user' | 'assistant', content: m.content } as OpenAIMessage;
}

function mapStop(s: string): FinishReason {
  switch (s) {
    case 'stop':         return 'stop';
    case 'length':       return 'length';
    case 'tool_calls':   return 'tool_use';
    default:             return 'other';
  }
}

function parseJSONLoose(s: string): unknown {
  if (!s) return {};
  try { return JSON.parse(s); }
  catch { return { _raw: s }; }   // some providers ship invalid JSON; preserve for debugging
}

function shortErr(body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message ?? j?.message ?? JSON.stringify(j).slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
