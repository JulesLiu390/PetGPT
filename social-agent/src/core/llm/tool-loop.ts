import type {
  LLMClient, ChatMessage, ChatRequest, ToolCall, ToolDefinition,
} from './types.ts';

/**
 * Provider-agnostic multi-round tool calling driver.
 *
 *   1. send chat({ messages, tools })
 *   2. if response has toolCalls: execute each handler, append assistant + tool messages, loop
 *   3. if response has no toolCalls: stop and return
 *
 * Iteration is bounded by maxIterations to prevent runaway loops.
 */

export type ToolHandlerResult = { content: string; isError?: boolean };
export type ToolHandler = (args: unknown) => Promise<ToolHandlerResult> | ToolHandlerResult;

export interface CallWithToolsOptions {
  client: LLMClient;
  /** Initial messages (system / user). Will be cloned; not mutated. */
  messages: ChatMessage[];
  model: string;
  tools: ToolDefinition[];
  /** Map tool name → handler. Tools the model invokes that have no handler return an error result. */
  handlers: Record<string, ToolHandler>;
  /** Default 10. */
  maxIterations?: number;
  /** Forwarded to chat(). */
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** When the named tool is called, run handlers + append result, but stop the loop afterwards.
   *  Useful for "submit answer" style terminator tools. */
  stopAfterTool?: string;
  /** Hooks for observability. Errors thrown here propagate. */
  onIterationStart?: (iter: number, messages: ChatMessage[]) => void;
  onToolCall?:    (call: ToolCall) => void;
  onToolResult?:  (call: ToolCall, result: ToolHandlerResult) => void;
}

export interface CallWithToolsResult {
  /** Full conversation transcript including the assistant + tool messages we appended. */
  messages: ChatMessage[];
  /** Last assistant text content (after the loop terminated). */
  finalContent: string;
  iterations: number;
  /** True when the loop bailed because stopAfterTool fired. */
  stoppedEarly: boolean;
}

export async function callWithTools(opts: CallWithToolsOptions): Promise<CallWithToolsResult> {
  const {
    client, model, tools, handlers,
    maxIterations = 10,
    temperature, maxTokens, timeoutMs,
    stopAfterTool,
    onIterationStart, onToolCall, onToolResult,
  } = opts;

  const messages: ChatMessage[] = [...opts.messages];

  for (let iter = 1; iter <= maxIterations; iter++) {
    onIterationStart?.(iter, messages);

    const req: ChatRequest = {
      messages,
      model,
      tools,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens   !== undefined ? { maxTokens } : {}),
      ...(timeoutMs   !== undefined ? { timeoutMs } : {}),
    };
    const resp = await client.chat(req);

    // Always record the assistant turn — tool-only response still needs to be in history
    messages.push({
      role: 'assistant',
      content: resp.content,
      ...(resp.toolCalls.length > 0 ? { toolCalls: resp.toolCalls } : {}),
    });

    // No tool calls → done
    if (resp.toolCalls.length === 0) {
      return { messages, finalContent: resp.content, iterations: iter, stoppedEarly: false };
    }

    // Execute every tool call, append result messages
    let earlyStop = false;
    for (const call of resp.toolCalls) {
      onToolCall?.(call);
      const handler = handlers[call.name];
      let result: ToolHandlerResult;
      if (!handler) {
        result = { content: `Error: no handler registered for tool "${call.name}"`, isError: true };
      } else {
        try {
          result = await handler(call.arguments);
        } catch (e: any) {
          result = { content: `Error: ${e?.message ?? String(e)}`, isError: true };
        }
      }
      onToolResult?.(call, result);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      });
      if (stopAfterTool && call.name === stopAfterTool) earlyStop = true;
    }

    if (earlyStop) {
      return { messages, finalContent: resp.content, iterations: iter, stoppedEarly: true };
    }
  }

  throw new Error(`callWithTools: max iterations (${maxIterations}) exceeded without final answer`);
}
