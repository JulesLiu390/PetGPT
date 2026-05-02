/**
 * Provider-agnostic LLM types.
 *
 * Streaming / multimodal not here yet. Tool calling lives here as of Phase 3b.
 *
 * Wire format reference (each adapter translates to/from this canonical shape):
 *   ChatMessage      ↔ Anthropic content blocks / OpenAI message / Gemini contents
 *   ToolCall          ↔ Anthropic tool_use   / OpenAI tool_calls / Gemini functionCall
 *   ToolResult (msg)  ↔ Anthropic tool_result / OpenAI role:tool  / Gemini functionResponse
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** Vendor-supplied id; required for the round-trip. We never invent these. */
  id: string;
  name: string;
  /** Already JSON-parsed arguments object. */
  arguments: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on role='assistant' messages where the model decided to invoke tools. */
  toolCalls?: ToolCall[];
  /** Present on role='tool' messages — must echo the matching ToolCall.id. */
  toolCallId?: string;
  /** role='tool' result that errored (e.g. handler threw). Surfaces as is_error to the model. */
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON-Schema-shaped — adapters pass through as-is. */
  inputSchema: object;
}

export type ToolChoice = 'auto' | 'any' | 'none' | { name: string };

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Override the per-request total deadline. */
  timeoutMs?: number;
  /** Tools the model can choose to invoke. Empty/undefined = plain chat (3a behaviour). */
  tools?: ToolDefinition[];
  /** Default 'auto'. 'any' forces a tool call; 'none' suppresses. */
  toolChoice?: ToolChoice;
}

export type FinishReason = 'stop' | 'length' | 'tool_use' | 'other';

export interface ChatResponse {
  content: string;
  /** Set when finishReason === 'tool_use'. Empty array means no tools called. */
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  model: string;
  /** Vendor-specific raw payload, kept for debugging — do not feed back to the LLM. */
  raw?: unknown;
}

export interface LLMClient {
  /** Single round-trip chat call. Throws on transport / 4xx / 5xx. */
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
