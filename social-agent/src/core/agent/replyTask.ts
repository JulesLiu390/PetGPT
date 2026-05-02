import type { Platform } from '../../platform/index.ts';
import type { Provider } from '../../providers.ts';
import type { ChatMessage, ToolCall } from '../llm/index.ts';
import { createLLMClient, callWithTools } from '../llm/index.ts';
import { createSocialPromptBuilders, type LurkMode, type TargetType } from '../prompts/social.ts';
import { createWorkspaceTools } from '../tools/workspace.ts';
import { createReplyTools } from '../tools/reply.ts';

/**
 * One Reply LLM call.
 *
 * Reply layer reads reply_brief.md (already injected by buildSocialPrompt
 * via "# Intent 交接"), decides what to say, and invokes send_message —
 * the terminator tool. The captured message is returned to the caller so
 * AgentManager can emit the appropriate event / forward to MCP later.
 */

export interface RunReplyOptions {
  petId: string;
  targetId: string;
  targetType?: TargetType;

  provider: Provider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxIterations?: number;

  /** Pre-rendered chat snapshot (becomes the user-message that kicks Reply). */
  chatSnapshot: string;

  // Forwarded to buildSocialPrompt (role='reply')
  socialPersonaPrompt?: string;
  targetName?: string;
  botQQ?: string;
  ownerQQ?: string;
  ownerName?: string;
  ownerSecret?: string;
  nameDelimiterL?: string;
  nameDelimiterR?: string;
  msgDelimiterL?: string;
  msgDelimiterR?: string;
  lurkMode?: LurkMode;
}

export interface ReplyToolTrace {
  name: string;
  arguments: unknown;
  resultContent: string;
  isError: boolean;
}

export interface ReplyResult {
  /** What send_message captured. null if Reply LLM never sent. */
  captured: { content: string; replyTo?: string } | null;
  toolCalls: ReplyToolTrace[];
  finalContent: string;
  iterations: number;
  stoppedEarly: boolean;
  elapsedMs: number;
  messages: ChatMessage[];
}

export async function runReply(platform: Platform, opts: RunReplyOptions): Promise<ReplyResult> {
  const targetType = opts.targetType ?? 'group';

  const promptBuilders = createSocialPromptBuilders(platform);
  const systemPrompt = await promptBuilders.buildSocialPrompt({
    petId:               opts.petId,
    socialPersonaPrompt: opts.socialPersonaPrompt,
    targetId:            opts.targetId,
    targetName:          opts.targetName,
    targetType,
    botQQ:               opts.botQQ,
    ownerQQ:             opts.ownerQQ,
    ownerName:           opts.ownerName,
    ownerSecret:         opts.ownerSecret,
    nameDelimiterL:      opts.nameDelimiterL,
    nameDelimiterR:      opts.nameDelimiterR,
    msgDelimiterL:       opts.msgDelimiterL,
    msgDelimiterR:       opts.msgDelimiterR,
    lurkMode:            opts.lurkMode,
    role:                'reply',
  });

  const wsTools    = createWorkspaceTools(platform, opts.petId);
  const replyCtx   = { captured: null as ReplyResult['captured'] };
  const replyTools = createReplyTools(replyCtx);

  const tools    = [...wsTools.definitions, ...replyTools.definitions];
  const handlers = { ...wsTools.handlers, ...replyTools.handlers };

  const t0 = Date.now();
  const trace: ReplyToolTrace[] = [];

  const client = createLLMClient(platform, opts.provider);
  const result = await callWithTools({
    client,
    model:        opts.model,
    messages:     [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: opts.chatSnapshot || '（无新消息）' },
    ],
    tools,
    handlers,
    maxIterations: opts.maxIterations ?? 6,
    temperature:   opts.temperature,
    maxTokens:     opts.maxTokens,
    timeoutMs:     opts.timeoutMs,
    stopAfterTool: 'send_message',
    onToolResult(call: ToolCall, r) {
      trace.push({
        name: call.name,
        arguments: call.arguments,
        resultContent: r.content,
        isError: !!r.isError,
      });
    },
  });

  return {
    captured:     replyCtx.captured,
    toolCalls:    trace,
    finalContent: result.finalContent,
    iterations:   result.iterations,
    stoppedEarly: result.stoppedEarly,
    elapsedMs:    Date.now() - t0,
    messages:     result.messages,
  };
}
