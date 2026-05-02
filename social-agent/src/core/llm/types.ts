/**
 * Provider-agnostic LLM types.
 *
 * Tools / streaming / multimodal are NOT here yet — they come in Phase 3b+.
 * This file deliberately stays small so the three adapters can be reasoned
 * about in isolation.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Override the per-request total deadline. */
  timeoutMs?: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_use' | 'other';

export interface ChatResponse {
  content: string;
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
