import type { ToolDefinition } from '../llm/index.ts';
import type { ToolHandler } from '../llm/tool-loop.ts';

/**
 * Reply-mode terminator tool: send_message.
 *
 * Captures what the LLM wants to say to the group. Real delivery to
 * QQ / chat platforms happens via MCP (Phase 4); for now the handler
 * records the captured content on the context and returns success so
 * the LLM can wrap up.
 *
 * Pair with callWithTools({ stopAfterTool: 'send_message' }).
 */

export interface ReplyToolsContext {
  /** Filled in by the handler when the LLM invokes send_message. */
  captured: { content: string; replyTo?: string } | null;
}

export function createReplyTools(ctx: ReplyToolsContext): {
  definitions: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
} {
  const definitions: ToolDefinition[] = [
    {
      name: 'send_message',
      description: '把 reply 内容发送到当前会话——这是文字消息**唯一**的发送通道。直接输出纯文本不会到达群聊。调用一次即结束。',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '回复内容。可在内部用 </分段> 标签分段（最多 2 段）；不要用 markdown 格式。',
          },
          reply_to: {
            type: 'string',
            description: '（可选）要引用的消息 ID。仅在明确回应某条消息时使用。',
          },
        },
        required: ['content'],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async send_message(args: any) {
      const content = String(args?.content ?? '').trim();
      if (!content) {
        return { content: 'Error: content is required (the message body)', isError: true };
      }
      const replyTo = args?.reply_to ? String(args.reply_to) : undefined;
      ctx.captured = { content, ...(replyTo ? { replyTo } : {}) };
      return { content: `✓ message queued (${content.length} chars)${replyTo ? ` → reply_to=${replyTo}` : ''}` };
    },
  };

  return { definitions, handlers };
}
