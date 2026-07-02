import type { PlatformHTTP } from '../../platform/types.ts';
import type { Provider } from '../../providers.ts';
import type {
  LLMClient, ChatRequest, ChatResponse, ChatMessage, FinishReason,
  ToolCall, ToolDefinition, ToolChoice,
} from './types.ts';
import { LLMError } from './types.ts';

interface AnthropicTextBlock     { type: 'text';      text: string }
interface AnthropicToolUseBlock  { type: 'tool_use';  id: string; name: string; input: unknown }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string; [k: string]: unknown };

interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | string;
  usage: { input_tokens: number; output_tokens: number };
}

const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicClient(http: PlatformHTTP, provider: Provider): LLMClient {
  const baseUrl = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const { systemText, turns } = transformMessages(req.messages);

      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(systemText ? { system: systemText } : {}),
        messages: turns,
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map(toAnthropicTool);
      }
      if (req.toolChoice) {
        body.tool_choice = toAnthropicToolChoice(req.toolChoice);
      }

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
        .filter((b): b is AnthropicTextBlock => b?.type === 'text')
        .map(b => b.text)
        .join('');

      const toolCalls: ToolCall[] = parsed.content
        .filter((b): b is AnthropicToolUseBlock => b?.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, arguments: b.input }));

      return {
        content: text,
        toolCalls,
        finishReason: mapStop(parsed.stop_reason),
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        elapsedMs,
        model: parsed.model,
        raw: parsed,
      };
    },

    async listModels(opts = {}) {
      const res = await http.request({
        url: `${baseUrl}/v1/models`,
        method: 'GET',
        headers: {
          'x-api-key': provider.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        timeoutMs: opts.timeoutMs,
      });
      if (!res.ok) throw new LLMError(`Anthropic ${res.status}: ${shortErr(res.body)}`, res.status, res.body);
      const parsed = JSON.parse(res.body) as { data?: Array<{ id: string }> };
      return (parsed.data ?? []).map(m => m.id).filter(Boolean);
    },
  };
}

// ─────────────────── translation ───────────────────

function toAnthropicTool(t: ToolDefinition) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  };
}

function toAnthropicToolChoice(c: ToolChoice) {
  if (c === 'auto') return { type: 'auto' };
  if (c === 'any')  return { type: 'any' };
  if (c === 'none') return { type: 'none' };
  return { type: 'tool', name: c.name };
}

interface AnthropicTurn {
  role: 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  >;
}

function transformMessages(messages: ChatMessage[]): { systemText: string; turns: AnthropicTurn[] } {
  const systemParts: string[] = [];
  const turns: AnthropicTurn[] = [];

  // Anthropic requires alternating user / assistant turns. role='tool' must
  // be folded into a user-turn carrying tool_result blocks. Multiple tool
  // results in a row are collapsed into one user turn (Anthropic accepts that).
  let pendingToolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      turns.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'system') { systemParts.push(m.content); continue; }

    if (m.role === 'tool') {
      if (!m.toolCallId) throw new Error('tool message missing toolCallId');
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      });
      continue;
    }

    flushToolResults();

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: AnthropicTurn['content'] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content } as any);
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments } as any);
      }
      turns.push({ role: 'assistant', content: blocks });
    } else {
      turns.push({ role: m.role as 'user' | 'assistant', content: m.content });
    }
  }
  flushToolResults();

  return { systemText: systemParts.join('\n\n'), turns };
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
